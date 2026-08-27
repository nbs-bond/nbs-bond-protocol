import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
} from '@nestjs/common';
import { OracleService } from './oracle.service';
import { ContractService } from '../stellar/contract.service';
import { IpfsService } from '../projects/ipfs.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { ReportStatus } from './interfaces/oracle.interface';
import {
  xdr,
  nativeToScVal,
  scValToNative,
  Address,
  Keypair,
} from '@stellar/stellar-sdk';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
  return {
    createClient: jest.fn().mockReturnValue(mockClient),
  };
});

const PROVIDER_ADDRESS = 'GBO6AXD5GLGDR45HENK4RZMFXOTZIJYL3NWGNGWXYI3RTFNIYK32YGJQ';
const SECOND_PROVIDER_ADDRESS = 'GCLVICGPC75ND5COFZSEIYPPTNWIJ7MU4FOIUQQGRB53CSJ4AWUHJ7NM';
const ADMIN_ADDRESS = 'GAJRCN6P67RAKN2WHGHRP7D7UGIFNIGD5CIBI2XYPAEG7J5VMXO53KWQ';

function buildService(overrides: {
  contractService?: Partial<ContractService>;
  stellarService?: Partial<StellarService>;
  nonceService?: Partial<NonceService>;
  ipfsService?: Partial<IpfsService>;
} = {}) {
  return new OracleService(
    (overrides.contractService ?? {}) as ContractService,
    (overrides.ipfsService ?? {}) as IpfsService,
    (overrides.stellarService ?? {}) as StellarService,
    (overrides.nonceService ?? {}) as NonceService,
  );
}

function providerStructScVal(
  address: string,
  methodology: string,
  stake: bigint,
  active: boolean,
  registeredAt: bigint,
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    Address.fromString(address).toScVal(),
    nativeToScVal(methodology, { type: 'symbol' }),
    nativeToScVal(stake, { type: 'i128' }),
    xdr.ScVal.scvBool(active),
    nativeToScVal(registeredAt, { type: 'u64' }),
  ]);
}

describe('OracleService', () => {
  let service: OracleService;
  const contractService = { invokeContractMethod: jest.fn() };
  const nonceService = { next: jest.fn() };
  const investorAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const stellarService = {
    getKeypairFromSecret: jest.fn(() => ({ publicKey: () => investorAddress })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: ContractService, useValue: contractService },
        { provide: IpfsService, useValue: {} },
        { provide: StellarService, useValue: stellarService },
        {
          provide: NonceService,
          useValue: nonceService,
        },
      ],
    }).compile();

    service = moduleRef.get(OracleService);
  });

  beforeEach(() => {
    process.env.INVESTOR_SECRET_KEY = 'test-investor-secret';
    contractService.invokeContractMethod.mockReset().mockResolvedValue({});
    nonceService.next.mockReset().mockResolvedValue(0);
    (service as any).localChallengeAttempts.clear();
  });

  describe('challengeReport', () => {
    const dto = {
      counterEvidenceHash: 'QmYwAPJzv5CZsnAzt8auVZRnGi2C8Qp9G2YB3hM9oWZpDa',
      reason: 'Independent evidence conflicts with this report',
    };

    it('signs with the configured investor key, never the admin key', async () => {
      process.env.ADMIN_SECRET_KEY = 'admin-secret-must-not-be-used';
      try {
        await service.challengeReport(7, dto, investorAddress);

        expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
          expect.any(String),
          'challenge_report',
          'test-investor-secret',
          expect.any(Array),
          0,
        );
      } finally {
        delete process.env.ADMIN_SECRET_KEY;
      }
    });

    it('rejects counter-evidence that is not CIDv0', async () => {
      await expect(service.challengeReport(7, {
        ...dto,
        counterEvidenceHash: 'not-a-cid',
      }, investorAddress)).rejects.toBeInstanceOf(BadRequestException);
      expect(contractService.invokeContractMethod).not.toHaveBeenCalled();
    });

    it('rejects a JWT wallet that differs from the configured signer', async () => {
      const otherAddress = Keypair.random().publicKey();
      await expect(service.challengeReport(7, dto, otherAddress))
        .rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows at most three challenges per wallet in 24 hours', async () => {
      await service.challengeReport(1, dto, investorAddress);
      await service.challengeReport(2, dto, investorAddress);
      await service.challengeReport(3, dto, investorAddress);

      await expect(service.challengeReport(4, dto, investorAddress))
        .rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
      expect(contractService.invokeContractMethod).toHaveBeenCalledTimes(3);
    });

    it('maps a ChallengeAlreadyExists contract error (code 20) to a ConflictException', async () => {
      contractService.invokeContractMethod.mockReset().mockRejectedValue(
        new BadRequestException(
          'Contract simulation failed: Error(Contract, #20) (contract error code 20)',
        ),
      );

      await expect(
        service.challengeReport(7, dto, investorAddress),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.challengeReport(8, dto, investorAddress),
      ).rejects.toThrow('already has a challenge on file');
    });

    it('propagates other contract failures from challenge_report unchanged', async () => {
      contractService.invokeContractMethod.mockReset().mockRejectedValue(
        new BadRequestException(
          'Contract simulation failed: Error(Contract, #6) (contract error code 6)',
        ),
      );

      await expect(
        service.challengeReport(9, dto, investorAddress),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('contract error code 6'),
      });
    });
  });

  describe('decodeReport', () => {
    it('maps the contract Report struct to a ReportResponse, skipping the biodiversity field', () => {
      const raw = [
        BigInt(4),
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        BigInt(42),
        Buffer.from('a1b2'.padEnd(64, '0'), 'hex'),
        BigInt(1700000000),
        BigInt(1700086400),
        BigInt(1200),
        ['Absent'],
        'VM0003',
        Buffer.from('c3d4'.padEnd(64, '0'), 'hex'),
        1,
        BigInt(1700001000),
        BigInt(0),
      ];

      expect((service as any).decodeReport(raw)).toEqual({
        id: 4,
        providerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        projectId: 'a1b2'.padEnd(64, '0'),
        periodStart: 1700000000,
        periodEnd: 1700086400,
        carbonSequestered: 1200,
        methodology: 'VM0003',
        ipfsHash: 'c3d4'.padEnd(64, '0'),
        status: ReportStatus.Verified,
        createdAt: new Date(1700001000 * 1000).toISOString(),
      });
    });

    it.each([
      [0, ReportStatus.Pending],
      [1, ReportStatus.Verified],
      [2, ReportStatus.Challenged],
      [3, ReportStatus.Rejected],
    ])('maps status index %i to %s', (index, expected) => {
      const raw = [
        BigInt(1),
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        BigInt(1),
        Buffer.alloc(32),
        BigInt(0),
        BigInt(0),
        BigInt(0),
        ['Absent'],
        'VM0003',
        Buffer.alloc(32),
        index,
        BigInt(0),
        BigInt(0),
      ];

      expect((service as any).decodeReport(raw).status).toBe(expected);
    });
  });

  describe('decodeSlashRecord', () => {
    it('maps a SlashRecord struct to a SlashRecord response', () => {
      const raw = {
        report_id: BigInt(7),
        penalty: BigInt(10_000),
        remaining_stake: BigInt(90_000),
        timestamp: BigInt(1700000000),
        active_after: true,
      };

      expect((service as any).decodeSlashRecord(raw)).toEqual({
        reportId: 7,
        penalty: 10_000,
        remainingStake: 90_000,
        timestamp: new Date(1700000000 * 1000).toISOString(),
        activeAfter: true,
      });
    });

    it('handles array-encoded structs', () => {
      const raw = [
        BigInt(7),
        BigInt(10_000),
        BigInt(90_000),
        BigInt(1700000000),
        true,
      ];

      expect((service as any).decodeSlashRecord(raw)).toEqual({
        reportId: 7,
        penalty: 10_000,
        remainingStake: 90_000,
        timestamp: new Date(1700000000 * 1000).toISOString(),
        activeAfter: true,
      });
    });
  });

  describe('decodeChallengeRecord', () => {
    it('maps a Challenge struct to a ChallengeRecord response', () => {
      const raw = {
        report_id: BigInt(7),
        challenger: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        counter_evidence_hash: Buffer.from('a1b2'.padEnd(64, '0'), 'hex'),
        submitted_at: BigInt(1699990000),
        resolved: true,
        resolution: 3,
      };

      expect((service as any).decodeChallengeRecord(raw)).toEqual({
        reportId: 7,
        challengerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        counterEvidenceHash: 'a1b2'.padEnd(64, '0'),
        submittedAt: new Date(1699990000 * 1000).toISOString(),
        resolved: true,
        resolution: ReportStatus.Rejected,
      });
    });

    it('returns null resolution for unresolved challenges', () => {
      const raw = {
        report_id: BigInt(7),
        challenger: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        counter_evidence_hash: Buffer.alloc(32),
        submitted_at: BigInt(1699990000),
        resolved: false,
        resolution: 0,
      };

      expect((service as any).decodeChallengeRecord(raw).resolution).toBeNull();
    });
  });

  describe('toRecord / field', () => {
    it('prefers object keys over array indices', () => {
      expect((service as any).field({ slashes: 4 }, 'slashes', 2)).toBe(4);
      expect((service as any).field([1, 2, 4], 'slashes', 2)).toBe(4);
    });
  });

  describe('listProviders', () => {
    it('returns registered providers with stake and on-chain metadata', async () => {
      const contractService = {
        simulateCall: jest.fn()
          .mockResolvedValueOnce(
            xdr.ScVal.scvVec([Address.fromString(PROVIDER_ADDRESS).toScVal()]),
          )
          .mockResolvedValueOnce(
            providerStructScVal(PROVIDER_ADDRESS, 'VERRA-VCS', BigInt(50_000), true, BigInt(1_700_000_000)),
          ),
      };

      const service = buildService({ contractService });
      const providers = await service.listProviders();

      const methods = contractService.simulateCall.mock.calls.map(
        ([options]: any[]) => options.method,
      );
      expect(methods).toEqual(['list_providers', 'get_provider']);
      expect(providers).toEqual([
        {
          providerAddress: PROVIDER_ADDRESS,
          methodology: 'VERRA-VCS',
          name: `Oracle ${PROVIDER_ADDRESS.slice(0, 6)}`,
          stake: 50_000,
          active: true,
          registeredAt: new Date(1_700_000_000 * 1000).toISOString(),
        },
      ]);
    });

    it('skips providers whose on-chain lookup fails', async () => {
      const contractService = {
        simulateCall: jest.fn()
          .mockResolvedValueOnce(
            xdr.ScVal.scvVec([
              Address.fromString(PROVIDER_ADDRESS).toScVal(),
              Address.fromString(SECOND_PROVIDER_ADDRESS).toScVal(),
            ]),
          )
          .mockRejectedValueOnce(new BadRequestException('Contract simulation failed: Error(Contract, #4) (contract error code 4)'))
          .mockResolvedValueOnce(
            providerStructScVal(SECOND_PROVIDER_ADDRESS, 'SATELLITE', BigInt(0), true, BigInt(1_700_000_000)),
          ),
      };

      const service = buildService({ contractService });
      const providers = await service.listProviders();

      expect(providers).toHaveLength(1);
      expect(providers[0].providerAddress).toBe(SECOND_PROVIDER_ADDRESS);
      expect(providers[0].methodology).toBe('SATELLITE');
    });
  });

  describe('mergeProviderHealth', () => {
    const provider = {
      providerAddress: PROVIDER_ADDRESS,
      methodology: 'VERRA-VCS',
      name: `Oracle ${PROVIDER_ADDRESS.slice(0, 6)}`,
      active: true,
      registeredAt: new Date(1_700_000_000 * 1000).toISOString(),
    };

    const stalenessReport = (providers: any[]) => ({
      asOf: new Date().toISOString(),
      projects: [],
      providers,
    });

    it('adds healthy off-chain health status from the monitoring report', () => {
      const service = buildService({});
      const merged = service.mergeProviderHealth([provider], stalenessReport([
        {
          providerAddress: PROVIDER_ADDRESS,
          lastVerifiedAt: '2024-01-02T00:00:00.000Z',
          expectedNextReportAt: '2025-01-01T00:00:00.000Z',
          stalenessSeconds: 10,
          isStale: false,
          projectIds: ['1'],
        },
      ]));

      expect(merged[0].health).toEqual({
        status: 'healthy',
        lastVerifiedAt: '2024-01-02T00:00:00.000Z',
        expectedNextReportAt: '2025-01-01T00:00:00.000Z',
        stalenessSeconds: 10,
        projectIds: ['1'],
      });
    });

    it('marks stale providers', () => {
      const service = buildService({});
      const merged = service.mergeProviderHealth([provider], stalenessReport([
        {
          providerAddress: PROVIDER_ADDRESS,
          lastVerifiedAt: '2023-01-01T00:00:00.000Z',
          isStale: true,
          projectIds: ['1', '2'],
        },
      ]));

      expect(merged[0].health).toEqual({
        status: 'stale',
        lastVerifiedAt: '2023-01-01T00:00:00.000Z',
        expectedNextReportAt: undefined,
        stalenessSeconds: undefined,
        projectIds: ['1', '2'],
      });
    });

    it('reports unknown health when the provider has no monitoring data', () => {
      const service = buildService({});
      const merged = service.mergeProviderHealth([provider], stalenessReport([]));

      expect(merged[0].health).toEqual({ status: 'unknown', projectIds: [] });
    });

    it('returns providers unchanged when health monitoring is unavailable', () => {
      const service = buildService({});
      const merged = service.mergeProviderHealth([provider], undefined);

      expect(merged).toEqual([provider]);
    });
  });

  describe('hasReportForPeriod', () => {
    it('returns true when a non-rejected report covers the period for the provider', async () => {
      const service = buildService({});
      (service as any).getProjectReports = jest.fn().mockResolvedValue([
        { providerAddress: PROVIDER_ADDRESS, periodStart: 1000, periodEnd: 2000, status: ReportStatus.Verified },
        { providerAddress: PROVIDER_ADDRESS, periodStart: 1000, periodEnd: 2000, status: ReportStatus.Pending },
      ]);

      await expect(
        service.hasReportForPeriod('1', PROVIDER_ADDRESS, 1000, 2000),
      ).resolves.toBe(true);
    });

    it('returns false when only rejected reports cover the period', async () => {
      const service = buildService({});
      (service as any).getProjectReports = jest.fn().mockResolvedValue([
        { providerAddress: PROVIDER_ADDRESS, periodStart: 1000, periodEnd: 2000, status: ReportStatus.Rejected },
      ]);

      await expect(
        service.hasReportForPeriod('1', PROVIDER_ADDRESS, 1000, 2000),
      ).resolves.toBe(false);
    });

    it('returns false when no report matches the provider or period', async () => {
      const service = buildService({});
      (service as any).getProjectReports = jest.fn().mockResolvedValue([
        { providerAddress: 'OTHER', periodStart: 1000, periodEnd: 2000, status: ReportStatus.Verified },
        { providerAddress: PROVIDER_ADDRESS, periodStart: 9000, periodEnd: 9900, status: ReportStatus.Verified },
      ]);

      await expect(
        service.hasReportForPeriod('1', PROVIDER_ADDRESS, 1000, 2000),
      ).resolves.toBe(false);
    });
  });

  describe('submitReport', () => {
    const dto = {
      projectId: 'a1b2'.padEnd(64, '0'),
      periodStart: 1700000000,
      periodEnd: 1700086400,
      carbonSequestered: 1200,
      methodology: 'VM0003',
      evidenceHash: 'QmYwAPJzv5CZsnAzt8auVZRnGi2C8Qp9G2YB3hM9oWZpDa',
    };

    it('allocates nonce for the admin signer, not the provider address', async () => {
      process.env.ADMIN_SECRET_KEY = 'test-admin-secret';
      try {
        const adminPublicKey = 'GAJRCN6P67RAKN2WHGHRP7D7UGIFNIGD5CIBI2XYPAEG7J5VMXO53KWQ';
        const adminKeypairService = {
          getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => adminPublicKey }),
        };

        const localContractService = {
          invokeContractMethod: jest.fn().mockResolvedValue({
            result: nativeToScVal(BigInt(1), { type: 'u64' }),
          }),
        };
        const localIpfsService = {
          uploadJson: jest.fn().mockResolvedValue({ hash: 'QmYwAPJzv5CZsnAzt8auVZRnGi2C8Qp9G2YB3hM9oWZpDa' }),
        };
        const localNonceService = { next: jest.fn().mockResolvedValue(0) };

        const localService = new OracleService(
          localContractService as any,
          localIpfsService as any,
          adminKeypairService as any,
          localNonceService as any,
        );

        await localService.submitReport(dto, PROVIDER_ADDRESS);

        expect(localNonceService.next).toHaveBeenCalledWith(
          expect.any(String),
          adminPublicKey,
        );
        expect(localNonceService.next).not.toHaveBeenCalledWith(
          expect.any(String),
          PROVIDER_ADDRESS,
        );
      } finally {
        delete process.env.ADMIN_SECRET_KEY;
      }
    });

    it('signs the transaction with the admin secret', async () => {
      process.env.ADMIN_SECRET_KEY = 'test-admin-secret';
      try {
        const adminPublicKey = 'GAJRCN6P67RAKN2WHGHRP7D7UGIFNIGD5CIBI2XYPAEG7J5VMXO53KWQ';
        const adminKeypairService = {
          getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => adminPublicKey }),
        };

        const localContractService = {
          invokeContractMethod: jest.fn().mockResolvedValue({
            result: nativeToScVal(BigInt(1), { type: 'u64' }),
          }),
        };
        const localIpfsService = {
          uploadJson: jest.fn().mockResolvedValue({ hash: 'QmYwAPJzv5CZsnAzt8auVZRnGi2C8Qp9G2YB3hM9oWZpDa' }),
        };
        const localNonceService = { next: jest.fn().mockResolvedValue(5) };

        const localService = new OracleService(
          localContractService as any,
          localIpfsService as any,
          adminKeypairService as any,
          localNonceService as any,
        );

        await localService.submitReport(dto, PROVIDER_ADDRESS);

        expect(localContractService.invokeContractMethod).toHaveBeenCalledWith(
          expect.any(String),
          'submit_report',
          'test-admin-secret',
          expect.any(Array),
          5,
        );
      } finally {
        delete process.env.ADMIN_SECRET_KEY;
      }
    });
  });

  describe('registerProvider', () => {
    const dto = { providerAddress: PROVIDER_ADDRESS, methodology: 'VERRA-VCS' };

    it('registers a provider through the contract and returns a success response', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockResolvedValue({
          result: xdr.ScVal.scvVoid(),
          successful: true,
        }),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => ADMIN_ADDRESS }),
      };
      const nonceService = { next: jest.fn().mockResolvedValue(0) };

      const service = buildService({ contractService, stellarService, nonceService });
      const response = await service.registerProvider(dto);

      expect(stellarService.getKeypairFromSecret).toHaveBeenCalledWith('');
      expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
        '', 'register_provider', '',
        expect.any(Array),
        0,
      );
      const callArgs = contractService.invokeContractMethod.mock.calls[0][3] as xdr.ScVal[];
      expect(callArgs).toHaveLength(3);
      expect(scValToNative(callArgs[0])).toBe(ADMIN_ADDRESS);
      expect(scValToNative(callArgs[1])).toBe(PROVIDER_ADDRESS);
      expect(scValToNative(callArgs[2])).toBe('VERRA-VCS');
      expect(response).toEqual({
        providerAddress: PROVIDER_ADDRESS,
        methodology: 'VERRA-VCS',
        name: `Oracle ${PROVIDER_ADDRESS.slice(0, 6)}`,
        active: true,
        stake: 0,
        registeredAt: expect.any(String),
      });
    });

    it('maps a ProviderAlreadyExists contract error to a ConflictException', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(
          new BadRequestException(
            'Contract simulation failed: Error(Contract, #5) (contract error code 5)',
          ),
        ),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => ADMIN_ADDRESS }),
      };
      const nonceService = { next: jest.fn().mockResolvedValue(0) };

      const service = buildService({ contractService, stellarService, nonceService });
      await expect(service.registerProvider(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.registerProvider(dto)).rejects.toThrow(
        'Oracle provider is already registered',
      );
    });

    it('propagates other contract failures as BadRequestException', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(
          new BadRequestException(
            'Transaction simulation failed: Error(Contract, #2) (contract error code 2)',
          ),
        ),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => ADMIN_ADDRESS }),
      };
      const nonceService = { next: jest.fn().mockResolvedValue(0) };

      const service = buildService({ contractService, stellarService, nonceService });
      await expect(service.registerProvider(dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
