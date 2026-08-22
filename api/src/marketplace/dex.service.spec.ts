import { Test } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
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
  let redisMock: any;

  const simulateCallMock = jest.fn();
  const invokeContractMethodMock = jest.fn();
  const nonceNextMock = jest.fn().mockResolvedValue(0);
  const nonceSyncMock = jest.fn().mockResolvedValue(0);

  const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const ADMIN_PUBLIC_KEY = 'GAJRCN6P67RAKN2WHGHRP7D7UGIFNIGD5CIBI2XYPAEG7J5VMXO53KWQ';

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
        { provide: StellarService, useValue: { getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => ADMIN_PUBLIC_KEY }) } },
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
    redisMock = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async () => 'OK'),
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async () => 1),
      unlink: jest.fn(async (keys: string[]) => {
        keys.forEach((key) => store.delete(key));
        return keys.length;
      }),
      scanIterator: jest.fn(({ MATCH }: { MATCH: string }) => {
        const prefix = MATCH.replace(/\*$/, '');
        const matched = [...store.keys()].filter((key) => key.startsWith(prefix));
        return (async function* () {
          for (const key of matched) yield key;
        })();
      }),
      __store: store,
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

  describe('getBestPrice', () => {
    it('decodes an on-chain quote from exactly one simulation', async () => {
      simulateCallMock.mockResolvedValue(
        xdr.ScVal.scvVec([
          nativeToScVal(BigInt(15), { type: 'i128' }),
          nativeToScVal(BigInt(150), { type: 'i128' }),
          nativeToScVal(BigInt(5_000), { type: 'i128' }),
        ]),
      );

      await expect(service.getBestPrice(7, 'buy', 10)).resolves.toEqual({
        price: 15,
        total: 150,
        slippageBps: 5_000,
      });

      expect(simulateCallMock).toHaveBeenCalledTimes(1);
      const call = simulateCallMock.mock.calls[0][0];
      expect(call.method).toBe('get_best_price');
      expect(scValToNative(call.args[0])).toBe(BigInt(7));
      expect(scValToNative(call.args[1])).toEqual(['Buy']);
      expect(scValToNative(call.args[2])).toBe(BigInt(10));
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

    it('calls deposit_quote and returns the new balance', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'abc123',
        successful: true,
      });
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(11_000), { type: 'i128' }));

      await expect(
        service.depositQuote({ asset: 'USDC', amount: 1000 }, address),
      ).resolves.toEqual({
        address,
        asset: 'USDC',
        amount: 1000,
        balance: 11000,
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

    it('calls withdraw_quote and returns the new balance', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'def456',
        successful: true,
      });
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(4_500), { type: 'i128' }));

      await expect(
        service.withdrawQuote({ asset: 'XLM', amount: 500 }, address),
      ).resolves.toEqual({
        address,
        asset: 'XLM',
        amount: 500,
        balance: 4500,
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
        ADMIN_PUBLIC_KEY,
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

  // ---------------------------------------------------------------------------
  // buyBondTokens — escrow pre-check boundary (dto.amount * order.pricePerToken
  // vs. escrowed balance). The general "enough balance" / "not enough balance"
  // cases were already covered elsewhere, but not the exact boundary where
  // proceeds == balance, which is the case most likely to flip on an off-by-one
  // if the `<` in `escrowed.balance < proceeds` were ever changed to `<=`.
  // ---------------------------------------------------------------------------

  describe('buyBondTokens — escrow boundary', () => {
    const order = { ...STUB_ORDER, pricePerToken: 25 };
    const dto = { orderId: 1, maxPrice: 25, amount: 8 }; // proceeds = 25 * 8 = 200

    it('proceeds exactly equal to escrowed balance is allowed (boundary, not rejected)', async () => {
      jest.spyOn(service, 'getOrder').mockResolvedValue(order);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 200, // == proceeds exactly
      });
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(true),
        transactionHash: 'txhash',
        successful: true,
      });

      await expect(service.buyBondTokens(dto, SELLER)).resolves.toBeDefined();
      expect(invokeContractMethodMock).toHaveBeenCalled();
    });

    it('proceeds one unit over escrowed balance is rejected before touching the contract', async () => {
      jest.spyOn(service, 'getOrder').mockResolvedValue(order);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 199, // == proceeds - 1
      });

      await expect(service.buyBondTokens(dto, SELLER)).rejects.toBeInstanceOf(
        Error,
      );
      expect(invokeContractMethodMock).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // mapDexError — buyBondTokens' catch handler translates on-chain DEXError
  // codes into HTTP responses. Only the SellerBalanceDepleted (409) branch had
  // coverage; the InsufficientFunds branch, the default/unmapped-code fallback,
  // and the HttpException passthrough were untested.
  // ---------------------------------------------------------------------------

  describe('buyBondTokens — mapDexError translation', () => {
    function setupForError(rejection: unknown): void {
      jest.spyOn(service, 'getOrder').mockResolvedValue(STUB_ORDER);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 1_000, // proceeds for 100 @ 10 = 1_000, so the pre-check passes
      });
      invokeContractMethodMock.mockRejectedValue(rejection);
    }

    it('maps DEXError code 10 (InsufficientFunds) to 402 Payment Required', async () => {
      setupForError(
        new Error('Transaction simulation failed: Error(Contract, #10) (contract error code 10)'),
      );

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };

      await expect(service.buyBondTokens(dto, SELLER)).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    });

    it('falls back to BadRequestException for an unmapped DEXError code', async () => {
      setupForError(
        new Error('Transaction simulation failed: Error(Contract, #3) (contract error code 3)'),
      );

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };

      await expect(service.buyBondTokens(dto, SELLER)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('falls back to BadRequestException for an error with no recognizable code', async () => {
      setupForError(new Error('network timeout contacting horizon'));

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };

      await expect(service.buyBondTokens(dto, SELLER)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        message: 'network timeout contacting horizon',
      });
    });

    it('passes an existing HttpException through unchanged instead of re-wrapping it', async () => {
      const original = new HttpException('upstream rate limited', HttpStatus.TOO_MANY_REQUESTS);
      setupForError(original);

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };

      await expect(service.buyBondTokens(dto, SELLER)).rejects.toBe(original);
    });
  });

  // ---------------------------------------------------------------------------
  // Nonce scoping — nonce must be allocated for the admin signer, not the user
  // ---------------------------------------------------------------------------

  describe('nonce scoping', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('listBondTokens allocates nonce for admin signer, not seller', async () => {
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(BigInt(1), { type: 'u64' }),
        transactionHash: 'txhash',
        successful: true,
      });
      jest.spyOn(service, 'getOrder').mockResolvedValue({ ...STUB_ORDER, id: 1 });

      const dto: ListBondDto = {
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
      };

      await service.listBondTokens(dto, SELLER);

      expect(nonceNextMock).toHaveBeenCalledWith(
        expect.any(String),
        ADMIN_PUBLIC_KEY,
      );
      expect(nonceNextMock).not.toHaveBeenCalledWith(
        expect.any(String),
        SELLER,
      );
    });

    it('buyBondTokens allocates nonce for admin signer, not buyer', async () => {
      jest.spyOn(service, 'getOrder').mockResolvedValue(STUB_ORDER);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 1_000,
      });
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(true),
        transactionHash: 'txhash',
        successful: true,
      });

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };
      await service.buyBondTokens(dto, SELLER);

      expect(nonceNextMock).toHaveBeenCalledWith(
        expect.any(String),
        ADMIN_PUBLIC_KEY,
      );
      expect(nonceNextMock).not.toHaveBeenCalledWith(
        expect.any(String),
        SELLER,
      );
    });

    it('cancelOrder allocates nonce for admin signer, not caller', async () => {
      invokeContractMethodMock.mockResolvedValue({ transactionHash: 'txhash' });

      await service.cancelOrder(1, SELLER);

      expect(nonceNextMock).toHaveBeenCalledWith(
        expect.any(String),
        ADMIN_PUBLIC_KEY,
      );
      expect(nonceNextMock).not.toHaveBeenCalledWith(
        expect.any(String),
        SELLER,
      );
    });

    it('depositQuote allocates nonce for admin signer, not caller', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'abc123',
        successful: true,
      });
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(5000), { type: 'i128' }));

      await service.depositQuote({ asset: 'USDC', amount: 1000 }, SELLER);

      expect(nonceNextMock).toHaveBeenCalledWith(
        expect.any(String),
        ADMIN_PUBLIC_KEY,
      );
      expect(nonceNextMock).not.toHaveBeenCalledWith(
        expect.any(String),
        SELLER,
      );
    });

    it('withdrawQuote allocates nonce for admin signer, not caller', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'def456',
        successful: true,
      });
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(3000), { type: 'i128' }));

      await service.withdrawQuote({ asset: 'XLM', amount: 500 }, SELLER);

      expect(nonceNextMock).toHaveBeenCalledWith(
        expect.any(String),
        ADMIN_PUBLIC_KEY,
      );
      expect(nonceNextMock).not.toHaveBeenCalledWith(
        expect.any(String),
        SELLER,
      );
    });

    it('buyBondTokens re-syncs nonce for admin signer on failure', async () => {
      jest.spyOn(service, 'getOrder').mockResolvedValue(STUB_ORDER);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 1_000,
      });
      invokeContractMethodMock.mockRejectedValue(
        new Error('Transaction simulation failed: Error(Contract, #12) (contract error code 12)'),
      );

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };
      await service.buyBondTokens(dto, SELLER).catch(() => undefined);

      expect(nonceSyncMock).toHaveBeenCalledWith(
        expect.any(String),
        ADMIN_PUBLIC_KEY,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Argument order regression — lock the exact ScVal arrays sent to DEXRouter
  // ---------------------------------------------------------------------------

  describe('argument order regression', () => {
    /** Extract the args array (4th element) from the last invokeContractMethod call */
    function getLastArgs(): any[] {
      return invokeContractMethodMock.mock.calls[invokeContractMethodMock.mock.calls.length - 1][3];
    }

    it('execute_purchase sends [buyer, order_id, max_price, amount]', async () => {
      jest.spyOn(service, 'getOrder').mockResolvedValue(STUB_ORDER);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 10_000,
      });
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(true),
        transactionHash: 'txhash',
        successful: true,
      });

      const BUYER_ADDR = ADMIN_PUBLIC_KEY;
      const dto = { orderId: 1, maxPrice: 15, amount: 50 };
      await service.buyBondTokens(dto, BUYER_ADDR);

      const args = getLastArgs();
      expect(args).toHaveLength(4);

      // args[0] = buyer (Address)
      const buyerAddr = scValToNative(args[0]) as string;
      expect(buyerAddr).toBe(BUYER_ADDR);

      // args[1] = order_id (u64)
      expect(scValToNative(args[1])).toBe(BigInt(1));

      // args[2] = max_price (i128) — must come BEFORE amount
      expect(scValToNative(args[2])).toBe(BigInt(15));

      // args[3] = amount (i128)
      expect(scValToNative(args[3])).toBe(BigInt(50));
    });

    it('deposit_quote sends [caller, quote_asset, amount]', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'abc123',
        successful: true,
      });
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(5000), { type: 'i128' }));

      await service.depositQuote({ asset: 'USDC', amount: 2000 }, SELLER);

      const args = getLastArgs();
      expect(args).toHaveLength(3);

      // args[0] = caller (Address)
      const callerAddr = scValToNative(args[0]) as string;
      expect(callerAddr).toBe(SELLER);

      // args[1] = quote_asset (symbol)
      expect(scValToNative(args[1])).toBe('USDC');

      // args[2] = amount (i128)
      expect(scValToNative(args[2])).toBe(BigInt(2000));
    });

    it('withdraw_quote sends [caller, quote_asset, amount]', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'def456',
        successful: true,
      });
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(3000), { type: 'i128' }));

      await service.withdrawQuote({ asset: 'XLM', amount: 1500 }, SELLER);

      const args = getLastArgs();
      expect(args).toHaveLength(3);

      // args[0] = caller (Address)
      const callerAddr = scValToNative(args[0]) as string;
      expect(callerAddr).toBe(SELLER);

      // args[1] = quote_asset (symbol)
      expect(scValToNative(args[1])).toBe('XLM');

      // args[2] = amount (i128)
      expect(scValToNative(args[2])).toBe(BigInt(1500));
    });

    // Contract signature (contracts/dex-router/src/lib.rs list_bond_tokens):
    // (seller, bond_id: u64, amount: i128, price_per_token: i128, quote_asset: Symbol,
    // expires_after_seconds: u64, nonce). Not covered by the pre-existing regression
    // block, which only locked execute_purchase/deposit_quote/withdraw_quote. Every
    // numeric fixture below is distinct so an accidental swap between adjacent
    // same-typed args (amount <-> pricePerToken, or either <-> expiresAfterSeconds)
    // changes the asserted outcome rather than silently passing.
    it('list_bond_tokens sends [seller, bond_id, amount, price_per_token, quote_asset, expires_after_seconds]', async () => {
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(BigInt(1), { type: 'u64' }),
        transactionHash: 'txhash',
        successful: true,
      });
      jest.spyOn(service, 'getOrder').mockResolvedValue({ ...STUB_ORDER, id: 1 });

      const dto: ListBondDto = {
        bondId: 42,
        amount: 777,
        pricePerToken: 33,
        quoteAsset: 'XLM',
        expiresAfterSeconds: 9001,
      };
      await service.listBondTokens(dto, SELLER);

      const args = getLastArgs();
      expect(args).toHaveLength(6);

      // args[0] = seller (Address)
      expect(scValToNative(args[0]) as string).toBe(SELLER);

      // args[1] = bond_id (u64)
      expect(scValToNative(args[1])).toBe(BigInt(42));

      // args[2] = amount (i128) — must come BEFORE price_per_token
      expect(scValToNative(args[2])).toBe(BigInt(777));

      // args[3] = price_per_token (i128) — must come AFTER amount
      expect(scValToNative(args[3])).toBe(BigInt(33));

      // args[4] = quote_asset (symbol)
      expect(scValToNative(args[4])).toBe('XLM');

      // args[5] = expires_after_seconds (u64)
      expect(scValToNative(args[5])).toBe(BigInt(9001));
    });

    // Contract signature (contracts/dex-router/src/lib.rs cancel_listing):
    // (caller, order_id: u64, nonce). Also not covered by the pre-existing block.
    it('cancel_listing sends [caller, order_id]', async () => {
      invokeContractMethodMock.mockResolvedValue({ transactionHash: 'txhash' });

      await service.cancelOrder(17, SELLER);

      const args = getLastArgs();
      expect(args).toHaveLength(2);

      // args[0] = caller (Address)
      expect(scValToNative(args[0]) as string).toBe(SELLER);

      // args[1] = order_id (u64)
      expect(scValToNative(args[1])).toBe(BigInt(17));
    });
  });

  // ---------------------------------------------------------------------------
  // Cache invalidation — order:* and orders:* caches must be evicted so a
  // follow-up getOrder/listOrders never serves pre-trade state. `del('orders:*')`
  // is a no-op against a real Redis (it's not a glob), so this locks in the
  // SCAN + UNLINK replacement.
  // ---------------------------------------------------------------------------

  describe('cache invalidation', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      (redisMock.__store as Map<string, string>).clear();
    });

    describe('invalidateOrderCaches', () => {
      it('unlinks the order detail key and every matching orders:* list key', async () => {
        const store = redisMock.__store as Map<string, string>;
        store.set('order:5', JSON.stringify({ id: 5 }));
        store.set('orders:all:all:1:20', JSON.stringify({ data: [] }));
        store.set('orders:1:Open:1:20', JSON.stringify({ data: [] }));
        store.set('unrelated:key', 'keep-me');

        await (service as any).invalidateOrderCaches(5);

        expect(store.has('order:5')).toBe(false);
        expect(store.has('orders:all:all:1:20')).toBe(false);
        expect(store.has('orders:1:Open:1:20')).toBe(false);
        expect(store.has('unrelated:key')).toBe(true);

        expect(redisMock.unlink).toHaveBeenCalledTimes(1);
        const unlinkedKeys = redisMock.unlink.mock.calls[0][0];
        expect(unlinkedKeys.sort()).toEqual(
          ['order:5', 'orders:1:Open:1:20', 'orders:all:all:1:20'].sort(),
        );
      });

      it('still unlinks the order detail key when there are no cached list pages', async () => {
        await (service as any).invalidateOrderCaches(9);

        expect(redisMock.unlink).toHaveBeenCalledWith(['order:9']);
      });
    });

    it('buyBondTokens invalidates caches for the purchased order after the trade lands', async () => {
      jest.spyOn(service, 'getOrder').mockResolvedValue(STUB_ORDER);
      jest.spyOn(service, 'getQuoteBalance').mockResolvedValue({
        address: SELLER,
        asset: 'USDC',
        balance: 1_000,
      });
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(true),
        transactionHash: 'txhash',
        successful: true,
      });
      const invalidateSpy = jest.spyOn(service as any, 'invalidateOrderCaches');

      const dto = { orderId: 1, maxPrice: 100, amount: 100 };
      await service.buyBondTokens(dto, SELLER);

      expect(invalidateSpy).toHaveBeenCalledWith(1);
      // Must run before the post-trade getOrder re-read, not after.
      const invalidateOrderIndex = invalidateSpy.mock.invocationCallOrder[0];
      const getOrderCalls = (service.getOrder as jest.Mock).mock.invocationCallOrder;
      expect(invalidateOrderIndex).toBeLessThan(getOrderCalls[getOrderCalls.length - 1]);
    });

    it('cancelOrder invalidates caches for the cancelled order', async () => {
      invokeContractMethodMock.mockResolvedValue({ transactionHash: 'txhash' });
      const invalidateSpy = jest.spyOn(service as any, 'invalidateOrderCaches');

      await service.cancelOrder(3, SELLER);

      expect(invalidateSpy).toHaveBeenCalledWith(3);
    });

    it('listBondTokens invalidates caches for the newly created order', async () => {
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(BigInt(11), { type: 'u64' }),
        transactionHash: 'txhash',
        successful: true,
      });
      jest.spyOn(service, 'getOrder').mockResolvedValue({ ...STUB_ORDER, id: 11 });
      const invalidateSpy = jest.spyOn(service as any, 'invalidateOrderCaches');

      const dto: ListBondDto = {
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
      };
      await service.listBondTokens(dto, SELLER);

      expect(invalidateSpy).toHaveBeenCalledWith(11);
    });
  });

  // ---------------------------------------------------------------------------
  // Escrow cycle integration — deposit → list → buy → verify → withdraw
  // ---------------------------------------------------------------------------

  describe('escrow cycle integration', () => {
    const BUYER = ADMIN_PUBLIC_KEY;

    it('completes a full deposit → list → buy → verify balances → withdraw cycle', async () => {
      // Spy on getQuoteBalance to control balance returns without touching simulateCallMock
      const getBalanceSpy = jest.spyOn(service, 'getQuoteBalance');

      // --- Step 1: Deposit 5000 USDC into escrow ---
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'deposit-tx',
        successful: true,
      });
      getBalanceSpy.mockResolvedValueOnce({ address: BUYER, asset: 'USDC', balance: 5000 });

      const depositResult = await service.depositQuote(
        { asset: 'USDC', amount: 5000 },
        BUYER,
      );
      expect(depositResult.balance).toBe(5000);
      expect(depositResult.transactionHash).toBe('deposit-tx');

      // --- Step 2: Seller lists 100 bond tokens at 10 USDC each ---
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(BigInt(1), { type: 'u64' }),
        transactionHash: 'list-tx',
        successful: true,
      });
      jest.spyOn(service, 'getOrder').mockResolvedValue({
        ...STUB_ORDER,
        id: 1,
        seller: SELLER,
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
        status: OrderStatus.Open,
      });

      const listResult = await service.listBondTokens(
        { bondId: 1, amount: 100, pricePerToken: 10, quoteAsset: 'USDC' },
        SELLER,
      );
      expect(listResult.id).toBe(1);

      // --- Step 3: Buyer purchases 30 tokens → proceeds = 300 ---
      jest.spyOn(service, 'getOrder').mockResolvedValue({
        ...STUB_ORDER,
        id: 1,
        seller: SELLER,
        bondId: 1,
        amount: 100,
        pricePerToken: 10,
        quoteAsset: 'USDC',
        status: OrderStatus.Open,
      });

      // Mock getQuoteBalance: buyer has 5000 USDC escrowed
      getBalanceSpy.mockResolvedValueOnce({ address: BUYER, asset: 'USDC', balance: 5000 });

      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(true),
        transactionHash: 'buy-tx',
        successful: true,
      });

      const buyResult = await service.buyBondTokens(
        { orderId: 1, amount: 30, maxPrice: 10 },
        BUYER,
      );
      expect(buyResult.id).toBe(1);

      // Verify execute_purchase was called with the correct method
      expect(invokeContractMethodMock).toHaveBeenCalledWith(
        expect.any(String),
        'execute_purchase',
        expect.any(String),
        expect.any(Array),
        0,
      );

      // --- Step 4: Verify buyer's balance decreased ---
      getBalanceSpy.mockResolvedValueOnce({ address: BUYER, asset: 'USDC', balance: 4700 });

      const buyerBalance = await service.getQuoteBalance(BUYER, 'USDC');
      expect(buyerBalance.balance).toBe(4700);

      // --- Step 5: Verify seller's balance increased ---
      getBalanceSpy.mockResolvedValueOnce({ address: SELLER, asset: 'USDC', balance: 300 });

      const sellerBalance = await service.getQuoteBalance(SELLER, 'USDC');
      expect(sellerBalance.balance).toBe(300);

      // --- Step 6: Seller withdraws 300 USDC proceeds ---
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'withdraw-tx',
        successful: true,
      });
      getBalanceSpy.mockResolvedValueOnce({ address: SELLER, asset: 'USDC', balance: 0 });

      const withdrawResult = await service.withdrawQuote(
        { asset: 'USDC', amount: 300 },
        SELLER,
      );
      expect(withdrawResult.balance).toBe(0);
      expect(withdrawResult.transactionHash).toBe('withdraw-tx');
    });
  });
});
