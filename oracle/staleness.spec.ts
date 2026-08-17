import { computeStaleness, cadenceForMethodology, DEFAULT_GRACE_SECONDS } from './staleness';

const REFERENCE_TIMESTAMP = Math.floor(Date.UTC(2200, 0, 1, 0, 0, 0) / 1000);
const DAY_SECONDS = 24 * 60 * 60;
const CADENCE_GRACE_SECONDS = 365 * DAY_SECONDS + DEFAULT_GRACE_SECONDS;

function toIso(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

describe('computeStaleness', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks a project stale after the reporting window plus grace elapses', () => {
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-1234',
          createdAt: toIso(REFERENCE_TIMESTAMP - 2 * CADENCE_GRACE_SECONDS),
          lastVerifiedAt: toIso(
            REFERENCE_TIMESTAMP - CADENCE_GRACE_SECONDS - DAY_SECONDS,
          ),
          cadenceSeconds: 365 * DAY_SECONDS,
        },
      ],
      REFERENCE_TIMESTAMP,
    );

    expect(results[0].isStale).toBe(true);
    expect(results[0].stalenessSeconds).toBe(CADENCE_GRACE_SECONDS + DAY_SECONDS);
  });

  it('keeps a project healthy inside the window', () => {
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-1234',
          createdAt: toIso(REFERENCE_TIMESTAMP - 2 * CADENCE_GRACE_SECONDS),
          lastVerifiedAt: toIso(REFERENCE_TIMESTAMP - DAY_SECONDS),
          cadenceSeconds: 365 * DAY_SECONDS,
        },
      ],
      REFERENCE_TIMESTAMP,
    );

    expect(results[0].isStale).toBe(false);
    expect(results[0].lastVerifiedAt).toBe(toIso(REFERENCE_TIMESTAMP - DAY_SECONDS));
  });

  it('falls back to the project creation date when never verified', () => {
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-9999',
          createdAt: toIso(
            REFERENCE_TIMESTAMP - CADENCE_GRACE_SECONDS - DAY_SECONDS,
          ),
          cadenceSeconds: 365 * DAY_SECONDS,
        },
      ],
      REFERENCE_TIMESTAMP,
    );

    expect(results[0].isStale).toBe(true);
    expect(results[0].lastVerifiedAt).toBeUndefined();
  });

  it('respects a custom grace period', () => {
    const graceSeconds = 7 * DAY_SECONDS;
    const results = computeStaleness(
      [
        {
          projectId: 'VCS-1234',
          createdAt: toIso(REFERENCE_TIMESTAMP - 400 * DAY_SECONDS),
          lastVerifiedAt: toIso(
            REFERENCE_TIMESTAMP - (365 + 7) * DAY_SECONDS - DAY_SECONDS,
          ),
          cadenceSeconds: 365 * DAY_SECONDS,
          graceSeconds,
        },
      ],
      REFERENCE_TIMESTAMP,
    );

    expect(results[0].isStale).toBe(true);
  });

  it('converts the wall clock fallback from milliseconds to seconds', () => {
    jest.spyOn(Date, 'now').mockReturnValue(REFERENCE_TIMESTAMP * 1000);

    const results = computeStaleness([
      {
        projectId: 'VCS-1234',
        createdAt: toIso(REFERENCE_TIMESTAMP - DAY_SECONDS),
        cadenceSeconds: 365 * DAY_SECONDS,
      },
    ]);

    expect(results[0].stalenessSeconds).toBe(DAY_SECONDS);
    expect(results[0].isStale).toBe(false);
  });
});

describe('cadenceForMethodology', () => {
  it('uses an annual cadence by default', () => {
    expect(cadenceForMethodology('VERRA-VCS')).toBe(365 * 24 * 60 * 60);
  });

  it('uses quarterly cadence for remote sensing', () => {
    expect(cadenceForMethodology('REMOTE-SENSING')).toBe(90 * 24 * 60 * 60);
  });

  it('uses monthly cadence for IoT sensors', () => {
    expect(cadenceForMethodology('IOT-SENSORS')).toBe(30 * 24 * 60 * 60);
  });
});
