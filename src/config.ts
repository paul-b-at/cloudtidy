import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
export interface Route { id: string; folder: string; description: string; rename: boolean }
export interface Config { version: 1; root: string; classifier: string; ocr: string; timeoutMs: number; routes: Route[] }
const buckets = new Set(['01_Uni','02_Admin & Finanzen','03_Projekte & Dev','04_Persönlich']);
export function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
export function safeName(x: unknown): x is string {
 return typeof x === 'string' && x.length > 0 && x.length <= 160 && x === x.trim() && !x.startsWith('.') && !/[\\/:\x00-\x1f\x7f]/.test(x);
}
export function validateConfig(x: unknown): Config {
 if (!record(x) || x.version !== 1 || typeof x.root !== 'string' || !x.root || typeof x.classifier !== 'string' || !x.classifier || typeof x.ocr !== 'string' || !x.ocr || !Number.isInteger(x.timeoutMs) || Number(x.timeoutMs) < 100 || Number(x.timeoutMs) > 120000 || !Array.isArray(x.routes) || !x.routes.length || x.routes.length > 32) throw Error('Invalid configuration');
 const ids = new Set<string>(), folders = new Set<string>();
 for (const v of x.routes) {
  if (!record(v) || typeof v.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.id) || v.id === 'review' || ids.has(v.id) || typeof v.folder !== 'string' || isAbsolute(v.folder) || !buckets.has(v.folder.split('/')[0]!) || !v.folder.split('/').every(safeName) || folders.has(v.folder.normalize('NFC')) || typeof v.description !== 'string' || !v.description.length || v.description.length > 240 || typeof v.rename !== 'boolean') throw Error('Invalid route');
  if (v.rename && !['02_Admin & Finanzen/Rechnungen','02_Admin & Finanzen/Verträge'].includes(v.folder)) throw Error('Renaming is restricted to invoices/contracts');
  ids.add(v.id); folders.add(v.folder.normalize('NFC'));
 }
 return x as unknown as Config;
}
export const expandHome = (s: string) => s.startsWith('~/') ? resolve(homedir(), s.slice(2)) : resolve(s);
export async function loadConfig(file: string): Promise<Config> {
 const c = validateConfig(JSON.parse(await readFile(file,'utf8')));
 return { ...c, root: expandHome(c.root), classifier: expandHome(c.classifier), ocr: expandHome(c.ocr) };
}
