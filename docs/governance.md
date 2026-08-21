# Governance

## Multi-Stakeholder Committee
- Project Developers
- Bond Issuers
- Oracle Providers
- Protocol Maintainers
- Token Holders

## Governance Actions (3-of-5 Multi-sig)
- Add/remove oracle providers
- Update credit conversion factors
- Deploy contract upgrades (48h timelock)
- Modify KYC requirements
- Adjust dispute resolution parameters

## Proposal Lifecycle
- Proposals are created with a per-proposal `expires_at` derived from the on-chain
  ledger timestamp at creation (30-day TTL), so a later parameter change can never
  retroactively revive a stale proposal.
- Only proposals that are `Queued`, past the timelock, and still within `expires_at`
  can be executed. Executing an expired proposal is rejected with
  `GovernanceError::ProposalExpired`, blocking governance replay attacks.

## Execution Allowlist

`execute` dispatches a proposal's `(target, method, args)` straight to the target
contract. Clearing the vote and the timelock proves the multi-sig *agreed*; it
proves nothing about *what* was agreed to. Without a second gate, a proposal
could name any method on any contract the governance address administers — a
token `transfer`, another contract's `set_admin`, an `upgrade` — and the timelock
would only delay it.

Every proposal is therefore checked against an on-chain allowlist of
`(contract, method)` pairs before the call is dispatched:

- The allowlist lives in **persistent** storage under `DataKey::AllowedCalls`,
  so it cannot be archived out from under the contract.
- Matching is **pair-wise**. Allowing `set_admin` on the oracle does not allow
  `set_admin` on the bond issuer.
- It is **deny by default**. A contract deployed with an empty allowlist
  executes nothing until an allowlist proposal has cleared.
- A rejected proposal is refused with `GovernanceError::UnauthorizedCall`
  *before* the target is invoked, so the target is never reached.
- The list is deduplicated on write and capped at `MAX_ALLOWED_CALLS` (64).
  An unbounded list would be rescanned on every execution and could push later
  executions past the ledger's budget.

### Changing the allowlist

The allowlist is reconfigured only by a proposal that clears the same M-of-N
vote and timelock as any other proposal, targeting the governance contract
itself:

```text
target = <the governance contract's own address>
method = "set_allowed_calls"
args   = [governance_address, Vec<AllowedCall>, governance_nonce]
```

Soroban forbids contract re-entry, so such a proposal cannot be routed through
`invoke_contract`; `execute` recognises a self-targeted proposal and dispatches
it internally. Only `set_allowed_calls` is reachable this way — any other method
symbol aimed at the governance contract is rejected with `UnauthorizedCall`.

`set_allowed_calls` is a **full replacement**, not a merge: a proposal that adds
one pair must re-state the pairs it keeps, so the complete post-execution
permission set is reviewable in the proposal itself.

### Deployment order

The registry, bond issuer and oracle consumer all take the governance address as
their admin at construction, so their addresses do not exist when governance is
deployed. The expected sequence is:

1. Deploy governance with an empty (or partial) allowlist.
2. Deploy the administered contracts with the governance address as admin.
3. Pass one `set_allowed_calls` proposal naming their addresses and the specific
   admin methods governance is permitted to call.

Between steps 1 and 3 the contract is inert rather than open — proposals can be
created and voted on, but nothing executes.

### Keeping the allowlist in sync

The allowlist pins method *names*, not signatures. If a target contract is
upgraded such that a method is renamed or removed, the corresponding entry goes
stale: proposals naming it will be dispatched and then fail inside the target.
An upgrade that renames an administered method should be paired with a
`set_allowed_calls` proposal in the same governance cycle.

### Read-only helpers

- `get_allowed_calls() -> Vec<AllowedCall>` — the current allowlist.
- `is_call_allowed(contract, function) -> bool` — whether `execute` would
  currently permit a call, so a proposer can check before spending a vote cycle.
