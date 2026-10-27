import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { INBOX, safeName, type Config } from './config';
import { fingerprint, type Fingerprint } from './fsx';
import { protectedName, type Layout, type SourceKind } from './paths';

export type SkipReason = 'dotfile' | 'icloud_placeholder' | 'partial_download' | 'directory' | 'symlink' | 'not_regular_file' | 'protected_name' | 'unsafe_name';
export interface Skipped { name: string; reason: SkipReason }
export interface Candidates { files: { name: string; path: string }[]; skipped: Skipped[] }
const PARTIAL = /\.(?:download|crdownload|part|partial|tmp|temp)$/i;
/** Direct children only. Skips dotfiles, `.icloud` placeholders, partial downloads, symlinks, directories (incl. Needs_Review), `~` names and app containers. */
export async function listCandidates(layout: Layout, config: Config, kind: SourceKind): Promise<Candidates> {
 const dir = kind === 'inbox' ? layout.inbox : layout.root;
 const out: Candidates = { files: [], skipped: [] };
 const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
 for (const e of entries) {
  const skip = (reason: SkipReason) => out.skipped.push({ name: e.name, reason });
  if (e.name.startsWith('.')) { skip(/\.icloud$/i.test(e.name) ? 'icloud_placeholder' : 'dotfile'); continue; }
  if (/\.icloud$/i.test(e.name)) { skip('icloud_placeholder'); continue; }
  if (e.isSymbolicLink()) { skip('symlink'); continue; }
  if (e.isDirectory()) { skip('directory'); continue; }
  if (!e.isFile()) { skip('not_regular_file'); continue; }
  if (PARTIAL.test(e.name) || e.name.startsWith('Icon\r')) { skip('partial_download'); continue; }
  if (protectedName(e.name, config) || e.name === INBOX) { skip('protected_name'); continue; }
  if (!safeName(e.name)) { skip('unsafe_name'); continue; } // control/bidi chars, edge whitespace, >160 chars: the mover would refuse it on every run
  out.files.push({ name: e.name, path: join(dir, e.name) });
 }
 return out;
}
export interface Stable { name: string; path: string; snapshot: Fingerprint }
export interface StabilityResult { stable: Stable[]; unstable: { name: string; path: string }[] }
/**
 * One shared debounce per run: snapshot every candidate, wait ONCE, compare. A file is stable when dev/ino/size/mtime are identical
 * across the interval (iCloud and browsers write files in place). Files still changing are returned as `unstable` (reported as
 * pending, retried on the next trigger; `stabilityRetries` > 0 adds extra shared rounds for them). Empty files are "stable" here;
 * run.ts holds them back for the empty-file grace period.
 */
export async function waitForStable(files: { name: string; path: string }[], config: Pick<Config, 'debounceMs' | 'stabilityRetries'>, sleep: (ms: number) => Promise<unknown> = Bun.sleep): Promise<StabilityResult> {
 const result: StabilityResult = { stable: [], unstable: [] };
 const prev = new Map<string, Fingerprint | null>();
 let pending = files;
 for (const f of pending) prev.set(f.path, await fingerprint(f.path));
 for (let round = 0; round <= config.stabilityRetries && pending.length; round++) {
  if (config.debounceMs > 0) await sleep(config.debounceMs);
  const next: typeof pending = [];
  for (const f of pending) {
   const a = prev.get(f.path), b = await fingerprint(f.path);
   if (a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs) result.stable.push({ ...f, snapshot: b });
   else { prev.set(f.path, b); if (b) next.push(f); }
  }
  pending = next;
 }
 for (const f of pending) result.unstable.push({ name: f.name, path: f.path });
 result.stable.sort((x, y) => (x.name < y.name ? -1 : 1));
 return result;
}
