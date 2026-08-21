import * as fs from 'fs';
import * as path from 'path';
import { FailureKind } from './failure';

/**
 * Bounded dead-letter store for failed adapter runs.
 *
 * Failed runs are appended as JSON lines to a file so operators can review
 * them. Every append prunes the store back to at most `maxEntries` records,
 * dropping records older than `maxAgeMs`, so a degraded environment can
 * never grow the file unboundedly. Records are identified by `id` so the
 * same failure is not recorded twice in a single cycle.
 */

export interface DeadLetterRecord {
  /** Unique id, e.g. `<adapter>:<projectId>:<periodStart>`; deduped on append. */
  id: string;
  adapter: string;
  kind: FailureKind;
  error: string;
  failedAt: string;
  projectId?: string;
  period?: string;
}

export interface DeadLetterOptions {
  filePath?: string;
  maxEntries?: number;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class DeadLetterStore {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: DeadLetterOptions = {}) {
    this.filePath =
      options.filePath ??
      process.env.ORACLE_DEAD_LETTER_FILE ??
      path.join(process.cwd(), '.oracle-dead-letter.jsonl');
    this.maxEntries =
      options.maxEntries ??
      envPositiveInt('ORACLE_DEAD_LETTER_MAX_ENTRIES', DEFAULT_MAX_ENTRIES);
    this.maxAgeMs =
      options.maxAgeMs ??
      envPositiveInt('ORACLE_DEAD_LETTER_TTL_MS', DEFAULT_MAX_AGE_MS);
    this.now = options.now ?? Date.now;
  }

  get path(): string {
    return this.filePath;
  }

  /** Append a failed run to the store, deduplicating by id, then prune. */
  record(entry: DeadLetterRecord): void {
    const existing = this.read();
    if (existing.some((record) => record.id === entry.id)) {
      return;
    }
    existing.push(entry);
    this.write(this.prune(existing));
  }

  /** All stored records, newest first, within the bound. */
  list(): DeadLetterRecord[] {
    return this.prune(this.read()).reverse();
  }

  count(): number {
    return this.list().length;
  }

  private read(): DeadLetterRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    const records: DeadLetterRecord[] = [];
    for (const line of fs.readFileSync(this.filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as DeadLetterRecord);
      } catch {
        // Skip corrupt lines rather than losing the whole store.
      }
    }
    return records;
  }

  private prune(records: DeadLetterRecord[]): DeadLetterRecord[] {
    const cutoff = this.now() - this.maxAgeMs;
    const fresh = records.filter((record) => {
      const failedAt = new Date(record.failedAt).getTime();
      return Number.isFinite(failedAt) && failedAt >= cutoff;
    });
    return fresh.slice(-this.maxEntries);
  }

  private write(records: DeadLetterRecord[]): void {
    const dir = path.dirname(this.filePath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content = records.map((record) => JSON.stringify(record)).join('\n');
    fs.writeFileSync(this.filePath, content ? `${content}\n` : '');
  }
}
