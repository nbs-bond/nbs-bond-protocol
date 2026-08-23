import { ForbiddenException, Injectable, Logger, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
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

/**
 * Maximum age (seconds) of a stale-cache fallback before it is no longer
 * considered trustworthy for KYC-gated operations such as bond subscription.
 * A revoked/expired KYC can otherwise be served for hours or days while the
 * circuit breaker is open.
 */
const DEFAULT_STALE_THRESHOLD_SECONDS = 24 * 60 * 60;

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

/** A resolved KYC status plus its freshness metadata. */
export interface KycStatusResult {
  status: KycStatus;
  /** True when the status was served from the outage fallback (last known). */
  stale: boolean;
  /** ISO timestamp of when the served status was recorded. */
  cachedAt: string;
}

/** Circuit breaker states. */
export type CircuitBreakerState = 'closed' | 'open' | 'halfOpen';

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

/**
 * Failure-counting circuit breaker for the KYC provider with a `halfOpen`
 * state. After `threshold` consecutive failures the breaker opens and refuses
 * calls for `cooldownMs`. Once the cooldown elapses it becomes half-open and
 * lets a single probe request through: a success closes the circuit, a failure
 * reopens it for another full cooldown.
 */
export class KycCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;
  private state: CircuitBreakerState = 'closed';
  private probeInFlight = false;

  constructor(
    private readonly threshold = envPositiveInt('KYC_CIRCUIT_THRESHOLD', 3),
    private readonly cooldownMs = envPositiveInt('KYC_CIRCUIT_COOLDOWN_MS', 30_000),
  ) {}

  /** Current state; an elapsed open window lazily becomes `halfOpen`. */
  get currentState(): CircuitBreakerState {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'halfOpen';
    }
    return this.state;
  }

  get isOpen(): boolean {
    return this.currentState === 'open';
  }

  get isHalfOpen(): boolean {
    return this.currentState === 'halfOpen';
  }

  /** Seconds remaining in the open window; 0 when closed or half-open. */
  get retryAfterSeconds(): number {
    if (this.currentState !== 'open') return 0;
    return Math.max(0, Math.ceil((this.openedAt + this.cooldownMs - Date.now()) / 1000));
  }

  /** Whether a request may be attempted in the current state. */
  canAttempt(): boolean {
    const state = this.currentState;
    if (state === 'closed') return true;
    if (state === 'halfOpen' && !this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.state = 'closed';
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === 'halfOpen') {
      // A failed probe reopens the circuit for a fresh cooldown window.
      this.state = 'open';
      this.openedAt = Date.now();
      return;
    }
    if (this.consecutiveFailures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

@Injectable()
export class KycService implements OnModuleDestroy {
  private readonly logger = new Logger(KycService.name);
  private redis: RedisClientType;
  private readonly provider: KycProviderClient;
  private readonly breaker: KycCircuitBreaker;
  private readonly staleThresholdSeconds: number;

  constructor(
    @Optional() provider: KycProviderClient = new HttpKycProviderClient(),
    @Optional() breaker: KycCircuitBreaker = new KycCircuitBreaker(),
    @Optional() staleThresholdSeconds?: number,
  ) {
    this.provider = provider;
    this.breaker = breaker;
    this.staleThresholdSeconds =
      staleThresholdSeconds ??
      envPositiveInt('KYC_STALE_THRESHOLD_SECONDS', DEFAULT_STALE_THRESHOLD_SECONDS);
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(() => {});
  }

  private key(address: string): string {
    return `kyc:${address}`;
  }

  private staleKey(address: string): string {
    return `${this.key(address)}:stale`;
  }

  /** Serialized cache value: the status plus when it was recorded. */
  private serializeCached(status: KycStatus, cachedAt: string): string {
    return JSON.stringify({ status, cachedAt });
  }

  /** Parse a cache value; returns null for missing/unrecognized values. */
  private parseCached(raw: string | null): { status: KycStatus; cachedAt: string } | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { status?: string; cachedAt?: string };
      if (
        parsed &&
        typeof parsed.status === 'string' &&
        (Object.values(KycStatus) as string[]).includes(parsed.status)
      ) {
        return {
          status: parsed.status as KycStatus,
          cachedAt: parsed.cachedAt || new Date(0).toISOString(),
        };
      }
    } catch {
      // Fall through: legacy/plain values are treated as unrecognized.
    }
    return null;
  }

  /**
   * Resolve the KYC status for `address`. Serves the Redis cache when fresh;
   * on a cache miss the live provider is consulted and the result cached
   * with a per-state TTL (plus an unbounded "last known" mirror for outage
   * fallback). When the provider is unreachable the circuit breaker trips
   * after `KYC_CIRCUIT_THRESHOLD` consecutive failures; while open/half-open,
   * and on transient failures, the last known status is served (flagged as
   * `stale`) so subscriptions do not fail while the provider recovers. With no
   * cache and no provider, a 503 is raised whose `retryAfterSeconds` reflects
   * the provider's own recovery estimate when its health endpoint exposes one.
   */
  async getStatus(address: string): Promise<KycStatusResult> {
    const cacheKey = this.key(address);
    const cachedRaw = await this.redis.get(cacheKey);
    const cached = this.parseCached(cachedRaw);
    if (cached) {
      return { status: cached.status, stale: false, cachedAt: cached.cachedAt };
    }
    if (cachedRaw) {
      // Unrecognized value (e.g. written by an older version): drop it.
      await this.redis.del(cacheKey);
    }

    if (!this.provider.isConfigured()) {
      // Dev mode without a provider: no live call is possible, behave as
      // before and report the neutral state.
      return { status: KycStatus.PENDING, stale: false, cachedAt: new Date().toISOString() };
    }

    const lastKnown = this.parseCached(await this.redis.get(this.staleKey(address)));
    if (!this.breaker.canAttempt()) {
      this.logger.warn(`KYC provider circuit open; serving last known status for ${address}`);
      if (lastKnown) {
        return { status: lastKnown.status, stale: true, cachedAt: lastKnown.cachedAt };
      }
      throw await this.providerUnavailable('KYC provider is unavailable (circuit open)');
    }

    try {
      const status = await this.provider.checkStatus(address);
      this.breaker.recordSuccess();
      const cachedAt = new Date().toISOString();
      await this.cacheStatus(address, status, cachedAt);
      return { status, stale: false, cachedAt };
    } catch (error) {
      this.breaker.recordFailure();
      this.logger.warn(
        `KYC provider check failed for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (lastKnown) {
        // Stale-while-error fallback: serve the last known status rather
        // than failing the subscription while the provider recovers.
        return { status: lastKnown.status, stale: true, cachedAt: lastKnown.cachedAt };
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

  /**
   * Whether `address` satisfies `requiredStatus`. Stale statuses served from
   * the outage fallback are rejected once they are older than the configurable
   * `KYC_STALE_THRESHOLD_SECONDS` (default 24h) so a revoked/expired KYC can
   * never be relied upon for KYC-gated operations while the provider is down.
   */
  async isEligible(address: string, requiredStatus: KycStatus): Promise<boolean> {
    const result = await this.getStatus(address);
    if (result.stale && this.isStaleBeyondThreshold(result.cachedAt)) {
      throw new ForbiddenException(
        'KYC status is stale; fresh verification is required before subscribing',
      );
    }
    return this.compareStatus(result.status, requiredStatus);
  }

  /**
   * Snapshot of the circuit breaker for health reporting.
   */
  getCircuitBreakerHealth(): {
    state: CircuitBreakerState;
    retryAfterSeconds: number;
    staleThresholdSeconds: number;
  } {
    return {
      state: this.breaker.currentState,
      retryAfterSeconds: this.breaker.retryAfterSeconds,
      staleThresholdSeconds: this.staleThresholdSeconds,
    };
  }

  private isStaleBeyondThreshold(cachedAt: string): boolean {
    const cachedAtMs = Date.parse(cachedAt);
    if (!Number.isFinite(cachedAtMs)) return true;
    return Date.now() - cachedAtMs > this.staleThresholdSeconds * 1000;
  }

  private async cacheStatus(address: string, status: KycStatus, cachedAt?: string): Promise<void> {
    const at = cachedAt ?? new Date().toISOString();
    await this.redis.set(this.key(address), this.serializeCached(status, at), {
      EX: this.ttlFor(status),
    });
    // Unbounded mirror used as the outage fallback; refreshed on every
    // successful provider read.
    await this.redis.set(this.staleKey(address), this.serializeCached(status, at));
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

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis.isReady) {
        await this.redis.quit();
        this.logger.log('KycService: Redis connection closed gracefully');
      } else if (this.redis.isOpen) {
        // The connection never reached the ready state (e.g. Redis was
        // unavailable on startup); quit() would hang waiting for a reply.
        this.redis.disconnect();
      }
    } catch (error) {
      this.logger.warn(
        `KycService: error closing Redis connection: ${error?.message ?? error}`,
      );
    }
  }
}
