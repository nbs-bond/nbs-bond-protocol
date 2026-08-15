import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { xdr, scValToNative, nativeToScVal } from '@stellar/stellar-sdk';

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

import { BondsService } from './bonds.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { InvalidProjectIdError } from '../stellar/bytes32';

describe('BondsService', () => {
  let service: BondsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BondsService,
        { provide: ContractService, useValue: {} },
        { provide: StellarService, useValue: {} },
        {
          provide: NonceService,
          useValue: { next: jest.fn().mockResolvedValue(0) },
        },
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
});
