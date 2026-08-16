#![no_std]
#![allow(deprecated)]
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol, Val, Vec};
use nbbs_shared::GovernanceError;

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
    ExecutionNonce(Address),
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

fn get_execution_nonce(env: &Env, target: &Address) -> u64 {    env.storage()
        .instance()
        .get(&DataKey::ExecutionNonce(target.clone()))
        .unwrap_or(0)
}

fn set_execution_nonce(env: &Env, target: &Address, nonce: u64) {
    env.storage()
        .instance()
        .set(&DataKey::ExecutionNonce(target.clone()), &nonce);
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
        if env.storage().instance().get::<_, bool>(&vote_key).unwrap_or(false) {
            return Err(GovernanceError::AlreadyVoted);
        }
        env.storage().instance().set(&vote_key, &true);

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
        if env.storage().instance().get::<_, bool>(&vote_key).unwrap_or(false) {
            return Err(GovernanceError::AlreadyVoted);
        }
        env.storage().instance().set(&vote_key, &false);

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

        let exec_nonce = get_execution_nonce(&env, &proposal.target);
        let mut full_args: Vec<Val> = vec![&env, env.current_contract_address().into_val(&env)];
        for arg in proposal.args.iter() {
            full_args.push_back(arg);
        }
        full_args.push_back(exec_nonce.into_val(&env));

        env.invoke_contract::<Val>(&proposal.target, &proposal.method, full_args);
        set_execution_nonce(&env, &proposal.target, exec_nonce + 1);

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

    pub fn get_vote(env: Env, proposal_id: u64, signer: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Vote(proposal_id, signer))
            .unwrap_or(false)
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

        let proposal_id = gov_client.propose(
            &signers.get(0).unwrap(),
            &registry_id,
            &Symbol::new(&env, "approve_project"),
            &vec![&env, pid.into_val(&env)],
            &Symbol::new(&env, "approve"),
            &0,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);

        env.ledger().set_timestamp(DEFAULT_TIMELOCK_SECONDS);
        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &1);

        let project = registry.get_project(&pid);
        assert_eq!(project.status, nbbs_shared::ProjectStatus::Approved);
    }
}
