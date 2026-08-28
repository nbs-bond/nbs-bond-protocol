import { Test } from '@nestjs/testing';
import { DexService } from '../src/marketplace/dex.service';
import { ContractService } from '../src/stellar/contract.service';
import { StellarService } from '../src/stellar/stellar.service';
import { NonceService } from '../src/common/services/nonce.service';
import { DepositQuoteDto } from '../src/marketplace/dto/deposit-quote.dto';
import { nativeToScVal } from '@stellar/stellar-sdk';

describe('Marketplace Concurrency (e2e)', () => {
  let dexService: DexService;
  
  const invokeContractMethodMock = jest.fn();
  const simulateCallMock = jest.fn();
  const nonceNextMock = jest.fn();

  beforeAll(async () => {
    // Override redis to not connect in test
    jest.mock('@redis/client', () => ({
      createClient: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        setEx: jest.fn().mockResolvedValue('OK'),
        quit: jest.fn().mockResolvedValue(undefined),
      }),
    }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        DexService,
        {
          provide: ContractService,
          useValue: {
            invokeContractMethod: invokeContractMethodMock,
            simulateCall: simulateCallMock,
          },
        },
        {
          provide: StellarService,
          useValue: {
            getKeypairFromSecret: jest.fn().mockReturnValue({
              publicKey: () => 'GAJRCN6P67RAKN2WHGHRP7D7UGIFNIGD5CIBI2XYPAEG7J5VMXO53KWQ',
            }),
          },
        },
        {
          provide: NonceService,
          useValue: {
            next: nonceNextMock,
            sync: jest.fn(),
          },
        },
      ],
    }).compile();

    dexService = moduleRef.get(DexService);
    // Stub redis manually for the service since we didn't use jest.mock at top level properly
    (dexService as any).redis = {
      connect: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      setEx: jest.fn().mockResolvedValue('OK'),
      quit: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterAll(async () => {
    await dexService.onModuleDestroy();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handles concurrent deposit_quote calls from two different addresses without nonce collision', async () => {
    const user1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const user2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    const dto1: DepositQuoteDto = { asset: 'USDC', amount: 1000 };
    const dto2: DepositQuoteDto = { asset: 'USDC', amount: 2000 };

    // Mock nonce generation so each user gets their own independent sequence
    nonceNextMock.mockImplementation((contract, address) => {
      if (address === user1) return Promise.resolve(10);
      if (address === user2) return Promise.resolve(20);
      return Promise.resolve(0);
    });

    invokeContractMethodMock.mockResolvedValue({
      transactionHash: 'test-hash',
      successful: true,
    });

    simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(0), { type: 'i128' }));

    // Run concurrently
    await Promise.all([
      dexService.depositQuote(dto1, user1),
      dexService.depositQuote(dto2, user2),
    ]);

    expect(nonceNextMock).toHaveBeenCalledTimes(2);
    expect(nonceNextMock).toHaveBeenCalledWith(expect.any(String), user1);
    expect(nonceNextMock).toHaveBeenCalledWith(expect.any(String), user2);

    expect(invokeContractMethodMock).toHaveBeenCalledTimes(2);
    // User 1 uses nonce 10
    expect(invokeContractMethodMock).toHaveBeenCalledWith(
      expect.any(String),
      'deposit_quote',
      expect.any(String),
      expect.any(Array),
      10,
    );
    // User 2 uses nonce 20
    expect(invokeContractMethodMock).toHaveBeenCalledWith(
      expect.any(String),
      'deposit_quote',
      expect.any(String),
      expect.any(Array),
      20,
    );
  });
});
