import { Test, TestingModule } from '@nestjs/testing';
import { MarketplaceController } from './marketplace.controller';
import { DexService } from './dex.service';
import { LiquidityService } from './liquidity.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('MarketplaceController', () => {
  let controller: MarketplaceController;
  let dexService: jest.Mocked<DexService>;
  let liquidityService: jest.Mocked<LiquidityService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MarketplaceController],
      providers: [
        {
          provide: DexService,
          useValue: {
            listOrders: jest.fn(),
            listBondTokens: jest.fn(),
            buyBondTokens: jest.fn(),
            getQuoteBalance: jest.fn(),
            depositQuote: jest.fn(),
            withdrawQuote: jest.fn(),
            cancelOrder: jest.fn(),
            getOrder: jest.fn(),
          },
        },
        {
          provide: LiquidityService,
          useValue: {
            getPriceFeed: jest.fn(),
            getBestPrice: jest.fn(),
            calculateSlippage: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<MarketplaceController>(MarketplaceController);
    dexService = module.get(DexService);
    liquidityService = module.get(LiquidityService);
  });

  it('listOrders delegates to dexService.listOrders', async () => {
    const expected = { data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 1 } };
    dexService.listOrders.mockResolvedValue(expected);

    const result = await controller.listOrders(1, 'Open', 1, 20);

    expect(dexService.listOrders).toHaveBeenCalledWith(1, 'Open', 1, 20);
    expect(result).toBe(expected);
  });

  it('listBondTokens delegates to dexService.listBondTokens', async () => {
    const dto = { bondId: 1, amount: 10, pricePerToken: 5 };
    const req = { headers: { 'x-wallet-address': 'GSELLER' } };
    const expected = { orderId: 1 } as any;
    dexService.listBondTokens.mockResolvedValue(expected);

    const result = await controller.listBondTokens(dto as any, req);

    expect(dexService.listBondTokens).toHaveBeenCalledWith(dto, 'GSELLER');
    expect(result).toBe(expected);
  });

  it('buyBondTokens delegates to dexService.buyBondTokens', async () => {
    const dto = { orderId: 1, amount: 5 };
    const req = { headers: { 'x-wallet-address': 'GBUYER' } };
    const expected = { orderId: 1 } as any;
    dexService.buyBondTokens.mockResolvedValue(expected);

    const result = await controller.buyBondTokens(dto as any, req);

    expect(dexService.buyBondTokens).toHaveBeenCalledWith(dto, 'GBUYER');
    expect(result).toBe(expected);
  });

  it('getQuoteBalance delegates to dexService.getQuoteBalance with header address', async () => {
    const req = { headers: { 'x-wallet-address': 'GUSER' } };
    const expected = { balance: '100', asset: 'USDC' } as any;
    dexService.getQuoteBalance.mockResolvedValue(expected);

    const result = await controller.getQuoteBalance({ asset: 'USDC' }, req);

    expect(dexService.getQuoteBalance).toHaveBeenCalledWith('GUSER', 'USDC');
    expect(result).toBe(expected);
  });

  it('getQuoteBalanceByAddress delegates to dexService.getQuoteBalance with param address', async () => {
    const expected = { balance: '200', asset: 'USDC' } as any;
    dexService.getQuoteBalance.mockResolvedValue(expected);

    const result = await controller.getQuoteBalanceByAddress('GPARAM', { asset: 'USDC' });

    expect(dexService.getQuoteBalance).toHaveBeenCalledWith('GPARAM', 'USDC');
    expect(result).toBe(expected);
  });

  it('depositQuote delegates to dexService.depositQuote', async () => {
    const dto = { amount: 50 };
    const req = { headers: { 'x-wallet-address': 'GUSER' } };
    const expected = { txHash: 'tx123' } as any;
    dexService.depositQuote.mockResolvedValue(expected);

    const result = await controller.depositQuote(dto as any, req);

    expect(dexService.depositQuote).toHaveBeenCalledWith(dto, 'GUSER');
    expect(result).toBe(expected);
  });

  it('withdrawQuote delegates to dexService.withdrawQuote', async () => {
    const dto = { amount: 20 };
    const req = { headers: { 'x-wallet-address': 'GUSER' } };
    const expected = { txHash: 'tx456' } as any;
    dexService.withdrawQuote.mockResolvedValue(expected);

    const result = await controller.withdrawQuote(dto as any, req);

    expect(dexService.withdrawQuote).toHaveBeenCalledWith(dto, 'GUSER');
    expect(result).toBe(expected);
  });

  it('cancelOrder delegates to dexService.cancelOrder', async () => {
    const req = { headers: { 'x-wallet-address': 'GUSER' } };
    dexService.cancelOrder.mockResolvedValue(undefined);

    await controller.cancelOrder(1, req);

    expect(dexService.cancelOrder).toHaveBeenCalledWith(1, 'GUSER');
  });

  it('getOrder delegates to dexService.getOrder', async () => {
    const expected = { orderId: 1 } as any;
    dexService.getOrder.mockResolvedValue(expected);

    const result = await controller.getOrder(1);

    expect(dexService.getOrder).toHaveBeenCalledWith(1);
    expect(result).toBe(expected);
  });

  it('getPriceFeed delegates to liquidityService.getPriceFeed', async () => {
    const expected = [{ bondId: 1 }] as any;
    liquidityService.getPriceFeed.mockResolvedValue(expected);

    const result = await controller.getPriceFeed(1);

    expect(liquidityService.getPriceFeed).toHaveBeenCalledWith(1);
    expect(result).toBe(expected);
  });

  it('getBestPrice delegates to liquidityService.getBestPrice', async () => {
    const expected = { price: 10, amount: 5, total: 50 };
    liquidityService.getBestPrice.mockResolvedValue(expected);

    const result = await controller.getBestPrice(1, 'buy');

    expect(liquidityService.getBestPrice).toHaveBeenCalledWith(1, 'buy');
    expect(result).toBe(expected);
  });

  it('calculateSlippage delegates to liquidityService.calculateSlippage', async () => {
    const expected = { bondId: 1, amount: 10, averagePrice: 15, estimatedTotal: 150, slippagePercent: 5 };
    liquidityService.calculateSlippage.mockResolvedValue(expected);

    const result = await controller.calculateSlippage(1, 10);

    expect(liquidityService.calculateSlippage).toHaveBeenCalledWith(1, 10);
    expect(result).toBe(expected);
  });
});

describe('MarketplaceController guards', () => {
  const GUARDS_METADATA = '__guards__';

  it.each([
    'listBondTokens',
    'buyBondTokens',
    'depositQuote',
    'withdrawQuote',
    'cancelOrder',
  ] as const)('guards %s with JWT authentication', (handler) => {
    const guards: unknown[] = Reflect.getMetadata(
      GUARDS_METADATA,
      MarketplaceController.prototype[handler],
    );
    expect(guards).toEqual([JwtAuthGuard]);
  });

  it.each(['listOrders', 'getOrder', 'getPriceFeed', 'getBestPrice'] as const)(
    'keeps %s public',
    (handler) => {
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          MarketplaceController.prototype[handler],
        ),
      ).toBeUndefined();
    },
  );
});
