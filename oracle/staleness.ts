export const DEFAULT_CADENCE_SECONDS = 365 * 24 * 60 * 60;
export const DEFAULT_GRACE_SECONDS = 30 * 24 * 60 * 60;

const CADENCE_OVERRIDES: Array<{ pattern: RegExp; seconds: number }> = [
  { pattern: /REMOTE.?SENSING|SATELLITE/i, seconds: 90 * 24 * 60 * 60 },
  { pattern: /IOT|SENSOR/i, seconds: 30 * 24 * 60 * 60 },
];

/** Expected reporting cadence for a methodology (seconds between reports). */
export function cadenceForMethodology(methodology: string): number {
  for (const override of CADENCE_OVERRIDES) {
    if (override.pattern.test(methodology)) return override.seconds;
  }
  return DEFAULT_CADENCE_SECONDS;
}

export interface StalenessInput {
  projectId: string;
  provider?: string;
  /** ISO timestamp of the last verified report; omit when never verified. */
  lastVerifiedAt?: string | null;
  /** ISO timestamp used as the baseline when no verified report exists. */
  createdAt: string;
  cadenceSeconds: number;
  graceSeconds?: number;
}

export interface StalenessResult {
  projectId: string;
  provider?: string;
  lastVerifiedAt?: string;
  expectedNextReportAt: string;
  /** Seconds since the last verified report (or project creation). */
  stalenessSeconds: number;
  /** True when the project has exceeded its reporting window + grace. */
  isStale: boolean;
}

function parseTimestampSeconds(value: string, fallback: number): number {
  const parsedMilliseconds = Date.parse(value);
  return Number.isNaN(parsedMilliseconds)
    ? fallback
    : Math.floor(parsedMilliseconds / 1000);
}

/**
 * Compute the staleness metric for one or more projects: seconds elapsed
 * since the last verified report versus the expected reporting window
 * (cadence + grace). A project with no verified report falls back to its
 * creation timestamp as the baseline. The reference timestamp uses Unix
 * seconds to match Soroban's ledger timestamp.
 */
export function computeStaleness(
  inputs: StalenessInput[],
  referenceTimestamp: number = Math.floor(Date.now() / 1000),
): StalenessResult[] {
  return inputs.map((input) => {
    const cadence = input.cadenceSeconds > 0 ? input.cadenceSeconds : DEFAULT_CADENCE_SECONDS;
    const grace = input.graceSeconds && input.graceSeconds > 0
      ? input.graceSeconds
      : DEFAULT_GRACE_SECONDS;

    const baseline = input.lastVerifiedAt
      ? parseTimestampSeconds(input.lastVerifiedAt, referenceTimestamp)
      : parseTimestampSeconds(input.createdAt, referenceTimestamp);

    const expectedNextReportAt = baseline + cadence + grace;
    const stalenessSeconds = Math.max(0, referenceTimestamp - baseline);

    return {
      projectId: input.projectId,
      provider: input.provider,
      lastVerifiedAt: input.lastVerifiedAt
        ? new Date(baseline * 1000).toISOString()
        : undefined,
      expectedNextReportAt: new Date(expectedNextReportAt * 1000).toISOString(),
      stalenessSeconds,
      isStale: referenceTimestamp > expectedNextReportAt,
    };
  });
}
