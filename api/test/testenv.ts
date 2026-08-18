/**
 * testenv.ts — shared test-environment helpers for e2e suites
 *
 * Problems solved
 * ---------------
 * 1. Placeholder keys (S...) from .env.example produce cryptic tx_failed
 *    errors when tests run against a live testnet. We validate the format
 *    up-front and skip rather than fail with a misleading error.
 *
 * 2. Some e2e suites only call read-only endpoints (GET /bonds, etc.) and
 *    do not need signing keys at all. We expose granular flags and a
 *    describe-wrapper so those suites run regardless of key configuration.
 *
 * 3. A correctly formatted key that has never been funded also produces
 *    tx_failed. We cannot verify funding at import time, but the skip
 *    message directs contributors to Friendbot so they know what to do.
 *
 * Stellar secret-key format
 * -------------------------
 * StrKey S-encoded Ed25519 seed:
 *   - Starts with 'S'
 *   - 56 characters total (base32, uppercase, no padding)
 *   - Checksum validated by the SDK's StrKey.isValidEd25519SecretSeed()
 *
 * We intentionally use the SDK validator rather than a hand-rolled regex so
 * that near-valid keys (right length, wrong checksum) are also rejected.
 *
 * Jest skip registration timing
 * ------------------------------
 * `test.skip` and `describe.skip` must be called synchronously at
 * describe-collection time, not inside a `beforeAll` callback. Jest's
 * circus runner raises "Cannot add a test after tests have started running"
 * if you try to register a test inside `beforeAll`. The correct pattern is:
 *
 *   const run = hasAdminKey ? describe : describe.skip;
 *   run('my suite', () => { ... });
 *
 * The `describeIf` helpers below encapsulate this idiom.
 */

import { StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

/**
 * Returns true only when `value` is a fully valid Stellar secret seed
 * (starts with 'S', 56 chars, correct base32 checksum).
 *
 * Uses the SDK's StrKey validator, not a regex, so near-valid keys
 * (correct length but wrong checksum) are also caught.
 */
export function isValidStellarSecretKey(value: string | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  try {
    return StrKey.isValidEd25519SecretSeed(value);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Environment probes
// ---------------------------------------------------------------------------

/**
 * True when ADMIN_SECRET_KEY is a valid Stellar secret seed.
 * Required by admin-level signing tests.
 */
export const hasAdminKey = isValidStellarSecretKey(process.env.ADMIN_SECRET_KEY);

/**
 * True when INVESTOR_SECRET_KEY is a valid Stellar secret seed.
 * Required by investor subscription / transfer signing tests.
 */
export const hasInvestorKey = isValidStellarSecretKey(process.env.INVESTOR_SECRET_KEY);

/**
 * True when USER_SECRET_KEY is a valid Stellar secret seed.
 * Required by user-level signing tests.
 */
export const hasUserKey = isValidStellarSecretKey(process.env.USER_SECRET_KEY);

/**
 * True when ALL three signer keys are present and valid.
 * Use this for suites that exercise the full bond lifecycle.
 */
export const hasAllSigningKeys = hasAdminKey && hasInvestorKey && hasUserKey;

// ---------------------------------------------------------------------------
// Skip-reason helpers (for logging)
// ---------------------------------------------------------------------------

const FUNDING_NOTE =
  'Fund test accounts at https://friendbot.stellar.org/?addr=<PUBLIC_KEY>';

function missingKeyReason(envVar: string): string {
  const raw = process.env[envVar];
  if (!raw || raw === 'S...') {
    return `${envVar} is not set (placeholder value in .env.example).`;
  }
  return `${envVar} is set but is not a valid Stellar secret seed (got: "${raw.slice(0, 4)}...").`;
}

function warnSkip(reasons: string[]): void {
  console.warn(
    `[e2e] Skipping signing suite — ${reasons.join('; ')}\n` +
    `       Set real keys in api/.env and re-run.\n` +
    `       ${FUNDING_NOTE}`,
  );
}

// ---------------------------------------------------------------------------
// describe-wrapper helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a `describe` block so that the entire suite runs only when
 * ADMIN_SECRET_KEY is a valid Stellar secret seed. When the key is absent
 * or placeholder, the suite is marked as `describe.skip` with a logged
 * explanation.
 *
 * Must be called at module scope (not inside `beforeAll`) because Jest
 * registers `describe.skip` synchronously during test collection.
 *
 * @example
 * describeWithAdminKey('admin flow (e2e)', () => {
 *   it('issues a bond', async () => { ... });
 * });
 */
export function describeWithAdminKey(
  name: string,
  fn: () => void,
): void {
  if (hasAdminKey) {
    describe(name, fn);
  } else {
    warnSkip([missingKeyReason('ADMIN_SECRET_KEY')]);
    describe.skip(name, fn);
  }
}

/**
 * Wraps a `describe` block so that the suite runs only when
 * INVESTOR_SECRET_KEY is a valid Stellar secret seed.
 */
export function describeWithInvestorKey(
  name: string,
  fn: () => void,
): void {
  if (hasInvestorKey) {
    describe(name, fn);
  } else {
    warnSkip([missingKeyReason('INVESTOR_SECRET_KEY')]);
    describe.skip(name, fn);
  }
}

/**
 * Wraps a `describe` block so that the suite runs only when all three
 * signer keys (ADMIN_SECRET_KEY, INVESTOR_SECRET_KEY, USER_SECRET_KEY)
 * are valid Stellar secret seeds.
 *
 * Use this for full bond-lifecycle flows that require every role.
 */
export function describeWithAllSigningKeys(
  name: string,
  fn: () => void,
): void {
  if (hasAllSigningKeys) {
    describe(name, fn);
  } else {
    const missing: string[] = [];
    if (!hasAdminKey) missing.push('ADMIN_SECRET_KEY');
    if (!hasInvestorKey) missing.push('INVESTOR_SECRET_KEY');
    if (!hasUserKey) missing.push('USER_SECRET_KEY');
    warnSkip(missing.map(missingKeyReason));
    describe.skip(name, fn);
  }
}
