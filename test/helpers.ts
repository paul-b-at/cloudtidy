import { mkdtemp, mkdir, readdir, readFile, realpath, rm, lstat, readlink, symlink } from 'node:fs/promises';
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
 // realpath: on macOS tmpdir() is under the /var -> /private/var symlink, and the product (correctly) works on realpath'd roots.
 const dir = await realpath(await mkdtemp(join(tmpdir(), 'cloudtidy-')));
 const root = join(dir, 'com~apple~CloudDocs'), inbox = join(root, '_Inbox'), state = join(dir, 'state');
 await mkdir(inbox, { recursive: true });
 // The product never creates top-level buckets itself (they must come from iCloud or `init`): the fixture pre-creates them.
 for (const b of ['01_Uni', '02_Admin & Finanzen', '03_Projekte & Dev', '04_Persönlich']) await mkdir(join(root, b));
 const config: Config = { ...defaultConfig, root, stateDir: state, logDir: join(dir, 'logs'), classifier: join(dir, 'classify'), ocr: join(dir, 'ocr'), debounceMs: 0, stabilityRetries: 0, lockWaitMs: 50, classifierRetries: 0, allowNonICloudRoot: true, ...over };
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
/** Replaces a pre-created bucket with a symlink (the fixture creates all buckets up front). */
export async function swapForSymlink(sb: Sandbox, bucket: string, target: string) { await rm(join(sb.root, bucket), { recursive: true }); await symlink(target, join(sb.root, bucket)); }
