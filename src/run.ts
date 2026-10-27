import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';

import { checkModel, type ModelCall, type ModelStatus } from './classifier';
import { type Config } from './config';
import { applyOne, plan, plannedItem, type AnalyzeDeps, type Item, type Planned } from './engine';
import { INBOX } from './config';
import { type RenameOptions } from './fsx';
import { HistoryWriteError, newRunId, reconcileIntents, type Reconciled } from './history';
import { listCandidates, waitForStable, type Skipped } from './ingest';
import { acquireLock } from './lock';
import { log } from './log';
import { notify } from './notify';
import { PendingStore, type PendingEntry } from './pending';
import { assertApplyAllowed, resolveLayout, type SourceKind } from './paths';
import { configFingerprint, DecisionCache, ensureStateDir, HeldStore, stateFiles, writeStatus, type Status } from './state';

export interface RunOptions {
 apply: boolean;
 /** Invoked by launchd (`run --daemon`): moves happen only when `config.daemon.apply` is true. */
 daemon?: boolean;
 useCache?: boolean;
 /** Read-only previews (scan --dry-run) take no lock and write no state (cache, pending, status, notification); the debounce still runs. */
 readOnly?: boolean;
 kind?: SourceKind;
 mode?: 'run' | 'sweep';
 sleep?: (ms: number) => Promise<unknown>;
 model?: ModelCall;
 extract?: AnalyzeDeps['extract'];
 rename?: RenameOptions;
 deviceOf?: (dir: string) => Promise<number>;
 /** Called between planning and applying; return false to abort (sweep confirmation). */
 confirm?: (planned: Item[]) => Promise<boolean>;
 notify?: boolean;
 /** Clock for the pending/backoff/grace logic (tests). */
 now?: () => number;
}
export interface RunReport {
 runId: string; mode: 'dry-run' | 'apply'; context: 'launchd' | 'interactive'; items: Item[]; skipped: Skipped[];
 counts: Record<string, number>; model: ModelStatus | null; locked: boolean; aborted: boolean; inboxReadable: boolean;
 /** Journal entries recovered/aborted after a crash between intent and commit (apply runs only). */
 recovered: Reconciled;
}
export const isDaemonContext = (o?: { daemon?: boolean }) => !!o?.daemon || process.env.CLOUDTIDY_CONTEXT === 'launchd';
export const resolveApply = (o: Pick<RunOptions, 'apply' | 'daemon'>, config: Config) => o.apply || (isDaemonContext(o) && config.daemon.apply);
function tally(items: Item[], skipped: Skipped[]): Record<string, number> {
 const c: Record<string, number> = { planned: 0, moved: 0, review: 0, duplicate: 0, pending: 0, skipped: skipped.length, errors: 0 };
 for (const i of items) { if (i.outcome === 'error') c.errors!++; else if (i.outcome === 'skipped') c.skipped!++; else c[i.outcome] = (c[i.outcome] ?? 0) + 1; }
 return c;
}
const pendingItem = (name: string, e: Pick<PendingEntry, 'reason' | 'detail'>): Item => ({ file: name, action: 'defer', outcome: 'pending', route: null, tier: 'none', reason: e.reason, destination: `${INBOX}/${name}`, renamed: false, cached: false, sha256: '', size: 0, ...(e.detail ? { detail: e.detail } : {}) });
/** One pass over `_Inbox` (or, for sweep, loose files in the iCloud root). */
export async function runOnce(config: Config, o: RunOptions): Promise<RunReport> {
 const kind = o.kind ?? 'inbox', apply = resolveApply(o, config) && !o.readOnly;
 const report: RunReport = { runId: newRunId(), mode: apply ? 'apply' : 'dry-run', context: process.env.CLOUDTIDY_CONTEXT === 'launchd' || o.daemon ? 'launchd' : 'interactive', items: [], skipped: [], counts: {}, model: null, locked: false, aborted: false, inboxReadable: true, recovered: { recovered: 0, aborted: 0 } };
 const files = stateFiles(config), layout = await resolveLayout(config);
 if (apply) await assertApplyAllowed(layout, config); // never move files outside iCloud Drive unless the config says so explicitly
 const lock = o.readOnly ? null : (await ensureStateDir(config), await acquireLock(files.lock, { waitMs: config.lockWaitMs }));
 if (!o.readOnly && !lock) { report.locked = true; log('another cloudtidy process holds the lock; skipping this trigger'); return report; }
 let pending: PendingStore | null = null, held: HeldStore | null = null;
 try {
  try { await access(layout.inbox, constants.R_OK); await readdir(layout.inbox); } catch { report.inboxReadable = false; }
  if (!o.readOnly) report.model = await checkModel(config);
  if (!report.inboxReadable) { report.counts = tally([], []); return report; }
  if (apply) {
   // crash recovery: dangling write-ahead intents become commits or aborts. An unreadable history is not fatal here: the first move's intent write fails and stops the run.
   report.recovered = await reconcileIntents(files.history).catch(e => { log(`history not readable: ${(e as Error).message}`); return { recovered: 0, aborted: 0 }; });
   if (report.recovered.recovered || report.recovered.aborted) log(`history reconciled: ${report.recovered.recovered} recovered, ${report.recovered.aborted} aborted`);
  }
  const cand = await listCandidates(layout, config, kind);
  report.skipped.push(...cand.skipped);
  // Sweep sees the root, not _Inbox: its pending bookkeeping is in memory only, so it can never clobber the inbox's pending state.
  pending = await PendingStore.load(kind === 'inbox' ? files.pending : null, o.now);
  const st = await waitForStable(cand.files, config, o.sleep);
  pending.retainOnly(cand.files.map(f => f.name));
  const pendItems: Item[] = [];
  for (const u of st.unstable) { const e = pending.touch(u.name, 'unstable', 'unstable', { detail: 'still changing; checked again on the next run' }); pendItems.push(pendingItem(u.name, e)); }
  const ready = [];
  for (const f of st.stable) {
   if (f.snapshot.size > 0) { const e = pending.get(f.name); if (e && e.kind !== 'model') pending.clear(f.name); ready.push(f); continue; }
   // Empty file: probably still being written or synced. Pending until it has stayed empty for the grace period, then review.
   const e = pending.get(f.name)?.kind === 'empty' ? pending.get(f.name)! : pending.touch(f.name, 'empty', 'empty_file', { detail: `empty; goes to Needs_Review if still empty after ${config.emptyGraceMinutes} min` });
   if (pending.graceElapsed(e, config)) ready.push(f); else pendItems.push(pendingItem(f.name, e));
  }
  const cache = o.useCache === false || o.readOnly ? null : await DecisionCache.load(files.cache, await configFingerprint(config));
  held = await HeldStore.load(files.held);
  const { planned } = await plan(ready, config, { cache, held: o.useCache === false ? null : held, extract: o.extract, model: o.model, sleep: o.sleep, pending, modelAvailable: !!report.model?.available });
  await cache?.save();
  if (o.useCache === false && !o.readOnly) { for (const p of planned) held.release(p.sha256, p.name); await held.save(); } // --no-cache releases undo holds for the files it re-examines
  const preview = [...planned.map(plannedItem), ...pendItems];
  if (o.confirm && !(await o.confirm(preview))) { report.items = preview; report.aborted = true; report.counts = tally(preview, report.skipped); return report; }
  if (!apply) report.items = preview;
  else {
   const ctx = { layout, config, kind, runId: report.runId, mode: o.mode ?? 'run', historyFile: files.history, rename: o.rename, deviceOf: o.deviceOf };
   for (const p of planned as Planned[]) {
    try { report.items.push(await applyOne(ctx, p)); }
    catch (e) {
     report.items.push({ ...plannedItem(p), outcome: 'error', detail: 'history_or_io_error' });
     if (e instanceof HistoryWriteError) { log(`aborting run: ${e.message}`); break; } // history not writable: stop moving
     log(`error on one file, continuing: ${(e as Error).message}`); // one poisoned file must not starve every later file on every run
    }
   }
   report.items.push(...pendItems);
  }
  report.counts = tally(report.items, report.skipped);
  return report;
 } finally {
  if (!o.readOnly) {
   await pending?.save().catch(() => {});
   const s: Status = { v: 1, time: new Date().toISOString(), context: report.context, mode: report.mode, runId: report.runId, model: report.model, inboxReadable: report.inboxReadable, counts: report.counts };
   if (o.mode !== 'sweep') await writeStatus(config, s).catch(() => {});
   if (apply && o.notify !== false && config.daemon.notify) await notify(report.items);
  }
  await lock?.release();
 }
}
