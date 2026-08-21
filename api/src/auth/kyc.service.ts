import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createClient, RedisClientType } from '@redis/client';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';

/**
 * KYC status cache with a live provider fallback.
 *
 * Every subscription request used to depend on a synchronous call to the
 * KYC provider. This service caches status per address with per-state TTLs
 * (short for `PENDING`, full for approved states), invalidates the cache
 * immediately on revocation, and shields callers from provider outages with
 * a circuit breaker plus a stale-cache fallback. When the provider is down
 * and no cached status exists, callers get a 503 whose retry estimate comes
 * from the provider health endpoint when available, otherwise from the
 * circuit breaker cooldown.
 */

const DEFAULT_TTL_SECONDS: Record<KycStatus, number> = {
  // Approved states may be cached for the full TTL: the status only changes
  // through explicit admin action, which invalidates the cache.
  [KycStatus.VERIFIED]: 60 * 60,
  [KycStatus.ACCREDITED]: 60 * 60,
  // Pending is cached briefly so a completed review shows up quickly.
  [KycStatus.PENDING]: 60,
  // No record / rejected is cached longer than pending.
  [KycStatus.NONE]: 6 * 60 * 60,
};

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Map a raw provider status string to the protocol's `KycStatus` enum. */
function mapProviderStatus(raw: string): KycStatus {
  switch (raw.toLowerCase()) {
    case 'verified':
    case 'approved':
      return KycStatus.VERIFIED;
    case 'accredited':
      return KycStatus.ACCREDITED;
    case 'pending':
      return KycStatus.PENDING;
    case 'rejected':
    case 'none':
    default:
      return KycStatus.NONE;
  }
}

export interface KycProviderHealth {
  status: string;
  /** Provider-estimated seconds until the service recovers, when exposed. */
  recoverySeconds?: number;
}

/** Thin HTTP client for the external KYC provider. */
export interface KycProviderClient {
  isConfigured(): boolean;
  checkStatus(address: string): Promise<KycStatus>;
  health(): Promise<KycProviderHealth | null>;
}

export class HttpKycProviderClient implements KycProviderClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = (process.env.KYC_PROVIDER_URL || '').replace(/\/$/, '');
    this.apiKey = process.env.KYC_API_KEY || '';
    this.timeoutMs = envPositiveInt('KYC_PROVIDER_TIMEOUT_MS', 5_000);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  async checkStatus(address: string): Promise<KycStatus> {
    const response = await fetch(`${this.baseUrl}/status/${encodeURIComponent(address)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`KYC provider returned status ${response.status}`);
    }
    const data = (await response.json()) as { status?: string; kycStatus?: string };
    return mapProviderStatus(String(data.status ?? data.kycStatus ?? ''));
  }

  async health(): Promise<KycProviderHealth | null> {
    if (!this.isConfigured()) return null;
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        status?: string;
        recovery_seconds?: number;
        recoverySeconds?: number;
      };
      const recoverySeconds =
        Number(data.recovery_seconds ?? data.recoverySeconds) || undefined;
      return {
        status: String(data.status ?? 'ok'),
        recoverySeconds:
          recoverySeconds !== undefined && recoverySeconds > 0
            ? recoverySeconds
            : undefined,
      };
    } catch {
      return null;
    }
  }
}

/** Simple failure-counting circuit breaker for the KYC provider. */
export class KycCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = envPositiveInt('KYC_CIRCUIT_THRESHOLD', 3),
    private readonly cooldownMs = envPositiveInt('KYC_CIRCUIT_COOLDOWN_MS', 30_000),
  ) {}

  get isOpen(): boolean {
    if (this.openedAt === 0) return false;
    return Date.now() - this.openedAt < this.cooldownMs;
  }

  /** Seconds remaining in the open window; 0 when closed. */
  get retryAfterSeconds(): number {
    if (this.openedAt === 0) return 0;
    return Math.max(0, Math.ceil((this.openedAt + this.cooldownMs - Date.now()) / 1000));
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openedAt = Date.now();
    }
  }
}

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private redis: RedisClientType;
  private readonly provider: KycProviderClient;
  private readonly breaker: KycCircuitBreaker;

  constructor(
    @Optional() provider: KycProviderClient = new HttpKycProviderClient(),
    @Optional() breaker: KycCircuitBreaker = new KycCircuitBreaker(),
  ) {
    this.provider = provider;
    this.breaker = breaker;
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  private key(address: string): string {
    return `kyc:${address}`;
  }

  private staleKey(address: string): string {
    return `${this.key(address)}:stale`;
  }

  /**
   * Resolve the KYC status for `address`. Serves the Redis cache when fresh;
   * on a cache miss the live provider is consulted and the result cached
   * with a per-state TTL (plus an unbounded "last known" mirror for outage
   * fallback). When the provider is unreachable the circuit breaker trips
   * after `KYC_CIRCUIT_THRESHOLD` consecutive failures; while open, and on
   * transient failures, the last known status is served so subscriptions do
   * not fail while the provider recovers. With no cache and no provider, a
   * 503 is raised whose `retryAfterSeconds` reflects the provider's own
   * recovery estimate when its health endpoint exposes one.
   */
  async getStatus(address: string): Promise<KycStatus> {
    const cacheKey = this.key(address);
    const cached = await this.redis.get(cacheKey);
    if (cached && (Object.values(KycStatus) as string[]).includes(cached)) {
      return cached as KycStatus;
    }
    if (cached) {
      // Unrecognized value (e.g. written by an older version): drop it.
      await this.redis.del(cacheKey);
    }

    if (!this.provider.isConfigured()) {
      // Dev mode without a provider: no live call is possible, behave as
      // before and report the neutral state.
      return KycStatus.PENDING;
    }

    const lastKnown = await this.redis.get(this.staleKey(address));
    if (this.breaker.isOpen) {
      this.logger.warn(`KYC provider circuit open; serving last known status for ${address}`);
      if (lastKnown) return lastKnown as KycStatus;
      throw await this.providerUnavailable('KYC provider is unavailable (circuit open)');
    }

    try {
      const status = await this.provider.checkStatus(address);
      this.breaker.recordSuccess();
      await this.cacheStatus(address, status);
      return status;
    } catch (error) {
      this.breaker.recordFailure();
      this.logger.warn(
        `KYC provider check failed for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (lastKnown) {
        // Stale-while-error fallback: serve the last known status rather
        // than failing the subscription while the provider recovers.
        return lastKnown as KycStatus;
      }
      throw await this.providerUnavailable(
        'KYC provider is unavailable; please retry shortly',
      );
    }
  }

  /** Cache `status` with the TTL appropriate for its state. */
  async updateStatus(address: string, status: KycStatus): Promise<void> {
    await this.cacheStatus(address, status);
  }

  /**
   * Immediately invalidate the cached status (e.g. on KYC revocation).
   * Also clears the outage fallback so a revoked investor cannot keep
   * passing through the stale mirror.
   */
  async revoke(address: string): Promise<void> {
    await this.redis.del(this.key(address));
    await this.redis.del(this.staleKey(address));
  }

  async isEligible(address: string, requiredStatus: KycStatus): Promise<boolean> {
    const actual = await this.getStatus(address);
    return this.compareStatus(actual, requiredStatus);
  }

  private async cacheStatus(address: string, status: KycStatus): Promise<void> {
    await this.redis.set(this.key(address), status, { EX: this.ttlFor(status) });
    // Unbounded mirror used as the outage fallback; refreshed on every
    // successful provider read.
    await this.redis.set(this.staleKey(address), status);
  }

  private ttlFor(status: KycStatus): number {
    switch (status) {
      case KycStatus.VERIFIED:
      case KycStatus.ACCREDITED:
        return envPositiveInt('KYC_CACHE_TTL_APPROVED_SECONDS', DEFAULT_TTL_SECONDS[status]);
      case KycStatus.PENDING:
        return envPositiveInt('KYC_CACHE_TTL_PENDING_SECONDS', DEFAULT_TTL_SECONDS[status]);
      case KycStatus.NONE:
        return envPositiveInt('KYC_CACHE_TTL_REJECTED_SECONDS', DEFAULT_TTL_SECONDS[status]);
    }
  }

  private async providerUnavailable(reason: string): Promise<ServiceUnavailableException> {
    const health = await this.provider.health();
    const retryAfterSeconds =
      health?.recoverySeconds && health.recoverySeconds > 0
        ? health.recoverySeconds
        : this.breaker.retryAfterSeconds || 30;
    return new ServiceUnavailableException({
      message: reason,
      retryAfterSeconds,
    });
  }

  private compareStatus(actual: KycStatus, required: KycStatus): boolean {
    const order = [KycStatus.NONE, KycStatus.PENDING, KycStatus.VERIFIED, KycStatus.ACCREDITED];
    return order.indexOf(actual) >= order.indexOf(required);
  }
}
