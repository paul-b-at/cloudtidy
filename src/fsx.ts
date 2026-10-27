import { createReadStream } from 'node:fs';
import { lstat, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function sha256File(file: string): Promise<string> {
 const hash = createHash('sha256');
 for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
 return hash.digest('hex');
}
export interface Fingerprint { dev: number; ino: number; size: number; mtimeMs: number }
export const sameFingerprint = (a: Fingerprint, b: Fingerprint) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
export async function fingerprint(file: string): Promise<Fingerprint | null> {
 try {
  const s = await lstat(file);
  if (!s.isFile()) return null; // lstat: symlinks, directories and devices are not regular files
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
 } catch { return null; }
}
export const exists = (p: string) => lstat(p).then(() => true, e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; });

export type RenameResult = 'ok' | 'exists' | 'exdev' | 'missing' | 'error' | 'unsupported';
export interface RenameOptions {
 /** Explicit opt-in to the NON-atomic lstat+rename fallback (tests, filesystems without RENAME_EXCL). Also enabled by CLOUDTIDY_ALLOW_NONATOMIC_RENAME=1. */
 forceFallback?: boolean;
 /** Test hook: behave as if bun:ffi / the OS call were unavailable (the fallback is still refused unless opted in). */
 disableNative?: boolean;
 /** Test hook: which implementation actually ran. Lets a test tell the atomic native rename from the lstat+rename fallback. */
 onBackend?: (backend: 'native' | 'fallback') => void;
}
const fallbackAllowed = (o: RenameOptions) => !!o.forceFallback || process.env.CLOUDTIDY_ALLOW_NONATOMIC_RENAME === '1';
type Native = (src: string, dest: string) => { rc: number; errno: number };
let native: Native | null | undefined;
const ERRNO = process.platform === 'darwin'
 ? { exists: 17, exdev: 18, missing: 2, unsupported: [22, 45, 78, 102] }
 : { exists: 17, exdev: 18, missing: 2, unsupported: [22, 38, 95] };
/** Loads renamex_np(RENAME_EXCL) on macOS or renameat2(RENAME_NOREPLACE) on Linux; null where unavailable. */
function loadNative(): Native | null {
 if (native !== undefined) return native;
 native = null;
 try {
  const { dlopen, FFIType, read } = require('bun:ffi') as typeof import('bun:ffi');
  const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
  if (process.platform === 'darwin') {
   const lib = dlopen('/usr/lib/libSystem.B.dylib', { renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 }, __error: { args: [], returns: FFIType.ptr } });
   native = (src, dest) => { const rc = lib.symbols.renamex_np(cstr(src), cstr(dest), 0x4 /* RENAME_EXCL */); return { rc, errno: rc === 0 ? 0 : read.i32(lib.symbols.__error()!) }; };
  } else if (process.platform === 'linux') {
   const lib = dlopen('libc.so.6', { renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 }, __errno_location: { args: [], returns: FFIType.ptr } });
   native = (src, dest) => { const rc = lib.symbols.renameat2(-100 /* AT_FDCWD */, cstr(src), -100, cstr(dest), 1 /* RENAME_NOREPLACE */); return { rc, errno: rc === 0 ? 0 : read.i32(lib.symbols.__errno_location()!) }; };
  }
 } catch { native = null; }
 return native;
}
export const exclusiveRenameSupported = () => loadNative() !== null;
/**
 * Same-volume rename that never replaces an existing destination.
 * Primary path is an OS-level exclusive rename (atomic: no window between the existence check and the rename).
 * Fallback (lstat(dest) then rename) is NOT atomic: a foreign process (iCloud's daemon, another device's download) creating the
 * destination in that window would be overwritten. It is therefore never used implicitly: without `forceFallback` /
 * CLOUDTIDY_ALLOW_NONATOMIC_RENAME=1 an unavailable or unsupported exclusive rename returns 'unsupported' and nothing moves.
 * EXDEV is never handled by copying.
 */
export async function exclusiveRename(src: string, dest: string, opts: RenameOptions = {}): Promise<RenameResult> {
 const fn = opts.forceFallback || opts.disableNative ? null : loadNative();
 if (!fn && !fallbackAllowed(opts)) return 'unsupported';
 if (fn) {
  opts.onBackend?.('native');
  const { rc, errno } = fn(src, dest);
  if (rc === 0) return 'ok';
  if (errno === ERRNO.exists) return 'exists';
  if (errno === ERRNO.exdev) return 'exdev';
  if (errno === ERRNO.missing) return 'missing';
  if (ERRNO.unsupported.includes(errno)) { if (!fallbackAllowed(opts)) return 'unsupported'; }
  else {
   // errno could not be trusted: classify from filesystem state instead of guessing.
   if (await exists(dest)) return 'exists';
   if (!(await exists(src))) return 'missing';
   return 'error';
  }
 }
 opts.onBackend?.('fallback');
 if (await exists(dest)) return 'exists';
 try { await rename(src, dest); return 'ok'; }
 catch (e) { const c = (e as NodeJS.ErrnoException).code; return c === 'EXDEV' ? 'exdev' : c === 'ENOENT' ? 'missing' : 'error'; }
}
