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
