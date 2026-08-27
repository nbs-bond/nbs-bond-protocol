#!/usr/bin/env bash
set -euo pipefail

# ── Source environment ──────────────────────────────────────────
ENV_FILE="${ENV_FILE:-api/.env}"
if [ -f "$ENV_FILE" ]; then
  echo "Sourcing ${ENV_FILE}"
  set -a
  source "$ENV_FILE"
  set +a
fi

# ── Configuration ───────────────────────────────────────────────
NETWORK=testnet
ADMIN_ADDRESS="${STELLAR_PUBLIC_KEY:?STELLAR_PUBLIC_KEY not set}"
CONTRACTS=(
  "shared"
  "project-registry"
  "bond-issuer"
  "coupon-engine"
  "oracle-consumer"
  "dex-router"
  "credit-retirement"
)

# Keep these mappings compatible with the Bash 3.2 version shipped by macOS.
package_for_contract() {
  case "$1" in
    shared) echo "nbbs-shared" ;;
    project-registry) echo "nbbs-project-registry" ;;
    bond-issuer) echo "nbbs-bonds" ;;
    coupon-engine) echo "nbbs-coupon-engine" ;;
    oracle-consumer) echo "nbbs-oracle-consumer" ;;
    dex-router) echo "nbbs-dex-router" ;;
    credit-retirement) echo "nbbs-credit-retirement" ;;
    *) return 1 ;;
  esac
}

env_key_for_contract() {
  case "$1" in
    project-registry) echo "PROJECT_REGISTRY_ADDRESS" ;;
    bond-issuer) echo "BOND_ISSUER_ADDRESS" ;;
    coupon-engine) echo "COUPON_ENGINE_ADDRESS" ;;
    oracle-consumer) echo "ORACLE_CONSUMER_ADDRESS" ;;
    dex-router) echo "DEX_ROUTER_ADDRESS" ;;
    credit-retirement) echo "CREDIT_RETIREMENT_ADDRESS" ;;
    *) return 1 ;;
  esac
}

# Read a value back from the env file as deployment progresses.
get_env_value() {
  awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1); exit }' \
    "$ENV_FILE" 2>/dev/null
}

# Replace an existing address or append it without changing any other setting.
update_env_address() {
  local key="$1"
  local value="$2"

  if grep -Eq "^[[:space:]]*#?[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null; then
    ENV_KEY="$key" ENV_VALUE="$value" perl -i -pe \
      's/^\s*#?\s*\Q$ENV{ENV_KEY}\E=.*/$ENV{ENV_KEY}=$ENV{ENV_VALUE}/' \
      "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

command -v perl >/dev/null 2>&1 || {
  echo "perl is required to update ${ENV_FILE} portably" >&2
  exit 1
}
mkdir -p "$(dirname "$ENV_FILE")"

echo "Deploying contracts to ${NETWORK} as admin ${ADMIN_ADDRESS}"
echo ""

for contract in "${CONTRACTS[@]}"; do
  pkg="$(package_for_contract "$contract")"
  wasm_name="${contract//-/_}"
  wasm="target/wasm32-unknown-unknown/release/nbbs_${wasm_name}.wasm"

  echo "── ${contract} ──"

  # Skip shared — it's a library, not deployable
  if [ "$contract" = "shared" ]; then
    echo "  ↪ Building shared library..."
    (cd contracts && soroban contract build --package "$pkg")
    echo "  ✓ Done (library only, no deployment)"
    echo ""
    continue
  fi

  echo "  Building..."
  (cd contracts && soroban contract build --package "$pkg")

  echo "  Deploying..."
  address=$(soroban contract deploy \
    --wasm "contracts/${wasm}" \
    --network "$NETWORK")

  echo "  Address: ${address}"

  echo "  Initializing..."
  constructor_args=(--arg "$ADMIN_ADDRESS")
  case "$contract" in
    dex-router|credit-retirement)
      constructor_args+=(
        --arg "$(get_env_value BOND_ISSUER_ADDRESS)"
        --arg "$(get_env_value COUPON_ENGINE_ADDRESS)"
      )
      ;;
  esac
  soroban contract invoke \
    --id "$address" \
    --fn __constructor \
    "${constructor_args[@]}" \
    --network "$NETWORK"

  # Persist only after deployment and initialization both succeed.
  env_key="$(env_key_for_contract "$contract")"
  update_env_address "$env_key" "$address"

  echo "  ✓ ${contract} → ${env_key}=${address}"
  echo ""
done

# Wire the oracle and registry together before either contract consumes an
# admin nonce. Oracle submissions trust only this configured registry, while
# rejected report challenges may call back through the configured oracle id.
PROJECT_REGISTRY_ADDRESS="$(get_env_value PROJECT_REGISTRY_ADDRESS)"
ORACLE_CONSUMER_ADDRESS="$(get_env_value ORACLE_CONSUMER_ADDRESS)"

soroban contract invoke \
  --id "$ORACLE_CONSUMER_ADDRESS" \
  --fn set_project_registry \
  --arg "$ADMIN_ADDRESS" \
  --arg "$PROJECT_REGISTRY_ADDRESS" \
  --arg 0 \
  --network "$NETWORK"

soroban contract invoke \
  --id "$PROJECT_REGISTRY_ADDRESS" \
  --fn set_oracle_consumer \
  --arg "$ADMIN_ADDRESS" \
  --arg "$ORACLE_CONSUMER_ADDRESS" \
  --arg 0 \
  --network "$NETWORK"

# ── Summary ─────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════════════════"
echo "  All contracts deployed to ${NETWORK}"
echo "══════════════════════════════════════════════════════════════"
for contract in "${CONTRACTS[@]}"; do
  [ "$contract" = "shared" ] && continue
  env_key="$(env_key_for_contract "$contract")"
  echo "  ${env_key}=$(get_env_value "$env_key")"
done
echo "══════════════════════════════════════════════════════════════"
