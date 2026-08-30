/**
 * Unit tests for NonceService.
 *
 * Mocking strategy (matches bonds.service.spec.ts and dex.service.spec.ts):
 * - @redis/client is mocked at the module level so no real Redis connection
 *   is attempted. Individual tests override mock return values as needed.
 * - @stellar/stellar-sdk's rpc.Server is mocked so no real RPC calls are
 *   made; getContractData resolves or rejects per-test.
 * - jest.useFakeTimers() is NOT used here — setTimeout inside syncWithLock
 *   is stubbed at the module level so concurrency tests run synchronously.
 */

// ─── Redis mock ─────────────────────────────────────────────────────────────
// Must be hoisted before any import that triggers the module.

const redisMock = {
  connect: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn(),
  set: jest.fn(),
  eval: jest.fn(),
  sAdd: jest.fn(),
  sMembers: jest.fn(),
};

jest.mock('@redis/client', () => ({
  createClient: jest.fn().mockReturnValue(redisMock),
}));

// ─── Stellar SDK mock ────────────────────────────────────────────────────────

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

import { NonceService } from './nonce.service';
import { nativeToScVal, Keypair } from '@stellar/stellar-sdk';
import { InternalServerErrorException } from '@nestjs/common';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Build a minimal xdr.LedgerEntryData stub that looks like the shape
 * returned by sorobanRpc.getContractData() for a u64 nonce value.
 */
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NonceService', () => {
  let service: NonceService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: Redis SET, eval, and set operations succeed.
    redisMock.set.mockResolvedValue('OK');
    redisMock.eval.mockResolvedValue(1); // INCR returns 1 → nonce 0
    redisMock.sAdd.mockResolvedValue(1);
    redisMock.sMembers.mockResolvedValue([]);
    service = new NonceService();
  });

  // ── Case (a) ───────────────────────────────────────────────────────────────
  // Key missing → next() calls sync(), returns on-chain-derived nonce.
  describe('next() — key missing, no contention', () => {
    it('calls sync() and returns the correct on-chain-derived nonce as the first value', async () => {
      // The nonce key does not exist in Redis.
      redisMock.exists.mockResolvedValueOnce(0); // nonce key absent → trigger sync
      // Lock acquisition succeeds (SET NX returns 'OK').
      redisMock.set.mockResolvedValueOnce('OK');
      // On-chain nonce is 7 for this address.
      getContractDataMock.mockResolvedValueOnce(makeLedgerEntry(7));
      // sync() writes the seeded value; let it pass through.
      redisMock.set.mockResolvedValueOnce('OK');
      // Lock release eval succeeds.
      redisMock.eval.mockResolvedValueOnce(1);
      // INCR+EXPIRE Lua: existing value is 7, INCR → 8; nonce returned is 8-1 = 7.
      redisMock.eval.mockResolvedValueOnce(8);

      const nonce = await service.next(CONTRACT, ADDRESS);

      // sync() must have been called (getContractData was invoked).
      expect(getContractDataMock).toHaveBeenCalledTimes(1);
      // The nonce returned should reflect the on-chain baseline (7), which
      // after one INCR means the caller gets 7 as its allocated slot.
      expect(nonce).toBe(7);
    });

    it('returns 0 as the first nonce when the address is brand-new (on-chain entry absent)', async () => {
      // Key absent in Redis.
      redisMock.exists.mockResolvedValueOnce(0);
      // Lock acquired.
      redisMock.set.mockResolvedValueOnce('OK');
      // getContractData throws "entry not found" for a brand-new address —
      // this matches the contract's unwrap_or(0) behaviour.
      getContractDataMock.mockRejectedValueOnce(new Error('entry not found'));
      // sync() writes 0 to Redis.
      redisMock.set.mockResolvedValueOnce('OK');
      // Lock release.
      redisMock.eval.mockResolvedValueOnce(1);
      // INCR from 0 → 1; nonce returned is 1-1 = 0.
      redisMock.eval.mockResolvedValueOnce(1);

      const nonce = await service.next(CONTRACT, ADDRESS);

      expect(getContractDataMock).toHaveBeenCalledTimes(1);
      // First-ever transaction for this address — correct nonce is 0.
      expect(nonce).toBe(0);
    });
  });

  // ── Case (b) ───────────────────────────────────────────────────────────────
  // Key present with TTL → next() skips sync(), goes straight to INCR+EXPIRE.
  describe('next() — key already exists', () => {
    it('does NOT call sync() when the key is present, and refreshes the TTL via INCR+EXPIRE', async () => {
      // Nonce key is already in Redis (value=5, INCR will make it 6).
      redisMock.exists.mockResolvedValueOnce(1);
      // INCR+EXPIRE Lua: returns 6, so nonce is 6-1 = 5.
      redisMock.eval.mockResolvedValueOnce(6);

      const nonce = await service.next(CONTRACT, ADDRESS);

      // sync() path must not have been triggered.
      expect(getContractDataMock).not.toHaveBeenCalled();
      // SET should not have been called either (no lock, no seed write).
      expect(redisMock.set).not.toHaveBeenCalled();
      // Nonce is the pre-increment value (INCR result − 1).
      expect(nonce).toBe(5);
      // The Lua INCR+EXPIRE script was called exactly once.
      expect(redisMock.eval).toHaveBeenCalledTimes(1);
    });
  });

  // ── Case (c) ───────────────────────────────────────────────────────────────
  // Two concurrent next() calls on the same missing key → sync() runs once.
  describe('next() — concurrent calls on missing key', () => {
    it('calls sync() exactly once and both callers receive non-colliding nonces', async () => {
      // Both callers see the key as absent at EXISTS check time.
      redisMock.exists
        .mockResolvedValueOnce(0) // caller A: key absent
        .mockResolvedValueOnce(0) // caller B: key absent
        .mockResolvedValueOnce(1); // caller B poll: key now seeded by A

      // Caller A wins the lock (SET NX → 'OK').
      // Caller B loses (SET NX → null, meaning the key already exists).
      redisMock.set
        .mockResolvedValueOnce('OK') // caller A acquires lock
        .mockResolvedValueOnce(null) // caller B fails to acquire lock
        .mockResolvedValueOnce('OK'); // caller A's sync() writes the nonce key

      // On-chain nonce is 3. Only caller A should reach getContractData.
      getContractDataMock.mockResolvedValueOnce(makeLedgerEntry(3));

      // Lock release eval for caller A.
      redisMock.eval
        .mockResolvedValueOnce(1) // caller A releases lock
        .mockResolvedValueOnce(4) // caller A INCR+EXPIRE: 3+1=4 → nonce 3
        .mockResolvedValueOnce(5); // caller B INCR+EXPIRE: 4+1=5 → nonce 4

      // Kick off both calls concurrently (no await yet).
      const [nonceA, nonceB] = await Promise.all([
        service.next(CONTRACT, ADDRESS),
        service.next(CONTRACT, ADDRESS),
      ]);

      // sync() — and therefore the on-chain RPC — must have been called
      // exactly once, regardless of two concurrent calls.
      expect(getContractDataMock).toHaveBeenCalledTimes(1);

      // The two nonces must be distinct and sequentially ordered.
      expect(nonceA).toBe(3);
      expect(nonceB).toBe(4);
    });
  });

  // ── Case (d) ───────────────────────────────────────────────────────────────
  // Redis INCR failure → next() falls back to on-chain sync() instead of a
  // timestamp nonce.
  describe('next() — Redis INCR failure', () => {
    it('falls back to on-chain sync and returns the on-chain nonce', async () => {
      // Key already exists, so the missing-key sync path is skipped.
      redisMock.exists.mockResolvedValueOnce(1);
      // INCR+EXPIRE Lua script fails (Redis outage).
      redisMock.eval.mockRejectedValueOnce(new Error('redis connection lost'));
      // On-chain sync succeeds with nonce 7.
      getContractDataMock.mockResolvedValueOnce(makeLedgerEntry(7));

      const nonce = await service.next(CONTRACT, ADDRESS);

      // sync() must have been invoked to recover the authoritative nonce.
      expect(getContractDataMock).toHaveBeenCalledTimes(1);
      expect(nonce).toBe(7);
      // sync() re-seeds Redis with the recovered value (atomic SET ... EX).
      expect(redisMock.set).toHaveBeenCalledWith(
        `nonce:${CONTRACT}:${ADDRESS}`,
        '7',
        { EX: 30 * 24 * 60 * 60 },
      );
    });

    it('throws when both Redis INCR and on-chain sync fail', async () => {
      redisMock.exists.mockResolvedValueOnce(1);
      redisMock.eval.mockRejectedValueOnce(new Error('redis connection lost'));
      // On-chain sync also fails with a non-"not found" RPC error.
      getContractDataMock.mockRejectedValueOnce(new Error('RPC node unreachable'));

      await expect(service.next(CONTRACT, ADDRESS)).rejects.toThrow(
        'RPC node unreachable',
      );
    });
  });

  // ── Known-pairs registry (feeds NonceReconcilerService) ─────────────────────

  describe('known-pairs tracking', () => {
    it('records the pair in the registry when next() is called', async () => {
      redisMock.exists.mockResolvedValueOnce(1); // warm key, skip sync
      redisMock.eval.mockResolvedValueOnce(6); // INCR → 6 → nonce 5

      await service.next(CONTRACT, ADDRESS);

      expect(redisMock.sAdd).toHaveBeenCalledWith(
        'nonce:known-pairs',
        `${CONTRACT}:${ADDRESS}`,
      );
    });

    it('records the pair in the registry when sync() is called directly', async () => {
      getContractDataMock.mockResolvedValueOnce(makeLedgerEntry(7));

      await service.sync(CONTRACT, ADDRESS);

      expect(redisMock.sAdd).toHaveBeenCalledWith(
        'nonce:known-pairs',
        `${CONTRACT}:${ADDRESS}`,
      );
    });

    it('never fails nonce allocation when registry tracking fails', async () => {
      redisMock.sAdd.mockRejectedValueOnce(new Error('redis down'));
      redisMock.exists.mockResolvedValueOnce(1);
      redisMock.eval.mockResolvedValueOnce(6);

      const nonce = await service.next(CONTRACT, ADDRESS);

      expect(nonce).toBe(5);
    });

    it('lists known pairs for the reconciler, skipping malformed members', async () => {
      redisMock.sMembers.mockResolvedValueOnce([
        `${CONTRACT}:${ADDRESS}`,
        'malformed-no-colon',
        'trailing-colon:',
      ]);

      const pairs = await service.listKnownPairs();

      expect(pairs).toEqual([{ contractAddress: CONTRACT, address: ADDRESS }]);
    });
  });

  // ── Self-healing after a Redis flush ───────────────────────────────────────
  // The exact operational outage from issue #85: Redis loses all nonce keys
  // (restart, eviction, container replacement) while the on-chain counters
  // keep their real values. The very next API call must recover on its own.

  describe('next() — self-healing after a simulated Redis flush', () => {
    it('re-syncs from the chain without manual intervention once the key is lost', async () => {
      // Warm-up: the key exists in Redis, so this call never touches the chain.
      redisMock.exists.mockResolvedValueOnce(1);
      redisMock.eval.mockResolvedValueOnce(6); // INCR → 6 → nonce 5
      await service.next(CONTRACT, ADDRESS);
      expect(getContractDataMock).not.toHaveBeenCalled();

      // Simulate the flush: every nonce key is now gone from Redis.
      redisMock.exists.mockResolvedValueOnce(0); // key missing post-flush
      redisMock.set.mockResolvedValueOnce('OK'); // lock acquired
      redisMock.set.mockResolvedValueOnce('OK'); // sync() seeds the key
      redisMock.eval.mockResolvedValueOnce(1); // lock release
      redisMock.eval.mockResolvedValueOnce(8); // INCR from 7 → 8
      // The chain still holds the ground truth: nonce 7 for this address.
      getContractDataMock.mockResolvedValueOnce(makeLedgerEntry(7));

      const nonce = await service.next(CONTRACT, ADDRESS);

      // Recovered the authoritative value — no manual Redis reset required.
      expect(getContractDataMock).toHaveBeenCalledTimes(1);
      expect(nonce).toBe(7);
    });
  });

  // ── Case (e) ───────────────────────────────────────────────────────────────
  // sync() defaults to 0 when on-chain entry is absent (new address).
  describe('sync() — on-chain entry absent', () => {
    it('seeds Redis with 0 when getContractData throws (brand-new address)', async () => {
      // getContractData throws for an address with no on-chain history.
      getContractDataMock.mockRejectedValueOnce(new Error('entry not found'));

      const result = await service.sync(CONTRACT, ADDRESS);

      // Should have defaulted to 0 (matches contract unwrap_or(0)).
      expect(result).toBe(0);

      // Redis.set must have been called with the nonce key, value "0", and the
      // correct 30-day TTL — confirming the atomic SET…EX form was used.
      expect(redisMock.set).toHaveBeenCalledWith(
        `nonce:${CONTRACT}:${ADDRESS}`,
        '0',
        { EX: 30 * 24 * 60 * 60 },
      );
    });

    it('seeds Redis with the on-chain value when the entry exists', async () => {
      getContractDataMock.mockResolvedValueOnce(makeLedgerEntry(42));

      const result = await service.sync(CONTRACT, ADDRESS);

      expect(result).toBe(42);
      expect(redisMock.set).toHaveBeenCalledWith(
        `nonce:${CONTRACT}:${ADDRESS}`,
        '42',
        { EX: 30 * 24 * 60 * 60 },
      );
    });
  });

  // ── Additional edge cases ──────────────────────────────────────────────────

  // ── rollback() ─────────────────────────────────────────────────────────────

  describe('rollback()', () => {
    it('decrements the nonce key by 1 via a Lua script', async () => {
      redisMock.eval.mockResolvedValueOnce(4); // DECR from 5 → 4

      const result = await service.rollback(CONTRACT, ADDRESS);

      expect(result).toBe(4);
      expect(redisMock.eval).toHaveBeenCalledTimes(1);
      // Verify the Lua script was called with the correct key and TTL.
      const [script, { keys, arguments: args }] = redisMock.eval.mock.calls[0];
      expect(script).toContain('DECR');
      expect(keys).toEqual([`nonce:${CONTRACT}:${ADDRESS}`]);
      expect(args).toEqual([String(30 * 24 * 60 * 60)]);
    });

    it('propagates Redis errors to the caller', async () => {
      redisMock.eval.mockRejectedValueOnce(new Error('redis connection lost'));

      await expect(service.rollback(CONTRACT, ADDRESS)).rejects.toThrow(
        'redis connection lost',
      );
    });
  });

  // ── lock wait timeout ──────────────────────────────────────────────────────

  describe('next() — lock wait timeout', () => {
    it('throws InternalServerErrorException when lock holder never seeds the key', async () => {
      // Key is missing — both the initial EXISTS check and every poll during
      // the wait loop return 0 (the key never gets seeded).
      redisMock.exists.mockResolvedValue(0);
      // Lock is held by someone else — SET NX returns null (not acquired).
      redisMock.set.mockResolvedValue(null);

      // Enable fake timers so the polling loop's setTimeout calls complete
      // instantly and Date.now() advances past the deadline without waiting
      // 3 real seconds.
      jest.useFakeTimers();

      let caughtError: unknown;
      // Start the call *after* enabling fake timers so every setTimeout
      // inside syncWithLock is captured by the fake clock.
      const promise = service.next(CONTRACT, ADDRESS).catch((err) => {
        caughtError = err;
      });

      // Advance fake clock well past SYNC_LOCK_WAIT_TIMEOUT_MS (3 000 ms),
      // flushing all pending setTimeout callbacks in the polling loop.
      await jest.advanceTimersByTimeAsync(4_000);

      // Let any remaining microtasks settle.
      await promise;

      jest.useRealTimers();

      expect(caughtError).toBeInstanceOf(InternalServerErrorException);
    });
  });

  // ── Concurrent subscriptions from DIFFERENT investor addresses ─────────────
  //
  // This is the scenario #116 ("Fix Nonce Collisions by Removing Shared
  // INVESTOR_SECRET_KEY") actually fixes: 10 different real investors, each
  // signing with their own wallet, subscribing at the same moment. Before the
  // fix, every investor operation was signed with one shared
  // INVESTOR_SECRET_KEY, so all 10 requests shared one on-chain sequence
  // number/nonce regardless of what NonceService did. Now that each investor
  // submits their own pre-signed transaction, NonceService.next() must hand
  // out correctly-scoped, non-colliding nonces per (contract, address) pair
  // under real concurrency.
  //
  // A hand-rolled in-memory fake Redis is used here (rather than sequencing
  // dozens of mockResolvedValueOnce() calls by hand, as the two-caller case
  // above does) because 10 independent addresses each drive their own
  // EXISTS → SET(NX lock) → sync() → INCR+EXPIRE sequence, and the ordering
  // between them is exactly what this test must NOT assume.
  describe('next() — 10 concurrent subscriptions from different investor addresses', () => {
    function createFakeRedis() {
      const store = new Map<string, string>();

      return {
        async connect(): Promise<void> {},
        async exists(key: string): Promise<number> {
          return store.has(key) ? 1 : 0;
        },
        async set(
          key: string,
          value: string,
          opts?: { NX?: boolean; EX?: number; PX?: number },
        ): Promise<'OK' | null> {
          if (opts?.NX && store.has(key)) {
            return null;
          }
          store.set(key, value);
          return 'OK';
        },
        async eval(
          script: string,
          params: { keys: string[]; arguments: string[] },
        ): Promise<number> {
          const [key] = params.keys;
          if (script.includes('INCR')) {
            const next = Number(store.get(key) ?? '0') + 1;
            store.set(key, String(next));
            return next;
          }
          if (script.includes('DECR')) {
            const next = Number(store.get(key) ?? '0') - 1;
            store.set(key, String(next));
            return next;
          }
          if (script.includes('GET') && script.includes('DEL')) {
            // Lock release: check-and-delete.
            const token = params.arguments[0];
            if (store.get(key) === token) {
              store.delete(key);
              return 1;
            }
            return 0;
          }
          throw new Error(`unexpected Lua script in fake redis: ${script}`);
        },
      };
    }

    it('allocates distinct, correctly-incrementing nonces per address with no collisions', async () => {
      const { createClient } = jest.requireMock('@redis/client') as {
        createClient: jest.Mock;
      };
      const fakeRedis = createFakeRedis();
      createClient.mockReturnValueOnce(fakeRedis);

      // Fresh NonceService instance bound to the fake redis above (the
      // module-level redisMock used by every other test in this file is
      // fully hand-mocked and shared, so a real per-test instance is used
      // here instead).
      const concurrentService = new NonceService();

      // 10 distinct investor addresses — each represents a different real
      // user's own wallet, which is the actual fix for #116. Real Keypairs
      // are used (not synthetic strings) because sync() round-trips each
      // address through Address.fromString().
      const investors = Array.from({ length: 10 }, () => Keypair.random().publicKey());

      // Every address is brand-new on-chain (nonce 0), matching the seed
      // scenario used elsewhere in this file for a first-ever transaction.
      getContractDataMock.mockRejectedValue(new Error('entry not found'));

      // Fire all 10 "first subscribe" calls simultaneously.
      const firstRoundNonces = await Promise.all(
        investors.map((address) => concurrentService.next(CONTRACT, address)),
      );

      // Every investor's first nonce must be 0 (their own first-ever
      // transaction against this contract) — no cross-investor collision.
      expect(firstRoundNonces).toEqual(new Array(10).fill(0));

      // Fire a second round concurrently to confirm nonces keep incrementing
      // correctly per address rather than colliding or resetting.
      const secondRoundNonces = await Promise.all(
        investors.map((address) => concurrentService.next(CONTRACT, address)),
      );
      expect(secondRoundNonces).toEqual(new Array(10).fill(1));

      // All 20 allocated (address, nonce) pairs must be unique — the direct
      // definition of "no nonce collisions".
      const allocated = investors.flatMap((address, i) => [
        `${address}:${firstRoundNonces[i]}`,
        `${address}:${secondRoundNonces[i]}`,
      ]);
      expect(new Set(allocated).size).toBe(allocated.length);
    });
  });

  // ── RPC transport-error mirror-integrity tests (AC-1 through AC-5) ─────────

  describe('sync() — transport RPC error: does NOT overwrite the Redis mirror', () => {
    it('throws and never calls redis.set when getContractData fails with a transport error', async () => {
      // Simulate a network-level RPC failure (not "entry not found").
      getContractDataMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8000'));

      await expect(service.sync(CONTRACT, ADDRESS)).rejects.toThrow(
        'connect ECONNREFUSED',
      );

      // redis.set must NOT have been called — the mirror must remain intact.
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('throws and never calls redis.set when getContractData returns a 5xx-style error', async () => {
      getContractDataMock.mockRejectedValueOnce(new Error('Request failed with status code 503'));

      await expect(service.sync(CONTRACT, ADDRESS)).rejects.toThrow(
        'status code 503',
      );

      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('throws and never calls redis.set on an RPC timeout', async () => {
      getContractDataMock.mockRejectedValueOnce(new Error('timeout of 5000ms exceeded'));

      await expect(service.sync(CONTRACT, ADDRESS)).rejects.toThrow(
        'timeout',
      );

      expect(redisMock.set).not.toHaveBeenCalled();
    });
  });

  describe('next() — RPC transport error during sync: throws and does not corrupt mirror', () => {
    it('propagates the RPC error and does not emit nonce 0 when sync() throws on transport error', async () => {
      // Nonce key absent → triggers syncWithLock() → sync() → getContractData fails.
      redisMock.exists.mockResolvedValueOnce(0);
      // Lock acquired successfully.
      redisMock.set.mockResolvedValueOnce('OK');
      // Simulate transient RPC failure.
      getContractDataMock.mockRejectedValueOnce(new Error('RPC node unreachable'));
      // Lock release eval succeeds.
      redisMock.eval.mockResolvedValueOnce(1);

      // next() must throw — not return a nonce.
      await expect(service.next(CONTRACT, ADDRESS)).rejects.toThrow(
        'RPC node unreachable',
      );

      // Redis INCR must NOT have been called — no nonce was emitted.
      // The eval call count should be exactly 1 (the lock release), not 2.
      const incrCallMade = redisMock.eval.mock.calls.some(
        ([script]: [string]) => script?.includes('INCR'),
      );
      expect(incrCallMade).toBe(false);

      // redis.set (used by sync() to write the mirror) must not have been
      // called with the nonce key — the mirror must remain absent/unchanged.
      const mirrorWritten = redisMock.set.mock.calls.some(
        ([k]: [string]) => k === `nonce:${CONTRACT}:${ADDRESS}`,
      );
      expect(mirrorWritten).toBe(false);
    });
  });

  describe('next() — key already present: RPC transport error during forced sync does not overwrite mirror', () => {
    it('preserves the existing mirror value when Redis INCR fails and on-chain sync also fails', async () => {
      // Key is present (seeded from a previous successful sync at nonce 42).
      redisMock.exists.mockResolvedValueOnce(1);
      // INCR+EXPIRE Lua script fails (transient Redis outage).
      redisMock.eval.mockRejectedValueOnce(new Error('redis connection lost'));
      // On-chain sync also fails with an RPC error — the mirror must NOT be
      // overwritten with 0; next() must throw instead.
      getContractDataMock.mockRejectedValueOnce(new Error('RPC timeout'));

      await expect(service.next(CONTRACT, ADDRESS)).rejects.toThrow(
        'RPC timeout',
      );

      // sync() must have been attempted (the Redis-INCR fallback path calls it).
      expect(getContractDataMock).toHaveBeenCalledTimes(1);

      // redis.set must NOT have been called — the pre-existing mirror at 42
      // must remain untouched.
      expect(redisMock.set).not.toHaveBeenCalled();
    });
  });

  describe('next() — concurrent calls: waiter surfaces error when lock holder\'s sync fails', () => {
    it('throws InternalServerErrorException when the key is never seeded because the lock holder sync failed', async () => {
      // Both callers see the key as absent.
      // After the lock holder's sync fails, the key is still absent for the
      // waiter's poll loop.
      redisMock.exists.mockResolvedValue(0); // initial check + all polls return 0

      // Caller A wins the lock; caller B does not.
      redisMock.set
        .mockResolvedValueOnce('OK')   // caller A acquires lock
        .mockResolvedValueOnce(null);  // caller B does not acquire lock

      // Lock holder (caller A) encounters an RPC transport error.
      getContractDataMock.mockRejectedValueOnce(new Error('DNS lookup failed'));

      // Lock release eval succeeds for caller A.
      redisMock.eval.mockResolvedValueOnce(1);

      jest.useFakeTimers();

      const errorsA: unknown[] = [];
      const errorsB: unknown[] = [];

      const promiseA = service.next(CONTRACT, ADDRESS).catch((e) => errorsA.push(e));
      const promiseB = service.next(CONTRACT, ADDRESS).catch((e) => errorsB.push(e));

      // Advance time past the lock wait timeout so caller B's poll loop
      // also times out, preventing the test from hanging.
      await jest.advanceTimersByTimeAsync(5_000);

      await Promise.all([promiseA, promiseB]);

      jest.useRealTimers();

      // Caller A must have received the RPC error (propagated from sync()).
      expect(errorsA).toHaveLength(1);
      expect((errorsA[0] as Error).message).toMatch(/DNS lookup failed/);

      // Caller B must have received a timeout error (the key was never seeded).
      expect(errorsB).toHaveLength(1);
      expect(errorsB[0]).toBeInstanceOf(InternalServerErrorException);
    });
  });
});
