#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/deploy-testnet.sh"
TMP_DIR="$(mktemp -d)"
MOCK_BIN="${TMP_DIR}/bin"
MOCK_STATE="${TMP_DIR}/deploy-count"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$MOCK_BIN"
cat > "${MOCK_BIN}/soroban" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "contract" ] && [ "$2" = "deploy" ]; then
  count=0
  if [ -f "$SOROBAN_MOCK_STATE" ]; then
    count="$(cat "$SOROBAN_MOCK_STATE")"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$SOROBAN_MOCK_STATE"

  if [ "${SOROBAN_FAIL_DEPLOY:-}" = "$count" ]; then
    echo "mock deployment failure" >&2
    exit 1
  fi

  printf 'CMOCK%s\n' "$count"
fi
MOCK
chmod +x "${MOCK_BIN}/soroban"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_line() {
  local expected="$1"
  local file="$2"
  grep -Fqx "$expected" "$file" || fail "missing '${expected}' in ${file}"
}

assert_single_key() {
  local key="$1"
  local file="$2"
  local count
  count="$(grep -Ec "^${key}=" "$file" || true)"
  [ "$count" -eq 1 ] || fail "expected one ${key} entry in ${file}, found ${count}"
}

run_deploy() {
  local env_file="$1"
  local fail_at="${2:-}"

  (
    cd "$ROOT_DIR"
    PATH="${MOCK_BIN}:${PATH}" \
      ENV_FILE="$env_file" \
      STELLAR_PUBLIC_KEY="GADMIN" \
      SOROBAN_MOCK_STATE="$MOCK_STATE" \
      SOROBAN_FAIL_DEPLOY="$fail_at" \
      "$SCRIPT"
  )
}

ENV_FILE="${TMP_DIR}/complete.env"
cat > "$ENV_FILE" <<'ENV'
STELLAR_PUBLIC_KEY=GADMIN
ADMIN_SECRET_KEY=SKEEP
USER_SECRET_KEY=SUSERKEEP
PROJECT_REGISTRY_ADDRESS=COLDPROJECT
# BOND_ISSUER_ADDRESS=COLDBOND
#  COUPON_ENGINE_ADDRESS=OLDCOUPON
ENV

run_deploy "$ENV_FILE" > "${TMP_DIR}/complete.log"

expected_keys=(
  "PROJECT_REGISTRY_ADDRESS"
  "BOND_ISSUER_ADDRESS"
  "COUPON_ENGINE_ADDRESS"
  "ORACLE_CONSUMER_ADDRESS"
  "DEX_ROUTER_ADDRESS"
  "CREDIT_RETIREMENT_ADDRESS"
)

for index in "${!expected_keys[@]}"; do
  key="${expected_keys[$index]}"
  address_number=$((index + 1))
  assert_line "${key}=CMOCK${address_number}" "$ENV_FILE"
  assert_single_key "$key" "$ENV_FILE"
done
assert_line "ADMIN_SECRET_KEY=SKEEP" "$ENV_FILE"
assert_line "USER_SECRET_KEY=SUSERKEEP" "$ENV_FILE"

run_deploy "$ENV_FILE" > "${TMP_DIR}/repeat.log"

for index in "${!expected_keys[@]}"; do
  key="${expected_keys[$index]}"
  address_number=$((index + 7))
  assert_line "${key}=CMOCK${address_number}" "$ENV_FILE"
  assert_single_key "$key" "$ENV_FILE"
done
assert_line "ADMIN_SECRET_KEY=SKEEP" "$ENV_FILE"
assert_line "USER_SECRET_KEY=SUSERKEEP" "$ENV_FILE"

PARTIAL_ENV_FILE="${TMP_DIR}/partial.env"
cat > "$PARTIAL_ENV_FILE" <<'ENV'
STELLAR_PUBLIC_KEY=GADMIN
ADMIN_SECRET_KEY=SPARTIALKEEP
PROJECT_REGISTRY_ADDRESS=COLDPROJECT
BOND_ISSUER_ADDRESS=COLDBOND
COUPON_ENGINE_ADDRESS=COLDCOUPON
ORACLE_CONSUMER_ADDRESS=COLDORACLE
DEX_ROUTER_ADDRESS=COLDDEX
CREDIT_RETIREMENT_ADDRESS=COLDCREDIT
ENV
rm -f "$MOCK_STATE"

if run_deploy "$PARTIAL_ENV_FILE" 4 > "${TMP_DIR}/partial.log" 2>&1; then
  fail "expected the fourth deployment to fail"
fi

assert_line "PROJECT_REGISTRY_ADDRESS=CMOCK1" "$PARTIAL_ENV_FILE"
assert_line "BOND_ISSUER_ADDRESS=CMOCK2" "$PARTIAL_ENV_FILE"
assert_line "COUPON_ENGINE_ADDRESS=CMOCK3" "$PARTIAL_ENV_FILE"
assert_line "ORACLE_CONSUMER_ADDRESS=COLDORACLE" "$PARTIAL_ENV_FILE"
assert_line "DEX_ROUTER_ADDRESS=COLDDEX" "$PARTIAL_ENV_FILE"
assert_line "CREDIT_RETIREMENT_ADDRESS=COLDCREDIT" "$PARTIAL_ENV_FILE"
assert_line "ADMIN_SECRET_KEY=SPARTIALKEEP" "$PARTIAL_ENV_FILE"

echo "deploy-testnet.sh tests passed"
