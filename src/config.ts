import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Route {
 id: string;
 folder: string;
 description: string;
 /** Invoice/contract style `YYYY-MM-DD_Sender-DocType.ext` renaming (only after deterministic validation). */
 rename: boolean;
 /** Document type label used in standardized names (required when `rename` is true). */
 docType?: string;
 /** Tier-1 regular expressions (case-insensitive, unicode), matched as whole words (see routePatterns). Exactly one matching route is "definite" and final. */
 patterns: string[];
}
/** A sender recognised deterministically in invoice/contract text (no model call). `aliases` are other spellings of the same organisation. */
export interface KnownSender { name: string; aliases: string[] }
export interface Config {
 version: 1;
 root: string;
 classifier: string;
 ocr: string;
 timeoutMs: number;
 routes: Route[];
 /** Extra app-container names; added to the built-in blocklist, never replacing it. */
 blocklist: string[];
 stateDir: string;
 logDir: string;
 /** Stability debounce: size+mtime must be unchanged across this interval. */
 debounceMs: number;
 /** Extra debounce rounds for files still changing after the shared debounce (default 0: they are reported as pending and retried on the next trigger). */
 stabilityRetries: number;
 /** An empty file unchanged for this long is sent to review (until then it is pending). */
 emptyGraceMinutes: number;
 /** Extra model attempts after a transient helper failure (timeout/unavailable/crash). */
 classifierRetries: number;
 /** How long `run`/`sweep`/`undo` wait for another cloudtidy process before giving up. */
 lockWaitMs: number;
 naming: { datePrefix: boolean };
 daemon: { apply: boolean; notify: boolean; intervalSec: number };
 /** Files that need the model while it is unavailable/busy stay pending in `_Inbox` for this long, then go to review. */
 model: { maxDeferHours: number };
 knownSenders: KnownSender[];
 /** Apply modes (run --apply, daemon apply, sweep --apply, init) refuse when `root` is not iCloud Drive unless this is true (test fixtures, deliberate non-iCloud use). */
 allowNonICloudRoot: boolean;
}

export const INBOX = '_Inbox';
export const REVIEW = 'Needs_Review';
export const ARCHIVE = '_Archiv';
/** Native app containers + archive. Config can add names; it cannot remove these. */
export const BUILTIN_BLOCKLIST = [ARCHIVE, 'Pages', 'Keynote', 'Numbers', 'Obsidian', 'Goodnotes', 'Shortcuts', 'Preview', 'TextEdit', 'Automator', 'Script Editor', 'QuickTime Player', 'Scriptable'];
const buckets = new Set(['01_Uni', '02_Admin & Finanzen', '03_Projekte & Dev', '04_Persönlich']);
const RENAME_FOLDERS = ['02_Admin & Finanzen/Rechnungen', '02_Admin & Finanzen/Verträge'];
const TOP_KEYS = new Set(['version', 'root', 'classifier', 'ocr', 'timeoutMs', 'routes', 'blocklist', 'stateDir', 'logDir', 'debounceMs', 'stabilityRetries', 'classifierRetries', 'lockWaitMs', 'naming', 'daemon', 'model', 'knownSenders', 'allowNonICloudRoot', 'emptyGraceMinutes']);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
/** Filename/segment safety: no separators, control/C1/bidi-override/zero-width-space/line-separator chars, leading dot, edge whitespace. ZWJ/ZWNJ/LRM/RLM stay legal (emoji, Persian). */
export function safeName(x: unknown): x is string {
 return typeof x === 'string' && x.length > 0 && x.length <= 160 && x === x.trim() && !x.startsWith('.') && x !== '..' && !/[\\/:\x00-\x1f\x7f-\x9f\u200b\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/.test(x);
}
function intIn(x: unknown, def: number, min: number, max: number, what: string): number {
 if (x === undefined) return def;
 if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) throw Error(`Invalid configuration: ${what}`);
 return x;
}
function bool(x: unknown, def: boolean, what: string): boolean {
 if (x === undefined) return def;
 if (typeof x !== 'boolean') throw Error(`Invalid configuration: ${what}`);
 return x;
}
const SENDER_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .&'\-]{0,59}$/u;
function parseSenders(x: unknown): KnownSender[] {
 if (x === undefined) return [];
 if (!Array.isArray(x) || x.length > 200) throw Error('Invalid configuration: knownSenders');
 return x.map(v => {
  if (!record(v) || typeof v.name !== 'string' || !SENDER_LABEL.test(v.name) || v.name.length < 2) throw Error('Invalid configuration: knownSenders name');
  for (const k of Object.keys(v)) if (k !== 'name' && k !== 'aliases') throw Error(`Invalid configuration: unknown knownSenders key "${k}"`);
  const aliases = v.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 8 || !aliases.every(a => typeof a === 'string' && SENDER_LABEL.test(a) && a.length >= 2)) throw Error('Invalid configuration: knownSenders aliases');
  return { name: v.name, aliases: aliases as string[] };
 });
}
export function validateConfig(x: unknown): Config {
 if (!record(x) || x.version !== 1 || typeof x.root !== 'string' || !x.root || typeof x.classifier !== 'string' || !x.classifier || typeof x.ocr !== 'string' || !x.ocr || !Number.isInteger(x.timeoutMs) || Number(x.timeoutMs) < 100 || Number(x.timeoutMs) > 120000 || !Array.isArray(x.routes) || !x.routes.length || x.routes.length > 32) throw Error('Invalid configuration');
 for (const k of Object.keys(x)) if (!TOP_KEYS.has(k)) throw Error(`Invalid configuration: unknown key "${k}"`);
 const ids = new Set<string>(), folders = new Set<string>(), routes: Route[] = [];
 for (const v of x.routes) {
  if (!record(v) || typeof v.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.id) || v.id === 'review' || ids.has(v.id) || typeof v.folder !== 'string' || isAbsolute(v.folder) || !buckets.has(v.folder.split('/')[0]!) || !v.folder.split('/').every(s => safeName(s) && !s.includes('~')) || folders.has(v.folder.normalize('NFC')) || typeof v.description !== 'string' || !v.description.length || v.description.length > 240 || typeof v.rename !== 'boolean') throw Error('Invalid route');
  if (v.rename && !RENAME_FOLDERS.includes(v.folder)) throw Error('Renaming is restricted to invoices/contracts');
  if (v.rename && (typeof v.docType !== 'string' || !/^[\p{L}][\p{L}\p{N}-]{0,30}$/u.test(v.docType))) throw Error('Invalid route: docType required for renaming routes');
  if (!v.rename && v.docType !== undefined) throw Error('Invalid route: docType only applies to renaming routes');
  const patterns = v.patterns ?? [];
  if (!Array.isArray(patterns) || patterns.length > 16) throw Error('Invalid route patterns');
  for (const p of patterns) { if (typeof p !== 'string' || !p || p.length > 400) throw Error('Invalid route patterns'); try { new RegExp(wholeWord(p), 'iu'); } catch { throw Error('Invalid route pattern'); } }
  ids.add(v.id); folders.add(v.folder.normalize('NFC'));
  routes.push({ id: v.id, folder: v.folder, description: v.description, rename: v.rename, ...(v.rename ? { docType: v.docType as string } : {}), patterns: patterns as string[] });
 }
 const blocklist = x.blocklist ?? [];
 if (!Array.isArray(blocklist) || blocklist.length > 64 || !blocklist.every(safeName)) throw Error('Invalid configuration: blocklist');
 const naming = x.naming ?? {}, daemon = x.daemon ?? {}, model = x.model ?? {};
 if (!record(naming) || !record(daemon) || !record(model)) throw Error('Invalid configuration');
 for (const k of Object.keys(model)) if (k !== 'maxDeferHours') throw Error(`Invalid configuration: unknown model key "${k}"`);
 const knownSenders = parseSenders(x.knownSenders);
 for (const k of Object.keys(naming)) if (k !== 'datePrefix') throw Error(`Invalid configuration: unknown naming key "${k}"`);
 for (const k of Object.keys(daemon)) if (!['apply', 'notify', 'intervalSec'].includes(k)) throw Error(`Invalid configuration: unknown daemon key "${k}"`);
 const stateDir = x.stateDir ?? '~/Library/Application Support/cloudtidy', logDir = x.logDir ?? '~/Library/Logs/cloudtidy';
 if (typeof stateDir !== 'string' || !stateDir || typeof logDir !== 'string' || !logDir) throw Error('Invalid configuration: stateDir/logDir');
 return {
  version: 1, root: x.root, classifier: x.classifier, ocr: x.ocr, timeoutMs: x.timeoutMs as number, routes,
  blocklist: blocklist as string[], stateDir, logDir,
  debounceMs: intIn(x.debounceMs, 3000, 0, 60000, 'debounceMs'),
  stabilityRetries: intIn(x.stabilityRetries, 0, 0, 3, 'stabilityRetries'),
  emptyGraceMinutes: intIn(x.emptyGraceMinutes, 10, 0, 1440, 'emptyGraceMinutes'),
  classifierRetries: intIn(x.classifierRetries, 1, 0, 3, 'classifierRetries'),
  lockWaitMs: intIn(x.lockWaitMs, 30000, 0, 300000, 'lockWaitMs'),
  naming: { datePrefix: bool(naming.datePrefix, false, 'naming.datePrefix') },
  daemon: { apply: bool(daemon.apply, false, 'daemon.apply'), notify: bool(daemon.notify, true, 'daemon.notify'), intervalSec: intIn(daemon.intervalSec, 600, 60, 86400, 'daemon.intervalSec') },
  model: { maxDeferHours: intIn(model.maxDeferHours, 24, 1, 720, 'model.maxDeferHours') },
  knownSenders, allowNonICloudRoot: bool(x.allowNonICloudRoot, false, 'allowNonICloudRoot')
 };
}
export const expandHome = (s: string, base = process.cwd()) => s === '~' ? homedir() : s.startsWith('~/') ? resolve(homedir(), s.slice(2)) : resolve(base, s);
export function resolvePaths(c: Config): Config {
 return { ...c, root: expandHome(c.root), classifier: expandHome(c.classifier, repoRoot), ocr: expandHome(c.ocr, repoRoot), stateDir: expandHome(c.stateDir), logDir: expandHome(c.logDir) };
}
export const defaultConfigPath = resolve(repoRoot, 'config/default.config.json');
export async function loadConfig(file = defaultConfigPath): Promise<Config> {
 return resolvePaths(validateConfig(JSON.parse(await readFile(file, 'utf8'))));
}
/**
 * Tier-1 patterns match whole words only: no letter or digit may touch either end of the match (Unicode-aware, so "ü" counts as a
 * letter, unlike \\b). `_`, `-`, `.` and spaces separate words, so `JKU_notes.txt` still matches `JKU`. German compounds that should match
 * are spelled out in the pattern (e.g. `Rechnung(?:s\\p{L}*)?`).
 */
export const wholeWord = (p: string) => `(?<![\\p{L}\\p{N}])(?:${p})(?![\\p{L}\\p{N}])`;
const compiled = new WeakMap<Route, RegExp[]>();
export function routePatterns(route: Route): RegExp[] {
 let r = compiled.get(route);
 if (!r) { r = route.patterns.map(p => new RegExp(wholeWord(p), 'iu')); compiled.set(route, r); }
 return r;
}
