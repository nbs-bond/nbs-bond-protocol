#![no_std]
#![allow(deprecated)]
pub use nbbs_shared::Project;
use nbbs_shared::{ProjectStatus, RegistryError};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Address, BytesN, Env, IntoVal, String,
    Symbol, TryFromVal, Val, Vec,
};

/// Ledgers closed in a day at the network's ~5 second close time.
const LEDGERS_PER_DAY: u32 = 17_280;
/// Refresh entries once they are within 30 days of expiry.
const PERSISTENT_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
/// Keep project data and the contract instance alive for another 120 days.
const PERSISTENT_TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 120;

/// Delay, in seconds, between an admin transfer being proposed and it
/// becoming acceptable (issue #206); 48 hours. Turns a single instant,
/// silent admin change into a two-step, on-chain-visible one: a compromised
/// or mistaken key rotation is observable (via the `admin_transfer_proposed`
/// event) and cancellable by the current admin before it can take effect.
const ADMIN_TRANSFER_TIMELOCK_SECONDS: u64 = 172_800;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Project(BytesN<32>),
    ProjectCount,
    ProjectId(u64),
    ProjectByHash(BytesN<32>),
    Nonce(Address),
    OwnerProjects(Address),
    OracleConsumerId,
    /// A proposed but not-yet-accepted admin transfer, if any (issue #206).
    PendingAdmin,
}

/// A proposed admin rotation awaiting acceptance by `candidate` once
/// `executable_at` has passed. See [`ProjectRegistry::propose_admin_transfer`].
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingAdminChange {
    pub candidate: Address,
    pub executable_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ProjectSummary {
    pub id: u64,
    pub name: Symbol,
    pub status: ProjectStatus,
    pub country: Symbol,
}

/// Minimal registry-owned data needed to link an oracle report to a project.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct ProjectLinkage {
    pub id: u64,
    pub metadata_ipfs_hash: BytesN<32>,
    pub status: ProjectStatus,
}

fn project_id_to_bytes(env: &Env, id: u64) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[..8].copy_from_slice(&id.to_be_bytes());
    BytesN::from_array(env, &arr)
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

fn read_persistent<V>(env: &Env, key: &DataKey) -> Option<V>
where
    V: TryFromVal<Env, Val>,
{
    match env.storage().persistent().get(key) {
        Some(value) => {
            bump_persistent(env, key);
            Some(value)
        }
        None => None,
    }
}

fn write_persistent<V>(env: &Env, key: &DataKey, value: &V)
where
    V: IntoVal<Env, Val>,
{
    env.storage().persistent().set(key, value);
    bump_persistent(env, key);
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), RegistryError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(RegistryError::NotInitialized)?;
    if caller != &admin {
        return Err(RegistryError::Unauthorized);
    }
    Ok(())
}

fn require_admin_or_oracle(env: &Env, caller: &Address) -> Result<(), RegistryError> {
    if require_admin(env, caller).is_ok() {
        return Ok(());
    }

    let oracle_consumer: Address = env
        .storage()
        .instance()
        .get(&DataKey::OracleConsumerId)
        .ok_or(RegistryError::OracleConsumerNotSet)?;
    if caller != &oracle_consumer {
        return Err(RegistryError::Unauthorized);
    }
    Ok(())
}

fn ensure_metadata_hash_available(
    env: &Env,
    metadata_ipfs_hash: &BytesN<32>,
) -> Result<(), RegistryError> {
    let hash_key = DataKey::ProjectByHash(metadata_ipfs_hash.clone());
    if let Some(project_id) = read_persistent::<u64>(env, &hash_key) {
        let project_key = DataKey::Project(project_id_to_bytes(env, project_id));
        if let Some(project) = read_persistent::<Project>(env, &project_key) {
            let active_project = matches!(
                project.status,
                ProjectStatus::Pending | ProjectStatus::Approved
            );
            if active_project {
                return Err(RegistryError::ProjectAlreadyExists);
            }
        }
    }

    Ok(())
}

#[contract]
pub struct ProjectRegistry;

#[contractimpl]
impl ProjectRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        bump_instance(&env);
    }

    pub fn register_project(
        env: Env,
        caller: Address,
        metadata_ipfs_hash: BytesN<32>,
        name: Symbol,
        methodology: Symbol,
        country: Symbol,
        nonce: u64,
    ) -> Result<u64, RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }

        let hash_arr = metadata_ipfs_hash.to_array();
        if hash_arr.iter().all(|&b| b == 0) {
            return Err(RegistryError::ProjectNotFound);
        }
        ensure_metadata_hash_available(&env, &metadata_ipfs_hash)?;

        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        let count: u64 = read_persistent(&env, &DataKey::ProjectCount).unwrap_or(0);
        let new_id = count + 1;
        write_persistent(&env, &DataKey::ProjectCount, &new_id);

        let project = Project {
            id: new_id,
            owner: caller.clone(),
            metadata_ipfs_hash: metadata_ipfs_hash.clone(),
            name,
            status: ProjectStatus::Pending,
            methodology,
            country,
        };

        let key = project_id_to_bytes(&env, new_id);
        write_persistent(&env, &DataKey::Project(key), &project);
        write_persistent(&env, &DataKey::ProjectByHash(metadata_ipfs_hash), &new_id);

        let owner_projects_key = DataKey::OwnerProjects(caller.clone());
        let mut owner_projects: Vec<u64> =
            read_persistent(&env, &owner_projects_key).unwrap_or(vec![&env]);
        owner_projects.push_back(new_id);
        write_persistent(&env, &owner_projects_key, &owner_projects);

        Ok(new_id)
    }

    /// Suspend an approved project (admin-only). Suspended projects cannot back new bonds
    /// or generate credits until reinstated.
    pub fn suspend_project(
        env: Env,
        caller: Address,
        project_id: u64,
        reason: String,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = read_persistent(&env, &DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Approved {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Inactive;
        write_persistent(&env, &DataKey::Project(key), &project);

        // Emit suspension event
        env.events()
            .publish((symbol_short!("P_SUSPEND"),), (project_id, caller, reason));

        Ok(())
    }

    /// Revoke an approved project. The admin or configured oracle consumer may
    /// revoke it; rejected oracle reports use the latter path. Revoked projects
    /// are permanently removed from the active registry and cannot be reinstated.
    pub fn revoke_project(
        env: Env,
        caller: Address,
        project_id: u64,
        reason: String,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        require_admin_or_oracle(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = read_persistent(&env, &DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Approved {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Rejected;
        write_persistent(&env, &DataKey::Project(key), &project);

        // Emit revocation event
        env.events()
            .publish((symbol_short!("P_REVOKE"),), (project_id, caller, reason));

        Ok(())
    }

    /// Check if a project is active (Approved and not suspended).
    pub fn is_project_active(env: &Env, project_id: u64) -> bool {
        bump_instance(env);
        let key = project_id_to_bytes(env, project_id);
        match read_persistent::<Project>(env, &DataKey::Project(key)) {
            Some(project) => project.status == ProjectStatus::Approved,
            None => false,
        }
    }

    /// Get project status for oracle integration.
    pub fn get_project_status(env: &Env, project_id: u64) -> Result<ProjectStatus, RegistryError> {
        bump_instance(env);
        let key = project_id_to_bytes(env, project_id);
        read_persistent::<Project>(env, &DataKey::Project(key))
            .map(|project: Project| project.status)
            .ok_or(RegistryError::ProjectNotFound)
    }

    /// Return the registry-owned identity, metadata hash, and current status
    /// needed by consumers that link records to a project. `project_id` is the
    /// canonical numeric [`Project::id`]; callers must not substitute the
    /// project's metadata hash for this identifier.
    pub fn get_project_linkage(
        env: &Env,
        project_id: u64,
    ) -> Result<ProjectLinkage, RegistryError> {
        bump_instance(env);
        let key = project_id_to_bytes(env, project_id);
        read_persistent::<Project>(env, &DataKey::Project(key))
            .map(|project| ProjectLinkage {
                id: project.id,
                metadata_ipfs_hash: project.metadata_ipfs_hash,
                status: project.status,
            })
            .ok_or(RegistryError::ProjectNotFound)
    }

    /// Set the oracle consumer contract address (admin-only).
    pub fn set_oracle_consumer(
        env: Env,
        caller: Address,
        oracle_consumer_id: Address,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        env.storage()
            .instance()
            .set(&DataKey::OracleConsumerId, &oracle_consumer_id);

        env.events()
            .publish((symbol_short!("ORA_SET"),), (caller, oracle_consumer_id));

        Ok(())
    }

    pub fn approve_project(
        env: Env,
        caller: Address,
        project_id: u64,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = read_persistent(&env, &DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Pending {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Approved;
        write_persistent(&env, &DataKey::Project(key), &project);

        Ok(())
    }

    pub fn reject_project(
        env: Env,
        caller: Address,
        project_id: u64,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = read_persistent(&env, &DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Pending {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Rejected;
        write_persistent(&env, &DataKey::Project(key), &project);

        Ok(())
    }

    pub fn get_project(env: Env, project_id: u64) -> Result<Project, RegistryError> {
        bump_instance(&env);
        let key = project_id_to_bytes(&env, project_id);
        read_persistent(&env, &DataKey::Project(key)).ok_or(RegistryError::ProjectNotFound)
    }

    pub fn get_project_status_by_hash(
        env: Env,
        hash: BytesN<32>,
    ) -> Result<ProjectStatus, RegistryError> {
        bump_instance(&env);
        let project_id: u64 = read_persistent(&env, &DataKey::ProjectByHash(hash))
            .ok_or(RegistryError::ProjectNotFound)?;
        let key = project_id_to_bytes(&env, project_id);
        let project: Project =
            read_persistent(&env, &DataKey::Project(key)).ok_or(RegistryError::ProjectNotFound)?;
        Ok(project.status)
    }

    pub fn list_projects(env: Env, page: u32, page_size: u32) -> Vec<ProjectSummary> {
        bump_instance(&env);
        let count: u64 = read_persistent(&env, &DataKey::ProjectCount).unwrap_or(0);

        let page_size = page_size.min(50);
        let start = (page as u64) * (page_size as u64);
        let mut result: Vec<ProjectSummary> = vec![&env];

        if start >= count {
            return result;
        }

        let end = (start + page_size as u64).min(count);
        for i in (start + 1)..=end {
            let key = project_id_to_bytes(&env, i);
            if let Some(project) = read_persistent::<Project>(&env, &DataKey::Project(key)) {
                result.push_back(ProjectSummary {
                    id: project.id,
                    name: project.name,
                    status: project.status,
                    country: project.country,
                });
            }
        }

        result
    }

    pub fn project_count(env: Env) -> u64 {
        bump_instance(&env);
        read_persistent(&env, &DataKey::ProjectCount).unwrap_or(0)
    }

    /// Get project by metadata IPFS hash.
    pub fn get_project_by_hash(
        env: Env,
        metadata_ipfs_hash: BytesN<32>,
    ) -> Result<Project, RegistryError> {
        bump_instance(&env);
        let project_id: u64 = read_persistent(
            &env,
            &DataKey::ProjectByHash(metadata_ipfs_hash),
        )
        .ok_or(RegistryError::ProjectNotFound)?;
        let key = project_id_to_bytes(&env, project_id);
        read_persistent(&env, &DataKey::Project(key)).ok_or(RegistryError::ProjectNotFound)
    }

    pub fn get_owner_projects(env: Env, owner: Address) -> Vec<u64> {
        bump_instance(&env);
        read_persistent(&env, &DataKey::OwnerProjects(owner)).unwrap_or(vec![&env])
    }

    /// Begin rotating the admin key. Only the current admin may propose, and
    /// the change only takes effect once `candidate` itself calls
    /// [`Self::accept_admin_transfer`] after `ADMIN_TRANSFER_TIMELOCK_SECONDS`
    /// has elapsed (issue #206).
    ///
    /// The two-step, timelocked design avoids two hazards a direct
    /// `set_admin` would carry: the candidate must be able to sign to claim
    /// the role, so a transfer can never land on a mistyped or unreachable
    /// address; and the `admin_transfer_proposed` event plus the delay give
    /// observers a window to notice and, via [`Self::cancel_admin_transfer`],
    /// stop an unwanted rotation (e.g. one made under a compromised key)
    /// before it can complete.
    pub fn propose_admin_transfer(
        env: Env,
        caller: Address,
        candidate: Address,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let executable_at = env.ledger().timestamp() + ADMIN_TRANSFER_TIMELOCK_SECONDS;
        write_persistent(
            &env,
            &DataKey::PendingAdmin,
            &PendingAdminChange {
                candidate: candidate.clone(),
                executable_at,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "admin_transfer_proposed"),),
            (caller, candidate, executable_at),
        );

        Ok(())
    }

    /// Cancel a pending admin transfer before it is accepted. Admin-only, so
    /// the current admin can undo a proposal it did not intend (or that was
    /// made under a since-revoked key) any time before `accept_admin_transfer`
    /// is called.
    pub fn cancel_admin_transfer(
        env: Env,
        caller: Address,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        if !env.storage().persistent().has(&DataKey::PendingAdmin) {
            return Err(RegistryError::NoPendingAdminChange);
        }
        env.storage().persistent().remove(&DataKey::PendingAdmin);

        env.events()
            .publish((Symbol::new(&env, "admin_transfer_cancelled"),), (caller,));

        Ok(())
    }

    /// Complete a pending admin transfer. Must be called by the proposed
    /// `candidate` itself, once the timelock has elapsed; this is the only
    /// path by which `Admin` changes, which is what makes the contract
    /// recoverable if the current admin key is lost or compromised: a fresh
    /// admin key can be handed control without redeploying, by whoever the
    /// existing admin (or, before compromise, its operators) designates.
    pub fn accept_admin_transfer(
        env: Env,
        caller: Address,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        bump_instance(&env);
        caller.require_auth();

        let nonce_key = DataKey::Nonce(caller.clone());
        let expected_nonce: u64 = read_persistent(&env, &nonce_key).unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        write_persistent(&env, &nonce_key, &(expected_nonce + 1));

        let pending: PendingAdminChange = read_persistent(&env, &DataKey::PendingAdmin)
            .ok_or(RegistryError::NoPendingAdminChange)?;

        if caller != pending.candidate {
            return Err(RegistryError::Unauthorized);
        }
        if env.ledger().timestamp() < pending.executable_at {
            return Err(RegistryError::TimelockNotElapsed);
        }

        let old_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RegistryError::NotInitialized)?;

        env.storage().instance().set(&DataKey::Admin, &caller);
        env.storage().persistent().remove(&DataKey::PendingAdmin);

        env.events()
            .publish((Symbol::new(&env, "admin_changed"),), (old_admin, caller));

        Ok(())
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn get_pending_admin(env: Env) -> Option<PendingAdminChange> {
        bump_instance(&env);
        read_persistent(&env, &DataKey::PendingAdmin)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{storage::Persistent as _, Address as _, Ledger as _};

    fn create_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn zero_hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0u8; 32])
    }

    fn setup() -> (Env, ProjectRegistryClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let contract_id = env.register(ProjectRegistry, (&admin,));
        let client = ProjectRegistryClient::new(&env, &contract_id);
        (env, client, admin, user)
    }

    #[test]
    fn test_register_project() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id, 1);

        let project = client.get_project(&1);
        assert_eq!(project.id, 1);
        assert_eq!(project.owner, user);
        assert_eq!(project.name, Symbol::new(&env, "Project"));
        assert_eq!(project.status, ProjectStatus::Pending);
        assert_eq!(project.metadata_ipfs_hash, hash);
    }

    #[test]
    fn test_register_project_invalid_nonce() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let result = client.try_register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &1,
        );
        assert_eq!(result, Err(Ok(RegistryError::InvalidNonce)));
    }

    #[test]
    fn test_register_project_zero_hash() {
        let (env, client, _admin, user) = setup();
        let result = client.try_register_project(
            &user,
            &zero_hash(&env),
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(result, Err(Ok(RegistryError::ProjectNotFound)));
    }

    #[test]
    fn test_register_project_duplicate_pending_hash() {
        let (env, client, _admin, user) = setup();
        let user2 = Address::generate(&env);
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id, 1);

        let result = client.try_register_project(
            &user2,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &0,
        );
        assert_eq!(result, Err(Ok(RegistryError::ProjectAlreadyExists)));
        assert_eq!(client.project_count(), 1);

        let hash2 = create_hash(&env, 2);
        let id2 = client.register_project(
            &user2,
            &hash2,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &0,
        );
        assert_eq!(id2, 2);
    }

    #[test]
    fn test_register_project_reuses_rejected_hash() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let hash = create_hash(&env, 1);

        let rejected_id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.reject_project(&admin, &rejected_id, &0);

        let reused_id = client.register_project(
            &user2,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &0,
        );
        assert_eq!(reused_id, 2);

        let project = client.get_project(&reused_id);
        assert_eq!(project.status, ProjectStatus::Pending);
        assert_eq!(project.metadata_ipfs_hash, hash);
    }

    #[test]
    fn test_approve_project() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.approve_project(&admin, &id, &0);

        let project = client.get_project(&id);
        assert_eq!(project.status, ProjectStatus::Approved);
    }

    #[test]
    fn test_reject_project() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.reject_project(&admin, &id, &0);

        let project = client.get_project(&id);
        assert_eq!(project.status, ProjectStatus::Rejected);
    }

    #[test]
    fn test_configured_oracle_can_revoke_approved_project() {
        let (env, client, admin, user) = setup();
        let oracle = Address::generate(&env);
        let project_id = client.register_project(
            &user,
            &create_hash(&env, 8),
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.approve_project(&admin, &project_id, &0);
        client.set_oracle_consumer(&admin, &oracle, &1);

        client.revoke_project(
            &oracle,
            &project_id,
            &String::from_str(&env, "rejected report"),
            &0,
        );

        assert_eq!(
            client.get_project_status(&project_id),
            ProjectStatus::Rejected
        );
    }

    #[test]
    fn test_approve_non_existent_project() {
        let (_env, client, admin, _user) = setup();
        let result = client.try_approve_project(&admin, &999, &0);
        assert_eq!(result, Err(Ok(RegistryError::ProjectNotFound)));
    }

    #[test]
    fn test_approve_already_approved() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.approve_project(&admin, &id, &0);

        let result = client.try_approve_project(&admin, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_reject_already_rejected() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.reject_project(&admin, &id, &0);

        let result = client.try_reject_project(&admin, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_approve_unauthorized() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        let result = client.try_approve_project(&user, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));
    }

    #[test]
    fn test_get_project_not_found() {
        let (_env, client, _admin, _user) = setup();
        let result = client.try_get_project(&999);
        assert_eq!(result, Err(Ok(RegistryError::ProjectNotFound)));
    }

    #[test]
    fn test_get_project_linkage_uses_numeric_id() {
        let (env, client, admin, user) = setup();
        let metadata_hash = create_hash(&env, 9);
        let project_id = client.register_project(
            &user,
            &metadata_hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.approve_project(&admin, &project_id, &0);

        let linkage = client.get_project_linkage(&project_id);
        assert_eq!(linkage.id, project_id);
        assert_eq!(linkage.metadata_ipfs_hash, metadata_hash);
        assert_eq!(linkage.status, ProjectStatus::Approved);

        assert_eq!(
            client.try_get_project_linkage(&999),
            Err(Ok(RegistryError::ProjectNotFound))
        );
    }

    #[test]
    fn test_project_count() {
        let (env, client, _admin, user) = setup();

        assert_eq!(client.project_count(), 0);

        let hash = create_hash(&env, 1);
        client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(client.project_count(), 1);

        let hash2 = create_hash(&env, 2);
        client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );
        assert_eq!(client.project_count(), 2);
    }

    #[test]
    fn test_list_projects_pagination() {
        let (env, client, _admin, user) = setup();

        for i in 0..5 {
            let hash = create_hash(&env, (i + 1) as u8);
            client.register_project(
                &user,
                &hash,
                &Symbol::new(&env, "Project"),
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &(i as u64),
            );
        }

        let page1 = client.list_projects(&0, &3);
        assert_eq!(page1.len(), 3);
        assert_eq!(page1.get(0).unwrap().id, 1);
        assert_eq!(page1.get(0).unwrap().name, Symbol::new(&env, "Project"));
        assert_eq!(page1.get(1).unwrap().id, 2);
        assert_eq!(page1.get(2).unwrap().id, 3);

        let page2 = client.list_projects(&1, &3);
        assert_eq!(page2.len(), 2);
        assert_eq!(page2.get(0).unwrap().id, 4);
        assert_eq!(page2.get(1).unwrap().id, 5);
    }

    #[test]
    fn test_get_owner_projects() {
        let (env, client, _admin, user) = setup();
        let user2 = Address::generate(&env);

        let hash1 = create_hash(&env, 1);
        let id1 = client.register_project(
            &user,
            &hash1,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        let hash2 = create_hash(&env, 2);
        let id2 = client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );

        let hash3 = create_hash(&env, 3);
        let id3 = client.register_project(
            &user2,
            &hash3,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "KE"),
            &0,
        );

        let user_projects = client.get_owner_projects(&user);
        assert_eq!(user_projects.len(), 2);
        assert_eq!(user_projects.get(0).unwrap(), id1);
        assert_eq!(user_projects.get(1).unwrap(), id2);

        let user2_projects = client.get_owner_projects(&user2);
        assert_eq!(user2_projects.len(), 1);
        assert_eq!(user2_projects.get(0).unwrap(), id3);
    }

    #[test]
    fn test_list_projects_caps_page_size() {
        let (env, client, _admin, user) = setup();

        for i in 0..60 {
            let hash = create_hash(&env, ((i % 255) + 1) as u8);
            client.register_project(
                &user,
                &hash,
                &Symbol::new(&env, "Project"),
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &(i as u64),
            );
        }

        let result = client.list_projects(&0, &100);
        assert_eq!(result.len(), 50);
    }

    #[test]
    fn test_register_twice_updates_nonce() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id1 = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id1, 1);

        let hash2 = create_hash(&env, 2);
        let id2 = client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "Project"),
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );
        assert_eq!(id2, 2);
    }

    #[test]
    fn test_project_data_is_persistent_and_bumped_on_write() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 42);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Forest"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "GT"),
            &0,
        );

        let project_key = DataKey::Project(project_id_to_bytes(&env, id));
        let count_key = DataKey::ProjectCount;
        let owner_key = DataKey::OwnerProjects(user.clone());
        let hash_key = DataKey::ProjectByHash(hash.clone());

        env.as_contract(&client.address, || {
            for key in [&project_key, &count_key, &owner_key, &hash_key] {
                assert!(env.storage().persistent().has(key));
                assert!(!env.storage().instance().has(key));
                assert!(env.storage().persistent().get_ttl(key) >= PERSISTENT_TTL_EXTEND_TO);
            }

            assert_eq!(
                env.storage().persistent().get::<_, u64>(&hash_key),
                Some(id)
            );
        });
    }

    #[test]
    fn test_persistent_ttls_are_bumped_on_reads() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 43);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Wetland"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "GT"),
            &0,
        );

        let project_key = DataKey::Project(project_id_to_bytes(&env, id));
        let count_key = DataKey::ProjectCount;
        let owner_key = DataKey::OwnerProjects(user.clone());
        let hash_key = DataKey::ProjectByHash(hash.clone());
        let aged_by = PERSISTENT_TTL_EXTEND_TO - PERSISTENT_TTL_THRESHOLD / 2;
        env.ledger()
            .with_mut(|ledger| ledger.sequence_number += aged_by);

        env.as_contract(&client.address, || {
            for key in [&project_key, &count_key, &owner_key, &hash_key] {
                assert!(env.storage().persistent().get_ttl(key) < PERSISTENT_TTL_THRESHOLD);
            }
        });

        assert_eq!(client.get_project(&id).name, Symbol::new(&env, "Wetland"));
        assert_eq!(
            client.get_project_status_by_hash(&hash),
            ProjectStatus::Pending
        );
        assert_eq!(client.list_projects(&0, &1).len(), 1);
        assert_eq!(client.project_count(), 1);
        assert_eq!(client.get_owner_projects(&user).get(0), Some(id));

        env.as_contract(&client.address, || {
            for key in [&project_key, &count_key, &owner_key, &hash_key] {
                assert!(env.storage().persistent().get_ttl(key) >= PERSISTENT_TTL_EXTEND_TO);
            }
        });
    }

    #[test]
    fn test_project_status_by_hash_uses_reverse_index() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 44);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "Mangrove"),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "GT"),
            &0,
        );

        env.as_contract(&client.address, || {
            assert_eq!(
                env.storage()
                    .persistent()
                    .get::<_, u64>(&DataKey::ProjectByHash(hash.clone())),
                Some(id)
            );
            // An indexed lookup must not depend on the project count.
            env.storage()
                .persistent()
                .set(&DataKey::ProjectCount, &0u64);
        });

        assert_eq!(
            client.get_project_status_by_hash(&hash),
            ProjectStatus::Pending
        );
        client.approve_project(&admin, &id, &0);
        assert_eq!(
            client.get_project_status_by_hash(&hash),
            ProjectStatus::Approved
        );
    }

    // ── Admin rotation / recovery (issue #206) ───────────────────────────────

    #[test]
    fn test_admin_transfer_propose_accept_rotates_admin() {
        let (env, client, admin, new_admin) = setup();

        env.ledger().set_timestamp(1_000_000);
        client.propose_admin_transfer(&admin, &new_admin, &0);

        let pending = client.get_pending_admin().expect("pending admin change");
        assert_eq!(pending.candidate, new_admin);
        assert_eq!(
            pending.executable_at,
            1_000_000 + ADMIN_TRANSFER_TIMELOCK_SECONDS
        );
        // Not rotated yet.
        assert_eq!(client.get_admin(), Some(admin.clone()));

        env.ledger()
            .set_timestamp(1_000_000 + ADMIN_TRANSFER_TIMELOCK_SECONDS);
        client.accept_admin_transfer(&new_admin, &0);

        assert_eq!(client.get_admin(), Some(new_admin.clone()));
        assert_eq!(client.get_pending_admin(), None);

        // The old admin has lost admin rights ...
        let result = client.try_set_oracle_consumer(&admin, &Address::generate(&env), &1);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));

        // ... and the new admin can act immediately (nonce 1: its 0 was
        // spent on `accept_admin_transfer`).
        client.set_oracle_consumer(&new_admin, &Address::generate(&env), &1);
    }

    #[test]
    fn test_accept_admin_transfer_before_timelock_rejected() {
        let (env, client, admin, new_admin) = setup();

        env.ledger().set_timestamp(1_000_000);
        client.propose_admin_transfer(&admin, &new_admin, &0);

        // One second short of the timelock.
        env.ledger()
            .set_timestamp(1_000_000 + ADMIN_TRANSFER_TIMELOCK_SECONDS - 1);
        let result = client.try_accept_admin_transfer(&new_admin, &0);
        assert_eq!(result, Err(Ok(RegistryError::TimelockNotElapsed)));
        assert_eq!(client.get_admin(), Some(admin));
    }

    #[test]
    fn test_accept_admin_transfer_wrong_candidate_rejected() {
        let (env, client, admin, new_admin) = setup();
        let impostor = Address::generate(&env);

        env.ledger().set_timestamp(1_000_000);
        client.propose_admin_transfer(&admin, &new_admin, &0);
        env.ledger()
            .set_timestamp(1_000_000 + ADMIN_TRANSFER_TIMELOCK_SECONDS);

        let result = client.try_accept_admin_transfer(&impostor, &0);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));
        assert_eq!(client.get_admin(), Some(admin));
    }

    #[test]
    fn test_propose_admin_transfer_requires_admin() {
        let (env, client, _admin, attacker) = setup();
        let candidate = Address::generate(&env);

        let result = client.try_propose_admin_transfer(&attacker, &candidate, &0);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    fn test_cancel_admin_transfer_clears_pending() {
        let (env, client, admin, new_admin) = setup();

        env.ledger().set_timestamp(1_000_000);
        client.propose_admin_transfer(&admin, &new_admin, &0);
        client.cancel_admin_transfer(&admin, &1);
        assert_eq!(client.get_pending_admin(), None);

        env.ledger()
            .set_timestamp(1_000_000 + ADMIN_TRANSFER_TIMELOCK_SECONDS);
        let result = client.try_accept_admin_transfer(&new_admin, &0);
        assert_eq!(result, Err(Ok(RegistryError::NoPendingAdminChange)));
        assert_eq!(client.get_admin(), Some(admin));
    }

    #[test]
    fn test_cancel_admin_transfer_requires_admin() {
        let (env, client, admin, new_admin) = setup();
        let attacker = Address::generate(&env);

        client.propose_admin_transfer(&admin, &new_admin, &0);
        let result = client.try_cancel_admin_transfer(&attacker, &0);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));
        assert!(client.get_pending_admin().is_some());
    }

    #[test]
    fn test_accept_admin_transfer_without_proposal_rejected() {
        let (_env, client, _admin, candidate) = setup();

        let result = client.try_accept_admin_transfer(&candidate, &0);
        assert_eq!(result, Err(Ok(RegistryError::NoPendingAdminChange)));
    }
}
