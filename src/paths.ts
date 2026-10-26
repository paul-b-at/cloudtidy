import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { BUILTIN_BLOCKLIST, INBOX, REVIEW, safeName, type Config } from './config';

export class UnsafePathError extends Error { constructor(readonly target: string, readonly reason: string) { super(`unsafe_path: ${reason}`); } }
export interface Layout { root: string; inbox: string; review: string }
export type SourceKind = 'inbox' | 'root';
/** Case/normalization-insensitive key: APFS is case-insensitive and normalization-preserving. */
export const key = (s: string) => s.normalize('NFC').toLowerCase();

export async function resolveLayout(config: Config): Promise<Layout> {
 const root = await realpath(config.root);
 return { root, inbox: join(root, INBOX), review: join(root, INBOX, REVIEW) };
}
export function blockedNames(config: Config): Set<string> { return new Set([...BUILTIN_BLOCKLIST, ...config.blocklist].map(key)); }
/** Names the tool must never read or write: app containers, `_Archiv`, anything containing `~` (relative to the iCloud root). */
export function protectedName(segment: string, config: Config): boolean { return segment.includes('~') || blockedNames(config).has(key(segment)); }
export function bucketTops(config: Config): Set<string> { return new Set(config.routes.map(r => key(r.folder.split('/')[0]!))); }

/** Lexical segments relative to the root; throws on escape (`..`, absolute, outside). */
export function segmentsFromRoot(layout: Layout, abs: string): string[] {
 if (!isAbsolute(abs)) throw new UnsafePathError(abs, 'not_absolute');
 const rel = relative(layout.root, abs);
 if (rel === '' ) return [];
 const parts = rel.split(sep);
 if (isAbsolute(rel) || parts.some(p => p === '..' || p === '.' || p === '')) throw new UnsafePathError(abs, 'outside_root');
 return parts;
}

/**
 * Validates a destination directory: inside a configured bucket or `_Inbox/Needs_Review`, never `_Archiv` or an app
 * container, and no symlink in any existing component. With `create`, missing components are created one at a time
 * (each re-validated). Residual risk: a component swapped for a symlink between this check and the rename (no openat in Bun).
 */
export async function assertDestDir(layout: Layout, config: Config, dir: string, create = false): Promise<string> {
 const parts = segmentsFromRoot(layout, dir);
 const top = parts[0] === undefined ? undefined : key(parts[0]);
 const inReview = parts.length >= 2 && key(parts[0]!) === key(INBOX) && key(parts[1]!) === key(REVIEW);
 if (!parts.length || !(inReview || (top !== undefined && bucketTops(config).has(top)))) throw new UnsafePathError(dir, 'not_a_configured_destination');
 if (parts.some(p => protectedName(p, config))) throw new UnsafePathError(dir, 'protected_name');
 if (parts.some(p => !safeName(p))) throw new UnsafePathError(dir, 'unsafe_segment');
 let cur = layout.root, missing = false;
 for (const seg of parts) {
  cur = join(cur, seg);
  if (!missing) {
   try {
    const s = await lstat(cur);
    if (s.isSymbolicLink()) throw new UnsafePathError(dir, 'symlink_component');
    if (!s.isDirectory()) throw new UnsafePathError(dir, 'not_a_directory');
    if (key(await realpath(cur)) !== key(cur)) throw new UnsafePathError(dir, 'realpath_mismatch');
    continue;
   } catch (e) {
    if (e instanceof UnsafePathError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    missing = true;
   }
  }
  if (!create) continue;
  await mkdir(cur);
  const s = await lstat(cur);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new UnsafePathError(dir, 'symlink_component');
 }
 return cur;
}
export async function assertDestFile(layout: Layout, config: Config, file: string): Promise<void> {
 const name = basename(file);
 if (!safeName(name) || protectedName(name, config)) throw new UnsafePathError(file, 'unsafe_name');
 await assertDestDir(layout, config, dirname(file));
 const s = await lstat(file).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; });
 if (s?.isSymbolicLink()) throw new UnsafePathError(file, 'symlink_destination');
}
/** Source must be a regular, non-symlink direct child of `_Inbox` (or the iCloud root for sweep) with an unprotected name. */
export async function assertSource(layout: Layout, config: Config, file: string, kind: SourceKind): Promise<void> {
 const parent = kind === 'inbox' ? layout.inbox : layout.root;
 if (dirname(file) !== parent) throw new UnsafePathError(file, 'not_a_direct_child');
 const name = basename(file);
 if (!safeName(name) || protectedName(name, config) || /\.icloud$/i.test(name)) throw new UnsafePathError(file, 'unsafe_name');
 if (kind === 'inbox') {
  const s = await lstat(parent);
  if (s.isSymbolicLink() || !s.isDirectory() || key(await realpath(parent)) !== key(parent)) throw new UnsafePathError(file, 'inbox_not_a_plain_directory');
 }
 const s = await lstat(file);
 if (s.isSymbolicLink() || !s.isFile()) throw new UnsafePathError(file, 'not_a_regular_file');
}
