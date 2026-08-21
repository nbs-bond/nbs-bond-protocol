import {
  Controller, Get, Post, Delete, Body, Param, Query, Req,
  HttpCode, HttpStatus, ParseIntPipe, UseGuards,
} from '@nestjs/common';
import { DexService } from './dex.service';
import { LiquidityService } from './liquidity.service';
import { ListBondDto } from './dto/list-bond.dto';
import { BuyBondDto } from './dto/buy-bond.dto';
import { DepositQuoteDto } from './dto/deposit-quote.dto';
import { WithdrawQuoteDto } from './dto/withdraw-quote.dto';
import { QuoteBalanceQueryDto } from './dto/quote-balance-query.dto';
import {
  OrderResponse,
  PriceFeedResponse,
  PriceLevel,
  QuoteBalanceResponse,
  QuoteTransactionResponse,
  SlippageResponse,
} from './interfaces/marketplace.interface';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('marketplace')
export class MarketplaceController {
  constructor(
    private readonly dexService: DexService,
    private readonly liquidityService: LiquidityService,
  ) {}

  @Get('orders')
  async listOrders(
    @Query('bondId') bondId?: number,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<PaginatedResponse<OrderResponse>> {
    return this.dexService.listOrders(
      bondId ? Number(bondId) : undefined,
      status,
      page || 1,
      limit || 20,
    );
  }

  @Post('list')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async listBondTokens(
    @Body() dto: ListBondDto,
    @Req() req: any,
  ): Promise<OrderResponse> {
    const sellerAddress = req.headers['x-wallet-address'] as string || '';
    return this.dexService.listBondTokens(dto, sellerAddress);
  }

  @Post('buy')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async buyBondTokens(
    @Body() dto: BuyBondDto,
    @Req() req: any,
  ): Promise<OrderResponse> {
    const buyerAddress = req.headers['x-wallet-address'] as string || '';
    return this.dexService.buyBondTokens(dto, buyerAddress);
  }

  @Get('quote-balance')
  async getQuoteBalance(
    @Query() query: QuoteBalanceQueryDto,
    @Req() req: any,
  ): Promise<QuoteBalanceResponse> {
    const address = req.headers['x-wallet-address'] as string || '';
    return this.dexService.getQuoteBalance(address, query.asset ?? 'USDC');
  }

  @Get('balance/:address')
  async getQuoteBalanceByAddress(
    @Param('address') address: string,
    @Query() query: QuoteBalanceQueryDto,
  ): Promise<QuoteBalanceResponse> {
    return this.dexService.getQuoteBalance(address, query.asset ?? 'USDC');
  }

  @Post('deposit')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async depositQuote(
    @Body() dto: DepositQuoteDto,
    @Req() req: any,
  ): Promise<QuoteTransactionResponse> {
    const address = req.headers['x-wallet-address'] as string || '';
    return this.dexService.depositQuote(dto, address);
  }

  @Post('withdraw')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async withdrawQuote(
    @Body() dto: WithdrawQuoteDto,
    @Req() req: any,
  ): Promise<QuoteTransactionResponse> {
    const address = req.headers['x-wallet-address'] as string || '';
    return this.dexService.withdrawQuote(dto, address);
  }

  @Delete('orders/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelOrder(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ): Promise<void> {
    const callerAddress = req.headers['x-wallet-address'] as string || '';
    return this.dexService.cancelOrder(id, callerAddress);
  }

  @Get('orders/:id')
  async getOrder(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<OrderResponse> {
    return this.dexService.getOrder(id);
  }

  @Get('prices')
  async getPriceFeed(
    @Query('bondId') bondId?: number,
  ): Promise<PriceFeedResponse[]> {
    return this.liquidityService.getPriceFeed(bondId ? Number(bondId) : undefined);
  }

  @Get('prices/:bondId/best')
  async getBestPrice(
    @Param('bondId', ParseIntPipe) bondId: number,
    @Query('side') side: 'buy' | 'sell' = 'sell',
  ): Promise<PriceLevel> {
    return this.liquidityService.getBestPrice(bondId, side);
  }

  @Get('prices/:bondId/slippage')
  async calculateSlippage(
    @Param('bondId', ParseIntPipe) bondId: number,
    @Query('amount') amount: number,
  ): Promise<SlippageResponse> {
    return this.liquidityService.calculateSlippage(bondId, Number(amount));
  }
}
