import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { startMonitorServer } from './monitor';
import { MockHttpClient } from './test-helpers';

const REFERENCE_TIMESTAMP = Math.floor(Date.UTC(2200, 0, 1, 0, 0, 0) / 1000);
const DAY_SECONDS = 24 * 60 * 60;
const CADENCE_GRACE_SECONDS = (365 + 30) * DAY_SECONDS;

interface StalenessResponse {
  asOf: string;
  projects: Array<{
    projectId: string;
    stalenessSeconds: number;
    isStale: boolean;
  }>;
}

function toIso(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

function requestJson(
  server: http.Server,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ status: number; body: StalenessResponse }> {
  const address = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: requestPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(data) as StalenessResponse,
          });
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

describe('staleness monitor reference timestamp', () => {
  let server: http.Server;
  let tempDir: string;
  let originalStalenessFile: string | undefined;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-staleness-'));
    originalStalenessFile = process.env.ORACLE_STALENESS_FILE;
    server = startMonitorServer([], 0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalStalenessFile === undefined) {
      delete process.env.ORACLE_STALENESS_FILE;
    } else {
      process.env.ORACLE_STALENESS_FILE = originalStalenessFile;
    }
    jest.restoreAllMocks();
  });

  it('uses the ledger timestamp supplied in a POST body', async () => {
    const response = await requestJson(server, 'POST', '/staleness', {
      referenceTimestamp: REFERENCE_TIMESTAMP,
      projects: [
        {
          projectId: 'VCS-POST',
          createdAt: toIso(
            REFERENCE_TIMESTAMP - CADENCE_GRACE_SECONDS - DAY_SECONDS,
          ),
          cadenceSeconds: 365 * DAY_SECONDS,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.asOf).toBe(toIso(REFERENCE_TIMESTAMP));
    expect(response.body.projects[0].isStale).toBe(true);
  });

  it('uses the ledger timestamp supplied to the GET endpoint', async () => {
    const stalenessFile = path.join(tempDir, 'staleness.json');
    fs.writeFileSync(
      stalenessFile,
      JSON.stringify([
        {
          projectId: 'VCS-GET',
          createdAt: toIso(
            REFERENCE_TIMESTAMP - CADENCE_GRACE_SECONDS - DAY_SECONDS,
          ),
          cadenceSeconds: 365 * DAY_SECONDS,
        },
      ]),
    );
    process.env.ORACLE_STALENESS_FILE = stalenessFile;

    const response = await requestJson(
      server,
      'GET',
      `/staleness?referenceTimestamp=${REFERENCE_TIMESTAMP}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.asOf).toBe(toIso(REFERENCE_TIMESTAMP));
    expect(response.body.projects[0].isStale).toBe(true);
  });
});

describe('monitor degradation alerting', () => {
  interface HealthResponse {
    asOf: string;
    status: string;
    adapters: Array<{ adapter: string; status: string }>;
  }

  it('fires a degradation webhook when a /health probe degrades', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const healthHttp = new MockHttpClient([{ status: 429, data: {} }]);
    const webhookHttp = new MockHttpClient([{ status: 200, data: {} }]);
    const server = startMonitorServer(
      [{ adapter: 'satellite', url: 'https://upstream.example/v1' }],
      0,
      {
        webhookUrl: 'https://hooks.example.com/webhook',
        http: webhookHttp,
        logger: { warn: () => {}, info: () => {} },
        now: () => 1_000,
      },
      { http: healthHttp },
    );
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const response = await requestJson(server, 'GET', '/health');
      const body = response.body as unknown as HealthResponse;

      expect(response.status).toBe(200);
      expect(body.adapters).toHaveLength(1);
      expect(body.adapters[0].status).toBe('degraded');

      expect(webhookHttp.calls).toHaveLength(1);
      expect(webhookHttp.calls[0].method).toBe('post');
      expect(webhookHttp.calls[0].url).toBe('https://hooks.example.com/webhook');
      const payload = webhookHttp.calls[0].body as {
        provider: { name: string };
        status: string;
        alert: { type: string };
      };
      expect(payload.alert.type).toBe('provider_degraded');
      expect(payload.provider.name).toBe('satellite');
      expect(payload.status).toBe('degraded');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      jest.restoreAllMocks();
    }
  });
});
