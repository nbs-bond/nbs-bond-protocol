# Runbook: Degraded Oracle Providers

With staking and slashing live on `OracleConsumer`, the protocol has a real
economic stake in provider reliability. This runbook covers how to observe
provider health, what alerts mean, and how to respond.

## Observability surface

| Signal | Where | Description |
|--------|-------|-------------|
| Adapter health | `oracle` monitor, `GET /health` | Per-adapter upstream probe: `up` / `degraded` / `down` + latency |
| Degradation alerts | `oracle` monitor + webhook | Structured log event + optional webhook POST when a provider degrades (see below) |
| Report staleness | API, `GET /oracle/monitoring/staleness` | Per-project and per-provider time since last verified report vs. expected window |
| Provider stats | API, `GET /oracle/stats/:providerAddress` | Reports submitted, challenges faced, slash history (from chain) |
| Alert log | API scheduler | Log-based alert when a project misses its reporting window + grace |

### Starting the oracle monitor

```bash
cd oracle
npm run monitor            # starts http server on $ORACLE_MONITOR_PORT (default 8080)
```

Endpoints:

- `GET /health` — health check per adapter (Verra registry, satellite, IoT).
- `GET /staleness` — staleness from `ORACLE_STALENESS_FILE` (optional JSON input).
- `POST /staleness` — compute staleness from a JSON body:

```json
{
  "projects": [
    {
      "projectId": "VCS-1234",
      "methodology": "VERRA-VCS",
      "createdAt": "2024-01-01T00:00:00Z",
      "lastVerifiedAt": "2025-02-01T00:00:00Z"
    }
  ]
}
```

## Degradation alerting (webhook)

A `degraded`/`down` status is only useful if somebody reacts to it. The oracle
monitor feeds every `GET /health` probe through a `ProviderAlertTracker`
(`oracle/health.ts`) that, when a provider degrades, emits a structured `WARN`
log event and — if a webhook is configured — POSTs a documented JSON payload to
it.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_ALERT_WEBHOOK` | *(unset — log-only)* | URL to POST degradation alerts to (PagerDuty, Slack, OpsGenie, …) |
| `ORACLE_ALERT_COOLDOWN_MS` | `3600000` (1h) | Minimum interval between alerts **per provider**. Prevents alert fatigue when a provider oscillates healthy/degraded within one reporting window; while a provider stays degraded the alert re-fires at most once per cooldown |
| `ORACLE_ALERT_TIMEOUT_MS` | `2000` (2s) | Webhook POST timeout. Delivery is fire-and-forget — a slow or unreachable webhook endpoint never blocks health checks or monitoring of other providers |

### Webhook payload

```json
{
  "alert": {
    "id": "provider-degraded-1-1786960386000",
    "type": "provider_degraded",
    "severity": "warning",
    "generatedAt": "2026-08-17T09:53:06.000Z"
  },
  "provider": {
    "name": "satellite",
    "address": "GABC123...",
    "methodology": "REMOTE-SENSING"
  },
  "status": "degraded",
  "previousStatus": "up",
  "consecutiveMissedWindows": 2,
  "lastSeenAt": "2026-07-01T00:00:00.000Z",
  "checkedAt": "2026-08-17T09:53:06.000Z",
  "latencyMs": 6200,
  "url": "https://api.satellite-processor.io/v1",
  "error": "probe latency 6200ms exceeds threshold 5000ms",
  "message": "oracle provider satellite (GABC123...) is degraded after 2 consecutive missed windows, last seen 2026-07-01T00:00:00.000Z: probe latency 6200ms exceeds threshold 5000ms"
}
```

Field semantics:

- `alert.severity` — `warning` when `status` is `degraded`, `critical` when it is `down`.
- `provider.address` / `provider.methodology` — optional enrichment; pass them when
  evaluating health results (e.g. from the on-chain provider registry).
- `consecutiveMissedWindows` — number of consecutive degraded/down health checks
  (a proxy for missed reporting windows; resets to 0 on recovery).
- `lastSeenAt` — ISO timestamp of the last healthy observation (or the last
  verified report when supplied as context).
- `message` — the same human-readable line written to the structured log.

The structured log event carries the same fields under a `provider`/`providerAddress`
key and also includes `webhookUrl`, so an on-call engineer can act without
additional lookups.

### Alert lifecycle

1. Provider reports `degraded` or `down` → alert fires (log + webhook) and the
   cooldown timer starts for that provider.
2. Provider recovers to `up` → no alert; the consecutive-missed counter resets,
   but the cooldown is **not** cleared, so an oscillation within one cooldown
   window does not re-alert.
3. Provider is still degraded when the cooldown elapses → the alert re-fires
   (at most once per cooldown per provider).
4. Webhook failures are logged (`oracle degradation webhook delivery failed`)
   and never block monitoring.

Webhooks fire when the monitor serves a `GET /health` request and the probe
returns a degraded status — wire `GET /health` into your existing uptime cron
to drive alerting.

### API endpoints

```bash
# Provider stats + slash/challenge history straight from the chain
curl http://localhost:3000/oracle/stats/GBUDFMPN4L7SE6Y3S6W7F7Q5L7Y3S6W7F7Q5L7Y3S6W7F7Q5L7Y3S6W7F

# Staleness metric per project and provider
curl http://localhost:3000/oracle/monitoring/staleness
```

## Staleness metric definition

- **Cadence**: expected seconds between verified reports, per methodology
  (`VERRA-VCS` = 365d, `REMOTE-SENSING` = 90d, `IOT-SENSORS` = 30d; override
  via `ORACLE_CADENCE_SECONDS`).
- **Grace**: additional slack before alerting (`ORACLE_GRACE_SECONDS`, default 30d).
- `expectedNextReportAt = lastVerifiedAt + cadence + grace`.
- A project with no verified report falls back to its `createdAt` as baseline.
- `isStale = now > expectedNextReportAt`.

The API scheduler evaluates this every 6 hours, logs a `WARN` per stale project
(redis-deduplicated so each project alerts at most once per 24h), and the
result is queryable at `GET /oracle/monitoring/staleness`.

## Interpreting provider stats

`GET /oracle/stats/:providerAddress` returns (from chain storage):

- `reportsSubmitted` — lifetime reports submitted.
- `challengesFaced` — reports that were challenged.
- `slashes` / `totalPenalty` — rejected challenges that slashed stake (10% each).
- `slashHistory` — per-slash record (`reportId`, `penalty`, `remainingStake`, `activeAfter`).
- `challengeHistory` — per-challenge record with resolution.

A provider accumulating slashes, or dropping to `active: false` (stake
zeroed), has been through the enforcement path and should be reviewed.

## Alert → action matrix

| Alert | Meaning | Action |
|-------|---------|--------|
| `Oracle alert: project X is stale` | No verified report within cadence + grace | Contact provider; verify ingest jobs are running; check adapter health |
| `Adapter <x> status: down` | Upstream returned 5xx, timeout, or DNS failure | Check upstream provider status / credentials / network |
| `Adapter <x> status: degraded` | 4xx response, or latency above threshold | Check API keys, rate limits, quota |
| `provider slashed` event / `slashes > 0` | A rejected challenge applied the 10% penalty | Investigate report quality; watch stake; consider rotation |

## Recovery flow

1. **Confirm scope.** Is one adapter down or the whole chain RPC?
   `GET /health` isolates upstreams; `GET /oracle/monitoring/staleness` shows
   which projects are affected.
2. **Fix the ingest path.** Check the `oracle` ingest jobs
   (`npm run ingest`, `npm run monitor`), credentials, and upstream quotas.
3. **Re-run ingestion.** Re-publish the missed report via the API
   (`POST /oracle/reports`) so a fresh verified report resets the staleness
   clock.
4. **Escalate within the challenge window.** A report that stays un-verified
   past the 72-hour challenge window cannot be corrected without a new
   submission.
5. **Rotate or de-activate.** For providers that repeatedly fail, use
   `remove_provider` (admin) or let slashing deactivate them at zero stake.
6. **Verify recovery.** `GET /oracle/monitoring/staleness` should flip
   `isStale` to `false` for the affected projects within the next scheduler
   cycle.
