/**
 * NonceService self-healing after a Redis flush (e2e)
 *
 * Verifies the acceptance criterion from issue #85 end to end: after a
 * simulated Redis flush wipes every nonce key, the very next API-level
 * NonceService.next() call succeeds without manual intervention by
 * re-syncing the authoritative on-chain nonce.
 *
 * Environment:
 * - Requires a REAL Redis at REDIS_URL (CI provides one via a service
 *   container). The suite is skipped when REDIS_URL is not set so local
 *   runs without Redis stay green.
 * - The Soroban RPC is stubbed at the @stellar/stellar-sdk boundary (the
 *   same technique as nonce.service.spec.ts), so no network, funded
 *   accounts, or deployed contracts are needed.
 *
 * The flush is simulated by deleting only this suite's own `nonce:*` keys
 * (SCAN + UNLINK), not FLUSHDB, so a shared Redis instance is never
 * destructively wiped.
 */
import { createClient, RedisClientType } from '@redis/client';

// ─── Soroban RPC stub ────────────────────────────────────────────────────────
// Declared before jest.mock: the factory runs lazily when the SDK is first
// imported (below), by which point this const is initialized.
const getContractDataMock = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getContractData: getContractDataMock,
      })),
      Durability: actual.rpc.Durability,
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { nativeToScVal } from '@stellar/stellar-sdk';
import { NonceService } from '../src/common/services/nonce.service';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Module-scope skip decision (Jest requires describe.skip at collection
// time). Locally without REDIS_URL set the suite is skipped; CI sets it.
const run = process.env.REDIS_URL ? describe : describe.skip;

// Must be valid StrKeys: NonceService constructs Contract/Address objects
// from them before querying storage. These dummy-but-valid values never
// touch a real network (the RPC is stubbed), so they are safe to reuse.
const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Stub the shape returned by sorobanRpc.getContractData() for a u64 nonce. */
function makeLedgerEntry(nonceValue: number) {
  const scVal = nativeToScVal(BigInt(nonceValue), { type: 'u64' });
  return {
    val: {
      contractData: () => ({
        val: () => scVal,
      }),
    },
  };
}

run('NonceService Redis-flush recovery (e2e)', () => {
  let service: NonceService;
  let redis: RedisClientType;
  // Keys owned by this suite, cleaned up in afterAll.
  const nonceKey = `nonce:${CONTRACT}:${ADDRESS}`;

  beforeAll(async () => {
    // Fail loudly when REDIS_URL was explicitly set but is unreachable.
    redis = createClient({ url: REDIS_URL });
    await redis.connect();

    service = new NonceService();
    // On-chain ground truth: this address is at nonce 7 on the contract.
    getContractDataMock.mockResolvedValue(makeLedgerEntry(7));
  });

  afterAll(async () => {
    // Remove only this suite's keys so a shared Redis is left pristine.
    await redis.del(nonceKey).catch(() => undefined);
    await redis.sRem('nonce:known-pairs', `${CONTRACT}:${ADDRESS}`).catch(() => undefined);
    await service.onModuleDestroy();
    await redis.quit().catch(() => undefined);
  });

  it('recovers from a Redis flush on the next call without manual intervention', async () => {
    // 1. Warm-up: cold Redis seeds the key from the chain (nonce 7), and the
    //    first allocation returns 7.
    expect(await service.next(CONTRACT, ADDRESS)).toBe(7);
    expect(await redis.exists(nonceKey)).toBe(1);
    expect(getContractDataMock).toHaveBeenCalledTimes(1);

    // 2. Simulate the outage from issue #85: every nonce key vanishes from
    //    Redis (restart / eviction / container replacement).
    const keysToUnlink: string[] = [];
    for await (const key of redis.scanIterator({ MATCH: 'nonce:*', COUNT: 100 })) {
      keysToUnlink.push(key as unknown as string);
    }
    await redis.unlink(keysToUnlink);

    // 3. The next call must succeed on its own: the key is missing, so it
    //    re-syncs from the chain (still 7) instead of assuming 0 and
    //    producing an InvalidNonce on the contract. next() returns 7 and the
    //    INCR immediately advances the stored key to 8 for the next call.
    expect(await service.next(CONTRACT, ADDRESS)).toBe(7);
    expect(getContractDataMock).toHaveBeenCalledTimes(2);
    expect(await redis.get(nonceKey)).toBe('8');

    // 4. Warm path restored: subsequent calls hit Redis only, no chain read.
    expect(await service.next(CONTRACT, ADDRESS)).toBe(8);
    expect(getContractDataMock).toHaveBeenCalledTimes(2);
  });
});
