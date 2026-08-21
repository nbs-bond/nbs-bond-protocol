#![no_std]
#![allow(deprecated)]
use nbbs_shared::{GovernanceError, VoteChoice};
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, Env, Symbol, TryFromVal, Val, Vec,
};

pub const DEFAULT_TIMELOCK_SECONDS: u64 = 172_800;
pub const DEFAULT_PROPOSAL_TTL_SECONDS: u64 = 2_592_000;

/// TTL bump parameters for persistent-storage entries, matching the
/// convention used by the other contracts in the workspace.
const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND_TO: u32 = 2_073_600;

/// `StorageVersion` value once `migrate_storage` has copied any legacy
/// instance-stored proposals/counter into persistent storage (issue #103).
const STORAGE_VERSION_PERSISTENT: u32 = 1;

/// Upper bound on the number of `(contract, method)` pairs the allowlist may
/// hold. `execute` scans the list linearly on every call, so an unbounded list
/// set by a single proposal could push later executions past the ledger's
/// read/CPU budget and permanently brick governance. 64 entries is far beyond
/// the protocol's real surface (seven contracts, a handful of admin methods
/// each) while keeping the scan trivially cheap.
pub const MAX_ALLOWED_CALLS: u32 = 64;

/// The only method on the governance contract itself that a proposal may
/// target. Soroban forbids contract re-entry, so a self-targeted proposal can
/// never be routed through `env.invoke_contract`; `execute` dispatches it
/// internally instead. See [`Governance::set_allowed_calls`].
const SELF_METHOD_SET_ALLOWED_CALLS: &str = "set_allowed_calls";

/// A single `(contract, method)` pair that governance is permitted to invoke.
///
/// The allowlist is pair-wise, not per-contract or per-method: allowing
/// `set_admin` on the oracle does not allow `set_admin` on the bond issuer,
/// and allowing `approve_project` on the registry does not allow `transfer`
/// on it.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct AllowedCall {
    pub contract: Address,
    pub function: Symbol,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Signers,
    Threshold,
    TimelockSeconds,
    Proposal(u64),
    ProposalCount,
    Vote(u64, Address),
    Nonce(Address),
    /// The execution allowlist: a deduplicated `Vec<AllowedCall>`. Held in
    /// **persistent** storage rather than instance storage — the allowlist is
    /// the contract's security boundary and must outlive any instance-storage
    /// archival of the rest of the governance state.
    AllowedCalls,
    /// Storage migration marker (issue #103). Lives in instance storage since
    /// it's a single small flag, not something that grows. Absent (or `0`)
    /// means some Proposal/ProposalCount entries may still be sitting in
    /// legacy instance storage; `STORAGE_VERSION_PERSISTENT` means
    /// `migrate_storage` has already copied over everything it could find.
    /// Reads of Proposal/ProposalCount/Vote/Nonce fall back to instance
    /// storage regardless of this flag, so no data is ever lost even if
    /// `migrate_storage` is never called — the flag just lets `migrate_storage`
    /// itself skip redundant work.
    StorageVersion,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ProposalStatus {
    Pending,
    Queued,
    Executed,
    Rejected,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub target: Address,
    pub method: Symbol,
    pub args: Vec<Val>,
    pub description: Symbol,
    pub status: ProposalStatus,
    pub approval_count: u32,
    pub veto_count: u32,
    pub created_at: u64,
    pub expires_at: u64,
    pub queued_at: u64,
    pub executed_at: u64,
    pub timelock_seconds: u64,
}

fn storage_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::StorageVersion)
        .unwrap_or(0)
}

/// Nonces (issue #103): always read/written through persistent storage now,
/// with a fallback read to instance storage for any nonce recorded before
/// this fix shipped. Nonces are keyed by address, so — unlike proposals —
/// they can't be enumerated and bulk-copied by `migrate_storage`; the
/// fallback read is what keeps a signer's pre-migration nonce honoured
/// instead of silently resetting to 0, which would let a stale signed
/// request replay.
fn get_nonce(env: &Env, addr: &Address) -> u64 {
    let key = DataKey::Nonce(addr.clone());
    if let Some(nonce) = env.storage().persistent().get(&key) {
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
        return nonce;
    }
    env.storage().instance().get(&key).unwrap_or(0)
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    let key = DataKey::Nonce(addr.clone());
    env.storage().persistent().set(&key, &nonce);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

fn check_nonce(env: &Env, addr: &Address, nonce: u64) -> Result<(), GovernanceError> {
    if nonce != get_nonce(env, addr) {
        return Err(GovernanceError::InvalidNonce);
    }
    set_nonce(env, addr, nonce + 1);
    Ok(())
}

fn require_signer(env: &Env, caller: &Address) -> Result<(), GovernanceError> {
    let signers: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Signers)
        .ok_or(GovernanceError::NotInitialized)?;
    if !signers.contains(caller.clone()) {
        return Err(GovernanceError::NotSigner);
    }
    Ok(())
}

fn is_expired(env: &Env, proposal: &Proposal) -> bool {
    env.ledger().timestamp() >= proposal.expires_at
}

/// Proposals, the proposal counter, and votes (issue #103): all three now
/// live in persistent storage, since instance storage has a hard 100KB cap
/// and a governance contract with a few hundred proposals would hit it and
/// become permanently unusable — no new proposals, no votes, no execution.
/// Reads fall back to instance storage so anything created before this fix
/// stays readable; `migrate_storage` additionally bulk-copies proposals and
/// the counter forward since those are enumerable by id.
fn read_proposal(env: &Env, proposal_id: u64) -> Option<Proposal> {
    let key = DataKey::Proposal(proposal_id);
    if let Some(proposal) = env.storage().persistent().get(&key) {
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
        return Some(proposal);
    }
    env.storage().instance().get(&key)
}

fn write_proposal(env: &Env, proposal_id: u64, proposal: &Proposal) {
    let key = DataKey::Proposal(proposal_id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

fn read_proposal_count(env: &Env) -> u64 {
    if let Some(count) = env.storage().persistent().get(&DataKey::ProposalCount) {
        return count;
    }
    env.storage()
        .instance()
        .get(&DataKey::ProposalCount)
        .unwrap_or(0)
}

fn write_proposal_count(env: &Env, count: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::ProposalCount, &count);
    env.storage().persistent().extend_ttl(
        &DataKey::ProposalCount,
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND_TO,
    );
}

fn read_vote(env: &Env, proposal_id: u64, voter: &Address) -> Option<VoteChoice> {
    let key = DataKey::Vote(proposal_id, voter.clone());
    if let Some(choice) = env.storage().persistent().get(&key) {
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
        return Some(choice);
    }
    env.storage().instance().get(&key)
}

fn write_vote(env: &Env, proposal_id: u64, voter: &Address, choice: &VoteChoice) {
    let key = DataKey::Vote(proposal_id, voter.clone());
    env.storage().persistent().set(&key, choice);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

/// Bump the persistent allowlist entry's TTL so the security boundary cannot
/// be archived out from under the contract.
fn bump_allowed_calls_ttl(env: &Env) {
    env.storage().persistent().extend_ttl(
        &DataKey::AllowedCalls,
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND_TO,
    );
}

/// Read the execution allowlist. A contract deployed with an empty allowlist
/// reads back an empty list, which denies every cross-contract call — deny by
/// default, never allow by default.
fn read_allowed_calls(env: &Env) -> Vec<AllowedCall> {
    if env.storage().persistent().has(&DataKey::AllowedCalls) {
        bump_allowed_calls_ttl(env);
        env.storage()
            .persistent()
            .get(&DataKey::AllowedCalls)
            .unwrap_or_else(|| vec![env])
    } else {
        vec![env]
    }
}

/// Validate, deduplicate and persist an allowlist.
///
/// Elements are decoded with `try_get` rather than `get` so that a malformed
/// argument list from a self-administration proposal surfaces as
/// `InvalidCallArgs` instead of panicking here — or, worse, being stored and
/// panicking on every subsequent read.
fn write_allowed_calls(env: &Env, calls: &Vec<AllowedCall>) -> Result<u32, GovernanceError> {
    if calls.len() > MAX_ALLOWED_CALLS {
        return Err(GovernanceError::InvalidCallArgs);
    }

    let mut deduped: Vec<AllowedCall> = vec![env];
    for i in 0..calls.len() {
        let call = calls
            .try_get(i)
            .map_err(|_| GovernanceError::InvalidCallArgs)?
            .ok_or(GovernanceError::InvalidCallArgs)?;
        if !contains_call(&deduped, &call.contract, &call.function) {
            deduped.push_back(call);
        }
    }

    env.storage()
        .persistent()
        .set(&DataKey::AllowedCalls, &deduped);
    bump_allowed_calls_ttl(env);
    Ok(deduped.len())
}

/// Linear scan for a `(contract, method)` pair. The list is capped at
/// [`MAX_ALLOWED_CALLS`], so this stays cheap.
fn contains_call(calls: &Vec<AllowedCall>, contract: &Address, function: &Symbol) -> bool {
    for call in calls.iter() {
        if &call.contract == contract && &call.function == function {
            return true;
        }
    }
    false
}

/// Apply a `set_allowed_calls` request.
///
/// Shared by the public [`Governance::set_allowed_calls`] entrypoint and by
/// `execute`'s internal self-call dispatch, so both paths enforce exactly the
/// same caller check, nonce check and validation.
fn apply_set_allowed_calls(
    env: &Env,
    caller: &Address,
    calls: &Vec<AllowedCall>,
    nonce: u64,
) -> Result<(), GovernanceError> {
    // The allowlist is reconfigurable only by the governance contract acting on
    // its own behalf — i.e. only as the outcome of a proposal that cleared the
    // full M-of-N vote and the timelock.
    if caller != &env.current_contract_address() {
        return Err(GovernanceError::Unauthorized);
    }
    check_nonce(env, caller, nonce)?;
    // The stored count, not the submitted one — the two differ when the
    // proposal listed a pair twice.
    let stored = write_allowed_calls(env, calls)?;

    env.events().publish(
        (Symbol::new(env, "allowed_calls_set"),),
        (stored, caller.clone()),
    );
    Ok(())
}

/// Execute a proposal that targets the governance contract itself.
///
/// Soroban forbids contract re-entry, so `env.invoke_contract` can never be
/// used to reach the governance contract's own entrypoints. Self-administration
/// proposals are therefore dispatched here instead, decoding `proposal.args`
/// using the same argument convention every other proposal follows:
/// `[caller: Address, .., nonce: u64]`.
///
/// Only the methods enumerated here are reachable; every other method symbol is
/// rejected with `UnauthorizedCall`. This hard-coded set is what makes the
/// allowlist bootstrappable without ever leaving the contract open by default.
fn dispatch_self_call(env: &Env, method: &Symbol, args: &Vec<Val>) -> Result<(), GovernanceError> {
    if method != &Symbol::new(env, SELF_METHOD_SET_ALLOWED_CALLS) {
        return Err(GovernanceError::UnauthorizedCall);
    }

    // set_allowed_calls(caller: Address, calls: Vec<AllowedCall>, nonce: u64)
    if args.len() != 3 {
        return Err(GovernanceError::InvalidCallArgs);
    }
    let caller = Address::try_from_val(env, &args.get_unchecked(0))
        .map_err(|_| GovernanceError::InvalidCallArgs)?;
    let calls = Vec::<AllowedCall>::try_from_val(env, &args.get_unchecked(1))
        .map_err(|_| GovernanceError::InvalidCallArgs)?;
    let nonce = u64::try_from_val(env, &args.get_unchecked(2))
        .map_err(|_| GovernanceError::InvalidCallArgs)?;

    apply_set_allowed_calls(env, &caller, &calls, nonce)
}

#[contract]
pub struct Governance;

#[contractimpl]
impl Governance {
    /// # Breaking change
    ///
    /// The constructor now takes a fifth argument, `allowed_calls`, seeding the
    /// execution allowlist at deploy time. Deployment tooling must be updated.
    ///
    /// Passing an empty list is legal and safe: the contract simply cannot
    /// execute any cross-contract proposal until a `set_allowed_calls` proposal
    /// clears the vote and the timelock. That is the expected path whenever the
    /// governance address must exist before the contracts it administers (the
    /// registry, issuer and oracle all take the governance address as their
    /// admin at construction, so their addresses cannot be known here).
    pub fn __constructor(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
        timelock_seconds: u64,
        allowed_calls: Vec<AllowedCall>,
    ) {
        assert!(!signers.is_empty(), "signers must not be empty");
        assert!(
            threshold > 0 && threshold <= signers.len(),
            "threshold must be between 1 and signer count"
        );
        for i in 0..signers.len() {
            for j in (i + 1)..signers.len() {
                assert!(
                    signers.get(i).unwrap() != signers.get(j).unwrap(),
                    "duplicate signer"
                );
            }
        }
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::TimelockSeconds, &timelock_seconds);
        assert!(
            write_allowed_calls(&env, &allowed_calls).is_ok(),
            "invalid allowed_calls"
        );
    }

    pub fn propose(
        env: Env,
        caller: Address,
        target: Address,
        method: Symbol,
        args: Vec<Val>,
        description: Symbol,
        nonce: u64,
    ) -> Result<u64, GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        let count: u64 = read_proposal_count(&env);
        let proposal_id = count + 1;
        write_proposal_count(&env, proposal_id);

        let timelock_seconds: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TimelockSeconds)
            .unwrap_or(DEFAULT_TIMELOCK_SECONDS);

        let proposal = Proposal {
            id: proposal_id,
            proposer: caller.clone(),
            target: target.clone(),
            method,
            args,
            description,
            status: ProposalStatus::Pending,
            approval_count: 0,
            veto_count: 0,
            created_at: env.ledger().timestamp(),
            expires_at: env
                .ledger()
                .timestamp()
                .saturating_add(DEFAULT_PROPOSAL_TTL_SECONDS),
            queued_at: 0,
            executed_at: 0,
            timelock_seconds,
        };
        write_proposal(&env, proposal_id, &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_created"),),
            (proposal_id, target, caller),
        );

        Ok(proposal_id)
    }

    pub fn vote_approve(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        let mut proposal: Proposal =
            read_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        // issue #191: a proposal whose expires_at has passed must stop
        // accruing votes, even though its status is still nominally Pending
        // — Soroban's revert-on-error semantics mean this call can't persist
        // an Expired status transition (any write here would be rolled back
        // along with the Err return), so this check is what actually closes
        // the gap: rejecting the vote is what keeps an expired proposal from
        // ever reaching Queued, since that's the only path there.
        if is_expired(&env, &proposal) {
            return Err(GovernanceError::ProposalExpired);
        }

        // Guard checks presence of ANY prior choice, not a specific value —
        // this is what fixes the veto-bypass bug (#121): a stored `Veto` is
        // just as "already voted" as a stored `Approve`.
        if read_vote(&env, proposal_id, &caller).is_some() {
            return Err(GovernanceError::AlreadyVoted);
        }
        write_vote(&env, proposal_id, &caller, &VoteChoice::Approve);

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1);

        proposal.approval_count += 1;
        if proposal.approval_count >= threshold {
            proposal.status = ProposalStatus::Queued;
            proposal.queued_at = env.ledger().timestamp();
        }
        write_proposal(&env, proposal_id, &proposal);

        env.events().publish(
            (Symbol::new(&env, "vote_cast"),),
            (proposal_id, caller, proposal.status),
        );

        Ok(())
    }

    pub fn vote_veto(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        let mut proposal: Proposal =
            read_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        // issue #191: same expiry gate as vote_approve — a veto on an
        // expired proposal must revert rather than accrue.
        if is_expired(&env, &proposal) {
            return Err(GovernanceError::ProposalExpired);
        }

        // Same presence check as vote_approve — this is the line that was
        // broken before: reading with `.unwrap_or(false)` against a key that
        // this function itself writes `false` into meant a veto vote could
        // never trip its own "already voted" guard.
        if read_vote(&env, proposal_id, &caller).is_some() {
            return Err(GovernanceError::AlreadyVoted);
        }
        write_vote(&env, proposal_id, &caller, &VoteChoice::Veto);

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1);

        proposal.veto_count += 1;
        if proposal.veto_count >= threshold {
            proposal.status = ProposalStatus::Rejected;
        }
        write_proposal(&env, proposal_id, &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_rejected"),),
            (proposal_id, caller),
        );

        Ok(())
    }

    pub fn cancel(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        let mut proposal: Proposal =
            read_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        proposal.status = ProposalStatus::Cancelled;
        write_proposal(&env, proposal_id, &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_cancelled"),),
            (proposal_id, caller),
        );

        Ok(())
    }

    pub fn execute(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;

        let mut proposal: Proposal =
            read_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Queued {
            return Err(GovernanceError::NotQueued);
        }

        // Proposals carry a per-proposal expiry (frozen at creation). Once the
        // ledger timestamp passes expires_at the proposal can never be executed,
        // blocking governance replay of stale proposals. Soroban reverts all
        // storage on error, so the terminal state is expressed via the
        // ProposalStatus::Expired variant rather than a persisted transition.
        if is_expired(&env, &proposal) {
            return Err(GovernanceError::ProposalExpired);
        }

        let now = env.ledger().timestamp();
        if now < proposal.queued_at.saturating_add(proposal.timelock_seconds) {
            return Err(GovernanceError::TimelockNotElapsed);
        }

        // ── Execution allowlist (issue #146) ────────────────────────────────
        // Everything above this point only proves that the multi-sig agreed and
        // waited. It says nothing about *what* was agreed to, and the argument
        // list below is passed verbatim to an arbitrary contract. Without the
        // check that follows, a single proposer could queue a call to any
        // method on any contract the governance address administers — a token
        // `transfer`, another contract's `set_admin`, an `upgrade` — and the
        // timelock would only delay it, never stop it.
        //
        // The (target, method) pair must therefore appear in the on-chain
        // allowlist, and the check happens *before* the dispatch, so a rejected
        // proposal never reaches the target at all.
        if proposal.target == env.current_contract_address() {
            // Self-administration. Soroban forbids re-entry, so this cannot go
            // through invoke_contract; dispatch_self_call handles it internally
            // and only recognises the governance contract's own config methods.
            dispatch_self_call(&env, &proposal.method, &proposal.args)?;
        } else {
            if !contains_call(
                &read_allowed_calls(&env),
                &proposal.target,
                &proposal.method,
            ) {
                return Err(GovernanceError::UnauthorizedCall);
            }

            // Pass proposal.args verbatim. The proposer is responsible for
            // encoding the complete argument list — including the governance
            // contract address as the caller at position 0 and the correct nonce
            // for the governance address on the target contract at the last
            // position. This guarantees the target receives exactly the arguments
            // it expects, regardless of the target's function signature.
            env.invoke_contract::<Val>(&proposal.target, &proposal.method, proposal.args.clone());
        }

        proposal.status = ProposalStatus::Executed;
        proposal.executed_at = now;
        write_proposal(&env, proposal_id, &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_executed"),),
            (proposal_id, proposal.target.clone()),
        );

        Ok(())
    }

    /// Replace the execution allowlist with `calls`.
    ///
    /// `caller` must be the governance contract's own address, which no
    /// external party can authorize: the contract has no `__check_auth`, so the
    /// only way to satisfy `require_auth` here is from inside the contract's own
    /// call frame. In practice this entrypoint is reached exclusively through
    /// [`Governance::execute`], which dispatches self-targeted proposals to the
    /// same implementation internally (Soroban forbids re-entry, so it cannot
    /// call this function through the host).
    ///
    /// It is declared as a contract function anyway so that the method symbol a
    /// proposal must carry, and the argument list it must encode, are part of
    /// the published contract spec and can be built by off-chain tooling:
    ///
    /// ```text
    /// target = <the governance contract's own address>
    /// method = "set_allowed_calls"
    /// args   = [governance_address, Vec<AllowedCall>, governance_nonce]
    /// ```
    ///
    /// The list is deduplicated on write and capped at [`MAX_ALLOWED_CALLS`].
    /// This is a full replacement, not a merge — a proposal that adds one pair
    /// must re-state the pairs it wants to keep, which makes the complete
    /// post-execution permission set reviewable in the proposal itself.
    pub fn set_allowed_calls(
        env: Env,
        caller: Address,
        calls: Vec<AllowedCall>,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        apply_set_allowed_calls(&env, &caller, &calls, nonce)
    }

    /// The current execution allowlist, for dashboards and proposal review.
    pub fn get_allowed_calls(env: Env) -> Vec<AllowedCall> {
        read_allowed_calls(&env)
    }

    /// Whether `execute` would currently permit invoking `function` on
    /// `contract`. Lets a proposer check a call before spending a vote cycle on
    /// a proposal that would be rejected at execution.
    pub fn is_call_allowed(env: Env, contract: Address, function: Symbol) -> bool {
        contains_call(&read_allowed_calls(&env), &contract, &function)
    }

    /// Copy any proposals and the proposal counter still sitting in legacy
    /// instance storage into persistent storage (issue #103), and mark the
    /// migration done. Idempotent — safe to call more than once, and safe to
    /// call on a contract that has no legacy data at all (returns `Ok(0)`).
    ///
    /// Votes and nonces don't get an explicit copy step: they're keyed by
    /// address, so there's no way to enumerate and bulk-copy them the way
    /// proposals (keyed by sequential id) can be. `get_vote`/`get_nonce` (and
    /// every internal read) already fall back to instance storage for any
    /// pre-migration entry, so nothing is lost — this function just moves the
    /// enumerable part forward proactively.
    ///
    /// Returns the number of proposals copied.
    pub fn migrate_storage(env: Env, caller: Address) -> Result<u64, GovernanceError> {
        caller.require_auth();
        require_signer(&env, &caller)?;

        if storage_version(&env) >= STORAGE_VERSION_PERSISTENT {
            return Ok(0);
        }

        let mut migrated: u64 = 0;
        if let Some(count) = env
            .storage()
            .instance()
            .get::<_, u64>(&DataKey::ProposalCount)
        {
            if env
                .storage()
                .persistent()
                .get::<_, u64>(&DataKey::ProposalCount)
                .is_none()
            {
                write_proposal_count(&env, count);
            }
            for id in 1..=count {
                let key = DataKey::Proposal(id);
                if env
                    .storage()
                    .persistent()
                    .get::<_, Proposal>(&key)
                    .is_some()
                {
                    continue;
                }
                if let Some(proposal) = env.storage().instance().get::<_, Proposal>(&key) {
                    write_proposal(&env, id, &proposal);
                    migrated += 1;
                }
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::StorageVersion, &STORAGE_VERSION_PERSISTENT);

        Ok(migrated)
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        read_proposal(&env, proposal_id).ok_or(GovernanceError::ProposalNotFound)
    }

    /// Returns the signer's recorded choice on `proposal_id`, or `None` if
    /// the signer has not voted. Distinguishes an explicit veto from a
    /// never-voted state (issue #121) — before this fix, both returned
    /// `false` because the storage value doubled as the vote's boolean
    /// meaning and its presence flag.
    ///
    /// # Breaking change
    ///
    /// This is a breaking ABI change: the function previously returned
    /// `bool`. Any off-chain consumer reading `get_vote` must be updated to
    /// handle `Option<VoteChoice>` instead of `bool`.
    pub fn get_vote(env: Env, proposal_id: u64, signer: Address) -> Option<VoteChoice> {
        read_vote(&env, proposal_id, &signer)
    }

    pub fn proposal_count(env: Env) -> u64 {
        read_proposal_count(&env)
    }

    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or(vec![&env])
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1)
    }

    pub fn get_timelock(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TimelockSeconds)
            .unwrap_or(DEFAULT_TIMELOCK_SECONDS)
    }

    pub fn is_signer(env: Env, address: Address) -> bool {
        env.storage()
            .instance()
            .get::<_, Vec<Address>>(&DataKey::Signers)
            .map(|signers| signers.contains(address))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, BytesN, IntoVal};

    fn make_signers(env: &Env, count: u32) -> Vec<Address> {
        let mut signers: Vec<Address> = vec![&env];
        for _ in 0..count {
            signers.push_back(Address::generate(env));
        }
        signers
    }

    /// A 3-of-5 governance contract with an empty allowlist — the deny-by-
    /// default starting point. Used by every test that never reaches a
    /// successful `execute`.
    fn setup() -> (Env, GovernanceClient<'static>, Vec<Address>) {
        let (env, client, signers, _) = setup_with_allowlist(&|_env| None);
        (env, client, signers)
    }

    /// A 3-of-5 governance contract whose allowlist is seeded at construction.
    ///
    /// `build` receives the freshly created `Env` and returns the single
    /// `(target, method)` pair to allow, along with the target address so the
    /// test can propose against it. Returning `None` seeds an empty allowlist.
    fn setup_with_allowlist(
        build: &dyn Fn(&Env) -> Option<(Address, Symbol)>,
    ) -> (
        Env,
        GovernanceClient<'static>,
        Vec<Address>,
        Option<Address>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;

        let seeded = build(&env);
        let mut allowed: Vec<AllowedCall> = vec![&env];
        if let Some((contract, function)) = seeded.clone() {
            allowed.push_back(AllowedCall { contract, function });
        }

        let contract_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &allowed),
        );
        let client = GovernanceClient::new(&env, &contract_id);
        (env, client, signers, seeded.map(|(c, _)| c))
    }

    fn make_target(env: &Env) -> Address {
        Address::generate(env)
    }

    /// Build the argument list a `set_allowed_calls` proposal must carry.
    fn set_allowed_calls_args(
        env: &Env,
        gov_id: &Address,
        calls: &Vec<AllowedCall>,
        gov_nonce: u64,
    ) -> Vec<Val> {
        vec![
            env,
            gov_id.clone().into_val(env),
            calls.into_val(env),
            gov_nonce.into_val(env),
        ]
    }

    /// Run a complete self-governance cycle that writes `calls` to the
    /// allowlist: propose → reach quorum → wait out the timelock → execute.
    ///
    /// This is the real bootstrap path for a governance contract whose
    /// administered contracts take the governance address as their admin, so
    /// their addresses cannot be known at governance construction time.
    ///
    /// Assumes it runs as the first governance interaction of a test (every
    /// signer nonce and the governance contract's own nonce are still 0). On
    /// return the ledger has advanced by one timelock period, signer 0's nonce
    /// is 2, signers `1..=threshold` are at 1, and the governance address's own
    /// nonce is 1.
    fn seed_allowlist(
        env: &Env,
        gov: &GovernanceClient,
        gov_id: &Address,
        signers: &Vec<Address>,
        threshold: u32,
        calls: Vec<AllowedCall>,
    ) {
        let started_at = env.ledger().timestamp();
        let args = set_allowed_calls_args(env, gov_id, &calls, 0);

        let proposal_id = gov.propose(
            &signers.get(0).unwrap(),
            gov_id,
            &Symbol::new(env, SELF_METHOD_SET_ALLOWED_CALLS),
            &args,
            &Symbol::new(env, "allowlist"),
            &0,
        );
        for i in 1..=threshold {
            gov.vote_approve(&signers.get(i).unwrap(), &proposal_id, &0);
        }
        assert_eq!(
            gov.get_proposal(&proposal_id).status,
            ProposalStatus::Queued
        );

        env.ledger()
            .set_timestamp(started_at + DEFAULT_TIMELOCK_SECONDS);
        gov.execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(
            gov.get_proposal(&proposal_id).status,
            ProposalStatus::Executed
        );
    }

    fn args_for(env: &Env, value: u64) -> Vec<Val> {
        vec![&env, value.into_val(env)]
    }

    #[test]
    fn test_constructor_state() {
        let (_env, client, signers) = setup();
        assert_eq!(client.get_signers(), signers);
        assert_eq!(client.get_threshold(), 3);
        assert_eq!(client.get_timelock(), DEFAULT_TIMELOCK_SECONDS);
        assert!(client.is_signer(&signers.get(0).unwrap()));
        assert!(!client.is_signer(&Address::generate(&_env)));
    }

    #[test]
    fn test_non_signer_cannot_propose() {
        let (env, client, _signers) = setup();
        let outsider = Address::generate(&env);
        let target = make_target(&env);
        let result = client.try_propose(
            &outsider,
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );
        assert_eq!(result, Err(Ok(GovernanceError::NotSigner)));
    }

    #[test]
    fn test_propose_and_quorum_queues() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &args_for(&env, 42),
            &Symbol::new(&env, "desc"),
            &0,
        );
        assert_eq!(proposal_id, 1);

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.proposer, signers.get(0).unwrap());
        assert_eq!(proposal.target, target);

        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.approval_count, 1);

        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.approval_count, 2);

        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Queued);
        assert_eq!(proposal.approval_count, 3);
        assert_eq!(proposal.queued_at, 1_000_000);
    }

    #[test]
    fn test_veto_quorum_rejects() {
        let (env, client, signers) = setup();
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_veto(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_veto(&signers.get(2).unwrap(), &proposal_id, &0);
        assert_eq!(
            client.get_proposal(&proposal_id).status,
            ProposalStatus::Pending
        );

        client.vote_veto(&signers.get(3).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Rejected);
        assert_eq!(proposal.veto_count, 3);
    }

    #[test]
    fn test_duplicate_vote_rejected() {
        let (env, client, signers) = setup();
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        let result = client.try_vote_approve(&signers.get(1).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::AlreadyVoted)));

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.approval_count, 1);
    }

    #[test]
    fn test_vote_on_non_pending_rejected() {
        let (env, client, signers) = setup();
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);

        let result = client.try_vote_approve(&signers.get(4).unwrap(), &proposal_id, &0);
        assert_eq!(result, Err(Ok(GovernanceError::NotPending)));
    }

    #[test]
    fn test_cancel_pending_proposal() {
        let (env, client, signers) = setup();
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.cancel(&signers.get(1).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Cancelled);

        let result = client.try_cancel(&signers.get(2).unwrap(), &proposal_id, &0);
        assert_eq!(result, Err(Ok(GovernanceError::NotPending)));
    }

    #[test]
    fn test_execute_requires_timelock_elapsed() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &args_for(&env, 42),
            &Symbol::new(&env, "desc"),
            &0,
        );
        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS - 1);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::TimelockNotElapsed)));

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert!(result.is_err());
        assert_ne!(result, Err(Ok(GovernanceError::TimelockNotElapsed)));
    }

    #[test]
    fn test_execute_not_queued_rejected() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::NotQueued)));
    }

    #[test]
    fn test_execute_rejected_proposal_rejected() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_veto(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_veto(&signers.get(2).unwrap(), &proposal_id, &0);
        client.vote_veto(&signers.get(3).unwrap(), &proposal_id, &0);

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::NotQueued)));
    }

    #[test]
    fn test_invalid_nonce() {
        let (env, client, signers) = setup();
        let target = make_target(&env);

        let result = client.try_propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &1,
        );
        assert_eq!(result, Err(Ok(GovernanceError::InvalidNonce)));
    }

    #[test]
    fn test_proposal_expires_at_creation() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.created_at, 1_000_000);
        assert_eq!(
            proposal.expires_at,
            1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS
        );
    }

    #[test]
    fn test_execute_expired_proposal_rejected() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );
        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);
        assert_eq!(
            client.get_proposal(&proposal_id).status,
            ProposalStatus::Queued
        );

        // Advance past the per-proposal TTL frozen at creation (also past the timelock).
        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS + 1);

        // Execution of an expired proposal is always rejected.
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::ProposalExpired)));

        // The proposal stays queryable for audit purposes.
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Queued);
        assert!(env.ledger().timestamp() > proposal.expires_at);

        // Repeated execute attempts are equally rejected.
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::ProposalExpired)));
    }

    #[test]
    fn test_get_nonexistent_proposal() {
        let (_env, client, _signers) = setup();
        let result = client.try_get_proposal(&999);
        assert_eq!(result, Err(Ok(GovernanceError::ProposalNotFound)));
    }

    #[test]
    fn test_executes_end_to_end_against_registry() {
        let env = Env::default();
        env.mock_all_auths();

        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let empty: Vec<AllowedCall> = vec![&env];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &empty),
        );
        let gov_client = GovernanceClient::new(&env, &gov_id);

        // Governance contract is the admin of the registry so that it can call
        // approve_project on behalf of the multi-sig.
        let registry_id = env.register(nbbs_project_registry::ProjectRegistry, (&gov_id,));
        let registry = nbbs_project_registry::ProjectRegistryClient::new(&env, &registry_id);

        // The registry's address only exists now — it takes gov_id as its admin
        // at construction — so the allowlist entry for it has to be added by a
        // governance proposal after the fact. This is the ordinary bootstrap.
        seed_allowlist(
            &env,
            &gov_client,
            &gov_id,
            &signers,
            threshold,
            vec![
                &env,
                AllowedCall {
                    contract: registry_id.clone(),
                    function: Symbol::new(&env, "approve_project"),
                },
            ],
        );

        let user = Address::generate(&env);
        let mut hash = [0u8; 32];
        hash[31] = 1;
        let metadata = BytesN::from_array(&env, &hash);
        let pid = registry.register_project(
            &user,
            &metadata,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        // Encode the full argument list that approve_project expects:
        //   fn approve_project(env, caller: Address, project_id: u64, nonce: u64)
        // caller  = gov_id  (the governance contract is the admin on the registry)
        // nonce   = 0       (first call from the governance address on this registry)
        let proposal_args: Vec<Val> = vec![
            &env,
            gov_id.clone().into_val(&env),
            pid.into_val(&env),
            0u64.into_val(&env),
        ];

        // Nonces continue from where seed_allowlist left them: signer 0 is at 2,
        // signers 1-3 are at 1.
        let proposal_id = gov_client.propose(
            &signers.get(0).unwrap(),
            &registry_id,
            &Symbol::new(&env, "approve_project"),
            &proposal_args,
            &Symbol::new(&env, "approve"),
            &2,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &1);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &1);
        gov_client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &1);

        env.ledger().set_timestamp(2 * DEFAULT_TIMELOCK_SECONDS);
        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &3);

        // Verify the proposal executed successfully and the registry reflects
        // the approved status — not relying on the accident of argument order.
        let proposal = gov_client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Executed);

        let project = registry.get_project(&pid);
        assert_eq!(project.status, nbbs_shared::ProjectStatus::Approved);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Cross-contract execution: OracleConsumer.set_signature_threshold
    //
    // Verifies that execute passes args verbatim so a function whose first
    // parameter is NOT a caller address — but whose signature is
    // (caller: Address, threshold: u32, nonce: u64) — receives the correct
    // values with no corruption.
    // ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_set_signature_threshold_via_governance() {
        let env = Env::default();
        env.mock_all_auths();

        let signers = make_signers(&env, 3);
        let threshold: u32 = 2;
        let empty: Vec<AllowedCall> = vec![&env];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &empty),
        );
        let gov_client = GovernanceClient::new(&env, &gov_id);

        // Governance is the admin of the OracleConsumer.
        let oracle_id = env.register(nbbs_oracle_consumer::OracleConsumer, (&gov_id,));
        let oracle = nbbs_oracle_consumer::OracleConsumerClient::new(&env, &oracle_id);

        // Default threshold is 1 (set in __constructor).
        assert_eq!(oracle.get_signature_threshold(), 1u32);

        seed_allowlist(
            &env,
            &gov_client,
            &gov_id,
            &signers,
            threshold,
            vec![
                &env,
                AllowedCall {
                    contract: oracle_id.clone(),
                    function: Symbol::new(&env, "set_signature_threshold"),
                },
            ],
        );

        // Encode full args for set_signature_threshold(caller, threshold, nonce):
        //   caller    = gov_id  (governance is the admin)
        //   threshold = 3
        //   nonce     = 0       (first call from governance address on oracle)
        let new_threshold: u32 = 3;
        let proposal_args: Vec<Val> = vec![
            &env,
            gov_id.clone().into_val(&env),
            new_threshold.into_val(&env),
            0u64.into_val(&env),
        ];

        let proposal_id = gov_client.propose(
            &signers.get(0).unwrap(),
            &oracle_id,
            &Symbol::new(&env, "set_signature_threshold"),
            &proposal_args,
            &Symbol::new(&env, "set_thresh"),
            &2,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &1);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &1);

        env.ledger().set_timestamp(2 * DEFAULT_TIMELOCK_SECONDS);
        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &3);

        // The proposal must be marked Executed.
        let proposal = gov_client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Executed);

        // The oracle contract must reflect the updated threshold — confirming
        // that the argument arrived uncorrupted.
        assert_eq!(oracle.get_signature_threshold(), new_threshold);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Cross-contract execution: BondIssuer.mature_bond
    //
    // Verifies that execute passes args verbatim for a function whose signature
    // is (caller: Address, bond_id: u64, nonce: u64) and that the bond
    // transitions to Matured status after governance execution.
    // ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_mature_bond_via_governance() {
        let env = Env::default();
        env.mock_all_auths();

        let signers = make_signers(&env, 3);
        let threshold: u32 = 2;
        let empty: Vec<AllowedCall> = vec![&env];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &empty),
        );
        let gov_client = GovernanceClient::new(&env, &gov_id);

        // Governance is the admin of the BondIssuer.
        let issuer_id = env.register(nbbs_bond_issuer::BondIssuer, (&gov_id,));
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);

        // Allow only mature_bond on the issuer. Note this does NOT allow
        // issue_bond — the bond below is issued directly by the governance
        // address as admin, not through a proposal.
        seed_allowlist(
            &env,
            &gov_client,
            &gov_id,
            &signers,
            threshold,
            vec![
                &env,
                AllowedCall {
                    contract: issuer_id.clone(),
                    function: Symbol::new(&env, "mature_bond"),
                },
            ],
        );

        // Issue a bond with a maturity date in the future.
        // maturity_date is set relative to the timestamp we advance to below.
        // We advance to DEFAULT_TIMELOCK_SECONDS for execution, so coupon
        // dates and maturity must be beyond timestamp 0 but not in the past.
        // seed_allowlist already advanced the ledger by one timelock period, so
        // maturity is measured from where it left off.
        let maturity_date: u64 = env.ledger().timestamp() + DEFAULT_TIMELOCK_SECONDS + 10_000;
        let mut pid_arr = [0u8; 32];
        pid_arr[31] = 7;
        let project_id = soroban_sdk::BytesN::from_array(&env, &pid_arr);
        let config = nbbs_shared::BondConfig {
            project_id,
            face_value: 1_000,
            coupon_schedule: soroban_sdk::vec![&env, maturity_date - 5_000],
            credit_type: nbbs_shared::CreditType::Carbon,
            maturity_date,
            total_supply: 100,
        };
        // issue_bond uses the governance address's nonce on the issuer — nonce 0.
        let bond_id = issuer.issue_bond(&gov_id, &config, &0u64);

        // Advance past maturity so mature_bond doesn't reject the call.
        env.ledger().set_timestamp(maturity_date + 1);

        // Encode full args for mature_bond(caller, bond_id, nonce):
        //   caller  = gov_id  (governance is the admin)
        //   bond_id = bond_id
        //   nonce   = 1       (second call from governance on issuer — issue_bond was nonce 0)
        let proposal_args: Vec<Val> = vec![
            &env,
            gov_id.clone().into_val(&env),
            bond_id.into_val(&env),
            1u64.into_val(&env),
        ];

        let proposal_id = gov_client.propose(
            &signers.get(0).unwrap(),
            &issuer_id,
            &Symbol::new(&env, "mature_bond"),
            &proposal_args,
            &Symbol::new(&env, "mature"),
            &2,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &1);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &1);

        // Governance's own timelock must also elapse.
        env.ledger()
            .set_timestamp(maturity_date + 1 + DEFAULT_TIMELOCK_SECONDS);

        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &3);

        // The proposal must be marked Executed.
        let proposal = gov_client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Executed);

        // The bond must now be in Matured status — arguments arrived uncorrupted.
        let state = issuer.get_bond_state(&bond_id);
        assert_eq!(state.status, nbbs_shared::BondStatus::Matured);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Execution allowlist (issue #146)
    //
    // execute passed proposal.target / proposal.method / proposal.args straight
    // to env.invoke_contract with no validation, so a proposal that cleared the
    // multi-sig could call any method on any contract the governance address
    // administers. The tests below pin the allowlist that now gates it.
    // ──────────────────────────────────────────────────────────────────────────

    /// Drive a proposal from creation through quorum and the timelock, and
    /// return the result of `execute` so assertions can focus on the allowlist.
    ///
    /// `nonces` is `(proposer_nonce, voter_nonce)`: signer 0 both proposes and
    /// executes while the voters only vote, so the two advance independently.
    /// Soroban reverts the whole transaction on error, so a *rejected* execute
    /// does not consume its nonce — a rejected round advances both by exactly 1.
    fn propose_and_execute(
        env: &Env,
        client: &GovernanceClient,
        signers: &Vec<Address>,
        target: &Address,
        method: Symbol,
        args: Vec<Val>,
        nonces: (u64, u64),
    ) -> Result<
        Result<(), soroban_sdk::ConversionError>,
        Result<GovernanceError, soroban_sdk::InvokeError>,
    > {
        let (proposer_nonce, voter_nonce) = nonces;
        let started_at = env.ledger().timestamp();
        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            target,
            &method,
            &args,
            &Symbol::new(env, "desc"),
            &proposer_nonce,
        );
        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &voter_nonce);
        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &voter_nonce);
        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &voter_nonce);

        env.ledger()
            .set_timestamp(started_at + DEFAULT_TIMELOCK_SECONDS);
        client.try_execute(
            &signers.get(0).unwrap(),
            &proposal_id,
            &(proposer_nonce + 1),
        )
    }

    #[test]
    fn test_execute_rejects_method_outside_allowlist() {
        // Governance is created with an allowlist holding exactly one pair:
        // (target, "approve_project").
        let (env, client, signers, target) = setup_with_allowlist(&|env| {
            Some((Address::generate(env), Symbol::new(env, "approve_project")))
        });
        let target = target.unwrap();
        env.ledger().set_timestamp(1_000_000);

        // A proposal for a DIFFERENT method on that same contract clears the
        // multi-sig and the timelock, and is still refused at execution.
        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &target,
            Symbol::new(&env, "set_admin"),
            args_for(&env, 42),
            (0, 0),
        );
        assert_eq!(result, Err(Ok(GovernanceError::UnauthorizedCall)));

        // Rejection reverts the whole transaction, so the proposal is left
        // Queued rather than Executed and cannot be retried into success.
        assert_eq!(client.get_proposal(&1).status, ProposalStatus::Queued);
    }

    #[test]
    fn test_execute_rejects_allowed_method_on_different_contract() {
        // The allowlist is pair-wise: allowing "approve_project" on one contract
        // must not allow it on another. `target` here is a bare generated
        // address with no contract behind it — reaching invoke_contract would
        // panic rather than return UnauthorizedCall, which is also what proves
        // the check runs *before* the dispatch.
        let (env, client, signers, _allowed) = setup_with_allowlist(&|env| {
            Some((Address::generate(env), Symbol::new(env, "approve_project")))
        });
        env.ledger().set_timestamp(1_000_000);

        let other_contract = Address::generate(&env);
        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &other_contract,
            Symbol::new(&env, "approve_project"),
            args_for(&env, 42),
            (0, 0),
        );
        assert_eq!(result, Err(Ok(GovernanceError::UnauthorizedCall)));
    }

    #[test]
    fn test_execute_denies_everything_when_allowlist_empty() {
        // Deny by default: a contract deployed with no allowlist executes
        // nothing until a set_allowed_calls proposal has cleared.
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);

        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &make_target(&env),
            Symbol::new(&env, "transfer"),
            args_for(&env, 42),
            (0, 0),
        );
        assert_eq!(result, Err(Ok(GovernanceError::UnauthorizedCall)));
    }

    #[test]
    fn test_constructor_seeds_allowlist() {
        let (env, client, _signers, target) = setup_with_allowlist(&|env| {
            Some((Address::generate(env), Symbol::new(env, "approve_project")))
        });
        let target = target.unwrap();

        let allowed = client.get_allowed_calls();
        assert_eq!(allowed.len(), 1);
        assert_eq!(
            allowed.get(0).unwrap(),
            AllowedCall {
                contract: target.clone(),
                function: Symbol::new(&env, "approve_project"),
            }
        );

        assert!(client.is_call_allowed(&target, &Symbol::new(&env, "approve_project")));
        assert!(!client.is_call_allowed(&target, &Symbol::new(&env, "set_admin")));
        assert!(!client.is_call_allowed(
            &Address::generate(&env),
            &Symbol::new(&env, "approve_project")
        ));
    }

    #[test]
    fn test_empty_allowlist_by_default() {
        let (_env, client, _signers) = setup();
        assert_eq!(client.get_allowed_calls().len(), 0);
    }

    #[test]
    fn test_allowlist_is_configurable_via_governance_proposal() {
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let empty: Vec<AllowedCall> = vec![&env];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &empty),
        );
        let client = GovernanceClient::new(&env, &gov_id);
        env.ledger().set_timestamp(1_000_000);

        let target = Address::generate(&env);
        assert!(!client.is_call_allowed(&target, &Symbol::new(&env, "approve_project")));

        // The allowlist is changed only by a proposal that targets the
        // governance contract itself and clears the same M-of-N vote and
        // timelock as any other proposal.
        seed_allowlist(
            &env,
            &client,
            &gov_id,
            &signers,
            threshold,
            vec![
                &env,
                AllowedCall {
                    contract: target.clone(),
                    function: Symbol::new(&env, "approve_project"),
                },
            ],
        );

        assert!(client.is_call_allowed(&target, &Symbol::new(&env, "approve_project")));
        assert_eq!(client.get_allowed_calls().len(), 1);
    }

    #[test]
    fn test_self_proposal_for_unknown_method_rejected() {
        // Targeting the governance contract itself only reaches its
        // self-administration methods; anything else is refused rather than
        // dispatched.
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let empty: Vec<AllowedCall> = vec![&env];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &empty),
        );
        let client = GovernanceClient::new(&env, &gov_id);
        env.ledger().set_timestamp(1_000_000);

        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &gov_id,
            Symbol::new(&env, "propose"),
            vec![&env],
            (0, 0),
        );
        assert_eq!(result, Err(Ok(GovernanceError::UnauthorizedCall)));
    }

    #[test]
    fn test_self_proposal_with_malformed_args_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let empty: Vec<AllowedCall> = vec![&env];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &empty),
        );
        let client = GovernanceClient::new(&env, &gov_id);
        env.ledger().set_timestamp(1_000_000);

        // Right method, wrong arity — a malformed self-call must be rejected
        // cleanly, not stored or half-applied.
        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &gov_id,
            Symbol::new(&env, SELF_METHOD_SET_ALLOWED_CALLS),
            vec![&env, gov_id.clone().into_val(&env)],
            (0, 0),
        );
        assert_eq!(result, Err(Ok(GovernanceError::InvalidCallArgs)));
        assert_eq!(client.get_allowed_calls().len(), 0);

        // Right arity, but position 1 is a scalar rather than a list of pairs.
        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &gov_id,
            Symbol::new(&env, SELF_METHOD_SET_ALLOWED_CALLS),
            vec![
                &env,
                gov_id.clone().into_val(&env),
                7u64.into_val(&env),
                0u64.into_val(&env),
            ],
            (1, 1),
        );
        assert_eq!(result, Err(Ok(GovernanceError::InvalidCallArgs)));
        assert_eq!(client.get_allowed_calls().len(), 0);

        // Right arity and a list, but of the wrong element type. This is the
        // case that must not be stored: an allowlist of undecodable elements
        // would panic on every later read, bricking execute permanently.
        let wrong_elements: Vec<u64> = vec![&env, 1u64, 2u64];
        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &gov_id,
            Symbol::new(&env, SELF_METHOD_SET_ALLOWED_CALLS),
            vec![
                &env,
                gov_id.clone().into_val(&env),
                wrong_elements.into_val(&env),
                0u64.into_val(&env),
            ],
            (2, 2),
        );
        assert_eq!(result, Err(Ok(GovernanceError::InvalidCallArgs)));
        assert_eq!(client.get_allowed_calls().len(), 0);
    }

    #[test]
    fn test_self_proposal_with_wrong_caller_rejected() {
        // The caller encoded at position 0 must be the governance address
        // itself; a proposal that names a signer instead cannot smuggle the
        // signer's own nonce into a config change.
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let empty: Vec<AllowedCall> = vec![&env];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &empty),
        );
        let client = GovernanceClient::new(&env, &gov_id);
        env.ledger().set_timestamp(1_000_000);

        let calls: Vec<AllowedCall> = vec![
            &env,
            AllowedCall {
                contract: Address::generate(&env),
                function: Symbol::new(&env, "transfer"),
            },
        ];
        let args = set_allowed_calls_args(&env, &signers.get(0).unwrap(), &calls, 0);

        let result = propose_and_execute(
            &env,
            &client,
            &signers,
            &gov_id,
            Symbol::new(&env, SELF_METHOD_SET_ALLOWED_CALLS),
            args,
            (0, 0),
        );
        assert_eq!(result, Err(Ok(GovernanceError::Unauthorized)));
        assert_eq!(client.get_allowed_calls().len(), 0);
    }

    #[test]
    fn test_allowlist_deduplicates_and_caps_entries() {
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let contract = Address::generate(&env);
        let function = Symbol::new(&env, "approve_project");

        // The same pair listed three times collapses to one entry.
        let duplicated: Vec<AllowedCall> = vec![
            &env,
            AllowedCall {
                contract: contract.clone(),
                function: function.clone(),
            },
            AllowedCall {
                contract: contract.clone(),
                function: function.clone(),
            },
            AllowedCall {
                contract: contract.clone(),
                function: function.clone(),
            },
        ];
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &duplicated),
        );
        let client = GovernanceClient::new(&env, &gov_id);
        assert_eq!(client.get_allowed_calls().len(), 1);
        assert!(client.is_call_allowed(&contract, &function));
    }

    #[test]
    #[should_panic(expected = "invalid allowed_calls")]
    fn test_constructor_rejects_oversized_allowlist() {
        // An unbounded allowlist would make every execute scan it, so the cap
        // is enforced at the only two write points: the constructor and
        // set_allowed_calls.
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;

        let mut oversized: Vec<AllowedCall> = vec![&env];
        for _ in 0..(MAX_ALLOWED_CALLS + 1) {
            oversized.push_back(AllowedCall {
                contract: Address::generate(&env),
                function: Symbol::new(&env, "approve_project"),
            });
        }
        env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS, &oversized),
        );
    }

    #[test]
    fn test_set_allowed_calls_rejects_external_caller() {
        // The entrypoint exists so the proposal ABI is published, but no
        // external address may drive it — not a signer, not anyone else.
        let (env, client, signers) = setup();
        let calls: Vec<AllowedCall> = vec![
            &env,
            AllowedCall {
                contract: Address::generate(&env),
                function: Symbol::new(&env, "transfer"),
            },
        ];

        let result = client.try_set_allowed_calls(&signers.get(0).unwrap(), &calls, &0);
        assert_eq!(result, Err(Ok(GovernanceError::Unauthorized)));

        let outsider = Address::generate(&env);
        let result = client.try_set_allowed_calls(&outsider, &calls, &0);
        assert_eq!(result, Err(Ok(GovernanceError::Unauthorized)));

        assert_eq!(client.get_allowed_calls().len(), 0);
    }

    #[test]
    fn test_get_vote_distinguishes_approve_veto_and_never_voted() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        let signer_a = signers.get(1).unwrap();
        let signer_b = signers.get(2).unwrap();

        // Two distinct proposals, both proposed by signer 0.
        let proposal_1 = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );
        let proposal_2 = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &1,
        );

        // Signer A vetoes proposal 1 and approves proposal 2.
        client.vote_veto(&signer_a, &proposal_1, &0);
        client.vote_approve(&signer_a, &proposal_2, &1);

        assert_eq!(
            client.get_vote(&proposal_1, &signer_a),
            Some(VoteChoice::Veto)
        );
        assert_eq!(
            client.get_vote(&proposal_2, &signer_a),
            Some(VoteChoice::Approve)
        );
        // Signer B never voted on either proposal.
        assert_eq!(client.get_vote(&proposal_1, &signer_b), None);
        assert_eq!(client.get_vote(&proposal_2, &signer_b), None);
    }

    #[test]
    fn test_vote_veto_cannot_be_cast_twice_by_same_signer() {
        // Regression for the bypass bug that motivated this fix: before it,
        // `vote_veto`'s own `AlreadyVoted` guard read the same storage key
        // with `.unwrap_or(false)` that the function itself overwrites with
        // `false`, so a repeated veto from the same signer never tripped the
        // guard, letting one signer inflate veto_count on their own.
        let (env, client, signers) = setup();
        let target = make_target(&env);
        let signer_a = signers.get(1).unwrap();

        let proposal_1 = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_veto(&signer_a, &proposal_1, &0);

        // Second veto attempt from the same signer must fail.
        let result = client.try_vote_veto(&signer_a, &proposal_1, &1);
        assert_eq!(result, Err(Ok(GovernanceError::AlreadyVoted)));

        // veto_count must not have been inflated by the rejected second call.
        assert_eq!(client.get_proposal(&proposal_1).veto_count, 1);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Vote expiry (issue #191)
    //
    // Previously expiry was only checked at execute — a Pending proposal past
    // its expires_at kept accepting votes and could still reach Queued, only
    // to fail (uselessly) at execute. The tests below pin that voting itself
    // now rejects an expired proposal, and that this is what stops it from
    // ever reaching Queued.
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_vote_approve_rejects_after_expiry() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        // One approval before expiry — stays Pending, below threshold.
        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        assert_eq!(client.get_proposal(&proposal_id).approval_count, 1);

        // Advance past the proposal's own TTL, frozen at creation.
        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS + 1);

        // A further vote on the now-expired proposal must revert instead of
        // silently accruing.
        let result = client.try_vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        assert_eq!(result, Err(Ok(GovernanceError::ProposalExpired)));

        // The rejected vote must not have moved the count.
        assert_eq!(client.get_proposal(&proposal_id).approval_count, 1);
    }

    #[test]
    fn test_vote_veto_rejects_after_expiry() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS + 1);

        let result = client.try_vote_veto(&signers.get(1).unwrap(), &proposal_id, &0);
        assert_eq!(result, Err(Ok(GovernanceError::ProposalExpired)));
        assert_eq!(client.get_proposal(&proposal_id).veto_count, 0);
    }

    #[test]
    fn test_expired_proposal_cannot_reach_queued() {
        // A proposal one vote short of threshold, left to expire, must never
        // transition to Queued no matter how many more votes are attempted —
        // Queued is only ever reached through vote_approve, and that path is
        // now closed once the proposal has expired.
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );
        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        // One vote short of the 3-signer threshold; still Pending.
        assert_eq!(
            client.get_proposal(&proposal_id).status,
            ProposalStatus::Pending
        );

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS + 1);

        let result = client.try_vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);
        assert_eq!(result, Err(Ok(GovernanceError::ProposalExpired)));
        assert_eq!(
            client.get_proposal(&proposal_id).status,
            ProposalStatus::Pending
        );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Persistent storage migration (issue #103)
    // ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_migrate_storage_preserves_legacy_proposal() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        // Simulate a proposal + counter that predate this fix by writing them
        // directly into instance storage, bypassing propose() (which now
        // always writes to persistent storage).
        env.as_contract(&client.address, || {
            let proposal = Proposal {
                id: 1,
                proposer: signers.get(0).unwrap(),
                target: target.clone(),
                method: Symbol::new(&env, "legacy_call"),
                args: vec![&env],
                description: Symbol::new(&env, "legacy"),
                status: ProposalStatus::Pending,
                approval_count: 0,
                veto_count: 0,
                created_at: 1_000_000,
                expires_at: 1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS,
                queued_at: 0,
                executed_at: 0,
                timelock_seconds: DEFAULT_TIMELOCK_SECONDS,
            };
            env.storage()
                .instance()
                .set(&DataKey::Proposal(1u64), &proposal);
            env.storage().instance().set(&DataKey::ProposalCount, &1u64);
        });

        // Readable via the legacy fallback even before migration runs.
        let proposal = client.get_proposal(&1);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.method, Symbol::new(&env, "legacy_call"));
        assert_eq!(client.proposal_count(), 1);

        // Run the migration.
        let migrated = client.migrate_storage(&signers.get(0).unwrap());
        assert_eq!(migrated, 1);

        // Still readable — now served from persistent storage.
        let proposal = client.get_proposal(&1);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(client.proposal_count(), 1);

        // Calling migrate again is a safe no-op.
        let migrated_again = client.migrate_storage(&signers.get(0).unwrap());
        assert_eq!(migrated_again, 0);
    }

    #[test]
    fn test_new_proposals_go_straight_to_persistent_storage() {
        // Proposals created after this fix should never touch instance
        // storage at all — that's the whole point of the fix.
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        env.as_contract(&client.address, || {
            assert!(env
                .storage()
                .persistent()
                .has(&DataKey::Proposal(proposal_id)));
            assert!(!env
                .storage()
                .instance()
                .has(&DataKey::Proposal(proposal_id)));
            assert!(env.storage().persistent().has(&DataKey::ProposalCount));
        });
    }
}
