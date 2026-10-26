import { basename, join } from 'node:path';
import { INBOX, REVIEW, safeName, type Config, type Route } from './config';
import { classify, type ClassifyDeps, type Decision, type Tier } from './classifier';
import { ExtractError, extract as realExtract } from './extract';
import { fingerprint, sha256File, type Fingerprint, type RenameOptions } from './fsx';
import { appendHistory, type Outcome } from './history';
import { moveNoClobber } from './mover';
import { targetName } from './naming';
import { type Layout, type SourceKind } from './paths';
import { DecisionCache } from './state';

export interface Analysis { route: Route | null; tier: Tier; needsReview: boolean; reason: string; transient: boolean; name: string; renamed: boolean; cached: boolean; held: boolean }
export interface AnalyzeDeps extends ClassifyDeps { cache?: DecisionCache | null; extract?: (file: string, config: Config) => Promise<string> }
const heldAnalysis = (name: string): Analysis => ({ route: null, tier: 'none', needsReview: true, reason: 'held_after_undo', transient: false, name, renamed: false, cached: true, held: true });
/** Extraction + two-tier classification + deterministic naming. Never touches the filesystem except reading `file`. */
export async function analyze(file: string, name: string, sha256: string | null, config: Config, deps: AnalyzeDeps = {}): Promise<Analysis> {
 const hit = sha256 && deps.cache ? deps.cache.get(sha256, name) : null;
 if (hit) {
  if (hit.held) return heldAnalysis(name);
  const route = hit.route ? config.routes.find(r => r.id === hit.route) ?? null : null;
  if (!hit.route || route) return { route, tier: hit.tier, needsReview: hit.needsReview, reason: hit.reason, transient: hit.transient, name: hit.name, renamed: hit.renamed, cached: true, held: false };
 }
 let d: Decision, text = '';
 if (!safeName(name) || name.includes('~')) d = { route: null, tier: 'none', needsReview: true, reason: 'unsafe_filename', transient: false, documentDate: null, sender: null };
 else {
  try { text = await (deps.extract ?? realExtract)(file, config); d = await classify(name, text, config, deps); }
  catch (e) { d = { route: null, tier: 'none', needsReview: true, reason: e instanceof ExtractError ? e.reason : 'extraction_failed', transient: false, documentDate: null, sender: null }; }
 }
 const route = d.route ? config.routes.find(r => r.id === d.route) ?? null : null;
 const named = route && !d.needsReview ? targetName({ filename: name, text, route, documentDate: d.documentDate, sender: d.sender }, config) : { name, renamed: false, reason: '' };
 const a: Analysis = { route: d.needsReview ? null : route, tier: d.tier, needsReview: d.needsReview || !route, reason: d.reason, transient: d.transient, name: named.name, renamed: named.renamed, cached: false, held: false };
 if (sha256 && deps.cache) deps.cache.set(sha256, name, { route: a.route?.id ?? null, name: a.name, tier: a.tier, reason: a.reason, needsReview: a.needsReview, renamed: a.renamed, transient: a.transient });
 return a;
}

export type ItemOutcome = 'planned' | 'moved' | 'review' | 'duplicate' | 'skipped' | 'error';
export interface Item {
 file: string; action: 'move' | 'review'; outcome: ItemOutcome; route: string | null; tier: Tier; reason: string;
 /** Path relative to the iCloud root where the file goes (planned) or went (applied). */
 destination: string; renamed: boolean; cached: boolean; sha256: string; size: number; detail?: string;
}
export interface Planned { name: string; path: string; snapshot: Fingerprint; sha256: string; analysis: Analysis }
const rel = (...p: string[]) => p.join('/');
export const plannedItem = (p: Planned): Item => ({
 file: p.name, action: p.analysis.needsReview ? 'review' : 'move', outcome: 'planned', route: p.analysis.route?.id ?? null, tier: p.analysis.tier, reason: p.analysis.reason,
 destination: p.analysis.needsReview ? rel(INBOX, REVIEW, p.name) : rel(p.analysis.route!.folder, p.analysis.name), renamed: p.analysis.renamed, cached: p.analysis.cached, sha256: p.sha256, size: p.snapshot.size
});
export async function plan(files: { name: string; path: string; snapshot: Fingerprint }[], config: Config, deps: AnalyzeDeps): Promise<{ planned: Planned[]; gone: string[] }> {
 const planned: Planned[] = [], gone: string[] = [];
 for (const f of files) {
  let sha: string;
  try { sha = await sha256File(f.path); } catch { gone.push(f.name); continue; }
  const now = await fingerprint(f.path);
  if (!now || now.size !== f.snapshot.size || now.mtimeMs !== f.snapshot.mtimeMs || now.ino !== f.snapshot.ino) { gone.push(f.name); continue; }
  planned.push({ ...f, sha256: sha, analysis: await analyze(f.path, f.name, sha, config, deps) });
 }
 return { planned, gone };
}
export interface ApplyCtx { layout: Layout; config: Config; kind: SourceKind; runId: string; mode: 'run' | 'sweep'; historyFile: string; rename?: RenameOptions; deviceOf?: (dir: string) => Promise<number> }
/** Applies one planned item. Every successful move is journaled to the audit history immediately. */
export async function applyOne(ctx: ApplyCtx, p: Planned): Promise<Item> {
 const base = plannedItem(p);
 const record = async (to: string, outcome: Outcome, reason: string) => {
  await appendHistory(ctx.historyFile, { v: 1, type: 'move', id: crypto.randomUUID().slice(0, 12), runId: ctx.runId, time: new Date().toISOString(), mode: ctx.mode, source: p.path, destination: to, sha256: p.sha256, size: p.snapshot.size, route: p.analysis.route?.id ?? null, tier: p.analysis.tier, outcome, reason, renamed: outcome === 'moved' && p.analysis.renamed });
 };
 const toReview = async (reason: string, outcome: 'review' | 'duplicate'): Promise<Item> => {
  const r = await moveNoClobber({ layout: ctx.layout, config: ctx.config, kind: ctx.kind, src: p.path, snapshot: p.snapshot, sha256: p.sha256, destDir: ctx.layout.review, name: p.name, rename: ctx.rename, deviceOf: ctx.deviceOf });
  if (r.kind === 'moved') { await record(r.to, outcome, reason); return { ...base, action: 'review', outcome, reason, destination: rel(INBOX, REVIEW, basename(r.to)) }; }
  if (r.kind === 'duplicate') return { ...base, action: 'review', outcome: 'skipped', reason, detail: 'identical_file_already_in_review' };
  return { ...base, action: 'review', outcome: r.reason === 'source_changed' || r.reason === 'source_missing' ? 'skipped' : 'error', reason, detail: r.reason };
 };
 const a = p.analysis;
 if (a.held) return { ...base, outcome: 'skipped', detail: 'held_after_undo' };
 if (a.needsReview) return toReview(a.reason, 'review');
 const r = await moveNoClobber({ layout: ctx.layout, config: ctx.config, kind: ctx.kind, src: p.path, snapshot: p.snapshot, sha256: p.sha256, destDir: join(ctx.layout.root, ...a.route!.folder.split('/')), name: a.name, rename: ctx.rename, deviceOf: ctx.deviceOf });
 if (r.kind === 'moved') { await record(r.to, 'moved', a.reason); return { ...base, outcome: 'moved', destination: rel(a.route!.folder, basename(r.to)) }; }
 if (r.kind === 'duplicate') return toReview('duplicate_of_existing', 'duplicate');
 if (r.reason === 'exdev' || r.reason === 'destination_unsafe' || r.reason === 'name_exhausted') return toReview(r.reason, 'review');
 return { ...base, outcome: r.reason === 'source_changed' || r.reason === 'source_missing' ? 'skipped' : 'error', detail: r.reason };
}
