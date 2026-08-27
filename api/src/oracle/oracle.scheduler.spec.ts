import { SchedulerRegistry } from '@nestjs/schedule';
import { OracleScheduler, classifyProviderFailure } from './oracle.scheduler';
import { OracleService } from './oracle.service';
import { OracleMonitoringService } from './oracle.monitoring.service';
import { ProjectsService } from '../projects/projects.service';
import { OracleProviderAdapter, MeasurementData } from './providers/provider.interface';
import { VerraProvider } from './providers/verra.provider';
import { SatelliteProvider } from './providers/satellite.provider';
import { BlueCarbonProvider } from './providers/blue-carbon.provider';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    lPush: jest.fn().mockResolvedValue(1),
    lTrim: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn().mockResolvedValue(true),
  };
  return {
    createClient: jest.fn().mockReturnValue(mockClient),
  };
});

import { createClient, RedisClientType } from '@redis/client';

function measurement(projectId: string): MeasurementData {
  return {
    projectId,
    periodStart: new Date('2025-01-01T00:00:00Z'),
    periodEnd: new Date('2025-03-31T00:00:00Z'),
    carbonSequesteredKg: 50000,
    confidence: 0.95,
    evidenceHashes: ['QmHash'],
  };
}

function provider(name: string, failWith?: Error): OracleProviderAdapter {
  return {
    name,
    methodology: `${name.toUpperCase()}-METH`,
    fetchMeasurement: jest.fn((projectId: string) => {
      if (failWith) return Promise.reject(failWith);
      return Promise.resolve(measurement(projectId));
    }),
  } as unknown as OracleProviderAdapter;
}

function buildScheduler(overrides: {
  oracleService?: Partial<OracleService>;
  projectsService?: Partial<ProjectsService>;
  providers?: OracleProviderAdapter[];
} = {}) {
  const [verra, satellite, blueCarbon] = overrides.providers ?? [
    provider('Verra'),
    provider('Satellite'),
    provider('BlueCarbon'),
  ];
  // By default no on-chain reports exist, so dedup never triggers.
  const oracleService = {
    hasReportForPeriod: jest.fn().mockResolvedValue(false),
    ...(overrides.oracleService ?? {}),
  } as OracleService;
  const scheduler = new OracleScheduler(
    oracleService,
    {} as OracleMonitoringService,
    (overrides.projectsService ?? {}) as ProjectsService,
    verra as unknown as VerraProvider,
    satellite as unknown as SatelliteProvider,
    blueCarbon as unknown as BlueCarbonProvider,
    {} as SchedulerRegistry,
  );
  return { scheduler, verra, satellite, blueCarbon };
}

function redisMock(): {
  client: RedisClientType;
  lPush: jest.Mock;
  lTrim: jest.Mock;
  expire: jest.Mock;
} {
  const client = createClient() as unknown as {
    lPush: jest.Mock;
    lTrim: jest.Mock;
    expire: jest.Mock;
  };
  return {
    client: client as unknown as RedisClientType,
    lPush: client.lPush,
    lTrim: client.lTrim,
    expire: client.expire,
  };
}

describe('OracleScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('classifyProviderFailure', () => {
    it('classifies schema/validation errors and 4xx as permanent', () => {
      expect(classifyProviderFailure(new Error('schema validation failed'))).toBe('permanent');
      expect(classifyProviderFailure(new Error('upstream status 401'))).toBe('permanent');
    });

    it('maps on-chain contract errors to a distinct non-retryable kind', () => {
      expect(classifyProviderFailure(new Error('Contract simulation failed: Error(Contract, #4) (contract error code 4)'))).toBe('contract');
      expect(classifyProviderFailure(new Error('contract error code 5'))).toBe('contract');
      expect(classifyProviderFailure(new Error('Transaction failed: Error(Contract, #10)'))).toBe('contract');
    });

    it('classifies network and 5xx errors as transient', () => {
      expect(classifyProviderFailure(new Error('connect ETIMEDOUT'))).toBe('transient');
      expect(classifyProviderFailure(new Error('upstream status 503'))).toBe('transient');
      expect(classifyProviderFailure(new Error('socket hang up'))).toBe('transient');
    });

    it('defaults unknown errors to transient', () => {
      expect(classifyProviderFailure(new Error('weird'))).toBe('transient');
    });
  });

  describe('pollOracleData', () => {
    it('polls every provider for every project and submits reports', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { scheduler } = buildScheduler({
        oracleService: { submitReport },
        projectsService: {
          findAll: jest.fn().mockResolvedValue({ data: [{ id: 1 }, { id: 2 }] }),
        },
      });

      await scheduler.pollOracleData();

      expect(submitReport).toHaveBeenCalledTimes(6); // 3 providers × 2 projects
      const first = submitReport.mock.calls[0][0];
      expect(first.projectId).toBe('1');
      expect(first.carbonSequestered).toBe(50000);
      expect(first.methodology).toBe('VERRA-METH');
    });

    it('isolates a failing provider so the remaining providers still run', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { lPush, lTrim, expire } = redisMock();
      const { scheduler } = buildScheduler({
        oracleService: { submitReport },
        projectsService: {
          findAll: jest.fn().mockResolvedValue({ data: [{ id: 1 }] }),
        },
        providers: [
          provider('Verra', new Error('connect ETIMEDOUT')),
          provider('Satellite'),
          provider('BlueCarbon'),
        ],
      });

      await scheduler.pollOracleData();

      expect(submitReport).toHaveBeenCalledTimes(2); // satellite + blue carbon
      expect(lPush).toHaveBeenCalledTimes(1); // verra dead-lettered
      const entry = JSON.parse(lPush.mock.calls[0][1] as string);
      expect(entry.provider).toBe('Verra');
      expect(entry.kind).toBe('transient');
      expect(lTrim).toHaveBeenCalledWith('oracle:dead-letter', 0, 999);
      expect(expire).toHaveBeenCalledWith('oracle:dead-letter', expect.any(Number));
    });

    it('records permanent failures separately from transient ones', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { lPush } = redisMock();
      const { scheduler } = buildScheduler({
        oracleService: { submitReport },
        projectsService: {
          findAll: jest.fn().mockResolvedValue({ data: [{ id: 1 }] }),
        },
        providers: [
          provider('Verra', new Error('schema validation failed')),
          provider('Satellite'),
          provider('BlueCarbon'),
        ],
      });

      await scheduler.pollOracleData();

      expect(lPush).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(lPush.mock.calls[0][1] as string);
      expect(entry.kind).toBe('permanent');
    });

    it('records on-chain contract rejections distinctly and never retries them', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { lPush } = redisMock();
      const { scheduler } = buildScheduler({
        oracleService: { submitReport },
        projectsService: {
          findAll: jest.fn().mockResolvedValue({ data: [{ id: 1 }] }),
        },
        providers: [
          provider('Verra', new Error('Contract simulation failed: Error(Contract, #4) (contract error code 4)')),
          provider('Satellite'),
          provider('BlueCarbon'),
        ],
      });

      await scheduler.pollOracleData();

      expect(lPush).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(lPush.mock.calls[0][1] as string);
      expect(entry.kind).toBe('contract');
    });

    it('skips pairs that already have a report covering the same period', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { scheduler } = buildScheduler({
        oracleService: {
          submitReport,
          hasReportForPeriod: jest.fn().mockResolvedValue(true),
        },
        projectsService: {
          findAll: jest.fn().mockResolvedValue({ data: [{ id: 1 }, { id: 2 }] }),
        },
      });

      await scheduler.pollOracleData();

      // 3 providers × 2 projects, but every pair already has a report.
      expect(submitReport).not.toHaveBeenCalled();
    });

    it('deduplicates a period that has a report while submitting a new one', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { scheduler } = buildScheduler({
        oracleService: {
          submitReport,
          // Project 2 already has a report this period; project 1 does not.
          hasReportForPeriod: jest.fn((projectId: string) =>
            Promise.resolve(projectId === '2'),
          ),
        },
        projectsService: {
          findAll: jest.fn().mockResolvedValue({ data: [{ id: 1 }, { id: 2 }] }),
        },
        providers: [provider('Verra')],
      });

      await scheduler.pollOracleData();

      // 1 provider × 2 projects: project 1 submitted, project 2 deduplicated.
      expect(submitReport).toHaveBeenCalledTimes(1);
      expect(submitReport.mock.calls[0][0].projectId).toBe('1');
    });

    it('does not crash and does not poll when projects cannot be loaded', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { scheduler } = buildScheduler({
        oracleService: { submitReport },
        projectsService: {
          findAll: jest.fn().mockRejectedValue(new Error('registry down')),
        },
      });

      await scheduler.pollOracleData();

      expect(submitReport).not.toHaveBeenCalled();
    });

    it('does not crash when the dead-letter write fails', async () => {
      const submitReport = jest.fn().mockResolvedValue(undefined);
      const { client } = redisMock();
      (client.lPush as jest.Mock).mockRejectedValue(new Error('redis down'));
      const { scheduler } = buildScheduler({
        oracleService: { submitReport },
        projectsService: {
          findAll: jest.fn().mockResolvedValue({ data: [{ id: 1 }] }),
        },
        providers: [provider('Verra', new Error('boom'))],
      });

      await expect(scheduler.pollOracleData()).resolves.toBeUndefined();
    });
  });
});
