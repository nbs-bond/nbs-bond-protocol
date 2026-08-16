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
import {
  ReportResponse,
  ChallengeResponse,
  ProviderResponse,
  ProviderStatsWithHistory,
  OracleStalenessReport,
} from './interfaces/oracle.interface';

@Controller('oracle')
export class OracleController {
  constructor(
    private readonly oracleService: OracleService,
    private readonly monitoringService: OracleMonitoringService,
  ) {}

  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  async submitReport(
    @Body() dto: SubmitReportDto,
    @Req() req: any,
  ): Promise<ReportResponse> {
    const providerAddress = req.headers['x-provider-address'] as string || process.env.DEFAULT_PROVIDER_ADDRESS || '';
    return this.oracleService.submitReport(dto, providerAddress);
  }

  @Get('reports/:projectId')
  async getProjectReports(
    @Param('projectId') projectId: string,
  ): Promise<ReportResponse[]> {
    return this.oracleService.getProjectReports(projectId);
  }

  @Post('challenge/:reportId')
  @HttpCode(HttpStatus.OK)
  async challengeReport(
    @Param('reportId', ParseIntPipe) reportId: number,
    @Body() dto: ChallengeDto,
    @Req() req: any,
  ): Promise<ChallengeResponse> {
    const challengerAddress = req.headers['x-wallet-address'] as string || '';
    return this.oracleService.challengeReport(reportId, dto, challengerAddress);
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
