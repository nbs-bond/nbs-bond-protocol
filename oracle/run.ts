import * as fs from 'fs';
import * as path from 'path';
import { HttpClient, HttpResponse } from './http';

/**
 * A local-file `HttpClient` used to run each adapter against the JSON
 * fixtures in `oracle/testdata/` without any network access.
 *
 * Upstream URLs are matched by their last path segment so the adapters can
 * run with `baseUrl` pointing at the fixture root (e.g. `file://fixtures`).
 */
export class FileHttpClient implements HttpClient {
  private readonly fixtureDir: string;

  constructor(fixtureDir = path.join(__dirname, 'testdata')) {
    this.fixtureDir = fixtureDir;
  }

  private resolve(url: string): HttpResponse<unknown> {
    const match = /projects\/[^/?]+(?:\/([\w-]+))?|\/ndvi\/stats|\/readings/.exec(url);
    if (!match) {
      return { status: 404, data: { error: `no fixture for ${url}` } };
    }

    let filename: string;
    if (url.includes('/ndvi/stats')) {
      filename = 'satellite-ndvi.json';
    } else if (url.includes('/readings')) {
      filename = 'iot-readings.json';
    } else if (url.includes('/surveys')) {
      filename = 'blue-carbon-surveys.json';
    } else if (match[1] === 'monitoring-reports') {
      filename = 'verra-monitoring-reports.json';
    } else {
      filename = 'verra-project.json';
    }

    const file = path.join(this.fixtureDir, filename);
    if (!fs.existsSync(file)) {
      return { status: 404, data: { error: `fixture not found: ${filename}` } };
    }
    return { status: 200, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  async get<T>(url: string): Promise<HttpResponse<T>> {
    return this.resolve(url) as HttpResponse<T>;
  }

  async post<T>(): Promise<HttpResponse<T>> {
    return { status: 404, data: undefined as unknown as T };
  }
}

import { classifyAdapterError, isTransientAdapterError } from './failure';
import { DeadLetterStore } from './dead-letter';
import {
  pollVerraProject,
} from './verra-adapter';
import {
  ingestSatelliteMeasurement,
} from './satellite-processor';
import {
  aggregateIotProject,
  DEFAULT_BULK_DENSITY_T_PER_M3,
  DEFAULT_SAMPLING_DEPTH_M,
} from './iot-aggregator';
import {
  aggregateBlueCarbonProject,
} from './blue-carbon-adapter';

const FILE_URL = 'file://fixtures';

async function runVerra(): Promise<void> {
  const report = await pollVerraProject(
    'VCS-1234',
    { periodStart: '2025-01-01', periodEnd: '2025-06-30' },
    { baseUrl: FILE_URL, http: new FileHttpClient() },
  );
  console.log(JSON.stringify(report, null, 2));
}

async function runSatellite(): Promise<void> {
  const report = await ingestSatelliteMeasurement(
   {
      project_id: 'VCS-1234',
      bbox: [-76.5, -6.2, -76.2, -5.9],
      area_ha: 1250,
      baseline_ndvi: 0.28,
      ndvi_carbon_factor_t_per_ha: 3.67, // TODO: confirm against IPCC table for this project's biome
    },
    { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
    { baseUrl: FILE_URL, http: new FileHttpClient() },
  );
  console.log(JSON.stringify(report, null, 2));
}

async function runIot(): Promise<void> {
  const report = await aggregateIotProject(
    {
      project_id: 'VCS-1234',
      device_ids: ['NBS-SOIL-001', 'NBS-SOIL-002'],
      area_ha: 1250,
      // This is the fixture-driven demo runner, not a real project
      // registration flow, so falling back to the suggested defaults here
      // is fine — a real caller (API/UI) must supply measured values; see
      // IotProjectConfigSchema in schemas.ts, which has no default and
      // will reject a config that omits either field.
      bulk_density_t_per_m3: DEFAULT_BULK_DENSITY_T_PER_M3,
      sampling_depth_m: DEFAULT_SAMPLING_DEPTH_M,
    },
    { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
    { baseUrl: FILE_URL, http: new FileHttpClient() },
  );
  console.log(JSON.stringify(report, null, 2));
}

async function runBlueCarbon(): Promise<void> {
  const report = await aggregateBlueCarbonProject(
    {
      project_id: 'BLUE-2024-001',
      habitat: 'mangrove',
      area_ha: 500,
      baseline_carbon_t_per_ha: 480,
      root_shoot_ratio: 0.8,
    },
    { periodStart: '2025-01-01', periodEnd: '2025-03-31' },
    { baseUrl: FILE_URL, http: new FileHttpClient() },
  );
  console.log(JSON.stringify(report, null, 2));
}

const ADAPTERS = {
  verra: runVerra,
  satellite: runSatellite,
  iot: runIot,
  'blue-carbon': runBlueCarbon,
} as const;

async function runMonitor(): Promise<void> {
  const { startMonitorServer, resolveAdapters } = await import('./monitor');
  startMonitorServer(resolveAdapters());
}

interface RunOutcome {
  adapter: string;
  ok: boolean;
  error?: Error;
}

/**
 * Run a single adapter with full error isolation. A throwing adapter is
 * recorded to the bounded dead-letter store and reported in the summary;
 * it never aborts the remaining adapters in the cycle.
 */
async function runAdapter(name: string, run: () => Promise<void>): Promise<RunOutcome> {
  try {
    await run();
    return { adapter: name, ok: true };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const deadLetter = new DeadLetterStore();
    deadLetter.record({
      id: `${name}:${new Date().toISOString()}`,
      adapter: name,
      kind: classifyAdapterError(err),
      error: err.message,
      failedAt: new Date().toISOString(),
    });
    return { adapter: name, ok: false, error: err };
  }
}

function printSummary(outcomes: RunOutcome[]): number {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const transient = failed.filter((outcome) =>
    isTransientAdapterError(outcome.error),
  ).length;
  const permanent = failed.length - transient;

  if (failed.length > 0) {
    console.error(
      `\n${failed.length} of ${outcomes.length} adapter run(s) failed ` +
        `(${transient} transient, ${permanent} permanent — permanent failures require human review, transient ones retry next cycle).`,
    );
    for (const outcome of failed) {
      const kind = isTransientAdapterError(outcome.error) ? 'transient' : 'permanent';
      console.error(`  [${kind}] ${outcome.adapter}: ${outcome.error?.message}`);
    }
  } else {
    console.log(`\nAll ${outcomes.length} adapter run(s) completed successfully.`);
  }
  return failed.length;
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? 'all';

  if (target === 'monitor') {
    await runMonitor();
    return;
  }

  if (target === 'dead-letter') {
    const store = new DeadLetterStore();
    const records = store.list();
    if (records.length === 0) {
      console.log('Dead-letter store is empty.');
      return;
    }
    console.log(`${records.length} dead-letter record(s) (newest first):`);
    for (const record of records) {
      console.log(JSON.stringify(record));
    }
    return;
  }

  if (target === 'all') {
    const outcomes: RunOutcome[] = [];
    for (const [name, run] of Object.entries(ADAPTERS)) {
      outcomes.push(await runAdapter(name, run));
      console.log('\n' + '─'.repeat(60) + '\n');
    }
    const failed = printSummary(outcomes);
    if (failed > 0) {
      process.exitCode = 1;
    }
    return;
  }
  const run = ADAPTERS[target as keyof typeof ADAPTERS];
  if (!run) {
    console.error(`Unknown adapter '${target}'. Expected one of: ${Object.keys(ADAPTERS).join(', ')}, all, monitor, dead-letter`);
    process.exit(1);
  }
  const outcome = await runAdapter(target, run);
  if (!outcome.ok) {
    printSummary([outcome]);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
