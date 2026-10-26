import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Config } from './config';
import { exclusiveRename, fingerprint, sameFingerprint, sha256File, type Fingerprint, type RenameOptions } from './fsx';
import { assertDestDir, assertDestFile, assertSource, UnsafePathError, type Layout, type SourceKind } from './paths';
import { splitName } from './naming';

export interface MoveRequest {
 layout: Layout; config: Config; kind: SourceKind;
 src: string; snapshot: Fingerprint; sha256: string;
 destDir: string; name: string;
 rename?: RenameOptions;
 /** Test hook: device id of the destination directory. */
 deviceOf?: (dir: string) => Promise<number>;
}
export type RefusalReason = 'exdev' | 'destination_unsafe' | 'source_unsafe' | 'source_changed' | 'source_missing' | 'name_exhausted' | 'rename_failed';
export type MoveOutcome =
 | { kind: 'moved'; to: string; suffixed: boolean }
 | { kind: 'duplicate'; existing: string }
 | { kind: 'refused'; reason: RefusalReason };
/** `Rechnung.pdf`, 2 -> `Rechnung (2).pdf` (deterministic collision suffix). */
export function withCounter(name: string, n: number): string {
 if (n <= 1) return name;
 const { stem, ext } = splitName(name);
 return `${stem} (${n})${ext}`;
}
const MAX_SUFFIX = 99;
/**
 * The only function that moves user files. Never overwrites, never deletes, never copies:
 * 1. re-validate the source immediately before the move (still a plain file, same dev/ino/size/mtime, same sha256);
 * 2. re-validate the destination directory (configured bucket / Needs_Review, no symlink components, no protected names);
 * 3. refuse cross-volume moves (EXDEV) instead of copy+delete;
 * 4. exclusive rename to the first free `name`, `name (2)`, ...; identical content already there => duplicate (caller sends it to review).
 */
export async function moveNoClobber(req: MoveRequest): Promise<MoveOutcome> {
 const { layout, config } = req;
 try { await assertSource(layout, config, req.src, req.kind); } catch (e) { return e instanceof UnsafePathError ? { kind: 'refused', reason: 'source_unsafe' } : { kind: 'refused', reason: 'source_missing' }; }
 const now = await fingerprint(req.src);
 if (!now) return { kind: 'refused', reason: 'source_missing' };
 if (!sameFingerprint(now, req.snapshot)) return { kind: 'refused', reason: 'source_changed' };
 if ((await sha256File(req.src)) !== req.sha256) return { kind: 'refused', reason: 'source_changed' };
 const afterHash = await fingerprint(req.src);
 if (!afterHash || !sameFingerprint(afterHash, req.snapshot)) return { kind: 'refused', reason: 'source_changed' };
 try { await assertDestDir(layout, config, req.destDir, true); } catch (e) { if (e instanceof UnsafePathError) return { kind: 'refused', reason: 'destination_unsafe' }; throw e; }
 if ((await (req.deviceOf ? req.deviceOf(req.destDir) : stat(req.destDir).then(x => x.dev))) !== req.snapshot.dev) return { kind: 'refused', reason: 'exdev' };
 let races = 0;
 for (let n = 1; n <= MAX_SUFFIX; n++) {
  const candidate = join(req.destDir, withCounter(req.name, n));
  try { await assertDestFile(layout, config, candidate); } catch (e) { if (e instanceof UnsafePathError) return { kind: 'refused', reason: 'destination_unsafe' }; throw e; }
  const existing = await lstat(candidate).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; });
  if (existing) {
   if (existing.isFile() && existing.size === req.snapshot.size && (await sha256File(candidate)) === req.sha256) return { kind: 'duplicate', existing: candidate };
   continue;
  }
  const result = await exclusiveRename(req.src, candidate, req.rename);
  if (result === 'exists') { if (++races <= 3) n--; continue; } // lost a race: re-inspect the same candidate (may now be a duplicate), then move on
  if (result === 'ok') {
   const landed = await fingerprint(candidate);
   if (!landed || landed.ino !== req.snapshot.ino) return { kind: 'refused', reason: 'rename_failed' };
   return { kind: 'moved', to: candidate, suffixed: n > 1 };
  }
  return { kind: 'refused', reason: result === 'exdev' ? 'exdev' : result === 'missing' ? 'source_missing' : 'rename_failed' };
 }
 return { kind: 'refused', reason: 'name_exhausted' };
}
