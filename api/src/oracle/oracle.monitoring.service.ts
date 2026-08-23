import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from '@redis/client';
import { ProjectsService } from '../projects/projects.service';
import { OracleService } from './oracle.service';
import {
  ReportStatus,
  StalenessMetric,
  ProviderStalenessMetric,
  OracleStalenessReport,
} from './interfaces/oracle.interface';

const DEFAULT_CADENCE_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_GRACE_SECONDS = 30 * 24 * 60 * 60;
const CADENCE_OVERRIDES: Array<{ pattern: RegExp; seconds: number }> = [
  { pattern: /REMOTE.?SENSING|SATELLITE/i, seconds: 90 * 24 * 60 * 60 },
  { pattern: /IOT|SENSOR/i, seconds: 30 * 24 * 60 * 60 },
];
const ALERT_REARM_SECONDS = 24 * 60 * 60;

function cadenceForMethodology(methodology: string): number {
  for (const override of CADENCE_OVERRIDES) {
    if (override.pattern.test(methodology)) return override.seconds;
  }
  const configured = Number(process.env.ORACLE_CADENCE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CADENCE_SECONDS;
}

function graceSeconds(): number {
  const configured = Number(process.env.ORACLE_GRACE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GRACE_SECONDS;
}

@Injectable()
export class OracleMonitoringService implements OnModuleDestroy {
  private readonly logger = new Logger(OracleMonitoringService.name);
  private redis: RedisClientType;

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly oracleService: OracleService,
  ) {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  async computeStaleness(now: number = Date.now()): Promise<OracleStalenessReport> {
    const projects = await this.projectsService.findAll(1, 1000);

    const projectMetrics: StalenessMetric[] = [];
    const reportsByProvider = new Map<string, Array<{ projectId: string; verifiedAt: number }>>();

    for (const project of projects.data) {
      const projectId = String(project.id);
      const cadence = cadenceForMethodology(project.methodology);
      const grace = graceSeconds();

      let lastVerifiedAt: number | undefined;
      let providerAddress: string | undefined;
      try {
        const reports = await this.oracleService.getProjectReports(projectId);
        const latest = reports
          .filter((report) => report.status === ReportStatus.Verified)
          .sort(
            (a, b) =>
              this.reportTime(b) - this.reportTime(a),
          )[0];

        if (latest) {
          lastVerifiedAt = this.reportTime(latest);
          providerAddress = latest.providerAddress;
          if (providerAddress) {
            const entry = reportsByProvider.get(providerAddress) ?? [];
            entry.push({ projectId, verifiedAt: lastVerifiedAt });
            reportsByProvider.set(providerAddress, entry);
          }
        }
      } catch {}

      const baseline = lastVerifiedAt ?? new Date(project.createdAt).getTime();
      projectMetrics.push(
        this.buildProjectMetric(projectId, providerAddress, baseline, cadence, grace, now),
      );
    }

    const providerMetrics = this.aggregateProviderStaleness(reportsByProvider, now);

    return {
      asOf: new Date(now).toISOString(),
      projects: projectMetrics,
      providers: providerMetrics,
    };
  }

  async alertStaleProjects(now: number = Date.now()): Promise<number> {
    const report = await this.computeStaleness(now);
    const stale = report.projects.filter((metric) => metric.isStale);

    let alerted = 0;
    for (const metric of stale) {
      const rearmKey = `oracle:alerts:${metric.projectId}`;
      const lastAlert = await this.redis.get(rearmKey);
      if (lastAlert && now - Number(lastAlert) < ALERT_REARM_SECONDS * 1000) {
        continue;
      }

      this.logger.warn(
        `Oracle alert: project ${metric.projectId} is stale. ` +
          `Last verified: ${metric.lastVerifiedAt ?? 'never'}, ` +
          `expected next report by ${metric.expectedNextReportAt}, ` +
          `staleness: ${this.formatDuration(metric.stalenessSeconds ?? 0)}`,
      );
      await this.redis.set(rearmKey, String(now));
      alerted += 1;
    }

    if (alerted > 0) {
      this.logger.warn(`Oracle monitoring: ${alerted} stale project(s) alerted this cycle`);
    }
    return alerted;
  }

  private buildProjectMetric(
    projectId: string,
    providerAddress: string | undefined,
    baselineMs: number,
    cadenceSeconds: number,
    grace: number,
    now: number,
  ): StalenessMetric {
    const expectedNext = baselineMs + (cadenceSeconds + grace) * 1000;
    const staleness = Math.max(0, now - baselineMs);
    return {
      projectId,
      providerAddress,
      lastVerifiedAt: new Date(baselineMs).toISOString(),
      expectedCadenceSeconds: cadenceSeconds,
      graceSeconds: grace,
      expectedNextReportAt: new Date(expectedNext).toISOString(),
      stalenessSeconds: Math.floor(staleness / 1000),
      isStale: now > expectedNext,
    };
  }

  private aggregateProviderStaleness(
    reportsByProvider: Map<string, Array<{ projectId: string; verifiedAt: number }>>,
    now: number,
  ): ProviderStalenessMetric[] {
    const metrics: ProviderStalenessMetric[] = [];
    for (const [providerAddress, reports] of reportsByProvider) {
      const latest = reports.reduce((max, report) =>
        report.verifiedAt > max.verifiedAt ? report : max,
      );
      const cadence = DEFAULT_CADENCE_SECONDS;
      const grace = graceSeconds();
      const expectedNext = latest.verifiedAt + (cadence + grace) * 1000;
      const staleness = Math.max(0, now - latest.verifiedAt);
      metrics.push({
        providerAddress,
        lastVerifiedAt: new Date(latest.verifiedAt).toISOString(),
        expectedNextReportAt: new Date(expectedNext).toISOString(),
        stalenessSeconds: Math.floor(staleness / 1000),
        isStale: now > expectedNext,
        projectIds: reports.map((report) => report.projectId),
      });
    }
    return metrics;
  }

  private reportTime(report: { verifiedAt?: string; createdAt: string }): number {
    return new Date(report.verifiedAt ?? report.createdAt).getTime();
  }

  private formatDuration(seconds: number): string {
    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    return `${days}d ${hours}h`;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis.isReady) {
        await this.redis.quit();
        this.logger.log('OracleMonitoringService: Redis connection closed gracefully');
      } else if (this.redis.isOpen) {
        // The connection never reached the ready state (e.g. Redis was
        // unavailable on startup); quit() would hang waiting for a reply.
        this.redis.disconnect();
      }
    } catch (error) {
      this.logger.warn(
        `OracleMonitoringService: error closing Redis connection: ${error?.message ?? error}`,
      );
    }
  }
}
