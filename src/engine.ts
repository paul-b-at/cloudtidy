import { basename, join, relative, sep } from 'node:path';
import { INBOX, REVIEW, safeName, type Config, type Route } from './config';
import { callHelper, classify, explainRules, formatRuleTrace, wantsNaming, type ClassifyDeps, type Decision, type ModelCall, type Tier } from './classifier';
import { ExtractError, extract as realExtract } from './extract';
import { fingerprint, sha256File, type Fingerprint, type RenameOptions } from './fsx';
import { makeJournal, type Outcome } from './history';
import { HelperError, cleanDiag, helperState } from './process';
import { moveNoClobber } from './mover';
import { targetName } from './naming';
import { assertDestDir, FOLDER_MISSING, UnsafePathError, type Layout, type SourceKind } from './paths';
import { DecisionCache, HeldStore } from './state';
import { BUSY_CAP, MIN_APPLY_ATTEMPTS, type PendingEntry, type PendingStore } from './pending';

export interface Analysis {
 /** Only with `deps.trace`: which routes matched in the file name vs the text (keywords sanitized), for local CLI output. */
 rules?: string;
 route: Route | null; tier: Tier; needsReview: boolean; reason: string;
 /** The model was unavailable/busy/timed out: the file stays in `_Inbox` as pending and is retried later. */
 transient: boolean;
 name: string; renamed: boolean; cached: boolean; held: boolean; detail?: string;
 /** Why a file that was supposed to be renamed kept its name (e.g. `naming_sender_unverified`, `naming_model_refusal`). */
 note?: string;
 routeMs?: number; namingMs?: number; modelCalls?: number;
}
export interface AnalyzeDeps extends ClassifyDeps { cache?: DecisionCache | null; held?: HeldStore | null; extract?: (file: string, config: Config) => Promise<string>; /** Diagnostics for local CLI output (`classify <file>`, `eval --verbose`): attach the Tier-1 keyword trace. Never persisted. */ trace?: boolean }
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
   // A missing / non-executable OCR helper is a configuration problem, not a verdict on the document: the file stays pending (retried at once when the helper appears, given up on only after maxDeferHours of apply runs).
   if (e instanceof HelperError && e.message === 'helper_missing') { const st = (e.diag ?? 'ocr:missing').split(':')[1]; d = { route: null, tier: 'none', needsReview: false, reason: st === 'missing' ? 'ocr_helper_missing' : `ocr_helper_missing:${cleanDiag(st ?? 'missing', 20)}`, transient: true, documentDate: null, sender: null }; }
   else
   d = { route: null, tier: 'none', needsReview: !timeout, reason: e instanceof ExtractError ? e.reason : !timeout && typeof (e as NodeJS.ErrnoException)?.code === 'string' ? `extraction_failed:${cleanDiag((e as NodeJS.ErrnoException).code!, 40)}` : 'extraction_failed', transient: timeout, documentDate: null, sender: null };
  }
 }
 const route = d.route ? config.routes.find(r => r.id === d.route) ?? null : null;
 const named = route && !d.needsReview && !d.transient ? targetName({ filename: name, text, route, documentDate: d.documentDate, sender: d.sender }, config) : { name, renamed: false, reason: '' };
 const note = route && !d.needsReview && !d.transient && !named.renamed && wantsNaming(route, config) ? d.namingReason ?? named.reason : undefined;
 const a: Analysis = { route: d.needsReview || d.transient ? null : route, tier: d.tier, needsReview: !d.transient && (d.needsReview || !route), reason: d.reason, transient: d.transient, name: named.name, renamed: named.renamed, cached: false, held: false, routeMs: d.routeMs, namingMs: d.namingMs, modelCalls: d.modelCalls, ...(note ? { note } : {}), ...(deps.trace && text ? { rules: formatRuleTrace(explainRules(name, text, config)) } : {}) };
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
export interface PlanDeps extends AnalyzeDeps { pending?: PendingStore | null; modelAvailable?: boolean; apply?: boolean; /** Run time budget: checked before STARTING each file. */ budget?: { ms: number; elapsed: () => number } }
/** The retry/give-up schedule for a file that needs the model (see pending.ts). */
/** Past the maxDeferHours limit and enough apply attempts made: the next due attempt is the final one. */
const more0 = (e: PendingEntry, config: Config) => e.applySince !== undefined && (e.applyAttempts ?? 0) >= MIN_APPLY_ATTEMPTS && e.lastSeen - e.applySince >= config.model.maxDeferHours * 3_600_000;
function deferDetail(config: Config, e: PendingEntry): string {
 const next = `next try ${new Date(e.next).toISOString().slice(11, 16)}Z`;
 const n = e.applyAttempts ?? 0;
 if (e.applySince === undefined) return `attempt ${e.attempts}; ${next}; the ${config.model.maxDeferHours} h limit starts with the first run that applies`;
 if (e.reason === 'model_busy' && more0(e, config)) { const capH = Math.max(1, Math.round((e.applySince + BUSY_CAP * config.model.maxDeferHours * 3_600_000 - e.lastSeen) / 3_600_000)); return `attempt ${n}; ${next}; the model was busy at the final call, so the file stays pending; it goes to Needs_Review if the model is still busy after ~${capH} h, or when another attempt fails for any other reason`; }
 const leftMs = e.applySince + config.model.maxDeferHours * 3_600_000 - e.lastSeen, more = Math.max(0, MIN_APPLY_ATTEMPTS - n);
 const when = leftMs > 0 ? `after ~${Math.max(1, Math.round(leftMs / 3_600_000))} h${more ? ` and ${more} more attempt${more === 1 ? '' : 's'}` : ''}` : more ? `once ${more} more attempt${more === 1 ? ' has' : 's have'} been made (the ${config.model.maxDeferHours} h are over)` : 'at the next attempt';
 return `attempt ${n}; ${next}; goes to Needs_Review ${when}, only if the model still fails then`;
}
/** A file the open breaker answered for: not asked, not counted. */
const skippedDetail = (e: PendingEntry) => `model failed earlier in this run, not counted as an attempt${e.applyAttempts ? ` (${e.applyAttempts} so far)` : ''}; asked again on the next due run`;
export async function plan(files: { name: string; path: string; snapshot: Fingerprint }[], config: Config, deps: PlanDeps): Promise<{ planned: Planned[]; gone: string[]; left: number }> {
 const planned: Planned[] = [], gone: string[] = [], pend = deps.pending; let left = 0;
 // Per-run circuit breaker: once the model failed transiently (timeout, unavailable, busy, crashed), later files in this run are not sent to it.
 // Without it a hung helper costs (classifierRetries + 1) x timeoutMs for EVERY file, with the run lock held.
 const inner: ModelCall = deps.model ?? callHelper; let tripped: HelperError | null = null;
 let reached = false, skipped = false; // reached: THIS file made a real helper call in this run; skipped: the open breaker answered instead of the model
 const direct: ModelCall = async (...args) => { reached = true; return inner(...args); }; // expired entries: always a real call, never the breaker
 const breaker: ModelCall = async (...args) => { if (tripped) { skipped = true; throw new HelperError(tripped.message, tripped.exitCode, null, true, tripped.diag); } reached = true; return inner(...args); };
 const MODEL_DOWN: Record<string, [string, number | null]> = { classifier_helper_missing: ['helper_unavailable', null], model_timeout: ['helper_timeout', null], model_unavailable: ['helper_unavailable', null], model_busy: ['helper_failed', 4], model_crashed: ['helper_failed', null] };
 for (const f of files) {
  // Time budget: checked before a file is STARTED. Once spent, the rest is left completely untouched (no pending change, no attempt, no review): it is simply next in line.
  if (deps.budget && deps.budget.elapsed() >= deps.budget.ms) { left++; continue; }
  let sha: string;
  try { sha = await sha256File(f.path); } catch { gone.push(f.name); continue; }
  const now = await fingerprint(f.path);
  if (!now || now.size !== f.snapshot.size || now.mtimeMs !== f.snapshot.mtimeMs || now.ino !== f.snapshot.ino) { gone.push(f.name); continue; }
  const add = (analysis: Analysis) => planned.push({ ...f, sha256: sha, analysis });
  if (f.snapshot.size === 0) { pend?.clear(f.name); add(reviewAnalysis(f.name, 'empty_file')); continue; } // grace period already elapsed (run.ts)
  const e = pend?.get(f.name), mine = e && e.kind === 'model' && e.sha256 === sha ? e : undefined;
  // An OCR helper that was missing and is there now: retry at once instead of waiting out the backoff.
  const ocrBack = !!mine && mine.reason.startsWith('ocr_helper_missing') && (await helperState(config.ocr)) === 'ok';
  if (pend && mine && !ocrBack && !(deps.apply && pend.expired(mine, config) && mine.reason !== 'model_busy') && !pend.due(mine, !!deps.modelAvailable)) { // waiting for the backoff: no model call. An expired entry bypasses it (one final call), except after a `model_busy` final call: that keeps its backoff, otherwise it would be re-asked on every run and starve the files behind it
   add({ ...reviewAnalysis(f.name, mine.reason), needsReview: false, transient: true, detail: deferDetail(config, mine) });
   continue;
  }
  // An expired entry is NOT a verdict by itself (dry-run runs, a closed laptop or a long outage age it without any attempt): it gets exactly ONE real helper call in this run
  // (bypassing an open breaker, no retries, so a hung helper costs at most 1 x timeoutMs per expired file) and only a transient failure of THAT call sends it to review.
  const wasExpired = !!(deps.apply && mine && pend?.expired(mine, config));
  reached = false; skipped = false;
  let a = await analyze(f.path, f.name, sha, wasExpired ? { ...config, classifierRetries: 0 } : config, { ...deps, model: wasExpired ? direct : breaker });
  if (a.transient && !tripped && reached && MODEL_DOWN[a.reason]) tripped = new HelperError(...MODEL_DOWN[a.reason]!, null, false, a.reason.startsWith('classifier_helper_missing') ? 'classifier_helper_missing:missing' : null); // this file really asked and already used its retries: stop asking for the rest of the run
  if (a.transient && pend) {
   if (!skipped) { // an attempt = a real helper call OR any other transient failure that is the file's own (an OCR/pdftotext timeout): it backs off and may expire. Only the breaker's answer is not an attempt
    const ent = pend.touch(f.name, 'model', a.reason, { sha256: sha, attempt: true, apply: !!deps.apply });
    a = wasExpired && (a.reason !== 'model_busy' || pend.hardExpired(ent, config)) ? reviewAnalysis(f.name, `deferred_too_long:${a.reason}`) : { ...a, detail: deferDetail(config, ent) }; // `model_busy` on the final call says nothing about the file: it counts as an attempt but stays pending (until BUSY_CAP x maxDeferHours, then review)
   } else { // answered by the open breaker: not an attempt (no applyAttempts, no applySince, no backoff growth); the file stays pending and is asked on the next due run
    const ent = pend.touch(f.name, 'model', a.reason, { sha256: sha, attempt: false, apply: !!deps.apply });
    a = { ...a, detail: skippedDetail(ent) };
   }
  } else if (!a.transient) pend?.clear(f.name);
  add(a);
 }
 return { planned, gone, left };
}
/**
 * What `--apply` would do, as far as the destination goes: a move into a folder that does not exist (or is unsafe) becomes the same review
 * the mover would produce (`folder_missing:<path>`, `destination_unsafe`). A missing Needs_Review is reported, not hidden.
 */
export async function previewItem(layout: Layout, config: Config, p: Planned): Promise<Item> {
 const item = plannedItem(p), a = p.analysis;
 if (item.outcome !== 'planned') return item;
 const check = async (dir: string): Promise<string | null> => { try { await assertDestDir(layout, config, dir); return null; } catch (e) { return e instanceof UnsafePathError ? e.reason : `destination_unreadable:${(e as NodeJS.ErrnoException).code ?? 'error'}`; } }; // never throw: one unreadable folder must not abort the whole run/preview
 if (item.action === 'move') {
  const bad = await check(join(layout.root, ...a.route!.folder.split('/')));
  if (!bad) return item;
  if (bad.startsWith('destination_unreadable')) return { ...item, outcome: 'error', reason: bad, renamed: false, detail: 'the destination folder cannot be read: this file would stay in _Inbox with an error (the other files are not affected)' }; // the mover's own result for it (it never reviews an I/O error)
  const reason = bad.startsWith(FOLDER_MISSING) ? bad : 'destination_unsafe';
  const rv = await check(layout.review);
  return { ...item, action: 'review', reason, renamed: false, destination: rel(INBOX, REVIEW, p.name), ...(rv ? { detail: `${rv}: Needs_Review is not usable either, the file would stay in place (run "init --yes")` } : {}) };
 }
 const rv = await check(layout.review);
 return rv ? { ...item, detail: `${rv}: Needs_Review is not usable, the file would stay in place (run "init --yes")` } : item;
}
export interface ApplyCtx { layout: Layout; config: Config; kind: SourceKind; runId: string; mode: 'run' | 'sweep'; historyFile: string; rename?: RenameOptions; deviceOf?: (dir: string) => Promise<number> }
/** Applies one planned item. Every move is journaled write-ahead (intent before the rename, commit after it). */
export async function applyOne(ctx: ApplyCtx, p: Planned): Promise<Item> {
 const base = plannedItem(p);
 const journal = (outcome: Outcome, reason: string) => makeJournal(ctx.historyFile, { runId: ctx.runId, mode: ctx.mode, source: p.path, sha256: p.sha256, size: p.snapshot.size, ino: p.snapshot.ino, route: p.analysis.route?.id ?? null, tier: p.analysis.tier, outcome, reason: outcome === 'moved' && p.analysis.note ? `${reason}:${p.analysis.note}` : reason, renamed: outcome === 'moved' && p.analysis.renamed });
 const toReview = async (reason: string, outcome: 'review' | 'duplicate', detail?: string): Promise<Item> => {
  const r = await moveNoClobber({ layout: ctx.layout, config: ctx.config, kind: ctx.kind, src: p.path, snapshot: p.snapshot, sha256: p.sha256, destDir: ctx.layout.review, name: p.name, rename: ctx.rename, deviceOf: ctx.deviceOf, journal: journal(outcome, reason) });
  if (r.kind === 'moved') return { ...base, action: 'review', outcome, reason, renamed: false, destination: rel(INBOX, REVIEW, basename(r.to)), ...(detail ? { detail } : {}) }; // a review keeps the original name: never tagged `renamed`
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
