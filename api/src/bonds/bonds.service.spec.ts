import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { xdr, scValToNative, nativeToScVal, Address, Keypair } from '@stellar/stellar-sdk';

// BigInt is not JSON-serializable by default.  Jest workers use JSON.stringify
// to communicate mock call data back to the parent process; XDR objects stored
// in mock histories can contain BigInt values.  This polyfill prevents the
// "Do not know how to serialize a BigInt" error without affecting test
// assertions (toJSON is only invoked by JSON.stringify).
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

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
      // args: caller, bond_id, period_index, holders, report_id, is_final_batch
      expect(args.length).toBe(6);
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
      (scValToNative(invokeContractMethod.mock.calls[0][3][3]) as [string, bigint][]).map(([addr]) => addr);

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
    const ADMIN =
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const encodeReceiptVec = (opts: {
      bondId: number;
      destination: string;
      amount: number;
      carbonAmount: number;
      biodiversityAmount: number;
    }) =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(opts.bondId), { type: 'u64' }),
        Address.fromString(opts.destination).toScVal(),
        nativeToScVal(BigInt(opts.amount), { type: 'i128' }),
        nativeToScVal(BigInt(opts.carbonAmount), { type: 'i128' }),
        nativeToScVal(BigInt(opts.biodiversityAmount), { type: 'i128' }),
      ]);

    const encodeReceiptMap = (opts: {
      bondId: number;
      destination: string;
      amount: number;
      carbonAmount: number;
      biodiversityAmount: number;
    }) => {
      const entry = (key: string, val: xdr.ScVal) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(key, { type: 'symbol' }),
          val,
        });
      return xdr.ScVal.scvMap([
        entry('amount', nativeToScVal(BigInt(opts.amount), { type: 'i128' })),
        entry(
          'biodiversity_amount',
          nativeToScVal(BigInt(opts.biodiversityAmount), { type: 'i128' }),
        ),
        entry('bond_id', nativeToScVal(BigInt(opts.bondId), { type: 'u64' })),
        entry(
          'carbon_amount',
          nativeToScVal(BigInt(opts.carbonAmount), { type: 'i128' }),
        ),
        entry('destination', Address.fromString(opts.destination).toScVal()),
      ]);
    };

    const buildSvc = async (result: xdr.ScVal) => {
      const contractService = {
        invokeContractMethod: jest.fn().mockResolvedValue({
          result,
          transactionHash: '0xabc',
          successful: true,
        }),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({
          publicKey: () => ADMIN,
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

      return {
        svc: moduleRef.get(BondsService),
        contractService,
      };
    };

    it('invokes sweep_undistributed with admin destination and decodes SweepReceipt', async () => {
      const { svc, contractService } = await buildSvc(
        encodeReceiptVec({
          bondId: 3,
          destination: ADMIN,
          amount: 42,
          carbonAmount: 30,
          biodiversityAmount: 12,
        }),
      );

      const result = await svc.sweepUndistributed(3);

      const [contractAddress, method, callerSecret, args, nonce] =
        contractService.invokeContractMethod.mock.calls[0];

      expect(contractAddress).toBe('');
      expect(method).toBe('sweep_undistributed');
      expect(callerSecret).toBe('');
      expect(args.length).toBe(3);
      expect(scValToNative(args[0])).toBe(ADMIN);
      expect(scValToNative(args[1])).toBe(BigInt(3));
      expect(scValToNative(args[2])).toBe(ADMIN);
      expect(nonce).toBe(0);
      expect(result).toEqual({
        bondId: 3,
        destination: ADMIN,
        amount: 42,
        carbonAmount: 30,
        biodiversityAmount: 12,
        swept: 42,
        transactionHash: '0xabc',
      });
    });

    it('passes an explicit destination as the third argument', async () => {
      const treasury = Keypair.random().publicKey();
      const { svc, contractService } = await buildSvc(
        encodeReceiptVec({
          bondId: 3,
          destination: treasury,
          amount: 7,
          carbonAmount: 7,
          biodiversityAmount: 0,
        }),
      );

      const result = await svc.sweepUndistributed(3, treasury);

      const args = contractService.invokeContractMethod.mock.calls[0][3];
      expect(args.length).toBe(3);
      expect(scValToNative(args[0])).toBe(ADMIN);
      expect(scValToNative(args[2])).toBe(treasury);
      expect(result.destination).toBe(treasury);
      expect(result.amount).toBe(7);
      expect(result.swept).toBe(7);
    });

    it('decodes a named SweepReceipt struct/map', async () => {
      const { svc } = await buildSvc(
        encodeReceiptMap({
          bondId: 9,
          destination: ADMIN,
          amount: 15,
          carbonAmount: 10,
          biodiversityAmount: 5,
        }),
      );

      await expect(svc.sweepUndistributed(9)).resolves.toEqual({
        bondId: 9,
        destination: ADMIN,
        amount: 15,
        carbonAmount: 10,
        biodiversityAmount: 5,
        swept: 15,
        transactionHash: '0xabc',
      });
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

    it('maps a before-maturity NotYetMature (code 14) to a 400 with a clear message', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(
          new BadRequestException(
            'Contract error on TEST.mature_bond (contract error code 14)',
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

    it('rethrows a genuine arithmetic Overflow (code 9) unchanged', async () => {
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
        message: 'Contract error on TEST.mature_bond (contract error code 9)',
      });
    });
  });

  describe('create', () => {
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

    const dto: any = {
      projectId: '0'.repeat(64),
      faceValue: 1000,
      couponSchedule: [1000000, 2000000],
      creditType: 'Carbon',
      maturityDate: 500,
      totalSupply: 10000,
    };

    it('maps a past-maturity-date MaturityDateInPast (code 15) to a clear 400', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(
          new BadRequestException(
            'Contract error on TEST.issue_bond (contract error code 15)',
          ),
        ),
      };

      const svc = await buildModule(contractService);

      await expect(svc.create(dto)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(
          'maturity date must be in the future',
        ),
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

    it('returns empty list when get_bond_ids_range RPC fails', async () => {
      const contractService = {
        simulateCall: jest.fn(({ method }: { method: string }) => {
          if (method === 'bond_count') {
            return Promise.resolve(nativeToScVal(BigInt(5), { type: 'u64' }));
          }
          if (method === 'get_bond_ids_range') {
            return Promise.reject(new Error('RPC node unreachable'));
          }
          return Promise.resolve(
            nativeToScVal(BigInt(0), { type: 'u64' }),
          );
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
      const result = await svc.findAll(1, 20);

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({
        page: 1,
        limit: 20,
        total: 5,
        totalPages: 1,
      });
    });

    it('returns stale cache when get_bond_ids_range RPC fails', async () => {
      const cachedResult = {
        data: [{ id: 1 }],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      };

      const redisMock = createClient() as unknown as { get: jest.Mock };
      redisMock.get.mockImplementation((key: string) => {
        if (key === 'bonds:1:20') return Promise.resolve(JSON.stringify(cachedResult));
        return Promise.resolve(null);
      });

      const contractService = {
        simulateCall: jest.fn(({ method }: { method: string }) => {
          if (method === 'bond_count') {
            return Promise.resolve(nativeToScVal(BigInt(1), { type: 'u64' }));
          }
          if (method === 'get_bond_ids_range') {
            return Promise.reject(new Error('RPC node unreachable'));
          }
          return Promise.resolve(
            nativeToScVal(BigInt(0), { type: 'u64' }),
          );
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
      const result = await svc.findAll(1, 20);

      expect(result).toEqual(cachedResult);
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

    it('encodes each credit-type variant as a symbol ScVal', async () => {
      const simulateCall = jest.fn(async () =>
        nativeToScVal(BigInt(0), { type: 'i128' }),
      );

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

      const svc = moduleRef.get(BondsService);
      await svc.getAccruedCredits(1, HOLDER);

      const byTypeCalls = simulateCall.mock.calls
        .map(([options]: any[]) => options)
        .filter((options) => options.method === 'accrued_credits_by_type');

      expect(byTypeCalls).toHaveLength(4);
      expect(byTypeCalls.map((options) => options.args[2])).toEqual([
        nativeToScVal('Carbon', { type: 'symbol' }),
        nativeToScVal('Biodiversity', { type: 'symbol' }),
        nativeToScVal('Basket', { type: 'symbol' }),
        nativeToScVal('BlueCarbon', { type: 'symbol' }),
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
        nativeToScVal(BigInt(42), { type: 'u64' }),
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
        svc.subscribe(1, { investorAddress: 'GABC', amount: 100, signedTxXdr: 'signed-xdr' }),
      ).rejects.toMatchObject({
        status: 403,
        message: 'KYC verification required before subscribing to a bond',
      });
      expect(kycService.isEligible).toHaveBeenCalledWith('GABC', 'verified');
    });

    it('rejects subscription when KYC status is stale', async () => {
      const kycService = {
        isEligible: jest.fn().mockRejectedValue(
          new ForbiddenException(
            'KYC status is stale; fresh verification is required before subscribing',
          ),
        ),
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
        svc.subscribe(1, { investorAddress: 'GABC', amount: 100, signedTxXdr: 'signed-xdr' }),
      ).rejects.toMatchObject({
        status: 403,
        message: 'KYC status is stale; fresh verification is required before subscribing',
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
        BigInt(42),
        Buffer.alloc(32),
        BigInt(1000),
        BigInt(2000),
        BigInt(500),
        ['Absent'],
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

describe('BondsService.prepareClaim / claimCredits (pre-signed flow)', () => {
  const INVESTOR = Keypair.random().publicKey();
  const OTHER_HOLDER = Keypair.random().publicKey();

  const buildClaimService = async (opts: {
    accrued: number;
    claimed?: number;
    submitError?: Error;
  }) => {
    const simulateCall = jest.fn(({ method }: { method: string }) => {
      if (method === 'accrued_credits') {
        return Promise.resolve(
          nativeToScVal(BigInt(opts.accrued), { type: 'i128' }),
        );
      }
      return Promise.resolve(nativeToScVal(BigInt(0), { type: 'i128' }));
    });

    const prepareTransaction = jest.fn().mockResolvedValue({
      xdr: 'unsigned-claim-xdr',
      nonce: 4,
    });

    const submitSignedTransaction = opts.submitError
      ? jest.fn().mockRejectedValue(opts.submitError)
      : jest.fn().mockResolvedValue({
          result: nativeToScVal(BigInt(opts.claimed ?? opts.accrued), {
            type: 'i128',
          }),
          transactionHash: 'tx-hash',
          successful: true,
        });

    const next = jest.fn().mockResolvedValue(4);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BondsService,
        {
          provide: ContractService,
          useValue: { simulateCall, prepareTransaction, submitSignedTransaction },
        },
        { provide: StellarService, useValue: {} },
        { provide: NonceService, useValue: { next } },
        { provide: KycService, useValue: kycServiceMock },
      ],
    }).compile();

    return {
      svc: moduleRef.get(BondsService) as BondsService,
      simulateCall,
      prepareTransaction,
      submitSignedTransaction,
      next,
    };
  };

  it('prepareClaim returns an unsigned XDR and the reserved nonce when credits are accrued', async () => {
    const { svc, prepareTransaction, next } = await buildClaimService({ accrued: 250 });

    await expect(svc.prepareClaim(3, {}, INVESTOR)).resolves.toEqual({
      bondId: 3,
      investorAddress: INVESTOR,
      credits: 250,
      xdr: 'unsigned-claim-xdr',
      nonce: 4,
    });

    expect(next).toHaveBeenCalledWith(process.env.COUPON_ENGINE_ADDRESS || '', INVESTOR);
    const [contract, method, sourceAddress, args, nonce] = prepareTransaction.mock.calls[0];
    expect(contract).toBe(process.env.COUPON_ENGINE_ADDRESS || '');
    expect(method).toBe('claim_credits');
    expect(sourceAddress).toBe(INVESTOR);
    expect(scValToNative(args[0])).toBe(INVESTOR);
    expect(Number(scValToNative(args[1]))).toBe(3);
    expect(nonce).toBe(4);
  });

  it('prepareClaim short-circuits without reserving a nonce when nothing is accrued', async () => {
    const { svc, prepareTransaction, next } = await buildClaimService({ accrued: 0 });

    await expect(svc.prepareClaim(5, {}, INVESTOR)).resolves.toEqual({
      bondId: 5,
      investorAddress: INVESTOR,
      credits: 0,
      xdr: null,
      nonce: null,
    });
    expect(prepareTransaction).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('claimCredits submits the signed envelope and reports the on-chain amount', async () => {
    const { svc, submitSignedTransaction } = await buildClaimService({
      accrued: 250,
      claimed: 250,
    });

    await expect(
      svc.claimCredits(3, { signedTxXdr: 'signed-xdr' }, INVESTOR),
    ).resolves.toEqual({
      bondId: 3,
      investorAddress: INVESTOR,
      credits: 250,
      transactionHash: 'tx-hash',
    });

    expect(submitSignedTransaction).toHaveBeenCalledWith(
      'signed-xdr',
      process.env.COUPON_ENGINE_ADDRESS || '',
      'claim_credits',
      INVESTOR,
    );
  });

  it('claimCredits returns the amount the contract actually zeroed, not the pre-read balance', async () => {
    const { svc } = await buildClaimService({ accrued: 250, claimed: 180 });

    const response = await svc.claimCredits(3, { signedTxXdr: 'signed-xdr' }, INVESTOR);

    expect(response.credits).toBe(180);
  });

  it('accepts a body address identical to the session address', async () => {
    const { svc } = await buildClaimService({ accrued: 10 });

    await expect(
      svc.claimCredits(1, { investorAddress: INVESTOR, signedTxXdr: 'signed-xdr' }, INVESTOR),
    ).resolves.toMatchObject({ investorAddress: INVESTOR });
  });

  it('rejects a body address that is not the authenticated wallet with 403', async () => {
    const { svc, submitSignedTransaction } = await buildClaimService({ accrued: 10 });

    await expect(
      svc.claimCredits(1, { investorAddress: OTHER_HOLDER, signedTxXdr: 'signed-xdr' }, INVESTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('rejects a session that carries no valid Stellar address with 401', async () => {
    const { svc } = await buildClaimService({ accrued: 10 });

    await expect(
      svc.claimCredits(1, { signedTxXdr: 'signed-xdr' }, 'not-an-address'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects prepareClaim for a body address that is not the authenticated wallet with 403', async () => {
    const { svc, prepareTransaction } = await buildClaimService({ accrued: 10 });

    await expect(
      svc.prepareClaim(1, { investorAddress: OTHER_HOLDER }, INVESTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prepareTransaction).not.toHaveBeenCalled();
  });

  it('maps an on-chain accounting mismatch to 409 Conflict', async () => {
    const { svc } = await buildClaimService({
      accrued: 100,
      submitError: new BadRequestException(
        'Transaction simulation failed: host error (contract error code 13)',
      ),
    });

    await expect(
      svc.claimCredits(2, { signedTxXdr: 'signed-xdr' }, INVESTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps an unknown bond to 400', async () => {
    const { svc } = await buildClaimService({
      accrued: 100,
      submitError: new BadRequestException(
        'Transaction simulation failed: host error (contract error code 4)',
      ),
    });

    await expect(
      svc.claimCredits(99, { signedTxXdr: 'signed-xdr' }, INVESTOR),
    ).rejects.toThrow('Bond #99 does not exist');
  });

  it('never reads process.env.INVESTOR_SECRET_KEY (env var fully removed)', async () => {
    expect(process.env.INVESTOR_SECRET_KEY).toBeUndefined();
    const { svc } = await buildClaimService({ accrued: 10, claimed: 10 });

    // Works correctly with the env var absent — this would have thrown
    // InternalServerErrorException under the old shared-secret design.
    await expect(
      svc.claimCredits(1, { signedTxXdr: 'signed-xdr' }, INVESTOR),
    ).resolves.toMatchObject({ credits: 10 });
  });
});

describe('BondsService.prepareSubscribe / subscribe (pre-signed flow)', () => {
  const INVESTOR = Keypair.random().publicKey();

  const buildSubscribeService = async (opts: {
    kycEligible?: boolean;
    submitError?: Error;
  } = {}) => {
    const prepareTransaction = jest.fn().mockResolvedValue({
      xdr: 'unsigned-subscribe-xdr',
      nonce: 2,
    });
    const submitSignedTransaction = opts.submitError
      ? jest.fn().mockRejectedValue(opts.submitError)
      : jest.fn().mockResolvedValue({
          transactionHash: 'subscribe-tx-hash',
          successful: true,
          result: xdr.ScVal.scvVoid(),
        });
    const next = jest.fn().mockResolvedValue(2);
    const kycService = { isEligible: jest.fn().mockResolvedValue(opts.kycEligible ?? true) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BondsService,
        { provide: ContractService, useValue: { prepareTransaction, submitSignedTransaction } },
        { provide: StellarService, useValue: {} },
        { provide: NonceService, useValue: { next } },
        { provide: KycService, useValue: kycService },
      ],
    }).compile();

    return {
      svc: moduleRef.get(BondsService) as BondsService,
      prepareTransaction,
      submitSignedTransaction,
      next,
      kycService,
    };
  };

  it('prepareSubscribe reserves a nonce and returns the unsigned XDR', async () => {
    const { svc, prepareTransaction, next } = await buildSubscribeService();

    await expect(
      svc.prepareSubscribe(1, { investorAddress: INVESTOR, amount: 100 }),
    ).resolves.toEqual({ xdr: 'unsigned-subscribe-xdr', nonce: 2 });

    expect(next).toHaveBeenCalledWith(process.env.BOND_ISSUER_ADDRESS || '', INVESTOR);
    const [contract, method, sourceAddress, args, nonce] = prepareTransaction.mock.calls[0];
    expect(contract).toBe(process.env.BOND_ISSUER_ADDRESS || '');
    expect(method).toBe('subscribe');
    expect(sourceAddress).toBe(INVESTOR);
    expect(scValToNative(args[0])).toBe(INVESTOR);
    expect(Number(scValToNative(args[2]))).toBe(100);
    expect(nonce).toBe(2);
  });

  it('prepareSubscribe rejects when KYC is not eligible, without reserving a nonce', async () => {
    const { svc, next } = await buildSubscribeService({ kycEligible: false });

    await expect(
      svc.prepareSubscribe(1, { investorAddress: INVESTOR, amount: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('subscribe submits the signed envelope with the investor as expected source', async () => {
    const { svc, submitSignedTransaction } = await buildSubscribeService();

    await expect(
      svc.subscribe(1, { investorAddress: INVESTOR, amount: 100, signedTxXdr: 'signed-xdr' }),
    ).resolves.toEqual({
      bondId: 1,
      investorAddress: INVESTOR,
      amount: 100,
      transactionHash: 'subscribe-tx-hash',
    });

    expect(submitSignedTransaction).toHaveBeenCalledWith(
      'signed-xdr',
      process.env.BOND_ISSUER_ADDRESS || '',
      'subscribe',
      INVESTOR,
    );
  });

  it('subscribe rejects when KYC is not eligible, without submitting', async () => {
    const { svc, submitSignedTransaction } = await buildSubscribeService({ kycEligible: false });

    await expect(
      svc.subscribe(1, { investorAddress: INVESTOR, amount: 100, signedTxXdr: 'signed-xdr' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('never reads process.env.INVESTOR_SECRET_KEY (env var fully removed)', async () => {
    expect(process.env.INVESTOR_SECRET_KEY).toBeUndefined();
    const { svc } = await buildSubscribeService();

    await expect(
      svc.subscribe(1, { investorAddress: INVESTOR, amount: 100, signedTxXdr: 'signed-xdr' }),
    ).resolves.toMatchObject({ transactionHash: 'subscribe-tx-hash' });
  });
});

describe('BondsService.prepareTransfer / transfer (pre-signed flow)', () => {
  const FROM = Keypair.random().publicKey();
  const TO = Keypair.random().publicKey();

  const buildTransferService = async (opts: { submitError?: Error } = {}) => {
    const prepareTransaction = jest.fn().mockResolvedValue({
      xdr: 'unsigned-transfer-xdr',
      nonce: 9,
    });
    const submitSignedTransaction = opts.submitError
      ? jest.fn().mockRejectedValue(opts.submitError)
      : jest.fn().mockResolvedValue({
          transactionHash: 'transfer-tx-hash',
          successful: true,
          result: xdr.ScVal.scvVoid(),
        });
    const next = jest.fn().mockResolvedValue(9);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BondsService,
        { provide: ContractService, useValue: { prepareTransaction, submitSignedTransaction } },
        { provide: StellarService, useValue: {} },
        { provide: NonceService, useValue: { next } },
        { provide: KycService, useValue: kycServiceMock },
      ],
    }).compile();

    return {
      svc: moduleRef.get(BondsService) as BondsService,
      prepareTransaction,
      submitSignedTransaction,
      next,
    };
  };

  it('prepareTransfer reserves a nonce scoped to fromAddress and returns the unsigned XDR', async () => {
    const { svc, prepareTransaction, next } = await buildTransferService();

    await expect(
      svc.prepareTransfer(1, { fromAddress: FROM, toAddress: TO, amount: 50 }),
    ).resolves.toEqual({ xdr: 'unsigned-transfer-xdr', nonce: 9 });

    expect(next).toHaveBeenCalledWith(process.env.BOND_ISSUER_ADDRESS || '', FROM);
    const [contract, method, sourceAddress, args, nonce] = prepareTransaction.mock.calls[0];
    expect(contract).toBe(process.env.BOND_ISSUER_ADDRESS || '');
    expect(method).toBe('transfer');
    expect(sourceAddress).toBe(FROM);
    expect(scValToNative(args[0])).toBe(FROM);
    expect(scValToNative(args[1])).toBe(TO);
    expect(Number(scValToNative(args[3]))).toBe(50);
    expect(nonce).toBe(9);
  });

  it('transfer submits the signed envelope with fromAddress as the expected source', async () => {
    const { svc, submitSignedTransaction } = await buildTransferService();

    await expect(
      svc.transfer(1, { fromAddress: FROM, toAddress: TO, amount: 50, signedTxXdr: 'signed-xdr' }),
    ).resolves.toEqual({
      bondId: 1,
      fromAddress: FROM,
      toAddress: TO,
      amount: 50,
      transactionHash: 'transfer-tx-hash',
    });

    expect(submitSignedTransaction).toHaveBeenCalledWith(
      'signed-xdr',
      process.env.BOND_ISSUER_ADDRESS || '',
      'transfer',
      FROM,
    );
  });

  it('never reads process.env.INVESTOR_SECRET_KEY (env var fully removed)', async () => {
    expect(process.env.INVESTOR_SECRET_KEY).toBeUndefined();
    const { svc } = await buildTransferService();

    await expect(
      svc.transfer(1, { fromAddress: FROM, toAddress: TO, amount: 50, signedTxXdr: 'signed-xdr' }),
    ).resolves.toMatchObject({ transactionHash: 'transfer-tx-hash' });
  });

  it('maps an InsufficientBalance (code 16) simulation failure at prepare time to a clear 400', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BondsService,
        {
          provide: ContractService,
          useValue: {
            prepareTransaction: jest.fn().mockRejectedValue(
              new BadRequestException(
                'Transaction simulation failed: Error(Contract, #16) (contract error code 16)',
              ),
            ),
            submitSignedTransaction: jest.fn(),
          },
        },
        { provide: StellarService, useValue: {} },
        { provide: NonceService, useValue: { next: jest.fn().mockResolvedValue(9) } },
        { provide: KycService, useValue: kycServiceMock },
      ],
    }).compile();
    const svc = moduleRef.get(BondsService) as BondsService;

    await expect(
      svc.prepareTransfer(7, { fromAddress: FROM, toAddress: TO, amount: 50 }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Insufficient balance on bond #7'),
    });
  });
});
