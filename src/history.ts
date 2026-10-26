import { appendFile, mkdir, lstat, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { type Config } from './config';
import { exclusiveRename, exists, sha256File, type RenameOptions } from './fsx';
import { assertDestFile, UnsafePathError, type Layout, segmentsFromRoot, key } from './paths';
import { holdInCache } from './state';

export type Outcome = 'moved' | 'review' | 'duplicate';
export interface MoveRecord {
 v: 1; type: 'move'; id: string; runId: string; time: string; mode: 'run' | 'sweep';
 source: string; destination: string; sha256: string; size: number;
 route: string | null; tier: 'rule' | 'model' | 'none'; outcome: Outcome; reason: string; renamed: boolean;
}
export interface UndoRecord { v: 1; type: 'undo'; id: string; runId: string; time: string; of: string; source: string; destination: string }
export type HistoryRecord = MoveRecord | UndoRecord;
export const newRunId = (d = new Date()) => `${d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`;
export async function appendHistory(file: string, rec: HistoryRecord): Promise<void> {
 await mkdir(dirname(file), { recursive: true, mode: 0o700 });
 await appendFile(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
}
const isRecord = (x: unknown): x is HistoryRecord => !!x && typeof x === 'object' && (x as HistoryRecord).v === 1 && ((x as HistoryRecord).type === 'move' || (x as HistoryRecord).type === 'undo') && typeof (x as HistoryRecord).id === 'string';
export async function readHistory(file: string): Promise<HistoryRecord[]> {
 let raw: string;
 try { raw = await readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
 const out: HistoryRecord[] = [];
 for (const line of raw.split('\n')) { if (!line.trim()) continue; try { const j = JSON.parse(line); if (isRecord(j)) out.push(j); } catch { /* a torn last line must not hide the rest */ } }
 return out;
}
export type UndoStatus = 'restored' | 'would_restore' | 'skipped_missing' | 'skipped_changed' | 'skipped_original_occupied' | 'skipped_unsafe' | 'skipped_error';
export interface UndoItem { id: string; runId: string; from: string; to: string; status: UndoStatus }
export interface UndoSelection { runId?: string; last?: boolean }
/** Moves still eligible for undo (not yet undone), newest first. */
export function undoable(records: HistoryRecord[]): MoveRecord[] {
 const undone = new Set(records.filter((r): r is UndoRecord => r.type === 'undo').map(r => r.of));
 return records.filter((r): r is MoveRecord => r.type === 'move' && !undone.has(r.id)).reverse();
}
export function selectForUndo(records: HistoryRecord[], sel: UndoSelection): MoveRecord[] {
 const moves = undoable(records);
 const runId = sel.runId ?? (sel.last ? moves[0]?.runId : undefined);
 return runId ? moves.filter(m => m.runId === runId) : [];
}
/**
 * Restores a moved file to its original path only if (a) the destination still exists as a regular file with the recorded sha256,
 * (b) the original path is free, and (c) both ends are inside the iCloud root and allowed locations. Never overwrites: the restore is an
 * exclusive rename. History paths are untrusted input (the file is user-writable), so everything is re-validated.
 */
export async function undoMoves(config: Config, layout: Layout, historyFile: string, sel: UndoSelection, opts: { apply: boolean; rename?: RenameOptions; undoRunId: string; hold?: boolean }): Promise<UndoItem[]> {
 const chosen = selectForUndo(await readHistory(historyFile), sel);
 const items: UndoItem[] = [];
 for (const m of chosen) {
  const item = (status: UndoStatus): UndoItem => ({ id: m.id, runId: m.runId, from: m.destination, to: m.source, status });
  try {
   // Destination must still be a plain file inside the root (a bucket or Needs_Review); original location must be _Inbox/<name> or <root>/<name>.
   await assertDestFile(layout, config, m.destination);
   const srcParts = segmentsFromRoot(layout, m.source);
   const parentOk = srcParts.length === 2 ? key(srcParts[0]!) === key(basename(layout.inbox)) : srcParts.length === 1;
   if (!parentOk || basename(m.source) !== srcParts.at(-1) || m.source.includes('\0')) throw new UnsafePathError(m.source, 'unexpected_original_location');
   if (srcParts.length === 2) await assertDestInbox(layout, m.source);
  } catch (e) { items.push(item(e instanceof UnsafePathError ? 'skipped_unsafe' : 'skipped_error')); continue; }
  const st = await lstat(m.destination).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile()) { items.push(item('skipped_missing')); continue; }
  if ((await sha256File(m.destination)) !== m.sha256) { items.push(item('skipped_changed')); continue; }
  if (await exists(m.source)) { items.push(item('skipped_original_occupied')); continue; }
  if (!opts.apply) { items.push(item('would_restore')); continue; }
  const r = await exclusiveRename(m.destination, m.source, opts.rename);
  if (r !== 'ok') { items.push(item(r === 'exists' ? 'skipped_original_occupied' : r === 'missing' ? 'skipped_missing' : 'skipped_error')); continue; }
  await appendHistory(historyFile, { v: 1, type: 'undo', id: randomBytes(6).toString('hex'), runId: opts.undoRunId, time: new Date().toISOString(), of: m.id, source: m.destination, destination: m.source });
  if (opts.hold !== false) await holdInCache(config, m.sha256, basename(m.source));
  items.push(item('restored'));
 }
 return items;
}
async function assertDestInbox(layout: Layout, file: string): Promise<void> {
 const s = await lstat(layout.inbox);
 if (s.isSymbolicLink() || !s.isDirectory() || dirname(file) !== layout.inbox) throw new UnsafePathError(file, 'inbox_not_a_plain_directory');
}
