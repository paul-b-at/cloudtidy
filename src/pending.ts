import { type Config } from './config';
import { readJson, writeJsonAtomic } from './state';

/**
 * Files that stay in `_Inbox` for now and are looked at again on a later run: still changing (`unstable`), empty (`empty`, goes to
 * review after a grace period) or waiting for the model (`model`: unavailable, busy, timed out). Persisted so that scan, run, review
 * and status report the same thing, and so the "gave up after N hours" clock survives restarts.
 */
export type PendingKind = 'unstable' | 'empty' | 'model';
export interface PendingEntry { kind: PendingKind; reason: string; detail?: string; sha256?: string; since: number; lastSeen: number; attempts: number; next: number }
const key = (name: string) => name.normalize('NFC');
const MIN = 60_000;
/** 5, 10, 20, 40, then 60 minutes between model attempts. */
export const backoffMs = (attempts: number) => Math.min(5 * MIN * 2 ** Math.max(0, attempts - 1), 60 * MIN);
/** The single description used by scan, run, review and status. */
export function describePending(e: Pick<PendingEntry, 'kind' | 'reason' | 'detail'>): string {
 return `${e.reason}${e.detail ? `: ${e.detail}` : ''}`;
}
export class PendingStore {
 private dirty = false;
 constructor(private file: string | null, private entries: Record<string, PendingEntry>, private now: () => number) {}
 static async load(file: string | null, now: () => number = Date.now): Promise<PendingStore> {
  const raw = file ? await readJson<{ v: 1; entries: Record<string, PendingEntry> }>(file) : null;
  return new PendingStore(file, raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : {}, now);
 }
 get(name: string): PendingEntry | undefined { return this.entries[key(name)]; }
 list(): (PendingEntry & { name: string })[] { return Object.entries(this.entries).map(([name, e]) => ({ name, ...e })).sort((a, b) => (a.name < b.name ? -1 : 1)); }
 /** Records that `name` is pending for `reason`. A change of kind or content restarts the clock. */
 touch(name: string, kind: PendingKind, reason: string, o: { detail?: string; sha256?: string; attempt?: boolean } = {}): PendingEntry {
  const k = key(name), t = this.now(), old = this.entries[k];
  const same = old && old.kind === kind && old.sha256 === o.sha256;
  const attempts = (same ? old.attempts : 0) + (o.attempt ? 1 : 0);
  const e: PendingEntry = { kind, reason, ...(o.detail ? { detail: o.detail } : {}), ...(o.sha256 ? { sha256: o.sha256 } : {}), since: same ? old.since : t, lastSeen: t, attempts, next: o.attempt ? t + backoffMs(attempts) : same ? old.next : t };
  this.entries[k] = e; this.dirty = true;
  return e;
 }
 clear(name: string) { if (delete this.entries[key(name)]) this.dirty = true; }
 /** Drops entries for files that are no longer in `_Inbox` (moved, deleted, renamed by the user). */
 retainOnly(names: Iterable<string>) {
  const keep = new Set([...names].map(key));
  for (const k of Object.keys(this.entries)) if (!keep.has(k)) { delete this.entries[k]; this.dirty = true; }
 }
 /** A deferred file is retried when its backoff elapsed, or at once when the model it was waiting for is available again. */
 due(e: PendingEntry, modelAvailable: boolean): boolean { return this.now() >= e.next || (e.reason === 'model_unavailable' && modelAvailable); }
 expired(e: PendingEntry, config: Pick<Config, 'model'>) { return this.now() - e.since >= config.model.maxDeferHours * 60 * MIN; }
 graceElapsed(e: PendingEntry, config: Pick<Config, 'emptyGraceMinutes'>) { return this.now() - e.since >= config.emptyGraceMinutes * MIN; }
 async save() { if (this.file && this.dirty) { await writeJsonAtomic(this.file, { v: 1, entries: this.entries }); this.dirty = false; } }
}
