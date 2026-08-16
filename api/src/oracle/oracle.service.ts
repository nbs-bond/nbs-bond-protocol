import { Injectable, BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { ContractService } from '../stellar/contract.service';
import { toBytes32 } from '../stellar/bytes32';
import { IpfsService } from '../projects/ipfs.service';
import { NonceService } from '../common/services/nonce.service';
import { SubmitReportDto } from './dto/submit-report.dto';
import { ChallengeDto } from './dto/challenge.dto';
import { RegisterProviderDto } from './dto/register-provider.dto';
import {
  ReportResponse,
  ChallengeResponse,
  ProviderResponse,
  ProviderStatsWithHistory,
  ProviderHealthStatus,
  ProviderStalenessMetric,
  SlashRecord,
  ChallengeRecord,
  ReportStatus,
  OracleStalenessReport,
} from './interfaces/oracle.interface';
import { createClient, RedisClientType } from '@redis/client';
import { nativeToScVal, scValToNative, Address } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';

const ORACLE_CONSUMER = () => process.env.ORACLE_CONSUMER_ADDRESS || '';

const ORACLE_ERROR_CODE = {
  NotInitialized: 1,
  Unauthorized: 2,
  InvalidNonce: 3,
  ProviderNotFound: 4,
  ProviderAlreadyExists: 5,
};

@Injectable()
export class OracleService {
  private redis: RedisClientType;

  constructor(
    private readonly contractService: ContractService,
    private readonly ipfsService: IpfsService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
  ) {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  async submitReport(dto: SubmitReportDto, providerAddress: string): Promise<ReportResponse> {
    const ipfsResult = await this.ipfsService.uploadJson({
      projectId: dto.projectId,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      carbonSequestered: dto.carbonSequestered,
      methodology: dto.methodology,
      evidenceHash: dto.evidenceHash,
      providerAddress,
      timestamp: new Date().toISOString(),
    });

    const adminSecret = this.getAdminSecret();
    const nonce = await this.nonceService.next(ORACLE_CONSUMER(), providerAddress);

    const { result } = await this.contractService.invokeContractMethod(
      ORACLE_CONSUMER(), 'submit_report', adminSecret,
      [
        Address.fromString(providerAddress).toScVal(),
        toBytes32(dto.projectId),
        nativeToScVal(BigInt(dto.periodStart), { type: 'u64' }),
        nativeToScVal(BigInt(dto.periodEnd), { type: 'u64' }),
        nativeToScVal(BigInt(dto.carbonSequestered), { type: 'i128' }),
        nativeToScVal(dto.methodology, { type: 'symbol' }),
        toBytes32(ipfsResult.hash),
      ],
      nonce,
    );

    const reportId = Number(scValToNative(result));

    return {
      id: reportId,
      projectId: dto.projectId,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      carbonSequestered: dto.carbonSequestered,
      methodology: dto.methodology,
      ipfsHash: ipfsResult.hash,
      providerAddress,
      status: ReportStatus.Pending,
      createdAt: new Date().toISOString(),
    };
  }

  async getProjectReports(projectId: string): Promise<ReportResponse[]> {
    const cacheKey = `reports:${projectId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const idsScVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'get_project_reports',
      args: [toBytes32(projectId)],
    });
    const ids = scValToNative(idsScVal) as number[];

    const reports: ReportResponse[] = [];
    for (const reportId of ids) {
      try {
        const reportScVal = await this.contractService.simulateCall({
          contractAddress: ORACLE_CONSUMER(),
          method: 'get_report',
          args: [nativeToScVal(BigInt(reportId), { type: 'u64' })],
        });
        reports.push(this.decodeReport(scValToNative(reportScVal) as any[]));
      } catch {}
    }

    await this.redis.setEx(cacheKey, 60, JSON.stringify(reports));
    return reports;
  }

  async challengeReport(reportId: number, dto: ChallengeDto, challengerAddress: string): Promise<ChallengeResponse> {
    const adminSecret = this.getAdminSecret();
    const nonce = await this.nonceService.next(ORACLE_CONSUMER(), challengerAddress);

    await this.contractService.invokeContractMethod(
      ORACLE_CONSUMER(), 'challenge_report', adminSecret,
      [
        Address.fromString(challengerAddress).toScVal(),
        nativeToScVal(BigInt(reportId), { type: 'u64' }),
        toBytes32(dto.counterEvidenceHash),
      ],
      nonce,
    );

    return {
      reportId,
      challengerAddress,
      reason: dto.reason,
      counterEvidenceHash: dto.counterEvidenceHash,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
  }

  async registerProvider(dto: RegisterProviderDto): Promise<ProviderResponse> {
    try {
      const adminSecret = this.getAdminSecret();
      const adminAddress = this.stellarService.getKeypairFromSecret(adminSecret).publicKey();
      const nonce = await this.nonceService.next(ORACLE_CONSUMER(), adminAddress);

      await this.contractService.invokeContractMethod(
        ORACLE_CONSUMER(), 'register_provider', adminSecret,
        [
          Address.fromString(adminAddress).toScVal(),
          Address.fromString(dto.providerAddress).toScVal(),
          nativeToScVal(dto.methodology, { type: 'symbol' }),
        ],
        nonce,
      );

      return {
        providerAddress: dto.providerAddress,
        methodology: dto.methodology,
        name: `Oracle ${dto.providerAddress.slice(0, 6)}`,
        active: true,
        stake: 0,
        registeredAt: new Date().toISOString(),
      };
    } catch (error) {
      throw this.mapProviderError(error);
    }
  }

  async listProviders(): Promise<ProviderResponse[]> {
    const cacheKey = 'oracle:providers';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const listScVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'list_providers',
      args: [],
    });
    const addresses = scValToNative(listScVal) as string[];

    const providers: ProviderResponse[] = [];
    for (const address of addresses) {
      try {
        const providerScVal = await this.contractService.simulateCall({
          contractAddress: ORACLE_CONSUMER(),
          method: 'get_provider',
          args: [Address.fromString(address).toScVal()],
        });
        providers.push(this.buildProviderResponse(scValToNative(providerScVal)));
      } catch {}
    }

    await this.redis.setEx(cacheKey, 120, JSON.stringify(providers));
    return providers;
  }

  mergeProviderHealth(
    providers: ProviderResponse[],
    staleness?: OracleStalenessReport,
  ): ProviderResponse[] {
    if (!staleness) return providers;

    const healthByProvider = new Map<string, ProviderStalenessMetric>();
    for (const metric of staleness.providers ?? []) {
      healthByProvider.set(metric.providerAddress, metric);
    }

    return providers.map((provider) => ({
      ...provider,
      health: this.toProviderHealth(healthByProvider.get(provider.providerAddress)),
    }));
  }

  async getProviderStats(providerAddress: string): Promise<ProviderStatsWithHistory> {
    const statsScVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'get_provider_stats',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    const stats = this.toRecord(scValToNative(statsScVal) as any);

    const slashScVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'get_slash_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    const challengeScVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'get_challenge_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });

    const slashHistory = this.toArray(scValToNative(slashScVal)).map((record) =>
      this.decodeSlashRecord(this.toRecord(record)),
    );
    const challengeHistory = this.toArray(scValToNative(challengeScVal)).map((record) =>
      this.decodeChallengeRecord(this.toRecord(record)),
    );

    return {
      providerAddress,
      reportsSubmitted: Number(this.field(stats, 'reports_submitted', 0)),
      challengesFaced: Number(this.field(stats, 'challenges_faced', 1)),
      slashes: Number(this.field(stats, 'slashes', 2)),
      totalPenalty: Number(this.field(stats, 'total_penalty', 3)),
      stake: Number(this.field(stats, 'stake', 4)),
      active: Boolean(this.field(stats, 'active', 5)),
      slashHistory,
      challengeHistory,
    };
  }

  async getSlashHistory(providerAddress: string): Promise<SlashRecord[]> {
    const scVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'get_slash_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    return this.toArray(scValToNative(scVal)).map((record) =>
      this.decodeSlashRecord(this.toRecord(record)),
    );
  }

  async getChallengeHistory(providerAddress: string): Promise<ChallengeRecord[]> {
    const scVal = await this.contractService.simulateCall({
      contractAddress: ORACLE_CONSUMER(),
      method: 'get_challenge_history',
      args: [Address.fromString(providerAddress).toScVal()],
    });
    return this.toArray(scValToNative(scVal)).map((record) =>
      this.decodeChallengeRecord(this.toRecord(record)),
    );
  }

  private decodeSlashRecord(record: Record<string, any>): SlashRecord {
    return {
      reportId: Number(this.field(record, 'report_id', 0)),
      penalty: Number(this.field(record, 'penalty', 1)),
      remainingStake: Number(this.field(record, 'remaining_stake', 2)),
      timestamp: new Date(Number(this.field(record, 'timestamp', 3)) * 1000).toISOString(),
      activeAfter: Boolean(this.field(record, 'active_after', 4)),
    };
  }

  private decodeChallengeRecord(record: Record<string, any>): ChallengeRecord {
    const resolution = Number(this.field(record, 'resolution', 5));
    return {
      reportId: Number(this.field(record, 'report_id', 0)),
      challengerAddress: String(this.field(record, 'challenger', 1)),
      counterEvidenceHash: Buffer.from(
        this.field(record, 'counter_evidence_hash', 2) as Uint8Array,
      ).toString('hex'),
      submittedAt: new Date(Number(this.field(record, 'submitted_at', 3)) * 1000).toISOString(),
      resolved: Boolean(this.field(record, 'resolved', 4)),
      resolution: resolution > 0 ? this.reportStatusFromIndex(resolution) : null,
    };
  }

  private toArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
  }

  private toRecord(value: any): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    return {};
  }

  private field(record: Record<string, any>, key: string, index: number): any {
    if (record == null) return undefined;
    if (key in record) return record[key];
    const array = record as any;
    if (Array.isArray(array)) return array[index];
    return undefined;
  }

  private decodeReport(data: any[]): ReportResponse {
    return {
      id: Number(data[0]),
      providerAddress: data[1] as string,
      projectId: Buffer.from(data[2] as Uint8Array).toString('hex'),
      periodStart: Number(data[3]),
      periodEnd: Number(data[4]),
      carbonSequestered: Number(data[5]),
      methodology: data[6] as string,
      ipfsHash: Buffer.from(data[7] as Uint8Array).toString('hex'),
      status: this.reportStatusFromIndex(Number(data[8])),
      createdAt: new Date(Number(data[9]) * 1000).toISOString(),
      verifiedAt: Number(data[10]) > 0
        ? new Date(Number(data[10]) * 1000).toISOString()
        : undefined,
    };
  }

  private reportStatusFromIndex(index: number): ReportStatus {
    return (
      [
        ReportStatus.Pending,
        ReportStatus.Verified,
        ReportStatus.Challenged,
        ReportStatus.Rejected,
      ][index] ?? ReportStatus.Pending
    );
  }

  private buildProviderResponse(data: any): ProviderResponse {
    const providerAddress = String(this.field(data, 'address', 0));
    return {
      providerAddress,
      methodology: String(this.field(data, 'methodology', 1)),
      name: `Oracle ${providerAddress.slice(0, 6)}`,
      stake: Number(this.field(data, 'stake', 2)),
      active: Boolean(this.field(data, 'active', 3)),
      registeredAt: new Date(Number(this.field(data, 'registered_at', 4)) * 1000).toISOString(),
    };
  }

  private toProviderHealth(metric?: ProviderStalenessMetric): ProviderHealthStatus {
    if (!metric) {
      return { status: 'unknown', projectIds: [] };
    }
    return {
      status: metric.isStale ? 'stale' : 'healthy',
      lastVerifiedAt: metric.lastVerifiedAt,
      expectedNextReportAt: metric.expectedNextReportAt,
      stalenessSeconds: metric.stalenessSeconds,
      projectIds: metric.projectIds,
    };
  }

  private mapProviderError(error: unknown): Error {
    if (error instanceof ConflictException) {
      return error;
    }
    if (error instanceof HttpException) {
      if (this.contractErrorCode(error.message) === ORACLE_ERROR_CODE.ProviderAlreadyExists) {
        return new ConflictException('Oracle provider is already registered');
      }
      return error;
    }
    if (error instanceof Error) {
      return new BadRequestException(error.message);
    }
    return new BadRequestException('Failed to register oracle provider');
  }

  private contractErrorCode(message: string): number | undefined {
    const match = message.match(/error code (\d+)/);
    return match ? Number(match[1]) : undefined;
  }

  private getAdminSecret(): string {
    return process.env.ADMIN_SECRET_KEY || '';
  }
}
