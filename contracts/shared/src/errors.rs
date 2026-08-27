use soroban_sdk::contracterror;

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum BondError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    BondNotFound = 4,
    BondAlreadyMatured = 5,
    InsufficientSupply = 6,
    ZeroAmount = 7,
    ProjectNotApproved = 8,
    Overflow = 9,
    ReportNotVerified = 10,
    InvalidReport = 11,
    /// The period has already been fully distributed.  Replaces the previous
    /// overloaded use of `Overflow` (= 9) for this guard so callers can
    /// distinguish a real arithmetic overflow from a duplicate distribution
    /// attempt.  The old numeric value is intentionally *not* reused.
    PeriodAlreadyDistributed = 12,
    /// A batch call supplied a holder that was already paid in a previous
    /// batch for the same period.  The holder is silently skipped; this
    /// variant is returned only when the *entire* batch consists of already-
    /// paid addresses, so callers can detect a fully-redundant call.
    AlreadyProcessed = 13,
    /// `mature_bond` was called before `config.maturity_date` has elapsed.
    /// Replaces the previous overloaded use of `Overflow` (= 9) for this
    /// guard so callers can distinguish "not mature yet" from a real
    /// arithmetic overflow.
    NotYetMature = 14,
    /// `issue_bond` was called with a `maturity_date` that is already in the
    /// past (at or before the current ledger timestamp). Replaces the
    /// previous overloaded use of `Overflow` (= 9) for this guard.
    MaturityDateInPast = 15,
    /// A holder's own token balance was too small to cover a `transfer` or
    /// `redeem` request. Replaces the previous overloaded use of
    /// `InsufficientSupply` (= 6) for this check, which is reserved for the
    /// bond's total-supply cap in `subscribe`.
    InsufficientBalance = 16,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum OracleError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    ProviderNotFound = 4,
    ProviderAlreadyExists = 5,
    ReportNotFound = 6,
    ReportAlreadyVerified = 7,
    ChallengeWindowExpired = 8,
    InsufficientStake = 9,
    InvalidSignature = 10,
    InvalidResolution = 11,
    SelfChallenge = 12,
    StakeLocked = 13,
    /// The signature threshold is out of range: `0` would make a single
    /// signature trivially sufficient, and a value above the active provider
    /// count could never be reached, permanently deadlocking verification.
    InvalidThreshold = 14,
    /// No trusted project-registry contract has been configured.
    ProjectRegistryNotConfigured = 15,
    /// The supplied numeric project id does not exist in project-registry.
    ProjectNotFound = 16,
    /// The project exists, but its current registry status is not Approved.
    ProjectNotApproved = 17,
    /// The configured registry could not return a decodable linkage record.
    ProjectRegistryCallFailed = 18,
    /// The submitted report's half-open [period_start, period_end) window
    /// overlaps an already-submitted report for the same project, which
    /// would double-count carbon sequestered if both were verified.
    OverlappingReportPeriod = 19,
    /// `challenge_report` was called for a report that already has a
    /// `Challenge` recorded. Replaces the previous overloaded use of
    /// `ProviderAlreadyExists` (= 5), which is reserved for
    /// `register_provider`'s duplicate-provider check.
    ChallengeAlreadyExists = 20,
    /// `accept_admin_transfer` or `cancel_admin_transfer` was called with no
    /// admin transfer currently proposed.
    NoPendingAdminChange = 21,
    /// `accept_admin_transfer` was called before the proposal's timelock
    /// elapsed.
    TimelockNotElapsed = 22,
    /// `challenge_report` was called by an address whose deposited challenge
    /// bond balance is below the required `CHALLENGE_BOND`. Challenges must
    /// be economically backed so they cannot be used for costless griefing
    /// (issue #186).
    InsufficientChallengeBond = 23,
    /// A verifier tried to vote on a challenged report they had already voted
    /// on (a verifier gets exactly one vote, whichever way it was cast).
    AlreadyVoted = 24,
    /// `expire_stale_challenge` was called before the challenge timeout had
    /// elapsed; challenges may only be expired once resolution has stalled
    /// past `CHALLENGE_TIMEOUT_SECONDS`.
    ChallengeNotStale = 25,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum DEXError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    OrderNotFound = 4,
    OrderAlreadyFilled = 5,
    InsufficientBalance = 6,
    SelfBuyNotAllowed = 7,
    OrderExpired = 8,
    ZeroAmount = 9,
    InsufficientFunds = 10,
    Overflow = 11,
    SellerBalanceDepleted = 12,
    InvalidRange = 13,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum RegistryError {
    NotInitialized = 1,
    Unauthorized = 2,
    ProjectNotFound = 3,
    ProjectAlreadyExists = 4,
    InvalidStatusTransition = 5,
    InvalidNonce = 6,
    OracleConsumerNotSet = 7,
    ProjectNotApproved = 8,
    ProjectInactive = 9,
    CannotSuspend = 10,
    /// `accept_admin_transfer` or `cancel_admin_transfer` was called with no
    /// admin transfer currently proposed.
    NoPendingAdminChange = 11,
    /// `accept_admin_transfer` was called before the proposal's timelock
    /// elapsed.
    TimelockNotElapsed = 12,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum CreditError {
    NotInitialized = 1,
    Unauthorized = 2,
    InsufficientCredits = 3,
    AlreadyRetired = 4,
    InvalidNonce = 5,
    NotAHolder = 6,
    InvalidCertificate = 7,
    InvalidCreditType = 8,
    ProjectMismatch = 9,
    PeriodNotFound = 10,
    PeriodNotDistributed = 11,
    InsufficientCreditsByType = 12,
    /// A retirement id lookup (`get_retirement_record`,
    /// `get_retirement_certificate`, `extend_retirement_ttl`) missed.
    /// Replaces the previous overloaded use of `InsufficientCredits` (= 3)
    /// for these "not found" lookups, which is reserved for genuine
    /// insufficient-balance checks in `retire_credits`.
    RetirementNotFound = 13,
    /// A `checked_add` guard on retired-credit totals overflowed. Replaces
    /// the previous overloaded use of `InsufficientCredits` (= 3) for this
    /// arithmetic guard.
    Overflow = 14,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum CouponEngineError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    BondNotFound = 4,
    PeriodNotFound = 5,
    PeriodAlreadyDistributed = 6,
    AlreadyProcessed = 7,
    InvalidReport = 8,
    ReportNotVerified = 9,
    Overflow = 10,
    ZeroAmount = 11,
    ProjectNotApproved = 12,
    /// A holder's combined AccruedCredits balance didn't match the sum of
    /// their per-type balances when claim_credits or sweep_undistributed
    /// tried to zero it out (issue #110). Returned instead of silently
    /// destroying the mismatched amount.
    AccountingMismatch = 13,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum GovernanceError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    NotSigner = 4,
    ProposalNotFound = 5,
    AlreadyVoted = 6,
    NotPending = 7,
    TimelockNotElapsed = 8,
    NotQueued = 9,
    AlreadyExecuted = 10,
    ProposalExpired = 11,
    /// The proposal's `(target, method)` pair is not present in the on-chain
    /// execution allowlist, or the proposal targets the governance contract
    /// itself with a method that is not one of its self-administration
    /// entrypoints. Returned by `execute` *before* the cross-contract call is
    /// dispatched, so a rejected proposal never reaches the target.
    UnauthorizedCall = 12,
    /// A self-administration proposal carried an argument list that could not
    /// be decoded into the expected types, or whose values were out of range
    /// (for example an allowlist longer than `MAX_ALLOWED_CALLS`).
    InvalidCallArgs = 13,
    /// A nonce's "ever initialized" marker exists but the nonce entry itself
    /// is missing (issue #189). Since both are always written and
    /// TTL-extended together, this combination can only mean the nonce was
    /// lost to archival — never that the address simply hasn't transacted
    /// before, which is what makes it safe to treat as an error instead of
    /// silently resetting replay protection to 0.
    NonceArchived = 14,
}
