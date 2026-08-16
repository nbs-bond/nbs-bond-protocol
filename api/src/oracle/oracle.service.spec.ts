import { Test } from '@nestjs/testing';
import { OracleService } from './oracle.service';
import { ContractService } from '../stellar/contract.service';
import { IpfsService } from '../projects/ipfs.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { ReportStatus } from './interfaces/oracle.interface';
import { BadRequestException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';

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

      await service.challengeReport(7, dto, investorAddress);

      expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
        expect.any(String),
        'challenge_report',
        'test-investor-secret',
        expect.any(Array),
        0,
      );
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
  });

  describe('decodeReport', () => {
    it('maps the contract Report struct to a ReportResponse', () => {
      const raw = [
        BigInt(4),
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        Buffer.from('a1b2'.padEnd(64, '0'), 'hex'),
        BigInt(1700000000),
        BigInt(1700086400),
        BigInt(1200),
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
        Buffer.alloc(32),
        BigInt(0),
        BigInt(0),
        BigInt(0),
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
});
