import { Test, TestingModule } from '@nestjs/testing';
import { LiquidityService } from './liquidity.service';
import { DexService } from './dex.service';
import { OrderStatus } from './interfaces/marketplace.interface';

const mockRedis = {
  connect: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  setEx: jest.fn().mockResolvedValue('OK'),
};

jest.mock('@redis/client', () => ({
  createClient: jest.fn(() => mockRedis),
}));

describe('LiquidityService', () => {
  let service: LiquidityService;
  let dexService: jest.Mocked<DexService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiquidityService,
        {
          provide: DexService,
          useValue: {
            listOrders: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<LiquidityService>(LiquidityService);
    dexService = module.get(DexService);
  });

  describe('getPriceFeed', () => {
    it('returns cached price feed if found in Redis', async () => {
      const cached = [{ bondId: 1, bestPrice: 10, averagePrice: 12, totalOrders: 2, totalVolume: 100 }];
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(cached));

      const result = await service.getPriceFeed(1);

      expect(result).toEqual(cached);
      expect(dexService.listOrders).not.toHaveBeenCalled();
    });

    it('queries open orders from DexService and calculates price feed if not cached', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      dexService.listOrders.mockResolvedValue({
        data: [
          { bondId: 1, status: OrderStatus.Open, pricePerToken: 10, amount: 5 } as any,
          { bondId: 1, status: OrderStatus.Open, pricePerToken: 20, amount: 5 } as any,
          { bondId: 1, status: OrderStatus.Cancelled, pricePerToken: 5, amount: 100 } as any,
        ],
        meta: { page: 1, limit: 100, total: 3, totalPages: 1 },
      });

      const result = await service.getPriceFeed(1);

      expect(dexService.listOrders).toHaveBeenCalledWith(1, 'Open', 1, 100);
      expect(result).toEqual([
        {
          bondId: 1,
          bestPrice: 10,
          averagePrice: 15,
          totalOrders: 2,
          totalVolume: 150, // (10*5) + (20*5)
        },
      ]);
      expect(mockRedis.setEx).toHaveBeenCalledWith('pricefeed:1', 30, expect.any(String));
    });
  });

  describe('getBestPrice', () => {
    it('returns zeroed price level when no open orders exist', async () => {
      dexService.listOrders.mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 100, total: 0, totalPages: 1 },
      });

      const result = await service.getBestPrice(1, 'sell');

      expect(result).toEqual({ price: 0, amount: 0, total: 0 });
    });

    it('returns the lowest price order level', async () => {
      dexService.listOrders.mockResolvedValue({
        data: [
          { pricePerToken: 25, amount: 10 } as any,
          { pricePerToken: 15, amount: 5 } as any,
        ],
        meta: { page: 1, limit: 100, total: 2, totalPages: 1 },
      });

      const result = await service.getBestPrice(1, 'buy');

      expect(result).toEqual({ price: 15, amount: 5, total: 75 });
    });
  });

  describe('calculateSlippage', () => {
    it('calculates average price and slippage percentage across multiple order levels', async () => {
      dexService.listOrders.mockResolvedValue({
        data: [
          { pricePerToken: 10, amount: 5 } as any,
          { pricePerToken: 20, amount: 5 } as any,
        ],
        meta: { page: 1, limit: 100, total: 2, totalPages: 1 },
      });

      const result = await service.calculateSlippage(1, 10);

      // Total cost: (5 * 10) + (5 * 20) = 150. Average price: 150 / 10 = 15.
      // Ideal cost: 10 * 10 = 100.
      // Slippage: ((150 - 100) / 100) * 100 = 50%.
      expect(result).toEqual({
        bondId: 1,
        amount: 10,
        averagePrice: 15,
        estimatedTotal: 150,
        slippagePercent: 50,
      });
    });

    it('handles empty open order book gracefully', async () => {
      dexService.listOrders.mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 100, total: 0, totalPages: 1 },
      });

      const result = await service.calculateSlippage(1, 10);

      expect(result).toEqual({
        bondId: 1,
        amount: 10,
        averagePrice: 0,
        estimatedTotal: 0,
        slippagePercent: 0,
      });
    });
  });
});
