/**
 * shutdown.e2e-spec.ts
 *
 * Integration tests for graceful shutdown (Issue #153).
 *
 * What is tested
 * --------------
 * Each suite exercises the onModuleDestroy() hook of each service and verifies
 * the correct cleanup behaviour:
 *
 *   - AuthService:      redis.quit() is called when the module is destroyed.
 *   - NonceService:     any held distributed locks are released and
 *                       redis.quit() is called.
 *   - OracleScheduler:  the shuttingDown flag prevents new poll cycles,
 *                       in-flight cycles are awaited, and redis.quit() is called.
 *   - ContractService:  new transaction submissions are refused after shutdown,
 *                       and in-flight confirmation polls are awaited.
 *
 * Why direct construction rather than Test.createTestingModule for heavy services
 * ---------------------------------------------------------------------------------
 * Services like AuthService, NonceService, and ContractService have heavy
 * constructor dependencies (JwtService, StellarService, NonceService, …).
 * Wiring the full dependency graph in a test that only cares about the
 * onModuleDestroy() method is unnecessary noise.  We construct services
 * directly with `{} as never` stand-ins and then inject a mock Redis client
 * into the private field, matching the pattern used across the rest of the
 * test suite in this project.
 *
 * For the lifecycle-hook suite we DO use Test.createTestingModule because
 * that suite is specifically testing NestJS's hook invocation pipeline.
 *
 * Why in-process rather than subprocess
 * ----------------------------------------
 * A subprocess SIGTERM test would require a live Redis instance and a live
 * Stellar RPC node.  Testing onModuleDestroy() directly is equivalent because
 * app.close() calls the same NestJS callDestroyHook() pipeline as SIGTERM when
 * enableShutdownHooks() is active.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';

// Services under test
import { AuthService } from '../src/auth/auth.service';
import { NonceService } from '../src/common/services/nonce.service';
import { OracleScheduler } from '../src/oracle/oracle.scheduler';
import { ContractService, ContractCallOptions } from '../src/stellar/contract.service';

// ---------------------------------------------------------------------------
// Shared Redis mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock Redis client whose methods can be individually spied on.
 * `isOpen` starts as true so onModuleDestroy() will call quit() on it.
 */
function makeRedisMock() {
  let open = true;
  const mock = {
    get isOpen() {
      return open;
    },
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockImplementation(() => {
      open = false;
      return Promise.resolve();
    }),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    eval: jest.fn().mockResolvedValue(0),
    lPush: jest.fn().mockResolvedValue(1),
    lTrim: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn().mockResolvedValue(1),
  };
  return mock;
}

// ---------------------------------------------------------------------------
// Suite 1: AuthService — redis.quit() on shutdown
// ---------------------------------------------------------------------------

describe('AuthService — graceful shutdown (e2e)', () => {
  let service: AuthService;
  let redisMock: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    redisMock = makeRedisMock();

    // Construct directly with stub dependencies — we only care about the
    // Redis lifecycle, not the business logic of JwtService / KycService.
    service = new AuthService(
      /* jwtService    */ {} as never,
      /* kycService    */ {} as never,
      /* stellarService*/ {} as never,
    );
    // Replace the internally-created Redis client with our controllable mock.
    (service as unknown as { redis: unknown }).redis = redisMock;
  });

  it('calls redis.quit() when onModuleDestroy() is called', async () => {
    await service.onModuleDestroy();

    expect(redisMock.quit).toHaveBeenCalledTimes(1);
  });

  it('does not call redis.quit() when Redis is already closed', async () => {
    // Simulate a closed connection.
    Object.defineProperty(redisMock, 'isOpen', {
      get: () => false,
      configurable: true,
    });

    await service.onModuleDestroy();

    expect(redisMock.quit).not.toHaveBeenCalled();
  });

  it('does not throw if redis.quit() rejects', async () => {
    redisMock.quit.mockRejectedValueOnce(new Error('already disconnected'));

    await expect(service.onModuleDestroy()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: NonceService — lock release + redis.quit() on shutdown
// ---------------------------------------------------------------------------

describe('NonceService — graceful shutdown (e2e)', () => {
  let service: NonceService;
  let redisMock: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    redisMock = makeRedisMock();

    // NonceService constructor creates its own Redis client and SorobanRpc
    // server.  We stub both by overwriting the fields after construction.
    service = new NonceService();
    (service as unknown as { redis: unknown }).redis = redisMock;
    // Stub out sorobanRpc to prevent any real network calls.
    (service as unknown as { sorobanRpc: unknown }).sorobanRpc = {};
  });

  it('releases held locks and calls redis.quit() on shutdown', async () => {
    // Inject a held lock into the private map.
    const heldLocks: Map<string, string> = (
      service as unknown as { heldLocks: Map<string, string> }
    ).heldLocks;

    const lockKey = 'nonce_lock:CONTRACT_A:ADDRESS_1';
    const lockToken = 'test-token-abc123';
    heldLocks.set(lockKey, lockToken);

    // eval mock simulates the Lua check-and-delete succeeding.
    redisMock.eval.mockResolvedValue(1);

    await service.onModuleDestroy();

    // The Lua release script must have been called with the correct key + token.
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining('DEL'),
      expect.objectContaining({
        keys: [lockKey],
        arguments: [lockToken],
      }),
    );

    // All locks must be cleared.
    expect(heldLocks.size).toBe(0);

    // Redis must have been closed.
    expect(redisMock.quit).toHaveBeenCalledTimes(1);
  });

  it('still closes Redis even when lock release throws', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('Redis connection lost'));

    const heldLocks: Map<string, string> = (
      service as unknown as { heldLocks: Map<string, string> }
    ).heldLocks;
    heldLocks.set('nonce_lock:C:A', 'token');

    await expect(service.onModuleDestroy()).resolves.not.toThrow();
    expect(redisMock.quit).toHaveBeenCalledTimes(1);
  });

  it('calls redis.quit() even when no locks are held', async () => {
    await service.onModuleDestroy();

    expect(redisMock.quit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: OracleScheduler — shutdown flag + in-flight cycle + redis.quit()
// ---------------------------------------------------------------------------

describe('OracleScheduler — graceful shutdown (e2e)', () => {
  let service: OracleScheduler;
  let redisMock: ReturnType<typeof makeRedisMock>;
  let deleteCronJobMock: jest.Mock;

  beforeEach(() => {
    redisMock = makeRedisMock();
    deleteCronJobMock = jest.fn();

    service = new OracleScheduler(
      /* oracleService     */ {} as never,
      /* monitoringService */ {} as never,
      /* projectsService   */ {} as never,
      /* verraProvider     */ {} as never,
      /* satelliteProvider */ {} as never,
      /* blueCarbonProvider*/ {} as never,
      /* schedulerRegistry */ { deleteCronJob: deleteCronJobMock } as never,
    );
    (service as unknown as { redis: unknown }).redis = redisMock;
  });

  it('sets shuttingDown to true after onModuleDestroy()', async () => {
    await service.onModuleDestroy();

    const shuttingDown = (service as unknown as { shuttingDown: boolean }).shuttingDown;
    expect(shuttingDown).toBe(true);
  });

  it('unregisters both cron jobs on shutdown', async () => {
    await service.onModuleDestroy();

    expect(deleteCronJobMock).toHaveBeenCalledWith('pollOracleData');
    expect(deleteCronJobMock).toHaveBeenCalledWith('monitorProviderReliability');
  });

  it('waits for an in-flight poll cycle to complete before returning', async () => {
    let resolveCycle!: () => void;
    const longCycle = new Promise<void>((resolve) => {
      resolveCycle = resolve;
    });

    const activePollCycles: Set<Promise<void>> = (
      service as unknown as { activePollCycles: Set<Promise<void>> }
    ).activePollCycles;
    activePollCycles.add(longCycle);

    let shutdownResolved = false;
    const shutdownPromise = service.onModuleDestroy().then(() => {
      shutdownResolved = true;
    });

    // Flush microtasks — shutdown must still be pending.
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    // Complete the in-flight cycle.
    resolveCycle();
    await shutdownPromise;

    expect(shutdownResolved).toBe(true);
  });

  it('calls redis.quit() on shutdown', async () => {
    await service.onModuleDestroy();

    expect(redisMock.quit).toHaveBeenCalledTimes(1);
  });

  it('pollOracleData() is a no-op when shuttingDown is true', async () => {
    (service as unknown as { shuttingDown: boolean }).shuttingDown = true;

    // _runPollCycle() would throw because providers are {} mocks with no methods.
    // With the flag set, pollOracleData() must return without calling the cycle.
    await expect(service.pollOracleData()).resolves.not.toThrow();

    // No cycle was added to activePollCycles.
    const activePollCycles: Set<Promise<void>> = (
      service as unknown as { activePollCycles: Set<Promise<void>> }
    ).activePollCycles;
    expect(activePollCycles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: ContractService — shutdown flag + in-flight drain
// ---------------------------------------------------------------------------

describe('ContractService — graceful shutdown (e2e)', () => {
  let service: ContractService;

  beforeEach(() => {
    service = new ContractService(
      /* stellarService */ {} as never,
      /* nonceService   */ {} as never,
    );
    // Stub out the Soroban RPC server.
    (service as unknown as { sorobanRpc: unknown }).sorobanRpc = {};
  });

  it('sets shuttingDown to true after onModuleDestroy()', async () => {
    await service.onModuleDestroy();

    const shuttingDown = (service as unknown as { shuttingDown: boolean }).shuttingDown;
    expect(shuttingDown).toBe(true);
  });

  it('waits for in-flight transactions to settle before returning', async () => {
    let resolveConfirmation!: (v: unknown) => void;
    const inflightTx = new Promise<unknown>((resolve) => {
      resolveConfirmation = resolve;
    });

    const inFlightTransactions: Set<Promise<unknown>> = (
      service as unknown as { inFlightTransactions: Set<Promise<unknown>> }
    ).inFlightTransactions;
    inFlightTransactions.add(inflightTx as Promise<never>);

    let shutdownResolved = false;
    const shutdownPromise = service.onModuleDestroy().then(() => {
      shutdownResolved = true;
    });

    // Shutdown has not resolved yet — still waiting for in-flight tx.
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    // Resolve the in-flight confirmation.
    resolveConfirmation(undefined);
    await shutdownPromise;

    expect(shutdownResolved).toBe(true);
  });

  it('resolves immediately when there are no in-flight transactions', async () => {
    await expect(service.onModuleDestroy()).resolves.not.toThrow();
  });

  it('sendTransaction() throws 503 SERVICE_UNAVAILABLE when shutting down', async () => {
    (service as unknown as { shuttingDown: boolean }).shuttingDown = true;

    const options: ContractCallOptions = {
      contractAddress: 'CONTRACT',
      method: 'test',
      args: [],
      sourceSecretKey: 'SECRET',
    };

    await expect(service.sendTransaction(options)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 5: NestJS lifecycle hook pipeline — onModuleDestroy called on app.close()
// ---------------------------------------------------------------------------

describe('NestJS lifecycle hooks — onModuleDestroy called on app.close() (e2e)', () => {
  /**
   * Closest in-process equivalent of a SIGTERM test.
   *
   * We register a provider that implements OnModuleDestroy, call app.close(),
   * and verify the hook ran.  app.close() triggers the same NestJS shutdown
   * hook pipeline as SIGTERM when enableShutdownHooks() is active.
   */

  it('calls onModuleDestroy on every provider when app.close() is called', async () => {
    const destroySpy = jest.fn().mockResolvedValue(undefined);

    class ShutdownProbeService {
      async onModuleDestroy() {
        destroySpy();
      }
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [ShutdownProbeService],
    }).compile();

    const app: INestApplication = module.createNestApplication();
    await app.init();

    expect(destroySpy).not.toHaveBeenCalled();

    await app.close();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('enableShutdownHooks() can be called without error', async () => {
    class NoopService {}

    const module: TestingModule = await Test.createTestingModule({
      providers: [NoopService],
    }).compile();

    const app: INestApplication = module.createNestApplication();
    // enableShutdownHooks() must not throw.
    expect(() => app.enableShutdownHooks()).not.toThrow();
    await app.close();
  });
});
