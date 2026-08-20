use soroban_sdk::{contracttype, BytesN, Symbol, Vec};

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum CreditType {
    Carbon,
    Biodiversity,
    Basket,
    BlueCarbon,
}

/// Canonical oracle methodology symbols for the registered providers.
pub mod methodology {
    /// Blue carbon (mangrove, seagrass, saltmarsh) monitoring.
    pub const BLUE_CARBON: &str = "BLUE-CARBON";
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum BiodiversityMetrics {
    Absent,
    Present((i128, i128, i128)),
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct BondConfig {
    pub project_id: BytesN<32>,
    pub face_value: i128,
    pub coupon_schedule: Vec<u64>,
    pub credit_type: CreditType,
    pub maturity_date: u64,
    pub total_supply: i128,
}

pub type BondId = u64;
pub type ReportId = u64;
pub type OrderId = u64;

#[derive(Clone)]
#[contracttype]
pub struct OracleReport {
    pub project_id: BytesN<32>,
    pub period_start: u64,
    pub period_end: u64,
    pub carbon_sequestered: i128,
    pub methodology: Symbol,
    pub provider_signature: BytesN<64>,
    pub ipfs_evidence_hash: BytesN<32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum BondStatus {
    Active,
    Matured,
    Defaulted,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ProjectStatus {
    Pending,
    Approved,
    Rejected,
    Inactive,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ReportStatus {
    Pending,
    Verified,
    Challenged,
    Rejected,
}

/// A signer's recorded position on a governance proposal.
///
/// `Approve` and `Veto` are the only two states a signer can actively
/// record — the absence of any stored value (returned as `None` by
/// [`get_vote`](../../../governance/src/lib.rs)) means the signer has never
/// voted on this proposal. Distinguishing the three states matters both for
/// the public dashboard (issue #121) and for the internal `AlreadyVoted`
/// guard, which must check for the presence of *any* recorded choice, not
/// for a specific value.
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum VoteChoice {
    Approve,
    Veto,
}
