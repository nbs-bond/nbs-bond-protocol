#![no_std]
#![allow(deprecated)]
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol, Vec};
use nbbs_shared::DEXError;

// Persistent-storage TTL constants (in ledgers).
// MIN_TTL  ≈  1 day   at 5-second ledger cadence (~17 280 ledgers).
// MAX_TTL  ≈ 120 days at 5-second ledger cadence (~2 073 600 ledgers).
const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND_TO: u32 = 2_073_600;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Order(u64),
    OrderCount,
    SellerOrders(Address),
    BondOrders(u64),
    BondIssuerAddress,
    CouponEngineAddress,
    Balance(Symbol, Address),
    Nonce(Address),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Order {
    pub id: u64,
    pub seller: Address,
    pub bond_id: u64,
    pub amount: i128,
    pub price_per_token: i128,
    pub quote_asset: Symbol,
    pub status: OrderStatus,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum OrderStatus {
    Open,
    PartiallyFilled,
    Filled,
    Cancelled,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum Side {
    Buy,
    Sell,
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), DEXError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(DEXError::NotInitialized)?;
    if caller != &admin {
        return Err(DEXError::Unauthorized);
    }
    Ok(())
}

/// Bump a persistent storage entry's TTL if it is below the threshold.
fn bump_persistent<K: soroban_sdk::TryIntoVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
    env.storage().persistent().extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
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

fn get_balance(env: &Env, addr: &Address, asset: &Symbol) -> i128 {
    let key = DataKey::Balance(asset.clone(), addr.clone());
    let val = env.storage().persistent().get(&key).unwrap_or(0);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    val
}

fn set_balance(env: &Env, addr: &Address, asset: &Symbol, amount: i128) {
    let key = DataKey::Balance(asset.clone(), addr.clone());
    env.storage().persistent().set(&key, &amount);
    bump_persistent(env, &key);
}

fn is_order_expired(env: &Env, order: &Order) -> bool {
    env.ledger().timestamp() >= order.expires_at
}

fn verify_holder_balance(
    env: &Env,
    holder: &Address,
    bond_id: u64,
    required: i128,
) -> Result<(), DEXError> {
    let bond_issuer: Address = env
        .storage()
        .instance()
        .get(&DataKey::BondIssuerAddress)
        .ok_or(DEXError::NotInitialized)?;

    let balance: i128 = env.invoke_contract(
        &bond_issuer,
        &Symbol::new(env, "get_holder_balance"),
        vec![
            &env,
            bond_id.into_val(env),
            holder.clone().into_val(env),
        ],
    );

    if balance < required {
        return Err(DEXError::InsufficientBalance);
    }
    Ok(())
}

#[contract]
pub struct DEXRouter;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl DEXRouter {
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

    #[allow(clippy::too_many_arguments)]
    pub fn list_bond_tokens(
        env: Env,
        seller: Address,
        bond_id: u64,
        amount: i128,
        price_per_token: i128,
        quote_asset: Symbol,
        expires_after_seconds: u64,
        nonce: u64,
    ) -> Result<u64, DEXError> {
        seller.require_auth();

        let expected_nonce = get_nonce(&env, &seller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &seller, expected_nonce + 1);

        if amount <= 0 || price_per_token <= 0 {
            return Err(DEXError::ZeroAmount);
        }
        if expires_after_seconds == 0 {
            return Err(DEXError::OrderExpired);
        }

        verify_holder_balance(&env, &seller, bond_id, amount)?;

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0);
        let order_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::OrderCount, &order_id);

        let now = env.ledger().timestamp();
        let expires_at = now
            .checked_add(expires_after_seconds)
            .ok_or(DEXError::OrderExpired)?;
        let order = Order {
            id: order_id,
            seller: seller.clone(),
            bond_id,
            amount,
            price_per_token,
            quote_asset,
            status: OrderStatus::Open,
            created_at: now,
            expires_at,
        };

        let order_key = DataKey::Order(order_id);
        env.storage().persistent().set(&order_key, &order);
        bump_persistent(&env, &order_key);

        let so_key = DataKey::SellerOrders(seller.clone());
        let mut seller_orders: Vec<u64> = env
            .storage()
            .persistent()
            .get(&so_key)
            .unwrap_or(vec![&env]);
        seller_orders.push_back(order_id);
        env.storage().persistent().set(&so_key, &seller_orders);
        bump_persistent(&env, &so_key);

        let bo_key = DataKey::BondOrders(bond_id);
        let mut bond_orders: Vec<u64> = env
            .storage()
            .persistent()
            .get(&bo_key)
            .unwrap_or(vec![&env]);
        bond_orders.push_back(order_id);
        env.storage().persistent().set(&bo_key, &bond_orders);
        bump_persistent(&env, &bo_key);

        env.events().publish(
            (Symbol::new(&env, "order_listed"),),
            (order_id, seller, bond_id, amount, price_per_token),
        );

        Ok(order_id)
    }

    pub fn cancel_listing(
        env: Env,
        caller: Address,
        order_id: u64,
        nonce: u64,
    ) -> Result<(), DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        let order_key = DataKey::Order(order_id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&order_key)
            .ok_or(DEXError::OrderNotFound)?;

        if caller != order.seller {
            return Err(DEXError::Unauthorized);
        }

        if order.status != OrderStatus::Open
            && order.status != OrderStatus::PartiallyFilled
        {
            return Err(DEXError::OrderAlreadyFilled);
        }

        order.status = OrderStatus::Cancelled;
        env.storage().persistent().set(&order_key, &order);
        bump_persistent(&env, &order_key);

        env.events().publish(
            (Symbol::new(&env, "order_cancelled"),),
            (order_id, caller),
        );

        Ok(())
    }

    pub fn execute_purchase(
        env: Env,
        buyer: Address,
        order_id: u64,
        max_price: i128,
        amount: i128,
        nonce: u64,
    ) -> Result<(), DEXError> {
        buyer.require_auth();

        let expected_nonce = get_nonce(&env, &buyer);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &buyer, expected_nonce + 1);

        let order_key = DataKey::Order(order_id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&order_key)
            .ok_or(DEXError::OrderNotFound)?;
        bump_persistent(&env, &order_key);

        if order.status != OrderStatus::Open
            && order.status != OrderStatus::PartiallyFilled
        {
            return Err(DEXError::OrderAlreadyFilled);
        }

        if buyer == order.seller {
            return Err(DEXError::SelfBuyNotAllowed);
        }

        if is_order_expired(&env, &order) {
            return Err(DEXError::OrderExpired);
        }

        if amount <= 0 {
            return Err(DEXError::ZeroAmount);
        }

        if amount > order.amount {
            return Err(DEXError::InsufficientBalance);
        }

        if max_price < order.price_per_token {
            return Err(DEXError::InsufficientBalance);
        }

        if verify_holder_balance(&env, &order.seller, order.bond_id, amount).is_err() {
            env.events().publish(
                (Symbol::new(&env, "purchase_failed"),),
                (
                    order_id,
                    buyer.clone(),
                    Symbol::new(&env, "seller_balance_depleted"),
                ),
            );
            return Err(DEXError::SellerBalanceDepleted);
        }

        let proceeds = amount
            .checked_mul(order.price_per_token)
            .ok_or(DEXError::Overflow)?;

        let buyer_balance = get_balance(&env, &buyer, &order.quote_asset);
        if buyer_balance < proceeds {
            return Err(DEXError::InsufficientFunds);
        }
        set_balance(&env, &buyer, &order.quote_asset, buyer_balance - proceeds);

        let seller_balance = get_balance(&env, &order.seller, &order.quote_asset);
        let new_seller_balance = seller_balance
            .checked_add(proceeds)
            .ok_or(DEXError::Overflow)?;
        set_balance(&env, &order.seller, &order.quote_asset, new_seller_balance);

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(DEXError::NotInitialized)?;

        env.invoke_contract::<()>(
            &bond_issuer,
            &Symbol::new(&env, "transfer"),
            vec![
                &env,
                order.seller.clone().into_val(&env),
                buyer.clone().into_val(&env),
                order.bond_id.into_val(&env),
                amount.into_val(&env),
            ],
        );

        if amount == order.amount {
            order.status = OrderStatus::Filled;
        } else {
            order.status = OrderStatus::PartiallyFilled;
            order.amount -= amount;
        }

        env.storage().persistent().set(&order_key, &order);
        bump_persistent(&env, &order_key);

        env.events().publish(
            (Symbol::new(&env, "order_filled"),),
            (
                order_id,
                buyer,
                order.seller.clone(),
                amount,
                order.price_per_token,
                proceeds,
            ),
        );

        Ok(())
    }

    pub fn deposit_quote(
        env: Env,
        caller: Address,
        quote_asset: Symbol,
        amount: i128,
        nonce: u64,
    ) -> Result<(), DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        if amount <= 0 {
            return Err(DEXError::ZeroAmount);
        }

        let balance = get_balance(&env, &caller, &quote_asset);
        let new_balance = balance.checked_add(amount).ok_or(DEXError::Overflow)?;
        set_balance(&env, &caller, &quote_asset, new_balance);

        env.events().publish(
            (Symbol::new(&env, "quote_deposited"),),
            (caller, quote_asset, amount),
        );

        Ok(())
    }

    pub fn withdraw_quote(
        env: Env,
        caller: Address,
        quote_asset: Symbol,
        amount: i128,
        nonce: u64,
    ) -> Result<(), DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        if amount <= 0 {
            return Err(DEXError::ZeroAmount);
        }

        let balance = get_balance(&env, &caller, &quote_asset);
        if balance < amount {
            return Err(DEXError::InsufficientFunds);
        }
        set_balance(&env, &caller, &quote_asset, balance - amount);

        env.events().publish(
            (Symbol::new(&env, "quote_withdrawn"),),
            (caller, quote_asset, amount),
        );

        Ok(())
    }

    pub fn get_quote_balance(env: Env, address: Address, quote_asset: Symbol) -> i128 {
        get_balance(&env, &address, &quote_asset)
    }

    pub fn get_order(env: Env, order_id: u64) -> Result<Order, DEXError> {
        let key = DataKey::Order(order_id);
        let val = env.storage().persistent().get(&key).ok_or(DEXError::OrderNotFound)?;
        bump_persistent(&env, &key);
        Ok(val)
    }

    pub fn get_bond_orders(env: Env, bond_id: u64) -> Vec<u64> {
        let key = DataKey::BondOrders(bond_id);
        let val: Vec<u64> = env.storage().persistent().get(&key).unwrap_or(vec![&env]);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn get_seller_orders(env: Env, seller: Address) -> Vec<u64> {
        let key = DataKey::SellerOrders(seller);
        let val: Vec<u64> = env.storage().persistent().get(&key).unwrap_or(vec![&env]);
        if env.storage().persistent().has(&key) {
            bump_persistent(&env, &key);
        }
        val
    }

    pub fn order_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0)
    }

    /// Quotes a market-sized fill without requiring the caller to fetch every
    /// order over RPC. The returned tuple is `(average_price, total,
    /// slippage_bps)`, where one basis point is 0.01%.
    pub fn get_best_price(
        env: Env,
        bond_id: u64,
        side: Side,
        amount: i128,
    ) -> Result<(i128, i128, i128), DEXError> {
        if amount <= 0 {
            return Err(DEXError::ZeroAmount);
        }

        let bond_orders_key = DataKey::BondOrders(bond_id);
        let order_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&bond_orders_key)
            .unwrap_or(vec![&env]);
        if env.storage().persistent().has(&bond_orders_key) {
            bump_persistent(&env, &bond_orders_key);
        }

        // Keep the quote deterministic for equal price levels by using order
        // id (time priority) as the secondary key.
        let mut sorted: Vec<Order> = Vec::new(&env);
        for order_id in order_ids.iter() {
            let key = DataKey::Order(order_id);
            let Some(order) = env.storage().persistent().get::<DataKey, Order>(&key) else {
                continue;
            };
            bump_persistent(&env, &key);

            if order.bond_id != bond_id
                || order.amount <= 0
                || (order.status != OrderStatus::Open
                    && order.status != OrderStatus::PartiallyFilled)
                || is_order_expired(&env, &order)
            {
                continue;
            }

            let mut position = 0;
            while position < sorted.len() {
                let current = sorted.get(position).unwrap();
                let precedes = match side {
                    Side::Buy => {
                        order.price_per_token < current.price_per_token
                            || (order.price_per_token == current.price_per_token
                                && order.id < current.id)
                    }
                    Side::Sell => {
                        order.price_per_token > current.price_per_token
                            || (order.price_per_token == current.price_per_token
                                && order.id < current.id)
                    }
                };
                if precedes {
                    break;
                }
                position += 1;
            }
            sorted.insert(position, order);
        }

        let Some(first) = sorted.first() else {
            return Ok((0, 0, 0));
        };
        let best_price = first.price_per_token;
        let mut remaining = amount;
        let mut filled = 0i128;
        let mut total = 0i128;

        for order in sorted.iter() {
            if remaining == 0 {
                break;
            }
            let take = remaining.min(order.amount);
            let cost = take
                .checked_mul(order.price_per_token)
                .ok_or(DEXError::Overflow)?;
            total = total.checked_add(cost).ok_or(DEXError::Overflow)?;
            filled = filled.checked_add(take).ok_or(DEXError::Overflow)?;
            remaining -= take;
        }

        if filled == 0 {
            return Ok((0, 0, 0));
        }

        let average_price = total / filled;
        let ideal_total = filled
            .checked_mul(best_price)
            .ok_or(DEXError::Overflow)?;
        let adverse_delta = match side {
            Side::Buy => total.saturating_sub(ideal_total),
            Side::Sell => ideal_total.saturating_sub(total),
        };
        let slippage_bps = if ideal_total > 0 {
            adverse_delta
                .checked_mul(10_000)
                .ok_or(DEXError::Overflow)?
                / ideal_total
        } else {
            0
        };

        Ok((average_price, total, slippage_bps))
    }

    pub fn clean_expired_orders(
        env: Env,
        caller: Address,
        nonce: u64,
    ) -> Result<u32, DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0);

        if count == 0 {
            return Ok(0);
        }

        Self::clean_expired_orders_range_impl(&env, 1, count)
    }

    pub fn clean_expired_orders_range(
        env: Env,
        caller: Address,
        nonce: u64,
        start_id: u64,
        end_id: u64,
    ) -> Result<u32, DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0);

        if start_id < 1 || end_id > count || start_id > end_id {
            return Err(DEXError::InvalidRange);
        }

        Self::clean_expired_orders_range_impl(&env, start_id, end_id)
    }

    fn clean_expired_orders_range_impl(
        env: &Env,
        start_id: u64,
        end_id: u64,
    ) -> Result<u32, DEXError> {
        let mut cleaned: u32 = 0;
        for id in start_id..=end_id {
            let key = DataKey::Order(id);
            if let Some(mut order) = env.storage().persistent().get::<DataKey, Order>(&key) {
                if (order.status == OrderStatus::Open
                    || order.status == OrderStatus::PartiallyFilled)
                    && is_order_expired(env, &order)
                {
                    order.status = OrderStatus::Expired;
                    env.storage().persistent().set(&key, &order);
                    bump_persistent(env, &key);
                    cleaned += 1;
                }
            }
        }

        env.events().publish(
            (Symbol::new(env, "expired_orders_cleaned"),),
            (cleaned,),
        );

        Ok(cleaned)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        vec, BytesN, Env, Symbol,
    };

    fn create_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn setup_bond_and_holder(
        env: &Env,
        bond_supply: i128,
        holder_subscribe: i128,
    ) -> (Address, Address, u64, Address) {
        let issuer_admin = Address::generate(env);
        let issuer_id = env.register(
            nbbs_bond_issuer::BondIssuer,
            (issuer_admin.clone(),),
        );
        let issuer_client =
            nbbs_bond_issuer::BondIssuerClient::new(env, &issuer_id);

        let project_id = create_project_id(env, 1);
        let bond_config = nbbs_shared::BondConfig {
            project_id,
            face_value: 1000,
            coupon_schedule: vec![env, 1_000_000u64, 2_000_000u64],
            credit_type: nbbs_shared::CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: bond_supply,
        };

        let bond_id = issuer_client.issue_bond(&issuer_admin, &bond_config, &0);

        let holder = Address::generate(env);
        issuer_client.subscribe(&holder, &bond_id, &holder_subscribe, &0);

        (issuer_admin, issuer_id, bond_id, holder)
    }

    #[test]
    fn test_list_tokens() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        assert_eq!(order_id, 1);

        let order = client.get_order(&order_id);
        assert_eq!(order.seller, seller);
        assert_eq!(order.bond_id, bond_id);
        assert_eq!(order.amount, 1_000);
        assert_eq!(order.price_per_token, 100);
        assert_eq!(order.status, OrderStatus::Open);

        let bond_orders = client.get_bond_orders(&bond_id);
        assert_eq!(bond_orders.len(), 1);
        assert_eq!(bond_orders.get(0).unwrap(), order_id);

        let seller_orders = client.get_seller_orders(&seller);
        assert_eq!(seller_orders.len(), 1);
        assert_eq!(seller_orders.get(0).unwrap(), order_id);

        assert_eq!(client.order_count(), 1);
    }

    #[test]
    fn test_get_best_price_quotes_multiple_levels_in_one_call() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        env.ledger().set_timestamp(1_000_000);

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);
        let contract_id = env.register(
            DEXRouter,
            (admin, issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);
        let quote_asset = Symbol::new(&env, "USDC");

        client.list_bond_tokens(
            &seller,
            &bond_id,
            &5i128,
            &20i128,
            &quote_asset,
            &3_600u64,
            &0,
        );
        client.list_bond_tokens(
            &seller,
            &bond_id,
            &5i128,
            &10i128,
            &quote_asset,
            &3_600u64,
            &1,
        );

        let (average_price, total, slippage_bps) =
            client.get_best_price(&bond_id, &Side::Buy, &10i128);

        assert_eq!(average_price, 15);
        assert_eq!(total, 150);
        assert_eq!(slippage_bps, 5_000);
    }

    #[test]
    fn test_get_best_price_handles_empty_and_rejects_zero_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let contract_id = env.register(
            DEXRouter,
            (admin, Address::generate(&env), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        assert_eq!(
            client.get_best_price(&99, &Side::Buy, &10),
            (0, 0, 0)
        );
        assert_eq!(
            client.try_get_best_price(&99, &Side::Buy, &0),
            Err(Ok(DEXError::ZeroAmount))
        );
    }

    #[test]
    fn test_buy_full_order() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        client.execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Filled);

        let issuer_client =
            nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 4_000);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 1_000);

        assert_eq!(client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")), 0);
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            100_000
        );
    }

    #[test]
    fn test_buy_partial_fill() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        client.execute_purchase(&buyer, &order_id, &100i128, &400i128, &1);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::PartiallyFilled);
        assert_eq!(order.amount, 600);

        let issuer_client =
            nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 4_600);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 400);

        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            60_000
        );
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            40_000
        );

        client.execute_purchase(&buyer, &order_id, &100i128, &600i128, &2);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Filled);

        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 4_000);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 1_000);

        assert_eq!(client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")), 0);
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            100_000
        );
    }

    #[test]
    fn test_buy_fails_when_seller_balance_depleted() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let third_party = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 1_000);

        let issuer_client =
            nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id.clone());

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        issuer_client.transfer(&seller, &third_party, &bond_id, &1_000);

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(result, Err(Ok(DEXError::SellerBalanceDepleted)));

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Open);
        assert_eq!(order.amount, 1_000);

        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 0);
        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            100_000
        );
        assert_eq!(client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")), 0);

        // The failed purchase is fully atomic: the buyer's nonce is rolled back
        // together with the escrow bookkeeping, so the same nonce can be reused
        // for the retry. Retrying with the *next* nonce instead fails with
        // InvalidNonce, because the contract still expects the untouched nonce.
        let retry_same_nonce =
            client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(retry_same_nonce, Err(Ok(DEXError::SellerBalanceDepleted)));
        let retry_next_nonce =
            client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &2);
        assert_eq!(retry_next_nonce, Err(Ok(DEXError::InvalidNonce)));
    }

    #[test]
    fn test_replenished_seller_fills_order_on_retry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let third_party = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 2_000);

        let issuer_client =
            nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id.clone());

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        // Sell enough to deplete below the listed amount before the buyer
        // attempts the purchase.
        issuer_client.transfer(&seller, &third_party, &bond_id, &1_500);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 500);

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(result, Err(Ok(DEXError::SellerBalanceDepleted)));

        // The seller replenishes their holdings before the buyer retries with
        // the same (rolled-back) nonce.
        issuer_client.transfer(&third_party, &seller, &bond_id, &500);

        client.execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Filled);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 0);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 1_000);
    }

    #[test]
    fn test_buy_failed_purchase_does_not_debit_buyer() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let issuer_client =
            nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id.clone());

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &50i128, &1_000i128, &0);
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));

        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 5_000);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 0);
    }

    #[test]
    fn test_buy_requires_escrow_funds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &50_000i128, &0);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(result, Err(Ok(DEXError::InsufficientFunds)));

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Open);
        assert_eq!(order.amount, 1_000);

        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            50_000
        );
        assert_eq!(client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")), 0);
    }

    #[test]
    fn test_deposit_and_withdraw_quote() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), Address::generate(&env), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        client.deposit_quote(&user, &Symbol::new(&env, "USDC"), &10_000i128, &0);
        client.deposit_quote(&user, &Symbol::new(&env, "XLM"), &5_000i128, &1);

        assert_eq!(
            client.get_quote_balance(&user, &Symbol::new(&env, "USDC")),
            10_000
        );
        assert_eq!(
            client.get_quote_balance(&user, &Symbol::new(&env, "XLM")),
            5_000
        );

        let result = client.try_withdraw_quote(&user, &Symbol::new(&env, "USDC"), &11_000i128, &2);
        assert_eq!(result, Err(Ok(DEXError::InsufficientFunds)));

        client.withdraw_quote(&user, &Symbol::new(&env, "USDC"), &4_000i128, &2);
        assert_eq!(
            client.get_quote_balance(&user, &Symbol::new(&env, "USDC")),
            6_000
        );
    }

    #[test]
    fn test_cancel_listing() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.cancel_listing(&seller, &order_id, &1);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Cancelled);
    }

    #[test]
    fn test_cancel_unauthorized() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_cancel_listing(&stranger, &order_id, &0);
        assert_eq!(result, Err(Ok(DEXError::Unauthorized)));
    }

    #[test]
    fn test_self_buy_reject() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&seller, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(result, Err(Ok(DEXError::SelfBuyNotAllowed)));
    }

    #[test]
    fn test_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 1_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let result = client.try_list_bond_tokens(
            &seller,
            &bond_id,
            &2_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));
    }

    #[test]
    fn test_expired_order() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );

        env.ledger().set_timestamp(1_000_101);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &500i128, &0);
        assert_eq!(result, Err(Ok(DEXError::OrderExpired)));
    }

    #[test]
    fn test_nonexistent_order() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), Address::generate(&env), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let result = client.try_get_order(&999);
        assert_eq!(result, Err(Ok(DEXError::OrderNotFound)));
    }

    #[test]
    fn test_clean_expired_orders() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );

        client.list_bond_tokens(
            &seller,
            &bond_id,
            &500i128,
            &200i128,
            &Symbol::new(&env, "XLM"),
            &10_000u64,
            &1,
        );

        env.ledger().set_timestamp(1_000_200);

        let cleaned = client.clean_expired_orders(&admin, &0);
        assert_eq!(cleaned, 1);

        let order1 = client.get_order(&order_id);
        assert_eq!(order1.status, OrderStatus::Expired);

        let result = client.try_execute_purchase(
            &Address::generate(&env),
            &order_id,
            &100i128,
            &100i128,
            &0,
        );
        assert_eq!(result, Err(Ok(DEXError::OrderAlreadyFilled)));
    }

    #[test]
    fn test_clean_expired_orders_range_basic() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        // order 1: expires in 100s (will be expired at t=1_000_200)
        let order1_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );
        // order 2: expires in 10_000s (not expired)
        let order2_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &500i128,
            &200i128,
            &Symbol::new(&env, "XLM"),
            &10_000u64,
            &1,
        );
        // order 3: expires in 100s (will be expired at t=1_000_200)
        let order3_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &300i128,
            &50i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &2,
        );

        env.ledger().set_timestamp(1_000_200);

        // Only clean orders 2..=3 — order 1 should remain open
        let cleaned = client.clean_expired_orders_range(&admin, &0, &2, &3);
        assert_eq!(cleaned, 1); // only order 3

        assert_eq!(client.get_order(&order1_id).status, OrderStatus::Open);
        assert_eq!(client.get_order(&order2_id).status, OrderStatus::Open);
        assert_eq!(client.get_order(&order3_id).status, OrderStatus::Expired);
    }

    #[test]
    fn test_clean_expired_orders_range_idempotent() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );

        env.ledger().set_timestamp(1_000_200);

        let cleaned1 = client.clean_expired_orders_range(&admin, &0, &1, &1);
        assert_eq!(cleaned1, 1);

        // Second call on same range — already expired, should clean 0
        let cleaned2 = client.clean_expired_orders_range(&admin, &1, &1, &1);
        assert_eq!(cleaned2, 0);
    }

    #[test]
    fn test_clean_expired_orders_range_invalid() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, _bond_id, _seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        // start_id < 1
        let r = client.try_clean_expired_orders_range(&admin, &0, &0, &5);
        assert_eq!(r, Err(Ok(DEXError::InvalidRange)));

        // end_id > order_count (count is 0)
        let r = client.try_clean_expired_orders_range(&admin, &0, &1, &5);
        assert_eq!(r, Err(Ok(DEXError::InvalidRange)));

        // start_id > end_id
        let r = client.try_clean_expired_orders_range(&admin, &0, &5, &3);
        assert_eq!(r, Err(Ok(DEXError::InvalidRange)));
    }

    #[test]
    fn test_clean_expired_orders_range_gaps() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        // Create 3 orders
        let order1 = client.list_bond_tokens(
            &seller, &bond_id, &1_000i128, &100i128,
            &Symbol::new(&env, "USDC"), &100u64, &0,
        );
        client.list_bond_tokens(
            &seller, &bond_id, &500i128, &200i128,
            &Symbol::new(&env, "XLM"), &10_000u64, &1,
        );
        let order3 = client.list_bond_tokens(
            &seller, &bond_id, &300i128, &50i128,
            &Symbol::new(&env, "USDC"), &100u64, &2,
        );

        // Cancel order 2 to create a gap
        client.cancel_listing(&seller, &2, &3);

        env.ledger().set_timestamp(1_000_200);

        // Sweep range 1..=3 — order 2 is Cancelled so skipped gracefully
        let cleaned = client.clean_expired_orders_range(&admin, &0, &1, &3);
        assert_eq!(cleaned, 2); // orders 1 and 3 are expired and open

        assert_eq!(client.get_order(&order1).status, OrderStatus::Expired);
        assert_eq!(client.get_order(&order3).status, OrderStatus::Expired);
    }

    #[test]
    fn test_buy_more_than_listed() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &2_000i128, &0);
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));
    }

    #[test]
    fn test_buy_with_low_max_price() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &50i128, &500i128, &0);
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));
    }

    #[test]
    fn test_purchase_zero_amount_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &0i128, &0);
        assert_eq!(result, Err(Ok(DEXError::ZeroAmount)));

        let order = client.get_order(&order_id);
        assert_eq!(order.amount, 1_000);
        assert_eq!(order.status, OrderStatus::Open);
    }

    #[test]
    fn test_list_zero_amount_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let result = client.try_list_bond_tokens(
            &seller,
            &bond_id,
            &0i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        assert_eq!(result, Err(Ok(DEXError::ZeroAmount)));
    }

    #[test]
    fn test_order_expired_at_expiry_timestamp() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );

        env.ledger().set_timestamp(1_000_100);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &500i128, &0);
        assert_eq!(result, Err(Ok(DEXError::OrderExpired)));
    }

    mod property {
        extern crate std;

        use super::*;
        use proptest::prelude::*;

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 128,
                ..ProptestConfig::default()
            })]

            // Amount * price is exact: the contract never truncates proceeds.
            #[test]
            fn proceeds_is_exact_product(
                amount in 1i128..1_000_000i128,
                price in 1i128..1_000_000_000i128,
            ) {
                let proceeds = amount.checked_mul(price).expect("in-range product");
                prop_assert_eq!(proceeds, amount * price);
                prop_assert!(proceeds >= amount && proceeds >= price);
            }

            // The overflow guard in execute_purchase is equivalent to i128 checked
            // multiplication at the boundary: amount * price overflows iff
            // amount > i128::MAX / price.
            #[test]
            fn overflow_matches_checked_math(
                amount in 1i128..i128::MAX,
                price in 1i128..i128::MAX,
            ) {
                let overflows = amount.checked_mul(price).is_none();
                if overflows {
                    prop_assert!(amount > i128::MAX / price);
                } else {
                    prop_assert!(amount <= i128::MAX / price);
                }
            }

            // Failed purchases (overflow or insufficient escrow) must never mutate
            // the order or any quote balance.
            #[test]
            fn failed_purchase_is_atomic(price in 1i128..i128::MAX) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();

                let admin = Address::generate(&env);
                let buyer = Address::generate(&env);
                let order_amount = 1_000i128;
                let (_issuer_admin, issuer_id, bond_id, seller) =
                    setup_bond_and_holder(&env, 1_000_000, order_amount);

                let contract_id = env.register(
                    DEXRouter,
                    (admin.clone(), issuer_id, Address::generate(&env)),
                );
                let client = DEXRouterClient::new(&env, &contract_id);
                let quote = Symbol::new(&env, "USDC");

                let order_id = client.list_bond_tokens(
                    &seller,
                    &bond_id,
                    &order_amount,
                    &price,
                    &quote,
                    &3600u64,
                    &0,
                );

                let overflows = order_amount.checked_mul(price).is_none();
                let res = client.try_execute_purchase(&buyer, &order_id, &price, &order_amount, &0);
                if overflows {
                    prop_assert_eq!(res, Err(Ok(DEXError::Overflow)));
                } else {
                    prop_assert_eq!(res, Err(Ok(DEXError::InsufficientFunds)));
                }

                let order = client.get_order(&order_id);
                prop_assert_eq!(order.status, OrderStatus::Open);
                prop_assert_eq!(order.amount, order_amount);
                prop_assert_eq!(client.get_quote_balance(&buyer, &quote), 0);
                prop_assert_eq!(client.get_quote_balance(&seller, &quote), 0);
            }

            // A fill never reduces an order below its remaining amount, completes
            // via PartiallyFilled -> Filled, and conserves both the quote ledger
            // and the bond supply.
            #[test]
            fn settlement_conserves_balances(
                order_amount in 1i128..50_000i128,
                price in 1i128..100_000i128,
                fill in 1i128..50_000i128,
            ) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();

                let admin = Address::generate(&env);
                let buyer = Address::generate(&env);
                let (_issuer_admin, issuer_id, bond_id, seller) =
                    setup_bond_and_holder(&env, 1_000_000, order_amount);

                let contract_id = env.register(
                    DEXRouter,
                    (admin.clone(), issuer_id.clone(), Address::generate(&env)),
                );
                let client = DEXRouterClient::new(&env, &contract_id);
                let issuer_client =
                    nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
                let quote = Symbol::new(&env, "USDC");

                let order_id = client.list_bond_tokens(
                    &seller,
                    &bond_id,
                    &order_amount,
                    &price,
                    &quote,
                    &3600u64,
                    &0,
                );

                let first = fill.min(order_amount);
                let deposit = first * price + (order_amount - first) * price;
                client.deposit_quote(&buyer, &quote, &deposit, &0);

                client.execute_purchase(&buyer, &order_id, &price, &first, &1);
                if first < order_amount {
                    let order = client.get_order(&order_id);
                    prop_assert_eq!(order.status, OrderStatus::PartiallyFilled);
                    prop_assert_eq!(order.amount, order_amount - first);

                    let rest = order_amount - first;
                    client.execute_purchase(&buyer, &order_id, &price, &rest, &2);
                }

                let order = client.get_order(&order_id);
                prop_assert_eq!(order.status, OrderStatus::Filled);
                let final_remaining = if first == order_amount {
                    order_amount
                } else {
                    order_amount - first
                };
                prop_assert_eq!(order.amount, final_remaining);

                prop_assert_eq!(client.get_quote_balance(&buyer, &quote), 0);
                prop_assert_eq!(
                    client.get_quote_balance(&seller, &quote),
                    order_amount * price
                );

                let seller_bond = issuer_client.get_holder_balance(&bond_id, &seller);
                let buyer_bond = issuer_client.get_holder_balance(&bond_id, &buyer);
                prop_assert_eq!(seller_bond, 0);
                prop_assert_eq!(buyer_bond, order_amount);
                prop_assert_eq!(seller_bond + buyer_bond, order_amount);
            }

            // The quote ledger tracks a non-negative running balance through an
            // arbitrary interleaving of deposits and withdrawals.
            #[test]
            fn quote_ledger_never_negative(
                deposits in proptest::collection::vec(1i128..100_000i128, 1..20),
                withdrawals in proptest::collection::vec(1i128..100_000i128, 1..20),
            ) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();

                let admin = Address::generate(&env);
                let user = Address::generate(&env);
                let contract_id = env.register(
                    DEXRouter,
                    (admin.clone(), Address::generate(&env), Address::generate(&env)),
                );
                let client = DEXRouterClient::new(&env, &contract_id);
                let quote = Symbol::new(&env, "USDC");

                let mut balance = 0i128;
                let mut nonce = 0u64;
                for d in deposits {
                    client.deposit_quote(&user, &quote, &d, &nonce);
                    nonce += 1;
                    balance += d;
                    prop_assert_eq!(client.get_quote_balance(&user, &quote), balance);
                }
                for w in withdrawals {
                    if w <= balance {
                        client.withdraw_quote(&user, &quote, &w, &nonce);
                        balance -= w;
                        nonce += 1;
                    } else {
                        let res = client.try_withdraw_quote(&user, &quote, &w, &nonce);
                        prop_assert_eq!(res, Err(Ok(DEXError::InsufficientFunds)));
                    }
                    prop_assert_eq!(client.get_quote_balance(&user, &quote), balance);
                }
            }
        }
    }

    // ── TTL / persistent-storage stress tests ────────────────────────────────

    /// Create 200 orders for the same seller and verify `get_seller_orders`
    /// returns the complete set.  This exercises the persistent `SellerOrders`
    /// index across many appends and confirms the contract does not hit an
    /// instance-storage size cap.
    #[test]
    fn test_seller_orders_200_stress() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let order_count: u64 = 200;
        // Bond supply must cover all listings.
        let supply: i128 = order_count as i128 * 10;
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, supply, supply);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        for i in 0..order_count {
            client.list_bond_tokens(
                &seller,
                &bond_id,
                &10i128,
                &1i128,
                &Symbol::new(&env, "USDC"),
                &3_600_000u64, // long expiry so none expire during the loop
                &i,
            );
        }

        assert_eq!(client.order_count(), order_count);

        let seller_orders = client.get_seller_orders(&seller);
        assert_eq!(
            seller_orders.len() as u64,
            order_count,
            "expected {order_count} seller orders, got {}",
            seller_orders.len()
        );

        // Spot-check first and last.
        assert_eq!(seller_orders.get(0).unwrap(), 1u64);
        assert_eq!(seller_orders.get((order_count - 1) as u32).unwrap(), order_count);

        // Every order must be individually retrievable and belong to this bond.
        let bond_orders = client.get_bond_orders(&bond_id);
        assert_eq!(bond_orders.len() as u64, order_count);
        for id in 1..=order_count {
            let o = client.get_order(&id);
            assert_eq!(o.seller, seller);
            assert_eq!(o.bond_id, bond_id);
            assert_eq!(o.status, OrderStatus::Open);
        }
    }
}
