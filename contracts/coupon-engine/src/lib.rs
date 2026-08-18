#![no_std]
#![allow(deprecated)]
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Vec};
use nbbs_shared::{BiodiversityMetrics, BondError, CreditType, ReportStatus};
use nbbs_oracle_consumer::Report;

pub const FIXED_POINT: i128 = 10_000_000;
pub const CREDIT_DIVISOR: i128 = 1_000;
pub const HABITAT_CREDIT_RATE: i128 = 1_000_000;
pub const SPECIES_CREDIT_RATE: i128 = 100_000;
pub const UNIT_CREDIT_RATE: i128 = 1_000_000;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    PeriodInfo(u64, u32),
    PeriodCount(u64),
    AccruedCredits(u64, Address),
    AccruedCreditsByType(u64, Address, CreditType),
    BondProject(u64),
    BondCreditType(u64),
    UndistributedTotal(u64),
    Precision,
    BondIssuerAddress,
    OracleConsumerAddress,
    Nonce(Address),
}

#[derive(Clone)]
#[contracttype]
pub struct PeriodInfo {
    pub period_index: u32,
    pub start_time: u64,
    pub end_time: u64,
    pub total_credits_earned: i128,
    pub distributed: bool,
    pub report_id: u64,
    pub undistributed: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CouponResult {
    pub bond_id: u64,
    pub period_index: u32,
    pub total_credits: i128,
    pub holder_count: u32,
    pub credits_per_token: i128,
}

#[contract]
pub struct CouponEngine;

#[contractimpl]
impl CouponEngine {
    pub fn __constructor(
        env: Env,
        admin: Address,
        bond_issuer_address: Address,
        oracle_consumer_address: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::BondIssuerAddress, &bond_issuer_address);
        env.storage()
            .instance()
            .set(&DataKey::OracleConsumerAddress, &oracle_consumer_address);
        env.storage().instance().set(&DataKey::Precision, &FIXED_POINT);
    }

    pub fn register_bond(
        env: Env,
        caller: Address,
        bond_id: u64,
        project_id: BytesN<32>,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        env.storage()
            .instance()
            .set(&DataKey::BondProject(bond_id), &project_id);

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(BondError::NotInitialized)?;
        let config: nbbs_shared::BondConfig = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_bond"),
            vec![&env, bond_id.into_val(&env)],
        );

        if config.project_id != project_id {
            return Err(BondError::BondNotFound);
        }

        env.storage()
            .instance()
            .set(&DataKey::BondCreditType(bond_id), &config.credit_type);

        env.events().publish(
            (Symbol::new(&env, "bond_registered"),),
            (bond_id, project_id),
        );

        Ok(())
    }

    pub fn distribute_coupon(
        env: Env,
        caller: Address,
        bond_id: u64,
        period_index: u32,
        holders: Vec<Address>,
        report_id: u64,
        nonce: u64,
    ) -> Result<CouponResult, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let project_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::BondProject(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let oracle_consumer: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleConsumerAddress)
            .ok_or(BondError::NotInitialized)?;

        let report: Report = env.invoke_contract(
            &oracle_consumer,
            &Symbol::new(&env, "get_report"),
            vec![&env, report_id.into_val(&env)],
        );

        if report.status != ReportStatus::Verified {
            return Err(BondError::ReportNotVerified);
        }
        if report.project_id != project_id {
            return Err(BondError::BondNotFound);
        }

        let existing: Option<PeriodInfo> = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodInfo(bond_id, period_index));
        if let Some(info) = existing {
            if info.distributed {
                return Err(BondError::Overflow);
            }
        }

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .expect("bond issuer not set");

        let credit_type: CreditType = env
            .storage()
            .instance()
            .get(&DataKey::BondCreditType(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let carbon_total = report.carbon_sequestered / CREDIT_DIVISOR;
        let (carbon_total, biodiversity_total) = match credit_type {
            CreditType::Carbon | CreditType::BlueCarbon => (carbon_total, 0),
            CreditType::Biodiversity => match report.biodiversity {
                BiodiversityMetrics::Absent => return Err(BondError::InvalidReport),
                ref metrics => (0, compute_biodiversity_credits(metrics)),
            },
            CreditType::Basket => match report.biodiversity {
                BiodiversityMetrics::Absent => return Err(BondError::InvalidReport),
                ref metrics => (carbon_total, compute_biodiversity_credits(metrics)),
            },
        };
        let total_credits = carbon_total
            .checked_add(biodiversity_total)
            .ok_or(BondError::Overflow)?;

        let total_subscribed: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "total_subscribed"),
            vec![&env, bond_id.into_val(&env)],
        );

        let mut total_holder_credits: i128 = 0;
        let mut holder_count: u32 = 0;

        let credits_per_token = if total_subscribed > 0 && total_credits > 0 {
            total_credits * FIXED_POINT / total_subscribed
        } else {
            0
        };
        let carbon_per_token = if total_subscribed > 0 && carbon_total > 0 {
            carbon_total * FIXED_POINT / total_subscribed
        } else {
            0
        };
        let biodiversity_per_token = if total_subscribed > 0 && biodiversity_total > 0 {
            biodiversity_total * FIXED_POINT / total_subscribed
        } else {
            0
        };

        for holder in holders.iter() {
            let balance: i128 = env.invoke_contract(
                &bond_issuer,
                &Symbol::new(&env, "get_holder_balance"),
                vec![&env, bond_id.into_val(&env), holder.clone().into_val(&env)],
            );

            if balance > 0 {
                match credit_type {
                    CreditType::Carbon | CreditType::BlueCarbon => {
                        let holder_credits = credits_per_token * balance / FIXED_POINT;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            accrue_credits(
                                &env,
                                bond_id,
                                holder.clone(),
                                CreditType::Carbon,
                                holder_credits,
                            )?;
                            holder_count += 1;
                        }
                    }
                    CreditType::Biodiversity => {
                        let holder_credits = credits_per_token * balance / FIXED_POINT;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            accrue_credits(
                                &env,
                                bond_id,
                                holder.clone(),
                                CreditType::Biodiversity,
                                holder_credits,
                            )?;
                            holder_count += 1;
                        }
                    }
                    CreditType::Basket => {
                        let carbon_holder = carbon_per_token * balance / FIXED_POINT;
                        let biodiversity_holder =
                            biodiversity_per_token * balance / FIXED_POINT;
                        let holder_credits = carbon_holder
                            .checked_add(biodiversity_holder)
                            .ok_or(BondError::Overflow)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            if carbon_holder > 0 {
                                accrue_credits(
                                    &env,
                                    bond_id,
                                    holder.clone(),
                                    CreditType::Carbon,
                                    carbon_holder,
                                )?;
                            }
                            if biodiversity_holder > 0 {
                                accrue_credits(
                                    &env,
                                    bond_id,
                                    holder.clone(),
                                    CreditType::Biodiversity,
                                    biodiversity_holder,
                                )?;
                            }
                            holder_count += 1;
                        }
                    }
                }
            }
        }

        let period_info = PeriodInfo {
            period_index,
            start_time: report.period_start,
            end_time: report.period_end,
            total_credits_earned: total_holder_credits,
            distributed: true,
            report_id,
            undistributed: total_credits.saturating_sub(total_holder_credits),
        };
        env.storage()
            .persistent()
            .set(&DataKey::PeriodInfo(bond_id, period_index), &period_info);

        if period_info.undistributed > 0 {
            let undistributed_total: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::UndistributedTotal(bond_id))
                .unwrap_or(0);
            let new_total = undistributed_total
                .checked_add(period_info.undistributed)
                .ok_or(BondError::Overflow)?;
            env.storage()
                .persistent()
                .set(&DataKey::UndistributedTotal(bond_id), &new_total);
        }

        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodCount(bond_id))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::PeriodCount(bond_id), &(count + 1));

        env.events().publish(
            (Symbol::new(&env, "coupon_distributed"),),
            (bond_id, period_index, total_holder_credits, holder_count),
        );

        Ok(CouponResult {
            bond_id,
            period_index,
            total_credits: total_holder_credits,
            holder_count,
            credits_per_token,
        })
    }

    pub fn accrued_credits(env: Env, bond_id: u64, holder: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccruedCredits(bond_id, holder))
            .unwrap_or(0)
    }

    pub fn accrued_credits_by_type(
        env: Env,
        bond_id: u64,
        holder: Address,
        credit_type: CreditType,
    ) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccruedCreditsByType(
                bond_id,
                holder,
                credit_type,
            ))
            .unwrap_or(0)
    }

    pub fn get_bond_credit_type(env: Env, bond_id: u64) -> Result<CreditType, BondError> {
        env.storage()
            .instance()
            .get(&DataKey::BondCreditType(bond_id))
            .ok_or(BondError::BondNotFound)
    }

    pub fn claim_credits(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<i128, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        let key = DataKey::AccruedCredits(bond_id, caller.clone());
        let accrued: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &0i128);

        if accrued > 0 {
            let credit_type = env
                .storage()
                .instance()
                .get(&DataKey::BondCreditType(bond_id));
            match credit_type {
                Some(CreditType::Carbon) | Some(CreditType::BlueCarbon) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Carbon);
                }
                Some(CreditType::Biodiversity) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Biodiversity);
                }
                Some(CreditType::Basket) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Carbon);
                    clear_accrued(&env, bond_id, &caller, CreditType::Biodiversity);
                }
                None => {}
            }
        }

        env.events().publish(
            (Symbol::new(&env, "credits_claimed"),),
            (bond_id, caller, accrued),
        );

        Ok(accrued)
    }

    pub fn get_period_info(
        env: Env,
        bond_id: u64,
        period_index: u32,
    ) -> Result<PeriodInfo, BondError> {
        env.storage()
            .persistent()
            .get(&DataKey::PeriodInfo(bond_id, period_index))
            .ok_or(BondError::BondNotFound)
    }

    /// Returns up to `count` `PeriodInfo` records for `bond_id`, starting at
    /// period index `start`. `start` is a zero-based offset into the period
    /// history, not a period ID, mirroring `get_bond_ids_range`. Returns an
    /// empty vector when `start` is beyond the last distributed period or when
    /// `count` is zero. Does not modify storage.
    pub fn get_period_info_range(
        env: Env,
        bond_id: u64,
        start: u32,
        count: u32,
    ) -> Vec<PeriodInfo> {
        let total: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodCount(bond_id))
            .unwrap_or(0);
        let mut result: Vec<PeriodInfo> = vec![&env];

        if count == 0 || start >= total {
            return result;
        }

        let end = ((start as u64) + (count as u64)).min(total as u64) as u32;
        for i in start..end {
            if let Some(info) = env
                .storage()
                .persistent()
                .get(&DataKey::PeriodInfo(bond_id, i))
            {
                result.push_back(info);
            }
        }

        result
    }

    pub fn get_period_count(env: Env, bond_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::PeriodCount(bond_id))
            .unwrap_or(0)
    }

    pub fn get_undistributed_total(env: Env, bond_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UndistributedTotal(bond_id))
            .unwrap_or(0)
    }

    pub fn sweep_undistributed(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<i128, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let key = DataKey::UndistributedTotal(bond_id);
        let total: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &0i128);

        env.events().publish(
            (Symbol::new(&env, "undistributed_swept"),),
            (bond_id, total),
        );

        Ok(total)
    }
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), BondError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(BondError::NotInitialized)?;
    if caller != &admin {
        return Err(BondError::Unauthorized);
    }
    Ok(())
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

fn compute_biodiversity_credits(metrics: &BiodiversityMetrics) -> i128 {
    let (habitat, species, units) = match metrics {
        BiodiversityMetrics::Absent => return 0,
        BiodiversityMetrics::Present(v) => *v,
    };
    habitat
        .saturating_mul(HABITAT_CREDIT_RATE)
        .saturating_add(species.saturating_mul(SPECIES_CREDIT_RATE))
        .saturating_add(units.saturating_mul(UNIT_CREDIT_RATE))
        .saturating_div(HABITAT_CREDIT_RATE)
}

fn accrue_credits(
    env: &Env,
    bond_id: u64,
    holder: Address,
    credit_type: CreditType,
    amount: i128,
) -> Result<(), BondError> {
    let by_type_key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
    let by_type: i128 = env.storage().persistent().get(&by_type_key).unwrap_or(0);
    env.storage()
        .persistent()
        .set(&by_type_key, &by_type.checked_add(amount).ok_or(BondError::Overflow)?);

    let combined_key = DataKey::AccruedCredits(bond_id, holder);
    let combined: i128 = env.storage().persistent().get(&combined_key).unwrap_or(0);
    env.storage()
        .persistent()
        .set(
            &combined_key,
            &combined.checked_add(amount).ok_or(BondError::Overflow)?,
        );
    Ok(())
}

fn clear_accrued(env: &Env, bond_id: u64, holder: &Address, credit_type: CreditType) {
    let key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
    env.storage().persistent().set(&key, &0i128);
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _, vec, BytesN, Env, Symbol,
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

    fn make_bond_config(env: &Env, project_id: &BytesN<32>) -> nbbs_shared::BondConfig {
        nbbs_shared::BondConfig {
            project_id: project_id.clone(),
            face_value: 1000,
            coupon_schedule: vec![env, 1_000_000u64, 2_000_000u64],
            credit_type: nbbs_shared::CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: 10_000,
        }
    }

    fn make_bond_config_with_type(
        env: &Env,
        project_id: &BytesN<32>,
        credit_type: nbbs_shared::CreditType,
    ) -> nbbs_shared::BondConfig {
        nbbs_shared::BondConfig {
            credit_type,
            ..make_bond_config(env, project_id)
        }
    }

    struct TestEnv {
        _env: Env,
        admin: Address,
        issuer_id: Address,
        issuer_admin: Address,
        oracle_id: Address,
        client: CouponEngineClient<'static>,
    }

    fn deploy(env: Env, admin: Address) -> TestEnv {
        let issuer_admin = Address::generate(&env);
        let issuer_id = env.register(
            nbbs_bond_issuer::BondIssuer,
            (issuer_admin.clone(),),
        );
        let oracle_id = env.register(
            nbbs_oracle_consumer::OracleConsumer,
            (admin.clone(),),
        );
        let ce_id = env.register(
            CouponEngine,
            (admin.clone(), issuer_id.clone(), oracle_id.clone()),
        );
        let client = CouponEngineClient::new(&env, &ce_id);

        TestEnv {
            _env: env,
            admin,
            issuer_id,
            issuer_admin,
            oracle_id,
            client,
        }
    }

    fn issue_and_subscribe(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        holder: &Address,
        amount: i128,
    ) -> u64 {
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(env, &t.issuer_id);
        let config = make_bond_config(env, project_id);
        let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);
        issuer.subscribe(holder, &bond_id, &amount, &0);
        bond_id
    }

    fn issue_and_subscribe_with_type(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        credit_type: nbbs_shared::CreditType,
        holder: &Address,
        amount: i128,
    ) -> u64 {
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(env, &t.issuer_id);
        let config = make_bond_config_with_type(env, project_id, credit_type);
        let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);
        issuer.subscribe(holder, &bond_id, &amount, &0);
        bond_id
    }

    fn submit_verified_report(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        carbon: i128,
        biodiversity: BiodiversityMetrics,
        admin_nonce: u64,
    ) -> u64 {
        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(env, &t.oracle_id);
        let provider = Address::generate(env);
        oc.register_provider(&t.admin, &provider, &Symbol::new(env, "verra_vcs"), &admin_nonce);
        let report_id = oc.submit_report(
            &provider,
            project_id,
            &1000u64,
            &2000u64,
            &carbon,
            &biodiversity,
            &Symbol::new(env, "verra_vcs"),
            &make_ipfs_hash(env, 1),
            &0,
        );
        oc.verify_report(&t.admin, &report_id, &(admin_nonce + 1));
        report_id
    }

    fn submit_unverified_report(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        carbon: i128,
        biodiversity: BiodiversityMetrics,
        admin_nonce: u64,
    ) -> u64 {
        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(env, &t.oracle_id);
        let provider = Address::generate(env);
        oc.register_provider(&t.admin, &provider, &Symbol::new(env, "verra_vcs"), &admin_nonce);
        oc.submit_report(
            &provider,
            project_id,
            &1000u64,
            &2000u64,
            &carbon,
            &biodiversity,
            &Symbol::new(env, "verra_vcs"),
            &make_ipfs_hash(env, 1),
            &0,
        )
    }

    #[test]
    fn test_constructor_and_register_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin.clone());

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 1000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let credit_type = t.client.get_bond_credit_type(&bond_id);
        assert_eq!(credit_type, nbbs_shared::CreditType::Carbon);

        let count = t.client.get_period_count(&bond_id);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_register_bond_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let result = t.client.try_register_bond(&user, &1, &project_id, &0);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_register_bond_invalid_nonce() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let result = t.client.try_register_bond(&t.admin, &1, &project_id, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidNonce)));
    }

    #[test]
    fn test_register_bond_project_mismatch() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin.clone());

        let project_id = create_project_id(&t._env, 42);
        let wrong_project_id = create_project_id(&t._env, 43);
        let holder = Address::generate(&t._env);
        
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 1000);
        let result = t.client.try_register_bond(&t.admin, &bond_id, &wrong_project_id, &0);
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_distribute_to_single_holder() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );

        assert_eq!(result.bond_id, bond_id);
        assert_eq!(result.period_index, 0);
        assert_eq!(result.total_credits, 100);
        assert_eq!(result.holder_count, 1);
        assert_eq!(result.credits_per_token, 100 * FIXED_POINT / 10000);

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, 100);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert!(period_info.distributed);
        assert_eq!(period_info.total_credits_earned, 100);
        assert_eq!(period_info.report_id, report_id);
    }

    #[test]
    fn test_distribute_biodiversity_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 2);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe_with_type(
            &t._env,
            &t,
            &project_id,
            nbbs_shared::CreditType::Biodiversity,
            &holder,
            10_000,
        );
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let credit_type = t.client.get_bond_credit_type(&bond_id);
        assert_eq!(credit_type, nbbs_shared::CreditType::Biodiversity);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            0,
            BiodiversityMetrics::Present((500, 125, 1_000)),
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );

        let total = 500 + 125 * SPECIES_CREDIT_RATE / HABITAT_CREDIT_RATE + 1_000;
        assert_eq!(result.total_credits, total);

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, total);
        let by_type = t.client.accrued_credits_by_type(
            &bond_id,
            &holder,
            &nbbs_shared::CreditType::Biodiversity,
        );
        assert_eq!(by_type, total);
    }

    #[test]
    fn test_distribute_basket_bond_splits_by_type() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 3);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe_with_type(
            &t._env,
            &t,
            &project_id,
            nbbs_shared::CreditType::Basket,
            &holder,
            10_000,
        );
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Present((500, 125, 1_000)),
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );

        let bio_total = 500 + 125 * SPECIES_CREDIT_RATE / HABITAT_CREDIT_RATE + 1_000;
        assert_eq!(result.total_credits, 100 + bio_total);

        let carbon_accrued =
            t.client.accrued_credits_by_type(&bond_id, &holder, &nbbs_shared::CreditType::Carbon);
        assert_eq!(carbon_accrued, 100);
        let bio_accrued = t.client.accrued_credits_by_type(
            &bond_id,
            &holder,
            &nbbs_shared::CreditType::Biodiversity,
        );
        assert_eq!(bio_accrued, bio_total);

        let combined = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(combined, 100 + bio_total);
    }

    #[test]
    fn test_distribute_biodiversity_bond_requires_metrics() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 4);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe_with_type(
            &t._env,
            &t,
            &project_id,
            nbbs_shared::CreditType::Biodiversity,
            &holder,
            10_000,
        );
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            0,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );
        assert_eq!(result, Err(Ok(BondError::InvalidReport)));
    }

    #[test]
    fn test_distribute_pro_rata_multiple_holders() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder1 = Address::generate(&t._env);
        let holder2 = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder1, 3_000);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder2, &bond_id, &7_000, &0);

        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder1.clone(), holder2.clone()];

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );

        assert_eq!(result.total_credits, 100);
        assert_eq!(result.holder_count, 2);

        let total_sub = 10000i128;
        let credits_per_token = 100 * FIXED_POINT / total_sub;
        let expected_h1 = credits_per_token * 3000 / FIXED_POINT;
        let expected_h2 = credits_per_token * 7000 / FIXED_POINT;

        assert_eq!(t.client.accrued_credits(&bond_id, &holder1), expected_h1);
        assert_eq!(t.client.accrued_credits(&bond_id, &holder2), expected_h2);
        assert_eq!(expected_h1 + expected_h2, 100);
    }

    #[test]
    fn test_distribute_zero_sequestration() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 0, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );

        assert_eq!(result.total_credits, 0);
        assert_eq!(result.holder_count, 0);
        assert_eq!(result.credits_per_token, 0);

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_distribute_rejects_unverified_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_unverified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );
        assert_eq!(result, Err(Ok(BondError::ReportNotVerified)));

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_distribute_rejects_report_for_other_project() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let other_project = create_project_id(&t._env, 2);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &other_project, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_prevent_double_distribute() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &2,
        );
        assert_eq!(result, Err(Ok(BondError::Overflow)));
    }

    #[test]
    fn test_distribute_unregistered_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env];

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &999,
            &0,
            &holders,
            &report_id,
            &0,
        );
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_claim_credits() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];
        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let claimed = t.client.claim_credits(&holder, &bond_id, &0);
        assert_eq!(claimed, 100);

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_zero_holders_case() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env];

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );

        assert_eq!(result.total_credits, 0);
        assert_eq!(result.holder_count, 0);
        assert!(result.credits_per_token >= 0);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert!(period_info.distributed);
    }

    #[test]
    fn test_period_count_increments() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        assert_eq!(t.client.get_period_count(&bond_id), 0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
        assert_eq!(t.client.get_period_count(&bond_id), 1);

        let report_id2 = submit_verified_report(&t._env, &t, &project_id, 200_000, BiodiversityMetrics::Absent, 2);
        t.client.distribute_coupon(&t.admin, &bond_id, &1, &holders, &report_id2, &2);
        assert_eq!(t.client.get_period_count(&bond_id), 2);
    }

    #[test]
    fn test_get_period_info_range_paginates() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        for period in 0..3u32 {
            let report_id = submit_verified_report(
                &t._env,
                &t,
                &project_id,
                100_000,
                BiodiversityMetrics::Absent,
                (period as u64) * 2,
            );
            let holders = vec![&t._env, holder.clone()];
            t.client.distribute_coupon(
                &t.admin,
                &bond_id,
                &period,
                &holders,
                &report_id,
                &((period as u64) + 1),
            );
        }

        assert_eq!(t.client.get_period_count(&bond_id), 3);

        let first_page = t.client.get_period_info_range(&bond_id, &0, &2);
        assert_eq!(first_page.len(), 2);
        assert_eq!(first_page.get(0).unwrap().period_index, 0);
        assert_eq!(first_page.get(1).unwrap().period_index, 1);

        let second_page = t.client.get_period_info_range(&bond_id, &2, &2);
        assert_eq!(second_page.len(), 1);
        assert_eq!(second_page.get(0).unwrap().period_index, 2);

        assert_eq!(t.client.get_period_info_range(&bond_id, &5, &20).len(), 0);
        assert_eq!(t.client.get_period_info_range(&bond_id, &0, &0).len(), 0);
    }

    #[test]
    fn test_distribute_leaves_dust_and_sweep_recovers_it() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder_a = Address::generate(&t._env);
        let holder_b = Address::generate(&t._env);
        let holder_c = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder_a, 1);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder_b, &bond_id, &1, &0);
        issuer.subscribe(&holder_c, &bond_id, &1, &0);

        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder_a.clone(), holder_b.clone(), holder_c.clone()];

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
        );

        assert_eq!(result.total_credits, 99);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert_eq!(period_info.undistributed, 1);

        assert_eq!(t.client.get_undistributed_total(&bond_id), 1);

        let swept = t.client.sweep_undistributed(&t.admin, &bond_id, &2);
        assert_eq!(swept, 1);

        assert_eq!(t.client.get_undistributed_total(&bond_id), 0);
    }

    #[test]
    fn test_sweep_requires_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];
        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let user = Address::generate(&t._env);
        let result = t.client.try_sweep_undistributed(&user, &bond_id, &0);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_query_accrued_credits_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let oracle = Address::generate(&env);

        let contract_id = env.register(CouponEngine, (admin, issuer, oracle));
        let client = CouponEngineClient::new(&env, &contract_id);

        let holder = Address::generate(&env);
        let accrued = client.accrued_credits(&1, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_claim_credits_invalid_nonce() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let oracle = Address::generate(&env);

        let contract_id = env.register(CouponEngine, (admin, issuer, oracle));
        let client = CouponEngineClient::new(&env, &contract_id);

        let holder = Address::generate(&env);
        let result = client.try_claim_credits(&holder, &1, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidNonce)));
    }

    mod property {
        extern crate std;

        use super::*;
        use proptest::prelude::*;

        fn expected_credits(total_credits: i128, total_subscribed: i128, balance: i128) -> i128 {
            if total_subscribed <= 0 || total_credits <= 0 {
                return 0;
            }
            let credits_per_token = total_credits * FIXED_POINT / total_subscribed;
            credits_per_token * balance / FIXED_POINT
        }

        fn deploy_with_holders(
            env: Env,
            admin: Address,
            balances: &[i128],
        ) -> (TestEnv, std::vec::Vec<Address>, u64, i128) {
            let t = deploy(env, admin);
            let project_id = create_project_id(&t._env, 7);
            let total_subscribed: i128 = balances.iter().sum();

            let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
            let mut config = make_bond_config(&t._env, &project_id);
            config.total_supply = total_subscribed;
            let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);

            let holders: std::vec::Vec<Address> = balances
                .iter()
                .map(|_| Address::generate(&t._env))
                .collect();
            for (holder, &amount) in holders.iter().zip(balances.iter()) {
                issuer.subscribe(holder, &bond_id, &amount, &0);
            }

            t.client.register_bond(&t.admin, &bond_id, &project_id, &0);
            (t, holders, bond_id, total_subscribed)
        }

        fn setup_with_balances(
            env: Env,
            admin: Address,
            balances: &[i128],
            carbon: i128,
        ) -> (TestEnv, std::vec::Vec<Address>, u64, i128, u64) {
            let (t, holders, bond_id, total_subscribed) =
                deploy_with_holders(env, admin, balances);
            let project_id = create_project_id(&t._env, 7);
            let report_id = submit_verified_report(&t._env, &t, &project_id, carbon, BiodiversityMetrics::Absent, 0);
            (t, holders, bond_id, total_subscribed, report_id)
        }

        fn expected_distributed(balances: &[i128], total_credits: i128, total_subscribed: i128) -> i128 {
            balances
                .iter()
                .map(|&balance| expected_credits(total_credits, total_subscribed, balance))
                .sum()
        }

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 128,
                ..ProptestConfig::default()
            })]

            // Pure pro-rata math: floor-based distribution never allocates more
            // than the available credits and leaves a non-negative remainder that
            // reconciles exactly with the distributed amount.
            #[test]
            fn pro_rata_never_over_distributes(
                total_credits in 0i128..1_000_000i128,
                balances in proptest::collection::vec(1i128..100_000i128, 1..20),
            ) {
                let total_subscribed: i128 = balances.iter().sum();
                let mut distributed = 0i128;
                for &balance in &balances {
                    let credits = expected_credits(total_credits, total_subscribed, balance);
                    prop_assert!(credits >= 0);
                    prop_assert!(credits <= total_credits * balance / total_subscribed);
                    distributed += credits;
                }
                let undistributed = total_credits.saturating_sub(distributed);
                prop_assert!(undistributed >= 0);
                prop_assert!(distributed <= total_credits);
                prop_assert_eq!(distributed + undistributed, total_credits);
            }

            // On-chain invariant: sum of holder credits + undistributed == total
            // credits for an arbitrary holder distribution and sequestration amount.
            #[test]
            fn distribution_conserves_credits(
                carbon in 0i128..1_000_000_000i128,
                balances in proptest::collection::vec(1i128..10_000i128, 1..5),
            ) {
                let env = Env::default();
                env.mock_all_auths();

                let admin = Address::generate(&env);
                let (t, holders, bond_id, total_subscribed, report_id) =
                    setup_with_balances(env, admin.clone(), &balances, carbon);

                let mut holders_vec: Vec<Address> = Vec::new(&t._env);
                for h in &holders {
                    holders_vec.push_back(h.clone());
                }

                let total_credits = carbon / 1000;
                let result = t.client.distribute_coupon(
                    &t.admin,
                    &bond_id,
                    &0,
                    &holders_vec,
                    &report_id,
                    &1,
                );

                let distributed =
                    expected_distributed(&balances, total_credits, total_subscribed);
                prop_assert_eq!(result.total_credits, distributed);

                let mut credited_holders = 0u32;
                for (holder, &balance) in holders.iter().zip(balances.iter()) {
                    let expected =
                        expected_credits(total_credits, total_subscribed, balance);
                    prop_assert_eq!(t.client.accrued_credits(&bond_id, holder), expected);
                    if expected > 0 {
                        credited_holders += 1;
                    }
                }
                prop_assert_eq!(result.holder_count, credited_holders);

                let undistributed = total_credits.saturating_sub(distributed);
                prop_assert_eq!(t.client.get_undistributed_total(&bond_id), undistributed);
                prop_assert_eq!(distributed + undistributed, total_credits);

                let swept = t.client.sweep_undistributed(&t.admin, &bond_id, &2);
                prop_assert_eq!(swept, undistributed);
                prop_assert_eq!(t.client.get_undistributed_total(&bond_id), 0);
            }

            // Conservation across multiple periods: the running undistributed pool
            // is exactly the sum of each period's remainder, and the sum of all
            // accrued credits plus that pool equals the total credits issued.
            #[test]
            fn multi_period_conserves_credits(
                carbon_0 in 0i128..1_000_000i128,
                carbon_1 in 0i128..1_000_000i128,
                balances in proptest::collection::vec(1i128..10_000i128, 1..4),
            ) {
                let env = Env::default();
                env.mock_all_auths();

                let admin = Address::generate(&env);
                let (t, holders, bond_id, total_subscribed) =
                    deploy_with_holders(env, admin.clone(), &balances);

                let mut holders_vec: Vec<Address> = Vec::new(&t._env);
                for h in &holders {
                    holders_vec.push_back(h.clone());
                }

                let mut sum_undistributed = 0i128;
                for (period, &carbon) in [carbon_0, carbon_1].iter().enumerate() {
                    let report_id = submit_verified_report(
                        &t._env,
                        &t,
                        &create_project_id(&t._env, 7),
                        carbon,
                        BiodiversityMetrics::Absent,
                        (period as u64) * 2,
                    );
                    t.client.distribute_coupon(
                        &t.admin,
                        &bond_id,
                        &(period as u32),
                        &holders_vec,
                        &report_id,
                        &(1 + period as u64),
                    );
                    let total_credits = carbon / 1000;
                    let distributed =
                        expected_distributed(&balances, total_credits, total_subscribed);
                    sum_undistributed += total_credits.saturating_sub(distributed);

                    let info = t.client.get_period_info(&bond_id, &(period as u32));
                    prop_assert_eq!(info.undistributed, total_credits.saturating_sub(distributed));
                }

                prop_assert_eq!(
                    t.client.get_undistributed_total(&bond_id),
                    sum_undistributed
                );

                let mut sum_accrued = 0i128;
                for (holder, &balance) in holders.iter().zip(balances.iter()) {
                    let mut holder_accrued = 0i128;
                    for &carbon in [carbon_0, carbon_1].iter() {
                        holder_accrued +=
                            expected_credits(carbon / 1000, total_subscribed, balance);
                    }
                    sum_accrued += holder_accrued;
                    prop_assert_eq!(t.client.accrued_credits(&bond_id, holder), holder_accrued);
                }
                prop_assert_eq!(
                    sum_accrued + sum_undistributed,
                    (carbon_0 / 1000) + (carbon_1 / 1000)
                );
            }
        }
    }
}
