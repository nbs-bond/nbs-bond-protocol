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
}
