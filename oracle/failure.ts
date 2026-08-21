/**
 * Failure classification for oracle adapter runs.
 *
 * The scheduler must treat transient failures (network timeouts, 5xx
 * upstream responses — retry next cycle) differently from permanent
 * failures (schema validation errors, missing projects/reports — require
 * human review). Adapters throw typed errors (e.g. `VerraSchemaError`,
 * `SatelliteNoUsableScenesError`), which are matched by name; anything
 * else falls back to message heuristics.
 */

export type FailureKind = 'transient' | 'permanent';

/** Error names that represent a permanent, review-required condition. */
const PERMANENT_ERROR_NAME = /(SchemaError|NotFoundError|NoVerifiedReports|NoUsableScenes|NoSurveys|NoValidReadings|NoSoilCarbonDelta|OracleReportError)/;

/** HTTP status codes that indicate a transient upstream condition. */
const TRANSIENT_STATUS = /(408|429|5\d\d)/;

export function classifyAdapterError(error: unknown): FailureKind {
  if (!(error instanceof Error)) return 'transient';

  if (PERMANENT_ERROR_NAME.test(error.name)) {
    return 'permanent';
  }

  // Generic upstream status failures: 5xx/429/408 are transient, other 4xx
  // are permanent (the request itself is invalid and will keep failing).
  // Match only explicit status references so port numbers (e.g. ":443")
  // in network error messages are not mistaken for status codes.
  const status = error.message.match(/status\s+(\d{3})/i);
  if (status) {
    return TRANSIENT_STATUS.test(status[1]) ? 'transient' : 'permanent';
  }

  // Everything else — network errors, timeouts, unknown exceptions — is
  // transient by default so the next cycle retries rather than dropping
  // the adapter permanently.
  return 'transient';
}

export function isTransientAdapterError(error: unknown): boolean {
  return classifyAdapterError(error) === 'transient';
}
