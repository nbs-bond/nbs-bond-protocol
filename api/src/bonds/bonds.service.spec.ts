import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { xdr, scValToNative, nativeToScVal, Address, Keypair } from '@stellar/stellar-sdk';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  };
  return {
    createClient: jest.fn().mockReturnValue(mockClient),
  };
});

import { createClient } from '@redis/client';

import { BondsService } from './bonds.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { KycService } from '../auth/kyc.service';
import { InvalidProjectIdError } from '../stellar/bytes32';

const kycServiceMock = {
  isEligible: jest.fn().mockResolvedValue(true),
};

describe('BondsService', () => {
  let service: BondsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BondsService,
        { provide: ContractService, useValue: {} },
        { provide: StellarService, useValue: {} },          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();

    service = moduleRef.get(BondsService);
  });

  describe('encodeBondConfig', () => {
    it('encodes a CreateBondDto as the contract BondConfig struct', () => {
      const encoded = (service as any).encodeBondConfig({
        projectId: 'a1b2'.padEnd(64, '0'),
        faceValue: 1000,
        couponSchedule: [1000000, 2000000],
        creditType: 'Carbon',
        maturityDate: 3000000,
        totalSupply: 10000,
      });

      const raw = scValToNative(encoded) as any[];

      expect(Buffer.from(raw[0] as Uint8Array).toString('hex')).toBe(
        'a1b2'.padEnd(64, '0'),
      );
      expect(raw[1]).toBe(BigInt(1000));
      expect((raw[2] as bigint[]).map(Number)).toEqual([1000000, 2000000]);
      expect(raw[3]).toBe('Carbon');
      expect(raw[4]).toBe(BigInt(3000000));
      expect(raw[5]).toBe(BigInt(10000));
    });

    it('rejects a projectId that is not a valid 64-char hex or CIDv0', () => {
      expect(() =>
        (service as any).encodeBondConfig({
          projectId: 'VCS-1234',
          faceValue: 1000,
          couponSchedule: [1000000],
          creditType: 'Carbon',
          maturityDate: 3000000,
          totalSupply: 10000,
        }),
      ).toThrow(InvalidProjectIdError);
    });
  });

  describe('distributeCoupon arg encoding', () => {
    it('places the admin caller first and passes a scalar report id', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockResolvedValue({
          result: xdr.ScVal.scvVec([
            nativeToScVal(BigInt(1), { type: 'u64' }),
            xdr.ScVal.scvU32(0),
            nativeToScVal(BigInt(1_000_000), { type: 'i128' }),
            xdr.ScVal.scvU32(1),
          ]),
          successful: true,
        }),
        simulateCall: jest
          .fn()
          .mockResolvedValue(nativeToScVal(BigInt(0), { type: 'u64' })),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({
          publicKey: () =>
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        }),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: stellarService },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      await svc.distributeCoupon(1, { periodIndex: 0, reportId: 7 });

      const [contractAddress, method, , args] =
        contractService.invokeContractMethod.mock.calls[0];

      expect(contractAddress).toBe('');
      expect(method).toBe('distribute_coupon');
      expect(args.length).toBe(5);
      expect(scValToNative(args[0])).toBe(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );
      expect(scValToNative(args[4])).toBe(BigInt(7));
    });
  });

  describe('distributeCoupon holder reconciliation', () => {
    const ADMIN = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const redisMock = () =>
      createClient() as unknown as {
        sMembers: jest.Mock;
        sAdd: jest.Mock;
      };

    const holderListScVal = (addrs: string[]) =>
      xdr.ScVal.scvVec(addrs.map((a) => Address.fromString(a).toScVal()));

    const buildService = async (opts: {
      dbHolders: string[];
      onChainHolders: string[];
      balances: Record<string, number>;
      holderListFails?: boolean;
    }) => {
      redisMock().sMembers.mockResolvedValue(opts.dbHolders);

      const simulateCall = jest.fn(
        ({ method, args }: { method: string; args: any[] }) => {
          if (method === 'get_holder_count') {
            if (opts.holderListFails) {
              return Promise.reject(new Error('contract not found'));
            }
            return Promise.resolve(
              nativeToScVal(BigInt(opts.onChainHolders.length), { type: 'u64' }),
            );
          }
          if (method === 'get_holder_list_range') {
            return Promise.resolve(holderListScVal(opts.onChainHolders));
          }
          if (method === 'get_holder_balance') {
            const holder = scValToNative(args[1]) as string;
            return Promise.resolve(
              nativeToScVal(BigInt(opts.balances[holder] ?? 0), { type: 'i128' }),
            );
          }
          return Promise.resolve(nativeToScVal(BigInt(0), { type: 'u64' }));
        },
      );

      const invokeContractMethod = jest.fn().mockResolvedValue({
        result: xdr.ScVal.scvVec([
          nativeToScVal(BigInt(1), { type: 'u64' }),
          xdr.ScVal.scvU32(0),
          nativeToScVal(BigInt(1_000_000), { type: 'i128' }),
          xdr.ScVal.scvU32(1),
        ]),
        successful: true,
      });

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: { simulateCall, invokeContractMethod } },
          {
            provide: StellarService,
            useValue: {
              getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => ADMIN }),
            },
          },
          { provide: NonceService, useValue: { next: jest.fn().mockResolvedValue(0) } },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();

      return { svc: moduleRef.get(BondsService), invokeContractMethod };
    };

    const passedHolders = (invokeContractMethod: jest.Mock): string[] =>
      scValToNative(invokeContractMethod.mock.calls[0][3][3]) as string[];

    it('includes on-chain holders missing from the off-chain DB set', async () => {
      const dbHolder = Keypair.random().publicKey();
      const onChainOnly = Keypair.random().publicKey();
      const { svc, invokeContractMethod } = await buildService({
        dbHolders: [dbHolder],
        onChainHolders: [dbHolder, onChainOnly],
        balances: { [dbHolder]: 100, [onChainOnly]: 200 },
      });

      await svc.distributeCoupon(1, { periodIndex: 0, reportId: 7 });

      expect(passedHolders(invokeContractMethod).sort()).toEqual(
        [dbHolder, onChainOnly].sort(),
      );
    });

    it('filters stale zero-balance addresses out of the holder list', async () => {
      const stale = Keypair.random().publicKey();
      const active = Keypair.random().publicKey();
      const { svc, invokeContractMethod } = await buildService({
        dbHolders: [stale, active],
        onChainHolders: [],
        balances: { [stale]: 0, [active]: 100 },
      });

      await svc.distributeCoupon(1, { periodIndex: 0, reportId: 7 });

      expect(passedHolders(invokeContractMethod)).toEqual([active]);
    });

    it('deduplicates holders present in both the DB set and the on-chain list', async () => {
      const h1 = Keypair.random().publicKey();
      const h2 = Keypair.random().publicKey();
      const { svc, invokeContractMethod } = await buildService({
        dbHolders: [h1],
        onChainHolders: [h1, h2],
        balances: { [h1]: 100, [h2]: 200 },
      });

      await svc.distributeCoupon(1, { periodIndex: 0, reportId: 7 });

      expect(passedHolders(invokeContractMethod).sort()).toEqual([h1, h2].sort());
    });

    it('falls back to the DB set when the on-chain holder list cannot be read', async () => {
      const dbHolder = Keypair.random().publicKey();
      const { svc, invokeContractMethod } = await buildService({
        dbHolders: [dbHolder],
        onChainHolders: [],
        balances: { [dbHolder]: 100 },
        holderListFails: true,
      });

      await svc.distributeCoupon(1, { periodIndex: 0, reportId: 7 });

      expect(passedHolders(invokeContractMethod)).toEqual([dbHolder]);
    });
  });

  describe('getUndistributedTotal', () => {
    it('reads get_undistributed_total from the coupon engine', async () => {
      const contractService = {
        simulateCall: jest.fn().mockResolvedValue(
          nativeToScVal(BigInt(42), { type: 'i128' }),
        ),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      const result = await svc.getUndistributedTotal(3);

      const [options] = contractService.simulateCall.mock.calls[0];

      expect(options.contractAddress).toBe('');
      expect(options.method).toBe('get_undistributed_total');
      expect(options.args).toEqual([nativeToScVal(BigInt(3), { type: 'u64' })]);
      expect(result).toEqual({ bondId: 3, undistributedTotal: 42 });
    });
  });

  describe('sweepUndistributed arg encoding', () => {
    it('invokes sweep_undistributed as the admin and returns swept total', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockResolvedValue({
          result: nativeToScVal(BigInt(42), { type: 'i128' }),
          transactionHash: '0xabc',
          successful: true,
        }),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({
          publicKey: () =>
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        }),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: stellarService },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      const result = await svc.sweepUndistributed(3);

      const [contractAddress, method, callerSecret, args, nonce] =
        contractService.invokeContractMethod.mock.calls[0];

      expect(contractAddress).toBe('');
      expect(method).toBe('sweep_undistributed');
      expect(callerSecret).toBe('');
      expect(args.length).toBe(2);
      expect(scValToNative(args[0])).toBe(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );
      expect(scValToNative(args[1])).toBe(BigInt(3));
      expect(nonce).toBe(0);
      expect(result).toEqual({ bondId: 3, swept: 42, transactionHash: '0xabc' });
    });
  });

  describe('mature', () => {
    const adminStub = () => ({
      getKeypairFromSecret: jest.fn().mockReturnValue({
        publicKey: () =>
          'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      }),
    });

    const buildModule = async (contractService: any) => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: adminStub() },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();
      return moduleRef.get(BondsService);
    };

    it('maps a before-maturity Overflow to a 400 with a clear message', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(
          new BadRequestException(
            'Contract error on TEST.mature_bond (contract error code 9)',
          ),
        ),
      };

      const svc = await buildModule(contractService);

      await expect(svc.mature(7)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(
          'Bond #7 cannot be matured before its maturity date',
        ),
      });
    });

    it('rethrows other contract errors unchanged', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(
          new BadRequestException(
            'Contract error on TEST.mature_bond (contract error code 4)',
          ),
        ),
      };

      const svc = await buildModule(contractService);

      await expect(svc.mature(7)).rejects.toMatchObject({
        status: 400,
        message:
          'Contract error on TEST.mature_bond (contract error code 4)',
      });
    });
  });

  describe('findAll', () => {
    const configScVal = () =>
      xdr.ScVal.scvVec([
        xdr.ScVal.scvBytes(Buffer.from('a1b2'.padEnd(64, '0'), 'hex')),
        nativeToScVal(BigInt(1000), { type: 'i128' }),
        xdr.ScVal.scvVec([nativeToScVal(BigInt(1000000), { type: 'u64' })]),
        nativeToScVal('Carbon', { type: 'symbol' }),
        nativeToScVal(BigInt(253402300799), { type: 'u64' }),
        nativeToScVal(BigInt(10000), { type: 'i128' }),
      ]);

    const stateScVal = () =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(5000), { type: 'i128' }),
        nativeToScVal('Active', { type: 'symbol' }),
        nativeToScVal(BigInt(1767225600), { type: 'u64' }),
      ]);

    it('lists bonds via get_bond_ids_range instead of iterating 1..BondCount', async () => {
      const contractService = {
        simulateCall: jest.fn(({ method }: { method: string }) => {
          if (method === 'bond_count') {
            return Promise.resolve(nativeToScVal(BigInt(3), { type: 'u64' }));
          }
          if (method === 'get_bond_ids_range') {
            return Promise.resolve(
              xdr.ScVal.scvVec([nativeToScVal(BigInt(3), { type: 'u64' })]),
            );
          }
          if (method === 'get_bond') {
            return Promise.resolve(configScVal());
          }
          return Promise.resolve(stateScVal());
        }),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      const result = await svc.findAll(2, 2);

      const rangeCall: any = contractService.simulateCall.mock.calls.find(
        ([options]: any[]) => options.method === 'get_bond_ids_range',
      );
      expect(rangeCall).toBeDefined();
      expect(rangeCall[0].args).toEqual([
        nativeToScVal(2, { type: 'u32' }),
        nativeToScVal(2, { type: 'u32' }),
      ]);

      const getBondCalls = contractService.simulateCall.mock.calls.filter(
        ([options]: any[]) => options.method === 'get_bond',
      );
      expect(
        getBondCalls.map(([options]: any[]) =>
          Number(scValToNative(options.args[0])),
        ),
      ).toEqual([3]);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(3);
      expect(result.meta).toEqual({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
    });
  });

  describe('buildBondResponse', () => {
    const configScVal = (maturityDate: number) =>
      xdr.ScVal.scvVec([
        xdr.ScVal.scvBytes(Buffer.from('a1b2'.padEnd(64, '0'), 'hex')),
        nativeToScVal(BigInt(1000), { type: 'i128' }),
        xdr.ScVal.scvVec([nativeToScVal(BigInt(1000000), { type: 'u64' })]),
        nativeToScVal('Carbon', { type: 'symbol' }),
        nativeToScVal(BigInt(maturityDate), { type: 'u64' }),
        nativeToScVal(BigInt(10000), { type: 'i128' }),
      ]);

    const stateScVal = (status: string) =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(5000), { type: 'i128' }),
        nativeToScVal(status, { type: 'symbol' }),
        nativeToScVal(BigInt(1767225600), { type: 'u64' }),
      ]);

    const buildModule = async (maturityDate: number, status: string) => {
      const contractService = {
        simulateCall: jest.fn(({ method }) =>
          method === 'get_bond'
            ? Promise.resolve(configScVal(maturityDate))
            : Promise.resolve(stateScVal(status)),
        ),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();
      return moduleRef.get(BondsService);
    };

    it('reports maturityStatus Active for a bond whose maturity date is in the future', async () => {
      const svc = await buildModule(253402300799, 'Active');
      const bond = await (svc as any).buildBondResponse(1);

      expect(bond.maturityDate).toBe(253402300799);
      expect(bond.maturityStatus).toBe('Active');
      expect(bond.status).toBe('Active');
    });

    it('reports maturityStatus Matured once the maturity date has elapsed', async () => {
      const svc = await buildModule(1000, 'Active');
      const bond = await (svc as any).buildBondResponse(1);

      expect(bond.maturityStatus).toBe('Matured');
      expect(bond.status).toBe('Active');
    });

    it('reports maturityStatus Matured when the bond has been matured on-chain', async () => {
      const svc = await buildModule(253402300799, 'Matured');
      const bond = await (svc as any).buildBondResponse(1);

      expect(bond.maturityStatus).toBe('Matured');
      expect(bond.status).toBe('Matured');
    });
  });

  describe('getAccruedCredits', () => {
    const HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const buildService = async (
      simulateCall: (options: { method: string; args: any[] }) => Promise<any>,
    ) => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: { simulateCall: jest.fn(simulateCall) } },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();
      return moduleRef.get(BondsService);
    };

    it('returns total and non-zero per-type accruals from the CouponEngine', async () => {
      // The service probes credit types in enum order (Carbon, Biodiversity, Basket, BlueCarbon).
      const byTypeAmounts = [100, 50, 0, 0];
      let byTypeCall = 0;
      const svc = await buildService(async ({ method }) => {
        if (method === 'accrued_credits') {
          return nativeToScVal(BigInt(150), { type: 'i128' });
        }
        const amount = byTypeAmounts[byTypeCall++] ?? 0;
        return nativeToScVal(BigInt(amount), { type: 'i128' });
      });

      const result = await svc.getAccruedCredits(1, HOLDER);

      expect(result.bondId).toBe(1);
      expect(result.holder).toBe(HOLDER);
      expect(result.total).toBe(150);
      expect(result.perCreditType).toEqual([
        { creditType: 'Carbon', amount: 100 },
        { creditType: 'Biodiversity', amount: 50 },
      ]);
    });

    it('rejects an invalid holder address with 400', async () => {
      const svc = await buildService(async () =>
        nativeToScVal(BigInt(0), { type: 'i128' }),
      );
      await expect(svc.getAccruedCredits(1, 'not-a-key')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('returns an empty per-type list when nothing has accrued', async () => {
      const svc = await buildService(async () =>
        nativeToScVal(BigInt(0), { type: 'i128' }),
      );
      const result = await svc.getAccruedCredits(1, HOLDER);
      expect(result.total).toBe(0);
      expect(result.perCreditType).toEqual([]);
    });
  });

  describe('getPeriods', () => {
    const REPORT_HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const periodScVal = (periodIndex: number, reportId: number) =>
      xdr.ScVal.scvVec([
        xdr.ScVal.scvU32(periodIndex),
        nativeToScVal(BigInt(1000), { type: 'u64' }),
        nativeToScVal(BigInt(2000), { type: 'u64' }),
        nativeToScVal(BigInt(150), { type: 'i128' }),
        xdr.ScVal.scvBool(true),
        nativeToScVal(BigInt(reportId), { type: 'u64' }),
        nativeToScVal(BigInt(10), { type: 'i128' }),
      ]);

    const reportScVal = () =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(7), { type: 'u64' }),
        Address.fromString(REPORT_HOLDER).toScVal(),
        xdr.ScVal.scvBytes(Buffer.alloc(32)),
        nativeToScVal(BigInt(1000), { type: 'u64' }),
        nativeToScVal(BigInt(2000), { type: 'u64' }),
        nativeToScVal(BigInt(500), { type: 'i128' }),
        xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]),
        nativeToScVal('VM0003', { type: 'symbol' }),
        xdr.ScVal.scvBytes(Buffer.alloc(32)),
        xdr.ScVal.scvU32(1),
        nativeToScVal(BigInt(1700000000), { type: 'u64' }),
        nativeToScVal(BigInt(1700000060), { type: 'u64' }),
      ]);

    const buildService = async (
      simulateCall: jest.Mock,
    ) => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: { simulateCall } },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycServiceMock },
        ],
      }).compile();
      return moduleRef.get(BondsService);
    };

    it('gates subscription on KYC eligibility', async () => {
      const kycService = {
        isEligible: jest.fn().mockResolvedValue(false),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: {} },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          { provide: KycService, useValue: kycService },
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      await expect(
        svc.subscribe(1, { investorAddress: 'GABC', amount: 100 }),
      ).rejects.toMatchObject({
        status: 403,
        message: 'KYC verification required before subscribing to a bond',
      });
      expect(kycService.isEligible).toHaveBeenCalledWith('GABC', 'verified');
    });

    it('reads one page per-call via get_period_info_range and returns paginated meta', async () => {
      const simulateCall = jest.fn(({ method }: { method: string }) => {
        if (method === 'get_period_count') {
          return Promise.resolve(xdr.ScVal.scvU32(3));
        }
        return Promise.resolve(
          xdr.ScVal.scvVec([periodScVal(0, 1), periodScVal(1, 2)]),
        );
      });
      const svc = await buildService(simulateCall);

      const result = await svc.getPeriods(3, 1, 2);

      const rangeCall: any = simulateCall.mock.calls.find(
        ([options]: any[]) => options.method === 'get_period_info_range',
      );
      expect(rangeCall).toBeDefined();
      expect(rangeCall[0].args).toEqual([
        nativeToScVal(BigInt(3), { type: 'u64' }),
        nativeToScVal(0, { type: 'u32' }),
        nativeToScVal(2, { type: 'u32' }),
      ]);

      expect(result.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({
        periodIndex: 0,
        startTime: 1000,
        endTime: 2000,
        totalCreditsEarned: 150,
        distributed: true,
        reportId: 1,
        undistributed: 10,
      });
    });

    it('returns an empty page for bonds without any distributed period', async () => {
      const simulateCall = jest.fn(({ method }: { method: string }) =>
        method === 'get_period_count'
          ? Promise.resolve(xdr.ScVal.scvU32(0))
          : Promise.resolve(xdr.ScVal.scvVec([])),
      );
      const svc = await buildService(simulateCall);

      const result = await svc.getPeriods(3, 1, 20);

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
    });

    it('does not hydrate reports by default', async () => {
      const simulateCall = jest.fn(({ method }: { method: string }) => {
        if (method === 'get_period_count') {
          return Promise.resolve(xdr.ScVal.scvU32(1));
        }
        return Promise.resolve(xdr.ScVal.scvVec([periodScVal(0, 7)]));
      });
      const svc = await buildService(simulateCall);

      const result = await svc.getPeriods(3, 1, 20);

      expect(result.data[0].report).toBeUndefined();
      const reportCalls = simulateCall.mock.calls.filter(
        ([options]: any[]) => options.method === 'get_report',
      );
      expect(reportCalls).toHaveLength(0);
    });

    it('hydrates linked reports when includeReport is set', async () => {
      const simulateCall = jest.fn(({ method }: { method: string }) => {
        if (method === 'get_period_count') {
          return Promise.resolve(xdr.ScVal.scvU32(1));
        }
        if (method === 'get_period_info_range') {
          return Promise.resolve(xdr.ScVal.scvVec([periodScVal(0, 7)]));
        }
        return Promise.resolve(reportScVal());
      });
      const svc = await buildService(simulateCall);

      const result = await svc.getPeriods(3, 1, 20, true);

      expect(result.data[0].report).toEqual({
        id: 7,
        providerAddress: REPORT_HOLDER,
        projectId: Buffer.alloc(32).toString('hex'),
        periodStart: 1000,
        periodEnd: 2000,
        carbonSequestered: 500,
        methodology: 'VM0003',
        ipfsHash: Buffer.alloc(32).toString('hex'),
        status: 'Verified',
        submittedAt: 1700000000,
        verifiedAt: 1700000060,
      });
    });

    it('decodes a PeriodInfo struct from contract field order', async () => {
      const svc = await buildService(jest.fn());
      const period = (svc as any).decodePeriodInfo([
        2,
        BigInt(1000),
        BigInt(2000),
        BigInt(150),
        true,
        BigInt(9),
        BigInt(0),
      ]);
      expect(period).toEqual({
        periodIndex: 2,
        startTime: 1000,
        endTime: 2000,
        totalCreditsEarned: 150,
        distributed: true,
        reportId: 9,
        undistributed: 0,
      });
    });

    it('decodes an OracleConsumer Report struct skipping the biodiversity field', async () => {
      const svc = await buildService(jest.fn());
      const report = (svc as any).decodeReport([
        BigInt(9),
        REPORT_HOLDER,
        Buffer.alloc(32),
        BigInt(1000),
        BigInt(2000),
        BigInt(500),
        [0],
        'VM0003',
        Buffer.alloc(32),
        1,
        BigInt(1700000000),
        BigInt(1700000060),
      ]);
      expect(report).toEqual({
        id: 9,
        providerAddress: REPORT_HOLDER,
        projectId: Buffer.alloc(32).toString('hex'),
        periodStart: 1000,
        periodEnd: 2000,
        carbonSequestered: 500,
        methodology: 'VM0003',
        ipfsHash: Buffer.alloc(32).toString('hex'),
        status: 'Verified',
        submittedAt: 1700000000,
        verifiedAt: 1700000060,
      });
    });
  });
});
