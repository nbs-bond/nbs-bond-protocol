import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { NonceService } from './nonce.service';

/**
 * Periodically re-syncs every known (contractAddress, address) nonce pair
 * from on-chain storage into Redis (issue #85).
 *
 * WHY THIS EXISTS:
 * Redis is a mirror of the on-chain nonce counters. If Redis is restarted,
 * evicts keys, or the container is replaced, the nonce keys reset to 0 (or
 * vanish entirely) while the contracts keep their real counters. The next
 * API call would then submit nonce=0 and receive InvalidNonce — a silent
 * operational outage. NonceService.next() already self-heals a *missing*
 * key on the first call after the incident, but a key that still EXISTS
 * with a stale value is never re-read by the request path. This cron makes
 * divergence self-healing: every 5 minutes, every pair that has ever
 * requested a nonce is re-synced from the authoritative on-chain value, so
 * even silently diverged keys are corrected without manual Redis surgery.
 *
 * Known pairs come from NonceService's `nonce:known-pairs` registry, which
 * is populated by every next()/sync() call.
 */
@Injectable()
export class NonceReconcilerService implements OnModuleDestroy {
  private readonly logger = new Logger(NonceReconcilerService.name);

  constructor(
    private readonly nonceService: NonceService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // The explicit `name` is required: @nestjs/schedule v4 registers cron jobs
  // under a random UUID when no name is given, which would make the
  // onModuleDestroy cleanup below a silent no-op.
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'reconcileNonces' })
  async reconcileNonces(): Promise<void> {
    let pairs: Array<{ contractAddress: string; address: string }> = [];
    try {
      pairs = await this.nonceService.listKnownPairs();
    } catch (error) {
      this.logger.error(
        `Nonce reconciliation: could not load known pairs: ${error?.message ?? error}`,
      );
      return;
    }

    if (pairs.length === 0) {
      this.logger.log('Nonce reconciliation: no known pairs to sync');
      return;
    }

    // Re-sync every pair concurrently, isolating failures with allSettled:
    // one unreachable contract or failing RPC call must never abort the rest
    // of the cycle — failed pairs simply retry on the next 5-minute run.
    const results = await Promise.allSettled(
      pairs.map((pair) =>
        this.nonceService.sync(pair.contractAddress, pair.address),
      ),
    );

    const failed = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    ).length;

    if (failed > 0) {
      this.logger.warn(
        `Nonce reconciliation: ${failed}/${pairs.length} pair(s) failed to ` +
          `sync from the chain; they will retry on the next cycle`,
      );
    } else {
      this.logger.log(
        `Nonce reconciliation: synced ${pairs.length} pair(s) from on-chain state`,
      );
    }
  }

  /**
   * Unregister the cron job on shutdown so it cannot fire mid-teardown.
   * Called automatically by NestJS when app.enableShutdownHooks() is active
   * and the process receives SIGTERM/SIGINT.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      this.schedulerRegistry.deleteCronJob('reconcileNonces');
      this.logger.log(
        `NonceReconcilerService: cron job 'reconcileNonces' unregistered`,
      );
    } catch {
      // Job may not be registered in test environments — ignore.
    }
  }
}
