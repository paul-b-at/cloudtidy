import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';

import { checkModel, type ModelCall, type ModelStatus } from './classifier';
import { type Config } from './config';
import { applyOne, plan, plannedItem, type AnalyzeDeps, type Item, type Planned } from './engine';
import { fingerprint, type RenameOptions } from './fsx';
import { newRunId } from './history';
import { listCandidates, waitForStable, type Skipped } from './ingest';
import { acquireLock } from './lock';
import { log } from './log';
import { notify } from './notify';
import { resolveLayout, type Layout, type SourceKind } from './paths';
import { configFingerprint, DecisionCache, ensureStateDir, stateFiles, writeStatus, type Status } from './state';

export interface RunOptions {
 apply: boolean;
 /** Invoked by launchd (`run --daemon`): moves happen only when `config.daemon.apply` is true. */
 daemon?: boolean;
 useCache?: boolean;
 /** Read-only previews (scan --dry-run) skip the debounce, lock, cache, status and notification. */
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
}
export interface RunReport {
 runId: string; mode: 'dry-run' | 'apply'; context: 'launchd' | 'interactive'; items: Item[]; skipped: Skipped[];
 counts: Record<string, number>; model: ModelStatus | null; locked: boolean; aborted: boolean; inboxReadable: boolean;
}
async function snapshots(files: { name: string; path: string }[]) {
 const out = [];
 for (const f of files) { const snapshot = await fingerprint(f.path); if (snapshot) out.push({ ...f, snapshot }); }
 return out;
}
export const isDaemonContext = (o?: { daemon?: boolean }) => !!o?.daemon || process.env.CLOUDTIDY_CONTEXT === 'launchd';
export const resolveApply = (o: Pick<RunOptions, 'apply' | 'daemon'>, config: Config) => o.apply || (isDaemonContext(o) && config.daemon.apply);
function tally(items: Item[], skipped: Skipped[]): Record<string, number> {
 const c: Record<string, number> = { planned: 0, moved: 0, review: 0, duplicate: 0, skipped: skipped.length, errors: 0 };
 for (const i of items) { if (i.outcome === 'error') c.errors!++; else if (i.outcome === 'skipped') c.skipped!++; else c[i.outcome] = (c[i.outcome] ?? 0) + 1; }
 return c;
}
/** One pass over `_Inbox` (or, for sweep, loose files in the iCloud root). */
export async function runOnce(config: Config, o: RunOptions): Promise<RunReport> {
 const kind = o.kind ?? 'inbox', apply = resolveApply(o, config) && !o.readOnly;
 const report: RunReport = { runId: newRunId(), mode: apply ? 'apply' : 'dry-run', context: process.env.CLOUDTIDY_CONTEXT === 'launchd' || o.daemon ? 'launchd' : 'interactive', items: [], skipped: [], counts: {}, model: null, locked: false, aborted: false, inboxReadable: true };
 const files = stateFiles(config), layout = await resolveLayout(config);
 const lock = o.readOnly ? null : (await ensureStateDir(config), await acquireLock(files.lock, { waitMs: config.lockWaitMs }));
 if (!o.readOnly && !lock) { report.locked = true; log('another cloudtidy process holds the lock; skipping this trigger'); return report; }
 try {
  try { await access(layout.inbox, constants.R_OK); await readdir(layout.inbox); } catch { report.inboxReadable = false; }
  if (!o.readOnly) report.model = await checkModel(config);
  if (!report.inboxReadable) { report.counts = tally([], []); return report; }
  const cand = await listCandidates(layout, config, kind);
  report.skipped.push(...cand.skipped);
  const st = o.readOnly ? { stable: await snapshots(cand.files), skipped: [] as Skipped[] } : await waitForStable(cand.files, config, o.sleep);
  report.skipped.push(...st.skipped);
  const cache = o.useCache === false || o.readOnly ? null : await DecisionCache.load(files.cache, await configFingerprint(config));
  const { planned } = await plan(st.stable, config, { cache, model: o.model, extract: o.extract, sleep: o.sleep });
  await cache?.save();
  const preview = planned.map(plannedItem);
  if (o.confirm && !(await o.confirm(preview))) { report.items = preview; report.aborted = true; report.counts = tally(preview, report.skipped); return report; }
  if (!apply) report.items = preview;
  else {
   const ctx = { layout, config, kind, runId: report.runId, mode: o.mode ?? 'run', historyFile: files.history, rename: o.rename, deviceOf: o.deviceOf };
   for (const p of planned as Planned[]) {
    try { report.items.push(await applyOne(ctx, p)); }
    catch (e) { report.items.push({ ...plannedItem(p), outcome: 'error', detail: 'history_or_io_error' }); log(`aborting run after unexpected error: ${(e as Error).message}`); break; } // e.g. history not writable: stop moving
   }
  }
  report.counts = tally(report.items, report.skipped);
  return report;
 } finally {
  if (!o.readOnly) {
   const s: Status = { v: 1, time: new Date().toISOString(), context: report.context, mode: report.mode, runId: report.runId, model: report.model, inboxReadable: report.inboxReadable, counts: report.counts };
   if (o.mode !== 'sweep') await writeStatus(config, s).catch(() => {});
   if (apply && o.notify !== false && config.daemon.notify) await notify(report.items);
  }
  await lock?.release();
 }
}
