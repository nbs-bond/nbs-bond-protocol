#![no_std]
#![allow(deprecated)]
use nbbs_shared::{ProjectStatus, RegistryError};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Address, BytesN, Env, String, Symbol,
    Vec,
};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Project(BytesN<32>),
    ProjectCount,
    ProjectId(u64),
    Nonce(Address),
    OwnerProjects(Address),
    OracleConsumerId,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Project {
    pub id: u64,
    pub owner: Address,
    pub metadata_ipfs_hash: BytesN<32>,
    pub status: ProjectStatus,
    pub methodology: Symbol,
    pub country: Symbol,
}

#[derive(Clone)]
#[contracttype]
pub struct ProjectSummary {
    pub id: u64,
    pub name: Symbol,
    pub status: ProjectStatus,
    pub country: Symbol,
}

fn project_id_to_bytes(env: &Env, id: u64) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[..8].copy_from_slice(&id.to_be_bytes());
    BytesN::from_array(env, &arr)
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

fn ensure_metadata_hash_available(
    env: &Env,
    metadata_ipfs_hash: &BytesN<32>,
) -> Result<(), RegistryError> {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ProjectCount)
        .unwrap_or(0);

    for i in 1..=count {
        let key = project_id_to_bytes(env, i);
        if let Some(project) = env
            .storage()
            .instance()
            .get::<_, Project>(&DataKey::Project(key))
        {
            let active_project = matches!(
                project.status,
                ProjectStatus::Pending | ProjectStatus::Approved
            );
            if active_project
                && project.metadata_ipfs_hash.to_array() == metadata_ipfs_hash.to_array()
            {
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
    }

    pub fn register_project(
        env: Env,
        caller: Address,
        metadata_ipfs_hash: BytesN<32>,
        methodology: Symbol,
        country: Symbol,
        nonce: u64,
    ) -> Result<u64, RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }

        let hash_arr = metadata_ipfs_hash.to_array();
        if hash_arr.iter().all(|&b| b == 0) {
            return Err(RegistryError::ProjectNotFound);
        }
        ensure_metadata_hash_available(&env, &metadata_ipfs_hash)?;

        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);
        let new_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::ProjectCount, &new_id);

        let project = Project {
            id: new_id,
            owner: caller.clone(),
            metadata_ipfs_hash,
            status: ProjectStatus::Pending,
            methodology,
            country,
        };

        let key = project_id_to_bytes(&env, new_id);
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        let mut owner_projects: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::OwnerProjects(caller.clone()))
            .unwrap_or(vec![&env]);
        owner_projects.push_back(new_id);
        env.storage()
            .instance()
            .set(&DataKey::OwnerProjects(caller), &owner_projects);

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
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Approved {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Inactive;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        // Emit suspension event
        env.events()
            .publish((symbol_short!("P_SUSPEND"),), (project_id, caller, reason));

        Ok(())
    }

    /// Revoke an approved project (admin-only). Revoked projects are permanently
    /// removed from the active registry and cannot be reinstated.
    pub fn revoke_project(
        env: Env,
        caller: Address,
        project_id: u64,
        reason: String,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Approved {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Rejected;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        // Emit revocation event
        env.events()
            .publish((symbol_short!("P_REVOKE"),), (project_id, caller, reason));

        Ok(())
    }

    /// Check if a project is active (Approved and not suspended).
    pub fn is_project_active(env: &Env, project_id: u64) -> bool {
        let key = project_id_to_bytes(env, project_id);
        match env
            .storage()
            .instance()
            .get::<DataKey, Project>(&DataKey::Project(key))
        {
            Some(project) => project.status == ProjectStatus::Approved,
            None => false,
        }
    }

    /// Get project status for oracle integration.
    pub fn get_project_status(env: &Env, project_id: u64) -> Result<ProjectStatus, RegistryError> {
        let key = project_id_to_bytes(env, project_id);
        env.storage()
            .instance()
            .get::<DataKey, Project>(&DataKey::Project(key))
            .map(|project: Project| project.status)
            .ok_or(RegistryError::ProjectNotFound)
    }

    /// Set the oracle consumer contract address (admin-only).
    pub fn set_oracle_consumer(
        env: Env,
        caller: Address,
        oracle_consumer_id: Address,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

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
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Pending {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Approved;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        Ok(())
    }

    pub fn reject_project(
        env: Env,
        caller: Address,
        project_id: u64,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Pending {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Rejected;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        Ok(())
    }

    pub fn get_project(env: Env, project_id: u64) -> Result<Project, RegistryError> {
        let key = project_id_to_bytes(&env, project_id);
        env.storage()
            .instance()
            .get(&DataKey::Project(key))
            .ok_or(RegistryError::ProjectNotFound)
    }

    pub fn get_project_status_by_hash(
        env: Env,
        hash: BytesN<32>,
    ) -> Result<ProjectStatus, RegistryError> {
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);

        for i in 1..=count {
            let key = project_id_to_bytes(&env, i);
            if let Some(project) = env
                .storage()
                .instance()
                .get::<_, Project>(&DataKey::Project(key))
            {
                if project.metadata_ipfs_hash == hash {
                    return Ok(project.status);
                }
            }
        }
        Err(RegistryError::ProjectNotFound)
    }

    pub fn list_projects(env: Env, page: u32, page_size: u32) -> Vec<ProjectSummary> {
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);

        let page_size = page_size.min(50);
        let start = (page as u64) * (page_size as u64);
        let mut result: Vec<ProjectSummary> = vec![&env];

        if start >= count {
            return result;
        }

        let end = (start + page_size as u64).min(count);
        for i in (start + 1)..=end {
            let key = project_id_to_bytes(&env, i);
            if let Some(project) = env
                .storage()
                .instance()
                .get::<_, Project>(&DataKey::Project(key))
            {
                result.push_back(ProjectSummary {
                    id: project.id,
                    name: Symbol::new(&env, ""),
                    status: project.status,
                    country: project.country,
                });
            }
        }

        result
    }

    pub fn project_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0)
    }

    /// Get project by metadata IPFS hash.
    pub fn get_project_by_hash(
        env: Env,
        metadata_ipfs_hash: BytesN<32>,
    ) -> Result<Project, RegistryError> {
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);

        for id in 1..=count {
            let key = project_id_to_bytes(&env, id);
            if let Some(project) = env
                .storage()
                .instance()
                .get::<DataKey, Project>(&DataKey::Project(key))
            {
                if project.metadata_ipfs_hash == metadata_ipfs_hash {
                    return Ok(project);
                }
            }
        }

        Err(RegistryError::ProjectNotFound)
    }

    pub fn get_owner_projects(env: Env, owner: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::OwnerProjects(owner))
            .unwrap_or(vec![&env])
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

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
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id, 1);

        let project = client.get_project(&1);
        assert_eq!(project.id, 1);
        assert_eq!(project.owner, user);
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
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id, 1);

        let result = client.try_register_project(
            &user2,
            &hash,
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
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.reject_project(&admin, &rejected_id, &0);

        let reused_id = client.register_project(
            &user2,
            &hash,
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
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.reject_project(&admin, &id, &0);

        let project = client.get_project(&id);
        assert_eq!(project.status, ProjectStatus::Rejected);
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
    fn test_project_count() {
        let (env, client, _admin, user) = setup();

        assert_eq!(client.project_count(), 0);

        let hash = create_hash(&env, 1);
        client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(client.project_count(), 1);

        let hash2 = create_hash(&env, 2);
        client.register_project(
            &user,
            &hash2,
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
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &(i as u64),
            );
        }

        let page1 = client.list_projects(&0, &3);
        assert_eq!(page1.len(), 3);
        assert_eq!(page1.get(0).unwrap().id, 1);
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
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        let hash2 = create_hash(&env, 2);
        let id2 = client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );

        let hash3 = create_hash(&env, 3);
        let id3 = client.register_project(
            &user2,
            &hash3,
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
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id1, 1);

        let hash2 = create_hash(&env, 2);
        let id2 = client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );
        assert_eq!(id2, 2);
    }
}
