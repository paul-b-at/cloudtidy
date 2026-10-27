import { copyFile, chmod, rename, lstat, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
/** Timestamped stderr logging (launchd redirects it to ~/Library/Logs/cloudtidy). Never pass document text here. */
export const log = (msg: string) => { if (!process.env.CLOUDTIDY_QUIET) console.error(`${new Date().toISOString()} ${msg}`); };

export const LOG_FILES = ['launchd.out.log', 'launchd.err.log'];
export const LOG_MAX_BYTES = 5 * 1024 * 1024, LOG_KEEP = 3;
/**
 * Size-based rotation of the launchd stdout/stderr files: above `maxBytes` the file is copied to `.1` (older ones shift to `.2`, ... up to
 * `keep` files in total, the oldest is deleted) and truncated in place. Copy + truncate, not rename: launchd keeps its descriptor open in
 * append mode, so writes simply continue at the new start. Files stay 0600 (they contain file names). Best effort, never throws: a symlink or a failure is reported once per run through `warn` (default: the log), never silently skipped.
 */
export async function rotateLogs(logDir: string, files: string[] = LOG_FILES, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP, warn: (msg: string) => void = log): Promise<string[]> {
 const rotated: string[] = [];
 for (const f of files) {
  const p = join(logDir, f);
  try {
   const s = await lstat(p).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }); // lstat: a symlink called launchd.*.log is NOT ours to truncate
   if (!s) continue;
   if (s.isSymbolicLink()) { warn(`warning: log rotation skipped: ${f} is a symlink (never written through; replace it with a regular file)`); continue; }
   if (!s.isFile() || s.size <= maxBytes) continue;
   if (s.nlink > 1) { warn(`warning: log rotation skipped: ${f} has ${s.nlink} hard links (truncating it would also empty the other names; replace it with a regular file)`); continue; }
   await rm(`${p}.${keep - 1}`, { force: true });
   for (let i = keep - 2; i >= 1; i--) await rename(`${p}.${i}`, `${p}.${i + 1}`).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }); // a missing older file is fine, anything else is reported
   if (keep >= 2) { await copyFile(p, `${p}.1`, constants.COPYFILE_EXCL); await chmod(`${p}.1`, 0o600).catch(() => {}); }
   const fh = await open(p, constants.O_WRONLY | constants.O_NOFOLLOW); // not a path-based truncate: a link swapped in after the lstat is refused (ELOOP), never followed
   try { const t = await fh.stat(); if (t.ino !== s.ino || t.dev !== s.dev || t.nlink > 1) throw Object.assign(new Error('changed'), { code: 'ECHANGED' }); await fh.truncate(0); } finally { await fh.close(); }
   rotated.push(f);
  } catch (e) { warn(`warning: log rotation of ${f} failed (${(e as NodeJS.ErrnoException).code ?? 'error'}): the log keeps growing until this is fixed`); }
 }
 return rotated;
}
