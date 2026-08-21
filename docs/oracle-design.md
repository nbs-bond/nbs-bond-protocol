# Oracle Design

## Architecture
Multi-source, multi-layer: Auditors + Satellite + IoT → OracleConsumer contract

## Provider Lifecycle
Register → Whitelisted → Submit Reports → Challenge Window → Verify/Reject

## Report Format
```
{
  project_id: BytesN<32>,
  period_start: u64,
  period_end: u64,
  carbon_sequestered: i128,
  methodology: Symbol,
  provider_signature: BytesN<64>,
  ipfs_evidence_hash: BytesN<32>,
}
```

## Multi-Source Verification Threshold
A report only reaches `Verified` status after **independent verifications** meet the configured threshold:

- `set_signature_threshold(threshold)` sets the minimum number of distinct verifiers required (defaults to `1`).
- Only **registered, active providers** may call `verify_report`; the admin is deliberately **not** exempt. Each call records the verifier under `ReportVerifiers(report_id)` and increments `VerificationCount(report_id)`.
- Verifying the **same** report twice by the same address is a no-op (deduplicated, no double counting).
- A provider cannot verify its **own** report (`InvalidSignature`) — this guarantees the threshold represents genuinely independent sources.
- A report whose status is no longer `Pending` (challenged, already verified) cannot be re-verified.
- `get_report_verifiers(report_id)` and `get_verification_count(report_id)` expose the audit trail on-chain.

Because the admin is never counted as a verifier, **no single admin signature can verify a report** — even with the default threshold of `1`, a report needs at least one independent provider endorsement, and with threshold ≥ 2 it needs that many providers. The submitting provider's own signature never counts either.

## Admin Override

`admin_override_report(report_id, status)` is the **only** path by which the admin can force a `Pending` report to a terminal state (`Verified` or `Rejected`) without provider consensus. It is deliberately distinct from `verify_report`:

- Admin-only, nonce-guarded, and requires a terminal `status` (anything else is `InvalidResolution`).
- Never appends the admin to `ReportVerifiers` and never touches `VerificationCount`.
- Cannot flip an already-terminal report (`ReportAlreadyVerified`), so a `Verified` report cannot be silently downgraded.
- Emits its own **`report_admin_override`** event carrying `(report_id, status)` so every override is traceable on-chain.

This gives a compromised/coerced admin no silent path to mint credits: any override leaves an explicit, auditable trail distinct from the provider-consensus verification that `CouponEngine`/`BondIssuer` rely on.

## Challenge Mechanism
- 72-hour window from submission
- Any address can challenge with counter-evidence (IPFS hash)
- Admin resolves via on-chain vote (`resolve_challenge`), settling the report to `Rejected` or `Verified`; the `challenge_resolved` event carries the chosen resolution so the verdict is auditable

## Staking & Slashing
Providers stake collateral that is at risk if their reports are overturned:

- `add_stake(amount)` / `withdraw_stake(amount)` let an active provider top up or partially withdraw its own stake; withdrawals can never drop the stake below zero (`InsufficientStake`).
- On a challenge resolution to `Rejected`, the provider is slashed **10%** of its stake (`SLASH_PENALTY_PPM = 100_000`), transferred out of the provider's committed collateral.
- If the remaining stake reaches zero the provider is **deactivated** (`active = false`) and can no longer submit or verify reports.
- Resolving a challenge to `Verified` imposes **no** penalty — the challenger is wrong and the provider is exonerated.
- Every slash emits a `provider_slashed` event carrying the provider, penalty amount, remaining stake, and active flag.

## Provider Reliability Observability

The contract persists per-provider history so monitoring never has to replay
events or scan every report:

- `submit_report` increments a per-provider report counter.
- `challenge_report` records the challenged report id against the report's provider.
- `slash_provider` appends a `SlashRecord` (`report_id`, `penalty`,
  `remaining_stake`, `timestamp`, `active_after`) to the provider's history.

Query surface:

- `get_provider_stats(provider)` → `reports_submitted`, `challenges_faced`,
  `slashes`, `total_penalty`, `stake`, `active`.
- `get_slash_history(provider)` → `Vec<SlashRecord>`.
- `get_challenge_history(provider)` → `Vec<Challenge>` for that provider.

These power the API's `GET /oracle/stats/:providerAddress` endpoint and the
log-based staleness alerting described in
[`runbook-degraded-providers.md`](./runbook-degraded-providers.md).

## Security Model
- Provider whitelist (admin-managed)
- Provider staking: committed collateral underwrites report quality; `add_stake` / `withdraw_stake` manage exposure
- Slashing: a `Rejected` challenge resolution slashes 10% of stake; zero stake deactivates the provider
- Signature threshold requires multiple independent sources for verification
- Coupon distributions consume only `Verified` reports (enforced by `CouponEngine`)
- Multi-sig for high-value reports
