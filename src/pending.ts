import { type Config } from './config';
import { log } from './log';
import { readJson, writeJsonAtomic } from './state';

/**
 * Files that stay in `_Inbox` for now and are looked at again on a later run: still changing (`unstable`), empty (`empty`, goes to
 * review after a grace period) or waiting for the model (`model`: unavailable, busy, timed out). Persisted so that scan, run, review
 * and status report the same thing, and so the "gave up after N hours" clock survives restarts.
 */
export type PendingKind = 'unstable' | 'empty' | 'model';
/**
 * `since`/`attempts` describe everything we saw (also dry-runs, for reporting). `applySince`/`applyAttempts` count only attempts made in
 * APPLY mode: they alone drive expiry to review, so a daemon that ran in dry-run for days, or a closed laptop, never expires a file.
 */
export interface PendingEntry { kind: PendingKind; reason: string; detail?: string; sha256?: string; since: number; lastSeen: number; attempts: number; next: number; applySince?: number; applyAttempts?: number }
/** A file is only sent to review after at least this many model attempts in apply mode (plus one final attempt in the run that decides it). */
export const MIN_APPLY_ATTEMPTS = 3;
const key = (name: string) => name.normalize('NFC');
const MIN = 60_000;
/** 5, 10, 20, 40, then 60 minutes between model attempts. */
export const backoffMs = (attempts: number) => Math.min(5 * MIN * 2 ** Math.max(0, attempts - 1), 60 * MIN);
/** The single description used by scan, run, review and status. */
export function describePending(e: Pick<PendingEntry, 'kind' | 'reason' | 'detail'>): string {
 return `${e.reason}${e.detail ? `: ${e.detail}` : ''}`;
}
const MAX_ENTRIES = 5000, MAX_TIME = 4e12, MAX_ATTEMPTS = 1_000_000;
/** Strict shape check for one persisted entry (state files are untrusted: a bad entry must be dropped, never wedge or flush a file). */
export function validPendingEntry(name: string, e: unknown): e is PendingEntry {
 if (name.length === 0 || name.length > 1024 || !e || typeof e !== 'object' || Array.isArray(e)) return false;
 const x = e as Record<string, unknown>;
 const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIME;
 const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_ATTEMPTS;
 const optTime = (v: unknown) => v === undefined || time(v), optCount = (v: unknown) => v === undefined || count(v);
 return (x.kind === 'unstable' || x.kind === 'empty' || x.kind === 'model') && typeof x.reason === 'string' && x.reason.length <= 120 && !/[\u0000-\u001f\u007f]/.test(x.reason)
  && (x.detail === undefined || (typeof x.detail === 'string' && x.detail.length <= 400)) && (x.sha256 === undefined || (typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256)))
  && time(x.since) && time(x.lastSeen) && time(x.next) && count(x.attempts) && optTime(x.applySince) && optCount(x.applyAttempts);
}
export class PendingStore {
 private dirty = false;
 private entries: Record<string, PendingEntry>;
 /** Null-prototype map: a file called `__proto__` or `constructor` must be an ordinary key. */
 constructor(private file: string | null, entries: Record<string, PendingEntry>, private now: () => number) { this.entries = Object.assign(Object.create(null), entries); }
 static async load(file: string | null, now: () => number = Date.now): Promise<PendingStore> {
  const raw = file ? await readJson<{ v: 1; entries: Record<string, PendingEntry> }>(file) : null;
  const ok: Record<string, PendingEntry> = Object.create(null); let dropped = 0;
  if (raw && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
   for (const [k, e] of Object.entries(raw.entries)) { if (Object.keys(ok).length < MAX_ENTRIES && validPendingEntry(k, e)) ok[k] = e; else dropped++; }
  } else if (raw) dropped = 1;
  if (dropped) log(`warning: ignored ${dropped} invalid entr${dropped === 1 ? 'y' : 'ies'} in pending.json`);
  const store = new PendingStore(file, ok, now);
  if (dropped) store.dirty = true; // rewrite the file without the bad entries
  return store;
 }
 get(name: string): PendingEntry | undefined { return this.entries[key(name)]; }
 list(): (PendingEntry & { name: string })[] { return Object.entries(this.entries).map(([name, e]) => ({ name, ...e })).sort((a, b) => (a.name < b.name ? -1 : 1)); }
 /** Records that `name` is pending for `reason`. A change of kind or content restarts the clock. */
 touch(name: string, kind: PendingKind, reason: string, o: { detail?: string; sha256?: string; attempt?: boolean; apply?: boolean } = {}): PendingEntry {
  const k = key(name), t = this.now(), old = this.entries[k];
  const same = old && old.kind === kind && old.sha256 === o.sha256;
  const attempts = (same ? old.attempts : 0) + (o.attempt ? 1 : 0);
  const countsForExpiry = !!(o.attempt && o.apply); // dry-runs may report and back off, but never start or advance the expiry clock
  const applyAttempts = (same ? old.applyAttempts ?? 0 : 0) + (countsForExpiry ? 1 : 0);
  const applySince = same ? old.applySince ?? (countsForExpiry ? t : undefined) : countsForExpiry ? t : undefined;
  const e: PendingEntry = { kind, reason, ...(o.detail ? { detail: o.detail } : {}), ...(o.sha256 ? { sha256: o.sha256 } : {}), since: same ? old.since : t, lastSeen: t, attempts, next: o.attempt ? t + backoffMs(attempts) : same ? old.next : t, ...(applySince !== undefined ? { applySince, applyAttempts } : {}) };
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
 /**
  * Old enough to be given up on: `maxDeferHours` since the first APPLY-mode attempt, and at least MIN_APPLY_ATTEMPTS apply-mode attempts.
  * This alone is not a verdict: plan() makes one more attempt and only a transient failure of that attempt sends the file to review.
  */
 expired(e: PendingEntry, config: Pick<Config, 'model'>) { return e.applySince !== undefined && (e.applyAttempts ?? 0) >= MIN_APPLY_ATTEMPTS && this.now() - e.applySince >= config.model.maxDeferHours * 60 * MIN; }
 graceElapsed(e: PendingEntry, config: Pick<Config, 'emptyGraceMinutes'>) { return this.now() - e.since >= config.emptyGraceMinutes * MIN; }
 async save() { if (this.file && this.dirty) { await writeJsonAtomic(this.file, { v: 1, entries: this.entries }); this.dirty = false; } }
}
