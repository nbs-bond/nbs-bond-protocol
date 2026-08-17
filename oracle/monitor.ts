import * as http from 'http';
import * as fs from 'fs';
import {
  AdapterHealth,
  HealthCheckConfig,
  runHealthChecks,
  checkAdapterHealth,
  defaultHealthChecks,
} from './health';
import {
  StalenessInput,
  computeStaleness,
  cadenceForMethodology,
} from './staleness';

const DEFAULT_PORT = Number(process.env.ORACLE_MONITOR_PORT || 8080);

interface StalenessRequestBody {
  projects?: Array<
    Omit<StalenessInput, 'cadenceSeconds'> & { methodology?: string }
  >;
  /** Unix timestamp in seconds, matching Soroban's ledger timestamp. */
  referenceTimestamp?: number;
}

function readStalenessFile(filePath?: string): StalenessInput[] | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.projects ?? null;
  } catch {
    return null;
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function resolveReferenceTimestamp(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return Math.floor(Date.now() / 1000);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('referenceTimestamp must be a non-negative Unix timestamp in seconds');
  }
  return parsed;
}

function stalenessResponse(inputs: StalenessInput[], referenceTimestamp: number): unknown {
  return {
    asOf: new Date(referenceTimestamp * 1000).toISOString(),
    projects: computeStaleness(inputs, referenceTimestamp),
  };
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

/**
 * Start the oracle monitor HTTP server.
 *
 * Endpoints:
 *   GET  /health                 per-adapter health check
 *   GET  /staleness              staleness from ORACLE_STALENESS_FILE
 *   POST /staleness              staleness computed from a JSON body
 *
 * Both staleness endpoints accept an optional `referenceTimestamp` Unix
 * timestamp in seconds, matching Soroban's ledger timestamp.
 */
export function startMonitorServer(
  adapters: HealthCheckConfig[] = [],
  port: number = DEFAULT_PORT,
): http.Server {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/health' && request.method === 'GET') {
      const health: AdapterHealth[] = await runHealthChecks(adapters);
      sendJson(response, 200, {
        asOf: new Date().toISOString(),
        status: health.some((entry) => entry.status === 'down') ? 'down' : 'ok',
        adapters: health,
      });
      return;
    }

    if (url.pathname === '/staleness' && request.method === 'GET') {
      const inputs = readStalenessFile(process.env.ORACLE_STALENESS_FILE);
      if (!inputs) {
        sendJson(response, 503, {
          error: 'ORACLE_STALENESS_FILE not set or unreadable',
        });
        return;
      }
      try {
        const referenceTimestamp = resolveReferenceTimestamp(
          url.searchParams.get('referenceTimestamp'),
        );
        sendJson(response, 200, stalenessResponse(inputs, referenceTimestamp));
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname === '/staleness' && request.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(request)) as StalenessRequestBody;
        const projects = body.projects ?? (Array.isArray(body) ? body : []);
        const inputs: StalenessInput[] = projects.map((project: any) => ({
          projectId: project.projectId,
          provider: project.provider,
          lastVerifiedAt: project.lastVerifiedAt,
          createdAt: project.createdAt,
          cadenceSeconds: project.cadenceSeconds ?? cadenceForMethodology(project.methodology ?? ''),
          graceSeconds: project.graceSeconds,
        }));
        const referenceTimestamp = resolveReferenceTimestamp(
          body.referenceTimestamp ?? url.searchParams.get('referenceTimestamp'),
        );
        sendJson(response, 200, stalenessResponse(inputs, referenceTimestamp));
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  });

  server.listen(port, () => {
    console.log(`Oracle monitor listening on http://localhost:${port}`);
    console.log(`Endpoints: /health, GET /staleness, POST /staleness`);
  });

  return server;
}

/** Resolve adapters from ORACLE_ADAPTERS, falling back to defaults. */
export function resolveAdapters(): HealthCheckConfig[] {
  const configured = process.env.ORACLE_ADAPTERS;
  if (!configured) return defaultHealthChecks();
  return configured.split(',').map((adapter) => ({
    adapter,
    url: process.env[`${adapter.toUpperCase()}_URL`] || '',
  }));
}

async function main(): Promise<void> {
  const port = Number(process.env.ORACLE_MONITOR_PORT || DEFAULT_PORT);
  const adapters = resolveAdapters();

  if (adapters.length === 0) {
    console.warn('No explicit adapters configured; using default health checks.');
  }

  startMonitorServer(adapters, port);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { checkAdapterHealth, runHealthChecks, defaultHealthChecks };
