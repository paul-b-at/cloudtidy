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
 /** Tier-1 regular expressions (case-insensitive, unicode). Exactly one matching route is "definite". */
 patterns: string[];
}
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
 /** Extra debounce rounds before an unstable file is skipped until the next trigger. */
 stabilityRetries: number;
 /** Extra model attempts after a transient helper failure (timeout/unavailable/crash). */
 classifierRetries: number;
 /** How long `run`/`sweep`/`undo` wait for another cloudtidy process before giving up. */
 lockWaitMs: number;
 naming: { datePrefix: boolean };
 daemon: { apply: boolean; notify: boolean; intervalSec: number };
}

export const INBOX = '_Inbox';
export const REVIEW = 'Needs_Review';
export const ARCHIVE = '_Archiv';
/** Native app containers + archive. Config can add names; it cannot remove these. */
export const BUILTIN_BLOCKLIST = [ARCHIVE, 'Pages', 'Keynote', 'Numbers', 'Obsidian', 'Goodnotes', 'Shortcuts', 'Preview', 'TextEdit', 'Automator', 'Script Editor', 'QuickTime Player', 'Scriptable'];
const buckets = new Set(['01_Uni', '02_Admin & Finanzen', '03_Projekte & Dev', '04_Persönlich']);
const RENAME_FOLDERS = ['02_Admin & Finanzen/Rechnungen', '02_Admin & Finanzen/Verträge'];
const TOP_KEYS = new Set(['version', 'root', 'classifier', 'ocr', 'timeoutMs', 'routes', 'blocklist', 'stateDir', 'logDir', 'debounceMs', 'stabilityRetries', 'classifierRetries', 'lockWaitMs', 'naming', 'daemon']);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
/** Filename/segment safety: no separators, control chars, leading dot, edge whitespace. */
export function safeName(x: unknown): x is string {
 return typeof x === 'string' && x.length > 0 && x.length <= 160 && x === x.trim() && !x.startsWith('.') && x !== '..' && !/[\\/:\x00-\x1f\x7f]/.test(x);
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
  for (const p of patterns) { if (typeof p !== 'string' || !p || p.length > 300) throw Error('Invalid route patterns'); try { new RegExp(p, 'iu'); } catch { throw Error('Invalid route pattern'); } }
  ids.add(v.id); folders.add(v.folder.normalize('NFC'));
  routes.push({ id: v.id, folder: v.folder, description: v.description, rename: v.rename, ...(v.rename ? { docType: v.docType as string } : {}), patterns: patterns as string[] });
 }
 const blocklist = x.blocklist ?? [];
 if (!Array.isArray(blocklist) || blocklist.length > 64 || !blocklist.every(safeName)) throw Error('Invalid configuration: blocklist');
 const naming = x.naming ?? {}, daemon = x.daemon ?? {};
 if (!record(naming) || !record(daemon)) throw Error('Invalid configuration');
 for (const k of Object.keys(naming)) if (k !== 'datePrefix') throw Error(`Invalid configuration: unknown naming key "${k}"`);
 for (const k of Object.keys(daemon)) if (!['apply', 'notify', 'intervalSec'].includes(k)) throw Error(`Invalid configuration: unknown daemon key "${k}"`);
 const stateDir = x.stateDir ?? '~/Library/Application Support/cloudtidy', logDir = x.logDir ?? '~/Library/Logs/cloudtidy';
 if (typeof stateDir !== 'string' || !stateDir || typeof logDir !== 'string' || !logDir) throw Error('Invalid configuration: stateDir/logDir');
 return {
  version: 1, root: x.root, classifier: x.classifier, ocr: x.ocr, timeoutMs: x.timeoutMs as number, routes,
  blocklist: blocklist as string[], stateDir, logDir,
  debounceMs: intIn(x.debounceMs, 3000, 0, 60000, 'debounceMs'),
  stabilityRetries: intIn(x.stabilityRetries, 2, 0, 10, 'stabilityRetries'),
  classifierRetries: intIn(x.classifierRetries, 1, 0, 3, 'classifierRetries'),
  lockWaitMs: intIn(x.lockWaitMs, 30000, 0, 300000, 'lockWaitMs'),
  naming: { datePrefix: bool(naming.datePrefix, false, 'naming.datePrefix') },
  daemon: { apply: bool(daemon.apply, false, 'daemon.apply'), notify: bool(daemon.notify, true, 'daemon.notify'), intervalSec: intIn(daemon.intervalSec, 600, 60, 86400, 'daemon.intervalSec') }
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
const compiled = new WeakMap<Route, RegExp[]>();
export function routePatterns(route: Route): RegExp[] {
 let r = compiled.get(route);
 if (!r) { r = route.patterns.map(p => new RegExp(p, 'iu')); compiled.set(route, r); }
 return r;
}
