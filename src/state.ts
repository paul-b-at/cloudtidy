import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { type Config } from './config';
import { PROTOCOL_VERSION } from './classifier';
import { log } from './log';

export const stateFiles = (c: Config) => ({ dir: c.stateDir, lock: join(c.stateDir, 'run.lock'), history: join(c.stateDir, 'history.jsonl'), cache: join(c.stateDir, 'cache.json'), held: join(c.stateDir, 'held.json'), pending: join(c.stateDir, 'pending.json'), status: join(c.stateDir, 'status.json') });
export const ensureStateDir = (c: Config) => mkdir(c.stateDir, { recursive: true, mode: 0o700 });
/** Log directory holds personal file names: owner-only, even if it already existed with looser permissions. */
export async function ensureLogDir(c: Config): Promise<void> { await mkdir(c.logDir, { recursive: true, mode: 0o700 }); await chmod(c.logDir, 0o700).catch(() => {}); }
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
 const helper = await stat(c.classifier).then(s => `${s.size}:${s.mtimeMs}`, () => 'none'), ocr = await stat(c.ocr).then(s => `${s.size}:${s.mtimeMs}`, () => 'none');
 return createHash('sha256').update(JSON.stringify([PROTOCOL_VERSION, c.routes, c.naming, c.blocklist, c.knownSenders, helper, ocr])).digest('hex').slice(0, 16);
}
export interface CacheEntry { route: string | null; name: string; tier: 'rule' | 'model' | 'none'; reason: string; needsReview: boolean; renamed: boolean; note?: string; at: number }
const MAX_ENTRIES = 5000, MAX_HELD = 20000;
const validCacheEntry = (e: unknown): e is CacheEntry => {
 if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
 const x = e as Record<string, unknown>;
 return (x.route === null || typeof x.route === 'string') && typeof x.name === 'string' && x.name.length > 0 && x.name.length <= 255 && (x.tier === 'rule' || x.tier === 'model' || x.tier === 'none')
  && typeof x.reason === 'string' && x.reason.length <= 120 && typeof x.needsReview === 'boolean' && typeof x.renamed === 'boolean' && (x.note === undefined || typeof x.note === 'string') && typeof x.at === 'number' && Number.isFinite(x.at);
};
/**
 * Content-hash cache: unchanged files (same sha256 + name + config fingerprint) are not re-classified on every trigger.
 * Only definitive decisions are cached; transient failures are tracked by the pending store instead. Least-recently-written entries
 * are evicted beyond 5000; nothing that must survive (undo holds) lives here.
 */
export class DecisionCache {
 private dirty = false;
 private entries: Record<string, CacheEntry>;
 constructor(private file: string | null, private fp: string, entries: Record<string, CacheEntry>) { this.entries = Object.assign(Object.create(null), entries); }
 static async load(file: string | null, fp: string): Promise<DecisionCache> {
  const raw = file ? await readJson<{ fp: string; entries: Record<string, CacheEntry> }>(file) : null;
  const ok: Record<string, CacheEntry> = Object.create(null);
  if (raw && raw.fp === fp && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
   for (const [k, e] of Object.entries(raw.entries)) if (Object.keys(ok).length < MAX_ENTRIES && validCacheEntry(e)) ok[k] = e; // a damaged entry is simply re-classified
  }
  return new DecisionCache(file, fp, ok);
 }
 static key(sha256: string, name: string) { return `${sha256}:${name.normalize('NFC')}`; }
 get(sha256: string, name: string): CacheEntry | null { return this.entries[DecisionCache.key(sha256, name)] ?? null; }
 set(sha256: string, name: string, e: Omit<CacheEntry, 'at'>) { this.entries[DecisionCache.key(sha256, name)] = { ...e, at: Date.now() }; this.dirty = true; }
 async save() {
  if (!this.file || !this.dirty) return;
  const sorted = Object.entries(this.entries).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
  await writeJsonAtomic(this.file, { fp: this.fp, entries: Object.fromEntries(sorted) });
  this.dirty = false;
 }
}
/**
 * Files the user just restored with `undo`: the daemon must not re-sort them. Stored separately from the decision cache so a config
 * change (new fingerprint) or cache eviction can never release them. Keyed by content hash + NFC name; released by `run --no-cache`.
 */
export class HeldStore {
 private dirty = false;
 private entries: Record<string, { at: number }>;
 /** Null-prototype map; every persisted entry is validated (a bad one is dropped with a warning, it can never wedge or release anything else). */
 constructor(private file: string | null, entries: Record<string, { at: number }>) { this.entries = Object.assign(Object.create(null), entries); }
 static async load(file: string | null): Promise<HeldStore> {
  const raw = file ? await readJson<{ v: 1; entries: Record<string, { at: number }> }>(file) : null;
  const ok: Record<string, { at: number }> = Object.create(null); let dropped = 0;
  if (raw && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
   for (const [k, e] of Object.entries(raw.entries)) {
    if (Object.keys(ok).length < MAX_HELD && /^[0-9a-f]{64}:.{1,1024}$/su.test(k) && e && typeof e === 'object' && !Array.isArray(e) && typeof e.at === 'number' && Number.isFinite(e.at) && e.at >= 0 && e.at <= 4e12) ok[k] = { at: e.at };
    else dropped++;
   }
  } else if (raw) dropped = 1;
  if (dropped) log(`warning: ignored ${dropped} invalid entr${dropped === 1 ? 'y' : 'ies'} in held.json`);
  const store = new HeldStore(file, ok);
  if (dropped) store.dirty = true;
  return store;
 }
 has(sha256: string, name: string) { return DecisionCache.key(sha256, name) in this.entries; }
 add(sha256: string, name: string) { this.entries[DecisionCache.key(sha256, name)] = { at: Date.now() }; this.dirty = true; }
 release(sha256: string, name: string) { if (delete this.entries[DecisionCache.key(sha256, name)]) this.dirty = true; }
 get size() { return Object.keys(this.entries).length; }
 async save() { if (this.file && this.dirty) { await writeJsonAtomic(this.file, { v: 1, entries: this.entries }); this.dirty = false; } }
}
/** Marks restored content as held so the daemon does not immediately re-sort what the user just undid. */
export async function holdInCache(c: Config, sha256: string, name: string): Promise<void> {
  const held = (await ensureStateDir(c), await HeldStore.load(stateFiles(c).held));
 held.add(sha256, name);
 await held.save();
}
export interface Status {
 v: 1; time: string; context: 'launchd' | 'interactive'; mode: 'dry-run' | 'apply'; runId: string;
 model: { available: boolean; reason: string } | null;
 inboxReadable: boolean;
 counts: Record<string, number>;
 message?: string;
 /** Did this run stop because of `maxRunSeconds`? `streak` = consecutive recorded runs that did (a daemon that always hits it is flagged by status/doctor). */
 budget?: { hit: boolean; left: number; streak: number };
}
export const writeStatus = async (c: Config, s: Status) => { await ensureStateDir(c); await writeJsonAtomic(stateFiles(c).status, s); };
export const readStatus = (c: Config) => readJson<Status>(stateFiles(c).status);
