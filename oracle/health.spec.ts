import { checkAdapterHealth, runHealthChecks } from './health';
import {
  alertSeverityForStatus,
  buildAlertPayload,
  ProviderAlertTracker,
} from './health';
import type { AdapterHealth, AdapterStatus, AlertLogger } from './health';
import { MockHttpClient } from './test-helpers';

const CONFIG = { adapter: 'verra', url: 'https://registry.verra.org/api/v1' };

function healthResult(
  adapter: string,
  status: AdapterStatus,
  overrides: Partial<AdapterHealth> = {},
): AdapterHealth {
  return {
    adapter,
    status,
    latencyMs: 120,
    checkedAt: '2025-01-01T00:00:00.000Z',
    url: CONFIG.url,
    ...overrides,
  };
}

/** Flush pending microtasks / the fire-and-forget webhook delivery. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const silentLogger: AlertLogger = { warn: () => {}, info: () => {} };

describe('checkAdapterHealth', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports up for a fast 2xx probe', async () => {
    const http = new MockHttpClient([{ status: 200, data: { ok: true } }]);
    const result = await checkAdapterHealth(CONFIG, { http });

    expect(result.adapter).toBe('verra');
    expect(result.status).toBe('up');
    expect(result.url).toBe(CONFIG.url);
    expect(result.error).toBeUndefined();
    expect(http.calls[0].url).toBe('https://registry.verra.org/api/v1/health');
  });

  it('reports degraded when latency exceeds the threshold', async () => {
    const http = new MockHttpClient([{ status: 200, data: { ok: true } }]);
    const started = Date.now();
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(started)
      .mockReturnValueOnce(started + 10_000);

    const result = await checkAdapterHealth(CONFIG, {
      http,
      latencyThresholdMs: 5_000,
    });

    nowSpy.mockRestore();
    expect(result.status).toBe('degraded');
    expect(result.error).toContain('exceeds threshold');
  });

  it('reports degraded for a 4xx upstream', async () => {
    const http = new MockHttpClient([{ status: 404, data: { error: 'not found' } }]);
    const result = await checkAdapterHealth(CONFIG, { http });
    expect(result.status).toBe('degraded');
    expect(result.error).toContain('404');
  });

  it('reports down for a 5xx upstream', async () => {
    const http = new MockHttpClient([{ status: 503, data: { error: 'unavailable' } }]);
    const result = await checkAdapterHealth(CONFIG, { http });
    expect(result.status).toBe('down');
  });

  it('reports down when the probe throws (network error)', async () => {
    const http = new MockHttpClient([new Error('ECONNREFUSED')]);
    const result = await checkAdapterHealth(CONFIG, { http });
    expect(result.status).toBe('down');
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('runHealthChecks', () => {
  it('returns one result per adapter', async () => {
    const http = new MockHttpClient([
      { status: 200, data: {} },
      { status: 200, data: {} },
    ]);
    const results = await runHealthChecks(
      [
        { adapter: 'verra', url: 'https://registry.verra.org/api/v1' },
        { adapter: 'satellite', url: 'https://api.satellite-processor.io/v1' },
      ],
      { http },
    );

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.adapter)).toEqual(['verra', 'satellite']);
    expect(results.every((result) => result.status === 'up')).toBe(true);
  });
});

describe('buildAlertPayload', () => {
  it('maps severity from the adapter status', () => {
    expect(alertSeverityForStatus('degraded')).toBe('warning');
    expect(alertSeverityForStatus('down')).toBe('critical');
  });

  it('builds a stable documented payload', () => {
    const health = healthResult('iot', 'degraded', {
      latencyMs: 6_200,
      checkedAt: '2025-04-01T00:00:00.000Z',
      url: 'https://api.iot-sensor-network.io/v1',
      error: 'probe latency 6200ms exceeds threshold 5000ms',
    });
    const payload = buildAlertPayload({
      health,
      context: { methodology: 'IOT-SENSORS' },
      previousStatus: 'up',
      consecutive: 2,
      id: 'provider-degraded-1-1',
      generatedAt: '2025-04-01T00:00:01.000Z',
    });

    expect(payload.alert).toEqual({
      id: 'provider-degraded-1-1',
      type: 'provider_degraded',
      severity: 'warning',
      generatedAt: '2025-04-01T00:00:01.000Z',
    });
    expect(payload.provider).toEqual({
      name: 'iot',
      methodology: 'IOT-SENSORS',
    });
    expect(payload.status).toBe('degraded');
    expect(payload.previousStatus).toBe('up');
    expect(payload.consecutiveMissedWindows).toBe(2);
    expect(payload.url).toBe('https://api.iot-sensor-network.io/v1');
    expect(payload.error).toContain('exceeds threshold');
    expect(payload.message).toContain('2 consecutive missed windows');
  });
});

describe('ProviderAlertTracker', () => {
  const WEBHOOK = 'https://hooks.example.com/opsgenie';
  const SATELLITE_UP = () => healthResult('satellite', 'up');
  const SATELLITE_DEGRADED = () =>
    healthResult('satellite', 'degraded', {
      error: 'upstream returned status 429',
    });

  it('fires a webhook with the documented payload on the first degraded result', async () => {
    const http = new MockHttpClient([{ status: 200, data: {} }]);
const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      logger: silentLogger,
      now: () => 1_000,
    });

    const payload = tracker.evaluate(SATELLITE_DEGRADED());

    expect(payload).not.toBeNull();
    expect(payload!.alert.type).toBe('provider_degraded');
    expect(payload!.alert.severity).toBe('warning');
    expect(payload!.provider.name).toBe('satellite');
    expect(payload!.status).toBe('degraded');
    expect(payload!.consecutiveMissedWindows).toBe(1);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].method).toBe('post');
    expect(http.calls[0].url).toBe(WEBHOOK);
    expect(http.calls[0].body).toEqual(payload);
  });

  it('suppresses repeated alerts within the cooldown window', () => {
    let now = 0;
    const http = new MockHttpClient([{ status: 200, data: {} }]);
const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      logger: silentLogger,
      cooldownMs: 60_000,
      now: () => now,
    });

    now = 0;
    expect(tracker.evaluate(SATELLITE_DEGRADED())).not.toBeNull();
    now = 30_000;
    expect(tracker.evaluate(SATELLITE_DEGRADED())).toBeNull();
    expect(http.calls).toHaveLength(1);
  });

  it('re-alerts once the cooldown has elapsed', () => {
    let now = 0;
    const http = new MockHttpClient([
      { status: 200, data: {} },
      { status: 200, data: {} },
    ]);
const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      logger: silentLogger,
      cooldownMs: 60_000,
      now: () => now,
    });

    now = 0;
    expect(tracker.evaluate(SATELLITE_DEGRADED())).not.toBeNull();
    now = 61_000;
    expect(tracker.evaluate(SATELLITE_DEGRADED())).not.toBeNull();
    now = 61_001;
    expect(tracker.evaluate(SATELLITE_DEGRADED())).toBeNull();
    expect(http.calls).toHaveLength(2);
  });

  it('does not alert on recovery and resets the consecutive-missed counter', () => {
    let now = 0;
    const http = new MockHttpClient([
      { status: 200, data: {} },
      { status: 200, data: {} },
    ]);
const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      logger: silentLogger,
      cooldownMs: 0,
      now: () => now,
    });

    expect(tracker.evaluate(SATELLITE_DEGRADED())?.consecutiveMissedWindows).toBe(1);
    expect(tracker.evaluate(SATELLITE_UP())).toBeNull();
    now = 1_000;
    expect(
      tracker.evaluate(SATELLITE_DEGRADED())?.consecutiveMissedWindows,
    ).toBe(1);
    expect(http.calls).toHaveLength(2);
  });

  it('marks a down provider as critical', () => {
    const http = new MockHttpClient([{ status: 200, data: {} }]);
    const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      logger: silentLogger,
    });

    const payload = tracker.evaluate(
      healthResult('satellite', 'down', { error: 'ECONNREFUSED' }),
    );

    expect(payload?.alert.severity).toBe('critical');
  });

  it('attaches provider context to the payload and the structured log event', () => {
    const http = new MockHttpClient([{ status: 200, data: {} }]);
    const logContexts: Array<Record<string, unknown>> = [];
    const logger: AlertLogger = {
      warn: (_message, context) => logContexts.push(context ?? {}),
      info: () => {},
    };
const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      now: () => 1_000,
      logger,
    });

    const payload = tracker.evaluate(
      healthResult('satellite', 'degraded', {
        checkedAt: '2025-02-01T00:00:00.000Z',
      }),
      {
        address: 'GABC123',
        methodology: 'REMOTE-SENSING',
        consecutiveMissedWindows: 3,
        lastSeenAt: '2025-01-15T00:00:00.000Z',
      },
    );

    expect(payload?.provider.address).toBe('GABC123');
    expect(payload?.provider.methodology).toBe('REMOTE-SENSING');
    expect(payload?.consecutiveMissedWindows).toBe(3);
    expect(payload?.lastSeenAt).toBe('2025-01-15T00:00:00.000Z');
    expect(payload?.message).toContain('satellite (GABC123)');
    expect(payload?.message).toContain('3 consecutive missed windows');

    expect(logContexts).toHaveLength(1);
    expect(logContexts[0]).toMatchObject({
      alertId: payload!.alert.id,
      provider: 'satellite',
      providerAddress: 'GABC123',
      methodology: 'REMOTE-SENSING',
      status: 'degraded',
      consecutiveMissedWindows: 3,
      lastSeenAt: '2025-01-15T00:00:00.000Z',
      checkedAt: '2025-02-01T00:00:00.000Z',
      url: CONFIG.url,
      webhookUrl: WEBHOOK,
    });
  });

  it('tracks the last healthy observation as lastSeenAt', () => {
    const http = new MockHttpClient([{ status: 200, data: {} }]);
const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      logger: silentLogger,
      cooldownMs: 0,
      now: () => 0,
    });

    tracker.evaluate(
      healthResult('satellite', 'up', { checkedAt: '2025-03-01T00:00:00.000Z' }),
    );
    const payload = tracker.evaluate(
      healthResult('satellite', 'degraded', {
        checkedAt: '2025-03-02T00:00:00.000Z',
      }),
    );

    expect(payload?.lastSeenAt).toBe('2025-03-01T00:00:00.000Z');
  });

  it('swallows webhook delivery failures without blocking evaluation', async () => {
    const http = new MockHttpClient([new Error('ECONNREFUSED')]);
    const warns: string[] = [];
    const logger: AlertLogger = { warn: (message) => warns.push(message) };
const tracker = new ProviderAlertTracker({
      webhookUrl: WEBHOOK,
      http,
      now: () => 0,
      logger,
    });

    expect(() => tracker.evaluate(SATELLITE_DEGRADED())).not.toThrow();
    await flush();

    expect(warns).toContain('oracle degradation webhook delivery failed');
    expect(http.calls).toHaveLength(1);
  });

  it('logs a structured event but sends no webhook when none is configured', () => {
    const previousWebhook = process.env.ORACLE_ALERT_WEBHOOK;
    delete process.env.ORACLE_ALERT_WEBHOOK;

    const logContexts: Array<Record<string, unknown>> = [];
    const logger: AlertLogger = {
      warn: (_message, context) => logContexts.push(context ?? {}),
      info: () => {},
    };
    const tracker = new ProviderAlertTracker({ logger, now: () => 0 });

    const payload = tracker.evaluate(SATELLITE_DEGRADED());

    if (previousWebhook !== undefined) {
      process.env.ORACLE_ALERT_WEBHOOK = previousWebhook;
    }

    expect(tracker.configuredWebhookUrl).toBeUndefined();
    expect(payload).not.toBeNull();
    expect(logContexts).toHaveLength(1);
    expect(logContexts[0].provider).toBe('satellite');
    expect(logContexts[0].status).toBe('degraded');
  });
});
