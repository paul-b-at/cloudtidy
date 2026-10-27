import { createInterface } from 'node:readline/promises';
import { lstat, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { INBOX, REVIEW, defaultConfigPath, expandHome, loadConfig, oneFileMaxSeconds, worstCaseLockSeconds, type Config } from './config';
import { doctor, formatChecks } from './doctor';
import { type Item } from './engine';
import { evaluate, formatReport, inspectFile, readLabels } from './evaluate';
import { newRunId, readHistory, undoMoves, undoable, type MoveRecord } from './history';
import { agentState, installAgent, plistInput, renderPlist, resolveBunPath, resolvePdftotext, uninstallAgent } from './install';
import { applyInit, formatInit, planInit } from './init';
import { describePending, PendingStore } from './pending';
import { acquireLock } from './lock';
import { assertApplyAllowed, resolveLayout } from './paths';
import { isDaemonContext, runOnce, type RunReport } from './run';
import { readStatus, stateFiles } from './state';
import { budgetLine, INBOX_UNREADABLE, isHeld, itemLines, renderReport, show, skippedLines } from './report';
import { join } from 'node:path';

const HELP = `cloudtidy — local-first iCloud Drive organizer (Apple Foundation Models, on-device only)

Read-only by default. Files are moved only with an explicit --apply (or when the LaunchAgent runs with daemon.apply=true in the config).
Nothing is ever deleted or overwritten; uncertain / duplicate / failed files go to ${INBOX}/${REVIEW}.

Usage: bun src/cli.ts <command> [options]

Commands
  classify <file>                 Classify one file (read-only, any path). Prints route, destination, tier, reason, naming and, when a
                                  rule hit kept the original name, namingReason (e.g. naming_model_refusal).
  scan --dry-run                  Preview what would happen to ${INBOX} as JSON (same debounce as run; no lock, cache or state writes).
  run [--apply] [--no-cache] [--json] [--verbose]
                                  One ${INBOX} pass: debounce, classify, (with --apply) move + audit-log. Files that are unstable, empty or
                                  waiting for the model stay in ${INBOX} as pending (reported with a reason). A run starts no new file once its time budget
                                  (maxRunSeconds, default 300) is spent; the rest waits for the next run. The LaunchAgent runs this with --daemon.
  review                          List ${INBOX}/${REVIEW} with the recorded reason for each file, then files still pending in ${INBOX}.
  history [--limit N] [--run ID] [--json]
                                  Show the audit log (append-only JSONL in the state dir).
  undo <runId> | --last [--apply] Preview (default) or perform the undo of one run. Restores only if the destination hash
                                  still matches and the original path is free; never overwrites.
  init [--yes]                    Preview (default) or create the missing taxonomy folders (_Inbox, the buckets, configured sub-folders).
                                  Also creates ${INBOX}/${REVIEW}. Run it only after iCloud Drive has fully synced.
                                  Moves never create any folder: a file whose destination folder is missing goes to review (folder_missing:<path>).
  sweep [--apply] [--yes] [--verbose]
                                  Loose top-level files in the iCloud Drive root. Preview first; --apply asks for confirmation (or --yes).
                                  Never runs from the LaunchAgent. Folders, app containers and _Archiv are never touched.
  install [--print] [--bun <path>]
                                  Write ~/Library/LaunchAgents/at.paul.cloudtidy.plist and load it (macOS). --print only prints the plist.
                                  bun defaults to ~/.bun/bin/bun (then /opt/homebrew/bin/bun), never a versioned Cellar path.
  uninstall                       Unload and remove the LaunchAgent (history, cache, logs are kept).
  status                          LaunchAgent state, last run, model availability in the LaunchAgent context, lock, history size.
  eval <dir> [--expected labels.json] [--max-files N] [--json]
                                  Read-only batch report over a folder (default cap 500 files, dotfiles and the labels file are skipped): route
                                  distribution, review rate, accuracy vs labels, rule-tier routing latency (flags p95 > 10 ms) and naming/model latency.
  doctor [--json]                 Environment checks: native arm64 (not Rosetta), helpers, model, _Inbox, full taxonomy (buckets, sub-folders,
                                  Needs_Review), exclusive rename probe on the iCloud volume, run time budget, LaunchAgent, last run, journal.

Global options: --config <file> (default config/default.config.json), --help`;
class UsageError extends Error {}
interface Spec { flags?: string[]; values?: string[]; positionals?: number }
function parse(argv: string[], spec: Spec) {
 const flags = new Set<string>(), values: Record<string, string> = {}, pos: string[] = [];
 for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (spec.flags?.includes(a)) flags.add(a);
  else if (spec.values?.includes(a)) { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`); values[a] = v; }
  else if (!a.startsWith('--') && pos.length < (spec.positionals ?? 0)) pos.push(a);
  else throw new UsageError(`unexpected argument: ${a}`);
 }
 return { flags, values, pos };
}
const out = (s: string) => console.log(s);
const printItems = (items: Item[]) => { for (const l of itemLines(items)) out(l); };
const printSkipped = (skipped: RunReport['skipped'], verbose: boolean) => { for (const l of skippedLines(skipped, verbose)) out(l); };
function printReport(r: RunReport, apply: boolean, verbose = false) {
 const { out: o, err } = renderReport(r, apply, verbose);
 for (const l of o) out(l);
 for (const l of err) console.error(l);
}
async function sweepConfirm(items: Item[], opts: { yes: boolean }): Promise<boolean> {
 printItems(items);
 if (!items.length) { out('Nothing to sweep.'); return false; }
 if (opts.yes) return true;
 if (!process.stdin.isTTY) { out('Refusing to move files without confirmation: not a terminal. Re-run in a terminal or add --yes after reviewing the preview.'); process.exitCode = 1; return false; }
 const rl = createInterface({ input: process.stdin, output: process.stdout });
 try { return (await rl.question(`Move ${items.length} file(s) as shown above? Type "yes" to continue: `)).trim().toLowerCase() === 'yes'; } finally { rl.close(); }
}
async function reviewList(config: Config) {
 const layout = await resolveLayout(config), dir = layout.review, history = await readHistory(stateFiles(config).history);
 const names = await readdir(dir).catch(() => [] as string[]);
 if (!names.length) out(`${INBOX}/${REVIEW} is empty.`);
 for (const n of names.sort()) {
  const s = await lstat(join(dir, n));
  if (!s.isFile()) continue;
  const rec = [...history].reverse().find((r): r is MoveRecord => r.type === 'move' && r.destination === join(dir, n));
  out(show(`${n}  ${s.size < 1024 ? `${s.size} B` : `${(s.size / 1024).toFixed(0)} KiB`}  ${s.mtime.toISOString().slice(0, 10)}  ${rec ? `${rec.outcome}: ${rec.reason} (run ${rec.runId})` : 'not placed by cloudtidy'}`));
 }
}
/** Files that stay in _Inbox for now (still changing, empty, waiting for the model): the same description scan/run/status use. */
async function pendingList(config: Config): Promise<{ name: string; text: string }[]> {
 const store = await PendingStore.load(stateFiles(config).pending);
 const here = new Set(await readdir((await resolveLayout(config)).inbox).catch(() => [] as string[]));
 return store.list().filter(e => here.has(e.name)).map(e => ({ name: e.name, text: `${e.kind} — ${describePending(e)}${e.attempts ? ` (${e.attempts} attempt${e.attempts === 1 ? '' : 's'})` : ''}` }));
}
async function main() {
 const argv = process.argv.slice(2);
 if (!argv.length || argv[0] === '--help' || argv[0] === 'help' || argv[0] === '-h') return out(HELP);
 const ci = argv.indexOf('--config'); let configPath = defaultConfigPath;
 if (ci >= 0) { if (!argv[ci + 1]) throw new UsageError('--config needs a file'); configPath = resolve(expandHome(argv[ci + 1]!)); argv.splice(ci, 2); }
 const cmd = argv.shift()!;
 if (argv.includes('--help')) return out(HELP);
 const c = await loadConfig(configPath);
 switch (cmd) {
  case 'classify': { const { pos } = parse(argv, { positionals: 1 }); if (!pos[0]) throw new UsageError('classify <file>'); if (!(await stat(pos[0]).catch(() => null))?.isFile()) throw Error(`classify: not a readable file: ${pos[0]}`); return out(JSON.stringify(await inspectFile(pos[0], c), null, 2)); }
  case 'scan': {
   const { flags } = parse(argv, { flags: ['--dry-run'] });
   if (!flags.has('--dry-run')) throw new UsageError('scan only supports --dry-run (use "run --apply" to move files)');
   const r = await runOnce(c, { apply: false, readOnly: true });
   if (!r.inboxReadable) throw Error(INBOX_UNREADABLE);
   if (r.budget) console.error(budgetLine(r.budget));
   return out(JSON.stringify({ dryRun: true, proposals: r.items, skipped: r.skipped, ...(r.budget ? { budget: r.budget } : {}) }, null, 2));
  }
  case 'run': {
   const { flags } = parse(argv, { flags: ['--apply', '--daemon', '--no-cache', '--json', '--verbose'] });
   const r = await runOnce(c, { apply: flags.has('--apply'), daemon: flags.has('--daemon'), useCache: !flags.has('--no-cache') });
   if (flags.has('--json')) out(JSON.stringify(r, null, 2)); else printReport(r, r.mode === 'apply', flags.has('--verbose'));
   if (r.counts.errors || (!r.inboxReadable && r.context !== 'launchd')) process.exitCode = 1;
   return;
  }
  case 'review': { parse(argv, {}); await reviewList(c); const p = await pendingList(c); if (p.length) { out(`Pending in ${INBOX} (not in ${REVIEW}; retried automatically):`); for (const e of p) out(show(`${e.name}  ${e.text}`)); } return; }
  case 'history': {
   const { flags, values } = parse(argv, { flags: ['--json'], values: ['--limit', '--run'] });
   let recs = await readHistory(stateFiles(c).history);
   if (values['--run']) recs = recs.filter(r => r.runId === values['--run']);
   const n = Number(values['--limit'] ?? 20); if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit must be a positive integer');
   recs = recs.slice(-n);
   if (flags.has('--json')) return out(JSON.stringify(recs, null, 2));
   if (!recs.length) return out('No history yet.');
   for (const r of recs) out(show(r.type === 'move' ? `${r.time} ${r.runId} ${r.outcome.padEnd(9)} ${r.source} → ${r.destination}  [${r.tier}${r.route ? `:${r.route}` : ''}, ${r.reason}, sha256 ${r.sha256.slice(0, 12)}…, ${r.size} B]` : `${r.time} ${r.runId} undo      ${r.source} → ${r.destination}  (of ${r.of})`));
   return;
  }
  case 'undo': {
   const { flags, pos } = parse(argv, { flags: ['--last', '--apply'], positionals: 1 });
   if (!flags.has('--last') && !pos[0]) throw new UsageError('undo <runId> | --last  [--apply]');
   if (flags.has('--last') && pos[0]) throw new UsageError('use either <runId> or --last');
   const apply = flags.has('--apply'), files = stateFiles(c), layout = await resolveLayout(c);
   const lock = apply ? await acquireLock(files.lock, { waitMs: c.lockWaitMs }) : null;
   if (apply && !lock) throw Error('another cloudtidy run holds the lock; try again shortly');
   try {
    const items = await undoMoves(c, layout, files.history, { runId: pos[0], last: flags.has('--last') }, { apply, undoRunId: newRunId() });
    if (!items.length) { out(`${pos[0] ? `No undoable moves found for run ${pos[0]}` : 'Nothing to undo'} (${undoable(await readHistory(files.history)).length} undoable moves in history; see "history").`); if (pos[0]) process.exitCode = 1; }
    for (const i of items) out(show(`${i.status.padEnd(26)} ${i.from} → ${i.to}`));
    if (!apply && items.length) out('Preview only. Re-run with --apply to restore.');
    if (items.some(i => i.status.startsWith('skipped'))) process.exitCode = 1;
   } finally { await lock?.release(); }
   return;
  }
  case 'init': {
   const { flags } = parse(argv, { flags: ['--yes'] });
   const layout = await resolveLayout(c);
   if (!flags.has('--yes')) { out(formatInit(await planInit(layout, c), false)); return; }
   await assertApplyAllowed(layout, c);
   const lock = await acquireLock(stateFiles(c).lock, { waitMs: c.lockWaitMs });
   if (!lock) throw Error('another cloudtidy run holds the lock; try again shortly');
   try { out(formatInit(await applyInit(layout, c), true)); } finally { await lock.release(); }
   return;
  }
  case 'sweep': {
   const { flags } = parse(argv, { flags: ['--apply', '--yes', '--daemon', '--verbose'] });
   if (isDaemonContext({ daemon: flags.has('--daemon') })) throw Error('sweep never runs from the LaunchAgent');
   if (flags.has('--yes') && !flags.has('--apply')) throw new UsageError('--yes only applies together with --apply');
   const apply = flags.has('--apply');
   const r = await runOnce(c, { apply, kind: 'root', mode: 'sweep', notify: false, ...(apply ? { confirm: items => sweepConfirm(items, { yes: flags.has('--yes') }) } : {}) });
   if (!r.inboxReadable) throw Error(`${INBOX_UNREADABLE} (sweep sends uncertain files to ${INBOX}/${REVIEW}.)`);
   if (r.aborted) return r.items.length ? out('Aborted: no files were moved.') : undefined;
   if (apply) printReport(r, true, flags.has('--verbose')); else { printItems(r.items.filter(i => flags.has('--verbose') || !isHeld(i))); printSkipped(r.skipped, flags.has('--verbose')); if (r.budget) out(budgetLine(r.budget)); out('Preview only. Re-run with --apply (and confirm) to move files.'); }
   if (r.counts.errors) process.exitCode = 1;
   return;
  }
  case 'install': {
   const { flags, values } = parse(argv, { flags: ['--print'], values: ['--bun'] });
   if (flags.has('--print')) {
    const layout = await resolveLayout(c).catch(() => null), inbox = layout ? layout.inbox : join(c.root, INBOX); // the resolved absolute path, exactly what `install` would bake in
    console.error(`# watching ${inbox}${layout ? '' : ' (root not found here: unresolved path)'}`);
    return out(renderPlist(plistInput(c, configPath, inbox, await resolveBunPath(values['--bun']), resolvePdftotext())));
   }
   for (const n of await installAgent(c, configPath, undefined, undefined, { bun: values['--bun'] })) out(n);
   return out('Verify with: bun src/cli.ts status');
  }
  case 'uninstall': parse(argv, {}); for (const n of await uninstallAgent()) out(n); return;
  case 'status': {
   parse(argv, {});
   const a = await agentState(), st = await readStatus(c), f = stateFiles(c);
   out(`LaunchAgent: ${a.installed ? 'installed' : 'not installed'}, ${a.loaded ? 'loaded' : 'not loaded'} (${a.plist})`);
   out(`Daemon apply mode: ${c.daemon.apply ? 'ON (moves files automatically)' : 'OFF (preview only)'}   interval: ${c.daemon.intervalSec}s   debounce: ${c.debounceMs}ms`);
   out(`Run time budget: ${c.maxRunSeconds}s (checked before each file; one file takes at most ~${oneFileMaxSeconds(c)}s, so the lock is held for at most ~${worstCaseLockSeconds(c)}s${worstCaseLockSeconds(c) > c.daemon.intervalSec ? `, longer than the ${c.daemon.intervalSec}s interval: overlapping triggers are skipped` : ''})`);
   if (st) { out(`Last run: ${st.time} (${st.context}, ${st.mode}, run ${st.runId})`); out(`  model reachable in that context: ${st.model ? (st.model.available ? 'yes' : `NO (${st.model.reason})`) : 'not checked'};  ${INBOX} readable: ${st.inboxReadable ? 'yes' : 'NO'}`); out(`  counts: ${Object.entries(st.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`); }
   else out('Last run: none recorded yet');
   if (st?.budget?.hit) out(`  WARNING: the last ${st.budget.streak} run(s) in a row stopped at the ${c.maxRunSeconds}s time budget (${st.budget.left} file(s) left in the latest): more files than one run can handle, or a slow model`);
   const p = await pendingList(c); out(`Pending in ${INBOX}: ${p.length}${p.length ? ' (run "review" for details)' : ''}`);
   const h = await readHistory(f.history); out(`History: ${h.filter(r => r.type === 'move').length} moves, ${undoable(h).length} undoable   (${f.history})`);
   return;
  }
  case 'eval': {
   const { flags, values, pos } = parse(argv, { flags: ['--json'], values: ['--expected', '--max-files'], positionals: 1 });
   if (!pos[0]) throw new UsageError('eval <dir> [--expected labels.json] [--max-files N]');
   const max = values['--max-files'] === undefined ? undefined : Number(values['--max-files']);
   if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 100000)) throw new UsageError('--max-files must be a positive integer');
   if (!(await stat(pos[0]).catch(() => null))?.isDirectory()) throw Error(`eval: not a readable folder: ${show(pos[0])}`);
   const labels = values['--expected'] ? await readLabels(values['--expected'], c) : null;
   const r = await evaluate(pos[0], c, labels, {}, values['--expected'] ? [resolve(values['--expected'])] : [], { maxFiles: max });
   return out(flags.has('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
  }
  case 'doctor': {
   const { flags } = parse(argv, { flags: ['--json'] });
   const checks = await doctor(c);
   out(flags.has('--json') ? JSON.stringify({ checks }, null, 2) : formatChecks(checks));
   if (checks.some(x => x.required && !x.ok)) process.exitCode = 1;
   return;
  }
  default: throw new UsageError(`unknown command: ${cmd}`);
 }
}
main().catch(e => {
 if (e instanceof UsageError) { console.error(`${e.message}\n\nRun with --help for usage.`); process.exitCode = 2; return; }
 console.error(e instanceof Error ? e.message : 'cloudtidy failed'); process.exitCode = 1;
});
