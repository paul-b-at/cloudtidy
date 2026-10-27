import { mkdir, lstat, open, readFile } from 'node:fs/promises';
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
export interface IntentRecord extends Omit<MoveRecord, 'type'> { type: 'intent' }
export interface CommitRecord { v: 1; type: 'commit'; id: string; runId: string; time: string; of: string; recovered?: boolean }
export interface AbortRecord { v: 1; type: 'abort'; id: string; runId: string; time: string; of: string; why: string }
/** What is stored on disk. Moves are journaled write-ahead: `intent` (before the rename), then `commit` (after it) or `abort`. */
export type RawRecord = MoveRecord | UndoRecord | IntentRecord | CommitRecord | AbortRecord;
/** The derived, user-facing view: every committed intent appears as a `move`; undo records as-is. */
export type HistoryRecord = MoveRecord | UndoRecord;
export const newRunId = (d = new Date()) => `${d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`;
/** Thrown when a move could not be journaled. The caller must stop moving files (an unjournaled move cannot be undone). */
export class HistoryWriteError extends Error { constructor(message: string, readonly rolledBack: boolean) { super(message); } }
/** Append one JSON line and fsync it. A torn last line (crash / ENOSPC mid-write) gets a newline first so it cannot swallow the new record. */
export async function appendHistory(file: string, rec: RawRecord): Promise<void> {
 await mkdir(dirname(file), { recursive: true, mode: 0o700 });
 const h = await open(file, 'a+', 0o600);
 try {
  const { size } = await h.stat();
  let prefix = '';
  if (size > 0) { const b = Buffer.alloc(1); await h.read(b, 0, 1, size - 1); if (b[0] !== 0x0a) prefix = '\n'; }
  await h.write(`${prefix}${JSON.stringify(rec)}\n`);
  await h.sync(); // the record must be on disk before (intent) or right after (commit) the rename it describes
  await h.chmod(0o600).catch(() => {}); // history holds personal file names
 } finally { await h.close(); }
}
const str = (x: unknown) => typeof x === 'string';
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const isMoveShape = (r: Record<string, unknown>) => str(r.source) && str(r.destination) && str(r.sha256) && str(r.outcome) && str(r.reason) && str(r.time) && num(r.size) && (r.route === null || str(r.route)) && str(r.tier) && (r.mode === 'run' || r.mode === 'sweep') && typeof r.renamed === 'boolean';
const isRecord = (x: unknown): x is RawRecord => {
 if (!x || typeof x !== 'object') return false;
 const r = x as Record<string, unknown>;
 if (r.v !== 1 || !str(r.id) || !str(r.runId) || !str(r.time)) return false;
 if (r.type === 'move' || r.type === 'intent') return isMoveShape(r);
 if (r.type === 'undo') return str(r.of) && str(r.source) && str(r.destination);
 if (r.type === 'commit') return str(r.of);
 if (r.type === 'abort') return str(r.of) && str(r.why);
 return false;
};
export async function readRawHistory(file: string): Promise<RawRecord[]> {
 let raw: string;
 try { raw = await readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
 const out: RawRecord[] = [];
 for (const line of raw.split('\n')) { if (!line.trim()) continue; try { const j = JSON.parse(line); if (isRecord(j)) out.push(j); } catch { /* a torn last line must not hide the rest */ } }
 return out;
}
/** Intents that were written but never committed or aborted: a crash happened between the journal write and the end of the move. */
export function pendingIntents(raw: RawRecord[]): IntentRecord[] {
 const done = new Set<string>();
 for (const r of raw) if (r.type === 'commit' || r.type === 'abort') done.add(r.of);
 return raw.filter((r): r is IntentRecord => r.type === 'intent' && !done.has(r.id));
}
export function deriveHistory(raw: RawRecord[]): HistoryRecord[] {
 const committed = new Map<string, CommitRecord>();
 for (const r of raw) if (r.type === 'commit') committed.set(r.of, r);
 const out: HistoryRecord[] = [];
 for (const r of raw) {
  if (r.type === 'move' || r.type === 'undo') out.push(r);
  else if (r.type === 'intent') { const c = committed.get(r.id); if (c) out.push({ ...r, type: 'move', time: c.time, reason: c.recovered ? `${r.reason} (recovered after crash)` : r.reason }); }
 }
 return out;
}
export async function readHistory(file: string): Promise<HistoryRecord[]> { return deriveHistory(await readRawHistory(file)); }
export interface MoveJournal {
 /** Write-ahead record for a rename about to happen to `destination`. Throws HistoryWriteError (nothing has moved yet). */
 intent(destination: string): Promise<string>;
 commit(id: string): Promise<void>;
 /** Best effort: the rename did not happen (or was rolled back). */
 abort(id: string, why: string): Promise<void>;
}
export type JournalBase = Pick<MoveRecord, 'runId' | 'mode' | 'source' | 'sha256' | 'size' | 'route' | 'tier' | 'outcome' | 'reason' | 'renamed'>;
export function makeJournal(file: string, base: JournalBase): MoveJournal {
 return {
  async intent(destination) {
   const id = randomBytes(6).toString('hex');
   try { await appendHistory(file, { v: 1, type: 'intent', id, time: new Date().toISOString(), destination, ...base }); }
   catch (e) { throw new HistoryWriteError(`history write failed (${(e as Error).message}); nothing was moved`, true); }
   return id;
  },
  async commit(id) {
   try { await appendHistory(file, { v: 1, type: 'commit', id: randomBytes(6).toString('hex'), runId: base.runId, time: new Date().toISOString(), of: id }); }
   catch (e) { throw new HistoryWriteError(`history commit failed (${(e as Error).message})`, false); }
  },
  async abort(id, why) { await appendHistory(file, { v: 1, type: 'abort', id: randomBytes(6).toString('hex'), runId: base.runId, time: new Date().toISOString(), of: id, why }).catch(() => {}); }
 };
}
export interface Reconciled { recovered: number; aborted: number }
/**
 * Startup recovery after a crash between "intent" and "commit". For each dangling intent: if the destination holds exactly the
 * recorded content and the source is gone, the rename happened: commit it (so undo works). Otherwise record an abort.
 * Only appends journal records; never touches user files. Callers hold the run lock.
 */
export async function reconcileIntents(file: string): Promise<Reconciled> {
 const out: Reconciled = { recovered: 0, aborted: 0 };
 for (const i of pendingIntents(await readRawHistory(file))) {
  const dst = await lstat(i.destination).catch(() => null), srcThere = await exists(i.source).catch(() => true);
  const landed = !!dst && dst.isFile() && !dst.isSymbolicLink() && dst.size === i.size && (await sha256File(i.destination).catch(() => '')) === i.sha256;
  if (landed && !srcThere) { await appendHistory(file, { v: 1, type: 'commit', id: randomBytes(6).toString('hex'), runId: i.runId, time: new Date().toISOString(), of: i.id, recovered: true }); out.recovered++; }
  else { await appendHistory(file, { v: 1, type: 'abort', id: randomBytes(6).toString('hex'), runId: i.runId, time: new Date().toISOString(), of: i.id, why: landed ? 'source_and_destination_present' : srcThere ? 'rename_did_not_happen' : 'destination_missing_or_changed' }); out.aborted++; }
 }
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
