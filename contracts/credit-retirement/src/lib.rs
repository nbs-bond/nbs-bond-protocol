#![no_std]
#![allow(deprecated)]
// Contract entrypoints carry the full provenance a certificate needs; the
// generated client/args code inherits the arity, so the allow has to be crate-wide.
#![allow(clippy::too_many_arguments)]
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, TryFromVal,
    Val, Vec,
};
use nbbs_coupon_engine::PeriodInfo;
use nbbs_shared::{BondError, CreditError, CreditType};

/// Ledgers closed in a day at the network's ~5 second close time.
const LEDGERS_PER_DAY: u32 = 17_280;
/// Bump a retirement entry's TTL once it is within 30 days of expiry.
const RETIREMENT_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
/// Bump it back out to 120 days, comfortably below the network's maximum entry TTL.
const RETIREMENT_TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 120;

const SECONDS_PER_DAY: u64 = 86_400;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Retirement(u64),
    RetirementCount,
    HolderRetirements(Address),
    /// Retirement ids for one holder on one bond, so a certificate can be looked
    /// up by (bond, holder) without scanning every retirement in the contract.
    BondHolderRetirements(u64, Address),
    RetiredCredits(Address),
    RetiredPerBond(u64, Address),
    BondIssuerAddress,
    CouponEngineAddress,
    Nonce(Address),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RetirementRecord {
    pub id: u64,
    pub holder: Address,
    pub bond_id: u64,
    /// Project the credits originated from, as recorded by `BondIssuer`.
    pub project_id: BytesN<32>,
    /// Coupon period the retired credits are attributed to.
    pub period_index: u32,
    /// Oracle report that measured that period — encodes the vintage window.
    pub report_id: u64,
    /// Calendar year the monitoring period closed in, cached at retirement time.
    pub vintage_year: u32,
    pub vintage_period_start: u64,
    pub vintage_period_end: u64,
    pub amount: i128,
    pub credit_type: CreditType,
    pub retired_at: u64,
    pub certificate_ipfs_hash: BytesN<32>,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RetirementCertificate {
    pub record_id: u64,
    pub holder: Address,
    pub bond_id: u64,
    pub project_id: BytesN<32>,
    pub period_index: u32,
    pub report_id: u64,
    pub vintage_year: u32,
    pub vintage_period_start: u64,
    pub vintage_period_end: u64,
    pub amount: i128,
    pub credit_type: CreditType,
    pub retired_at: u64,
    pub certificate_hash: BytesN<32>,
}

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0)
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::Nonce(addr.clone()), &nonce);
}

fn extend_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, RETIREMENT_TTL_THRESHOLD, RETIREMENT_TTL_EXTEND_TO);
}

/// Retirement data lives in persistent storage. Entries written before that move
/// are still in the instance entry, so reads fall back to it; every write goes to
/// persistent storage and bumps the entry's TTL.
fn read<V>(env: &Env, key: &DataKey) -> Option<V>
where
    V: TryFromVal<Env, Val>,
{
    match env.storage().persistent().get::<DataKey, V>(key) {
        Some(value) => Some(value),
        None => env.storage().instance().get::<DataKey, V>(key),
    }
}

fn write<V>(env: &Env, key: &DataKey, value: &V)
where
    V: IntoVal<Env, Val>,
{
    env.storage().persistent().set(key, value);
    extend_ttl(env, key);
}

/// Calendar year a unix timestamp falls in (proleptic Gregorian, UTC).
///
/// Howard Hinnant's `civil_from_days`, reduced to the year component. Used to
/// cache the vintage year on a certificate so reads never need the oracle.
pub fn year_from_timestamp(timestamp: u64) -> u32 {
    let days = (timestamp / SECONDS_PER_DAY) as i64;
    // Shift the epoch to 0000-03-01 so leap days land at the end of the cycle.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    // January and February belong to the following calendar year.
    let year = if month <= 2 { year + 1 } else { year };
    year as u32
}

/// Check whether a caller-supplied credit type is compatible with the bond's
/// registered type. Carbon and BlueCarbon share the same underlying storage
/// (CouponsEngine accrues both as Carbon), so either is valid for a
/// Carbon-or-BlueCarbon bond. Basket bonds accrue Carbon and Biodiversity
/// separately, so both are accepted.
fn is_compatible_credit_type(bond_type: CreditType, supplied: CreditType) -> bool {
    match bond_type {
        CreditType::Carbon | CreditType::BlueCarbon => {
            matches!(supplied, CreditType::Carbon | CreditType::BlueCarbon)
        }
        CreditType::Biodiversity => supplied == CreditType::Biodiversity,
        CreditType::Basket => {
            matches!(
                supplied,
                CreditType::Carbon | CreditType::BlueCarbon | CreditType::Biodiversity
            )
        }
    }
}

fn certificate_from_record(record: &RetirementRecord) -> RetirementCertificate {
    RetirementCertificate {
        record_id: record.id,
        holder: record.holder.clone(),
        bond_id: record.bond_id,
        project_id: record.project_id.clone(),
        period_index: record.period_index,
        report_id: record.report_id,
        vintage_year: record.vintage_year,
        vintage_period_start: record.vintage_period_start,
        vintage_period_end: record.vintage_period_end,
        amount: record.amount,
        credit_type: record.credit_type,
        retired_at: record.retired_at,
        certificate_hash: record.certificate_ipfs_hash.clone(),
    }
}

#[contract]
pub struct CreditRetirement;

#[contractimpl]
impl CreditRetirement {
    pub fn __constructor(
        env: Env,
        admin: Address,
        bond_issuer_address: Address,
        coupon_engine_address: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::BondIssuerAddress, &bond_issuer_address);
        env.storage()
            .instance()
            .set(&DataKey::CouponEngineAddress, &coupon_engine_address);
    }

    /// Retire accrued credits and mint an auditable retirement certificate.
    ///
    /// `project_id` and `period_index` are supplied by the caller and validated
    /// on-chain: `project_id` must match the bond's project as recorded by
    /// `BondIssuer`, and `period_index` must name a distributed coupon period on
    /// `CouponEngine`. The holder's signed authorization therefore covers the
    /// project and vintage the certificate will claim, and the chain proves the
    /// claim matched the issuer's own record.
    ///
    /// Note: `CouponEngine` accrues credits per bond, not per period, so the
    /// retired amount is capped against the holder's total accrual on the bond.
    /// `period_index` records which monitoring period the holder attributes the
    /// retirement to; it is not a per-period balance.
    pub fn retire_credits(
        env: Env,
        holder: Address,
        bond_id: u64,
        project_id: BytesN<32>,
        period_index: u32,
        amount: i128,
        credit_type: CreditType,
        certificate_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<u64, CreditError> {
        holder.require_auth();

        let expected_nonce = get_nonce(&env, &holder);
        if nonce != expected_nonce {
            return Err(CreditError::InvalidNonce);
        }
        set_nonce(&env, &holder, expected_nonce + 1);

        if amount <= 0 {
            return Err(CreditError::InsufficientCredits);
        }

        if certificate_hash.to_array().iter().all(|b| *b == 0) {
            return Err(CreditError::InvalidCertificate);
        }

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(CreditError::NotInitialized)?;
        let balance: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_holder_balance"),
            vec![&env, bond_id.into_val(&env), holder.clone().into_val(&env)],
        );
        if balance <= 0 {
            return Err(CreditError::NotAHolder);
        }

        // Validate the caller's claimed project against the issuer's record.
        let config: nbbs_shared::BondConfig = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_bond"),
            vec![&env, bond_id.into_val(&env)],
        );
        if config.project_id != project_id {
            return Err(CreditError::ProjectMismatch);
        }

        if !is_compatible_credit_type(config.credit_type, credit_type) {
            return Err(CreditError::InvalidCreditType);
        }

        let coupon_engine: Address = env
            .storage()
            .instance()
            .get(&DataKey::CouponEngineAddress)
            .ok_or(CreditError::NotInitialized)?;
        let accrued: i128 = env.invoke_contract(
            &coupon_engine,
            &Symbol::new(&env, "accrued_credits"),
            vec![&env, bond_id.into_val(&env), holder.clone().into_val(&env)],
        );

        // The period carries the oracle report id and the monitoring window the
        // credits were measured over — the vintage, in GHG Protocol terms.
        let period = match env.try_invoke_contract::<PeriodInfo, BondError>(
            &coupon_engine,
            &Symbol::new(&env, "get_period_info"),
            vec![
                &env,
                bond_id.into_val(&env),
                period_index.into_val(&env),
            ],
        ) {
            Ok(Ok(period)) => period,
            _ => return Err(CreditError::PeriodNotFound),
        };
        if !period.distributed {
            return Err(CreditError::PeriodNotDistributed);
        }

        if amount > accrued {
            return Err(CreditError::InsufficientCredits);
        }

        // Atomically deduct from CouponEngine so retired credits cannot be
        // claimed again via `claim_credits`.
        let deducted = env.try_invoke_contract::<i128, BondError>(
            &coupon_engine,
            &Symbol::new(&env, "deduct_credits"),
            vec![
                &env,
                bond_id.into_val(&env),
                holder.clone().into_val(&env),
                amount.into_val(&env),
                credit_type.into_val(&env),
            ],
        );
        match deducted {
            Ok(Ok(_)) => {}
            _ => return Err(CreditError::InsufficientCredits),
        }

        let retired_key = DataKey::RetiredPerBond(bond_id, holder.clone());
        let already_retired: i128 = read(&env, &retired_key).unwrap_or(0);
        write(&env, &retired_key, &(already_retired + amount));

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::RetirementCount)
            .unwrap_or(0);
        let retirement_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::RetirementCount, &retirement_id);

        let now = env.ledger().timestamp();
        let record = RetirementRecord {
            id: retirement_id,
            holder: holder.clone(),
            bond_id,
            project_id,
            period_index,
            report_id: period.report_id,
            // Cached so certificate reads never touch OracleConsumer again.
            vintage_year: year_from_timestamp(period.end_time),
            vintage_period_start: period.start_time,
            vintage_period_end: period.end_time,
            amount,
            credit_type,
            retired_at: now,
            certificate_ipfs_hash: certificate_hash.clone(),
        };

        write(&env, &DataKey::Retirement(retirement_id), &record);

        let retired: i128 = read(&env, &DataKey::RetiredCredits(holder.clone())).unwrap_or(0);
        let new_total = retired
            .checked_add(amount)
            .ok_or(CreditError::InsufficientCredits)?;
        write(&env, &DataKey::RetiredCredits(holder.clone()), &new_total);

        let mut retirements: Vec<u64> =
            read(&env, &DataKey::HolderRetirements(holder.clone())).unwrap_or(vec![&env]);
        retirements.push_back(retirement_id);
        write(&env, &DataKey::HolderRetirements(holder.clone()), &retirements);

        let bond_holder_key = DataKey::BondHolderRetirements(bond_id, holder.clone());
        let mut bond_retirements: Vec<u64> = read(&env, &bond_holder_key).unwrap_or(vec![&env]);
        bond_retirements.push_back(retirement_id);
        write(&env, &bond_holder_key, &bond_retirements);

        env.storage()
            .instance()
            .extend_ttl(RETIREMENT_TTL_THRESHOLD, RETIREMENT_TTL_EXTEND_TO);

        env.events().publish(
            (Symbol::new(&env, "CreditsRetired"), holder.clone()),
            certificate_from_record(&record),
        );

        Ok(retirement_id)
    }

    pub fn get_retirement_record(
        env: Env,
        retirement_id: u64,
    ) -> Result<RetirementRecord, CreditError> {
        read(&env, &DataKey::Retirement(retirement_id)).ok_or(CreditError::InsufficientCredits)
    }

    pub fn get_retirement_certificate(
        env: Env,
        retirement_id: u64,
    ) -> Result<RetirementCertificate, CreditError> {
        let record: RetirementRecord =
            read(&env, &DataKey::Retirement(retirement_id)).ok_or(CreditError::InsufficientCredits)?;
        Ok(certificate_from_record(&record))
    }

    /// Retirement ids for one holder on one bond, read straight from the index —
    /// no scan over the contract's full retirement history.
    pub fn get_bond_retirements(env: Env, bond_id: u64, holder: Address) -> Vec<u64> {
        read(&env, &DataKey::BondHolderRetirements(bond_id, holder)).unwrap_or(vec![&env])
    }

    /// Full certificates for one holder on one bond, for net-zero reporting.
    pub fn get_bond_certificates(
        env: Env,
        bond_id: u64,
        holder: Address,
    ) -> Vec<RetirementCertificate> {
        let ids: Vec<u64> =
            read(&env, &DataKey::BondHolderRetirements(bond_id, holder)).unwrap_or(vec![&env]);
        let mut certificates = vec![&env];
        for id in ids.iter() {
            if let Some(record) = read::<RetirementRecord>(&env, &DataKey::Retirement(id)) {
                certificates.push_back(certificate_from_record(&record));
            }
        }
        certificates
    }

    /// Push a certificate's storage entries back out to the full TTL window.
    /// Permissionless: certificates outlive the bond, and anyone relying on one
    /// for reporting must be able to keep it alive.
    pub fn extend_retirement_ttl(env: Env, retirement_id: u64) -> Result<(), CreditError> {
        let record: RetirementRecord = read(&env, &DataKey::Retirement(retirement_id))
            .ok_or(CreditError::InsufficientCredits)?;

        // Re-home legacy instance-storage records on first touch so the TTL bump
        // has a persistent entry to act on.
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Retirement(retirement_id))
        {
            write(&env, &DataKey::Retirement(retirement_id), &record);
        } else {
            extend_ttl(&env, &DataKey::Retirement(retirement_id));
        }

        extend_ttl(&env, &DataKey::HolderRetirements(record.holder.clone()));
        extend_ttl(
            &env,
            &DataKey::BondHolderRetirements(record.bond_id, record.holder),
        );
        Ok(())
    }

    pub fn get_holder_retirements(env: Env, holder: Address) -> Vec<u64> {
        read(&env, &DataKey::HolderRetirements(holder)).unwrap_or(vec![&env])
    }

    pub fn get_total_retired(env: Env, holder: Address) -> i128 {
        read(&env, &DataKey::RetiredCredits(holder)).unwrap_or(0)
    }

    pub fn total_retirements(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::RetirementCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Address as _, Ledger as _},
        vec as svec, BytesN, Env, Symbol,
    };
    use nbbs_bond_issuer::{BondIssuer, BondIssuerClient};
    use nbbs_coupon_engine::{CouponEngine, CouponEngineClient};
    use nbbs_shared::{BiodiversityMetrics, BondConfig};

    fn make_certificate_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    /// 2024-01-01T00:00:00Z — start of the monitoring period used by `setup`.
    const PERIOD_START: u64 = 1_704_067_200;
    /// 2024-12-31T00:00:00Z — so the expected vintage year is 2024.
    const PERIOD_END: u64 = 1_735_603_200;
    const VINTAGE_YEAR: u32 = 2024;

    fn submit_verified_report(
        env: &Env,
        admin: &Address,
        oracle_id: &Address,
        project_id: &BytesN<32>,
        carbon: i128,
    ) -> u64 {
        submit_verified_report_for_period(
            env,
            admin,
            oracle_id,
            project_id,
            carbon,
            PERIOD_START,
            PERIOD_END,
            0,
        )
    }

    /// `admin_nonce` is the admin's next nonce on `OracleConsumer`; the helper
    /// consumes that one for `register_provider` and the next for `verify_report`.
    fn submit_verified_report_for_period(
        env: &Env,
        admin: &Address,
        oracle_id: &Address,
        project_id: &BytesN<32>,
        carbon: i128,
        period_start: u64,
        period_end: u64,
        admin_nonce: u64,
    ) -> u64 {
        let oc_client =
            nbbs_oracle_consumer::OracleConsumerClient::new(env, oracle_id);
        let provider = Address::generate(env);
        oc_client.register_provider(
            admin,
            &provider,
            &Symbol::new(env, "verra_vcs"),
            &admin_nonce,
        );
        let report_id = oc_client.submit_report(
            &provider,
            project_id,
            &period_start,
            &period_end,
            &carbon,
            &BiodiversityMetrics::Absent,
            &Symbol::new(env, "verra_vcs"),
            &make_certificate_hash(env, 9),
            &0,
        );
        oc_client.verify_report(admin, &report_id, &(admin_nonce + 1));
        report_id
    }

    struct Setup {
        _env: Env,
        client: CreditRetirementClient<'static>,
        contract_id: Address,
        ce_client: CouponEngineClient<'static>,
        oracle_id: Address,
        admin: Address,
        holder: Address,
        bond_id: u64,
        project_id: BytesN<32>,
        report_id: u64,
        accrued: i128,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let holder = Address::generate(&env);
        let project_id = make_project_id(&env, 1);

        let issuer_admin = Address::generate(&env);
        let issuer_id = env.register(BondIssuer, (issuer_admin.clone(),));
        let issuer_client = BondIssuerClient::new(&env, &issuer_id);

        let bond_config = BondConfig {
            project_id: project_id.clone(),
            face_value: 1000,
            coupon_schedule: svec![&env, 1_000_000u64, 2_000_000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: 10_000,
        };
        let bond_id = issuer_client.issue_bond(&issuer_admin, &bond_config, &0);
        issuer_client.subscribe(&holder, &bond_id, &10_000, &0);

        let oracle_id = env.register(
            nbbs_oracle_consumer::OracleConsumer,
            (admin.clone(),),
        );
        let report_id =
            submit_verified_report(&env, &admin, &oracle_id, &project_id, 100_000);

        let registry_id = env.register(nbbs_project_registry::ProjectRegistry, (admin.clone(),));
        let registry = nbbs_project_registry::ProjectRegistryClient::new(&env, &registry_id);
        let user = Address::generate(&env);
        let pid = registry.register_project(
            &user,
            &project_id,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        registry.approve_project(&admin, &pid, &0);

        let ce_id = env.register(
            CouponEngine,
            (admin.clone(), issuer_id.clone(), oracle_id.clone(), registry_id.clone()),
        );
        let ce_client = CouponEngineClient::new(&env, &ce_id);

        let contract_id = env.register(
            CreditRetirement,
            (admin.clone(), issuer_id.clone(), ce_id.clone()),
        );
        let client = CreditRetirementClient::new(&env, &contract_id);

        ce_client.register_deduct_caller(&admin, &contract_id, &0);
        ce_client.register_bond(&admin, &bond_id, &project_id, &1);

        let holders = svec![&env, (holder.clone(), 10_000i128)];
        ce_client.distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &2, &true);
        let accrued = ce_client.accrued_credits(&bond_id, &holder);
        assert!(accrued > 0);

        Setup {
            _env: env,
            client,
            contract_id,
            ce_client,
            oracle_id,
            admin,
            holder,
            bond_id,
            project_id,
            report_id,
            accrued,
        }
    }

    #[test]
    fn test_retire_credits_and_query() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let id = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(id, 1);

        let record = s.client.get_retirement_record(&id);
        assert_eq!(record.holder, s.holder);
        assert_eq!(record.bond_id, s.bond_id);
        assert_eq!(record.amount, s.accrued);
        assert_eq!(record.credit_type, CreditType::Carbon);
        assert_eq!(record.certificate_ipfs_hash, hash);

        let cert = s.client.get_retirement_certificate(&id);
        assert_eq!(cert.record_id, id);
        assert_eq!(cert.holder, s.holder);
        assert_eq!(cert.amount, s.accrued);
        assert_eq!(cert.certificate_hash, hash);

        assert_eq!(s.client.total_retirements(), 1);
    }

    #[test]
    fn test_multiple_retirements_and_total() {
        let s = setup();
        let half = s.accrued / 2;
        let second = s.accrued - half;

        let hash1 = make_certificate_hash(&s._env, 1);
        let id1 = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &half,
            &CreditType::Carbon,
            &hash1,
            &0,
        );

        let hash2 = make_certificate_hash(&s._env, 2);
        let id2 = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &second,
            &CreditType::Carbon,
            &hash2,
            &1,
        );

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(s.client.total_retirements(), 2);

        assert_eq!(s.client.get_total_retired(&s.holder), s.accrued);

        let retirements = s.client.get_holder_retirements(&s.holder);
        assert_eq!(retirements.len(), 2);
    }

    #[test]
    fn test_retire_zero_credits_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &0i128,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_retire_zero_certificate_hash_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 0);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::InvalidCertificate)));
    }

    #[test]
    fn test_retire_without_holding_bond_rejected() {
        let s = setup();

        let stranger = Address::generate(&s._env);
        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &stranger,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::NotAHolder)));
    }

    #[test]
    fn test_retire_more_than_accrued_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &(s.accrued + 1),
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_double_retirement_of_same_accrual_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );

        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &1i128,
            &CreditType::Carbon,
            &hash,
            &1,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_query_nonexistent_retirement() {
        let s = setup();
        let result = s.client.try_get_retirement_record(&999);
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_multiple_holders_tracked_independently() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);
        let project_id = make_project_id(&env, 3);

        let issuer_admin = Address::generate(&env);
        let issuer_id = env.register(BondIssuer, (issuer_admin.clone(),));
        let issuer_client = BondIssuerClient::new(&env, &issuer_id);

        let bond_config = BondConfig {
            project_id: project_id.clone(),
            face_value: 1000,
            coupon_schedule: svec![&env, 1_000_000u64, 2_000_000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: 10_000,
        };
        let bond_id = issuer_client.issue_bond(&issuer_admin, &bond_config, &0);
        issuer_client.subscribe(&holder1, &bond_id, &3_000, &0);
        issuer_client.subscribe(&holder2, &bond_id, &7_000, &0);

        let oracle_id = env.register(
            nbbs_oracle_consumer::OracleConsumer,
            (admin.clone(),),
        );
        let report_id =
            submit_verified_report(&env, &admin, &oracle_id, &project_id, 100_000);

        let registry_id = env.register(nbbs_project_registry::ProjectRegistry, (admin.clone(),));
        let registry = nbbs_project_registry::ProjectRegistryClient::new(&env, &registry_id);
        let user = Address::generate(&env);
        let pid = registry.register_project(
            &user,
            &project_id,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        registry.approve_project(&admin, &pid, &0);

        let ce_id = env.register(
            CouponEngine,
            (admin.clone(), issuer_id.clone(), oracle_id.clone(), registry_id.clone()),
        );
        let ce_client = CouponEngineClient::new(&env, &ce_id);

        let cr_id = env.register(
            CreditRetirement,
            (admin.clone(), issuer_id.clone(), ce_id.clone()),
        );
        let cr_client = CreditRetirementClient::new(&env, &cr_id);

        ce_client.register_deduct_caller(&admin, &cr_id, &0);
        ce_client.register_bond(&admin, &bond_id, &project_id, &1);

        let holders = svec![&env, (holder1.clone(), 3_000i128), (holder2.clone(), 7_000i128)];
        ce_client.distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &2, &true);

        let accrued1 = ce_client.accrued_credits(&bond_id, &holder1);
        let accrued2 = ce_client.accrued_credits(&bond_id, &holder2);
        assert!(accrued1 > 0);
        assert!(accrued2 > 0);

        let hash1 = make_certificate_hash(&env, 1);
        cr_client.retire_credits(
            &holder1,
            &bond_id,
            &project_id,
            &0u32,
            &accrued1,
            &CreditType::Carbon,
            &hash1,
            &0,
        );

        let hash2 = make_certificate_hash(&env, 2);
        cr_client.retire_credits(
            &holder2,
            &bond_id,
            &project_id,
            &0u32,
            &accrued2,
            &CreditType::Carbon,
            &hash2,
            &0,
        );

        assert_eq!(cr_client.get_total_retired(&holder1), accrued1);
        assert_eq!(cr_client.get_total_retired(&holder2), accrued2);
        assert_eq!(cr_client.total_retirements(), 2);

        let result = cr_client.try_retire_credits(
            &holder1,
            &bond_id,
            &project_id,
            &0u32,
            &1i128,
            &CreditType::Carbon,
            &hash1,
            &1,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));

        let result = cr_client.try_retire_credits(
            &Address::generate(&env),
            &bond_id,
            &project_id,
            &0u32,
            &1i128,
            &CreditType::Carbon,
            &hash1,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::NotAHolder)));
    }

    #[test]
    fn test_empty_total_retirements() {
        let s = setup();
        assert_eq!(s.client.total_retirements(), 0);
        let empty: Vec<u64> = vec![&s._env];
        assert_eq!(s.client.get_holder_retirements(&s.holder), empty);
        assert_eq!(s.client.get_total_retired(&s.holder), 0);
    }

    #[test]
    fn test_invalid_nonce_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &1,
        );
        assert_eq!(result, Err(Ok(CreditError::InvalidNonce)));
    }

    #[test]
    fn test_certificate_carries_full_provenance() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let id = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );

        let cert = s.client.get_retirement_certificate(&id);
        assert_eq!(cert.record_id, id);
        assert_eq!(cert.bond_id, s.bond_id);
        assert_eq!(cert.project_id, s.project_id);
        assert_eq!(cert.period_index, 0);
        assert_eq!(cert.report_id, s.report_id);
        assert_eq!(cert.vintage_year, VINTAGE_YEAR);
        assert_eq!(cert.vintage_period_start, PERIOD_START);
        assert_eq!(cert.vintage_period_end, PERIOD_END);
        assert_eq!(cert.amount, s.accrued);
        assert_eq!(cert.credit_type, CreditType::Carbon);
        assert_eq!(cert.certificate_hash, hash);

        // The record carries the same provenance the certificate is derived from.
        let record = s.client.get_retirement_record(&id);
        assert_eq!(record.project_id, s.project_id);
        assert_eq!(record.period_index, 0);
        assert_eq!(record.report_id, s.report_id);
        assert_eq!(record.vintage_year, VINTAGE_YEAR);
    }

    #[test]
    fn test_mismatched_project_id_rejected() {
        let s = setup();

        let wrong_project = make_project_id(&s._env, 99);
        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &wrong_project,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::ProjectMismatch)));

        // Nothing was recorded against the bond.
        assert_eq!(s.client.total_retirements(), 0);
        assert_eq!(s.client.get_total_retired(&s.holder), 0);
    }

    #[test]
    fn test_unknown_period_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &7u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::PeriodNotFound)));
        assert_eq!(s.client.total_retirements(), 0);
    }

    #[test]
    fn test_certificates_looked_up_by_bond_and_holder() {
        let s = setup();
        let half = s.accrued / 2;

        let hash1 = make_certificate_hash(&s._env, 1);
        let id1 = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &half,
            &CreditType::Carbon,
            &hash1,
            &0,
        );
        let hash2 = make_certificate_hash(&s._env, 2);
        let id2 = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &(s.accrued - half),
            &CreditType::Carbon,
            &hash2,
            &1,
        );

        let ids = s.client.get_bond_retirements(&s.bond_id, &s.holder);
        assert_eq!(ids, svec![&s._env, id1, id2]);

        let certificates = s.client.get_bond_certificates(&s.bond_id, &s.holder);
        assert_eq!(certificates.len(), 2);
        assert_eq!(certificates.get(0).unwrap().certificate_hash, hash1);
        assert_eq!(certificates.get(1).unwrap().certificate_hash, hash2);
        assert!(certificates
            .iter()
            .all(|c| c.bond_id == s.bond_id && c.holder == s.holder));

        // A bond the holder never retired against, and a holder who never retired,
        // both come back empty rather than scanning the whole history.
        let empty: Vec<u64> = vec![&s._env];
        assert_eq!(s.client.get_bond_retirements(&99u64, &s.holder), empty);
        let stranger = Address::generate(&s._env);
        assert_eq!(s.client.get_bond_retirements(&s.bond_id, &stranger), empty);
        assert_eq!(
            s.client.get_bond_certificates(&s.bond_id, &stranger).len(),
            0
        );
    }

    #[test]
    fn test_vintage_year_cached_per_period() {
        let s = setup();

        // A second monitoring period closing in 2025 — 2025-06-30T00:00:00Z.
        let period_end_2025 = 1_751_241_600u64;
        let report_id = submit_verified_report_for_period(
            &s._env,
            &s.admin,
            &s.oracle_id,
            &s.project_id,
            100_000,
            PERIOD_END,
            period_end_2025,
            2,
        );
        s.ce_client.distribute_coupon(
            &s.admin,
            &s.bond_id,
            &1u32,
            &svec![&s._env, (s.holder.clone(), 10_000i128)],
            &report_id,
            &3,
            &true,
        );

        let hash = make_certificate_hash(&s._env, 1);
        let id = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &1u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );

        let cert = s.client.get_retirement_certificate(&id);
        assert_eq!(cert.period_index, 1);
        assert_eq!(cert.report_id, report_id);
        assert_eq!(cert.vintage_year, 2025);
        assert_eq!(cert.vintage_period_start, PERIOD_END);
        assert_eq!(cert.vintage_period_end, period_end_2025);
    }

    #[test]
    fn test_year_from_timestamp_boundaries() {
        assert_eq!(year_from_timestamp(0), 1970);
        // 2024-01-01T00:00:00Z and the last second of 2024.
        assert_eq!(year_from_timestamp(1_704_067_200), 2024);
        assert_eq!(year_from_timestamp(1_735_689_599), 2024);
        // 2025-01-01T00:00:00Z.
        assert_eq!(year_from_timestamp(1_735_689_600), 2025);
        // 2024-02-29T00:00:00Z — leap day must not roll the year forward.
        assert_eq!(year_from_timestamp(1_709_164_800), 2024);
        // 2000-03-01T00:00:00Z — the 400-year leap rule.
        assert_eq!(year_from_timestamp(951_868_800), 2000);
    }

    #[test]
    fn test_retirement_stored_persistently_with_extendable_ttl() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let id = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );

        let key = DataKey::Retirement(id);
        let ttl_at_write = s._env.as_contract(&s.contract_id, || {
            assert!(s._env.storage().persistent().has(&key));
            s._env.storage().persistent().get_ttl(&key)
        });
        assert!(ttl_at_write >= RETIREMENT_TTL_EXTEND_TO);

        // Let the entry age most of the way to expiry, then bump it back out.
        let aged_by = RETIREMENT_TTL_EXTEND_TO - RETIREMENT_TTL_THRESHOLD / 2;
        s._env.ledger().with_mut(|li| li.sequence_number += aged_by);
        let ttl_before_bump = s
            ._env
            .as_contract(&s.contract_id, || s._env.storage().persistent().get_ttl(&key));
        assert!(ttl_before_bump < RETIREMENT_TTL_THRESHOLD);

        s.client.extend_retirement_ttl(&id);

        let ttl_after_bump = s
            ._env
            .as_contract(&s.contract_id, || s._env.storage().persistent().get_ttl(&key));
        assert!(ttl_after_bump >= RETIREMENT_TTL_EXTEND_TO);

        // The certificate is still readable and unchanged after the bump.
        let cert = s.client.get_retirement_certificate(&id);
        assert_eq!(cert.record_id, id);
        assert_eq!(cert.vintage_year, VINTAGE_YEAR);
    }

    #[test]
    fn test_extend_ttl_for_unknown_retirement_rejected() {
        let s = setup();
        let result = s.client.try_extend_retirement_ttl(&404u64);
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_retire_then_claim_returns_zero() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );

        // CouponEngine balance must be zero after full retirement.
        let remaining = s.ce_client.accrued_credits(&s.bond_id, &s.holder);
        assert_eq!(remaining, 0);

        // claim_credits must return 0 — no double-spend possible.
        let claimed = s.ce_client.claim_credits(&s.holder, &s.bond_id, &0);
        assert_eq!(claimed, 0);
        assert_eq!(s.ce_client.accrued_credits(&s.bond_id, &s.holder), 0);
    }

    #[test]
    fn test_partial_retire_then_claim_returns_remainder() {
        let s = setup();
        let half = s.accrued / 2;

        let hash = make_certificate_hash(&s._env, 1);
        s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &half,
            &CreditType::Carbon,
            &hash,
            &0,
        );

        // CouponEngine balance must reflect the remaining credits.
        let remaining = s.ce_client.accrued_credits(&s.bond_id, &s.holder);
        assert_eq!(remaining, s.accrued - half);

        // claim_credits must return only the unretired remainder.
        let claimed = s.ce_client.claim_credits(&s.holder, &s.bond_id, &0);
        assert_eq!(claimed, s.accrued - half);
        assert_eq!(s.ce_client.accrued_credits(&s.bond_id, &s.holder), 0);
    }

    #[test]
    fn test_retire_wrong_credit_type_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Biodiversity,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::InvalidCreditType)));
        assert_eq!(s.client.total_retirements(), 0);
        assert_eq!(s.client.get_total_retired(&s.holder), 0);
    }

    #[test]
    fn test_retire_correct_credit_type_succeeds() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let id = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.project_id,
            &0u32,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(id, 1);
        let record = s.client.get_retirement_record(&id);
        assert_eq!(record.credit_type, CreditType::Carbon);
    }
}
