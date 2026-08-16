# Retirement Certificates

Corporate net-zero reporting under the GHG Protocol and ISO 14064 requires a
retirement to identify **which project**, **which instrument**, and **which
vintage** the credits came from. A retirement event carrying only `holder` and
`amount` cannot be audited: it proves something was retired, not what.

`CreditRetirement` therefore records full provenance on every retirement and
serves it back as a certificate.

## Certificate contents

```rust
pub struct RetirementCertificate {
    pub record_id: u64,
    pub holder: Address,
    pub bond_id: u64,
    pub project_id: BytesN<32>,      // the project the credits originated from
    pub period_index: u32,           // the coupon period they are attributed to
    pub report_id: u64,              // the oracle report that measured that period
    pub vintage_year: u32,           // cached at retirement time
    pub vintage_period_start: u64,   // monitoring window, unix seconds
    pub vintage_period_end: u64,
    pub amount: i128,
    pub credit_type: CreditType,
    pub retired_at: u64,
    pub certificate_hash: BytesN<32>, // IPFS evidence hash
}
```

`RetirementRecord` carries the same fields; the certificate is derived from it.

## Breaking change: `retire_credits`

`retire_credits` gained two parameters, `project_id` and `period_index`, both
inserted after `bond_id`:

```rust
// before
retire_credits(holder, bond_id, amount, credit_type, certificate_hash, nonce)

// after
retire_credits(holder, bond_id, project_id, period_index, amount, credit_type, certificate_hash, nonce)
```

### Migrating a caller

1. Read the bond's project: `BondIssuer.get_bond(bond_id).project_id`. Pass it
   as `project_id` — a value that does not match is rejected with
   `CreditError::ProjectMismatch`.
2. Choose the coupon period the retirement is attributed to. Valid indices run
   `0..CouponEngine.get_period_count(bond_id)`; the period must have been
   distributed. An unknown index is rejected with `CreditError::PeriodNotFound`,
   a known-but-undistributed one with `CreditError::PeriodNotDistributed`.
3. Leave the remaining arguments as they were.

New `CreditError` variants: `ProjectMismatch = 9`, `PeriodNotFound = 10`,
`PeriodNotDistributed = 11`. Existing variants keep their discriminants, so
callers that only match on the old errors are unaffected.

### Event shape

The `CreditsRetired` event changed as well. It now uses the topic pair
`("CreditsRetired", holder)` — so indexers can filter by holder — and its data
payload is the full `RetirementCertificate` rather than the previous
`(holder, amount, credit_type)` tuple.

### New read methods

| Method | Purpose |
|--------|---------|
| `get_retirement_certificate(retirement_id)` | Certificate for one retirement |
| `get_bond_retirements(bond_id, holder)` | Retirement ids for a holder on a bond |
| `get_bond_certificates(bond_id, holder)` | Full certificates for a holder on a bond |
| `extend_retirement_ttl(retirement_id)` | Push a certificate's storage TTL back out |

## Design trade-offs

### Caller-supplied `project_id`, validated on-chain

The `project_id` is supplied by the caller and checked against
`BondIssuer.get_bond(bond_id)` rather than being read silently from
`CouponEngine`.

Two reasons. First, the holder's signed authorization then covers the project
the certificate will claim: the retiring party attests to a project, and the
chain proves the attestation matched the issuer's own record. A value the
contract fetches on the caller's behalf carries no such attestation. Second,
`BondIssuer` is the authoritative record of a bond's project and is already
invoked in `retire_credits` to check the holder's balance, so validation adds
no new contract dependency.

The dependency concern raised against fetching `project_id` from `CouponEngine`
— that retirement would fail if `CouponEngine` were unavailable — does not
change the outcome here: `retire_credits` already calls
`CouponEngine.accrued_credits` to size the retirement, so `CouponEngine`
availability was already a hard requirement.

### Vintage year cached, derived from `PeriodInfo`

`CouponEngine.PeriodInfo` already carries both the `report_id` and the
monitoring window copied from the oracle report at distribution time, so the
vintage is read from the period rather than from a second cross-contract call
into `OracleConsumer`. `CreditRetirement` needs no `OracleConsumer` address and
no constructor change.

The year is computed once, at retirement, and stored on the record. Certificate
reads are pure storage reads: no oracle call, no recomputation, and the value
cannot drift if an upstream report is later amended.

Vintage year is taken as the calendar year the monitoring period **ends** in,
matching the convention that a vintage is the year the sequestration was
measured to. Periods that straddle a year boundary are attributed to the
closing year; `vintage_period_start` and `vintage_period_end` are on the
certificate so an auditor can see the exact window.

### Persistent storage with explicit TTL extension

Retirement records, the per-holder index, the new `(bond_id, holder)` index,
and the retired-amount accumulators moved from instance storage to persistent
storage. Instance storage is a single ledger entry read and written on every
invocation; growing it once per retirement, forever, eventually makes the
contract unusable. Persistent entries are keyed individually and only the ones
a call touches enter its footprint.

Lookup by bond and holder is served by the `BondHolderRetirements(bond_id,
holder)` index, so `get_bond_certificates` reads one index entry plus one entry
per certificate — never a scan over the contract's full retirement history.

TTL is bumped on every write (threshold 30 days, extended to 120 days) and
`extend_retirement_ttl` exposes the bump explicitly. That method is
permissionless by design: certificates outlive the bonds they came from, and
anyone relying on one for reporting must be able to keep it alive without the
original holder's cooperation.

Reads fall back to instance storage so retirements written before this change
are still readable; the first `extend_retirement_ttl` on such a record re-homes
it into persistent storage. Legacy records are not in the `(bond_id, holder)`
index — they predate it — so `get_bond_certificates` only covers retirements
made after this change.

## Known limitation: period attribution is not a per-period balance

`CouponEngine` accrues credits per `(bond, holder)`, not per period. The retired
amount is therefore capped against the holder's **total** accrual on the bond,
and `period_index` records which monitoring period the holder attributes the
retirement to — the contract validates that the period exists and was
distributed, not that the specific credits were earned in it.

Tightening this would require per-period accrual accounting in `CouponEngine`,
which is a change to that contract rather than to retirement.
