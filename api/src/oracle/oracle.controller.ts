import {
  Controller, Get, Post, Body, Param, Req,
  HttpCode, HttpStatus, ParseIntPipe, UseGuards,
} from '@nestjs/common';
import { OracleService } from './oracle.service';
import { OracleMonitoringService } from './oracle.monitoring.service';
import { SubmitReportDto } from './dto/submit-report.dto';
import { ChallengeDto } from './dto/challenge.dto';
import { RegisterProviderDto } from './dto/register-provider.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { ProviderGuard } from '../common/guards/provider.guard';
import {
  ReportResponse,
  ChallengeResponse,
  ProviderResponse,
  ProviderStatsWithHistory,
  OracleStalenessReport,
} from './interfaces/oracle.interface';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@Controller('oracle')
export class OracleController {
  constructor(
    private readonly oracleService: OracleService,
    private readonly monitoringService: OracleMonitoringService,
  ) {}

  @Post('reports')
  @UseGuards(JwtAuthGuard, ProviderGuard)
  @HttpCode(HttpStatus.CREATED)
  async submitReport(
    @Body() dto: SubmitReportDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ReportResponse> {
    return this.oracleService.submitReport(dto, req.user.walletAddress);
  }

  @Get('reports/:projectId')
  async getProjectReports(
    @Param('projectId') projectId: string,
  ): Promise<ReportResponse[]> {
    return this.oracleService.getProjectReports(projectId);
  }

  @Post('challenge/:reportId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async challengeReport(
    @Param('reportId', ParseIntPipe) reportId: number,
    @Body() dto: ChallengeDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ChallengeResponse> {
    return this.oracleService.challengeReport(reportId, dto, req.user.walletAddress);
  }

  @Post('providers')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  async registerProvider(@Body() dto: RegisterProviderDto): Promise<ProviderResponse> {
    return this.oracleService.registerProvider(dto);
  }

  @Get('providers')
  async listProviders(): Promise<ProviderResponse[]> {
    const providers = await this.oracleService.listProviders();
    const staleness = await this.monitoringService
      .computeStaleness()
      .catch(() => undefined);
    return this.oracleService.mergeProviderHealth(providers, staleness);
  }

  @Get('stats/:providerAddress')
  async getProviderStats(
    @Param('providerAddress') providerAddress: string,
  ): Promise<ProviderStatsWithHistory> {
    return this.oracleService.getProviderStats(providerAddress);
  }

  @Get('monitoring/staleness')
  async staleness(): Promise<OracleStalenessReport> {
    return this.monitoringService.computeStaleness();
  }
}
