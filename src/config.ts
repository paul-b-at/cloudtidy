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
export interface KnownSender { name: string; aliases: string[]; /** An ordinary word as well as a company (Drei, Magenta, Verbund, Allianz): only counts in the letterhead window or before a company suffix. */ commonWord?: boolean }
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
 /** Time budget of one run/sweep (seconds): no new file is started once it is spent; the rest waits, untouched, for the next run. */
 maxRunSeconds: number;
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
const TOP_KEYS = new Set(['version', 'root', 'classifier', 'ocr', 'timeoutMs', 'routes', 'blocklist', 'stateDir', 'logDir', 'debounceMs', 'stabilityRetries', 'classifierRetries', 'lockWaitMs', 'maxRunSeconds', 'naming', 'daemon', 'model', 'knownSenders', 'allowNonICloudRoot', 'emptyGraceMinutes']);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
/** Filename/segment safety: no separators, control/C1/bidi-override/zero-width-space/line-separator chars, leading dot, edge whitespace. ZWJ/ZWNJ/LRM/RLM stay legal (emoji, Persian). */
export function safeName(x: unknown): x is string {
 return typeof x === 'string' && x.length > 0 && x.length <= 160 && x === x.trim() && !x.startsWith('.') && x !== '..' && !/[\\/:\x00-\x1f\x7f-\x9f\u200b\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/.test(x);
}
function intIn(x: unknown, def: number, min: number, max: number, what: string): number {
 if (x === undefined) return def;
 if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) throw Error(`Invalid configuration: "${what}" must be a whole number from ${min} to ${max} (found ${JSON.stringify(x)})`);
 return x;
}
function bool(x: unknown, def: boolean, what: string): boolean {
 if (x === undefined) return def;
 if (typeof x !== 'boolean') throw Error(`Invalid configuration: "${what}" must be true or false (found ${JSON.stringify(x)})`);
 return x;
}
const SENDER_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .&'\-]{0,59}$/u;
function parseSenders(x: unknown): KnownSender[] {
 if (x === undefined) return [];
 if (!Array.isArray(x) || x.length > 200) throw Error('Invalid configuration: "knownSenders" must be a list of at most 200 entries');
 return x.map(v => {
  if (!record(v) || typeof v.name !== 'string' || !SENDER_LABEL.test(v.name) || v.name.length < 2) throw Error('Invalid configuration: "knownSenders[].name" must be a 2-60 character name (letters, digits, space . & \' -) and an object with name/aliases only');
  for (const k of Object.keys(v)) if (k !== 'name' && k !== 'aliases' && k !== 'commonWord') throw Error(`Invalid configuration: unknown knownSenders key "${k}"`);
  const aliases = v.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 8 || !aliases.every(a => typeof a === 'string' && SENDER_LABEL.test(a) && a.length >= 2)) throw Error('Invalid configuration: "knownSenders[].aliases" must be a list of at most 8 names of 2-60 characters (letters, digits, space . & \' -)');
  if (v.commonWord !== undefined && typeof v.commonWord !== 'boolean') throw Error('Invalid configuration: "knownSenders[].commonWord" must be true or false');
  return { name: v.name, aliases: aliases as string[], ...(v.commonWord ? { commonWord: true } : {}) };
 });
}
export function validateConfig(x: unknown): Config {
 if (!record(x)) throw Error('Invalid configuration: the file must contain a JSON object');
 if (x.version !== 1) throw Error(`Invalid configuration: "version" must be 1 (found ${JSON.stringify(x.version)})`);
 for (const k of ['root', 'classifier', 'ocr'] as const) if (typeof x[k] !== 'string' || !x[k]) throw Error(`Invalid configuration: "${k}" must be a non-empty path string`);
 if (!Number.isInteger(x.timeoutMs) || Number(x.timeoutMs) < 100 || Number(x.timeoutMs) > 120000) throw Error(`Invalid configuration: "timeoutMs" must be a whole number of milliseconds from 100 to 120000 (found ${JSON.stringify(x.timeoutMs)})`);
 if (!Array.isArray(x.routes) || !x.routes.length || x.routes.length > 32) throw Error('Invalid configuration: "routes" must be a list of 1 to 32 routes');
 for (const k of Object.keys(x)) if (!TOP_KEYS.has(k)) throw Error(`Invalid configuration: unknown key "${k}"`);
 const ids = new Set<string>(), folders = new Set<string>(), routes: Route[] = [];
 for (const [n, v] of x.routes.entries()) {
  const at = `routes[${n}]${record(v) && typeof v.id === 'string' ? ` ("${v.id.slice(0, 40)}")` : ''}`, bad = (why: string): never => { throw Error(`Invalid configuration: ${at}: ${why}`); };
  if (!record(v)) bad('must be an object');
  if (typeof v.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.id)) bad('"id" must be 1-32 lowercase letters, digits, "_" or "-", starting with a letter');
  if (v.id === 'review') bad('"id" must not be "review" (reserved)');
  if (ids.has(v.id as string)) bad('"id" is used twice');
  if (typeof v.folder !== 'string' || isAbsolute(v.folder)) bad('"folder" must be a relative path like "01_Uni"');
  const parts = (v.folder as string).split('/');
  if (!buckets.has(parts[0]!)) bad(`"folder" must start with one of the buckets: ${[...buckets].join(', ')}`);
  if (!parts.every(seg => safeName(seg) && !seg.includes('~'))) bad('"folder" has an unsafe segment (separator, control character, leading dot, "~" or surrounding space)');
  if (folders.has((v.folder as string).normalize('NFC'))) bad('"folder" is used by another route');
  if (typeof v.description !== 'string' || !v.description.length || v.description.length > 240) bad('"description" must be 1-240 characters');
  if (typeof v.rename !== 'boolean') bad('"rename" must be true or false');
  if (v.rename && !RENAME_FOLDERS.includes(v.folder as string)) bad(`"rename": true is only allowed for ${RENAME_FOLDERS.join(' and ')}`);
  if (v.rename && (typeof v.docType !== 'string' || !/^[\p{L}][\p{L}\p{N}-]{0,30}$/u.test(v.docType))) bad('"docType" (letters, digits, "-", up to 31 characters) is required when "rename" is true');
  if (!v.rename && v.docType !== undefined) bad('"docType" only applies to routes with "rename": true');
  const patterns = v.patterns ?? [];
  if (!Array.isArray(patterns) || patterns.length > 16) bad('"patterns" must be a list of at most 16 regular expressions');
  for (const [j, p] of (patterns as unknown[]).entries()) {
   if (typeof p !== 'string' || !p || p.length > 400) bad(`"patterns[${j}]" must be a non-empty string of at most 400 characters`);
   let re: RegExp;
   try { re = new RegExp(wholeWord(p as string), 'iu'); } catch (e) { bad(`"patterns[${j}]" is not a valid regular expression (${(e as Error).message.replace(/^Invalid regular expression: /, '').slice(0, 120)})`); }
   if (re!.test('')) bad(`"patterns[${j}]" matches the empty string (it would match every document)`);
  }
  ids.add(v.id as string); folders.add((v.folder as string).normalize('NFC'));
  routes.push({ id: v.id as string, folder: v.folder as string, description: v.description as string, rename: v.rename as boolean, ...(v.rename ? { docType: v.docType as string } : {}), patterns: patterns as string[] });
 }
 const blocklist = x.blocklist ?? [];
 if (!Array.isArray(blocklist) || blocklist.length > 64 || !blocklist.every(safeName)) throw Error('Invalid configuration: "blocklist" must be a list of at most 64 plain folder names');
 const naming = x.naming ?? {}, daemon = x.daemon ?? {}, model = x.model ?? {};
 for (const [k, v] of [['naming', naming], ['daemon', daemon], ['model', model]] as const) if (!record(v)) throw Error(`Invalid configuration: "${k}" must be an object`);
 if (!record(naming) || !record(daemon) || !record(model)) throw Error('Invalid configuration');
 for (const k of Object.keys(model)) if (k !== 'maxDeferHours') throw Error(`Invalid configuration: unknown model key "${k}"`);
 const knownSenders = parseSenders(x.knownSenders);
 for (const k of Object.keys(naming)) if (k !== 'datePrefix') throw Error(`Invalid configuration: unknown naming key "${k}"`);
 for (const k of Object.keys(daemon)) if (!['apply', 'notify', 'intervalSec'].includes(k)) throw Error(`Invalid configuration: unknown daemon key "${k}"`);
 const stateDir = x.stateDir ?? '~/Library/Application Support/cloudtidy', logDir = x.logDir ?? '~/Library/Logs/cloudtidy';
 if (typeof stateDir !== 'string' || !stateDir || typeof logDir !== 'string' || !logDir) throw Error('Invalid configuration: "stateDir" and "logDir" must be non-empty path strings');
 return {
  version: 1, root: x.root as string, classifier: x.classifier as string, ocr: x.ocr as string, timeoutMs: x.timeoutMs as number, routes,
  blocklist: blocklist as string[], stateDir, logDir,
  debounceMs: intIn(x.debounceMs, 3000, 0, 60000, 'debounceMs'),
  stabilityRetries: intIn(x.stabilityRetries, 2, 0, 3, 'stabilityRetries'),
  emptyGraceMinutes: intIn(x.emptyGraceMinutes, 10, 0, 1440, 'emptyGraceMinutes'),
  classifierRetries: intIn(x.classifierRetries, 1, 0, 3, 'classifierRetries'),
  lockWaitMs: intIn(x.lockWaitMs, 30000, 0, 300000, 'lockWaitMs'),
  maxRunSeconds: intIn(x.maxRunSeconds, 300, 60, 3600, 'maxRunSeconds'),
  naming: { datePrefix: bool(naming.datePrefix, false, 'naming.datePrefix') },
  daemon: { apply: bool(daemon.apply, false, 'daemon.apply'), notify: bool(daemon.notify, true, 'daemon.notify'), intervalSec: intIn(daemon.intervalSec, 120, 60, 86400, 'daemon.intervalSec') },
  model: { maxDeferHours: intIn(model.maxDeferHours, 24, 1, 720, 'model.maxDeferHours') },
  knownSenders, allowNonICloudRoot: bool(x.allowNonICloudRoot, false, 'allowNonICloudRoot')
 };
}
/**
 * Longest a single file can take once it has been started: PDF text (timeout) then OCR (timeout), then the model ((retries + 1) calls plus the
 * 0.5 s, 1 s, ... pauses between them). The lock is held for at most `maxRunSeconds` + this, because the budget is only checked between files.
 */
export const oneFileMaxSeconds = (c: Pick<Config, 'timeoutMs' | 'classifierRetries'>) => Math.ceil((c.timeoutMs * (c.classifierRetries + 3) + 500 * c.classifierRetries * (c.classifierRetries + 1) / 2) / 1000);
export const worstCaseLockSeconds = (c: Pick<Config, 'timeoutMs' | 'classifierRetries' | 'maxRunSeconds'>) => c.maxRunSeconds + oneFileMaxSeconds(c);
export const expandHome = (s: string, base = process.cwd()) => s === '~' ? homedir() : s.startsWith('~/') ? resolve(homedir(), s.slice(2)) : resolve(base, s);
export function resolvePaths(c: Config): Config {
 return { ...c, root: expandHome(c.root), classifier: expandHome(c.classifier, repoRoot), ocr: expandHome(c.ocr, repoRoot), stateDir: expandHome(c.stateDir), logDir: expandHome(c.logDir) };
}
export const defaultConfigPath = resolve(repoRoot, 'config/default.config.json');
export async function loadConfig(file = defaultConfigPath): Promise<Config> {
 let text: string;
 try { text = await readFile(file, 'utf8'); } catch (e) { throw Error(`config file ${file}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : `cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`}`); }
 let json: unknown;
 try { json = JSON.parse(text); } catch (e) { throw Error(`config file ${file}: not valid JSON (${(e as Error).message.slice(0, 120)})`); }
 try { return resolvePaths(validateConfig(json)); } catch (e) { throw Error(`config file ${file}: ${(e as Error).message}`); }
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
