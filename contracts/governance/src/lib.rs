#![no_std]
#![allow(deprecated)]
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, Symbol, Val, Vec};
use nbbs_shared::{GovernanceError, VoteChoice};

pub const DEFAULT_TIMELOCK_SECONDS: u64 = 172_800;
pub const DEFAULT_PROPOSAL_TTL_SECONDS: u64 = 2_592_000;

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

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0)
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    env.storage()
        .instance()
        .set(&DataKey::Nonce(addr.clone()), &nonce);
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

#[contract]
pub struct Governance;

#[contractimpl]
impl Governance {
    pub fn __constructor(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
        timelock_seconds: u64,
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
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::TimelockSeconds, &timelock_seconds);
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

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

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
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

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

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        let vote_key = DataKey::Vote(proposal_id, caller.clone());
        // Guard checks presence of ANY prior choice, not a specific value —
        // this is what fixes the veto-bypass bug (#121): a stored `Veto` is
        // just as "already voted" as a stored `Approve`.
        if env
            .storage()
            .instance()
            .get::<_, VoteChoice>(&vote_key)
            .is_some()
        {
            return Err(GovernanceError::AlreadyVoted);
        }
        env.storage()
            .instance()
            .set(&vote_key, &VoteChoice::Approve);

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
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

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

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        let vote_key = DataKey::Vote(proposal_id, caller.clone());
        // Same presence check as vote_approve — this is the line that was
        // broken before: reading with `.unwrap_or(false)` against a key that
        // this function itself writes `false` into meant a veto vote could
        // never trip its own "already voted" guard.
        if env
            .storage()
            .instance()
            .get::<_, VoteChoice>(&vote_key)
            .is_some()
        {
            return Err(GovernanceError::AlreadyVoted);
        }
        env.storage().instance().set(&vote_key, &VoteChoice::Veto);

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1);

        proposal.veto_count += 1;
        if proposal.veto_count >= threshold {
            proposal.status = ProposalStatus::Rejected;
        }
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

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

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

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

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

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

        // Pass proposal.args verbatim. The proposer is responsible for
        // encoding the complete argument list — including the governance
        // contract address as the caller at position 0 and the correct nonce
        // for the governance address on the target contract at the last
        // position. This guarantees the target receives exactly the arguments
        // it expects, regardless of the target's function signature.
        env.invoke_contract::<Val>(&proposal.target, &proposal.method, proposal.args.clone());

        proposal.status = ProposalStatus::Executed;
        proposal.executed_at = now;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_executed"),),
            (proposal_id, proposal.target.clone()),
        );

        Ok(())
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)
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
        env.storage()
            .instance()
            .get(&DataKey::Vote(proposal_id, signer))
    }

    pub fn proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
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

    fn setup() -> (Env, GovernanceClient<'static>, Vec<Address>) {
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let contract_id = env.register(Governance, (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS));
        let client = GovernanceClient::new(&env, &contract_id);
        (env, client, signers)
    }

    fn make_target(env: &Env) -> Address {
        Address::generate(env)
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

        env.ledger().set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS - 1);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::TimelockNotElapsed)));

        env.ledger().set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
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

        env.ledger().set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
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

        env.ledger().set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
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
        assert_eq!(proposal.expires_at, 1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS);
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
        assert_eq!(client.get_proposal(&proposal_id).status, ProposalStatus::Queued);

        // Advance past the per-proposal TTL frozen at creation (also past the timelock).
        env.ledger().set_timestamp(1_000_000 + DEFAULT_PROPOSAL_TTL_SECONDS + 1);

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
        let gov_id = env.register(Governance, (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS));
        let gov_client = GovernanceClient::new(&env, &gov_id);

        // Governance contract is the admin of the registry so that it can call
        // approve_project on behalf of the multi-sig.
        let registry_id = env.register(nbbs_project_registry::ProjectRegistry, (&gov_id,));
        let registry = nbbs_project_registry::ProjectRegistryClient::new(&env, &registry_id);

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

        let proposal_id = gov_client.propose(
            &signers.get(0).unwrap(),
            &registry_id,
            &Symbol::new(&env, "approve_project"),
            &proposal_args,
            &Symbol::new(&env, "approve"),
            &0,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);

        env.ledger().set_timestamp(DEFAULT_TIMELOCK_SECONDS);
        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &1);

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
        let gov_id = env.register(Governance, (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS));
        let gov_client = GovernanceClient::new(&env, &gov_id);

        // Governance is the admin of the OracleConsumer.
        let oracle_id = env.register(nbbs_oracle_consumer::OracleConsumer, (&gov_id,));
        let oracle = nbbs_oracle_consumer::OracleConsumerClient::new(&env, &oracle_id);

        // Default threshold is 1 (set in __constructor).
        assert_eq!(oracle.get_signature_threshold(), 1u32);

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
            &0,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);

        env.ledger().set_timestamp(DEFAULT_TIMELOCK_SECONDS);
        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &1);

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
        let gov_id = env.register(Governance, (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS));
        let gov_client = GovernanceClient::new(&env, &gov_id);

        // Governance is the admin of the BondIssuer.
        let issuer_id = env.register(nbbs_bond_issuer::BondIssuer, (&gov_id,));
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);

        // Issue a bond with a maturity date in the future.
        // maturity_date is set relative to the timestamp we advance to below.
        // We advance to DEFAULT_TIMELOCK_SECONDS for execution, so coupon
        // dates and maturity must be beyond timestamp 0 but not in the past.
        let maturity_date: u64 = DEFAULT_TIMELOCK_SECONDS + 10_000;
        let mut pid_arr = [0u8; 32];
        pid_arr[31] = 7;
        let project_id = soroban_sdk::BytesN::from_array(&env, &pid_arr);
        let config = nbbs_shared::BondConfig {
            project_id,
            face_value: 1_000,
            coupon_schedule: soroban_sdk::vec![&env, DEFAULT_TIMELOCK_SECONDS / 2],
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
            &0,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);

        // Governance's own timelock must also elapse.
        env.ledger().set_timestamp(maturity_date + 1 + DEFAULT_TIMELOCK_SECONDS);

        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &1);

        // The proposal must be marked Executed.
        let proposal = gov_client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Executed);

        // The bond must now be in Matured status — arguments arrived uncorrupted.
        let state = issuer.get_bond_state(&bond_id);
        assert_eq!(state.status, nbbs_shared::BondStatus::Matured);
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

        // Assertion central del acceptance criteria: get_vote distingue los
        // tres estados observables.
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
}
