import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { createClient, RedisClientType } from '@redis/client';
import { OnModuleDestroy } from '@nestjs/common';
import { OracleService } from './oracle.service';
import { OracleMonitoringService } from './oracle.monitoring.service';
import { ProjectsService } from '../projects/projects.service';
import { VerraProvider } from './providers/verra.provider';
import { SatelliteProvider } from './providers/satellite.provider';
import { BlueCarbonProvider } from './providers/blue-carbon.provider';
import { OracleProviderAdapter, MeasurementData } from './providers/provider.interface';

type FailureKind = 'transient' | 'permanent';

interface DeadLetterEntry {
  provider: string;
  projectId?: string;
  kind: FailureKind;
  error: string;
  failedAt: string;
}

const DEAD_LETTER_KEY = 'oracle:dead-letter';
const DEFAULT_DEAD_LETTER_MAX_ENTRIES = 1_000;
const DEFAULT_DEAD_LETTER_TTL_SECONDS = 7 * 24 * 60 * 60;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Distinguish transient (retry next cycle) from permanent (review) failures. */
export function classifyProviderFailure(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/schema|validation|error code \d|status 4\d\d/i.test(message)) {
    return 'permanent';
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|ENETUNREACH|socket hang up|status 5\d\d/i.test(message)) {
    return 'transient';
  }
  return 'transient';
}

@Injectable()
export class OracleScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(OracleScheduler.name);
  private redis: RedisClientType;

  /** Set to true on shutdown; pollOracleData checks this before starting work. */
  private shuttingDown = false;

  /** In-flight poll cycle promises — waited on during shutdown. */
  private readonly activePollCycles = new Set<Promise<void>>();

  constructor(
    private readonly oracleService: OracleService,
    private readonly monitoringService: OracleMonitoringService,
    private readonly projectsService: ProjectsService,
    private readonly verraProvider: VerraProvider,
    private readonly satelliteProvider: SatelliteProvider,
    private readonly blueCarbonProvider: BlueCarbonProvider,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollOracleData(): Promise<void> {
    // Do not start a new cycle if shutdown has been requested.
    if (this.shuttingDown) {
      this.logger.log('Oracle poll cycle skipped — shutdown in progress');
      return;
    }

    const cycle = this._runPollCycle();
    this.activePollCycles.add(cycle);
    cycle.finally(() => this.activePollCycles.delete(cycle));
    await cycle;
  }

  /** Extracted so onModuleDestroy() can also wait for the inner work. */
  private async _runPollCycle(): Promise<void> {
    this.logger.log('Oracle poll cycle started');

    const projects = await this.loadProjects();
    const providers = [
      this.verraProvider,
      this.satelliteProvider,
      this.blueCarbonProvider,
    ];

    const tasks: Array<Promise<void>> = [];
    for (const provider of providers) {
      for (const project of projects) {
        tasks.push(this.pollProvider(provider, project));
      }
    }

    // Run every provider/project pair concurrently and isolate failures with
    // allSettled: one failing adapter can never abort the rest of the cycle.
    const results = await Promise.allSettled(tasks);

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const transient = failures.filter((result) =>
      classifyProviderFailure(result.reason) === 'transient',
    ).length;
    const permanent = failures.length - transient;

    if (failures.length > 0) {
      this.logger.warn(
        `Oracle poll cycle completed with ${failures.length} failed run(s) ` +
          `(${transient} transient, ${permanent} permanent); ` +
          `failures were isolated and recorded to ${DEAD_LETTER_KEY}.`,
      );
    } else {
      this.logger.log(
        `Oracle poll cycle completed: ${results.length} run(s), all succeeded`,
      );
    }
  }

  @Cron('0 */6 * * *')
  async monitorProviderReliability(): Promise<void> {
    this.logger.log('Oracle reliability monitoring cycle started');

    try {
      const alerted = await this.monitoringService.alertStaleProjects();
      this.logger.log(
        `Oracle reliability monitoring cycle completed: ${alerted} alert(s) emitted`,
      );
    } catch (error) {
      this.logger.error(`Oracle reliability monitoring error: ${error.message}`);
    }
  }

  private async loadProjects(): Promise<Array<{ id: string }>> {
    try {
      const result = await this.projectsService.findAll(1, 1000);
      return (result.data ?? []).map((project: { id: number }) => ({
        id: String(project.id),
      }));
    } catch (error) {
      this.logger.warn(
        `Oracle poll cycle could not load projects: ${error.message}; skipping this cycle`,
      );
      return [];
    }
  }

  private async pollProvider(
    provider: OracleProviderAdapter,
    project: { id: string },
  ): Promise<void> {
    try {
      const measurement = await provider.fetchMeasurement(project.id);
      await this.submitMeasurement(provider, project.id, measurement);
      this.logger.log(
        `Oracle poll: ${provider.name} submitted a report for project ${project.id}`,
      );
    } catch (error) {
      const kind = classifyProviderFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      await this.recordDeadLetter({
        provider: provider.name,
        projectId: project.id,
        kind,
        error: message,
        failedAt: new Date().toISOString(),
      });
      // Transient failures retry on the next scheduled cycle; permanent ones
      // need human review — both are logged differently.
      if (kind === 'transient') {
        this.logger.warn(
          `Oracle poll: ${provider.name} failed transiently for project ${project.id}: ${message}`,
        );
      } else {
        this.logger.error(
          `Oracle poll: ${provider.name} failed permanently for project ${project.id}: ${message}`,
        );
      }
      throw error;
    }
  }

  private async submitMeasurement(
    provider: OracleProviderAdapter,
    projectId: string,
    measurement: MeasurementData,
  ): Promise<void> {
    await this.oracleService.submitReport(
      {
        projectId,
        periodStart: Math.floor(measurement.periodStart.getTime() / 1000),
        periodEnd: Math.floor(measurement.periodEnd.getTime() / 1000),
        carbonSequestered: measurement.carbonSequesteredKg,
        methodology: provider.methodology,
        evidenceHash: measurement.evidenceHashes?.[0],
      },
      process.env.DEFAULT_PROVIDER_ADDRESS || '',
    );
  }

  /**
   * Append a failed run to the dead-letter list, bounded by a max length
   * (oldest entries trimmed) and a key TTL, so a degraded environment can
   * never grow the store unboundedly.
   */
  private async recordDeadLetter(entry: DeadLetterEntry): Promise<void> {
    const maxEntries = envPositiveInt(
      'ORACLE_DEAD_LETTER_MAX_ENTRIES',
      DEFAULT_DEAD_LETTER_MAX_ENTRIES,
    );
    const ttlSeconds = envPositiveInt(
      'ORACLE_DEAD_LETTER_TTL_SECONDS',
      DEFAULT_DEAD_LETTER_TTL_SECONDS,
    );
    try {
      await this.redis.lPush(DEAD_LETTER_KEY, JSON.stringify(entry));
      await this.redis.lTrim(DEAD_LETTER_KEY, 0, maxEntries - 1);
      await this.redis.expire(DEAD_LETTER_KEY, ttlSeconds);
    } catch (error) {
      this.logger.warn(
        `Oracle poll: could not record dead-letter entry: ${error.message}`,
      );
    }
  }

  /**
   * Gracefully shut down the OracleScheduler.
   *
   * Steps:
   * 1. Set the shutdown flag so no new poll cycle starts from the @Cron trigger.
   * 2. Unregister the cron jobs from NestJS's SchedulerRegistry so they cannot
   *    fire again after this point (belt-and-suspenders alongside the flag).
   * 3. Wait for any in-flight poll cycle to finish so we do not kill a cycle
   *    mid-flight and leave partial dead-letter entries.
   * 4. Quit the Redis connection cleanly.
   *
   * Called automatically by NestJS when app.enableShutdownHooks() is active
   * and the process receives SIGTERM/SIGINT.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;

    // Stop the scheduled cron jobs so they cannot fire while we are waiting
    // for in-flight cycles to complete.
    for (const jobName of ['pollOracleData', 'monitorProviderReliability']) {
      try {
        this.schedulerRegistry.deleteCronJob(jobName);
        this.logger.log(`OracleScheduler: cron job '${jobName}' unregistered`);
      } catch {
        // Job may not be registered in test environments — ignore.
      }
    }

    // Wait for any currently-running poll cycle to finish.
    if (this.activePollCycles.size > 0) {
      this.logger.log(
        `OracleScheduler: waiting for ${this.activePollCycles.size} in-flight poll cycle(s) to complete`,
      );
      await Promise.allSettled([...this.activePollCycles]);
      this.logger.log('OracleScheduler: all in-flight poll cycles finished');
    }

    // Close the Redis connection gracefully.
    try {
      if (this.redis.isReady) {
        await this.redis.quit();
        this.logger.log('OracleScheduler: Redis connection closed gracefully');
      } else if (this.redis.isOpen) {
        // The connection never reached the ready state (e.g. Redis was
        // unavailable on startup); quit() would hang waiting for a reply.
        this.redis.disconnect();
      }
    } catch (error) {
      this.logger.warn(
        `OracleScheduler: error closing Redis connection: ${error?.message ?? error}`,
      );
    }
  }
}
