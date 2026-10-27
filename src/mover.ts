import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Config } from './config';
import { exclusiveRename, fingerprint, sameFingerprint, sha256File, type Fingerprint, type RenameOptions } from './fsx';
import { assertDestDir, assertDestFile, FOLDER_MISSING, assertSource, key, UnsafePathError, type Layout, type SourceKind } from './paths';
import { splitName } from './naming';
import { HistoryWriteError, type MoveJournal } from './history';

export interface MoveRequest {
 layout: Layout; config: Config; kind: SourceKind;
 src: string; snapshot: Fingerprint; sha256: string;
 destDir: string; name: string;
 rename?: RenameOptions;
 /** Test hook: device id of the destination directory. */
 deviceOf?: (dir: string) => Promise<number>;
 /** Write-ahead journal: an `intent` is fsynced before every rename and a `commit` after it (see history.ts). */
 journal?: MoveJournal;
}
export type RefusalReason = 'exdev' | 'destination_unsafe' | 'source_unsafe' | 'source_changed' | 'source_missing' | 'name_exhausted' | 'rename_failed' | 'atomic_rename_unavailable' | 'folder_missing' | 'rollback_failed';
export type MoveOutcome =
 | { kind: 'moved'; to: string; suffixed: boolean }
 | { kind: 'duplicate'; existing: string }
 | { kind: 'refused'; reason: RefusalReason; /** `folder_missing:<relative path>` */ detail?: string };
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
 * 2. re-validate the destination directory (configured bucket / Needs_Review, no symlink components, no protected names; it must already exist, nothing is created);
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
 try { await assertDestDir(layout, config, req.destDir); } catch (e) { if (e instanceof UnsafePathError) return e.reason.startsWith(FOLDER_MISSING) ? { kind: 'refused', reason: 'folder_missing', detail: e.reason } : { kind: 'refused', reason: 'destination_unsafe' }; throw e; }
 if ((await (req.deviceOf ? req.deviceOf(req.destDir) : stat(req.destDir).then(x => x.dev))) !== req.snapshot.dev) return { kind: 'refused', reason: 'exdev' };
 let races = 0;
 for (let n = 1; n <= MAX_SUFFIX; n++) {
  const candidate = join(req.destDir, withCounter(req.name, n));
  try { await assertDestFile(layout, config, candidate); } catch (e) { if (e instanceof UnsafePathError) return { kind: 'refused', reason: 'destination_unsafe' }; throw e; }
  // An evicted iCloud file at this name is only a `.name.icloud` placeholder: treat the name as occupied or the download later collides.
  if (await lstat(join(req.destDir, `.${withCounter(req.name, n)}.icloud`)).then(() => true, () => false)) continue;
  const existing = await lstat(candidate).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; });
  if (existing) {
   if (existing.isFile() && existing.size === req.snapshot.size && (await sha256File(candidate)) === req.sha256) return { kind: 'duplicate', existing: candidate };
   continue;
  }
  const intent = await req.journal?.intent(candidate); // throws HistoryWriteError before anything moved
  const undo = async (reason: RefusalReason, why: string): Promise<MoveOutcome> => {
   const back = await exclusiveRename(candidate, req.src, req.rename);
   if (intent) {
    if (back === 'ok') await req.journal!.abort(intent, `rolled_back:${why}`);
    else {
     // Rollback impossible (the source name is taken again): the file now sits in the destination, so it must be journaled and stay visible/undoable (undo re-checks the hash).
     // If even that fails the intent stays dangling for the next run's recovery, and the run stops (HistoryWriteError): an unjournaled file is never ignored.
     try { await req.journal!.commit(intent); }
     catch (e) { throw new HistoryWriteError(`rollback failed and the move could not be journaled (${(e as Error).message}); ${candidate} is reconciled on the next run`, false); }
    }
   }
   return { kind: 'refused', reason: back === 'ok' ? reason : 'rollback_failed' };
  };
  const result = await exclusiveRename(req.src, candidate, req.rename);
  if (result !== 'ok' && intent) await req.journal!.abort(intent, `rename:${result}`);
  if (result === 'exists') { if (++races <= 3) n--; continue; } // lost a race: re-inspect the same candidate (may now be a duplicate), then move on
  if (result === 'ok') {
   const landed = await fingerprint(candidate);
   if (!landed) { if (intent) await req.journal!.abort(intent, 'landed_file_missing'); return { kind: 'refused', reason: 'rename_failed' }; }
   if (landed.ino !== req.snapshot.ino) return undo('source_changed', 'inode_mismatch'); // a different file was swapped in after verification: put it back instead of leaving an unverified file in the bucket
   // Directory-component TOCTOU (no openat in Bun): verify after the fact that the file really is where we think; if a component was swapped for a symlink, put it back.
   if (key(await realpath(candidate).catch(() => '')) !== key(candidate)) return undo('destination_unsafe', 'realpath_mismatch');
   if (intent) {
    try { await req.journal!.commit(intent); }
    catch (e) { const back = await exclusiveRename(candidate, req.src, req.rename); throw new HistoryWriteError((e as Error).message + (back === 'ok' ? '; move rolled back' : '; move NOT rolled back (reconciled on the next run)'), back === 'ok'); }
   }
   return { kind: 'moved', to: candidate, suffixed: n > 1 };
  }
  return { kind: 'refused', reason: result === 'exdev' ? 'exdev' : result === 'missing' ? 'source_missing' : result === 'unsupported' ? 'atomic_rename_unavailable' : 'rename_failed' };
 }
 return { kind: 'refused', reason: 'name_exhausted' };
}
