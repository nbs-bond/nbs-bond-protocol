# [BUG] Nonce Mirror Corruption on RPC Error

**Labels:** `bug`, `advanced`, `api`, `reliability`
**Affects:** `api/src/common/services/nonce.service.ts`

---

## Summary

A single transient RPC error permanently corrupts the Redis nonce mirror until
the 30-day TTL expires or a manual resync is forced. Once corrupted the mirror
sits at `0`, so every subsequent `next()` call hands out nonces starting from 0.
The contract rejects them all with `InvalidNonce`, knocking out **all
admin and investor writes** for that `(contract, address)` key.

---

## Background: What the Nonce Mirror Is

`NonceService` maintains a Redis key `nonce:<contractAddress>:<address>` that
mirrors the on-chain per-address nonce stored in Soroban persistent storage.
`next()` calls Redis `INCR` on that key to allocate the next nonce without
paying an RPC round-trip on every transaction.

When the key is absent — either on first use or after the 30-day TTL — `next()`
calls `sync()` to read the real on-chain value and seed the mirror before
incrementing. Getting this seed right is critical: handing out nonce 0 when the
on-chain nonce is, say, 42 causes `InvalidNonce` on every subsequent call.

---

## The Bug

### Where it was: `sync()` (lines 85–123, original)

The original `sync()` wrapped `getContractData` in a `try/catch` and
**unconditionally defaulted `onChainNonce = 0`** whether the error was:

* "entry not found" (brand-new address — nonce really is 0), or
* a timeout / 5xx / network reset (the real on-chain nonce could be anything).

It then called `redis.set(key, '0', { EX: ... })` in both cases, overwriting
whatever value was previously in Redis with `0`.

### Where it still existed: `syncWithLock()` (original)

Even after `sync()` was partially fixed to rethrow non-"not found" errors, the
`catch` block in `syncWithLock()` **swallowed the thrown error** and continued:

```ts
// BEFORE (original syncWithLock catch block — the corruption path)
} catch (syncError) {
  this.logger.warn(
    `next(): sync() failed for ${address}; proceeding with INCR from 0. ...`,
  );
  // ↑ falls through! INCR now runs on a key that was never seeded,
  // treating the missing key as 0.
}
```

Redis `INCR` on a missing key starts at 1 (returning nonce 0 to the caller).
That is correct only for a brand-new address. For any address that has prior
transactions the RPC error silently restarted nonces from 0.

### Why this is severe

| Trigger | Impact |
|---|---|
| Any transient `getContractData` failure (timeout, 5xx, DNS blip) | Mirror is seeded at 0 |
| 30-day TTL expires, next resync hits a flaky node | Same |
| Multiple API replicas, one hits a bad node | That replica corrupts the shared Redis key |
| Recovery | Mirror stays at 0 for up to 30 days or until `sync()` is manually re-run on a healthy node |

Because the mirror is shared across all replicas and its TTL is 30 days, a
single bad resync event during a maintenance window or node rotation can produce
an `InvalidNonce` storm that lasts for weeks.

---

## Root-Cause Diagram

```
next() called, nonce key absent in Redis
          │
          ▼
syncWithLock() — acquires lock, calls sync()
          │
          ▼
sync() calls getContractData()
          │
    ┌─────┴─────────────────────────────────┐
    │ RPC throws "entry not found"           │ RPC throws anything else
    │ → onChainNonce = 0 (correct)           │ → original: onChainNonce = 0 (WRONG)
    │                                        │ → fixed:    rethrow (correct)
    └────────────────┬──────────────────────-┘
                     │ rethrow propagates to syncWithLock()
                     ▼
        syncWithLock catch (original): swallow, continue
        syncWithLock catch (fixed):    rethrow → next() throws
                     │
          ┌──────────┴──────────┐
          │ original            │ fixed
          ▼                     ▼
   INCR on absent key    next() throws clear
   → returns 1            error to caller;
   → nonce 0 emitted      Redis key unchanged
   → CORRUPTION
```

---

## The Fix

### 1. `sync()` — distinguish "not found" from transport errors

`sync()` must **not** call `redis.set()` when `getContractData` throws for any
reason other than "entry not found". The fix (already applied):

```ts
} catch (error) {
  if (this.isNotFoundError(error)) {
    // Brand-new address — on-chain nonce really is 0. Fall through to redis.set(0).
    this.logger.debug(`sync(): no on-chain nonce entry for ...`);
  } else {
    // Transport/RPC failure — we do NOT know the real nonce.
    // Rethrow so the caller can surface a clear error rather than
    // silently writing 0 to the mirror.
    this.logger.error(`sync(): could not read on-chain nonce ...`);
    throw error;                        // ← key change: no redis.set() on transport errors
  }
}
// redis.set() is only reached for the success path and the "not found" path.
await this.redis.set(key, String(onChainNonce), { EX: NONCE_KEY_TTL_SECONDS });
```

`isNotFoundError()` matches messages containing "not found" (case-insensitive),
which covers both the Soroban RPC SDK's `"entry not found"` wording and the
`"not found"` used by tests.

### 2. `syncWithLock()` — rethrow on sync failure, do not swallow

The `catch` block in `syncWithLock()` must rethrow the error so that `next()`
propagates a clear exception to the API layer rather than silently proceeding
with `INCR` on an unseeded key:

```ts
// BEFORE (corruption path):
} catch (syncError) {
  this.logger.warn(`...proceeding with INCR from 0...`);
  // falls through → INCR on absent key → nonce 0 emitted
}

// AFTER (safe):
} catch (syncError) {
  this.logger.error(
    `syncWithLock(): sync() failed for ${address} on ${contractAddress}; ` +
      `aborting nonce allocation to prevent mirror corruption. ` +
      `Error: ${syncError?.message ?? syncError}`,
  );
  throw syncError;                      // ← key change: propagate, do not continue
}
```

With this fix:
* The Redis mirror is **never overwritten** with `0` on a transport error.
* `next()` throws a clear error to the HTTP layer, which returns 5xx to the
  client. The client can retry when the RPC node recovers.
* The existing mirror value (if any) is untouched.
* If the mirror is absent when the error occurs it stays absent; the next
  `next()` call will re-attempt `sync()` after the RPC recovers.

### 3. Caller behaviour of `next()` on RPC failure

The `syncWithLock()` rethrow propagates naturally through `next()`. The API
layer's existing 5xx handling returns an appropriate error to the client. No
nonce is allocated; no transaction is built with a wrong nonce; no
`InvalidNonce` storm occurs.

---

## Acceptance Criteria

| # | Criterion | How verified |
|---|---|---|
| AC-1 | A forced `getContractData` transport exception does **not** reset the Redis mirror | `sync() — transport RPC error: does NOT overwrite the Redis mirror` test |
| AC-2 | `next()` throws a clear error when `sync()` fails on RPC transport error | `next() — RPC transport error during sync: throws and does not corrupt mirror` test |
| AC-3 | A "not found" response still correctly seeds the mirror with 0 | `sync() — on-chain entry absent` test (existing, unchanged) |
| AC-4 | After an RPC failure the mirror retains its pre-failure value | `next() — key already present: RPC transport error during forced sync does not overwrite mirror` test |
| AC-5 | `syncWithLock()` concurrent lock-wait waiter surfaces a clear error when the lock holder's sync fails | `next() — concurrent calls: waiter surfaces error when lock holder's sync fails` test |

---

## Files Changed

| File | Change |
|---|---|
| `api/src/common/services/nonce.service.ts` | `syncWithLock()`: rethrow sync error instead of logging-and-continuing |
| `api/src/common/services/nonce.service.spec.ts` | New tests for RPC-failure scenarios (AC-1 through AC-5) |
| `docs/issues/nonce-mirror-corruption.md` | This document |

---

## Out of Scope

* `Math.floor` timestamp fallback nonce (tracked as issue #136) — the existing
  code already avoids this by rethrowing from `sync()` and falling back to
  on-chain resync in the `next()` Redis-failure path.
* Circuit-breaker / backoff for repeated RPC failures — a reasonable future
  improvement but not required to fix the corruption vector.
* `isNotFoundError` refinement to use error codes instead of message matching —
  acceptable improvement but the current string match covers all known SDK
  variants and is safe to iterate on separately.
