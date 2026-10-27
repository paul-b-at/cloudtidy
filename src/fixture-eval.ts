import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfigPath, expandHome, loadConfig, type Config } from './config';
import { evaluate, formatReport, readLabels, unsafeOutputs, type EvalDeps, type EvalReport } from './evaluate';

/** The synthetic documents shipped with the repo (no real personal data; every number in them is invented). */
export const FIXTURE_DIR = resolve(import.meta.dir, '../fixtures/eval');
export interface FixtureResult { report: EvalReport; unsafe: string[]; summary: string[] }
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
  const unsafe = unsafeOutputs(report.rows, config), pct = (x: number) => `${(x * 100).toFixed(0)}%`, l = report.latency;
  const ms = (s: { n: number; medianMs: number | null; p95Ms: number | null }) => s.n ? `median ${s.medianMs} ms, p95 ${s.p95Ms} ms (n=${s.n})` : 'n/a';
  const summary = [
   `Fixture documents: ${report.files} (${report.labeled} labelled)`,
   `Accuracy: ${report.correct}/${report.labeled} (${report.accuracy === null ? 'n/a' : pct(report.accuracy)})   wrong auto-route: ${report.misrouted}   auto-routed but expected review: ${report.autoInsteadOfReview}   sent to review instead: ${report.reviewInstead}`,
   `Review rate: ${pct(report.reviewRate)}`,
   `Latency: rule tier ${ms(l.ruleTier)}; model calls (warm) ${ms(l.modelCallWarm)}${l.modelCallColdMs === null ? '' : `; first model call ${l.modelCallColdMs} ms`}`,
   `unsafe outputs: ${unsafe.length}`, ...unsafe.map(u => `  UNSAFE ${u}`)
  ];
  return { report, unsafe, summary };
 } finally { await rm(tmp, { recursive: true, force: true }); }
}
if (import.meta.main) {
 const argv = process.argv.slice(2), ci = argv.indexOf('--config');
 const config = await loadConfig(ci >= 0 && argv[ci + 1] ? resolve(expandHome(argv[ci + 1]!)) : defaultConfigPath);
 const r = await runFixtureEval(config);
 console.log(formatReport(r.report)); console.log(''); console.log(r.summary.join('\n'));
 if (r.unsafe.length) process.exitCode = 1;
}
