import { mkdtemp, mkdir, readdir, readFile, rm, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, type Config } from '../src/config';
import type { ModelCall } from '../src/classifier';

process.env.CLOUDTIDY_QUIET = '1';
process.env.CLOUDTIDY_NO_NOTIFY = '1';
delete process.env.CLOUDTIDY_CONTEXT;
export const baseJson = JSON.parse(await readFile(new URL('../config/default.config.json', import.meta.url), 'utf8'));
export const defaultConfig = validateConfig(baseJson);
export interface Sandbox { dir: string; root: string; inbox: string; review: string; state: string; config: Config; cleanup(): Promise<void> }
/** A fake iCloud root (its name contains `~` like com~apple~CloudDocs) with an _Inbox and an isolated state dir. */
export async function sandbox(over: Partial<Config> = {}): Promise<Sandbox> {
 const dir = await mkdtemp(join(tmpdir(), 'cloudtidy-'));
 const root = join(dir, 'com~apple~CloudDocs'), inbox = join(root, '_Inbox'), state = join(dir, 'state');
 await mkdir(inbox, { recursive: true });
 const config: Config = { ...defaultConfig, root, stateDir: state, logDir: join(dir, 'logs'), classifier: join(dir, 'classify'), ocr: join(dir, 'ocr'), debounceMs: 0, stabilityRetries: 0, lockWaitMs: 50, classifierRetries: 0, ...over };
 return { dir, root, inbox, review: join(inbox, 'Needs_Review'), state, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export const model = (r: Partial<{ route: string; documentDate: string; sender: string; needsReview: boolean }> & Record<string, unknown> = {}): ModelCall => async () => ({ version: 2, route: 'review', documentDate: '', sender: '', needsReview: false, ...r });
export const failingModel: ModelCall = async () => { throw new Error('boom'); };
/** Deterministic listing of every entry below `dir` (type, size/target) to prove a tree did not change. */
export async function tree(dir: string, prefix = ''): Promise<string[]> {
 const out: string[] = [];
 for (const name of (await readdir(dir)).sort()) {
  const p = join(dir, name), s = await lstat(p);
  if (s.isSymbolicLink()) out.push(`${prefix}${name} -> ${await readlink(p)}`);
  else if (s.isDirectory()) { out.push(`${prefix}${name}/`); out.push(...await tree(p, `${prefix}${name}/`)); }
  else out.push(`${prefix}${name} ${s.size} ${s.mtimeMs}`);
 }
 return out;
}
