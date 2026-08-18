import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeadLetterStore, DeadLetterRecord } from './dead-letter';

function record(id: string, ageMs = 0, kind: 'transient' | 'permanent' = 'transient'): DeadLetterRecord {
  return {
    id,
    adapter: 'verra',
    kind,
    error: 'boom',
    failedAt: new Date(Date.now() - ageMs).toISOString(),
    projectId: 'VCS-1',
    period: '2025-01-01..2025-03-31',
  };
}

describe('DeadLetterStore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-letter-'));
  let seq = 0;

  function freshStore(overrides: Partial<{ maxEntries: number; maxAgeMs: number; now: () => number }> = {}) {
    seq += 1;
    return new DeadLetterStore({
      filePath: path.join(dir, `dead-letter-${seq}.jsonl`),
      maxEntries: 100,
      maxAgeMs: 60_000,
      ...overrides,
    });
  }

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records failures as JSON lines and lists them newest first', () => {
    const store = freshStore();
    store.record(record('a'));
    store.record(record('b'));

    const records = store.list();
    expect(records.map((r) => r.id)).toEqual(['b', 'a']);
    expect(store.count()).toBe(2);
  });

  it('deduplicates by id within a cycle', () => {
    const store = freshStore();
    store.record(record('a'));
    store.record(record('a'));

    expect(store.count()).toBe(1);
  });

  it('bounds the store by max entries (oldest dropped first)', () => {
    const store = freshStore({ maxEntries: 2 });
    store.record(record('a', 3_000));
    store.record(record('b', 2_000));
    store.record(record('c', 1_000));

    expect(store.list().map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('drops records older than the TTL', () => {
    const now = Date.now();
    const store = freshStore({ maxAgeMs: 60_000, now: () => now });
    store.record(record('old', 120_000));
    store.record(record('fresh', 1_000));

    expect(store.list().map((r) => r.id)).toEqual(['fresh']);
  });

  it('survives corrupt lines without losing the rest of the store', () => {
    const store = freshStore();
    store.record(record('a'));
    fs.appendFileSync(store.path, 'not-json\n');
    store.record(record('b'));

    expect(store.list().map((r) => r.id)).toEqual(['b', 'a']);
  });
});
