#![no_std]
#![allow(deprecated)]
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Vec};
use nbbs_shared::{BiodiversityMetrics, CouponEngineError, CreditType, ReportStatus};
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
    ProjectRegistryAddress,
    Nonce(Address),
    DeductCaller,
    /// Tracks intermediate state for a period that is being distributed in
    /// multiple batches.  Cleared (removed) once the period is fully settled
    /// and `PeriodInfo.distributed` is set to `true`.
    BatchState(u64, u32),
    /// Per-holder flag set after a holder has received their credit
    /// allocation for a given period.  Consulted at the start of each batch
    /// item so a holder that already appeared in a previous batch is
    /// silently skipped and never double-paid.
    HolderDistributed(u64, u32, Address),
}

#[derive(Clone, Debug, PartialEq, Eq)]
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

/// Persisted between batched `distribute_coupon` calls for a single period.
/// Removed once the period is fully distributed.
#[derive(Clone)]
#[contracttype]
pub struct BatchState {
    /// The oracle report anchoring this distribution.  Every batch for the
    /// same period *must* reference the same report.
    pub report_id: u64,
    /// Running sum of credits distributed to holders so far.
    pub distributed_so_far: i128,
    /// Running count of holders that received a non-zero allocation.
    pub holder_count_so_far: u32,
    /// Pre-computed total credits for the period (derived from the oracle
    /// report on the first batch call and stored so subsequent batches do
    /// not need to re-invoke the oracle consumer).
    pub total_credits: i128,
    /// Fixed-point rate for Carbon (or combined) credits per token.
    pub credits_per_token: i128,
    /// Fixed-point rate for Carbon-only allocation (Basket bonds).
    pub carbon_per_token: i128,
    /// Fixed-point rate for Biodiversity-only allocation (Basket bonds).
    pub biodiversity_per_token: i128,
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
        project_registry_address: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::BondIssuerAddress, &bond_issuer_address);
        env.storage()
            .instance()
            .set(&DataKey::OracleConsumerAddress, &oracle_consumer_address);
        env.storage()
            .instance()
            .set(&DataKey::ProjectRegistryAddress, &project_registry_address);
        env.storage().instance().set(&DataKey::Precision, &FIXED_POINT);
    }

    pub fn register_bond(
        env: Env,
        caller: Address,
        bond_id: u64,
        project_id: BytesN<32>,
        nonce: u64,
    ) -> Result<(), CouponEngineError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(CouponEngineError::InvalidNonce);
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
            .ok_or(CouponEngineError::NotInitialized)?;
        let config: nbbs_shared::BondConfig = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_bond"),
            vec![&env, bond_id.into_val(&env)],
        );

        if config.project_id != project_id {
            return Err(CouponEngineError::BondNotFound);
        }

        let project_registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::ProjectRegistryAddress)
            .ok_or(CouponEngineError::NotInitialized)?;

        let status: nbbs_shared::ProjectStatus = env.invoke_contract(
            &project_registry,
            &Symbol::new(&env, "get_project_status_by_hash"),
            vec![&env, project_id.into_val(&env)],
        );

        if status != nbbs_shared::ProjectStatus::Approved {
            return Err(CouponEngineError::ProjectNotApproved);
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

    #[allow(clippy::too_many_arguments)]
    pub fn distribute_coupon(
        env: Env,
        caller: Address,
        bond_id: u64,
        period_index: u32,
        // Pre-fetched (holder_address, bond_token_balance) pairs for this batch.
        // Passing balances from the API layer removes the per-holder cross-contract
        // call to BondIssuer.get_holder_balance that caused instruction-budget
        // exhaustion on large tranches.
        // Idempotency: holders already paid in a previous batch are silently skipped.
        holders: Vec<(Address, i128)>,
        report_id: u64,
        nonce: u64,
        // Set to `true` in the last (or only) batch call to finalise the period,
        // emit the coupon_distributed event, and clean up transient BatchState.
        is_final_batch: bool,
    ) -> Result<CouponResult, CouponEngineError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(CouponEngineError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        // ── Guard: reject any call once the period is fully distributed ──────
        let existing: Option<PeriodInfo> = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodInfo(bond_id, period_index));
        if let Some(ref info) = existing {
            if info.distributed {
                return Err(CouponEngineError::PeriodAlreadyDistributed);
            }
        }

        let project_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::BondProject(bond_id))
            .ok_or(CouponEngineError::BondNotFound)?;

        let credit_type: CreditType = env
            .storage()
            .instance()
            .get(&DataKey::BondCreditType(bond_id))
            .ok_or(CouponEngineError::BondNotFound)?;

        // ── Batch state: initialise on first call, resume on subsequent ──────
        let batch_key = DataKey::BatchState(bond_id, period_index);
        let mut state: BatchState = match env.storage().persistent().get(&batch_key) {
            Some(s) => {
                // Subsequent batch: verify that the same report is being used.
                let s: BatchState = s;
                if s.report_id != report_id {
                    return Err(CouponEngineError::InvalidReport);
                }
                s
            }
            None => {
                // First batch: validate the report and compute per-token rates.
                let oracle_consumer: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::OracleConsumerAddress)
                    .ok_or(CouponEngineError::NotInitialized)?;

                let report: Report = env.invoke_contract(
                    &oracle_consumer,
                    &Symbol::new(&env, "get_report"),
                    vec![&env, report_id.into_val(&env)],
                );

                if report.status != ReportStatus::Verified {
                    return Err(CouponEngineError::ReportNotVerified);
                }
                if report.project_id != project_id {
                    return Err(CouponEngineError::BondNotFound);
                }

                let bond_issuer: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::BondIssuerAddress)
                    .expect("bond issuer not set");

                let total_subscribed: i128 = env.invoke_contract(
                    &bond_issuer,
                    &Symbol::new(&env, "total_subscribed"),
                    vec![&env, bond_id.into_val(&env)],
                );

                let carbon_total = report.carbon_sequestered / CREDIT_DIVISOR;
                let (carbon_total, biodiversity_total) = match credit_type {
                    CreditType::Carbon | CreditType::BlueCarbon => (carbon_total, 0),
                    CreditType::Biodiversity => match report.biodiversity {
                        BiodiversityMetrics::Absent => return Err(CouponEngineError::InvalidReport),
                        ref metrics => (0, compute_biodiversity_credits(metrics)),
                    },
                    CreditType::Basket => match report.biodiversity {
                        BiodiversityMetrics::Absent => return Err(CouponEngineError::InvalidReport),
                        ref metrics => (carbon_total, compute_biodiversity_credits(metrics)),
                    },
                };
                let total_credits = carbon_total
                    .checked_add(biodiversity_total)
                    .ok_or(CouponEngineError::Overflow)?;

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
                let biodiversity_per_token =
                    if total_subscribed > 0 && biodiversity_total > 0 {
                        biodiversity_total * FIXED_POINT / total_subscribed
                    } else {
                        0
                    };

                // Persist BatchState so the period's start/end timestamps are
                // available when we write the final PeriodInfo.
                let s = BatchState {
                    report_id,
                    distributed_so_far: 0,
                    holder_count_so_far: 0,
                    total_credits,
                    credits_per_token,
                    carbon_per_token,
                    biodiversity_per_token,
                };
                // Store immediately so it is visible to the loop below even
                // if the first batch is also the final batch.
                env.storage().persistent().set(&batch_key, &s);
                s
            }
        };

        // ── Process holders in this batch ────────────────────────────────────
        let mut total_holder_credits: i128 = 0;
        let mut holder_count: u32 = 0;

        for (holder, balance) in holders.iter() {
            // Skip holders already processed in a prior batch (idempotent).
            let processed_key =
                DataKey::HolderDistributed(bond_id, period_index, holder.clone());
            if env.storage().persistent().has(&processed_key) {
                continue;
            }

            if balance > 0 {
                match credit_type {
                    CreditType::Carbon | CreditType::BlueCarbon => {
                        let holder_credits =
                            state.credits_per_token * balance / FIXED_POINT;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(CouponEngineError::Overflow)?;
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
                        let holder_credits =
                            state.credits_per_token * balance / FIXED_POINT;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(CouponEngineError::Overflow)?;
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
                        let carbon_holder =
                            state.carbon_per_token * balance / FIXED_POINT;
                        let biodiversity_holder =
                            state.biodiversity_per_token * balance / FIXED_POINT;
                        let holder_credits = carbon_holder
                            .checked_add(biodiversity_holder)
                            .ok_or(CouponEngineError::Overflow)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(CouponEngineError::Overflow)?;
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

                // Mark this holder as processed so subsequent batch calls
                // (or a retry of this one) skip them.
                env.storage().persistent().set(&processed_key, &true);
            }
        }

        // ── Accumulate into persistent BatchState ─────────────────────────
        state.distributed_so_far = state
            .distributed_so_far
            .checked_add(total_holder_credits)
            .ok_or(CouponEngineError::Overflow)?;
        state.holder_count_so_far += holder_count;
        env.storage().persistent().set(&batch_key, &state);

        // ── Finalise if this is the last batch ───────────────────────────────
        if is_final_batch {
            // Re-fetch the report for timestamps (already validated above).
            let oracle_consumer: Address = env
                .storage()
                .instance()
                .get(&DataKey::OracleConsumerAddress)
                .ok_or(CouponEngineError::NotInitialized)?;
            let report: Report = env.invoke_contract(
                &oracle_consumer,
                &Symbol::new(&env, "get_report"),
                vec![&env, report_id.into_val(&env)],
            );

            let total_distributed = state.distributed_so_far;
            let undistributed = state.total_credits.saturating_sub(total_distributed);

            let period_info = PeriodInfo {
                period_index,
                start_time: report.period_start,
                end_time: report.period_end,
                total_credits_earned: total_distributed,
                distributed: true,
                report_id,
                undistributed,
            };
            env.storage()
                .persistent()
                .set(&DataKey::PeriodInfo(bond_id, period_index), &period_info);

            if undistributed > 0 {
                let undistributed_total: i128 = env
                    .storage()
                    .persistent()
                    .get(&DataKey::UndistributedTotal(bond_id))
                    .unwrap_or(0);
                let new_total = undistributed_total
                    .checked_add(undistributed)
                    .ok_or(CouponEngineError::Overflow)?;
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

            // Clean up the transient BatchState now that the period is closed.
            env.storage().persistent().remove(&batch_key);

            env.events().publish(
                (Symbol::new(&env, "coupon_distributed"),),
                (
                    bond_id,
                    period_index,
                    total_distributed,
                    state.holder_count_so_far,
                ),
            );

            return Ok(CouponResult {
                bond_id,
                period_index,
                total_credits: total_distributed,
                holder_count: state.holder_count_so_far,
                credits_per_token: state.credits_per_token,
            });
        }

        // ── Intermediate batch: return a partial result ───────────────────────
        Ok(CouponResult {
            bond_id,
            period_index,
            total_credits: state.distributed_so_far,
            holder_count: state.holder_count_so_far,
            credits_per_token: state.credits_per_token,
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

    pub fn get_bond_credit_type(env: Env, bond_id: u64) -> Result<CreditType, CouponEngineError> {
        env.storage()
            .instance()
            .get(&DataKey::BondCreditType(bond_id))
            .ok_or(CouponEngineError::BondNotFound)
    }

    pub fn claim_credits(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<i128, CouponEngineError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(CouponEngineError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        let key = DataKey::AccruedCredits(bond_id, caller.clone());
        let accrued: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &0i128);

        let credit_type = env
            .storage()
            .instance()
            .get(&DataKey::BondCreditType(bond_id));

        let mut carbon_amt: i128 = 0;
        let mut bio_amt: i128 = 0;

        if accrued > 0 {
            match credit_type {
                Some(CreditType::Carbon) | Some(CreditType::BlueCarbon) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Carbon);
                }
                Some(CreditType::Biodiversity) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Biodiversity);
                }
                Some(CreditType::Basket) => {
                    carbon_amt = Self::accrued_credits_by_type(env.clone(), bond_id, caller.clone(), CreditType::Carbon);
                    bio_amt = Self::accrued_credits_by_type(env.clone(), bond_id, caller.clone(), CreditType::Biodiversity);
                    clear_accrued(&env, bond_id, &caller, CreditType::Carbon);
                    clear_accrued(&env, bond_id, &caller, CreditType::Biodiversity);
                }
                None => {}
            }
        }

        match credit_type {
            Some(CreditType::Basket) => {
                env.events().publish(
                    (Symbol::new(&env, "credits_claimed"),),
                    (bond_id, caller, carbon_amt, bio_amt),
                );
            }
            _ => {
                env.events().publish(
                    (Symbol::new(&env, "credits_claimed"),),
                    (bond_id, caller, accrued),
                );
            }
        }

        Ok(accrued)
    }

    pub fn get_period_info(
        env: Env,
        bond_id: u64,
        period_index: u32,
    ) -> Result<PeriodInfo, CouponEngineError> {
        env.storage()
            .persistent()
            .get(&DataKey::PeriodInfo(bond_id, period_index))
            .ok_or(CouponEngineError::PeriodNotFound)
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
    ) -> Result<i128, CouponEngineError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(CouponEngineError::InvalidNonce);
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

    pub fn register_deduct_caller(
        env: Env,
        caller: Address,
        deduct_caller: Address,
        nonce: u64,
    ) -> Result<(), CouponEngineError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(CouponEngineError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        env.storage()
            .instance()
            .set(&DataKey::DeductCaller, &deduct_caller);

        Ok(())
    }

    pub fn deduct_credits(
        env: Env,
        bond_id: u64,
        holder: Address,
        amount: i128,
        credit_type: CreditType,
    ) -> Result<i128, CouponEngineError> {
        let authorized: Address = env
            .storage()
            .instance()
            .get(&DataKey::DeductCaller)
            .ok_or(CouponEngineError::Unauthorized)?;
        authorized.require_auth();

        if amount <= 0 {
            return Err(CouponEngineError::ZeroAmount);
        }

        let combined_key = DataKey::AccruedCredits(bond_id, holder.clone());
        let combined: i128 = env
            .storage()
            .persistent()
            .get(&combined_key)
            .unwrap_or(0);
        if amount > combined {
            return Err(CouponEngineError::Overflow);
        }

        // BlueCarbon credits are accrued under Carbon, so resolve the storage
        // key from the bond's registered credit type, not the caller-supplied
        // retirement type.
        let storage_type = match credit_type {
            CreditType::BlueCarbon => CreditType::Carbon,
            other => other,
        };

        let by_type_key = DataKey::AccruedCreditsByType(
            bond_id,
            holder.clone(),
            storage_type,
        );
        let by_type: i128 = env
            .storage()
            .persistent()
            .get(&by_type_key)
            .unwrap_or(0);
        if amount > by_type {
            return Err(CouponEngineError::Overflow);
        }

        env.storage()
            .persistent()
            .set(&combined_key, &(combined - amount));
        env.storage()
            .persistent()
            .set(&by_type_key, &(by_type - amount));

        env.events().publish(
            (Symbol::new(&env, "credits_deducted"),),
            (bond_id, holder, amount, credit_type),
        );

        Ok(combined - amount)
    }
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), CouponEngineError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(CouponEngineError::NotInitialized)?;
    if caller != &admin {
        return Err(CouponEngineError::Unauthorized);
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
) -> Result<(), CouponEngineError> {
    let by_type_key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
    let by_type: i128 = env.storage().persistent().get(&by_type_key).unwrap_or(0);
    env.storage()
        .persistent()
        .set(&by_type_key, &by_type.checked_add(amount).ok_or(CouponEngineError::Overflow)?);

    let combined_key = DataKey::AccruedCredits(bond_id, holder);
    let combined: i128 = env.storage().persistent().get(&combined_key).unwrap_or(0);
    env.storage()
        .persistent()
        .set(
            &combined_key,
            &combined.checked_add(amount).ok_or(CouponEngineError::Overflow)?,
        );
    Ok(())
}

fn clear_accrued(env: &Env, bond_id: u64, holder: &Address, credit_type: CreditType) {
    let key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
    env.storage().persistent().set(&key, &0i128);
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        vec, BytesN, Env, Symbol,
    };

    fn setup_project(env: &Env, t: &TestEnv, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        let hash = BytesN::from_array(env, &arr);

        let registry = nbbs_project_registry::ProjectRegistryClient::new(env, &t.registry_id);
        let user = Address::generate(env);
        let pid = registry.register_project(
            &user,
            &hash,
            &Symbol::new(env, "VCS"),
            &Symbol::new(env, "US"),
            &0,
        );
        let admin_nonce = t.registry_admin_nonce.get();
        registry.approve_project(&t.admin, &pid, &admin_nonce);
        t.registry_admin_nonce.set(admin_nonce + 1);
        hash
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
        registry_id: Address,
        registry_admin_nonce: core::cell::Cell<u64>,
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
        let registry_id = env.register(
            nbbs_project_registry::ProjectRegistry,
            (admin.clone(),),
        );
        let ce_id = env.register(
            CouponEngine,
            (admin.clone(), issuer_id.clone(), oracle_id.clone(), registry_id.clone()),
        );
        let client = CouponEngineClient::new(&env, &ce_id);

        TestEnv {
            _env: env,
            admin,
            issuer_id,
            issuer_admin,
            oracle_id,
            registry_id,
            registry_admin_nonce: core::cell::Cell::new(0),
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

    /// Build a `Vec<(Address, i128)>` from a plain list of addresses by
    /// fetching each holder's on-chain balance from `BondIssuer`.  Used in
    /// tests that don't care about the holder/balance distinction and just
    /// want to call `distribute_coupon` with the new signature.
    fn holders_with_balances(
        env: &Env,
        t: &TestEnv,
        bond_id: u64,
        addrs: &[&Address],
    ) -> Vec<(Address, i128)> {
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(env, &t.issuer_id);
        let mut v: Vec<(Address, i128)> = Vec::new(env);
        for &addr in addrs {
            let bal = issuer.get_holder_balance(&bond_id, addr);
            v.push_back((addr.clone(), bal));
        }
        v
    }

    #[test]
    fn test_constructor_and_register_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin.clone());

        let project_id = setup_project(&t._env, &t, 42);
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

        let project_id = setup_project(&t._env, &t, 42);
        let result = t.client.try_register_bond(&user, &1, &project_id, &0);
        assert_eq!(result, Err(Ok(CouponEngineError::Unauthorized)));
    }

    #[test]
    fn test_register_bond_invalid_nonce() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 42);
        let result = t.client.try_register_bond(&t.admin, &1, &project_id, &1);
        assert_eq!(result, Err(Ok(CouponEngineError::InvalidNonce)));
    }

    #[test]
    fn test_register_bond_project_unapproved() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let mut arr = [0u8; 32];
        arr[31] = 42;
        let project_id = BytesN::from_array(&t._env, &arr);

        let registry = nbbs_project_registry::ProjectRegistryClient::new(&t._env, &t.registry_id);
        let user = Address::generate(&t._env);
        registry.register_project(
            &user,
            &project_id,
            &Symbol::new(&t._env, "VCS"),
            &Symbol::new(&t._env, "US"),
            &0,
        );

        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 1000);
        let result = t.client.try_register_bond(&t.admin, &bond_id, &project_id, &0);
        assert_eq!(result, Err(Ok(CouponEngineError::ProjectNotApproved)));
    }

    #[test]
    fn test_register_bond_project_mismatch() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 42);
        let wrong_project_id = setup_project(&t._env, &t, 43);

        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 1000);

        let result = t.client.try_register_bond(&t.admin, &bond_id, &wrong_project_id, &0);
        assert_eq!(result, Err(Ok(CouponEngineError::BondNotFound)));
    }

    #[test]
    fn test_distribute_to_single_holder() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
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

        let project_id = setup_project(&t._env, &t, 2);
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
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
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

        let project_id = setup_project(&t._env, &t, 3);
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
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
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

        let project_id = setup_project(&t._env, &t, 4);
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
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
        );
        assert_eq!(result, Err(Ok(CouponEngineError::InvalidReport)));
    }

    #[test]
    fn test_distribute_pro_rata_multiple_holders() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
        let holder1 = Address::generate(&t._env);
        let holder2 = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder1, 3_000);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder2, &bond_id, &7_000, &0);

        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder1, &holder2]);

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
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

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 0, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
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

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_unverified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
        );
        assert_eq!(result, Err(Ok(CouponEngineError::ReportNotVerified)));

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_distribute_rejects_report_for_other_project() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
        let other_project = setup_project(&t._env, &t, 2);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &other_project, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
        );
        assert_eq!(result, Err(Ok(CouponEngineError::BondNotFound)));
    }

    #[test]
    fn test_prevent_double_distribute() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1, &true);

        // After a successful final-batch call the period is locked.  A second
        // attempt on the same period must return PeriodAlreadyDistributed.
        let result = t.client.try_distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &2,
            &true,
        );
        assert_eq!(result, Err(Ok(CouponEngineError::PeriodAlreadyDistributed)));
    }

    #[test]
    fn test_distribute_unregistered_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders: Vec<(Address, i128)> = Vec::new(&t._env);

        let result = t.client.try_distribute_coupon(
            &t.admin,
            &999,
            &0,
            &holders,
            &report_id,
            &0,
            &true,
        );
        assert_eq!(result, Err(Ok(CouponEngineError::BondNotFound)));
    }

    #[test]
    fn test_claim_credits() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1, &true);

        let claimed = t.client.claim_credits(&holder, &bond_id, &0);
        assert_eq!(claimed, 100);

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_claim_credits_single_event() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env.clone(), admin);

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe_with_type(
            &t._env,
            &t,
            &project_id,
            nbbs_shared::CreditType::Carbon,
            &holder,
            10_000,
        );
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1, &true);

        let claimed = t.client.claim_credits(&holder, &bond_id, &0);
        let carbon_total = 100i128;
        assert_eq!(claimed, carbon_total);
    }

    #[test]
    fn test_claim_credits_basket_event() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env.clone(), admin);

        let project_id = setup_project(&t._env, &t, 3);
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
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1, &true);

        let claimed = t.client.claim_credits(&holder, &bond_id, &0);
        let bio_total = 500 + 125 * SPECIES_CREDIT_RATE / HABITAT_CREDIT_RATE + 1_000;
        let carbon_total = 100i128;
        assert_eq!(claimed, carbon_total + bio_total);
    }

    #[test]
    fn test_zero_holders_case() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders: Vec<(Address, i128)> = Vec::new(&t._env);

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
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

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        assert_eq!(t.client.get_period_count(&bond_id), 0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);

        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1, &true);
        assert_eq!(t.client.get_period_count(&bond_id), 1);

        let report_id2 = submit_verified_report(&t._env, &t, &project_id, 200_000, BiodiversityMetrics::Absent, 2);
        let holders2 = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        t.client.distribute_coupon(&t.admin, &bond_id, &1, &holders2, &report_id2, &2, &true);
        assert_eq!(t.client.get_period_count(&bond_id), 2);
    }

    #[test]
    fn test_get_period_info_range_paginates() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 1);
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
            let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
            t.client.distribute_coupon(
                &t.admin,
                &bond_id,
                &period,
                &holders,
                &report_id,
                &((period as u64) + 1),
                &true,
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

        let project_id = setup_project(&t._env, &t, 1);
        let holder_a = Address::generate(&t._env);
        let holder_b = Address::generate(&t._env);
        let holder_c = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder_a, 1);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder_b, &bond_id, &1, &0);
        issuer.subscribe(&holder_c, &bond_id, &1, &0);

        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder_a, &holder_b, &holder_c]);

        let result = t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &holders,
            &report_id,
            &1,
            &true,
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

        let project_id = setup_project(&t._env, &t, 1);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(&t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0);
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1, &true);

        let user = Address::generate(&t._env);
        let result = t.client.try_sweep_undistributed(&user, &bond_id, &0);
        assert_eq!(result, Err(Ok(CouponEngineError::Unauthorized)));
    }

    #[test]
    fn test_query_accrued_credits_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let oracle = Address::generate(&env);
        let registry = Address::generate(&env);

        let contract_id = env.register(CouponEngine, (admin, issuer, oracle, registry));
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
        let registry = Address::generate(&env);

        let contract_id = env.register(CouponEngine, (admin, issuer, oracle, registry));
        let client = CouponEngineClient::new(&env, &contract_id);

        let holder = Address::generate(&env);
        let result = client.try_claim_credits(&holder, &1, &1);
        assert_eq!(result, Err(Ok(CouponEngineError::InvalidNonce)));
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
        ) -> (TestEnv, std::vec::Vec<Address>, u64, i128, BytesN<32>) {
            let t = deploy(env, admin);
            let project_id = setup_project(&t._env, &t, 7);
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
            (t, holders, bond_id, total_subscribed, project_id)
        }

        fn setup_with_balances(
            env: Env,
            admin: Address,
            balances: &[i128],
            carbon: i128,
        ) -> (TestEnv, std::vec::Vec<Address>, u64, i128, u64) {
            let (t, holders, bond_id, total_subscribed, project_id) =
                deploy_with_holders(env, admin, balances);
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

                let mut holders_vec: Vec<(Address, i128)> = Vec::new(&t._env);
                for (h, &bal) in holders.iter().zip(balances.iter()) {
                    holders_vec.push_back((h.clone(), bal));
                }

                let total_credits = carbon / 1000;
                let result = t.client.distribute_coupon(
                    &t.admin,
                    &bond_id,
                    &0,
                    &holders_vec,
                    &report_id,
                    &1,
                    &true,
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
                let (t, holders, bond_id, total_subscribed, project_id) =
                    deploy_with_holders(env, admin.clone(), &balances);

                let mut holders_vec: Vec<(Address, i128)> = Vec::new(&t._env);
                for (h, &bal) in holders.iter().zip(balances.iter()) {
                    holders_vec.push_back((h.clone(), bal));
                }

                let mut sum_undistributed = 0i128;
                for (period, &carbon) in [carbon_0, carbon_1].iter().enumerate() {
                    let report_id = submit_verified_report(
                        &t._env,
                        &t,
                        &project_id,
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
                        &true,
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

    // ── Batch-distribution unit tests ────────────────────────────────────────

    #[test]
    fn test_batch_two_non_overlapping_batches_distribute_all_holders() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 5);
        let holder_a = Address::generate(&t._env);
        let holder_b = Address::generate(&t._env);
        let holder_c = Address::generate(&t._env);

        // Each holder subscribes for equal amounts.
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder_a, 3_000);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder_b, &bond_id, &3_000, &0);
        issuer.subscribe(&holder_c, &bond_id, &4_000, &0);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env, &t, &project_id, 30_000_000, BiodiversityMetrics::Absent, 0,
        );

        // Batch 1 – only holder_a and holder_b, NOT the final batch.
        let batch1 = holders_with_balances(&t._env, &t, bond_id, &[&holder_a, &holder_b]);
        let partial = t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &batch1, &report_id, &1, &false,
        );
        // Period must NOT be marked distributed yet.
        assert_eq!(
            t.client.try_get_period_info(&bond_id, &0),
            Err(Ok(CouponEngineError::PeriodNotFound)),
            "period must not be finalised after partial batch"
        );
        assert_eq!(partial.holder_count, 2);

        // Batch 2 – only holder_c, is the final batch.
        let batch2 = holders_with_balances(&t._env, &t, bond_id, &[&holder_c]);
        let final_result = t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &batch2, &report_id, &2, &true,
        );
        assert_eq!(final_result.holder_count, 3);
        assert!(final_result.total_credits > 0);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert!(period_info.distributed);

        // Credit conservation: sum of holder credits + undistributed == total.
        let total_credits = 30_000_000i128 / 1000; // 30_000
        let a = t.client.accrued_credits(&bond_id, &holder_a);
        let b = t.client.accrued_credits(&bond_id, &holder_b);
        let c = t.client.accrued_credits(&bond_id, &holder_c);
        let undistributed = t.client.get_undistributed_total(&bond_id);
        assert_eq!(a + b + c + undistributed, total_credits);
    }

    #[test]
    fn test_batch_already_distributed_holder_is_no_op() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 6);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0,
        );

        // First batch pays the holder.
        let batch = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &batch, &report_id, &1, &false,
        );
        let after_first = t.client.accrued_credits(&bond_id, &holder);
        assert!(after_first > 0);

        // Second batch includes the same holder again (duplicate) – must be a no-op.
        let batch_dup = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        let result = t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &batch_dup, &report_id, &2, &true,
        );
        // The holder must NOT have received extra credits.
        assert_eq!(t.client.accrued_credits(&bond_id, &holder), after_first);
        // The result's total must not be inflated by the duplicate.
        assert_eq!(result.total_credits, after_first);
    }

    #[test]
    fn test_batch_period_already_distributed_rejects_new_batches() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 7);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env, &t, &project_id, 100_000, BiodiversityMetrics::Absent, 0,
        );

        // Complete the period in one shot.
        let holders = holders_with_balances(&t._env, &t, bond_id, &[&holder]);
        t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &holders, &report_id, &1, &true,
        );

        // Any further call must be rejected.
        let result = t.client.try_distribute_coupon(
            &t.admin, &bond_id, &0, &holders, &report_id, &2, &true,
        );
        assert_eq!(result, Err(Ok(CouponEngineError::PeriodAlreadyDistributed)));
    }

    #[test]
    fn test_three_batch_credit_conservation() {
        // Three equal-size batches; credit conservation must hold after each
        // intermediate batch and after the final batch.
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = setup_project(&t._env, &t, 8);

        let holders_std: std::vec::Vec<Address> =
            (0..9).map(|_| Address::generate(&t._env)).collect();
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        let mut config = make_bond_config(&t._env, &project_id);
        config.total_supply = 9_000;
        let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);
        for h in &holders_std {
            issuer.subscribe(h, &bond_id, &1_000, &0);
        }
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        // 9_000_000 kg  → 9_000 credits (1 per tonne = 1 per holder at 1_000 tokens each)
        let report_id = submit_verified_report(
            &t._env, &t, &project_id, 9_000_000, BiodiversityMetrics::Absent, 0,
        );
        let total_credits = 9_000i128;

        // Batch 1: holders 0-2 (not final).
        let b1_refs: std::vec::Vec<&Address> = holders_std[0..3].iter().collect();
        let b1 = holders_with_balances(&t._env, &t, bond_id, &b1_refs);
        let r1 = t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &b1, &report_id, &1, &false,
        );
        assert_eq!(r1.holder_count, 3);
        // Period must NOT be finalised yet.
        assert_eq!(
            t.client.try_get_period_info(&bond_id, &0),
            Err(Ok(CouponEngineError::PeriodNotFound))
        );

        // Batch 2: holders 3-5 (not final).
        let b2_refs: std::vec::Vec<&Address> = holders_std[3..6].iter().collect();
        let b2 = holders_with_balances(&t._env, &t, bond_id, &b2_refs);
        let r2 = t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &b2, &report_id, &2, &false,
        );
        assert_eq!(r2.holder_count, 6);

        // Batch 3: holders 6-8 (final).
        let b3_refs: std::vec::Vec<&Address> = holders_std[6..9].iter().collect();
        let b3 = holders_with_balances(&t._env, &t, bond_id, &b3_refs);
        let r3 = t.client.distribute_coupon(
            &t.admin, &bond_id, &0, &b3, &report_id, &3, &true,
        );
        assert_eq!(r3.holder_count, 9);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert!(period_info.distributed);

        let sum_accrued: i128 = holders_std
            .iter()
            .map(|h| t.client.accrued_credits(&bond_id, h))
            .sum();
        let undistributed = t.client.get_undistributed_total(&bond_id);
        assert_eq!(sum_accrued + undistributed, total_credits,
            "credit conservation violated: {} + {} != {}",
            sum_accrued, undistributed, total_credits);
    }
}