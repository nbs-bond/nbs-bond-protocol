import {
  Controller, Get, Post, Body, Param, Query, Req,
  HttpCode, HttpStatus, UseGuards, ParseIntPipe,
} from '@nestjs/common';
import { BondsService } from './bonds.service';
import { CreateBondDto } from './dto/create-bond.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { DistributeCouponDto } from './dto/distribute-coupon.dto';
import { ClaimCreditsDto } from './dto/claim-credits.dto';
import { TransferBondDto } from './dto/transfer-bond.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PeriodsQueryDto } from './dto/periods-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import {
  BondResponse,
  SubscriptionResponse,
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

  @Post(':id/sweep-undistributed')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async sweepUndistributed(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SweepUndistributedResponse> {
    return this.bondsService.sweepUndistributed(id);
  }

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
