# Architecture

## Smart Contracts

### BondIssuer
```rust
// Public functions
pub fn issue_bond(...)
pub fn subscribe(...)
pub fn transfer(from, to, bond_id, amount)   // on-chain token transfer
pub fn redeem(...)
pub fn mature_bond(...)
pub fn get_bond(...)
pub fn get_bond_state(...)
pub fn get_holder_balance(...)
pub fn bond_count(...)
```

### CouponEngine
```rust
// Public functions
pub fn distribute_coupon(caller, bond_id, period, holders, report_id, nonce)
pub fn claim_credits(caller, bond_id, nonce)   // withdraw accrued credits
pub fn sweep_undistributed(caller, bond_id, destination, nonce)  // admin-only: credit dust to destination
pub fn accrued_credits(...)
pub fn accrued_credits_by_type(bond_id, holder, credit_type)  // per-type split for Basket bonds
pub fn get_bond_credit_type(bond_id)
pub fn get_period_info(...)
pub fn get_period_count(...)
pub fn get_undistributed_total(...)
```

### OracleConsumer
```rust
// Public functions
pub fn register_provider(...)
pub fn add_stake(...)              // commit provider collateral
pub fn withdraw_stake(...)         // partial withdrawal of own stake
pub fn submit_report(...)
pub fn verify_report(...)            // independent provider verifier endorsement (admin excluded)
pub fn admin_override_report(...)    // explicit auditable admin override; emits report_admin_override
pub fn challenge_report(...)
pub fn resolve_challenge(...)        // admin verdict; Rejected slashes 10% stake
pub fn set_signature_threshold(...)  // required independent verifications
pub fn get_report(...)
pub fn get_provider(...)
pub fn get_verification_count(...)
pub fn get_report_verifiers(...)
```

### DEXRouter
```rust
// Public functions
pub fn deposit_quote(...)      // escrow quote asset for purchases
pub fn withdraw_quote(...)     // pull escrowed proceeds back
pub fn get_quote_balance(...)
pub fn list_bond_tokens(...)
pub fn execute_purchase(...)   // atomically transfers bonds + escrowed quote
pub fn cancel_listing(...)
pub fn get_order(...)
pub fn get_orders_by_seller(...)
```

### ProjectRegistry
```rust
// Public functions
pub fn register_project(...)
pub fn approve_project(...)
pub fn reject_project(...)
pub fn get_project(...)
pub fn get_all_projects(...)
```

### CreditRetirement
```rust
// Public functions
pub fn retire_credits(...)
pub fn get_retirement_record(...)
pub fn get_retirement_certificate(...)
pub fn get_bond_retirements(...)
pub fn get_bond_certificates(...)
pub fn extend_retirement_ttl(...)
pub fn get_retired_balance(...)
```

## Storage Layout

| Contract | DataKey | Value Type | Description |
|----------|---------|------------|-------------|
| BondIssuer | Bond(bond_id) | BondConfig | Bond configuration |
| BondIssuer | HolderBalance(bond_id, holder) | i128 | Token balance |
| BondIssuer | BondState(bond_id) | BondState | Current bond state |
| CouponEngine | Coupon(bond_id, period) | CouponData | Coupon distribution |
| CouponEngine | Accrued(bond_id, holder) | i128 | Accrued credits |
| CouponEngine | UndistributedTotal(bond_id) | i128 | Unallocated coupon dust |
| OracleConsumer | Report(report_id) | OracleReport | Measurement report |
| OracleConsumer | Provider(addr) | OracleProvider | Oracle provider (stake, active) |
| DEXRouter | Order(order_id) | OrderData | Marketplace order |
| DEXRouter | Balance(symbol, addr) | i128 | Escrowed quote-asset balance |
| ProjectRegistry | Project(project_id) | ProjectInfo | Project record |
| CreditRetirement | Retirement(id) | RetirementRecord | Retirement + certificate provenance (persistent) |
| CreditRetirement | BondHolderRetirements(bond_id, holder) | Vec<u64> | Certificate index by bond and holder (persistent) |
| CreditRetirement | HolderRetirements(holder) | Vec<u64> | All retirement ids for a holder (persistent) |
| CreditRetirement | RetiredPerBond(bond_id, holder) | i128 | Credits already retired against a bond (persistent) |

## Cross-Contract Calls

```
ProjectRegistry ──► BondIssuer (verify project exists)
BondIssuer ──► CouponEngine (distribute coupons)
CouponEngine ──► OracleConsumer (read verified reports by report_id)
DEXRouter ──► BondIssuer (settle purchase via transfer, debiting seller / crediting buyer)
CreditRetirement ──► CouponEngine (verify credit ownership, read PeriodInfo for the vintage window)
CreditRetirement ──► BondIssuer (verify holding, validate the caller's project_id)
```

## Bond Maturity

- A bond matures when the ledger timestamp reaches its `maturity_date` — `mature_bond` rejects calls made before that instant (`BondError::Overflow`).
- Once the maturity date elapses, `subscribe` and `transfer` are rejected even if the bond has not yet been admin-matured, so the bond's outstanding supply is frozen on schedule.
- `redeem` still requires the explicit `Matured` state, keeping redemption a deliberate admin-acknowledged step.

## Marketplace Settlement

- Buyers must first `deposit_quote` a quote asset (e.g. USDC) into the DEXRouter; purchases otherwise fail with `DEXError::InsufficientFunds`.
- `execute_purchase` atomically transfers bond tokens (`BondIssuer.transfer`) and escrowed quote (`price_per_token * amount`) from buyer to seller, so a fill either fully settles or fully reverts.
- Sellers can `withdraw_quote` their proceeds; `get_quote_balance` reports escrowed balances by symbol.

### Purchase failure semantics

- `list_bond_tokens` checks the seller's bond holder balance at listing time. `execute_purchase` re-checks it at execution time: a seller can list tokens and transfer them away before the order fills, and the re-check rejects the fill with `DEXError::SellerBalanceDepleted` instead of stumbling into the inner `BondIssuer.transfer` failure.
- A failed purchase is fully atomic. The transaction reverts, so the buyer's escrowed quote is never debited, the order remains `Open`, and the `purchase_failed` event (`seller_balance_depleted`) is published for observability. Note: in Soroban, events emitted by a frame that reverts are not persisted on the ledger — the event is best-effort, while the escrow rollback is the hard guarantee.
- **Nonce behavior.** The contract keeps a per-address nonce incremented at the start of every call. Because a failed purchase reverts the entire transaction, the on-chain nonce is rolled back too — a raw contract caller can retry with the *same* nonce. The API keeps a Redis nonce mirror (`NonceService`) that is consumed on every attempt; on a failed buy the service re-syncs the mirror from the chain, so the next `/marketplace/buy` retry does not hit `InvalidNonce`. The failed attempt is surfaced as `409 Conflict` with `nonce_consumed: true`, telling the frontend the attempt consumed its nonce slot and should be retried.

## Coupon Integrity

- `CouponEngine.distribute_coupon` accepts an **on-chain `report_id`** instead of a caller-supplied report, eliminating fabricated distributions.
- It reads the report from the `OracleConsumer` contract and rejects any report whose status is not `Verified` (`ReportNotVerified`).
- The report's registry-authenticated `project_metadata_hash` must match the bond's registered project metadata hash, otherwise distribution is rejected; the report's canonical registry identity remains its numeric `project_id`.
- The verified report id is persisted in `PeriodInfo`, making every distribution auditable back to its evidence.
- Integer-division remainder that cannot be allocated to holders is recorded as `undistributed` per period and aggregated in `UndistributedTotal`; the admin can recover it via `sweep_undistributed`, which credits the dust to a `destination` wallet's `AccruedCredits` rather than destroying it.

## Retirement Certificates

- `retire_credits` takes the `project_id` and `period_index` from the caller and validates both on-chain: the project against `BondIssuer.get_bond`, the period against `CouponEngine.get_period_info`.
- The certificate caches `report_id`, `vintage_year`, and the monitoring window (`vintage_period_start` / `vintage_period_end`) at retirement time, so reads never re-derive the vintage from the oracle.
- Certificates are keyed in persistent storage and indexed by `(bond_id, holder)`; `extend_retirement_ttl` is permissionless so any relying party can keep a certificate alive.
- See [retirement-certificates.md](retirement-certificates.md) for the certificate schema, the design trade-offs, and the caller migration note.

## API Layer

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /bonds | Issue a new bond tranche |
| GET | /bonds | List active bond tranches |
| GET | /bonds/:id | Get bond details |
| POST | /bonds/:id/subscribe | Subscribe to bond |
| GET | /bonds/:id/holders | List token holders |
| POST | /bonds/:id/coupon | Trigger coupon distribution (by report_id) |
| POST | /bonds/:id/claim | Claim accrued credits (JWT; claims for the session wallet only) |
| GET | /bonds/:id/undistributed | Get undistributed coupon dust total |
| GET | /bonds/:id/periods | Coupon period history (paginated, optional `?include_report=true`) |
| POST | /bonds/:id/sweep-undistributed | Admin: sweep undistributed coupon dust to `destination` (defaults to admin) |
| POST | /bonds/:id/transfer | Transfer bond tokens to another address |
| POST | /projects | Register project |
| GET | /projects | List projects |
| GET | /projects/:id | Get project details |
| POST | /projects/:id/documents | Upload IPFS docs |
| GET | /marketplace/orders | List open orders |
| POST | /marketplace/list | List tokens for sale |
| POST | /marketplace/buy | Purchase tokens |
| GET | /marketplace/prices | Current prices |
| POST | /oracle/reports | Submit oracle report |
| GET | /oracle/reports/:projectId | Get project oracle history |
| POST | /oracle/challenge/:reportId | Challenge a report |
| GET | /oracle/stats/:providerAddress | Provider stats + slash/challenge history |
| GET | /oracle/monitoring/staleness | Per-project/provider staleness metric |

### POST /bonds/:id/claim

Claims the caller's accrued coupon credits on `CouponEngine` and zeroes the
holder's `AccruedCredits` balance for the bond.

- **Identity.** The claiming address is the `sub` claim of the JWT. The
  optional `investorAddress` body field is only cross-checked against it: a
  mismatch returns **403** (an authorisation failure), a malformed address
  returns **400**.
- **Signing.** The API signs with `INVESTOR_SECRET_KEY`, so it can only claim
  for that wallet; any other authenticated caller gets **403**. Accepting a
  wallet-signed XDR is the intended replacement for this server-side custody.
- **Amount.** `credits` is the value `claim_credits` returned — the balance it
  actually zeroed — so partial retirements and concurrent accruals are always
  reflected. Nothing is served from cache.
- **No-op claims.** When nothing is accrued the endpoint returns
  `credits: 0` with an empty `transactionHash` instead of submitting a
  transaction that would consume a nonce and a fee for no effect.

```json
{ "bondId": 1, "investorAddress": "G...", "credits": 500, "transactionHash": "..." }
```

### POST /bonds/:id/sweep-undistributed

Admin-only. Calls `CouponEngine.sweep_undistributed` and credits leftover
coupon dust to a wallet's `AccruedCredits` (the same path holders use, so
the destination can later `claim_credits`).

- **Destination.** Optional body field `destination` (a Stellar public
  key). When omitted the API credits the protocol admin — the public key of
  `ADMIN_SECRET_KEY`. Pass a dedicated treasury address when dust should
  not land on the admin wallet; there is no separate `TREASURY_*` env
  default.
- **Response.** Mirrors on-chain `SweepReceipt`: `amount` (also aliased as
  `swept`), `carbonAmount`, `biodiversityAmount`, and `destination`.

```json
{
  "bondId": 1,
  "destination": "G...",
  "amount": 42,
  "carbonAmount": 30,
  "biodiversityAmount": 12,
  "swept": 42,
  "transactionHash": "..."
}
```

## Frontend

### Component Tree
```
AppComponent
├── WalletButtonComponent
├── DashboardComponent
│   ├── BondCardComponent
│   └── ProjectCardComponent
├── ProjectsListComponent
│   └── ProjectCardComponent
├── ProjectDetailComponent
│   └── StatusBadgeComponent
├── ProjectCreateComponent
├── BondsListComponent
│   ├── BondCardComponent
│   └── StatusBadgeComponent
├── BondDetailComponent
│   ├── StatusBadgeComponent
│   └── LoadingSpinnerComponent
├── IssueBondComponent
├── MarketplaceListComponent
│   ├── StatusBadgeComponent
│   └── LoadingSpinnerComponent
├── MarketplaceSellComponent
└── AuthComponent
```

### Route Map
```
/ → redirect to /dashboard
/dashboard → DashboardComponent
/projects → ProjectsListComponent
/projects/new → ProjectCreateComponent
/projects/:id → ProjectDetailComponent
/bonds → BondsListComponent
/bonds/issue → IssueBondComponent
/bonds/:id → BondDetailComponent
/marketplace → MarketplaceListComponent
/marketplace/sell → MarketplaceSellComponent
/auth → AuthComponent
```
