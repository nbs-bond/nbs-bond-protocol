#![no_std]
#![allow(deprecated)]
use nbbs_shared::{BiodiversityMetrics, OracleError, ReportStatus};
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, BytesN, Env, Symbol, Vec};

pub const CHALLENGE_WINDOW_SECONDS: u64 = 259200;
pub const SLASH_PENALTY_PPM: i128 = 100_000;

// Persistent-storage TTL constants (in ledgers).
// MIN_TTL  ≈  1 day   at 5-second ledger cadence (~17 280 ledgers).
// MAX_TTL  ≈ 120 days at 5-second ledger cadence (~2 073 600 ledgers).
const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND_TO: u32 = 2_073_600;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Provider(Address),
    ProviderList,
    Report(u64),
    ReportCount,
    ProjectReports(BytesN<32>),
    Challenge(u64),
    ReportVerifiers(u64),
    VerificationCount(u64),
    SignatureThreshold,
    ChallengeWindow,
    Nonce(Address),
    ProviderReportCount(Address),
    ProviderChallenges(Address),
    SlashHistory(Address),
    LockedStake(Address),
    ReportLock(u64),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct OracleProvider {
    pub address: Address,
    pub methodology: Symbol,
    pub stake: i128,
    pub active: bool,
    pub registered_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Report {
    pub id: u64,
    pub provider: Address,
    pub project_id: BytesN<32>,
    pub period_start: u64,
    pub period_end: u64,
    pub carbon_sequestered: i128,
    pub biodiversity: BiodiversityMetrics,
    pub methodology: Symbol,
    pub ipfs_evidence_hash: BytesN<32>,
    pub status: ReportStatus,
    pub submitted_at: u64,
    pub verified_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct Challenge {
    pub report_id: u64,
    pub challenger: Address,
    pub counter_evidence_hash: BytesN<32>,
    pub submitted_at: u64,
    pub resolved: bool,
    pub resolution: u32,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct SlashRecord {
    pub report_id: u64,
    pub penalty: i128,
    pub remaining_stake: i128,
    pub timestamp: u64,
    pub active_after: bool,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct ProviderStats {
    pub reports_submitted: u64,
    pub challenges_faced: u64,
    pub slashes: u64,
    pub total_penalty: i128,
    pub stake: i128,
    pub active: bool,
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), OracleError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(OracleError::NotInitialized)?;
    if caller != &admin {
        return Err(OracleError::Unauthorized);
    }
    Ok(())
}

/// Bump a persistent storage key's TTL if it is below the threshold.
fn bump_persistent<
    K: soroban_sdk::TryIntoVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
>(
    env: &Env,
    key: &K,
) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    let key = DataKey::Nonce(addr.clone());
    let val: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    val
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    let key = DataKey::Nonce(addr.clone());
    env.storage().persistent().set(&key, &nonce);
    bump_persistent(env, &key);
}

/// Number of providers currently eligible to verify reports (active only).
/// Removed and stake-exhausted providers remain in `ProviderList` but are
/// flagged inactive and therefore excluded.
fn active_provider_count(env: &Env) -> u32 {
    let list_key = DataKey::ProviderList;
    let providers: Vec<Address> = env
        .storage()
        .persistent()
        .get(&list_key)
        .unwrap_or(vec![env]);
    let mut count: u32 = 0;
    for addr in providers.iter() {
        let key = DataKey::Provider(addr);
        if let Some(p) = env.storage().persistent().get::<DataKey, OracleProvider>(&key) {
            if p.active {
                count += 1;
            }
        }
    }
    count
}

/// Clamp the stored signature threshold down to the active provider count so
/// it can never exceed the eligible verifier set. Runs after any operation
/// that deactivates a provider (explicit removal or stake exhaustion); the
/// threshold floors at 1 (the constructor default) when no providers remain.
fn reconcile_signature_threshold(env: &Env) {
    let threshold_key = DataKey::SignatureThreshold;
    let current: u32 = env
        .storage()
        .instance()
        .get(&threshold_key)
        .unwrap_or(1);
    let adjusted = current.min(active_provider_count(env).max(1));
    if adjusted != current {
        env.storage().instance().set(&threshold_key, &adjusted);
        env.events().publish(
            (Symbol::new(env, "signature_threshold_adjusted"),),
            (adjusted,),
        );
    }
}

#[contract]
pub struct OracleConsumer;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl OracleConsumer {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ChallengeWindow, &CHALLENGE_WINDOW_SECONDS);
        env.storage()
            .instance()
            .set(&DataKey::SignatureThreshold, &1u32);
    }

    pub fn register_provider(
        env: Env,
        caller: Address,
        provider: Address,
        methodology: Symbol,
        nonce: u64,
    ) -> Result<(), OracleError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let provider_key = DataKey::Provider(provider.clone());
        if env.storage().persistent().has(&provider_key) {
            return Err(OracleError::ProviderAlreadyExists);
        }

        let oracle_provider = OracleProvider {
            address: provider.clone(),
            methodology,
            stake: 0,
            active: true,
            registered_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&provider_key, &oracle_provider);
        bump_persistent(&env, &provider_key);

        let list_key = DataKey::ProviderList;
        let mut providers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or(vec![&env]);
        providers.push_back(provider.clone());
        env.storage().persistent().set(&list_key, &providers);
        bump_persistent(&env, &list_key);

        env.events()
            .publish((Symbol::new(&env, "provider_registered"),), (provider,));

        Ok(())
    }

    pub fn remove_provider(
        env: Env,
        caller: Address,
        provider: Address,
        nonce: u64,
    ) -> Result<(), OracleError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let provider_key = DataKey::Provider(provider.clone());
        let mut p: OracleProvider = env
            .storage()
            .persistent()
            .get(&provider_key)
            .ok_or(OracleError::ProviderNotFound)?;

        p.active = false;
        env.storage().persistent().set(&provider_key, &p);
        bump_persistent(&env, &provider_key);

        // Removing a provider shrinks the eligible verifier set; clamp the
        // threshold so it never exceeds the live set.
        reconcile_signature_threshold(&env);

        env.events()
            .publish((Symbol::new(&env, "provider_removed"),), (provider,));

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_report(
        env: Env,
        provider: Address,
        project_id: BytesN<32>,
        period_start: u64,
        period_end: u64,
        carbon_sequestered: i128,
        biodiversity: BiodiversityMetrics,
        methodology: Symbol,
        ipfs_evidence_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<u64, OracleError> {
        provider.require_auth();

        let expected_nonce = get_nonce(&env, &provider);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &provider, expected_nonce + 1);

        let provider_key = DataKey::Provider(provider.clone());
        let p: OracleProvider = env
            .storage()
            .persistent()
            .get(&provider_key)
            .ok_or(OracleError::ProviderNotFound)?;
        bump_persistent(&env, &provider_key);

        if !p.active {
            return Err(OracleError::Unauthorized);
        }

        if period_end <= period_start || carbon_sequestered < 0 {
            return Err(OracleError::InvalidSignature);
        }
        if let BiodiversityMetrics::Present((habitat, species, units)) = &biodiversity {
            if habitat < &0 || species < &0 || units < &0 {
                return Err(OracleError::InvalidSignature);
            }
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ReportCount)
            .unwrap_or(0);
        let report_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::ReportCount, &report_id);

        let now = env.ledger().timestamp();
        let report = Report {
            id: report_id,
            provider: provider.clone(),
            project_id: project_id.clone(),
            period_start,
            period_end,
            carbon_sequestered,
            biodiversity,
            methodology,
            ipfs_evidence_hash,
            status: ReportStatus::Pending,
            submitted_at: now,
            verified_at: 0,
        };

        let report_key = DataKey::Report(report_id);
        env.storage().persistent().set(&report_key, &report);
        bump_persistent(&env, &report_key);

        lock_stake_for_report(&env, &provider, report_id, p.stake);

        let proj_key = DataKey::ProjectReports(project_id.clone());
        let mut project_reports: Vec<u64> = env
            .storage()
            .persistent()
            .get(&proj_key)
            .unwrap_or(vec![&env]);
        project_reports.push_back(report_id);
        env.storage().persistent().set(&proj_key, &project_reports);
        bump_persistent(&env, &proj_key);

        let prc_key = DataKey::ProviderReportCount(provider.clone());
        let report_count: u64 = env.storage().persistent().get(&prc_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&prc_key, &(report_count + 1));
        bump_persistent(&env, &prc_key);

        env.events().publish(
            (Symbol::new(&env, "report_submitted"),),
            (report_id, provider, project_id),
        );

        Ok(report_id)
    }

    pub fn verify_report(
        env: Env,
        caller: Address,
        report_id: u64,
        nonce: u64,
    ) -> Result<(), OracleError> {
        caller.require_auth();

        // Only registered, active providers participate in consensus
        // verification. The admin is deliberately NOT exempt: an admin
        // signature must never count toward the verifier threshold, so a
        // compromised admin cannot mint credits against fabricated reports.
        // Admins who need to force a status change must use the explicit,
        // event-emitting `admin_override_report` path instead.
        let provider_key = DataKey::Provider(caller.clone());
        let p: OracleProvider = env
            .storage()
            .persistent()
            .get(&provider_key)
            .ok_or(OracleError::Unauthorized)?;
        bump_persistent(&env, &provider_key);
        if !p.active {
            return Err(OracleError::Unauthorized);
        }

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        let report_key = DataKey::Report(report_id);
        let mut report: Report = env
            .storage()
            .persistent()
            .get(&report_key)
            .ok_or(OracleError::ReportNotFound)?;

        if report.status != ReportStatus::Pending {
            return Err(OracleError::ReportAlreadyVerified);
        }

        let challenge_key = DataKey::Challenge(report_id);
        if env.storage().persistent().has(&challenge_key) {
            return Err(OracleError::ReportAlreadyVerified);
        }

        if caller == report.provider {
            return Err(OracleError::InvalidSignature);
        }

        let verifiers_key = DataKey::ReportVerifiers(report_id);
        let mut verifiers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&verifiers_key)
            .unwrap_or(vec![&env]);

        let mut already_verified = false;
        for verifier in verifiers.iter() {
            if verifier == caller {
                already_verified = true;
                break;
            }
        }

        if !already_verified {
            verifiers.push_back(caller.clone());
            env.storage().persistent().set(&verifiers_key, &verifiers);
            bump_persistent(&env, &verifiers_key);

            let vc_key = DataKey::VerificationCount(report_id);
            env.storage().persistent().set(&vc_key, &verifiers.len());
            bump_persistent(&env, &vc_key);
        }

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SignatureThreshold)
            .unwrap_or(1);

        if verifiers.len() >= threshold {
            report.status = ReportStatus::Verified;
            report.verified_at = env.ledger().timestamp();
            env.storage().persistent().set(&report_key, &report);
            bump_persistent(&env, &report_key);

            release_report_lock(&env, &report.provider, report_id);

            env.events()
                .publish((Symbol::new(&env, "report_verified"),), (report_id,));
        }

        Ok(())
    }

    /// Explicit, auditable admin override, distinct from provider consensus.
    ///
    /// Admin-only: sets a `Pending` report directly to `Verified` or
    /// `Rejected`, bypassing the signature threshold by design. Unlike
    /// `verify_report`, this path never appends the admin to the verifier
    /// list and never touches `VerificationCount`, and it emits its own
    /// `report_admin_override` event so overrides are traceable on-chain.
    pub fn admin_override_report(
        env: Env,
        caller: Address,
        report_id: u64,
        status: ReportStatus,
        nonce: u64,
    ) -> Result<(), OracleError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        if status != ReportStatus::Verified && status != ReportStatus::Rejected {
            return Err(OracleError::InvalidResolution);
        }

        let report_key = DataKey::Report(report_id);
        let mut report: Report = env
            .storage()
            .persistent()
            .get(&report_key)
            .ok_or(OracleError::ReportNotFound)?;

        if report.status != ReportStatus::Pending {
            return Err(OracleError::ReportAlreadyVerified);
        }

        report.status = status;
        report.verified_at = env.ledger().timestamp();
        env.storage().persistent().set(&report_key, &report);
        bump_persistent(&env, &report_key);

        env.events().publish(
            (Symbol::new(&env, "report_admin_override"),),
            (report_id, status as u32),
        );

        Ok(())
    }

    pub fn challenge_report(
        env: Env,
        challenger: Address,
        report_id: u64,
        counter_evidence_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<(), OracleError> {
        challenger.require_auth();

        let expected_nonce = get_nonce(&env, &challenger);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &challenger, expected_nonce + 1);

        let report_key = DataKey::Report(report_id);
        let report: Report = env
            .storage()
            .persistent()
            .get(&report_key)
            .ok_or(OracleError::ReportNotFound)?;
        bump_persistent(&env, &report_key);

        if report.status != ReportStatus::Pending {
            return Err(OracleError::ReportAlreadyVerified);
        }

        if challenger == report.provider {
            return Err(OracleError::SelfChallenge);
        }

        let now = env.ledger().timestamp();
        let window: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ChallengeWindow)
            .unwrap_or(CHALLENGE_WINDOW_SECONDS);
        if now.saturating_sub(report.submitted_at) > window {
            return Err(OracleError::ChallengeWindowExpired);
        }

        let challenge_key = DataKey::Challenge(report_id);
        if env.storage().persistent().has(&challenge_key) {
            return Err(OracleError::ProviderAlreadyExists);
        }

        let challenge = Challenge {
            report_id,
            challenger: challenger.clone(),
            counter_evidence_hash,
            submitted_at: now,
            resolved: false,
            resolution: 0,
        };
        env.storage().persistent().set(&challenge_key, &challenge);
        bump_persistent(&env, &challenge_key);

        let mut report_mut: Report = env.storage().persistent().get(&report_key).unwrap();
        report_mut.status = ReportStatus::Challenged;
        env.storage().persistent().set(&report_key, &report_mut);
        bump_persistent(&env, &report_key);

        let pc_key = DataKey::ProviderChallenges(report.provider.clone());
        let mut provider_challenges: Vec<u64> = env
            .storage()
            .persistent()
            .get(&pc_key)
            .unwrap_or(vec![&env]);
        provider_challenges.push_back(report_id);
        env.storage()
            .persistent()
            .set(&pc_key, &provider_challenges);
        bump_persistent(&env, &pc_key);

        env.events().publish(
            (Symbol::new(&env, "report_challenged"),),
            (report_id, challenger),
        );

        Ok(())
    }

    pub fn resolve_challenge(
        env: Env,
        caller: Address,
        report_id: u64,
        resolution: ReportStatus,
        nonce: u64,
    ) -> Result<(), OracleError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        if resolution != ReportStatus::Verified && resolution != ReportStatus::Rejected {
            return Err(OracleError::InvalidResolution);
        }

        let challenge_key = DataKey::Challenge(report_id);
        let mut challenge: Challenge = env
            .storage()
            .persistent()
            .get(&challenge_key)
            .ok_or(OracleError::ReportNotFound)?;

        if challenge.resolved {
            return Ok(());
        }

        challenge.resolved = true;
        challenge.resolution = resolution as u32;
        env.storage().persistent().set(&challenge_key, &challenge);
        bump_persistent(&env, &challenge_key);

        let report_key = DataKey::Report(report_id);
        let mut report: Report = env
            .storage()
            .persistent()
            .get(&report_key)
            .ok_or(OracleError::ReportNotFound)?;
        report.status = resolution;
        if resolution == ReportStatus::Verified {
            report.verified_at = env.ledger().timestamp();
        }
        env.storage().persistent().set(&report_key, &report);
        bump_persistent(&env, &report_key);

        release_report_lock(&env, &report.provider, report_id);

        if resolution == ReportStatus::Rejected {
            slash_provider(&env, &report.provider, report_id);
        }

        env.events().publish(
            (Symbol::new(&env, "challenge_resolved"),),
            (report_id, resolution as u32),
        );

        Ok(())
    }

    pub fn get_provider(env: Env, provider: Address) -> Result<OracleProvider, OracleError> {
        let key = DataKey::Provider(provider);
        let val = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(OracleError::ProviderNotFound)?;
        bump_persistent(&env, &key);
        Ok(val)
    }

    pub fn get_report(env: Env, report_id: u64) -> Result<Report, OracleError> {
        let key = DataKey::Report(report_id);
        let val = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(OracleError::ReportNotFound)?;
        bump_persistent(&env, &key);
        Ok(val)
    }

    pub fn list_providers(env: Env) -> Vec<Address> {
        let key = DataKey::ProviderList;
        let val = env.storage().persistent().get(&key).unwrap_or(vec![&env]);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn get_project_reports(env: Env, project_id: BytesN<32>) -> Vec<u64> {
        let key = DataKey::ProjectReports(project_id);
        let val = env.storage().persistent().get(&key).unwrap_or(vec![&env]);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn get_challenge(env: Env, report_id: u64) -> Result<Challenge, OracleError> {
        let key = DataKey::Challenge(report_id);
        let val = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(OracleError::ReportNotFound)?;
        bump_persistent(&env, &key);
        Ok(val)
    }

    pub fn get_verification_count(env: Env, report_id: u64) -> u32 {
        let key = DataKey::VerificationCount(report_id);
        let val = env.storage().persistent().get(&key).unwrap_or(0);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn get_report_verifiers(env: Env, report_id: u64) -> Vec<Address> {
        let key = DataKey::ReportVerifiers(report_id);
        let val = env.storage().persistent().get(&key).unwrap_or(vec![&env]);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn get_provider_stats(env: Env, provider: Address) -> Result<ProviderStats, OracleError> {
        let provider_key = DataKey::Provider(provider.clone());
        let p: OracleProvider = env
            .storage()
            .persistent()
            .get(&provider_key)
            .ok_or(OracleError::ProviderNotFound)?;
        bump_persistent(&env, &provider_key);

        let prc_key = DataKey::ProviderReportCount(provider.clone());
        let reports_submitted: u64 = env.storage().persistent().get(&prc_key).unwrap_or(0);
        if env.storage().persistent().has(&prc_key) {
            bump_persistent(&env, &prc_key);
        }

        let pc_key = DataKey::ProviderChallenges(provider.clone());
        let challenges: Vec<u64> = env
            .storage()
            .persistent()
            .get(&pc_key)
            .unwrap_or(vec![&env]);
        if env.storage().persistent().has(&pc_key) {
            bump_persistent(&env, &pc_key);
        }

        let sh_key = DataKey::SlashHistory(provider.clone());
        let history: Vec<SlashRecord> = env
            .storage()
            .persistent()
            .get(&sh_key)
            .unwrap_or(vec![&env]);
        if env.storage().persistent().has(&sh_key) {
            bump_persistent(&env, &sh_key);
        }

        let mut total_penalty: i128 = 0;
        for record in history.iter() {
            total_penalty += record.penalty;
        }

        Ok(ProviderStats {
            reports_submitted,
            challenges_faced: challenges.len() as u64,
            slashes: history.len() as u64,
            total_penalty,
            stake: p.stake,
            active: p.active,
        })
    }

    pub fn get_locked_stake(env: Env, provider: Address) -> i128 {
        let key = DataKey::LockedStake(provider);
        let val = env.storage().persistent().get(&key).unwrap_or(0);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn get_slash_history(env: Env, provider: Address) -> Vec<SlashRecord> {
        let key = DataKey::SlashHistory(provider);
        let val = env.storage().persistent().get(&key).unwrap_or(vec![&env]);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn get_challenge_history(env: Env, provider: Address) -> Vec<Challenge> {
        let pc_key = DataKey::ProviderChallenges(provider);
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&pc_key)
            .unwrap_or(vec![&env]);
        if env.storage().persistent().has(&pc_key) {
            bump_persistent(&env, &pc_key);
        }

        let mut challenges: Vec<Challenge> = vec![&env];
        for id in ids.iter() {
            let c_key = DataKey::Challenge(id);
            if let Some(challenge) = env.storage().persistent().get::<DataKey, Challenge>(&c_key) {
                bump_persistent(&env, &c_key);
                challenges.push_back(challenge);
            }
        }
        challenges
    }

    pub fn set_signature_threshold(
        env: Env,
        caller: Address,
        threshold: u32,
        nonce: u64,
    ) -> Result<(), OracleError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        // A threshold of 0 would make `verifiers.len() >= threshold` trivially
        // true (single-signature spoofing), and a threshold above the active
        // provider count could never be reached, permanently deadlocking every
        // report in Pending.
        let active = active_provider_count(&env);
        if threshold == 0 || threshold > active {
            return Err(OracleError::InvalidThreshold);
        }

        env.storage()
            .instance()
            .set(&DataKey::SignatureThreshold, &threshold);

        Ok(())
    }

    pub fn get_signature_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::SignatureThreshold)
            .unwrap_or(1)
    }

    pub fn add_stake(
        env: Env,
        provider: Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), OracleError> {
        provider.require_auth();

        let expected_nonce = get_nonce(&env, &provider);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &provider, expected_nonce + 1);

        if amount <= 0 {
            return Err(OracleError::InsufficientStake);
        }

        let provider_key = DataKey::Provider(provider.clone());
        let mut p: OracleProvider = env
            .storage()
            .persistent()
            .get(&provider_key)
            .ok_or(OracleError::ProviderNotFound)?;

        p.stake = p
            .stake
            .checked_add(amount)
            .ok_or(OracleError::InsufficientStake)?;
        env.storage().persistent().set(&provider_key, &p);
        bump_persistent(&env, &provider_key);

        env.events()
            .publish((Symbol::new(&env, "stake_added"),), (provider, amount));

        Ok(())
    }

    pub fn withdraw_stake(
        env: Env,
        provider: Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), OracleError> {
        provider.require_auth();

        let expected_nonce = get_nonce(&env, &provider);
        if nonce != expected_nonce {
            return Err(OracleError::InvalidNonce);
        }
        set_nonce(&env, &provider, expected_nonce + 1);

        if amount <= 0 {
            return Err(OracleError::InsufficientStake);
        }

        let provider_key = DataKey::Provider(provider.clone());
        let mut p: OracleProvider = env
            .storage()
            .persistent()
            .get(&provider_key)
            .ok_or(OracleError::ProviderNotFound)?;

        if p.stake < amount {
            return Err(OracleError::InsufficientStake);
        }

        let locked_key = DataKey::LockedStake(provider.clone());
        let locked: i128 = env.storage().persistent().get(&locked_key).unwrap_or(0);
        if p.stake - amount < locked {
            return Err(OracleError::StakeLocked);
        }

        p.stake -= amount;
        env.storage().persistent().set(&provider_key, &p);
        bump_persistent(&env, &provider_key);

        env.events()
            .publish((Symbol::new(&env, "stake_withdrawn"),), (provider, amount));

        Ok(())
    }
}

/// The amount of stake that would be forfeited if `stake` were slashed right now.
fn slashable_amount(stake: i128) -> i128 {
    let mut penalty = stake * SLASH_PENALTY_PPM / 1_000_000;
    if penalty <= 0 {
        penalty = stake;
    }
    if penalty > stake {
        penalty = stake;
    }
    penalty
}

/// Reserve the amount that could be slashed for a newly-submitted report so it
/// cannot be withdrawn before the report is resolved (verified/rejected).
fn lock_stake_for_report(env: &Env, provider: &Address, report_id: u64, stake: i128) {
    let lock_amount = slashable_amount(stake);

    let report_lock_key = DataKey::ReportLock(report_id);
    env.storage()
        .persistent()
        .set(&report_lock_key, &lock_amount);
    bump_persistent(env, &report_lock_key);

    let locked_key = DataKey::LockedStake(provider.clone());
    let locked: i128 = env.storage().persistent().get(&locked_key).unwrap_or(0);
    env.storage()
        .persistent()
        .set(&locked_key, &(locked + lock_amount));
    bump_persistent(env, &locked_key);
}

/// Release a report's reserved stake once it reaches a terminal status
/// (Verified or Rejected).
fn release_report_lock(env: &Env, provider: &Address, report_id: u64) {
    let report_lock_key = DataKey::ReportLock(report_id);
    let lock_amount: i128 = env
        .storage()
        .persistent()
        .get(&report_lock_key)
        .unwrap_or(0);
    if lock_amount == 0 {
        return;
    }
    env.storage().persistent().remove(&report_lock_key);

    let locked_key = DataKey::LockedStake(provider.clone());
    let locked: i128 = env.storage().persistent().get(&locked_key).unwrap_or(0);
    let new_locked = if lock_amount > locked {
        0
    } else {
        locked - lock_amount
    };
    env.storage().persistent().set(&locked_key, &new_locked);
    bump_persistent(env, &locked_key);
}

fn slash_provider(env: &Env, provider: &Address, report_id: u64) {
    let provider_key = DataKey::Provider(provider.clone());
    let mut p: OracleProvider = env.storage().persistent().get(&provider_key).unwrap();

    let penalty = slashable_amount(p.stake);

    p.stake -= penalty;
    if p.stake == 0 {
        p.active = false;
    }
    env.storage().persistent().set(&provider_key, &p);
    bump_persistent(env, &provider_key);

    // A stake-exhausted provider is deactivated, shrinking the eligible
    // verifier set; clamp the threshold so it never exceeds the live set.
    reconcile_signature_threshold(env);

    let sh_key = DataKey::SlashHistory(provider.clone());
    let mut history: Vec<SlashRecord> = env
        .storage()
        .persistent()
        .get(&sh_key)
        .unwrap_or(vec![&env]);
    history.push_back(SlashRecord {
        report_id,
        penalty,
        remaining_stake: p.stake,
        timestamp: env.ledger().timestamp(),
        active_after: p.active,
    });
    env.storage().persistent().set(&sh_key, &history);
    bump_persistent(env, &sh_key);

    env.events().publish(
        (Symbol::new(env, "provider_slashed"),),
        (provider.clone(), penalty, p.stake, p.active),
    );
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        BytesN, Env, Symbol,
    };

    fn create_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_ipfs_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = value;
        BytesN::from_array(env, &arr)
    }

    #[test]
    fn test_register_provider_and_submit_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let verifier = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);
        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &verifier, &Symbol::new(&env, "satellite"), &1);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );
        assert_eq!(report_id, 1);

        let stored = client.get_report(&report_id);
        assert_eq!(stored.status, ReportStatus::Pending);
        assert_eq!(stored.provider, provider);
        assert_eq!(stored.carbon_sequestered, 100_000);

        env.ledger().set_timestamp(1_000_001);
        client.verify_report(&verifier, &report_id, &0);

        let verified = client.get_report(&report_id);
        assert_eq!(verified.status, ReportStatus::Verified);
        assert_eq!(verified.verified_at, 1_000_001);

        let providers = client.list_providers();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers.get(0).unwrap(), provider);

        let project_reports = client.get_project_reports(&project_id);
        assert_eq!(project_reports.len(), 1);
        assert_eq!(project_reports.get(0).unwrap(), report_id);
    }

    #[test]
    fn test_submit_report_with_biodiversity_metrics() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "uk_bng"), &0);

        let metrics = nbbs_shared::BiodiversityMetrics::Present((500, 125, 1_000));
        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &0i128,
            &metrics,
            &Symbol::new(&env, "uk_bng"),
            &make_ipfs_hash(&env, 1),
            &0,
        );
        assert_eq!(report_id, 1);

        let stored = client.get_report(&report_id);
        assert_eq!(stored.biodiversity, metrics);
        assert_eq!(stored.carbon_sequestered, 0);
    }

    #[test]
    fn test_submit_report_rejects_negative_biodiversity_metrics() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "uk_bng"), &0);

        let metrics = nbbs_shared::BiodiversityMetrics::Present((-1, 0, 0));
        let result = client.try_submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &0i128,
            &metrics,
            &Symbol::new(&env, "uk_bng"),
            &make_ipfs_hash(&env, 1),
            &0,
        );
        assert_eq!(result, Err(Ok(OracleError::InvalidSignature)));
    }

    #[test]
    fn test_submit_challenge_and_resolve() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        let challenged = client.get_report(&report_id);
        assert_eq!(challenged.status, ReportStatus::Challenged);

        let challenge = client.get_challenge(&report_id);
        assert_eq!(challenge.report_id, report_id);
        assert_eq!(challenge.challenger, challenger);
        assert!(!challenge.resolved);

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Verified, &1);

        let resolved = client.get_report(&report_id);
        assert_eq!(resolved.status, ReportStatus::Verified);

        let stored_challenge = client.get_challenge(&report_id);
        assert!(stored_challenge.resolved);
        assert_eq!(stored_challenge.resolution, ReportStatus::Verified as u32);
    }

    #[test]
    fn test_provider_cannot_challenge_own_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);
        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        env.ledger()
            .set_timestamp(1_000_000 + CHALLENGE_WINDOW_SECONDS + 1);

        let result =
            client.try_challenge_report(&provider, &report_id, &make_ipfs_hash(&env, 2), &1);

        assert_eq!(result, Err(Ok(OracleError::SelfChallenge)));
        assert_eq!(client.get_report(&report_id).status, ReportStatus::Pending);
        assert!(matches!(
            client.try_get_challenge(&report_id),
            Err(Ok(OracleError::ReportNotFound))
        ));
    }

    #[test]
    fn test_late_challenge() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1_000_100u64,
            &1_000_200u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        env.ledger()
            .set_timestamp(1_000_000 + CHALLENGE_WINDOW_SECONDS + 1);

        let result =
            client.try_challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);
        assert_eq!(result, Err(Ok(OracleError::ChallengeWindowExpired)));
    }

    #[test]
    fn test_challenge_allowed_when_clock_precedes_submission() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);
        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1_000_100u64,
            &1_000_200u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        env.ledger().set_timestamp(900_000);

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        let challenged = client.get_report(&report_id);
        assert_eq!(challenged.status, ReportStatus::Challenged);
    }

    #[test]
    fn test_submit_from_non_registered() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let rogue = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        let result = client.try_submit_report(
            &rogue,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );
        assert_eq!(result, Err(Ok(OracleError::ProviderNotFound)));
    }

    #[test]
    fn test_duplicate_provider() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let result =
            client.try_register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &1);
        assert_eq!(result, Err(Ok(OracleError::ProviderAlreadyExists)));
    }

    #[test]
    fn test_double_verify() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let verifier = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &verifier, &Symbol::new(&env, "satellite"), &1);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.verify_report(&verifier, &report_id, &0);

        let result = client.try_verify_report(&provider, &report_id, &1);
        assert_eq!(result, Err(Ok(OracleError::ReportAlreadyVerified)));
    }

    #[test]
    fn test_challenge_verified_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let verifier = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &verifier, &Symbol::new(&env, "satellite"), &1);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.verify_report(&verifier, &report_id, &0);

        let result =
            client.try_challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);
        assert_eq!(result, Err(Ok(OracleError::ReportAlreadyVerified)));
    }

    #[test]
    fn test_verify_report_by_any_address_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let stranger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        let result = client.try_verify_report(&stranger, &report_id, &0);
        assert_eq!(result, Err(Ok(OracleError::Unauthorized)));

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Pending);
    }

    #[test]
    fn test_verify_report_by_provider() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);

        let report_id = client.submit_report(
            &provider_a,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.verify_report(&provider_b, &report_id, &0);

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Verified);
    }

    #[test]
    fn test_inactive_provider_submission() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.remove_provider(&admin, &provider, &1);

        let result = client.try_submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );
        assert_eq!(result, Err(Ok(OracleError::Unauthorized)));
    }

    #[test]
    fn test_resolve_challenge_to_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &1);

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Rejected);
    }

    #[test]
    fn test_resolve_already_resolved_challenge() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Verified, &1);

        let result = client.try_resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &2);
        assert_eq!(result, Ok(Ok(())));
    }

    #[test]
    fn test_resolve_challenge_rejects_non_terminal_status() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        for invalid in [ReportStatus::Pending, ReportStatus::Challenged] {
            let result = client.try_resolve_challenge(&admin, &report_id, &invalid, &1);
            assert_eq!(result, Err(Ok(OracleError::InvalidResolution)));
        }

        let challenge = client.get_challenge(&report_id);
        assert!(!challenge.resolved);
    }

    #[test]
    fn test_get_nonexistent_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        let result = client.try_get_report(&999);
        assert_eq!(result, Err(Ok(OracleError::ReportNotFound)));
    }

    #[test]
    fn test_get_nonexistent_provider() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        let result = client.try_get_provider(&stranger);
        assert_eq!(result, Err(Ok(OracleError::ProviderNotFound)));
    }

    #[test]
    fn test_set_signature_threshold() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let provider_c = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);
        client.register_provider(&admin, &provider_c, &Symbol::new(&env, "iot"), &2);

        // Exactly the active provider count is the maximum allowed.
        client.set_signature_threshold(&admin, &3u32, &3);
        assert_eq!(client.get_signature_threshold(), 3);

        client.set_signature_threshold(&admin, &1u32, &4);
        assert_eq!(client.get_signature_threshold(), 1);

        client.set_signature_threshold(&admin, &3u32, &5);
        assert_eq!(client.get_signature_threshold(), 3);
    }

    #[test]
    fn test_set_signature_threshold_zero_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);

        // 0 would make `verifiers.len() >= threshold` trivially true, so a
        // single signature would suffice; it must revert.
        let result = client.try_set_signature_threshold(&admin, &0u32, &2);
        assert_eq!(result, Err(Ok(OracleError::InvalidThreshold)));
        assert_eq!(client.get_signature_threshold(), 1);

        // A valid value is still accepted afterwards. The revert rolls back
        // the nonce increment, so the same nonce can be retried.
        client.set_signature_threshold(&admin, &2u32, &2);
        assert_eq!(client.get_signature_threshold(), 2);
    }

    #[test]
    fn test_set_signature_threshold_above_active_count_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);

        // Above the active provider count the threshold could never be reached,
        // permanently deadlocking every report in Pending; it must revert.
        let result = client.try_set_signature_threshold(&admin, &2u32, &1);
        assert_eq!(result, Err(Ok(OracleError::InvalidThreshold)));
        assert_eq!(client.get_signature_threshold(), 1);

        // The revert rolls back the nonce increment, so the same nonce works
        // for a value that is within range.
        client.set_signature_threshold(&admin, &1u32, &1);
        assert_eq!(client.get_signature_threshold(), 1);
    }

    #[test]
    fn test_set_signature_threshold_without_providers_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        // With no active providers even a threshold of 1 exceeds the eligible
        // verifier set, so setting one must revert.
        let result = client.try_set_signature_threshold(&admin, &1u32, &0);
        assert_eq!(result, Err(Ok(OracleError::InvalidThreshold)));
        assert_eq!(client.get_signature_threshold(), 1);
    }

    #[test]
    fn test_remove_provider_adjusts_threshold() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let provider_c = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);
        client.register_provider(&admin, &provider_c, &Symbol::new(&env, "iot"), &2);

        client.set_signature_threshold(&admin, &3u32, &3);
        assert_eq!(client.get_signature_threshold(), 3);

        // Removing a provider shrinks the eligible verifier set, so the
        // threshold is clamped down instead of deadlocking verification.
        client.remove_provider(&admin, &provider_c, &4);
        assert_eq!(client.get_signature_threshold(), 2);

        client.remove_provider(&admin, &provider_b, &5);
        assert_eq!(client.get_signature_threshold(), 1);

        // The last provider can still be removed; the threshold floors at 1.
        client.remove_provider(&admin, &provider_a, &6);
        assert_eq!(client.get_signature_threshold(), 1);
    }

    #[test]
    fn test_slash_deactivation_adjusts_threshold() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);

        client.add_stake(&provider_a, &5i128, &0);
        client.add_stake(&provider_b, &100_000i128, &0);

        client.set_signature_threshold(&admin, &2u32, &2);
        assert_eq!(client.get_signature_threshold(), 2);

        let report_id = client.submit_report(
            &provider_a,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);
        client.resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &3);

        // provider_a is slashed to zero stake and deactivated; only one
        // eligible verifier remains, so the threshold is clamped to 1.
        let p = client.get_provider(&provider_a);
        assert_eq!(p.stake, 0);
        assert!(!p.active);
        assert_eq!(client.get_signature_threshold(), 1);
    }

    #[test]
    fn test_add_and_withdraw_stake() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        assert_eq!(client.get_provider(&provider).stake, 0);

        client.add_stake(&provider, &50_000i128, &0);
        assert_eq!(client.get_provider(&provider).stake, 50_000);

        let result = client.try_withdraw_stake(&provider, &60_000i128, &1);
        assert_eq!(result, Err(Ok(OracleError::InsufficientStake)));

        client.withdraw_stake(&provider, &20_000i128, &1);
        assert_eq!(client.get_provider(&provider).stake, 30_000);
    }

    #[test]
    fn test_stake_requires_registered_provider() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let rogue = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        let result = client.try_add_stake(&rogue, &1_000i128, &0);
        assert_eq!(result, Err(Ok(OracleError::ProviderNotFound)));
    }

    #[test]
    fn test_stake_zero_amount_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let result = client.try_add_stake(&provider, &0i128, &0);
        assert_eq!(result, Err(Ok(OracleError::InsufficientStake)));
    }

    #[test]
    fn test_withdraw_full_stake_blocked_while_report_pending() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        client.add_stake(&provider, &100_000i128, &0);

        client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        assert_eq!(client.get_locked_stake(&provider), 10_000);

        let result = client.try_withdraw_stake(&provider, &100_000i128, &2);
        assert_eq!(result, Err(Ok(OracleError::StakeLocked)));

        client.withdraw_stake(&provider, &90_000i128, &2);
        assert_eq!(client.get_provider(&provider).stake, 10_000);

        let result = client.try_withdraw_stake(&provider, &1i128, &3);
        assert_eq!(result, Err(Ok(OracleError::StakeLocked)));
    }

    #[test]
    fn test_withdraw_lock_releases_after_report_verified() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let verifier = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &verifier, &Symbol::new(&env, "satellite"), &1);
        client.add_stake(&provider, &100_000i128, &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        let result = client.try_withdraw_stake(&provider, &100_000i128, &2);
        assert_eq!(result, Err(Ok(OracleError::StakeLocked)));

        client.verify_report(&verifier, &report_id, &0);
        assert_eq!(client.get_locked_stake(&provider), 0);

        client.withdraw_stake(&provider, &100_000i128, &2);
        assert_eq!(client.get_provider(&provider).stake, 0);
    }

    #[test]
    fn test_withdraw_lock_releases_after_challenge_resolved() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.add_stake(&provider, &100_000i128, &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        let result = client.try_withdraw_stake(&provider, &100_000i128, &2);
        assert_eq!(result, Err(Ok(OracleError::StakeLocked)));

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Verified, &1);
        assert_eq!(client.get_locked_stake(&provider), 0);

        client.withdraw_stake(&provider, &100_000i128, &2);
        assert_eq!(client.get_provider(&provider).stake, 0);
    }

    /// Reproduces the escape sequence from issue #182: a provider used to be
    /// able to submit a report, withdraw their entire stake before it was
    /// resolved, and have `slash_provider` compute a zero penalty on
    /// rejection. The stake lock must keep the sequence from working.
    #[test]
    fn test_issue_182_escape_sequence_now_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.add_stake(&provider, &1_000i128, &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        let result = client.try_withdraw_stake(&provider, &1_000i128, &2);
        assert_eq!(result, Err(Ok(OracleError::StakeLocked)));

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);
        client.resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &1);

        let slashed = client.get_provider(&provider);
        assert_eq!(slashed.stake, 900);
        assert_eq!(
            client.get_slash_history(&provider).get(0).unwrap().penalty,
            100
        );
    }

    #[test]
    fn test_rejected_challenge_slashes_provider() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.add_stake(&provider, &100_000i128, &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &1);

        let slashed = client.get_provider(&provider);
        assert_eq!(slashed.stake, 100_000 - 10_000);
        assert!(slashed.active);

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Rejected);
    }

    #[test]
    fn test_rejected_challenge_zeroes_stake_and_deactivates() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.add_stake(&provider, &5i128, &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &1);

        let slashed = client.get_provider(&provider);
        assert_eq!(slashed.stake, 0);
        assert!(!slashed.active);
    }

    #[test]
    fn test_verified_resolution_does_not_slash() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.add_stake(&provider, &100_000i128, &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Verified, &1);

        let provider_state = client.get_provider(&provider);
        assert_eq!(provider_state.stake, 100_000);
        assert!(provider_state.active);
    }

    #[test]
    fn test_provider_stats_and_slash_history() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let challenger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);
        client.add_stake(&provider, &100_000i128, &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &1,
        );
        client.submit_report(
            &provider,
            &project_id,
            &2001u64,
            &3000u64,
            &120_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &2,
        );

        client.challenge_report(&challenger, &report_id, &make_ipfs_hash(&env, 2), &0);

        client.resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &1);

        let stats = client.get_provider_stats(&provider);
        assert_eq!(stats.reports_submitted, 2);
        assert_eq!(stats.challenges_faced, 1);
        assert_eq!(stats.slashes, 1);
        assert_eq!(stats.total_penalty, 10_000);
        assert_eq!(stats.stake, 90_000);
        assert!(stats.active);

        let history = client.get_slash_history(&provider);
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap().report_id, report_id);
        assert_eq!(history.get(0).unwrap().penalty, 10_000);
        assert_eq!(history.get(0).unwrap().remaining_stake, 90_000);
        assert!(history.get(0).unwrap().active_after);

        let challenges = client.get_challenge_history(&provider);
        assert_eq!(challenges.len(), 1);
        assert_eq!(challenges.get(0).unwrap().report_id, report_id);
        assert!(challenges.get(0).unwrap().resolved);
        assert_eq!(
            challenges.get(0).unwrap().resolution,
            ReportStatus::Rejected as u32
        );
    }

    #[test]
    fn test_provider_stats_initial_zeros() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let stats = client.get_provider_stats(&provider);
        assert_eq!(stats.reports_submitted, 0);
        assert_eq!(stats.challenges_faced, 0);
        assert_eq!(stats.slashes, 0);
        assert_eq!(stats.total_penalty, 0);
        assert_eq!(stats.stake, 0);
        assert!(stats.active);

        assert_eq!(client.get_slash_history(&provider).len(), 0);
        assert_eq!(client.get_challenge_history(&provider).len(), 0);
    }

    #[test]
    fn test_provider_stats_nonexistent_provider() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        let result = client.try_get_provider_stats(&stranger);
        assert_eq!(result, Err(Ok(OracleError::ProviderNotFound)));
    }

    fn register_provider_and_submit(
        env: &Env,
        client: &OracleConsumerClient<'static>,
        admin: &Address,
        provider: &Address,
        project_id: &BytesN<32>,
        provider_nonce: u64,
        admin_nonce: u64,
    ) -> u64 {
        client.register_provider(
            admin,
            provider,
            &Symbol::new(env, "verra_vcs"),
            &admin_nonce,
        );
        client.submit_report(
            provider,
            project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(env, "verra_vcs"),
            &make_ipfs_hash(env, 1),
            &provider_nonce,
        )
    }

    #[test]
    fn test_threshold_requires_multiple_verifiers() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let provider_c = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);
        client.register_provider(&admin, &provider_c, &Symbol::new(&env, "iot"), &2);

        client.set_signature_threshold(&admin, &2u32, &3);

        let report_id = client.submit_report(
            &provider_a,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.verify_report(&provider_b, &report_id, &0);
        assert_eq!(client.get_verification_count(&report_id), 1);

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Pending);

        client.verify_report(&provider_c, &report_id, &0);
        assert_eq!(client.get_verification_count(&report_id), 2);

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Verified);

        let verifiers = client.get_report_verifiers(&report_id);
        assert_eq!(verifiers.len(), 2);
        assert_eq!(verifiers.get(0).unwrap(), provider_b);
        assert_eq!(verifiers.get(1).unwrap(), provider_c);
    }

    #[test]
    fn test_same_verifier_does_not_double_count() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let provider_c = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);
        client.register_provider(&admin, &provider_c, &Symbol::new(&env, "iot"), &2);

        client.set_signature_threshold(&admin, &2u32, &3);

        let report_id = client.submit_report(
            &provider_a,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.verify_report(&provider_b, &report_id, &0);
        let result = client.try_verify_report(&provider_b, &report_id, &1);
        assert_eq!(result, Ok(Ok(())));
        assert_eq!(client.get_verification_count(&report_id), 1);

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Pending);

        client.verify_report(&provider_c, &report_id, &0);
        assert_eq!(client.get_verification_count(&report_id), 2);
    }

    #[test]
    fn test_provider_cannot_verify_own_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        let report_id =
            register_provider_and_submit(&env, &client, &admin, &provider_a, &project_id, 0, 0);

        let result = client.try_verify_report(&provider_a, &report_id, &1);
        assert_eq!(result, Err(Ok(OracleError::InvalidSignature)));

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Pending);
        assert_eq!(client.get_verification_count(&report_id), 0);
    }

    #[test]
    fn test_admin_verify_report_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let provider_c = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider_a, &Symbol::new(&env, "verra_vcs"), &0);
        client.register_provider(&admin, &provider_b, &Symbol::new(&env, "satellite"), &1);
        client.register_provider(&admin, &provider_c, &Symbol::new(&env, "iot"), &2);

        client.set_signature_threshold(&admin, &2u32, &3);

        let report_id = client.submit_report(
            &provider_a,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        // Admin is not a registered provider: the admin's signature must not
        // count toward the threshold, so `verify_report` rejects it outright.
        let result = client.try_verify_report(&admin, &report_id, &4);
        assert_eq!(result, Err(Ok(OracleError::Unauthorized)));
        assert_eq!(client.get_verification_count(&report_id), 0);
        assert_eq!(client.get_report_verifiers(&report_id).len(), 0);

        // With threshold 2, two independent provider signatures are required.
        client.verify_report(&provider_b, &report_id, &0);
        assert_eq!(client.get_verification_count(&report_id), 1);
        assert_eq!(client.get_report(&report_id).status, ReportStatus::Pending);

        client.verify_report(&provider_c, &report_id, &0);
        assert_eq!(client.get_verification_count(&report_id), 2);
        assert_eq!(client.get_report(&report_id).status, ReportStatus::Verified);
    }

    #[test]
    fn test_admin_override_verifies_pending_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        env.ledger().set_timestamp(2_000_000);
        client.admin_override_report(&admin, &report_id, &ReportStatus::Verified, &1);

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Verified);
        assert_eq!(report.verified_at, 2_000_000);
        // The override is distinct from provider consensus: no verifier is
        // recorded and the threshold count stays untouched.
        assert_eq!(client.get_verification_count(&report_id), 0);
        assert_eq!(client.get_report_verifiers(&report_id).len(), 0);
    }

    #[test]
    fn test_admin_override_rejects_pending_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.admin_override_report(&admin, &report_id, &ReportStatus::Rejected, &1);
        assert_eq!(client.get_report(&report_id).status, ReportStatus::Rejected);
        assert_eq!(client.get_verification_count(&report_id), 0);
    }

    #[test]
    fn test_admin_override_requires_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let stranger = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        let result =
            client.try_admin_override_report(&stranger, &report_id, &ReportStatus::Verified, &0);
        assert_eq!(result, Err(Ok(OracleError::Unauthorized)));
        assert_eq!(client.get_report(&report_id).status, ReportStatus::Pending);
    }

    #[test]
    fn test_admin_override_terminal_report_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        client.admin_override_report(&admin, &report_id, &ReportStatus::Verified, &1);

        // Already terminal: a second override must fail rather than flip the
        // status back and forth.
        let result =
            client.try_admin_override_report(&admin, &report_id, &ReportStatus::Rejected, &2);
        assert_eq!(result, Err(Ok(OracleError::ReportAlreadyVerified)));
        assert_eq!(client.get_report(&report_id).status, ReportStatus::Verified);
    }

    #[test]
    fn test_admin_override_rejects_invalid_status() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_id = client.submit_report(
            &provider,
            &project_id,
            &1000u64,
            &2000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "verra_vcs"),
            &make_ipfs_hash(&env, 1),
            &0,
        );

        for invalid in [ReportStatus::Pending, ReportStatus::Challenged] {
            let result = client.try_admin_override_report(&admin, &report_id, &invalid, &1);
            assert_eq!(result, Err(Ok(OracleError::InvalidResolution)));
        }

        let report = client.get_report(&report_id);
        assert_eq!(report.status, ReportStatus::Pending);
    }

    #[test]
    fn test_query_empty_project_reports() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let project_id = create_project_id(&env, 42);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        let reports = client.get_project_reports(&project_id);
        assert_eq!(reports.len(), 0);
    }

    mod property {
        extern crate std;

        use super::*;
        use proptest::prelude::*;

        // Mirrors slash_provider: penalty is 10% (PPM) floored, never less than
        // the full stake for dust balances, and never exceeds the stake.
        fn expected_slashed_stake(stake: i128) -> i128 {
            if stake <= 0 {
                return 0;
            }
            let mut penalty = stake * SLASH_PENALTY_PPM / 1_000_000;
            if penalty <= 0 {
                penalty = stake;
            }
            if penalty > stake {
                penalty = stake;
            }
            stake - penalty
        }

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 128,
                ..ProptestConfig::default()
            })]

            // Slashing conserves a non-negative stake: it never increases, never
            // goes negative, and drives the stake to exactly zero for dust.
            #[test]
            fn slash_never_negative_or_increasing(stake in 0i128..1_000_000i128) {
                let new = expected_slashed_stake(stake);
                prop_assert!(new >= 0);
                prop_assert!(new <= stake);
                if stake > 0 {
                    prop_assert!(new < stake);
                }
                // Deactivation happens at exactly zero stake.
                prop_assert_eq!(new == 0, stake < 10);
            }

            // Above the dust threshold the penalty is exactly the PPM fraction.
            #[test]
            fn slash_matches_ppm(stake in 10i128..1_000_000i128) {
                let new = expected_slashed_stake(stake);
                let expected = stake - stake * SLASH_PENALTY_PPM / 1_000_000;
                prop_assert_eq!(new, expected);
                prop_assert!(new >= 0);
            }

            // On-chain: a rejected challenge applies the slash invariant and
            // deactivates the provider iff its stake reaches zero.
            #[test]
            fn rejected_challenge_slash_invariant(stake in 1i128..1_000_000i128) {
                let env = Env::default();
                env.mock_all_auths();

                let admin = Address::generate(&env);
                let provider = Address::generate(&env);
                let challenger = Address::generate(&env);
                let project_id = create_project_id(&env, 1);

                let contract_id = env.register(OracleConsumer, (admin.clone(),));
                let client = OracleConsumerClient::new(&env, &contract_id);

                client.register_provider(
                    &admin,
                    &provider,
                    &Symbol::new(&env, "verra_vcs"),
                    &0,
                );
                client.add_stake(&provider, &stake, &0);

                let report_id = client.submit_report(
                    &provider,
                    &project_id,
                    &1000u64,
                    &2000u64,
                    &100_000i128,
                    &BiodiversityMetrics::Absent,
                    &Symbol::new(&env, "verra_vcs"),
                    &make_ipfs_hash(&env, 1),
                    &1,
                );
                client.challenge_report(
                    &challenger,
                    &report_id,
                    &make_ipfs_hash(&env, 2),
                    &0,
                );
                client.resolve_challenge(
                    &admin,
                    &report_id,
                    &ReportStatus::Rejected,
                    &1,
                );

                let p = client.get_provider(&provider);
                prop_assert_eq!(p.stake, expected_slashed_stake(stake));
                prop_assert!(p.stake >= 0);
                prop_assert_eq!(p.active, p.stake > 0);
            }

            // The stake ledger tracks a non-negative running balance through an
            // arbitrary interleaving of deposits and withdrawals.
            #[test]
            fn stake_ledger_never_negative(
                deposits in proptest::collection::vec(1i128..100_000i128, 1..15),
                withdrawals in proptest::collection::vec(1i128..100_000i128, 1..15),
            ) {
                let env = Env::default();
                env.mock_all_auths();

                let admin = Address::generate(&env);
                let provider = Address::generate(&env);
                let contract_id = env.register(OracleConsumer, (admin.clone(),));
                let client = OracleConsumerClient::new(&env, &contract_id);

                client.register_provider(
                    &admin,
                    &provider,
                    &Symbol::new(&env, "verra_vcs"),
                    &0,
                );

                let mut stake = 0i128;
                let mut nonce = 0u64;
                for d in deposits {
                    client.add_stake(&provider, &d, &nonce);
                    nonce += 1;
                    stake += d;
                    prop_assert_eq!(client.get_provider(&provider).stake, stake);
                }
                for w in withdrawals {
                    if w <= stake {
                        client.withdraw_stake(&provider, &w, &nonce);
                        nonce += 1;
                        stake -= w;
                    } else {
                        let res = client.try_withdraw_stake(&provider, &w, &nonce);
                        prop_assert_eq!(res, Err(Ok(OracleError::InsufficientStake)));
                    }
                    prop_assert_eq!(client.get_provider(&provider).stake, stake);
                }
            }
        }
    }

    // ── TTL / persistent-storage stress tests ────────────────────────────────

    /// Submit 500 reports for a single project and verify `get_project_reports`
    /// returns the correct count without panicking.  This exercises the
    /// persistent `ProjectReports` index across many appends and confirms that
    /// the contract does not hit an instance-storage size cap.
    #[test]
    fn test_project_reports_500_stress() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let provider = Address::generate(&env);
        let project_id = create_project_id(&env, 1);

        let contract_id = env.register(OracleConsumer, (admin.clone(),));
        let client = OracleConsumerClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);
        client.register_provider(&admin, &provider, &Symbol::new(&env, "verra_vcs"), &0);

        let report_count: u64 = 500;
        for i in 0..report_count {
            let period_start = 1_000 + i * 100;
            let period_end = period_start + 50;
            client.submit_report(
                &provider,
                &project_id,
                &period_start,
                &period_end,
                &100_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, (i % 256) as u8),
                &i,
            );
        }

        let ids = client.get_project_reports(&project_id);
        assert_eq!(
            ids.len() as u64,
            report_count,
            "expected {report_count} reports, got {}",
            ids.len()
        );

        // Spot-check first and last IDs.
        assert_eq!(ids.get(0).unwrap(), 1u64);
        assert_eq!(ids.get((report_count - 1) as u32).unwrap(), report_count);

        // Verify each report is individually retrievable.
        for id in 1..=report_count {
            let r = client.get_report(&id);
            assert_eq!(r.id, id);
            assert_eq!(r.project_id, project_id);
        }
    }
}
