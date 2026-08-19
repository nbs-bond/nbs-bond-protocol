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
import { nativeToScVal } from '@stellar/stellar-sdk';
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
    // Default: Redis SET and eval succeed.
    redisMock.set.mockResolvedValue('OK');
    redisMock.eval.mockResolvedValue(1); // INCR returns 1 → nonce 0
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
});
