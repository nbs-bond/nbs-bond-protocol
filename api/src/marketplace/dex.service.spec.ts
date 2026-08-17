import { Test } from '@nestjs/testing';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DexService } from './dex.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { ListBondDto } from './dto/list-bond.dto';
import { OrderStatus, OrderResponse } from './interfaces/marketplace.interface';

describe('DexService', () => {
  let service: DexService;
  let contractService: { simulateCall: jest.Mock; invokeContractMethod: jest.Mock };

  const simulateCallMock = jest.fn();
  const invokeContractMethodMock = jest.fn();
  const nonceNextMock = jest.fn().mockResolvedValue(0);
  const nonceSyncMock = jest.fn().mockResolvedValue(0);

  const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  /** A valid fully-decoded OrderResponse for use in getOrder spies */
  const STUB_ORDER: OrderResponse = {
    id: 1,
    seller: SELLER,
    bondId: 1,
    amount: 100,
    pricePerToken: 10,
    quoteAsset: 'USDC',
    status: OrderStatus.Open,
    createdAt: new Date(1700000000 * 1000).toISOString(),
  };

  /** Build a raw order tuple exactly as decodeOrder expects it */
  function makeRawOrder(overrides: Partial<{
    id: bigint; seller: string; bondId: bigint; amount: bigint;
    pricePerToken: bigint; quoteAsset: string; status: number;
    createdAt: bigint; expiresAt: bigint;
  }> = {}): any[] {
    return [
      overrides.id ?? BigInt(1),
      overrides.seller ?? SELLER,
      overrides.bondId ?? BigInt(1),
      overrides.amount ?? BigInt(100),
      overrides.pricePerToken ?? BigInt(10),
      overrides.quoteAsset ?? 'USDC',
      overrides.status ?? 0,
      overrides.createdAt ?? BigInt(1700000000),
      overrides.expiresAt ?? BigInt(1700086400),
    ];
  }

  beforeAll(async () => {
    contractService = {
      simulateCall: simulateCallMock,
      invokeContractMethod: invokeContractMethodMock,
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DexService,
        { provide: ContractService, useValue: contractService },
        { provide: StellarService, useValue: {} },
        {
          provide: NonceService,
          useValue: { next: nonceNextMock, sync: nonceSyncMock },
        },
      ],
    }).compile();

    service = moduleRef.get(DexService);

    // Replace the internal Redis client with an in-memory stub so tests do not
    // attempt real network connections and never hang.
    const store = new Map<string, string>();
    const redisMock = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async () => 'OK'),
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async () => 1),
    };
    (service as any).redis = redisMock;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // ListBondDto validation
  // ---------------------------------------------------------------------------

  describe('ListBondDto validation', () => {
    const baseValid = {
      bondId: 1,
      amount: 100,
      pricePerToken: 10,
      quoteAsset: 'USDC',
    };

    async function getErrors(plain: Record<string, unknown>) {
      const dto = plainToInstance(ListBondDto, plain);
      return validate(dto);
    }

    it('accepts a valid DTO without expiresAfterSeconds (uses default 86400)', async () => {
      const errors = await getErrors(baseValid);
      expect(errors).toHaveLength(0);

      const dto = plainToInstance(ListBondDto, baseValid);
      expect(dto.expiresAfterSeconds).toBe(86400);
    });

    it('accepts expiresAfterSeconds = 1 (minimum)', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: 1 });
      expect(errors).toHaveLength(0);
    });

    it('accepts expiresAfterSeconds = 86400 (24 hours)', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: 86400 });
      expect(errors).toHaveLength(0);
    });

    it('accepts expiresAfterSeconds = 2592000 (30 days maximum)', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: 2592000 });
      expect(errors).toHaveLength(0);
    });

    it('rejects expiresAfterSeconds = 0', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: 0 });
      expect(errors.length).toBeGreaterThan(0);
      const fields = errors.map((e) => e.property);
      expect(fields).toContain('expiresAfterSeconds');
    });

    it('rejects expiresAfterSeconds = -1 (negative)', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: -1 });
      expect(errors.length).toBeGreaterThan(0);
      const fields = errors.map((e) => e.property);
      expect(fields).toContain('expiresAfterSeconds');
    });

    it('rejects expiresAfterSeconds = -3600 (negative)', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: -3600 });
      expect(errors.length).toBeGreaterThan(0);
      const fields = errors.map((e) => e.property);
      expect(fields).toContain('expiresAfterSeconds');
    });

    it('rejects expiresAfterSeconds = 2592001 (exceeds 30 days)', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: 2592001 });
      expect(errors.length).toBeGreaterThan(0);
      const fields = errors.map((e) => e.property);
      expect(fields).toContain('expiresAfterSeconds');
    });

    it('rejects expiresAfterSeconds = 9999999 (far exceeds 30 days)', async () => {
      const errors = await getErrors({ ...baseValid, expiresAfterSeconds: 9999999 });
      expect(errors.length).toBeGreaterThan(0);
      const fields = errors.map((e) => e.property);
      expect(fields).toContain('expiresAfterSeconds');
    });
  });

  // ---------------------------------------------------------------------------
  // listBondTokens — pass-through to DEXRouter
  // ---------------------------------------------------------------------------

  describe('listBondTokens', () => {
    /**
     * Set up mocks for a successful listing call.
     * - invokeContractMethod resolves with an orderId wrapped in a u64 ScVal.
     * - getOrder is spied on to return a stub order without needing a real
     *   Stellar ScVal for the mixed-type order struct.
     */
    function setupMocksForListing(orderId = 1): jest.SpyInstance {
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(BigInt(orderId), { type: 'u64' }),
        transactionHash: 'txhash',
        successful: true,
      });
      return jest.spyOn(service, 'getOrder').mockResolvedValue({
        ...STUB_ORDER,
        id: orderId,
      });
    }

    /** Extract the expiresAfterSeconds ScVal argument passed to invokeContractMethod */
    function extractExpiryArg(): bigint {
      const args: any[] = invokeContractMethodMock.mock.calls[0][3];
      // args: [seller, bondId, amount, pricePerToken, quoteAsset, expiresAfterSeconds]
      const expiryScVal = args[5];
      return scValToNative(expiryScVal) as bigint;
    }

    it('passes the provided expiresAfterSeconds to list_bond_tokens', async () => {
      setupMocksForListing();

      const dto: ListBondDto = {
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
        expiresAfterSeconds: 3600,
      };

      await service.listBondTokens(dto, SELLER);

      expect(invokeContractMethodMock).toHaveBeenCalledWith(
        expect.any(String),
        'list_bond_tokens',
        expect.any(String),
        expect.any(Array),
        0,
      );

      expect(extractExpiryArg()).toBe(BigInt(3600));
    });

    it('passes the default 86400 when expiresAfterSeconds is not provided', async () => {
      setupMocksForListing();

      // Simulate what the ValidationPipe does: plainToInstance applies the class default
      const dto = plainToInstance(ListBondDto, {
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
      });

      await service.listBondTokens(dto, SELLER);

      expect(extractExpiryArg()).toBe(BigInt(86400));
    });

    it('passes 2592000 (maximum) without modification', async () => {
      setupMocksForListing();

      const dto: ListBondDto = {
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
        expiresAfterSeconds: 2592000,
      };

      await service.listBondTokens(dto, SELLER);

      expect(extractExpiryArg()).toBe(BigInt(2592000));
    });

    it('passes 1 (minimum valid) to DEXRouter without modification', async () => {
      setupMocksForListing();

      const dto: ListBondDto = {
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
        expiresAfterSeconds: 1,
      };

      await service.listBondTokens(dto, SELLER);

      expect(extractExpiryArg()).toBe(BigInt(1));
    });

    it('returns the order from the contract after a successful listing', async () => {
      setupMocksForListing(7);

      const dto: ListBondDto = {
        bondId: 3,
        amount: 1000,
        pricePerToken: 25,
        quoteAsset: 'USDC',
        expiresAfterSeconds: 86400,
      };

      const result = await service.listBondTokens(dto, SELLER);

      expect(result.id).toBe(7);
      expect(result.status).toBe(OrderStatus.Open);
    });

    it('does NOT override a provided expiry with the legacy 604800 fallback', async () => {
      setupMocksForListing();

      const dto: ListBondDto = {
        bondId: 1,
        amount: 50,
        pricePerToken: 5,
        quoteAsset: 'XLM',
        expiresAfterSeconds: 7200,
      };

      await service.listBondTokens(dto, SELLER);

      // Must NOT be 604800 (the old incorrect default)
      expect(extractExpiryArg()).not.toBe(BigInt(604800));
      expect(extractExpiryArg()).toBe(BigInt(7200));
    });
  });

  // ---------------------------------------------------------------------------
  // decodeOrder
  // ---------------------------------------------------------------------------

  describe('decodeOrder', () => {
    it('maps the contract Order struct to an OrderResponse', async () => {
      const raw = makeRawOrder({
        id: BigInt(7),
        seller: SELLER,
        bondId: BigInt(3),
        amount: BigInt(1000),
        pricePerToken: BigInt(25),
        quoteAsset: 'USDC',
        status: 0,
        createdAt: BigInt(1700000000),
        expiresAt: BigInt(1700604800),
      });

      expect((service as any).decodeOrder(raw)).toEqual({
        id: 7,
        seller: SELLER,
        bondId: 3,
        amount: 1000,
        pricePerToken: 25,
        quoteAsset: 'USDC',
        status: OrderStatus.Open,
        createdAt: new Date(1700000000 * 1000).toISOString(),
      });
    });

    it.each([
      [0, OrderStatus.Open],
      [1, OrderStatus.PartiallyFilled],
      [2, OrderStatus.Filled],
      [3, OrderStatus.Cancelled],
      [4, OrderStatus.Expired],
    ])('maps status index %i to %s', async (index, expected) => {
      const raw = makeRawOrder({ status: index });

      expect((service as any).decodeOrder(raw).status).toBe(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // getQuoteBalance
  // ---------------------------------------------------------------------------

  describe('getQuoteBalance', () => {
    const address = SELLER;

    it('reads the escrowed balance for the requested asset', async () => {
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(25_000), { type: 'i128' }));

      await expect(service.getQuoteBalance(address, 'USDC')).resolves.toEqual({
        address,
        asset: 'USDC',
        balance: 25000,
      });

      expect(simulateCallMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'get_quote_balance' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // depositQuote
  // ---------------------------------------------------------------------------

  describe('depositQuote', () => {
    const address = SELLER;

    it('calls deposit_quote and returns a transaction response', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'abc123',
        successful: true,
      });

      await expect(
        service.depositQuote({ asset: 'USDC', amount: 1000 }, address),
      ).resolves.toEqual({
        address,
        asset: 'USDC',
        amount: 1000,
        transactionHash: 'abc123',
      });

      expect(invokeContractMethodMock).toHaveBeenCalledWith(
        expect.any(String),
        'deposit_quote',
        expect.any(String),
        expect.any(Array),
        0,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // withdrawQuote
  // ---------------------------------------------------------------------------

  describe('withdrawQuote', () => {
    const address = SELLER;

    it('calls withdraw_quote and returns a transaction response', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'def456',
        successful: true,
      });

      await expect(
        service.withdrawQuote({ asset: 'XLM', amount: 500 }, address),
      ).resolves.toEqual({
        address,
        asset: 'XLM',
        amount: 500,
        transactionHash: 'def456',
      });

      expect(invokeContractMethodMock).toHaveBeenCalledWith(
        expect.any(String),
        'withdraw_quote',
        expect.any(String),
        expect.any(Array),
        0,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // buyBondTokens — seller-balance-depleted failure handling
  // ---------------------------------------------------------------------------

  describe('buyBondTokens', () => {
    function setupMocksForBuy(depletionErrorMessage?: string): void {
      jest.spyOn(service, 'getOrder').mockResolvedValue(STUB_ORDER);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 1_000, // proceeds for 100 @ 10 = 1_000
      });
      if (depletionErrorMessage) {
        invokeContractMethodMock.mockRejectedValue(
          new Error(depletionErrorMessage),
        );
      } else {
        invokeContractMethodMock.mockResolvedValue({
          result: nativeToScVal(true),
          transactionHash: 'txhash',
          successful: true,
        });
      }
    }

    it('throws a structured 409 with nonce_consumed:true when the seller balance is depleted', async () => {
      setupMocksForBuy(
        'Transaction simulation failed: Error(Contract, #12) (contract error code 12)',
      );

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };

      await expect(service.buyBondTokens(dto, SELLER)).rejects.toMatchObject({
        status: 409,
        response: {
          statusCode: 409,
          reason: 'seller_balance_depleted',
          nonce_consumed: true,
        },
      });
    });

    it('re-syncs the nonce mirror after a failed buy so the retry is not stuck on InvalidNonce', async () => {
      setupMocksForBuy(
        'Transaction simulation failed: Error(Contract, #12) (contract error code 12)',
      );

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };

      await service.buyBondTokens(dto, SELLER).catch(() => undefined);
      expect(nonceSyncMock).toHaveBeenCalledWith(
        expect.any(String),
        SELLER,
      );
    });

    it('does not re-sync the nonce when the escrow pre-check rejects', async () => {
      jest.spyOn(service, 'getOrder').mockResolvedValue(STUB_ORDER);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 0,
      });

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };

      await expect(service.buyBondTokens(dto, SELLER)).rejects.toBeInstanceOf(
        Error,
      );
      expect(invokeContractMethodMock).not.toHaveBeenCalled();
      expect(nonceSyncMock).not.toHaveBeenCalled();
    });
  });
});
