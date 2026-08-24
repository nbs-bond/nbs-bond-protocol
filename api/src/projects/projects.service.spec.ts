import { Test, TestingModule } from '@nestjs/testing';
import { nativeToScVal, Address, xdr } from '@stellar/stellar-sdk';
import { ProjectsService, toProjectNameSymbol } from './projects.service';
import { scValToNative } from '@stellar/stellar-sdk';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { IpfsService } from './ipfs.service';
import { NonceService } from '../common/services/nonce.service';
import { ProjectStatusEnum } from './interfaces/project.interface';

const mockRedis = {
  connect: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  setEx: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
};

jest.mock('@redis/client', () => ({
  createClient: jest.fn(() => mockRedis),
}));

describe('ProjectsService', () => {
  let service: ProjectsService;
  let contractService: jest.Mocked<ContractService>;
  let stellarService: jest.Mocked<StellarService>;
  let ipfsService: jest.Mocked<IpfsService>;
  let nonceService: jest.Mocked<NonceService>;

  const mockOwnerAddress = 'GBO6AXD5GLGDR45HENK4RZMFXOTZIJYL3NWGNGWXYI3RTFNIYK32YGJQ';
  const mockAdminAddress = 'GAJRCN6P67RAKN2WHGHRP7D7UGIFNIGD5CIBI2XYPAEG7J5VMXO53KWQ';

  function mockProjectScVal(id = 1, status = ProjectStatusEnum.Pending) {
    return xdr.ScVal.scvVec([
      nativeToScVal(BigInt(id), { type: 'u64' }),
      Address.fromString(mockOwnerAddress).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from('QmYwAPJzv5CZsnAzt8auVZRnGi2C8Qp9G2YB3hM9oWZpDa')),
      nativeToScVal(status, { type: 'symbol' }),
      nativeToScVal('VM0003', { type: 'symbol' }),
      nativeToScVal('BRA', { type: 'symbol' }),
    ]);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.ADMIN_SECRET_KEY = 'SADMINSECRET';
    process.env.USER_SECRET_KEY = 'SUSERSECRET';
    process.env.PROJECT_REGISTRY_ADDRESS = 'CPROJECTREGISTRY';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        {
          provide: ContractService,
          useValue: {
            invokeContractMethod: jest.fn().mockResolvedValue({
              result: nativeToScVal(BigInt(1), { type: 'u64' }),
            }),
            simulateCall: jest.fn(),
          },
        },
        {
          provide: StellarService,
          useValue: {
            getKeypairFromSecret: jest.fn().mockReturnValue({
              publicKey: () => mockAdminAddress,
            }),
          },
        },
        {
          provide: IpfsService,
          useValue: {
            uploadJson: jest.fn().mockResolvedValue({
              hash: 'QmYwAPJzv5CZsnAzt8auVZRnGi2C8Qp9G2YB3hM9oWZpDa',
            }),
            getContent: jest.fn().mockResolvedValue({
              name: 'Amazon Reforestation',
              totalAreaHa: 500,
              carbonSequestrationEstimate: 1000,
            }),
            uploadFile: jest.fn().mockResolvedValue({
              hash: 'QmDocHash123',
              gatewayUrl: 'https://ipfs.io/ipfs/QmDocHash123',
            }),
          },
        },
        {
          provide: NonceService,
          useValue: {
            next: jest.fn().mockResolvedValue(1),
          },
        },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
    contractService = module.get(ContractService);
    stellarService = module.get(StellarService);
    ipfsService = module.get(IpfsService);
    nonceService = module.get(NonceService);
  });

  describe('register', () => {
    it('registers a new project and caches the result in Redis', async () => {
      contractService.simulateCall.mockResolvedValue(mockProjectScVal(1));

      const dto = {
        name: 'Amazon Reforestation',
        methodology: 'VM0003',
        country: 'BRA',
        location: { lat: -3.4653, lng: -62.2159 },
        totalAreaHa: 500,
        carbonSequestrationEstimate: 1000,
      };

      const result = await service.register(dto, mockOwnerAddress);

      expect(ipfsService.uploadJson).toHaveBeenCalled();
      expect(nonceService.next).toHaveBeenCalledWith('CPROJECTREGISTRY', mockOwnerAddress);
      expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
        'CPROJECTREGISTRY',
        'register_project',
        'SUSERSECRET',
        expect.any(Array),
        1,
      );
      expect(mockRedis.setEx).toHaveBeenCalledWith(
        'project:1',
        300,
        expect.any(String),
      );
      expect(result.id).toBe(1);
      expect(result.name).toBe('Amazon Reforestation');
    });

    it('sends all 5 contract args in signature order, including the name Symbol (issue #235)', async () => {
      contractService.simulateCall.mockResolvedValue(mockProjectScVal(1));

      const dto = {
        name: 'Amazon Reforestation',
        methodology: 'VM0003',
        country: 'BRA',
        location: { lat: -3.4653, lng: -62.2159 },
        totalAreaHa: 500,
        carbonSequestrationEstimate: 1000,
      };

      await service.register(dto, mockOwnerAddress);

      const args = (contractService.invokeContractMethod as jest.Mock).mock.calls[0][3];
      // register_project(caller, metadata_ipfs_hash, name, methodology, country)
      expect(args).toHaveLength(5);
      expect(scValToNative(args[2])).toBe('Amazon_Reforestation'); // name, Symbol-slugged
      expect(scValToNative(args[3])).toBe('VM0003'); // methodology shifted to position 4
      expect(scValToNative(args[4])).toBe('BRA'); // country shifted to position 5
    });
  });

  describe('toProjectNameSymbol', () => {
    it('slugs names to the Soroban Symbol charset ([a-zA-Z0-9_], max 32)', () => {
      expect(toProjectNameSymbol('Amazon Reforestation')).toBe('Amazon_Reforestation');
      expect(toProjectNameSymbol('Mangrove Restoration #4!')).toBe('Mangrove_Restoration_4');
      expect(toProjectNameSymbol('  spaced  out  ')).toBe('spaced_out');
      expect(toProjectNameSymbol('a'.repeat(40))).toHaveLength(32);
      expect(toProjectNameSymbol('™£€')).toBe('project'); // nothing usable → fallback
      // Every output is a valid Symbol.
      for (const name of ['Amazon Reforestation', 'x', '™£€', 'a'.repeat(99)]) {
        expect(toProjectNameSymbol(name)).toMatch(/^[a-zA-Z0-9_]{1,32}$/);
      }
    });
  });

  describe('findAll', () => {
    it('returns cached pagination result if found in Redis', async () => {
      const cached = JSON.stringify({ data: [], meta: { page: 1, limit: 20, total: 0 } });
      mockRedis.get.mockResolvedValueOnce(cached);

      const result = await service.findAll(1, 20);

      expect(result).toEqual(JSON.parse(cached));
      expect(contractService.simulateCall).not.toHaveBeenCalled();
    });

    it('fetches projects count and details from contract if not cached', async () => {
      mockRedis.get.mockResolvedValue(null);
      contractService.simulateCall
        .mockResolvedValueOnce(nativeToScVal(BigInt(1), { type: 'u64' }))
        .mockResolvedValueOnce(mockProjectScVal(1));

      const result = await service.findAll(1, 20);

      expect(result.data.length).toBe(1);
      expect(result.meta.total).toBe(1);
      expect(mockRedis.setEx).toHaveBeenCalledWith('projects:1:20', 60, expect.any(String));
    });
  });

  describe('findOne', () => {
    it('returns project from Redis cache if available', async () => {
      const cachedProject = { id: 1, name: 'Cached Project' };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(cachedProject));

      const result = await service.findOne(1);

      expect(result).toEqual(cachedProject);
      expect(contractService.simulateCall).not.toHaveBeenCalled();
    });

    it('fetches project details from contract if cache miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      contractService.simulateCall.mockResolvedValue(mockProjectScVal(1));

      const result = await service.findOne(1);

      expect(result.id).toBe(1);
      expect(mockRedis.setEx).toHaveBeenCalledWith('project:1', 300, expect.any(String));
    });
  });

  describe('approve', () => {
    it('invokes approve_project contract method with admin secret', async () => {
      contractService.simulateCall.mockResolvedValue(mockProjectScVal(1, ProjectStatusEnum.Approved));

      const result = await service.approve(1);

      expect(stellarService.getKeypairFromSecret).toHaveBeenCalledWith('SADMINSECRET');
      expect(nonceService.next).toHaveBeenCalledWith('CPROJECTREGISTRY', mockAdminAddress);
      expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
        'CPROJECTREGISTRY',
        'approve_project',
        'SADMINSECRET',
        expect.any(Array),
        1,
      );
      expect(mockRedis.del).toHaveBeenCalledWith('project:1');
      expect(result.status).toBe(ProjectStatusEnum.Approved);
    });
  });

  describe('reject', () => {
    it('invokes reject_project contract method with admin secret', async () => {
      contractService.simulateCall.mockResolvedValue(mockProjectScVal(1, ProjectStatusEnum.Rejected));

      const result = await service.reject(1);

      expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
        'CPROJECTREGISTRY',
        'reject_project',
        'SADMINSECRET',
        expect.any(Array),
        1,
      );
      expect(mockRedis.del).toHaveBeenCalledWith('project:1');
      expect(result.status).toBe(ProjectStatusEnum.Rejected);
    });
  });

  describe('uploadDocuments', () => {
    it('uploads files to IPFS and updates document list in Redis', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const fakeFiles = [
        { buffer: Buffer.from('file1'), originalname: 'doc1.pdf' },
      ];

      const result = await service.uploadDocuments(1, fakeFiles);

      expect(ipfsService.uploadFile).toHaveBeenCalledWith(fakeFiles[0].buffer, 'doc1.pdf');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'project:1:documents',
        JSON.stringify(['QmDocHash123']),
      );
      expect(result).toEqual({
        projectId: 1,
        documentHashes: ['QmDocHash123'],
        gatewayUrls: ['https://ipfs.io/ipfs/QmDocHash123'],
      });
    });
  });
});
