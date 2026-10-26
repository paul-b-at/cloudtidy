import { createInterface } from 'node:readline/promises';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { INBOX, REVIEW, defaultConfigPath, expandHome, loadConfig, type Config } from './config';
import { doctor, formatChecks } from './doctor';
import { type Item } from './engine';
import { evaluate, formatReport, inspectFile, readLabels } from './evaluate';
import { newRunId, readHistory, undoMoves, undoable, type MoveRecord } from './history';
import { agentState, installAgent, plistInput, renderPlist, uninstallAgent } from './install';
import { acquireLock } from './lock';
import { resolveLayout } from './paths';
import { isDaemonContext, runOnce, type RunReport } from './run';
import { readStatus, stateFiles } from './state';
import { join } from 'node:path';

const HELP = `cloudtidy — local-first iCloud Drive organizer (Apple Foundation Models, on-device only)

Read-only by default. Files are moved only with an explicit --apply (or when the LaunchAgent runs with daemon.apply=true in the config).
Nothing is ever deleted or overwritten; uncertain / duplicate / failed files go to ${INBOX}/${REVIEW}.

Usage: bun src/cli.ts <command> [options]

Commands
  classify <file>                 Classify one file (read-only, any path). Prints route, destination, tier, reason.
  scan --dry-run                  Preview what would happen to ${INBOX} (no debounce, lock, cache or state writes).
  run [--apply] [--no-cache]      One ${INBOX} pass: debounce, classify, (with --apply) move + audit-log. This is what the LaunchAgent runs.
  review                          List ${INBOX}/${REVIEW} with the recorded reason for each file.
  history [--limit N] [--run ID] [--json]
                                  Show the audit log (append-only JSONL in the state dir).
  undo <runId> | --last [--apply] Preview (default) or perform the undo of one run. Restores only if the destination hash
                                  still matches and the original path is free; never overwrites.
  sweep [--apply] [--yes]         Loose top-level files in the iCloud Drive root. Preview first; --apply asks for confirmation (or --yes).
                                  Never runs from the LaunchAgent. Folders, app containers and _Archiv are never touched.
  install [--print]               Write ~/Library/LaunchAgents/at.paul.cloudtidy.plist and load it (macOS). --print only prints the plist.
  uninstall                       Unload and remove the LaunchAgent (history, cache, logs are kept).
  status                          LaunchAgent state, last run, model availability in the LaunchAgent context, lock, history size.
  eval <dir> [--expected labels.json] [--json]
                                  Read-only batch report over a folder: route distribution, review rate, accuracy vs labels, cold/warm latency.
  doctor [--json]                 Environment checks (helpers, model, inbox, exclusive rename, LaunchAgent).

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
function printItems(items: Item[]) {
 for (const i of items) out(`${i.outcome.padEnd(9)} ${i.file}  →  ${i.destination}   [${i.tier}${i.cached ? ', cached' : ''}: ${i.reason}${i.renamed ? ', renamed' : ''}${i.detail ? `, ${i.detail}` : ''}]`);
}
function printReport(r: RunReport, apply: boolean) {
 if (r.locked) return out('Another cloudtidy run holds the lock; nothing done.');
 if (!r.inboxReadable) return out(`${INBOX} is not readable (check the path, iCloud sync and Full Disk Access for bun).`);
 out(`${apply ? 'APPLY' : 'DRY-RUN'} ${r.runId}${r.model ? `   model: ${r.model.available ? 'available' : `UNAVAILABLE (${r.model.reason})`}` : ''}`);
 printItems(r.items);
 for (const s of r.skipped) out(`skipped   ${s.name}  (${s.reason})`);
 out(`counts: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ')}${apply ? '' : '\nNo files were changed. Use --apply to move files.'}`);
}
async function sweepConfirm(items: Item[], opts: { yes: boolean }): Promise<boolean> {
 printItems(items);
 if (!items.length) { out('Nothing to sweep.'); return false; }
 if (opts.yes) return true;
 if (!process.stdin.isTTY) { out('Refusing to move files without confirmation: not a terminal. Re-run in a terminal or add --yes after reviewing the preview.'); return false; }
 const rl = createInterface({ input: process.stdin, output: process.stdout });
 try { return (await rl.question(`Move ${items.length} file(s) as shown above? Type "yes" to continue: `)).trim().toLowerCase() === 'yes'; } finally { rl.close(); }
}
async function reviewList(config: Config) {
 const layout = await resolveLayout(config), dir = layout.review, history = await readHistory(stateFiles(config).history);
 const names = await readdir(dir).catch(() => [] as string[]);
 if (!names.length) return out(`${INBOX}/${REVIEW} is empty.`);
 for (const n of names.sort()) {
  const s = await lstat(join(dir, n));
  if (!s.isFile()) continue;
  const rec = [...history].reverse().find((r): r is MoveRecord => r.type === 'move' && r.destination === join(dir, n));
  out(`${n}  ${(s.size / 1024).toFixed(0)} KiB  ${s.mtime.toISOString().slice(0, 10)}  ${rec ? `${rec.outcome}: ${rec.reason} (run ${rec.runId})` : 'not placed by cloudtidy'}`);
 }
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
  case 'classify': { const { pos } = parse(argv, { positionals: 1 }); if (!pos[0]) throw new UsageError('classify <file>'); return out(JSON.stringify(await inspectFile(pos[0], c), null, 2)); }
  case 'scan': {
   const { flags } = parse(argv, { flags: ['--dry-run'] });
   if (!flags.has('--dry-run')) throw new UsageError('scan only supports --dry-run (use "run --apply" to move files)');
   const r = await runOnce(c, { apply: false, readOnly: true });
   return out(JSON.stringify({ dryRun: true, proposals: r.items, skipped: r.skipped }, null, 2));
  }
  case 'run': {
   const { flags } = parse(argv, { flags: ['--apply', '--daemon', '--no-cache', '--json'] });
   const r = await runOnce(c, { apply: flags.has('--apply'), daemon: flags.has('--daemon'), useCache: !flags.has('--no-cache') });
   if (flags.has('--json')) out(JSON.stringify(r, null, 2)); else printReport(r, r.mode === 'apply');
   if (r.counts.errors) process.exitCode = 1;
   return;
  }
  case 'review': parse(argv, {}); return reviewList(c);
  case 'history': {
   const { flags, values } = parse(argv, { flags: ['--json'], values: ['--limit', '--run'] });
   let recs = await readHistory(stateFiles(c).history);
   if (values['--run']) recs = recs.filter(r => r.runId === values['--run']);
   const n = Number(values['--limit'] ?? 20); if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit must be a positive integer');
   recs = recs.slice(-n);
   if (flags.has('--json')) return out(JSON.stringify(recs, null, 2));
   if (!recs.length) return out('No history yet.');
   for (const r of recs) out(r.type === 'move' ? `${r.time} ${r.runId} ${r.outcome.padEnd(9)} ${r.source} → ${r.destination}  [${r.tier}${r.route ? `:${r.route}` : ''}, ${r.reason}, sha256 ${r.sha256.slice(0, 12)}…, ${r.size} B]` : `${r.time} ${r.runId} undo      ${r.source} → ${r.destination}  (of ${r.of})`);
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
    if (!items.length) out(`Nothing to undo (${undoable(await readHistory(files.history)).length} undoable moves in history).`);
    for (const i of items) out(`${i.status.padEnd(26)} ${i.from} → ${i.to}`);
    if (!apply && items.length) out('Preview only. Re-run with --apply to restore.');
    if (items.some(i => i.status.startsWith('skipped'))) process.exitCode = 1;
   } finally { await lock?.release(); }
   return;
  }
  case 'sweep': {
   const { flags } = parse(argv, { flags: ['--apply', '--yes', '--daemon'] });
   if (isDaemonContext({ daemon: flags.has('--daemon') })) throw Error('sweep never runs from the LaunchAgent');
   if (flags.has('--yes') && !flags.has('--apply')) throw new UsageError('--yes only applies together with --apply');
   const apply = flags.has('--apply');
   const r = await runOnce(c, { apply, kind: 'root', mode: 'sweep', notify: false, ...(apply ? { confirm: items => sweepConfirm(items, { yes: flags.has('--yes') }) } : {}) });
   if (r.aborted) return out('Aborted: no files were moved.');
   if (apply) printReport(r, true); else { printItems(r.items); for (const s of r.skipped) out(`skipped   ${s.name}  (${s.reason})`); out('Preview only. Re-run with --apply (and confirm) to move files.'); }
   if (r.counts.errors) process.exitCode = 1;
   return;
  }
  case 'install': {
   const { flags } = parse(argv, { flags: ['--print'] });
   if (flags.has('--print')) { const inbox = join(c.root, INBOX); return out(renderPlist(plistInput(c, configPath, inbox))); }
   for (const n of await installAgent(c, configPath)) out(n);
   return out('Verify with: bun src/cli.ts status');
  }
  case 'uninstall': parse(argv, {}); for (const n of await uninstallAgent()) out(n); return;
  case 'status': {
   parse(argv, {});
   const a = await agentState(), st = await readStatus(c), f = stateFiles(c);
   out(`LaunchAgent: ${a.installed ? 'installed' : 'not installed'}, ${a.loaded ? 'loaded' : 'not loaded'} (${a.plist})`);
   out(`Daemon apply mode: ${c.daemon.apply ? 'ON (moves files automatically)' : 'OFF (preview only)'}   interval: ${c.daemon.intervalSec}s   debounce: ${c.debounceMs}ms`);
   if (st) { out(`Last run: ${st.time} (${st.context}, ${st.mode}, run ${st.runId})`); out(`  model reachable in that context: ${st.model ? (st.model.available ? 'yes' : `NO (${st.model.reason})`) : 'not checked'};  ${INBOX} readable: ${st.inboxReadable ? 'yes' : 'NO'}`); out(`  counts: ${Object.entries(st.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`); }
   else out('Last run: none recorded yet');
   const h = await readHistory(f.history); out(`History: ${h.filter(r => r.type === 'move').length} moves, ${undoable(h).length} undoable   (${f.history})`);
   return;
  }
  case 'eval': {
   const { flags, values, pos } = parse(argv, { flags: ['--json'], values: ['--expected'], positionals: 1 });
   if (!pos[0]) throw new UsageError('eval <dir> [--expected labels.json]');
   const labels = values['--expected'] ? await readLabels(values['--expected'], c) : null;
   const r = await evaluate(pos[0], c, labels, {}, values['--expected'] ? [resolve(values['--expected'])] : []);
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
