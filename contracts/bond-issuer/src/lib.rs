#![no_std]
#![allow(deprecated)]
use nbbs_shared::{BondConfig, BondError, BondStatus};
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, Symbol, Vec};

pub const MAX_SUPPLY: i128 = 1_000_000_000_000_000_000;
const LEDGER_CLOSE_TIME_SECS: u64 = 5;
const MAX_PERSISTENT_TTL: u32 = 2_073_600;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    BondConfig(u64),
    BondState(u64),
    HolderBalance(u64, Address),
    HolderList(u64),
    HolderCount(u64),
    BondCount,
    BondList,
    Nonce(Address),
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct BondState {
    pub total_subscribed: i128,
    pub status: BondStatus,
    pub created_at: u64,
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

/// Register a holder in the bond's on-chain `HolderList`. Called once per
/// holder on the first mint/transfer into a zero balance, so the list tracks
/// the set of addresses that have ever held the bond without duplicating
/// entries. Addresses that later transfer their entire balance out remain in
/// the list (with a zero balance) and are filtered at coupon distribution.
fn append_holder(env: &Env, bond_id: u64, maturity_date: u64, holder: Address) {
    let key = DataKey::HolderList(bond_id);
    let mut list: Vec<Address> = env.storage().persistent().get(&key).unwrap_or(vec![&env]);
    list.push_back(holder);
    env.storage().persistent().set(&key, &list);

    env.storage()
        .persistent()
        .set(&DataKey::HolderCount(bond_id), &(list.len() as u64));
    extend_bond_ttl(env, bond_id, maturity_date);
}

fn holder_count_from_persistent(env: &Env, bond_id: u64) -> u64 {
    if let Some(count) = env
        .storage()
        .persistent()
        .get(&DataKey::HolderCount(bond_id))
    {
        return count;
    }

    let list: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::HolderList(bond_id))
        .unwrap_or(vec![env]);
    list.len() as u64
}

fn extend_bond_ttl(env: &Env, bond_id: u64, maturity_date: u64) {
    let now = env.ledger().timestamp();
    let remaining_secs = maturity_date.saturating_sub(now);
    let remaining_ledgers = remaining_secs / LEDGER_CLOSE_TIME_SECS;

    let extend_to = remaining_ledgers
        .saturating_add(17_280)
        .min(MAX_PERSISTENT_TTL as u64) as u32;
    let threshold = extend_to / 10;
    let threshold = threshold.max(1_728);

    let config_key = DataKey::BondConfig(bond_id);
    let state_key = DataKey::BondState(bond_id);
    let holder_list_key = DataKey::HolderList(bond_id);
    let holder_count_key = DataKey::HolderCount(bond_id);
    env.storage()
        .persistent()
        .extend_ttl(&config_key, threshold, extend_to);
    env.storage()
        .persistent()
        .extend_ttl(&state_key, threshold, extend_to);
    if env.storage().persistent().has(&holder_list_key) {
        env.storage()
            .persistent()
            .extend_ttl(&holder_list_key, threshold, extend_to);
    }
    if env.storage().persistent().has(&holder_count_key) {
        env.storage()
            .persistent()
            .extend_ttl(&holder_count_key, threshold, extend_to);
    }
}

#[contract]
pub struct BondIssuer;

#[contractimpl]
impl BondIssuer {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn issue_bond(
        env: Env,
        caller: Address,
        config: BondConfig,
        nonce: u64,
    ) -> Result<u64, BondError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        if config.face_value <= 0 {
            return Err(BondError::ZeroAmount);
        }
        if config.total_supply <= 0 {
            return Err(BondError::ZeroAmount);
        }
        if config.maturity_date <= env.ledger().timestamp() {
            return Err(BondError::MaturityDateInPast);
        }

        let schedule_len = config.coupon_schedule.len();
        if schedule_len == 0 {
            return Err(BondError::ZeroAmount);
        }
        for i in 0..schedule_len {
            let coupon_date = config.coupon_schedule.get(i).unwrap();
            if coupon_date >= config.maturity_date {
                return Err(BondError::ZeroAmount);
            }
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::BondCount)
            .unwrap_or(0);
        let bond_id = count + 1;
        env.storage().instance().set(&DataKey::BondCount, &bond_id);

        env.storage()
            .persistent()
            .set(&DataKey::BondConfig(bond_id), &config);

        let state = BondState {
            total_subscribed: 0,
            status: BondStatus::Active,
            created_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::BondState(bond_id), &state);
        let holders: Vec<Address> = vec![&env];
        env.storage()
            .persistent()
            .set(&DataKey::HolderList(bond_id), &holders);
        env.storage()
            .persistent()
            .set(&DataKey::HolderCount(bond_id), &0u64);

        extend_bond_ttl(&env, bond_id, config.maturity_date);

        let mut bond_list: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::BondList)
            .unwrap_or(vec![&env]);
        bond_list.push_back(bond_id);
        env.storage()
            .persistent()
            .set(&DataKey::BondList, &bond_list);

        env.events().publish(
            (Symbol::new(&env, "bond_issued"),),
            (bond_id, config.project_id),
        );

        Ok(bond_id)
    }

    pub fn subscribe(
        env: Env,
        investor: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        investor.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(investor.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(investor.clone()), &(expected_nonce + 1));

        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let mut state: BondState = env
            .storage()
            .persistent()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        extend_bond_ttl(&env, bond_id, config.maturity_date);

        if state.status != BondStatus::Active {
            return Err(BondError::BondAlreadyMatured);
        }

        if env.ledger().timestamp() >= config.maturity_date {
            return Err(BondError::BondAlreadyMatured);
        }

        let new_total = state
            .total_subscribed
            .checked_add(amount)
            .ok_or(BondError::Overflow)?;
        if new_total > config.total_supply {
            return Err(BondError::InsufficientSupply);
        }

        let balance_key = DataKey::HolderBalance(bond_id, investor.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        let new_balance = current_balance
            .checked_add(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&balance_key, &new_balance);

        if current_balance == 0 {
            append_holder(&env, bond_id, config.maturity_date, investor.clone());
        }

        state.total_subscribed = new_total;
        env.storage()
            .persistent()
            .set(&DataKey::BondState(bond_id), &state);

        extend_bond_ttl(&env, bond_id, config.maturity_date);

        env.events().publish(
            (Symbol::new(&env, "subscribed"),),
            (bond_id, investor, amount),
        );

        Ok(())
    }

    pub fn get_nonce(env: Env, addr: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Nonce(addr))
            .unwrap_or(0)
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        from.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(from.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(from.clone()), &(expected_nonce + 1));

        if to == from {
            return Err(BondError::Unauthorized);
        }
        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let state: BondState = env
            .storage()
            .persistent()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        extend_bond_ttl(&env, bond_id, config.maturity_date);
        if state.status != BondStatus::Active {
            return Err(BondError::BondAlreadyMatured);
        }

        if env.ledger().timestamp() >= config.maturity_date {
            return Err(BondError::BondAlreadyMatured);
        }

        let from_key = DataKey::HolderBalance(bond_id, from.clone());
        let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_balance < amount {
            return Err(BondError::InsufficientBalance);
        }

        let new_from_balance = from_balance
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&from_key, &new_from_balance);

        let to_key = DataKey::HolderBalance(bond_id, to.clone());
        let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        let new_to_balance = to_balance.checked_add(amount).ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&to_key, &new_to_balance);

        if to_balance == 0 {
            append_holder(&env, bond_id, config.maturity_date, to.clone());
        }

        env.events().publish(
            (Symbol::new(&env, "transferred"),),
            (bond_id, from, to, amount),
        );

        Ok(())
    }

    pub fn redeem(
        env: Env,
        holder: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        holder.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(holder.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(holder.clone()), &(expected_nonce + 1));

        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let mut state: BondState = env
            .storage()
            .persistent()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        extend_bond_ttl(&env, bond_id, config.maturity_date);

        if state.status != BondStatus::Matured {
            return Err(BondError::BondAlreadyMatured);
        }

        let balance_key = DataKey::HolderBalance(bond_id, holder.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if current_balance < amount {
            return Err(BondError::InsufficientBalance);
        }

        let new_balance = current_balance
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&balance_key, &new_balance);

        state.total_subscribed = state
            .total_subscribed
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::BondState(bond_id), &state);

        extend_bond_ttl(&env, bond_id, config.maturity_date);

        env.events()
            .publish((Symbol::new(&env, "redeemed"),), (bond_id, holder, amount));

        Ok(())
    }

    pub fn get_bond(env: Env, bond_id: u64) -> Result<BondConfig, BondError> {
        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;
        extend_bond_ttl(&env, bond_id, config.maturity_date);
        Ok(config)
    }

    pub fn get_bond_state(env: Env, bond_id: u64) -> Result<BondState, BondError> {
        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;
        let state: BondState = env
            .storage()
            .persistent()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;
        extend_bond_ttl(&env, bond_id, config.maturity_date);
        Ok(state)
    }

    pub fn get_holder_balance(env: Env, bond_id: u64, holder: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::HolderBalance(bond_id, holder))
            .unwrap_or(0)
    }

    /// Full on-chain holder list for `bond_id`, in insertion order.
    pub fn get_holder_list(env: Env, bond_id: u64) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::HolderList(bond_id))
            .unwrap_or(vec![&env])
    }

    /// Number of distinct holders ever recorded for `bond_id`.
    pub fn get_holder_count(env: Env, bond_id: u64) -> u64 {
        holder_count_from_persistent(&env, bond_id)
    }

    /// Returns up to `count` holder addresses for `bond_id` starting at index
    /// `start` of the persistent `HolderList`, preserving insertion order.
    /// Mirrors `get_bond_ids_range` so the API can page through the holder
    /// list without materialising it in a single call.
    pub fn get_holder_list_range(env: Env, bond_id: u64, start: u32, count: u32) -> Vec<Address> {
        let holder_list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::HolderList(bond_id))
            .unwrap_or(vec![&env]);
        let mut result: Vec<Address> = vec![&env];

        let len = holder_list.len();
        if count == 0 || start >= len {
            return result;
        }

        let end = ((start as u64) + (count as u64)).min(len as u64) as u32;
        for i in start..end {
            if let Some(addr) = holder_list.get(i) {
                result.push_back(addr);
            }
        }

        result
    }

    pub fn total_supply(env: Env, bond_id: u64) -> Result<i128, BondError> {
        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;
        extend_bond_ttl(&env, bond_id, config.maturity_date);
        Ok(config.total_supply)
    }

    pub fn total_subscribed(env: Env, bond_id: u64) -> Result<i128, BondError> {
        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;
        let state: BondState = env
            .storage()
            .persistent()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;
        extend_bond_ttl(&env, bond_id, config.maturity_date);
        Ok(state.total_subscribed)
    }

    pub fn bond_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::BondCount)
            .unwrap_or(0)
    }

    pub fn get_all_bond_ids(env: Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::BondList)
            .unwrap_or(vec![&env])
    }

    /// Returns up to `count` bond IDs starting at index `start` of the
    /// persistent `BondList`, preserving issuance order. `start` is a
    /// zero-based offset into the list, not a bond ID. Returns an empty
    /// vector when `start` is beyond the end of the list or when `count`
    /// is zero. Does not modify storage.
    pub fn get_bond_ids_range(env: Env, start: u32, count: u32) -> Vec<u64> {
        let bond_list: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::BondList)
            .unwrap_or(vec![&env]);
        let mut result: Vec<u64> = vec![&env];

        let len = bond_list.len();
        if count == 0 || start >= len {
            return result;
        }

        let end = ((start as u64) + (count as u64)).min(len as u64) as u32;
        for i in start..end {
            if let Some(id) = bond_list.get(i) {
                result.push_back(id);
            }
        }

        result
    }

    pub fn mature_bond(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let config: BondConfig = env
            .storage()
            .persistent()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let mut state: BondState = env
            .storage()
            .persistent()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        extend_bond_ttl(&env, bond_id, config.maturity_date);

        if state.status != BondStatus::Active {
            return Err(BondError::BondAlreadyMatured);
        }

        if env.ledger().timestamp() < config.maturity_date {
            return Err(BondError::NotYetMature);
        }

        state.status = BondStatus::Matured;
        env.storage()
            .persistent()
            .set(&DataKey::BondState(bond_id), &state);

        extend_bond_ttl(&env, bond_id, config.maturity_date);

        env.events()
            .publish((Symbol::new(&env, "bond_matured"),), (bond_id,));

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::storage::Persistent as _, testutils::Address as _, testutils::Ledger as _, vec,
        BytesN,
    };

    fn create_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_config(env: &Env) -> BondConfig {
        BondConfig {
            project_id: create_project_id(env, 1),
            face_value: 1000,
            coupon_schedule: vec![&env, 1000000u64, 2000000u64],
            credit_type: nbbs_shared::CreditType::Carbon,
            maturity_date: 3000000,
            total_supply: 10000,
        }
    }

    fn setup() -> (Env, BondIssuerClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let contract_id = env.register(BondIssuer, (&admin,));
        let client = BondIssuerClient::new(&env, &contract_id);
        (env, client, admin, user)
    }

    #[test]
    fn test_issue_bond() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);

        let bond_id = client.issue_bond(&admin, &config, &0);
        assert_eq!(bond_id, 1);

        let stored = client.get_bond(&bond_id);
        assert_eq!(stored.face_value, 1000);
        assert_eq!(stored.total_supply, 10000);
        assert_eq!(stored.maturity_date, 3000000);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 0);
        assert_eq!(state.status, BondStatus::Active);
    }

    #[test]
    fn test_issue_bond_past_maturity() {
        let (env, client, admin, _user) = setup();
        env.ledger().set_timestamp(1000);
        let mut config = make_config(&env);
        config.maturity_date = 500;

        let result = client.try_issue_bond(&admin, &config, &0);
        assert_eq!(result, Err(Ok(BondError::MaturityDateInPast)));
    }

    #[test]
    fn test_issue_bond_empty_schedule() {
        let (env, client, admin, _user) = setup();
        let mut config = make_config(&env);
        config.coupon_schedule = vec![&env];

        let result = client.try_issue_bond(&admin, &config, &0);
        assert_eq!(result, Err(Ok(BondError::ZeroAmount)));
    }

    #[test]
    fn test_subscribe_partial() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 500);

        let balance = client.get_holder_balance(&bond_id, &user);
        assert_eq!(balance, 500);
    }

    #[test]
    fn test_subscribe_full() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &10000, &0);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 10000);
    }

    #[test]
    fn test_subscribe_exceeds_supply() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let result = client.try_subscribe(&user, &bond_id, &10001, &0);
        assert_eq!(result, Err(Ok(BondError::InsufficientSupply)));
    }

    #[test]
    fn test_subscribe_zero_amount() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let result = client.try_subscribe(&user, &bond_id, &0, &0);
        assert_eq!(result, Err(Ok(BondError::ZeroAmount)));
    }

    #[test]
    fn test_subscribe_non_existent_bond() {
        let (_env, client, _admin, user) = setup();
        let result = client.try_subscribe(&user, &999, &500, &0);
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_mature_bond() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &5000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.status, BondStatus::Matured);
    }

    #[test]
    fn test_mature_bond_before_maturity_rejected() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &5000, &0);
        env.ledger().set_timestamp(config.maturity_date - 1);

        let result = client.try_mature_bond(&admin, &bond_id, &1);
        assert_eq!(result, Err(Ok(BondError::NotYetMature)));

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.status, BondStatus::Active);
    }

    #[test]
    fn test_subscribe_after_maturity_date_rejected() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        env.ledger().set_timestamp(config.maturity_date);

        let result = client.try_subscribe(&user, &bond_id, &1000, &0);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_transfer_after_maturity_date_rejected() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        env.ledger().set_timestamp(config.maturity_date);

        let result = client.try_transfer(&user, &user2, &bond_id, &100, &1);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_redeem_after_maturity() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &3000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        client.redeem(&user, &bond_id, &1000, &1);

        let balance = client.get_holder_balance(&bond_id, &user);
        assert_eq!(balance, 2000);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 2000);
    }

    #[test]
    fn test_redeem_before_maturity() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &3000, &0);

        let result = client.try_redeem(&user, &bond_id, &1000, &1);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_redeem_more_than_owned() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        let result = client.try_redeem(&user, &bond_id, &2000, &1);
        assert_eq!(result, Err(Ok(BondError::InsufficientBalance)));
    }

    #[test]
    fn test_invalid_nonce() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);

        let result = client.try_issue_bond(&admin, &config, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidNonce)));
    }

    #[test]
    fn test_unauthorized() {
        let (env, client, _admin, user) = setup();
        let config = make_config(&env);

        let result = client.try_issue_bond(&user, &config, &0);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_multiple_investors() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &2000, &0);
        client.subscribe(&user2, &bond_id, &3000, &0);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 2000);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 3000);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 5000);
    }

    #[test]
    fn test_total_supply_and_subscribed() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        assert_eq!(client.total_supply(&bond_id), 10000);
        assert_eq!(client.total_subscribed(&bond_id), 0);

        client.subscribe(&user, &bond_id, &4000, &0);
        assert_eq!(client.total_subscribed(&bond_id), 4000);
    }

    #[test]
    fn test_transfer() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.transfer(&user, &user2, &bond_id, &600, &1);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 400);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 600);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 1000);
    }

    #[test]
    fn test_transfer_partial_keeps_source() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.subscribe(&user2, &bond_id, &500, &0);
        client.transfer(&user, &user2, &bond_id, &250, &1);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 750);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 750);
    }

    #[test]
    fn test_transfer_more_than_owned() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let result = client.try_transfer(&user, &user2, &bond_id, &600, &1);
        assert_eq!(result, Err(Ok(BondError::InsufficientBalance)));
    }

    #[test]
    fn test_transfer_from_non_holder() {
        let (env, client, admin, _user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let result = client.try_transfer(&user2, &Address::generate(&env), &bond_id, &100, &0);
        assert_eq!(result, Err(Ok(BondError::InsufficientBalance)));
    }

    #[test]
    fn test_transfer_self_rejected() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let result = client.try_transfer(&user, &user, &bond_id, &100, &1);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_transfer_zero_amount() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let result = client.try_transfer(&user, &user2, &bond_id, &0, &1);
        assert_eq!(result, Err(Ok(BondError::ZeroAmount)));
    }

    #[test]
    fn test_transfer_nonexistent_bond() {
        let (_env, client, _admin, user) = setup();
        let user2 = Address::generate(&_env);
        let result = client.try_transfer(&user, &user2, &999, &100, &0);
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_transfer_matured_bond_rejected() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        let result = client.try_transfer(&user, &user2, &bond_id, &100, &1);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_transfer_into_accumulated_balance() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.subscribe(&user2, &bond_id, &300, &0);
        client.transfer(&user, &user2, &bond_id, &700, &1);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 300);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 1000);
    }

    #[test]
    fn test_holder_list_tracks_subscribers() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &2000, &0);
        client.subscribe(&user2, &bond_id, &3000, &0);

        assert_eq!(client.get_holder_count(&bond_id), 2);
        assert_eq!(
            client.get_holder_list(&bond_id),
            vec![&env, user.clone(), user2.clone()]
        );
        assert_eq!(
            client.get_holder_list_range(&bond_id, &0, &1),
            vec![&env, user.clone()]
        );
        assert_eq!(
            client.get_holder_list_range(&bond_id, &1, &10),
            vec![&env, user2.clone()]
        );
    }

    #[test]
    fn test_holder_count_written_to_persistent_storage() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &2000, &0);
        client.subscribe(&user2, &bond_id, &3000, &0);

        env.as_contract(&client.address, || {
            let key = DataKey::HolderCount(bond_id);
            assert!(env.storage().persistent().has(&key));
            assert!(!env.storage().instance().has(&key));
            let stored: u64 = env.storage().persistent().get(&key).unwrap();
            assert_eq!(stored, 2);
        });
    }

    #[test]
    fn test_holder_list_dedupes_repeat_subscriber() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);
        client.subscribe(&user, &bond_id, &500, &1);

        assert_eq!(client.get_holder_count(&bond_id), 1);
        assert_eq!(client.get_holder_list(&bond_id), vec![&env, user.clone()]);
    }

    #[test]
    fn test_holder_list_appends_transfer_recipient() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.transfer(&user, &user2, &bond_id, &600, &1);

        assert_eq!(client.get_holder_count(&bond_id), 2);
        assert_eq!(
            client.get_holder_list(&bond_id),
            vec![&env, user.clone(), user2.clone()]
        );
        assert_eq!(client.get_holder_balance(&bond_id, &user), 400);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 600);
    }

    #[test]
    fn test_holder_list_keeps_source_after_full_transfer() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.transfer(&user, &user2, &bond_id, &1000, &1);

        // The source keeps a zero balance and remains in the list; the API
        // filters zero-balance addresses out at distribution time.
        assert_eq!(client.get_holder_balance(&bond_id, &user), 0);
        assert_eq!(client.get_holder_count(&bond_id), 2);
        assert_eq!(
            client.get_holder_list(&bond_id),
            vec![&env, user.clone(), user2.clone()]
        );
    }

    #[test]
    fn test_holder_list_empty_for_new_bond() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        assert_eq!(client.get_holder_count(&bond_id), 0);
        assert_eq!(client.get_holder_list(&bond_id), vec![&env]);
        assert_eq!(client.get_holder_list_range(&bond_id, &0, &20), vec![&env]);
    }

    #[test]
    fn test_holder_list_range_pagination() {
        let (env, client, admin, _user) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&a, &bond_id, &100, &0);
        client.subscribe(&b, &bond_id, &200, &0);
        client.subscribe(&c, &bond_id, &300, &0);

        assert_eq!(client.get_holder_count(&bond_id), 3);
        assert_eq!(
            client.get_holder_list_range(&bond_id, &0, &2),
            vec![&env, a.clone(), b.clone()]
        );
        assert_eq!(
            client.get_holder_list_range(&bond_id, &2, &2),
            vec![&env, c.clone()]
        );
        assert_eq!(client.get_holder_list_range(&bond_id, &3, &20), vec![&env]);
        assert_eq!(client.get_holder_list_range(&bond_id, &0, &0), vec![&env]);
    }

    #[test]
    fn test_holder_count_survives_instance_archival() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.subscribe(&user2, &bond_id, &1000, &0);

        env.as_contract(&client.address, || {
            env.storage()
                .instance()
                .remove(&DataKey::HolderCount(bond_id));
        });

        assert_eq!(client.get_holder_count(&bond_id), 2);
        assert_eq!(
            client.get_holder_count(&bond_id),
            client.get_holder_list(&bond_id).len() as u64
        );
    }

    #[test]
    fn test_holder_count_migrates_from_persistent_list_when_count_missing() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.subscribe(&user2, &bond_id, &1000, &0);

        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .remove(&DataKey::HolderCount(bond_id));
            env.storage()
                .instance()
                .set(&DataKey::HolderCount(bond_id), &0u64);
        });

        assert_eq!(client.get_holder_count(&bond_id), 2);
        assert_eq!(
            client.get_holder_count(&bond_id),
            client.get_holder_list(&bond_id).len() as u64
        );
    }

    #[test]
    fn test_bond_count() {
        let (env, client, admin, _user) = setup();
        assert_eq!(client.bond_count(), 0);

        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);
        assert_eq!(bond_id, 1);
        assert_eq!(client.bond_count(), 1);

        client.issue_bond(&admin, &config, &1);
        assert_eq!(client.bond_count(), 2);
    }

    #[test]
    fn test_get_all_bond_ids_empty() {
        let (env, client, _admin, _user) = setup();
        assert_eq!(client.get_all_bond_ids(), vec![&env]);
    }

    #[test]
    fn test_get_bond_ids_range_empty() {
        let (env, client, _admin, _user) = setup();
        assert_eq!(client.get_bond_ids_range(&0, &20), vec![&env]);
    }

    #[test]
    fn test_bond_list_first_bond() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);

        let bond_id = client.issue_bond(&admin, &config, &0);
        assert_eq!(bond_id, 1);

        assert_eq!(client.get_all_bond_ids(), vec![&env, 1u64]);
        assert_eq!(client.get_bond_ids_range(&0, &20), vec![&env, 1u64]);
        assert_eq!(client.bond_count(), 1);
    }

    #[test]
    fn test_bond_list_multiple_bonds() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);

        for nonce in 0..5u64 {
            let bond_id = client.issue_bond(&admin, &config, &nonce);
            assert_eq!(bond_id, nonce + 1);
        }

        let ids = client.get_all_bond_ids();
        assert_eq!(ids, vec![&env, 1u64, 2u64, 3u64, 4u64, 5u64]);
        assert_eq!(ids.len(), 5);
        assert_eq!(client.bond_count(), 5);

        for i in 0..ids.len() {
            let id = ids.get(i).unwrap();
            let bond = client.get_bond(&id);
            assert_eq!(bond.face_value, 1000);
        }
    }

    #[test]
    fn test_bond_ids_range() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);

        for nonce in 0..5u64 {
            client.issue_bond(&admin, &config, &nonce);
        }

        assert_eq!(
            client.get_bond_ids_range(&0, &3),
            vec![&env, 1u64, 2u64, 3u64]
        );
        assert_eq!(client.get_bond_ids_range(&2, &2), vec![&env, 3u64, 4u64]);
        assert_eq!(client.get_bond_ids_range(&4, &20), vec![&env, 5u64]);
        assert_eq!(client.get_bond_ids_range(&5, &20), vec![&env]);
        assert_eq!(client.get_bond_ids_range(&100, &20), vec![&env]);
        assert_eq!(client.get_bond_ids_range(&0, &0), vec![&env]);
        assert_eq!(
            client.get_all_bond_ids(),
            vec![&env, 1u64, 2u64, 3u64, 4u64, 5u64]
        );
    }

    // --- Issue #94: Persistent storage + TTL tests ---

    #[test]
    fn test_bond_config_state_written_to_persistent() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let contract_addr = client.address.clone();
        let config_key = DataKey::BondConfig(bond_id);
        let state_key = DataKey::BondState(bond_id);

        env.as_contract(&contract_addr, || {
            assert!(env.storage().persistent().has(&config_key));
            assert!(env.storage().persistent().has(&state_key));
            assert!(!env.storage().instance().has(&config_key));
            assert!(!env.storage().instance().has(&state_key));
        });
    }

    #[test]
    fn test_ttl_extended_on_read() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let contract_addr = client.address.clone();
        let config_key = DataKey::BondConfig(bond_id);

        env.ledger().set_sequence_number(100);
        let _ = client.get_bond(&bond_id);
        let ttl_after_first = env.as_contract(&contract_addr, || {
            env.storage().persistent().get_ttl(&config_key)
        });
        assert!(ttl_after_first > 0);

        env.ledger().set_sequence_number(500);
        let _ = client.get_bond(&bond_id);
        let ttl_after_second = env.as_contract(&contract_addr, || {
            env.storage().persistent().get_ttl(&config_key)
        });
        assert!(ttl_after_second > 0);
        assert!(ttl_after_second >= ttl_after_first - 400);
    }

    #[test]
    fn test_ttl_extended_on_write_subscribe() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let contract_addr = client.address.clone();
        let config_key = DataKey::BondConfig(bond_id);
        let state_key = DataKey::BondState(bond_id);
        let holder_list_key = DataKey::HolderList(bond_id);
        let holder_count_key = DataKey::HolderCount(bond_id);

        env.ledger().set_sequence_number(100);
        client.subscribe(&user, &bond_id, &500, &0);
        let (ttl_config, ttl_state, ttl_holder_list, ttl_holder_count) =
            env.as_contract(&contract_addr, || {
                (
                    env.storage().persistent().get_ttl(&config_key),
                    env.storage().persistent().get_ttl(&state_key),
                    env.storage().persistent().get_ttl(&holder_list_key),
                    env.storage().persistent().get_ttl(&holder_count_key),
                )
            });
        assert!(ttl_config > 0);
        assert!(ttl_state > 0);
        assert!(ttl_holder_list > 0);
        assert!(ttl_holder_count > 0);
    }

    #[test]
    fn test_ttl_extended_on_write_transfer() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);
        client.subscribe(&user, &bond_id, &1000, &0);

        let contract_addr = client.address.clone();
        let config_key = DataKey::BondConfig(bond_id);
        let state_key = DataKey::BondState(bond_id);
        let holder_list_key = DataKey::HolderList(bond_id);
        let holder_count_key = DataKey::HolderCount(bond_id);

        env.ledger().set_sequence_number(100);
        client.transfer(&user, &user2, &bond_id, &500, &1);
        let (ttl_config, ttl_state, ttl_holder_list, ttl_holder_count) =
            env.as_contract(&contract_addr, || {
                (
                    env.storage().persistent().get_ttl(&config_key),
                    env.storage().persistent().get_ttl(&state_key),
                    env.storage().persistent().get_ttl(&holder_list_key),
                    env.storage().persistent().get_ttl(&holder_count_key),
                )
            });
        assert!(ttl_config > 0);
        assert!(ttl_state > 0);
        assert!(ttl_holder_list > 0);
        assert!(ttl_holder_count > 0);
    }

    #[test]
    fn test_ttl_extended_on_write_redeem() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);
        client.subscribe(&user, &bond_id, &3000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        let contract_addr = client.address.clone();
        let state_key = DataKey::BondState(bond_id);

        env.ledger().set_sequence_number(100);
        client.redeem(&user, &bond_id, &1000, &1);
        let ttl_state = env.as_contract(&contract_addr, || {
            env.storage().persistent().get_ttl(&state_key)
        });
        assert!(ttl_state > 0);
    }

    #[test]
    fn test_ttl_extended_on_write_mature_bond() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);
        client.subscribe(&user, &bond_id, &3000, &0);

        let contract_addr = client.address.clone();
        let config_key = DataKey::BondConfig(bond_id);
        let state_key = DataKey::BondState(bond_id);

        env.ledger().set_timestamp(config.maturity_date);
        env.ledger().set_sequence_number(100);
        client.mature_bond(&admin, &bond_id, &1);
        let (ttl_config, ttl_state) = env.as_contract(&contract_addr, || {
            (
                env.storage().persistent().get_ttl(&config_key),
                env.storage().persistent().get_ttl(&state_key),
            )
        });
        assert!(ttl_config > 0);
        assert!(ttl_state > 0);
    }

    #[test]
    fn test_ttl_scales_with_maturity_date() {
        let (env, client, admin, _user) = setup();

        let mut config_short = make_config(&env);
        config_short.maturity_date = 500_000;
        config_short.coupon_schedule = vec![&env, 100_000u64, 200_000u64];
        let bond_short = client.issue_bond(&admin, &config_short, &0);

        let mut config_long = make_config(&env);
        config_long.maturity_date = 3_000_000;
        let bond_long = client.issue_bond(&admin, &config_long, &1);

        let contract_addr = client.address.clone();
        let key_short = DataKey::BondConfig(bond_short);
        let key_long = DataKey::BondConfig(bond_long);

        let (ttl_short, ttl_long) = env.as_contract(&contract_addr, || {
            (
                env.storage().persistent().get_ttl(&key_short),
                env.storage().persistent().get_ttl(&key_long),
            )
        });

        assert!(ttl_long > ttl_short);
    }

    #[test]
    fn test_regression_entry_survives_near_ttl_expiry() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let contract_addr = client.address.clone();
        let config_key = DataKey::BondConfig(bond_id);

        let initial_ttl = env.as_contract(&contract_addr, || {
            env.storage().persistent().get_ttl(&config_key)
        });
        assert!(initial_ttl > 0);

        env.ledger().set_sequence_number(1 + initial_ttl - 5);
        let ttl_before = env.as_contract(&contract_addr, || {
            env.storage().persistent().get_ttl(&config_key)
        });
        assert!(ttl_before <= 10);

        let stored = client.get_bond(&bond_id);
        assert_eq!(stored.face_value, 1000);

        let ttl_after = env.as_contract(&contract_addr, || {
            env.storage().persistent().get_ttl(&config_key)
        });
        assert!(ttl_after > ttl_before);
    }

    mod property {
        extern crate std;

        use super::*;
        use proptest::prelude::*;

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 64,
                ..ProptestConfig::default()
            })]

            // Supply conservation: through an arbitrary sequence of subscriptions
            // and transfers the sum of holder balances always equals
            // total_subscribed, never exceeds total_supply, and each balance is
            // non-negative.
            #[test]
            fn subscription_conserves_supply(
                supply in 100i128..1_000_000i128,
                subscribe_amounts in proptest::collection::vec(1i128..50_000i128, 0..20),
                transfer_amounts in proptest::collection::vec(1i128..50_000i128, 0..20),
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let users: std::vec::Vec<Address> =
                    (0..3).map(|_| Address::generate(&env)).collect();
                let contract_id = env.register(BondIssuer, (&admin,));
                let client = BondIssuerClient::new(&env, &contract_id);

                let mut config = make_config(&env);
                config.total_supply = supply;
                let bond_id = client.issue_bond(&admin, &config, &0);

                let mut balances = [0i128; 3];
                let mut total_subscribed = 0i128;
                let mut nonces = [0u64; 3];

                for (i, &amount) in subscribe_amounts.iter().enumerate() {
                    let u = i % 3;
                    if amount <= supply - total_subscribed {
                        client.subscribe(&users[u], &bond_id, &amount, &nonces[u]);
                        nonces[u] += 1;
                        total_subscribed += amount;
                        balances[u] += amount;
                    } else {
                        let res = client.try_subscribe(&users[u], &bond_id, &amount, &nonces[u]);
                        prop_assert_eq!(res, Err(Ok(BondError::InsufficientSupply)));
                    }
                    let sum: i128 = balances.iter().sum();
                    prop_assert_eq!(sum, total_subscribed);
                    prop_assert!(total_subscribed <= supply);
                    for b in &balances {
                        prop_assert!(*b >= 0);
                    }
                }
                prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);

                for (i, &amount) in transfer_amounts.iter().enumerate() {
                    let from = i % 3;
                    let to = (i + 1) % 3;
                    if amount <= balances[from] {
                        client.transfer(&users[from], &users[to], &bond_id, &amount, &nonces[from]);
                        nonces[from] += 1;
                        balances[from] -= amount;
                        balances[to] += amount;
                    } else {
                        let res =
                            client.try_transfer(&users[from], &users[to], &bond_id, &amount, &nonces[from]);
                        prop_assert_eq!(res, Err(Ok(BondError::InsufficientBalance)));
                    }
                    let sum: i128 = balances.iter().sum();
                    prop_assert_eq!(sum, total_subscribed);
                    prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);
                    for b in &balances {
                        prop_assert!(*b >= 0);
                    }
                    for (u, &bal) in balances.iter().enumerate() {
                        prop_assert_eq!(client.get_holder_balance(&bond_id, &users[u]), bal);
                    }
                }
            }

            #[test]
            fn holder_count_matches_list_len_across_operations(
                supply in 100i128..1_000_000i128,
                ops in proptest::collection::vec(
                    (any::<bool>(), 0usize..3, 0usize..3, 1i128..50_000i128),
                    0..50
                ),
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let users: std::vec::Vec<Address> =
                    (0..3).map(|_| Address::generate(&env)).collect();
                let contract_id = env.register(BondIssuer, (&admin,));
                let client = BondIssuerClient::new(&env, &contract_id);

                let mut config = make_config(&env);
                config.total_supply = supply;
                let bond_id = client.issue_bond(&admin, &config, &0);

                let mut balances = [0i128; 3];
                let mut total_subscribed = 0i128;
                let mut nonces = [0u64; 3];

                for (is_subscribe, a, b, amount) in ops {
                    if is_subscribe {
                        if amount <= supply - total_subscribed {
                            client.subscribe(&users[a], &bond_id, &amount, &nonces[a]);
                            balances[a] += amount;
                            total_subscribed += amount;
                            nonces[a] += 1;
                        } else {
                            let res = client.try_subscribe(&users[a], &bond_id, &amount, &nonces[a]);
                            prop_assert_eq!(res, Err(Ok(BondError::InsufficientSupply)));
                        }
                    } else {
                        let to = if a == b { (b + 1) % 3 } else { b };
                        if amount <= balances[a] {
                            client.transfer(&users[a], &users[to], &bond_id, &amount, &nonces[a]);
                            nonces[a] += 1;
                            balances[a] -= amount;
                            balances[to] += amount;
                        } else {
                            let res = client.try_transfer(&users[a], &users[to], &bond_id, &amount, &nonces[a]);
                            prop_assert_eq!(res, Err(Ok(BondError::InsufficientBalance)));
                        }
                    }

                    prop_assert_eq!(
                        client.get_holder_count(&bond_id),
                        client.get_holder_list(&bond_id).len() as u64
                    );
                }
            }

            // Subscription/maturity state machine: Active permits subscribe and
            // transfer, only the admin can mature and only at/after maturity_date,
            // and after Matured subscribe/transfer are locked while redeem burns
            // balances in lockstep with total_subscribed.
            #[test]
            fn maturity_state_machine(
                supply in 100i128..100_000i128,
                subscribe_amounts in proptest::collection::vec(1i128..10_000i128, 1..8),
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let users: std::vec::Vec<Address> =
                    (0..3).map(|_| Address::generate(&env)).collect();
                let contract_id = env.register(BondIssuer, (&admin,));
                let client = BondIssuerClient::new(&env, &contract_id);

                let mut config = make_config(&env);
                config.total_supply = supply;
                let bond_id = client.issue_bond(&admin, &config, &0);

                let mut balances = [0i128; 3];
                let mut total_subscribed = 0i128;
                let mut nonces = [0u64; 3];
                for (i, &amount) in subscribe_amounts.iter().enumerate() {
                    let u = i % 3;
                    let capped = amount.min(supply - total_subscribed);
                    if capped <= 0 {
                        break;
                    }
                    client.subscribe(&users[u], &bond_id, &capped, &nonces[u]);
                    nonces[u] += 1;
                    total_subscribed += capped;
                    balances[u] += capped;
                }

                let res = client.try_mature_bond(&admin, &bond_id, &1);
                prop_assert_eq!(res, Err(Ok(BondError::NotYetMature)));
                prop_assert_eq!(
                    client.get_bond_state(&bond_id).status,
                    BondStatus::Active
                );

                if total_subscribed < supply {
                    client.subscribe(&users[0], &bond_id, &1, &nonces[0]);
                    nonces[0] += 1;
                    total_subscribed += 1;
                    balances[0] += 1;
                }

                env.ledger().set_timestamp(config.maturity_date);
                client.mature_bond(&admin, &bond_id, &1);
                prop_assert_eq!(
                    client.get_bond_state(&bond_id).status,
                    BondStatus::Matured
                );

                let res = client.try_subscribe(&users[1], &bond_id, &1, &nonces[1]);
                prop_assert_eq!(res, Err(Ok(BondError::BondAlreadyMatured)));
                let res = client.try_transfer(&users[0], &users[1], &bond_id, &1, &nonces[0]);
                prop_assert_eq!(res, Err(Ok(BondError::BondAlreadyMatured)));
                let res = client.try_mature_bond(&admin, &bond_id, &2);
                prop_assert_eq!(res, Err(Ok(BondError::BondAlreadyMatured)));

                let amount = balances[0].min(supply);
                if amount > 0 {
                    client.redeem(&users[0], &bond_id, &amount, &nonces[0]);
                    nonces[0] += 1;
                    balances[0] -= amount;
                    total_subscribed -= amount;
                    prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);
                    prop_assert_eq!(
                        client.get_holder_balance(&bond_id, &users[0]),
                        balances[0]
                    );

                    let res = client.try_redeem(
                        &users[0],
                        &bond_id,
                        &(balances[0] + 1),
                        &nonces[0],
                    );
                    prop_assert_eq!(res, Err(Ok(BondError::InsufficientBalance)));
                }

                let sum: i128 = balances.iter().sum();
                prop_assert_eq!(sum, total_subscribed);
                prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);
            }
        }
    }
}
