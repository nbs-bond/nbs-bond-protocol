import {
  Controller, Get, Post, Body, Param, Query, Req,
  HttpCode, HttpStatus, UseGuards, ParseIntPipe,
} from '@nestjs/common';
import { BondsService } from './bonds.service';
import { CreateBondDto } from './dto/create-bond.dto';
import { SubscribeDto, PrepareSubscribeDto } from './dto/subscribe.dto';
import { DistributeCouponDto } from './dto/distribute-coupon.dto';
import { ClaimCreditsDto, PrepareClaimDto } from './dto/claim-credits.dto';
import { TransferBondDto, PrepareTransferDto } from './dto/transfer-bond.dto';
import { SweepUndistributedDto } from './dto/sweep-undistributed.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PeriodsQueryDto } from './dto/periods-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import {
  BondResponse,
  SubscriptionResponse,
  ClaimPrepareResponse,
  PrepareTransactionResponse,
  HolderListResponse,
  CouponDistributionResponse,
  ClaimCreditsResponse,
  TransferResponse,
  UndistributedTotalResponse,
  AccruedCreditsResponse,
  SweepUndistributedResponse,
  PeriodListResponse,
} from './interfaces/bond.interface';

@Controller('bonds')
export class BondsController {
  constructor(private readonly bondsService: BondsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateBondDto): Promise<BondResponse> {
    return this.bondsService.create(dto);
  }

  @Get()
  async findAll(@Query() query: PaginationDto) {
    return this.bondsService.findAll(query.page, query.limit);
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<BondResponse> {
    return this.bondsService.findOne(id);
  }

  /**
   * Step 1 of the pre-signed-transaction subscribe flow: returns an unsigned
   * transaction XDR for the investor's own wallet to sign. The API never
   * builds and signs a subscribe transaction on the investor's behalf — see
   * BondsService.prepareSubscribe().
   */
  @Post(':id/subscribe/prepare')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async prepareSubscribe(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PrepareSubscribeDto,
  ): Promise<PrepareTransactionResponse> {
    return this.bondsService.prepareSubscribe(id, dto);
  }

  /**
   * Step 2: submits the transaction envelope the investor's wallet signed
   * from POST :id/subscribe/prepare.
   */
  @Post(':id/subscribe')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async subscribe(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubscribeDto,
  ): Promise<SubscriptionResponse> {
    return this.bondsService.subscribe(id, dto);
  }

  @Get(':id/holders')
  async getHolders(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<HolderListResponse> {
    return this.bondsService.getHolders(id);
  }

  @Post(':id/coupon')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async distributeCoupon(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DistributeCouponDto,
  ): Promise<CouponDistributionResponse> {
    return this.bondsService.distributeCoupon(id, dto);
  }

  /**
   * Claims the caller's accrued coupon credits for bond `:id`.
   *
   * The claiming address is taken from the authenticated session (the JWT
   * `sub` claim), never from an unverified request field: `investorAddress`
   * in the body is optional and, when present, must match the session address
   * or the request is rejected with 403.
   */
  /**
   * Step 1 of the pre-signed-transaction claim flow: returns an unsigned
   * transaction XDR for the claimant's own wallet to sign, or a `credits: 0`
   * no-op response (with `xdr`/`nonce: null`) when nothing is accrued — see
   * BondsService.prepareClaim().
   */
  @Post(':id/claim/prepare')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async prepareClaim(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PrepareClaimDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClaimPrepareResponse> {
    return this.bondsService.prepareClaim(id, dto, req.user.walletAddress);
  }

  /**
   * Step 2: submits the transaction envelope the claimant's wallet signed
   * from POST :id/claim/prepare.
   */
  @Post(':id/claim')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async claimCredits(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ClaimCreditsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClaimCreditsResponse> {
    return this.bondsService.claimCredits(id, dto, req.user.walletAddress);
  }

  @Get(':id/undistributed')
  async getUndistributedTotal(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<UndistributedTotalResponse> {
    return this.bondsService.getUndistributedTotal(id);
  }

  @Get(':id/periods')
  async getPeriods(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PeriodsQueryDto,
  ): Promise<PeriodListResponse> {
    return this.bondsService.getPeriods(
      id,
      query.page,
      query.limit,
      query.includeReport,
    );
  }

  @Get(':id/accrued')
  async getAccruedCredits(
    @Param('id', ParseIntPipe) id: number,
    @Query('holder') holder: string,
  ): Promise<AccruedCreditsResponse> {
    return this.bondsService.getAccruedCredits(id, holder);
  }

  /**
   * Admin dust recovery. Swept remainder is credited to `destination`'s
   * AccruedCredits (claimable via POST /bonds/:id/claim). When `destination`
   * is omitted the protocol admin wallet is used.
   */
  @Post(':id/sweep-undistributed')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async sweepUndistributed(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SweepUndistributedDto,
  ): Promise<SweepUndistributedResponse> {
    return this.bondsService.sweepUndistributed(id, dto?.destination);
  }

  /**
   * Step 1 of the pre-signed-transaction transfer flow: returns an unsigned
   * transaction XDR for the sending wallet to sign.
   */
  @Post(':id/transfer/prepare')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async prepareTransfer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PrepareTransferDto,
  ): Promise<PrepareTransactionResponse> {
    return this.bondsService.prepareTransfer(id, dto);
  }

  /**
   * Step 2: submits the transaction envelope the sending wallet signed from
   * POST :id/transfer/prepare.
   */
  @Post(':id/transfer')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async transfer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TransferBondDto,
  ): Promise<TransferResponse> {
    return this.bondsService.transfer(id, dto);
  }

  @Post(':id/mature')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async mature(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<BondResponse> {
    return this.bondsService.mature(id);
  }
}
