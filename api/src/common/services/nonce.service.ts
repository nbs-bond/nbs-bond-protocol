import { Injectable, Logger, InternalServerErrorException, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from '@redis/client';
import { randomBytes } from 'crypto';
import {
  rpc,
  Contract,
  Address,
  xdr,
  scValToNative,
} from '@stellar/stellar-sdk';

const NONCE_KEY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Redis set of every `${contractAddress}:${address}` pair that has ever
 * requested a nonce. Consumed by NonceReconcilerService so the background
 * cron knows which on-chain nonces to re-sync, and self-heals drift even
 * when the per-pair nonce key itself still exists with a stale value.
 *
 * Intentionally TTL-less: this is the durable registry of pairs that must
 * be reconciled, not a cache.
 */
export const KNOWN_PAIRS_KEY = 'nonce:known-pairs';

/**
 * How long the sync() lock is held, in milliseconds.
 *
 * This only needs to cover the duration of a single getContractData() RPC
 * call — typically 200–500 ms on a healthy node. 5 s gives comfortable
 * headroom for a slow node without holding off concurrent callers for too
 * long. If a process crashes while holding the lock it will auto-expire
 * rather than deadlocking all subsequent callers.
 */
const SYNC_LOCK_TTL_MS = 5_000;

/**
 * How long a non-lock-holder will wait (in total) for the lock-holding
 * request to finish seeding the nonce key, before giving up.
 */
const SYNC_LOCK_WAIT_TIMEOUT_MS = 3_000;

/** Poll interval while waiting for the lock holder to finish sync(). */
const SYNC_LOCK_POLL_INTERVAL_MS = 100;

@Injectable()
export class NonceService implements OnModuleDestroy {
  private readonly logger = new Logger(NonceService.name);
  private readonly redis: RedisClientType;
  private readonly sorobanRpc: rpc.Server;

  /**
   * Tracks all active lock keys (nonce_lock:*) currently held by THIS
   * process instance.  When the process shuts down, onModuleDestroy()
   * iterates this set and releases every lock so other replicas can
   * proceed immediately instead of waiting for the auto-expire TTL.
   */
  private readonly heldLocks = new Map<string, string>(); // lockKey → lockToken

  constructor() {
    this.redis = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    this.redis.connect().catch(() => {
      this.logger.warn('Redis unavailable; nonce tracking disabled');
    });

    this.sorobanRpc = new rpc.Server(
      process.env.SOROBAN_RPC_URL || 'http://localhost:8000/soroban/rpc',
      { allowHttp: true },
    );
  }

  /**
   * Reads the current nonce for `address` directly from on-chain contract
   * persistent storage, writes it into Redis with a 30-day TTL, and returns
   * the value.
   *
   * HOW THE ON-CHAIN NONCE IS READ:
   * Each contract stores a per-address nonce under DataKey::Nonce(Address) in
   * persistent storage. The Soroban SDK's #[contracttype] macro encodes a
   * tuple-like enum variant Nonce(Address) as:
   *
   *   ScvVec([ScvSymbol("Nonce"), address_scval])
   *
   * We construct that key, then call sorobanRpc.getContractData() which hits
   * the getLedgerEntries RPC method and returns the parsed LedgerEntryResult
   * directly (not an array — a single entry object). The nonce value lives at
   * response.val.contractData().val(), which we decode with scValToNative().
   *
   * WHY THIS EXISTS:
   * Redis mirrors the on-chain nonce so next() can use INCR without a round-
   * trip to the RPC on every call. When the Redis key is absent — either
   * because this is a first-ever call for this (contract, address) pair, or
   * because the 30-day TTL expired due to inactivity — we MUST NOT assume the
   * nonce is 0. The contract may have a non-zero nonce from prior transactions.
   * Assuming 0 would produce an InvalidNonce error on the very next transaction
   * and in the worst case could allow a nonce-collision replay.
   *
   * This method is the authoritative re-sync path: always safe to call, and
   * the expected fallback when next() detects a missing key.
   */
  async sync(contractAddress: string, address: string): Promise<number> {
    const key = `nonce:${contractAddress}:${address}`;
    await this.trackPair(contractAddress, address);
    let onChainNonce = 0;

    try {
      // Build the DataKey::Nonce(Address) ScVal that each contract uses as its
      // persistent storage key. #[contracttype] encodes a single-payload enum
      // variant as ScvVec([ScvSymbol("<VariantName>"), <payload>]).
      const addressScVal = Address.fromString(address).toScVal();
      const nonceKey = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Nonce'),
        addressScVal,
      ]);

      // getContractData() returns a single LedgerEntryResult (not an array).
      // If the entry does not exist the RPC throws — we catch that below and
      // treat it as nonce=0, matching the contract's own unwrap_or(0) default
      // for brand-new addresses.
      const entry = await this.sorobanRpc.getContractData(
        new Contract(contractAddress),
        nonceKey,
        rpc.Durability.Persistent,
      );

      // entry.val is xdr.LedgerEntryData; the nonce ScVal lives at
      // .contractData().val() — this is the standard path for reading a
      // contract's persistent storage value from a raw ledger entry.
      const scVal = entry.val.contractData().val();
      onChainNonce = Number(scValToNative(scVal));
    } catch (error) {
      // A "not found" / "entry not found" error here means the address has
      // never transacted with this contract, so the contract's own
      // unwrap_or(0) would also return 0. Treat that as nonce=0.
      if (this.isNotFoundError(error)) {
        this.logger.debug(
          `sync(): no on-chain nonce entry for ${address} on ${contractAddress}; defaulting to 0`,
        );
      } else {
        // Any other RPC failure is a real outage: rethrow so the caller can
        // surface a clear error instead of silently handing back a wrong nonce
        // (e.g. when next() falls back to sync() after a Redis failure).
        this.logger.error(
          `sync(): could not read on-chain nonce for ${address} on ${contractAddress}; ` +
            `Error: ${error?.message ?? error}`,
        );
        throw error;
      }
    }

    // Atomically write the value with TTL in a single SET ... EX command.
    // Using SET with EX is mandatory here — a separate SET + EXPIRE would
    // leave a window where the key exists without a TTL, reintroducing the
    // unbounded-growth bug this service was fixed to prevent.
    await this.redis.set(key, String(onChainNonce), {
      EX: NONCE_KEY_TTL_SECONDS,
    });

    this.logger.debug(
      `sync(): seeded nonce key ${key} = ${onChainNonce} (TTL ${NONCE_KEY_TTL_SECONDS}s)`,
    );
    return onChainNonce;
  }

  /**
   * Allocate the next valid nonce for an address scoped to a contract.
   *
   * Contracts track a per-address, per-contract nonce starting at 0.
   * A Lua script is used so that INCR and EXPIRE are performed atomically,
   * preventing a race window where the key exists without a TTL.
   *
   * WHY THE EXISTS CHECK AND LOCK MATTER:
   * Redis INCR on a missing key silently starts from 0 → returns 1, so
   * `next()` would hand back nonce=0. If the real on-chain nonce for this
   * address is, say, 42 (because it last transacted more than 30 days ago and
   * the TTL-expired key was dropped), sending nonce=0 causes an InvalidNonce
   * contract error. We detect the missing key with EXISTS and call sync() to
   * seed the correct baseline before incrementing.
   *
   * WHY THE LOCK IS NECESSARY (not just EXISTS):
   * EXISTS and sync() are not atomic. Two concurrent next() calls that both
   * see a missing key would both call sync(), producing:
   *   - Duplicate on-chain RPC reads (wasted getContractData calls)
   *   - A write race between the two sync() calls landing in unpredictable
   *     order, potentially overwriting a value already incremented by the
   *     first caller's subsequent INCR
   * The lock ensures only one request runs sync() at a time. Other callers
   * wait for the nonce key to appear (seeded by the lock holder) then proceed
   * directly to the INCR+EXPIRE step.
   */
  async next(contractAddress: string, address: string): Promise<number> {
    const key = `nonce:${contractAddress}:${address}`;

    // Record this pair in the known-pairs registry so the background
    // reconciliation cron (NonceReconcilerService) can re-sync it from the
    // chain every cycle. Tracking failures must never block nonce allocation.
    await this.trackPair(contractAddress, address);

    // If the key is absent (first call ever, or expired after 30 days of
    // inactivity), sync the real on-chain value before incrementing.
    // DO NOT skip this check and fall through to INCR — a missing key
    // treated as 0 would collide with the address's real on-chain nonce.
    const exists = await this.redis.exists(key);
    if (!exists) {
      await this.syncWithLock(contractAddress, address);
    }

    // Lua script: atomically increment and (re-)set TTL in a single round-trip.
    const luaScript = `
      local val = redis.call("INCR", KEYS[1])
      redis.call("EXPIRE", KEYS[1], ARGV[1])
      return val
    `;
    try {
      const incremented = (await this.redis.eval(luaScript, {
        keys: [key],
        arguments: [String(NONCE_KEY_TTL_SECONDS)],
      })) as number;
      return incremented - 1;
    } catch (error) {
      // Redis INCR failed. Fall back to the authoritative on-chain nonce via
      // sync(). Never fabricate a timestamp nonce: a Unix timestamp is far
      // ahead of the contract's expected nonce (guaranteed InvalidNonce) and
      // collides for concurrent requests in the same second.
      this.logger.error(
        `next(): Redis nonce allocation failed for ${address} on ${contractAddress}; ` +
          `falling back to on-chain sync. Error: ${error?.message ?? error}`,
      );
      return await this.sync(contractAddress, address);
    }
  }

  /**
   * Register a (contractAddress, address) pair in the known-pairs registry
   * used by the reconciliation cron.
   *
   * Errors are swallowed with a debug log: SADD is bookkeeping for a
   * background job and must never fail (or slow down) a live nonce
   * allocation. If the registry is unavailable, next() and sync() still
   * behave correctly — the per-call missing-key sync path is unaffected.
   */
  private async trackPair(
    contractAddress: string,
    address: string,
  ): Promise<void> {
    try {
      await this.redis.sAdd(KNOWN_PAIRS_KEY, `${contractAddress}:${address}`);
    } catch (error) {
      this.logger.debug(
        `trackPair(): could not record ${contractAddress}:${address} in ` +
          `${KNOWN_PAIRS_KEY}: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * Return every (contractAddress, address) pair that has ever requested a
   * nonce, for the background reconciliation cron (NonceReconcilerService).
   *
   * Members are stored as `${contractAddress}:${address}`. Contract and
   * Stellar addresses never contain a colon, so splitting on the first ':'
   * is unambiguous. Malformed members are skipped with a debug log.
   */
  async listKnownPairs(): Promise<
    Array<{ contractAddress: string; address: string }>
  > {
    const members = await this.redis.sMembers(KNOWN_PAIRS_KEY);
    const pairs: Array<{ contractAddress: string; address: string }> = [];
    for (const member of members) {
      const separator = member.indexOf(':');
      if (separator <= 0 || separator === member.length - 1) {
        this.logger.debug(
          `listKnownPairs(): skipping malformed member "${member}"`,
        );
        continue;
      }
      pairs.push({
        contractAddress: member.slice(0, separator),
        address: member.slice(separator + 1),
      });
    }
    return pairs;
  }

  /**
   * Whether an on-chain read error indicates the nonce entry simply does not
   * exist yet (brand-new address) rather than an RPC/network failure.
   */
  private isNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /not found/i.test(message);
  }

  /**
   * Roll back the most recent optimistic nonce increment for an address.
   *
   * Called when a transaction that consumed a nonce slot ultimately fails
   * on-chain (FAILED status from getTransaction) or times out.  A simple
   * DECR + EXPIRE Lua script is atomic and sufficient here — the nonce
   * was incremented by exactly one INCR in the preceding next() call, so
   * decrementing by one restores the correct baseline for the next retry.
   *
   * If the key does not exist (e.g. it expired between next() and the
   * failed confirmation), DECR will create it at -1 which is harmless —
   * the next call's sync() path will re-seed from on-chain state.
   */
  async rollback(contractAddress: string, address: string): Promise<number> {
    const key = `nonce:${contractAddress}:${address}`;
    const luaScript = `
      local val = redis.call("DECR", KEYS[1])
      redis.call("EXPIRE", KEYS[1], ARGV[1])
      return val
    `;
    try {
      const decremented = (await this.redis.eval(luaScript, {
        keys: [key],
        arguments: [String(NONCE_KEY_TTL_SECONDS)],
      })) as number;
      this.logger.debug(
        `rollback(): ${key} decremented to ${decremented}`,
      );
      return decremented;
    } catch (error) {
      this.logger.warn(
        `rollback(): failed to decrement nonce for ${address} on ${contractAddress}: ${error?.message ?? error}`,
      );
      throw error;
    }
  }

  /**
   * Ensures sync() runs exactly once per missing (contractAddress, address)
   * pair, even under concurrent next() calls.
   *
   * LOCK PROTOCOL:
   * 1. Try to acquire `nonce_lock:<contractAddress>:<address>` using
   *    SET … NX PX <SYNC_LOCK_TTL_MS>. NX means "only set if the key does
   *    not already exist" — so at most one caller wins the lock at a time.
   *    PX sets a millisecond TTL so the lock auto-expires if this process
   *    crashes before releasing it (preventing a permanent deadlock).
   *
   * 2. LOCK ACQUIRED: run sync(), which seeds the nonce key, then release
   *    the lock via a Lua check-and-delete (only delete if the stored value
   *    still matches our unique token — guards against releasing a lock that
   *    was re-acquired by a later request after an unusually slow sync()).
   *
   * 3. LOCK NOT ACQUIRED (another request is already syncing): poll the
   *    nonce key with EXISTS at SYNC_LOCK_POLL_INTERVAL_MS intervals until
   *    it appears (seeded by the lock holder) or SYNC_LOCK_WAIT_TIMEOUT_MS
   *    elapses. Once the key exists we return — the caller's INCR will work
   *    on the correctly seeded value. On timeout, throw so the caller gets a
   *    clear error rather than silently handing back a potentially wrong nonce.
   */
  private async syncWithLock(
    contractAddress: string,
    address: string,
  ): Promise<void> {
    const lockKey = `nonce_lock:${contractAddress}:${address}`;
    const nonceKey = `nonce:${contractAddress}:${address}`;

    // Unique token that identifies this lock acquisition. Used in the
    // check-and-delete release script to confirm we still own the lock.
    const lockToken = randomBytes(16).toString('hex');

    const acquired = await this.redis.set(lockKey, lockToken, {
      NX: true,
      PX: SYNC_LOCK_TTL_MS,
    });

    if (acquired) {
      // Register the lock so onModuleDestroy() can release it on SIGTERM.
      this.heldLocks.set(lockKey, lockToken);

      // We hold the lock — run sync() and then release.
      let syncFailed = false;
      let syncError: unknown;
      try {
        await this.sync(contractAddress, address);
      } catch (err) {
        // sync() threw a transport / RPC error — we must NOT continue to
        // INCR because the nonce key was never seeded with the real on-chain
        // value. Doing so would let Redis INCR treat the absent key as 0 and
        // emit nonce 0, corrupting the mirror for up to 30 days.
        //
        // Record the failure so we can rethrow after the lock is released
        // (the finally block must always run to release the lock).
        syncFailed = true;
        syncError = err;
        this.logger.error(
          `syncWithLock(): sync() failed for ${address} on ${contractAddress}; ` +
            `aborting nonce allocation to prevent mirror corruption. ` +
            `Error: ${(err as Error)?.message ?? err}`,
        );
      } finally {
        // Release the lock only if we still own it. Using a Lua script makes
        // the read-then-delete atomic — without this, a slow sync() could
        // expire the lock, a new holder could acquire it, and then we would
        // inadvertently delete their lock.
        const releaseLua = `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
          else
            return 0
          end
        `;
        await this.redis
          .eval(releaseLua, { keys: [lockKey], arguments: [lockToken] })
          .catch((err) => {
            this.logger.warn(
              `next(): failed to release sync lock for ${lockKey}: ${err?.message ?? err}`,
            );
          });
        // Deregister the lock regardless of whether the DEL succeeded.
        this.heldLocks.delete(lockKey);
      }

      // Rethrow AFTER the lock has been released (the finally block above
      // runs before this line). If sync() failed with a transport error we
      // must not fall through to the INCR+EXPIRE step — the nonce key was
      // never seeded, so INCR would silently start from 0 and corrupt the
      // mirror for every subsequent call until the 30-day TTL expires.
      if (syncFailed) {
        throw syncError;
      }
    } else {
      // Another request holds the lock and is currently running sync().
      // Poll until the nonce key appears (the lock holder will write it
      // before releasing), then continue to the INCR step.
      this.logger.debug(
        `next(): sync lock busy for ${nonceKey}; waiting for lock holder to finish`,
      );

      const deadline = Date.now() + SYNC_LOCK_WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, SYNC_LOCK_POLL_INTERVAL_MS),
        );
        const seeded = await this.redis.exists(nonceKey);
        if (seeded) {
          return; // Nonce key is now present; proceed to INCR.
        }
      }

      // The lock holder did not seed the key within the timeout window.
      // This should not happen under normal operation (sync() completes in
      // well under SYNC_LOCK_WAIT_TIMEOUT_MS). Throw so the caller can
      // surface a clear error rather than silently proceeding with a
      // potentially wrong nonce.
      throw new InternalServerErrorException(
        `Timed out waiting for nonce key to be seeded for ${address} on ${contractAddress}. ` +
          `A concurrent sync() may have failed or the RPC is too slow.`,
      );
    }
  }

  /**
   * Gracefully shut down the NonceService.
   *
   * Steps:
   * 1. Release every distributed nonce lock currently held by this process.
   *    Without this, other API replicas would need to wait up to
   *    SYNC_LOCK_TTL_MS (5 s) for the auto-expire before they can acquire
   *    the lock and seed the nonce key.
   * 2. Quit the Redis connection cleanly (QUIT command) so the server can
   *    reclaim the connection slot immediately.
   *
   * Called automatically by NestJS when app.enableShutdownHooks() is active
   * and the process receives SIGTERM/SIGINT.
   */
  async onModuleDestroy(): Promise<void> {
    // Release all held locks using the same check-and-delete Lua script used
    // in syncWithLock().  If the lock has already auto-expired or been
    // released by the finally block, the Lua script returns 0 harmlessly.
    const releaseLua = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    for (const [lockKey, lockToken] of this.heldLocks) {
      try {
        await this.redis.eval(releaseLua, {
          keys: [lockKey],
          arguments: [lockToken],
        });
        this.logger.log(`NonceService: released lock ${lockKey} on shutdown`);
      } catch (err) {
        this.logger.warn(
          `NonceService: failed to release lock ${lockKey} on shutdown: ${err?.message ?? err}`,
        );
      }
    }
    this.heldLocks.clear();

    // Close the Redis connection gracefully.
    try {
      if (this.redis.isOpen) {
        await this.redis.quit();
        this.logger.log('NonceService: Redis connection closed gracefully');
      }
    } catch (error) {
      this.logger.warn(
        `NonceService: error closing Redis connection: ${error?.message ?? error}`,
      );
    }
  }
}
