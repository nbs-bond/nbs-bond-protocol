# Fix: `listOrders` unbounded sequential scan

**Related issue:** addresses the performance + correctness gap described in
the `listOrders` bug report (distinct from #119 pagination helpers and #138
`calculateSlippage`).

---

## Problem

`listOrders` in `api/src/marketplace/dex.service.ts` (lines 55-103) walks
every order ever created before it can return a single page:

```ts
while (true) {
  try {
    const orderScVal = await this.contractService.simulateCall({ ... });
    // filter, push, index++
  } catch {
    break;   // any error ends the scan
  }
}
```

### What goes wrong

| Symptom | Root cause |
|---|---|
| **Latency scales with total order count** | One simulateCall RPC per order - if 10 000 orders exist, a limit=20 request still issues 10 000 simulated transactions before slicing. |
| **Silent data loss on transient errors** | Any non-OrderNotFound error (network blip, rate-limit) is swallowed and treated as end-of-list, truncating everything after. |
| **ID-gap truncation** | If the contract errors on a specific ID for any reason, the entire remainder of the list is silently dropped. |
| **`total` is a full-scan artefact** | meta.total reflects however many orders were seen before the break, not the true count. |

### Why this matters now

With mainnet DEX launch approaching, order volume will grow continuously:
- p99 latency grows linearly with adoption.
- Each page request competes for the Stellar RPC rate-limit budget with actual trading traffic.
- A single flaky RPC silently hides all orders placed after the failed index.

---

## Solution

### Core strategy: bounded fetch with error classification

Since on-chain get_order_range / get_order_count does not exist yet (#119),
we cannot avoid per-ID fetches entirely. But we can **bound the scan to
`limit` successful fetches** and **distinguish "order not found" from "real
error"** so we never silently truncate.

#### Key changes in `listOrders`

1. **Fetch exactly `limit` matching orders, not all orders.**
   Stop when `fetched === limit` or the contract signals no more orders.

2. **Distinguish `OrderNotFound` (code 4, normal end) from other errors (real fault).**
   Parse the contract error code from the thrown message using the existing
   DEX_ERROR_CODE map. Only OrderNotFound is a legitimate end-of-list signal.
   Any other error is re-thrown so the caller gets a 500 instead of silent truncation.

3. **Apply filters before counting against `limit`.**
   bondId / status filters are applied in-loop; only matching orders count
   toward the page quota. Skipped orders do not burn the quota.

4. **Return a `hasMore` flag instead of a fake `total`.**
   Without get_order_count we cannot know the true total. We expose
   hasMore: boolean in meta (true when we stopped because we hit limit,
   not because we ran out of orders).

#### What stays the same

- The Redis cache key format and TTL are unchanged.
- The PaginatedResponse<T> shape is preserved (hasMore added as optional).
- All other DexService methods are untouched.

---

## Files changed

| File | Change |
|---|---|
| `api/src/marketplace/dex.service.ts` | Rewrite listOrders - bounded scan, error classification, hasMore meta |
| `api/src/marketplace/dex.service.spec.ts` | Add listOrders describe block: large count, mid-list error, gap, filter, cache |

---

## Acceptance criteria

- [x] listOrders issues at most `limit` simulateCall RPCs per page
- [x] A non-OrderNotFound error mid-scan throws instead of silently truncating
- [x] OrderNotFound on any ID is treated as end-of-list
- [x] meta.hasMore is true when the page is full and more orders may exist
- [x] Tests cover: large order counts, mid-list transient error, ID gap,
      filter by bondId/status, cache hit

---

## Out of scope

- On-chain get_order_count / get_order_range (#119)
- calculateSlippage O(n) (#138)
- Cursor-based pagination API design (follow-up)
