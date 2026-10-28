import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfigPath, expandHome, loadConfig, type Config } from './config';
import { evaluate, formatReport, readLabels, unsafeOutputs, type EvalDeps, type EvalReport } from './evaluate';

/** The synthetic documents shipped with the repo (no real personal data; every number in them is invented). */
export const FIXTURE_DIR = resolve(import.meta.dir, '../fixtures/eval');
/** Documents whose labelled route is not reachable without a model; review is the documented acceptable outcome (README), so it is counted separately and not as a miss. */
export const REVIEW_ACCEPTABLE = new Set(['unfallbericht_kfz_beispiel.txt', 'gerichtsschreiben_studium_beispiel.txt']) // round 11: the SVS letter is a rule hit now; these admin documents still need model + evidence;
export interface FixtureResult {
 report: EvalReport; unsafe: string[]; summary: string[];
 /** Documents that were not evaluated at all (pending: model unavailable, timeout, ...). */ notEvaluated: string[];
 /** Injection documents that ended anywhere but their label or review. */ injectionFailures: string[];
 /** 0 ok, 1 unsafe output or successful injection, 2 not meaningful (documents not evaluated). */ exitCode: 0 | 1 | 2;
}
/**
 * Copies the fixtures to a temporary root, runs `eval` with the shipped labels and checks every output for safety. Used by
 * `bun run eval:fixtures` (real helper on the Mac) and by the test suite (mock model). The temp copy is removed again.
 */
export async function runFixtureEval(config: Config, deps: EvalDeps = {}, fixtures = FIXTURE_DIR): Promise<FixtureResult> {
 const tmp = await mkdtemp(join(tmpdir(), 'cloudtidy-fixtures-'));
 try {
  const docs = join(tmp, 'docs'); await cp(fixtures, docs, { recursive: true });
  const labelsFile = join(docs, 'labels.json'), labels = await readLabels(labelsFile, config);
  const report = await evaluate(docs, config, labels, deps, [labelsFile]);
  const notEvaluated = report.rows.filter(x => x.got === 'pending').map(x => x.file);
  const injectionFailures = report.rows.filter(x => x.file.startsWith('inj_') && x.got !== 'pending' && x.got !== 'review' && x.got !== x.expected).map(x => `${x.file}: expected ${x.expected ?? 'review'}, got ${x.got}`);
  const okReview = report.rows.filter(x => x.got === 'review' && x.verdict === 'review_instead' && REVIEW_ACCEPTABLE.has(x.file)).length;
  const pendingLabeled = report.rows.filter(x => x.got === 'pending' && x.verdict === 'review_instead').length;
  const unsafe = unsafeOutputs(report.rows, config), pct = (x: number) => `${(x * 100).toFixed(0)}%`, l = report.latency;
  const ms = (s: { n: number; medianMs: number | null; p95Ms: number | null }) => s.n ? `median ${s.medianMs} ms, p95 ${s.p95Ms} ms (n=${s.n})` : 'n/a';
  const summary = [
   `Fixture documents: ${report.files} (${report.labeled} labelled)`,
   `Accuracy: ${report.correct}/${report.labeled} (${report.accuracy === null ? 'n/a' : pct(report.accuracy)})   wrong auto-route: ${report.misrouted}   auto-routed but expected review: ${report.autoInsteadOfReview}   sent to review instead: ${report.reviewInstead - pendingLabeled}${pendingLabeled ? `   NOT evaluated (pending): ${pendingLabeled}` : ''}`,
   ...(okReview ? [`Accuracy counting the documented-acceptable review (${[...REVIEW_ACCEPTABLE].join(', ')}) as correct: ${report.correct + okReview}/${report.labeled}`] : []),
   `Review rate: ${pct(report.reviewRate)}`,
   `Latency: rule tier ${ms(l.ruleTier)}; model calls (warm) ${ms(l.modelCallWarm)}${l.modelCallColdMs === null ? '' : `; first model call ${l.modelCallColdMs} ms`}`,
   `unsafe outputs: ${unsafe.length}`, ...unsafe.map(u => `  UNSAFE ${u}`),
   `injection documents that were not resisted: ${injectionFailures.length}`, ...injectionFailures.map(u => `  INJECTION ${u}`)
  ];
  if (notEvaluated.length) summary.push(`WARNING: ${notEvaluated.length} of ${report.files} document(s) were NOT evaluated (pending: model unavailable, busy or timed out): ${notEvaluated.join(', ')}.`, 'This result is not meaningful and gives no assurance; "unsafe outputs: 0" only covers the documents that were evaluated. Run "bun src/cli.ts doctor" and "bin/classify --check", then repeat. Exit code 2.');
  return { report, unsafe, summary, notEvaluated, injectionFailures, exitCode: unsafe.length || injectionFailures.length ? 1 : notEvaluated.length ? 2 : 0 };
 } finally { await rm(tmp, { recursive: true, force: true }); }
}
if (import.meta.main) {
 const argv = process.argv.slice(2), ci = argv.indexOf('--config');
 const config = await loadConfig(ci >= 0 && argv[ci + 1] ? resolve(expandHome(argv[ci + 1]!)) : defaultConfigPath);
 const r = await runFixtureEval(config);
 console.log(formatReport(r.report)); console.log(''); console.log(r.summary.join('\n'));
 process.exitCode = r.exitCode;
}
