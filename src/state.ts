import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { type Config } from './config';
import { PROTOCOL_VERSION } from './classifier';

export const stateFiles = (c: Config) => ({ dir: c.stateDir, lock: join(c.stateDir, 'run.lock'), history: join(c.stateDir, 'history.jsonl'), cache: join(c.stateDir, 'cache.json'), status: join(c.stateDir, 'status.json') });
export const ensureStateDir = (c: Config) => mkdir(c.stateDir, { recursive: true, mode: 0o700 });
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
 const tmp = `${file}.${process.pid}.tmp`;
 await writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
 await rename(tmp, file);
}
export async function readJson<T>(file: string): Promise<T | null> {
 try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
}

/** Anything that can change a classification result: taxonomy, rules, naming flags, protocol and helper build. */
export async function configFingerprint(c: Config): Promise<string> {
 const helper = await stat(c.classifier).then(s => `${s.size}:${s.mtimeMs}`, () => 'none');
 return createHash('sha256').update(JSON.stringify([PROTOCOL_VERSION, c.routes, c.naming, c.blocklist, helper])).digest('hex').slice(0, 16);
}
export interface CacheEntry { route: string | null; name: string; tier: 'rule' | 'model' | 'none'; reason: string; needsReview: boolean; renamed: boolean; transient: boolean; held: boolean; at: number }
const TRANSIENT_TTL_MS = 3600 * 1000, MAX_ENTRIES = 5000;
/**
 * Content-hash cache: unchanged files (same sha256 + name + config fingerprint) are not re-classified on every trigger.
 * Transient failures expire after an hour; "held" entries (files restored by `undo`) are skipped until the content or name changes.
 */
export class DecisionCache {
 private dirty = false;
 constructor(private file: string | null, private fp: string, private entries: Record<string, CacheEntry>, private now: () => number = Date.now) {}
 static async load(file: string | null, fp: string, now: () => number = Date.now): Promise<DecisionCache> {
  const raw = file ? await readJson<{ fp: string; entries: Record<string, CacheEntry> }>(file) : null;
  return new DecisionCache(file, fp, raw && raw.fp === fp && raw.entries && typeof raw.entries === 'object' ? raw.entries : {}, now);
 }
 static key(sha256: string, name: string) { return `${sha256}:${name.normalize('NFC')}`; }
 get(sha256: string, name: string): CacheEntry | null {
  const e = this.entries[DecisionCache.key(sha256, name)];
  if (!e) return null;
  if (!e.held && e.transient && this.now() - e.at > TRANSIENT_TTL_MS) return null;
  return e;
 }
 set(sha256: string, name: string, e: Omit<CacheEntry, 'at' | 'held'> & { held?: boolean }) { this.entries[DecisionCache.key(sha256, name)] = { held: false, ...e, at: this.now() }; this.dirty = true; }
 async save() {
  if (!this.file || !this.dirty) return;
  const sorted = Object.entries(this.entries).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
  await writeJsonAtomic(this.file, { fp: this.fp, entries: Object.fromEntries(sorted) });
  this.dirty = false;
 }
}
/** Marks restored content as held so the daemon does not immediately re-sort what the user just undid. */
export async function holdInCache(c: Config, sha256: string, name: string): Promise<void> {
 const f = stateFiles(c);
 const cache = await DecisionCache.load(f.cache, await configFingerprint(c));
 cache.set(sha256, name, { route: null, name, tier: 'none', reason: 'held_after_undo', needsReview: true, renamed: false, transient: false, held: true });
 await cache.save();
}
export interface Status {
 v: 1; time: string; context: 'launchd' | 'interactive'; mode: 'dry-run' | 'apply'; runId: string;
 model: { available: boolean; reason: string } | null;
 inboxReadable: boolean;
 counts: Record<string, number>;
 message?: string;
}
export const writeStatus = async (c: Config, s: Status) => { await ensureStateDir(c); await writeJsonAtomic(stateFiles(c).status, s); };
export const readStatus = (c: Config) => readJson<Status>(stateFiles(c).status);
