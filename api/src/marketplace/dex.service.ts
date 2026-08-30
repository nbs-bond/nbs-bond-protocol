import {
  Injectable,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { ListBondDto } from './dto/list-bond.dto';
import { BuyBondDto } from './dto/buy-bond.dto';
import { DepositQuoteDto } from './dto/deposit-quote.dto';
import { WithdrawQuoteDto } from './dto/withdraw-quote.dto';
import {
  OrderResponse,
  OrderStatus,
  QuoteAsset,
  QuoteBalanceResponse,
  QuoteTransactionResponse,
  OnChainPriceQuote,
} from './interfaces/marketplace.interface';
import { createClient, RedisClientType } from '@redis/client';
import { nativeToScVal, scValToNative, Address, xdr } from '@stellar/stellar-sdk';
import { PaginatedResponse } from '../common/dto/pagination.dto';

const DEX_ROUTER = () => process.env.DEX_ROUTER_ADDRESS || '';

const DEX_ERROR_CODE = {
  NotInitialized: 1,
  Unauthorized: 2,
  InvalidNonce: 3,
  OrderNotFound: 4,
  OrderAlreadyFilled: 5,
  InsufficientBalance: 6,
  SelfBuyNotAllowed: 7,
  OrderExpired: 8,
  ZeroAmount: 9,
  InsufficientFunds: 10,
  Overflow: 11,
  SellerBalanceDepleted: 12,
} as const;

@Injectable()
export class DexService implements OnModuleDestroy {
  private readonly logger = new Logger(DexService.name);
  private redis: RedisClientType;

  constructor(
    private readonly contractService: ContractService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
  ) {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  async listOrders(
    bondId?: number,
    status?: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<OrderResponse> & { meta: { hasMore?: boolean } }> {
    const cacheKey = `orders:${bondId || 'all'}:${status || 'all'}:${page}:${limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Skip the first (page-1)*limit matching orders, then collect `limit` more.
    const skipCount = (page - 1) * limit;
    let skipped = 0;
    const orders: OrderResponse[] = [];
    let index = 1;

    while (orders.length < limit) {
      let order: OrderResponse;
      try {
        const orderScVal = await this.contractService.simulateCall({
          contractAddress: DEX_ROUTER(),
          method: 'get_order',
          args: [nativeToScVal(BigInt(index), { type: 'u64' })],
        });
        order = this.decodeOrder(scValToNative(orderScVal) as any[]);
      } catch (err) {
        // OrderNotFound (code 4) is the legitimate end-of-list signal.
        // Any other error is a real fault — surface it instead of silently
        // truncating the listing.
        if (this.isOrderNotFound(err)) {
          break;
        }
        throw err;
      }

      index++;

      // Apply filters — unmatched orders don't count against the page quota.
      if (bondId !== undefined && order.bondId !== bondId) continue;
      if (status !== undefined && order.status !== status) continue;

      // Skip orders belonging to earlier pages.
      if (skipped < skipCount) {
        skipped++;
        continue;
      }

      orders.push(order);
    }

    // hasMore is true when we filled the page and there may be more orders
    // beyond index-1. We cannot know the exact total without get_order_count
    // (#119), so we surface hasMore rather than a potentially-wrong total.
    const hasMore = orders.length === limit;

    const result = {
      data: orders,
      meta: {
        page,
        limit,
        total: orders.length,
        totalPages: 1,
        hasMore,
      },
    };

    await this.redis.setEx(cacheKey, 30, JSON.stringify(result));
    return result;
  }

  /** Returns true when the thrown error is an on-chain OrderNotFound (code 4). */
  private isOrderNotFound(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/#(\d+)/) ?? message.match(/Error\(-(\d+)/);
    const code = match ? Number(match[1]) : undefined;
    return code === DEX_ERROR_CODE.OrderNotFound;
  }

  async listBondTokens(dto: ListBondDto, sellerAddress: string): Promise<OrderResponse> {
    const adminSecret = this.getAdminSecret();
    const nonce = await this.nonceService.next(DEX_ROUTER(), sellerAddress);

    const { result } = await this.contractService.invokeContractMethod(
      DEX_ROUTER(), 'list_bond_tokens', adminSecret,
      [
        Address.fromString(sellerAddress).toScVal(),
        nativeToScVal(BigInt(dto.bondId), { type: 'u64' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
        nativeToScVal(BigInt(dto.pricePerToken), { type: 'i128' }),
        nativeToScVal(dto.quoteAsset, { type: 'symbol' }),
        nativeToScVal(BigInt(dto.expiresAfterSeconds ?? 86400), { type: 'u64' }),
      ],
      nonce,
    );

    const orderId = Number(scValToNative(result));
    await this.invalidateOrderCaches(orderId);
    return this.getOrder(orderId);
  }

  async buyBondTokens(dto: BuyBondDto, buyerAddress: string): Promise<OrderResponse> {
    const order = await this.getOrder(dto.orderId);
    const proceeds = order.pricePerToken * dto.amount;

    const escrowed = await this.getQuoteBalance(buyerAddress, order.quoteAsset);
    if (escrowed.balance < proceeds) {
      throw new BadRequestException(
        `Insufficient escrowed ${order.quoteAsset}: required ${proceeds}, escrowed ${escrowed.balance}. ` +
        'Call POST /marketplace/deposit before purchasing.',
      );
    }

    const adminSecret = this.getAdminSecret();
    const nonce = await this.nonceService.next(DEX_ROUTER(), buyerAddress);

    try {
      // Contract signature (contracts/dex-router/src/lib.rs execute_purchase):
      // (buyer, order_id, max_price: i128, amount: i128, nonce) — max_price comes BEFORE amount.
      await this.contractService.invokeContractMethod(
        DEX_ROUTER(), 'execute_purchase', adminSecret,
        [
          Address.fromString(buyerAddress).toScVal(),
          nativeToScVal(BigInt(dto.orderId), { type: 'u64' }),
          nativeToScVal(BigInt(dto.maxPrice), { type: 'i128' }),
          nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
        ],
        nonce,
      );
    } catch (error) {
      // The buy attempt consumed one API-managed nonce slot before failing.
      // Soroban transactions are atomic, so the on-chain nonce and the escrow
      // bookkeeping were rolled back with the frame — re-sync the nonce mirror
      // from the chain so the buyer can simply retry the purchase instead of
      // hitting InvalidNonce on the next attempt.
      await this.nonceService.sync(DEX_ROUTER(), buyerAddress).catch(() => undefined);
      throw this.mapDexError(error);
    }

    await this.invalidateOrderCaches(dto.orderId);
    return this.getOrder(dto.orderId);
  }

  async cancelOrder(orderId: number, callerAddress: string): Promise<void> {
    const adminSecret = this.getAdminSecret();
    const nonce = await this.nonceService.next(DEX_ROUTER(), callerAddress);

    await this.contractService.invokeContractMethod(
      DEX_ROUTER(), 'cancel_listing', adminSecret,
      [
        Address.fromString(callerAddress).toScVal(),
        nativeToScVal(BigInt(orderId), { type: 'u64' }),
      ],
      nonce,
    );

    await this.invalidateOrderCaches(orderId);
  }

  async getOrder(orderId: number): Promise<OrderResponse> {
    const cacheKey = `order:${orderId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const orderScVal = await this.contractService.simulateCall({
      contractAddress: DEX_ROUTER(),
      method: 'get_order',
      args: [nativeToScVal(BigInt(orderId), { type: 'u64' })],
    });
    const order = this.decodeOrder(scValToNative(orderScVal) as any[]);

    await this.redis.setEx(cacheKey, 60, JSON.stringify(order));
    return order;
  }

  // `del('orders:*')` does not glob-match; SCAN for the real keys and UNLINK them.
  private async invalidateOrderCaches(orderId: number): Promise<void> {
    const keys = [`order:${orderId}`];

    for await (const key of this.redis.scanIterator({ MATCH: 'orders:*', COUNT: 100 })) {
      keys.push(key as unknown as string);
    }

    await this.redis.unlink(keys);
  }

  async getBestPrice(
    bondId: number,
    side: 'buy' | 'sell',
    amount: number,
  ): Promise<OnChainPriceQuote> {
    const sideScVal = xdr.ScVal.scvVec([
      nativeToScVal(side === 'buy' ? 'Buy' : 'Sell', { type: 'symbol' }),
    ]);
    const quoteScVal = await this.contractService.simulateCall({
      contractAddress: DEX_ROUTER(),
      method: 'get_best_price',
      args: [
        nativeToScVal(BigInt(bondId), { type: 'u64' }),
        sideScVal,
        nativeToScVal(BigInt(amount), { type: 'i128' }),
      ],
    });
    const [price, total, slippageBps] = scValToNative(quoteScVal) as bigint[];

    return {
      price: Number(price),
      total: Number(total),
      slippageBps: Number(slippageBps),
    };
  }

  async getQuoteBalance(
    address: string,
    asset: QuoteAsset = 'USDC',
  ): Promise<QuoteBalanceResponse> {
    const balanceScVal = await this.contractService.simulateCall({
      contractAddress: DEX_ROUTER(),
      method: 'get_quote_balance',
      args: [
        Address.fromString(address).toScVal(),
        nativeToScVal(asset, { type: 'symbol' }),
      ],
    });
    const balance = Number(scValToNative(balanceScVal));
    return { address, asset, balance };
  }

  async depositQuote(
    dto: DepositQuoteDto,
    callerAddress: string,
  ): Promise<QuoteTransactionResponse> {
    const adminSecret = this.getAdminSecret();
    const nonce = await this.nonceService.next(DEX_ROUTER(), callerAddress);

    // Contract signature (contracts/dex-router/src/lib.rs deposit_quote):
    // (caller, quote_asset: Symbol, amount: i128, nonce).
    const { transactionHash } = await this.contractService.invokeContractMethod(
      DEX_ROUTER(), 'deposit_quote', adminSecret,
      [
        Address.fromString(callerAddress).toScVal(),
        nativeToScVal(dto.asset, { type: 'symbol' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      nonce,
    );

    const { balance } = await this.getQuoteBalance(callerAddress, dto.asset);

    return { address: callerAddress, asset: dto.asset, amount: dto.amount, balance, transactionHash };
  }

  async withdrawQuote(
    dto: WithdrawQuoteDto,
    callerAddress: string,
  ): Promise<QuoteTransactionResponse> {
    const adminSecret = this.getAdminSecret();
    const nonce = await this.nonceService.next(DEX_ROUTER(), callerAddress);

    // Contract signature (contracts/dex-router/src/lib.rs withdraw_quote):
    // (caller, quote_asset: Symbol, amount: i128, nonce).
    const { transactionHash } = await this.contractService.invokeContractMethod(
      DEX_ROUTER(), 'withdraw_quote', adminSecret,
      [
        Address.fromString(callerAddress).toScVal(),
        nativeToScVal(dto.asset, { type: 'symbol' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      nonce,
    );

    const { balance } = await this.getQuoteBalance(callerAddress, dto.asset);

    return { address: callerAddress, asset: dto.asset, amount: dto.amount, balance, transactionHash };
  }

  private decodeOrder(data: any[]): OrderResponse {
    return {
      id: Number(data[0]),
      seller: data[1] as string,
      bondId: Number(data[2]),
      amount: Number(data[3]),
      pricePerToken: Number(data[4]),
      quoteAsset: data[5] as QuoteAsset,
      status: this.orderStatusFromIndex(Number(data[6])),
      createdAt: new Date(Number(data[7]) * 1000).toISOString(),
    };
  }

  private orderStatusFromIndex(index: number): OrderStatus {
    return (
      [
        OrderStatus.Open,
        OrderStatus.PartiallyFilled,
        OrderStatus.Filled,
        OrderStatus.Cancelled,
        OrderStatus.Expired,
      ][index] ?? OrderStatus.Open
    );
  }

  private getAdminSecret(): string {
    return process.env.ADMIN_SECRET_KEY || '';
  }

  private getAdminPublicKey(): string {
    return this.stellarService.getKeypairFromSecret(this.getAdminSecret()).publicKey();
  }

  private mapDexError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/#(\d+)/) ?? message.match(/Error\(-(\d+)/);
    const code = match ? Number(match[1]) : undefined;

    if (code === DEX_ERROR_CODE.InsufficientFunds) {
      return new HttpException(
        'Insufficient escrowed funds. Call POST /marketplace/deposit before purchasing.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    if (code === DEX_ERROR_CODE.SellerBalanceDepleted) {
      return new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message:
            'Order could not be filled because the seller no longer holds enough ' +
            'bond tokens. Your escrowed funds were not debited and remain ' +
            'available. The nonce for this attempted purchase was consumed — ' +
            'retry the purchase.',
          reason: 'seller_balance_depleted',
          nonce_consumed: true,
        },
        HttpStatus.CONFLICT,
      );
    }

    if (error instanceof HttpException) {
      return error;
    }

    return new BadRequestException(message);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis.isReady) {
        await this.redis.quit();
        this.logger.log('DexService: Redis connection closed gracefully');
      } else if (this.redis.isOpen) {
        // The connection never reached the ready state (e.g. Redis was
        // unavailable on startup); quit() would hang waiting for a reply.
        this.redis.disconnect();
      }
    } catch (error) {
      this.logger.warn(
        `DexService: error closing Redis connection: ${error?.message ?? error}`,
      );
    }
  }
}
