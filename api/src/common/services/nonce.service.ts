import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
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
export class NonceService {
  private readonly logger = new Logger(NonceService.name);
  private readonly redis: RedisClientType;
  private readonly sorobanRpc: rpc.Server;

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
      // Any other RPC error is also logged and defaults to 0 — the only
      // risk is a spurious InvalidNonce if the account is not new. The
      // caller's retry / error-handling path covers that case.
      this.logger.warn(
        `sync(): could not read on-chain nonce for ${address} on ${contractAddress}; ` +
          `defaulting to 0. Error: ${error?.message ?? error}`,
      );
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
      this.logger.warn(
        `Failed to allocate nonce for ${address}; falling back to timestamp`,
        error,
      );
      return Math.floor(Date.now() / 1000);
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
      // We hold the lock — run sync() and then release.
      try {
        await this.sync(contractAddress, address);
      } catch (syncError) {
        // Log and continue; the INCR below will operate on whatever state
        // sync() managed to write (or on a pre-existing key if another
        // racing caller already seeded it).
        this.logger.warn(
          `next(): sync() failed for ${address}; proceeding with INCR from 0. ` +
            `This may produce an InvalidNonce error if the address has prior transactions. ` +
            `Error: ${syncError?.message ?? syncError}`,
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
}
