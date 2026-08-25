use soroban_sdk::{contracttype, Address, BytesN, Env, Symbol, Vec};

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

/// Independence class of a data source, used to enforce methodology
/// diversity in oracle consensus.
///
/// Raw methodology `Symbol`s are arbitrary strings (`verra_vcs` vs
/// `verra-vcs-v2` would read as distinct while describing the same kind of
/// evidence), so diversity is enforced at the category level: every
/// registered methodology maps to exactly one category, and verifiers whose
/// categories collide are treated as correlated sources.
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ProviderCategory {
    /// Ground-truth instrumentation operated at the project site (IoT
    /// sensors, field surveys).
    InSitu,
    /// Satellite / aerial observation of the project area (NDVI, imagery
    /// analysis).
    RemoteSensing,
    /// Registry-backed audit standards issued by an independent third party
    /// (Verra VCS, UK BNG, Gold Standard).
    ThirdPartyAudit,
}

/// Map a canonical methodology symbol to its independence class.
///
/// Registration rejects methodologies outside this closed taxonomy so the
/// provider set stays auditable; see
/// `OracleError::InvalidMethodology`.
pub fn categorize_methodology(env: &Env, methodology: &Symbol) -> Option<ProviderCategory> {
    let third_party_audit = [
        Symbol::new(env, "verra_vcs"),
        Symbol::new(env, "uk_bng"),
        Symbol::new(env, "gold_standard"),
        Symbol::new(env, "blue_carbon"),
    ];
    let remote_sensing = [
        Symbol::new(env, "satellite"),
        Symbol::new(env, "remote_sensing"),
        Symbol::new(env, "ndvi"),
    ];
    let in_situ = [
        Symbol::new(env, "iot"),
        Symbol::new(env, "iot_sensors"),
        Symbol::new(env, "field_survey"),
    ];
    if third_party_audit.contains(methodology) {
        Some(ProviderCategory::ThirdPartyAudit)
    } else if remote_sensing.contains(methodology) {
        Some(ProviderCategory::RemoteSensing)
    } else if in_situ.contains(methodology) {
        Some(ProviderCategory::InSitu)
    } else {
        None
    }
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
    pub project_id: u64,
    pub project_metadata_hash: BytesN<32>,
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

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Project {
    pub id: u64,
    pub owner: Address,
    pub metadata_ipfs_hash: BytesN<32>,
    pub name: Symbol,
    pub status: ProjectStatus,
    pub methodology: Symbol,
    pub country: Symbol,
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
