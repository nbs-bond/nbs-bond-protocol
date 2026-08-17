import { createAxiosHttpClient, HttpClient } from './http';

export type AdapterStatus = 'up' | 'degraded' | 'down';

export interface AdapterHealth {
  adapter: string;
  status: AdapterStatus;
  latencyMs: number;
  checkedAt: string;
  /** Upstream endpoint that was probed. */
  url?: string;
  error?: string;
}

export interface HealthCheckConfig {
  adapter: string;
  url: string;
}

export interface HealthCheckOptions {
  http?: HttpClient;
  timeoutMs?: number;
  /** Latency above this (ms) downgrades an otherwise 2xx probe to `degraded`. */
  latencyThresholdMs?: number;
  /** Override the probe path appended to the adapter base URL. */
  healthPath?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LATENCY_THRESHOLD_MS = 5_000;
const DEFAULT_HEALTH_PATH = '/health';

/**
 * Adapter endpoints derived from the same env vars the adapters themselves
 * read, so the health probe tracks the real upstream targets.
 */
export function defaultHealthChecks(): HealthCheckConfig[] {
  return [
    {
      adapter: 'verra',
      url: process.env.VERRA_REGISTRY_URL || 'https://registry.verra.org/api/v1',
    },
    {
      adapter: 'satellite',
      url: process.env.SATELLITE_API_URL || 'https://api.satellite-processor.io/v1',
    },
    {
      adapter: 'iot',
      url: process.env.IOT_API_URL || 'https://api.iot-sensor-network.io/v1',
    },
  ];
}

/**
 * Probe a single adapter's health endpoint.
 *
 * - 2xx within the latency budget  -> `up`
 * - 2xx slower than the budget     -> `degraded` (slow upstream)
 * - 4xx (reachable, erroring)      -> `degraded`
 * - 5xx / network / timeout        -> `down`
 */
export async function checkAdapterHealth(
  config: HealthCheckConfig,
  options: HealthCheckOptions = {},
): Promise<AdapterHealth> {
  const http = options.http ?? createAxiosHttpClient(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const path = options.healthPath ?? DEFAULT_HEALTH_PATH;
  const probeUrl = `${config.url.replace(/\/$/, '')}${path}`;
  const threshold = options.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS;
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const response = await http.get<unknown>(probeUrl, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - startedAt;

    if (response.status >= 500) {
      return {
        adapter: config.adapter,
        status: 'down',
        latencyMs,
        checkedAt,
        url: config.url,
        error: `upstream returned status ${response.status}`,
      };
    }
    if (response.status >= 400) {
      return {
        adapter: config.adapter,
        status: 'degraded',
        latencyMs,
        checkedAt,
        url: config.url,
        error: `upstream returned status ${response.status}`,
      };
    }
    if (latencyMs > threshold) {
      return {
        adapter: config.adapter,
        status: 'degraded',
        latencyMs,
        checkedAt,
        url: config.url,
        error: `probe latency ${latencyMs}ms exceeds threshold ${threshold}ms`,
      };
    }
    return {
      adapter: config.adapter,
      status: 'up',
      latencyMs,
      checkedAt,
      url: config.url,
    };
  } catch (error) {
    return {
      adapter: config.adapter,
      status: 'down',
      latencyMs: Date.now() - startedAt,
      checkedAt,
      url: config.url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Run a health probe against every configured adapter concurrently. */
export async function runHealthChecks(
  adapters: HealthCheckConfig[] = defaultHealthChecks(),
  options: HealthCheckOptions = {},
): Promise<AdapterHealth[]> {
  return Promise.all(adapters.map((config) => checkAdapterHealth(config, options)));
}

// ────────────────────────────────────────────────────────────────────
// Provider degradation alerting
//
// `runHealthChecks` only reports status; nothing reacts when a provider
// turns `degraded` or `down`. `ProviderAlertTracker` observes each health
// result and, when a provider degrades, emits a structured log event and
// POSTs a documented webhook payload (PagerDuty / Slack / OpsGenie) at most
// once per cooldown window per provider. Webhook delivery is fire-and-forget
// with a short timeout so a slow webhook endpoint never blocks the monitor.
// ────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'warning' | 'critical';

/** Additional provider context attached to an alert (best-effort enrichment). */
export interface ProviderAlertContext {
  /** On-chain Stellar address of the provider, when known. */
  address?: string;
  /** Reporting methodology the provider is responsible for. */
  methodology?: string;
  /** Override the tracked count of consecutive degraded health checks. */
  consecutiveMissedWindows?: number;
  /** ISO timestamp of the last verified report / healthy observation. */
  lastSeenAt?: string;
}

/**
 * Webhook payload posted to `ORACLE_ALERT_WEBHOOK` when a provider degrades.
 * The shape is stable and documented in docs/runbook-degraded-providers.md
 * so operators can wire it into their alerting tools without changes.
 */
export interface AlertPayload {
  alert: {
    id: string;
    type: 'provider_degraded';
    severity: AlertSeverity;
    generatedAt: string;
  };
  provider: {
    name: string;
    address?: string;
    methodology?: string;
  };
  status: AdapterStatus;
  previousStatus?: AdapterStatus;
  consecutiveMissedWindows: number;
  lastSeenAt?: string;
  checkedAt: string;
  latencyMs: number;
  url?: string;
  error?: string;
  message: string;
}

export interface AlertLogger {
  warn?(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
}

export interface AlertNotificationOptions {
  /** Webhook URL for degradation alerts; falls back to `ORACLE_ALERT_WEBHOOK`. */
  webhookUrl?: string;
  /** Fire-and-forget webhook POST timeout in ms; default 2000. */
  webhookTimeoutMs?: number;
  /** Minimum interval between alerts per provider in ms; default 1 hour. */
  cooldownMs?: number;
  /** Injectable HTTP surface used for webhook delivery. */
  http?: HttpClient;
  /** Structured logger; defaults to console. */
  logger?: AlertLogger;
  /** Clock for cooldown decisions; defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_ALERT_COOLDOWN_MS = 60 * 60 * 1_000;
const DEFAULT_ALERT_TIMEOUT_MS = 2_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const defaultLogger: AlertLogger = {
  warn(message, context) {
    console.warn(context ? `${message} ${JSON.stringify(context)}` : message);
  },
  info(message, context) {
    console.info(context ? `${message} ${JSON.stringify(context)}` : message);
  },
};

export function alertSeverityForStatus(status: AdapterStatus): AlertSeverity {
  return status === 'down' ? 'critical' : 'warning';
}

/** Human-readable alert message; also used as the structured log line. */
export function formatAlertMessage(payload: AlertPayload): string {
  const provider = payload.provider.address
    ? `${payload.provider.name} (${payload.provider.address})`
    : payload.provider.name;
  const windows =
    payload.consecutiveMissedWindows === 1 ? 'window' : 'windows';
  const lastSeen = payload.lastSeenAt ? `, last seen ${payload.lastSeenAt}` : '';
  const detail = payload.error ? `: ${payload.error}` : '';
  return `oracle provider ${provider} is ${payload.status} after ${payload.consecutiveMissedWindows} consecutive missed ${windows}${lastSeen}${detail}`;
}

export interface BuildAlertPayloadInput {
  health: AdapterHealth;
  context: ProviderAlertContext;
  previousStatus?: AdapterStatus;
  consecutive: number;
  lastSeenAt?: string;
  id: string;
  generatedAt: string;
}

export function buildAlertPayload(input: BuildAlertPayloadInput): AlertPayload {
  const { health, context, previousStatus, consecutive, lastSeenAt, id, generatedAt } = input;
  const payload: AlertPayload = {
    alert: {
      id,
      type: 'provider_degraded',
      severity: alertSeverityForStatus(health.status),
      generatedAt,
    },
    provider: {
      name: health.adapter,
      address: context.address,
      methodology: context.methodology,
    },
    status: health.status,
    previousStatus,
    consecutiveMissedWindows: context.consecutiveMissedWindows ?? consecutive,
    lastSeenAt,
    checkedAt: health.checkedAt,
    latencyMs: health.latencyMs,
    url: health.url,
    error: health.error,
    message: '',
  };
  payload.message = formatAlertMessage(payload);
  return payload;
}

/**
 * Stateful observer of adapter health results that fires degradation
 * alerts. Track one instance per monitor process so cooldown state
 * survives across health-check runs.
 */
export class ProviderAlertTracker {
  private readonly webhookUrl?: string;
  private readonly webhookTimeoutMs: number;
  private readonly cooldownMs: number;
  private readonly http?: HttpClient;
  private readonly logger: AlertLogger;
  private readonly now: () => number;
  private readonly previousStatuses = new Map<string, AdapterStatus>();
  private readonly consecutiveMissed = new Map<string, number>();
  private readonly lastSeenHealthyAt = new Map<string, string>();
  private readonly lastAlertedAt = new Map<string, number>();
  private sequence = 0;

  constructor(options: AlertNotificationOptions = {}) {
    this.webhookUrl = options.webhookUrl ?? process.env.ORACLE_ALERT_WEBHOOK;
    this.webhookTimeoutMs =
      options.webhookTimeoutMs ??
      envPositiveInt('ORACLE_ALERT_TIMEOUT_MS', DEFAULT_ALERT_TIMEOUT_MS);
    this.cooldownMs =
      options.cooldownMs ?? envPositiveInt('ORACLE_ALERT_COOLDOWN_MS', DEFAULT_ALERT_COOLDOWN_MS);
    this.http = options.http;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  get configuredWebhookUrl(): string | undefined {
    return this.webhookUrl;
  }

  /**
   * Observe one health check result. Returns the alert payload when an
   * alert was fired for this provider, or null when the provider is
   * healthy or still within its cooldown window.
   *
   * Alerts fire only on `degraded`/`down` results. A recovery to `up`
   * resets the consecutive-missed counter but does NOT clear the cooldown,
   * so a provider oscillating healthy/degraded within one window alerts at
   * most once per cooldown.
   */
  evaluate(
    health: AdapterHealth,
    context: ProviderAlertContext = {},
  ): AlertPayload | null {
    const { adapter, status, checkedAt } = health;
    const nowMs = this.now();
    const previousStatus = this.previousStatuses.get(adapter);

    if (status === 'up') {
      this.previousStatuses.set(adapter, 'up');
      this.consecutiveMissed.set(adapter, 0);
      this.lastSeenHealthyAt.set(adapter, checkedAt);
      return null;
    }

    const missed = (this.consecutiveMissed.get(adapter) ?? 0) + 1;
    this.consecutiveMissed.set(adapter, missed);
    this.previousStatuses.set(adapter, status);

    const lastAlerted = this.lastAlertedAt.get(adapter);
    if (lastAlerted !== undefined && nowMs - lastAlerted < this.cooldownMs) {
      return null;
    }

    this.lastAlertedAt.set(adapter, nowMs);
    this.sequence += 1;

    const payload = buildAlertPayload({
      health,
      context,
      previousStatus,
      consecutive: missed,
      lastSeenAt: context.lastSeenAt ?? this.lastSeenHealthyAt.get(adapter),
      id: `provider-degraded-${this.sequence}-${nowMs}`,
      generatedAt: new Date(nowMs).toISOString(),
    });

    this.notify(payload);
    return payload;
  }

  private notify(payload: AlertPayload): void {
    this.logger.warn?.(payload.message, {
      alertId: payload.alert.id,
      provider: payload.provider.name,
      providerAddress: payload.provider.address,
      methodology: payload.provider.methodology,
      status: payload.status,
      previousStatus: payload.previousStatus,
      consecutiveMissedWindows: payload.consecutiveMissedWindows,
      lastSeenAt: payload.lastSeenAt,
      checkedAt: payload.checkedAt,
      latencyMs: payload.latencyMs,
      url: payload.url,
      webhookUrl: this.webhookUrl,
    });

    if (!this.webhookUrl) return;
    // Fire-and-forget: never block evaluation on webhook delivery.
    void this.deliverWebhook(payload);
  }

  private async deliverWebhook(payload: AlertPayload): Promise<void> {
    const url = this.webhookUrl;
    if (!url) return;
    const http = this.http ?? createAxiosHttpClient(this.webhookTimeoutMs);
    try {
      await http.post<unknown>(url, payload, {
        timeoutMs: this.webhookTimeoutMs,
      });
      this.logger.info?.('oracle degradation webhook delivered', {
        alertId: payload.alert.id,
        provider: payload.provider.name,
        webhookUrl: url,
      });
    } catch (error) {
      this.logger.warn?.('oracle degradation webhook delivery failed', {
        alertId: payload.alert.id,
        provider: payload.provider.name,
        webhookUrl: url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
