import { basename, join, relative, sep } from 'node:path';
import { INBOX, REVIEW, safeName, type Config, type Route } from './config';
import { callHelper, classify, wantsNaming, type ClassifyDeps, type Decision, type ModelCall, type Tier } from './classifier';
import { ExtractError, extract as realExtract } from './extract';
import { fingerprint, sha256File, type Fingerprint, type RenameOptions } from './fsx';
import { makeJournal, type Outcome } from './history';
import { HelperError } from './process';
import { moveNoClobber } from './mover';
import { targetName } from './naming';
import { type Layout, type SourceKind } from './paths';
import { DecisionCache, HeldStore } from './state';
import { MIN_APPLY_ATTEMPTS, type PendingEntry, type PendingStore } from './pending';

export interface Analysis {
 route: Route | null; tier: Tier; needsReview: boolean; reason: string;
 /** The model was unavailable/busy/timed out: the file stays in `_Inbox` as pending and is retried later. */
 transient: boolean;
 name: string; renamed: boolean; cached: boolean; held: boolean; detail?: string;
 /** Why a file that was supposed to be renamed kept its name (e.g. `naming_sender_unverified`, `naming_model_refusal`). */
 note?: string;
 routeMs?: number; namingMs?: number; modelCalls?: number;
}
export interface AnalyzeDeps extends ClassifyDeps { cache?: DecisionCache | null; held?: HeldStore | null; extract?: (file: string, config: Config) => Promise<string> }
const heldAnalysis = (name: string): Analysis => ({ route: null, tier: 'none', needsReview: true, reason: 'held_after_undo', transient: false, name, renamed: false, cached: true, held: true });
const reviewAnalysis = (name: string, reason: string): Analysis => ({ route: null, tier: 'none', needsReview: true, reason, transient: false, name, renamed: false, cached: false, held: false });
/** Extraction + two-tier classification + deterministic naming. Never touches the filesystem except reading `file`. */
export async function analyze(file: string, name: string, sha256: string | null, config: Config, deps: AnalyzeDeps = {}): Promise<Analysis> {
 if (sha256 && deps.held?.has(sha256, name)) return heldAnalysis(name);
 const hit = sha256 && deps.cache ? deps.cache.get(sha256, name) : null;
 if (hit) {
  const route = hit.route ? config.routes.find(r => r.id === hit.route) ?? null : null;
  if (!hit.route || route) return { route, tier: hit.tier, needsReview: hit.needsReview, reason: hit.reason, transient: false, name: hit.name, renamed: hit.renamed, cached: true, held: false, ...(hit.note ? { note: hit.note } : {}) };
 }
 let d: Decision, text = '';
 if (!safeName(name) || name.includes('~')) d = { route: null, tier: 'none', needsReview: true, reason: 'unsafe_filename', transient: false, documentDate: null, sender: null };
 else {
  try { text = await (deps.extract ?? realExtract)(file, config); d = await classify(name, text, config, deps); }
  catch (e) {
   // An OCR/pdf helper timeout is transient (retry later); a definite extraction failure is a review verdict.
   const timeout = e instanceof HelperError && e.message === 'helper_timeout';
   d = { route: null, tier: 'none', needsReview: !timeout, reason: e instanceof ExtractError ? e.reason : 'extraction_failed', transient: timeout, documentDate: null, sender: null };
  }
 }
 const route = d.route ? config.routes.find(r => r.id === d.route) ?? null : null;
 const named = route && !d.needsReview && !d.transient ? targetName({ filename: name, text, route, documentDate: d.documentDate, sender: d.sender }, config) : { name, renamed: false, reason: '' };
 const note = route && !d.needsReview && !d.transient && !named.renamed && wantsNaming(route, config) ? d.namingReason ?? named.reason : undefined;
 const a: Analysis = { route: d.needsReview || d.transient ? null : route, tier: d.tier, needsReview: !d.transient && (d.needsReview || !route), reason: d.reason, transient: d.transient, name: named.name, renamed: named.renamed, cached: false, held: false, routeMs: d.routeMs, namingMs: d.namingMs, modelCalls: d.modelCalls, ...(note ? { note } : {}) };
 if (sha256 && deps.cache && !a.transient) deps.cache.set(sha256, name, { route: a.route?.id ?? null, name: a.name, tier: a.tier, reason: a.reason, needsReview: a.needsReview, renamed: a.renamed, ...(note ? { note } : {}) });
 return a;
}

export type ItemOutcome = 'planned' | 'moved' | 'review' | 'duplicate' | 'pending' | 'skipped' | 'error';
export interface Item {
 file: string; action: 'move' | 'review' | 'defer'; outcome: ItemOutcome; route: string | null; tier: Tier; reason: string;
 /** Path relative to the iCloud root where the file goes (planned) or went (applied). */
 destination: string; renamed: boolean; cached: boolean; sha256: string; size: number; detail?: string;
}
export interface Planned { name: string; path: string; snapshot: Fingerprint; sha256: string; analysis: Analysis }
const rel = (...p: string[]) => p.join('/');
export const plannedItem = (p: Planned): Item => p.analysis.held
 ? { file: p.name, action: 'defer', outcome: 'skipped', route: null, tier: 'none', reason: p.analysis.reason, destination: rel(INBOX, p.name), renamed: false, cached: true, sha256: p.sha256, size: p.snapshot.size, detail: 'held_after_undo' } // stays where it is (applyOne agrees); a dry run must not promise a move to Needs_Review
 : p.analysis.transient
 ? { file: p.name, action: 'defer', outcome: 'pending', route: null, tier: p.analysis.tier, reason: p.analysis.reason, destination: rel(INBOX, p.name), renamed: false, cached: false, sha256: p.sha256, size: p.snapshot.size, ...(p.analysis.detail ? { detail: p.analysis.detail } : {}) }
 : {
 file: p.name, action: p.analysis.needsReview ? 'review' : 'move', outcome: 'planned', route: p.analysis.route?.id ?? null, tier: p.analysis.tier, reason: p.analysis.reason,
 destination: p.analysis.needsReview ? rel(INBOX, REVIEW, p.name) : rel(p.analysis.route!.folder, p.analysis.name), renamed: p.analysis.renamed, cached: p.analysis.cached, sha256: p.sha256, size: p.snapshot.size,
 ...(p.analysis.note && !p.analysis.needsReview ? { detail: p.analysis.note } : {})
};
/** `apply`: this run may move files. Only apply-mode attempts count towards the give-up rule (pending.ts); dry-runs never expire a file. */
export interface PlanDeps extends AnalyzeDeps { pending?: PendingStore | null; modelAvailable?: boolean; apply?: boolean }
/** The retry/give-up schedule for a file that needs the model (see pending.ts). */
function deferDetail(config: Config, e: PendingEntry): string {
 const next = `next try ${new Date(e.next).toISOString().slice(11, 16)}Z`;
 const n = e.applyAttempts ?? 0;
 if (e.applySince === undefined) return `attempt ${e.attempts}; ${next}; the ${config.model.maxDeferHours} h limit starts with the first run that applies`;
 const left = Math.max(0, Math.round((e.applySince + config.model.maxDeferHours * 3_600_000 - Date.now()) / 3_600_000));
 return `attempt ${n}; ${next}; goes to Needs_Review after ~${left}h and at least ${MIN_APPLY_ATTEMPTS} attempts, only if the model still fails then`;
}
export async function plan(files: { name: string; path: string; snapshot: Fingerprint }[], config: Config, deps: PlanDeps): Promise<{ planned: Planned[]; gone: string[] }> {
 const planned: Planned[] = [], gone: string[] = [], pend = deps.pending;
 // Per-run circuit breaker: once the model failed transiently (timeout, unavailable, busy, crashed), later files in this run are not sent to it.
 // Without it a hung helper costs (classifierRetries + 1) x timeoutMs for EVERY file, with the run lock held.
 const inner: ModelCall = deps.model ?? callHelper; let tripped: HelperError | null = null;
 let reached = false, skipped = false; // reached: THIS file made a real helper call in this run; skipped: the open breaker answered instead of the model
 const direct: ModelCall = async (...args) => { reached = true; return inner(...args); }; // expired entries: always a real call, never the breaker
 const breaker: ModelCall = async (...args) => { if (tripped) { skipped = true; throw new HelperError(tripped.message, tripped.exitCode, null, true); } reached = true; return inner(...args); };
 const MODEL_DOWN: Record<string, [string, number | null]> = { model_timeout: ['helper_timeout', null], model_unavailable: ['helper_unavailable', null], model_busy: ['helper_failed', 4], model_crashed: ['helper_failed', null] };
 for (const f of files) {
  let sha: string;
  try { sha = await sha256File(f.path); } catch { gone.push(f.name); continue; }
  const now = await fingerprint(f.path);
  if (!now || now.size !== f.snapshot.size || now.mtimeMs !== f.snapshot.mtimeMs || now.ino !== f.snapshot.ino) { gone.push(f.name); continue; }
  const add = (analysis: Analysis) => planned.push({ ...f, sha256: sha, analysis });
  if (f.snapshot.size === 0) { pend?.clear(f.name); add(reviewAnalysis(f.name, 'empty_file')); continue; } // grace period already elapsed (run.ts)
  const e = pend?.get(f.name), mine = e && e.kind === 'model' && e.sha256 === sha ? e : undefined;
  if (pend && mine && !(deps.apply && pend.expired(mine, config)) && !pend.due(mine, !!deps.modelAvailable)) { // waiting for the backoff: no model call
   add({ ...reviewAnalysis(f.name, mine.reason), needsReview: false, transient: true, detail: deferDetail(config, mine) });
   continue;
  }
  // An expired entry is NOT a verdict by itself (dry-run runs, a closed laptop or a long outage age it without any attempt): it gets exactly ONE real helper call in this run
  // (bypassing an open breaker, no retries, so a hung helper costs at most 1 x timeoutMs per expired file) and only a transient failure of THAT call sends it to review.
  const wasExpired = !!(deps.apply && mine && pend?.expired(mine, config));
  reached = false; skipped = false;
  let a = await analyze(f.path, f.name, sha, wasExpired ? { ...config, classifierRetries: 0 } : config, { ...deps, model: wasExpired ? direct : breaker });
  if (a.transient && !tripped && reached && MODEL_DOWN[a.reason]) tripped = new HelperError(...MODEL_DOWN[a.reason]!); // this file really asked and already used its retries: stop asking for the rest of the run
  if (a.transient && pend) {
   if (!skipped) { // an attempt = a real helper call OR any other transient failure that is the file's own (an OCR/pdftotext timeout): it backs off and may expire. Only the breaker's answer is not an attempt
    const ent = pend.touch(f.name, 'model', a.reason, { sha256: sha, attempt: true, apply: !!deps.apply });
    a = wasExpired ? reviewAnalysis(f.name, `deferred_too_long:${a.reason}`) : { ...a, detail: deferDetail(config, ent) };
   } else { // answered by the open breaker: not an attempt (no applyAttempts, no applySince, no backoff growth); the file stays pending and is asked on the next due run
    const ent = pend.touch(f.name, 'model', a.reason, { sha256: sha, attempt: false, apply: !!deps.apply });
    a = { ...a, detail: `not asked this run (the model failed earlier in this run); ${deferDetail(config, ent)}` };
   }
  } else if (!a.transient) pend?.clear(f.name);
  add(a);
 }
 return { planned, gone };
}
export interface ApplyCtx { layout: Layout; config: Config; kind: SourceKind; runId: string; mode: 'run' | 'sweep'; historyFile: string; rename?: RenameOptions; deviceOf?: (dir: string) => Promise<number> }
/** Applies one planned item. Every move is journaled write-ahead (intent before the rename, commit after it). */
export async function applyOne(ctx: ApplyCtx, p: Planned): Promise<Item> {
 const base = plannedItem(p);
 const journal = (outcome: Outcome, reason: string) => makeJournal(ctx.historyFile, { runId: ctx.runId, mode: ctx.mode, source: p.path, sha256: p.sha256, size: p.snapshot.size, ino: p.snapshot.ino, route: p.analysis.route?.id ?? null, tier: p.analysis.tier, outcome, reason: outcome === 'moved' && p.analysis.note ? `${reason}:${p.analysis.note}` : reason, renamed: outcome === 'moved' && p.analysis.renamed });
 const toReview = async (reason: string, outcome: 'review' | 'duplicate', detail?: string): Promise<Item> => {
  const r = await moveNoClobber({ layout: ctx.layout, config: ctx.config, kind: ctx.kind, src: p.path, snapshot: p.snapshot, sha256: p.sha256, destDir: ctx.layout.review, name: p.name, rename: ctx.rename, deviceOf: ctx.deviceOf, journal: journal(outcome, reason) });
  if (r.kind === 'moved') return { ...base, action: 'review', outcome, reason, destination: rel(INBOX, REVIEW, basename(r.to)), ...(detail ? { detail } : {}) };
  if (r.kind === 'duplicate') return { ...base, action: 'review', outcome: 'skipped', reason, detail: 'identical_file_already_in_review' };
  if (r.reason === 'folder_missing') return { ...base, action: 'review', outcome: 'error', reason, detail: r.detail ?? 'folder_missing' }; // Needs_Review itself is missing: the file stays where it is, and this is reported (run `init --yes`)
  return { ...base, action: 'review', outcome: r.reason === 'source_changed' || r.reason === 'source_missing' ? 'skipped' : 'error', reason, detail: r.reason };
 };
 const a = p.analysis;
 if (a.held) return { ...base, outcome: 'skipped', detail: 'held_after_undo' };
 if (a.transient) return base;
 if (a.needsReview) return toReview(a.reason, 'review');
 const r = await moveNoClobber({ layout: ctx.layout, config: ctx.config, kind: ctx.kind, src: p.path, snapshot: p.snapshot, sha256: p.sha256, destDir: join(ctx.layout.root, ...a.route!.folder.split('/')), name: a.name, rename: ctx.rename, deviceOf: ctx.deviceOf, journal: journal('moved', a.reason) });
 if (r.kind === 'moved') return { ...base, outcome: 'moved', destination: rel(a.route!.folder, basename(r.to)) };
 if (r.kind === 'duplicate') { const existing = relative(ctx.layout.root, r.existing).split(sep).join('/'); return toReview(`duplicate_of_existing:${existing}`, 'duplicate', `same content as ${existing}`); } // names the file that is already there
 if (r.reason === 'exdev' || r.reason === 'destination_unsafe' || r.reason === 'name_exhausted') return toReview(r.reason, 'review');
 if (r.reason === 'folder_missing') return toReview(r.detail ?? 'folder_missing', 'review'); // reason: folder_missing:<relative path>
 return { ...base, outcome: r.reason === 'source_changed' || r.reason === 'source_missing' ? 'skipped' : 'error', detail: r.reason };
}
