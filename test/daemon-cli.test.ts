import { test, expect } from 'bun:test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { renderPlist, plistInput, installAgent, uninstallAgent, LABEL, plistPath } from '../src/install';
import { notificationArgv, notify, summarize, message } from '../src/notify';
import { callHelper, checkModel, classify, heuristics, safeSlice, parseModelResult, validateResult } from '../src/classifier';
import { evaluate, formatReport, parseLabels, stats } from '../src/evaluate';
import { run } from '../src/process';
import type { Item } from '../src/engine';
import { defaultConfig as config, model, sandbox, tree } from './helpers';

const cli = (args: string[], env: Record<string, string> = {}) => Bun.spawn([process.execPath, resolve('src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env, CLOUDTIDY_QUIET: '1' } });
async function runCli(args: string[], env: Record<string, string> = {}) {
 const p = cli(args, env);
 const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
 return { out, err, code };
}
const EXPECTED_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>at.paul.cloudtidy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/paul/.bun/bin/bun</string>
    <string>/Users/paul/dev/cloudtidy/src/cli.ts</string>
    <string>run</string>
    <string>--daemon</string>
    <string>--config</string>
    <string>/Users/paul/dev/cloudtidy/config/default.config.json</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/paul/dev/cloudtidy</string>
  <key>WatchPaths</key>
  <array>
    <string>/Users/paul/Library/Mobile Documents/com~apple~CloudDocs/_Inbox</string>
  </array>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLOUDTIDY_CONTEXT</key>
    <string>launchd</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/paul/Library/Logs/cloudtidy/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/paul/Library/Logs/cloudtidy/launchd.err.log</string>
</dict>
</plist>
`;
test('plist snapshot', () => {
 expect(renderPlist({ bun: '/Users/paul/.bun/bin/bun', script: '/Users/paul/dev/cloudtidy/src/cli.ts', configPath: '/Users/paul/dev/cloudtidy/config/default.config.json', inbox: '/Users/paul/Library/Mobile Documents/com~apple~CloudDocs/_Inbox', workDir: '/Users/paul/dev/cloudtidy', logDir: '/Users/paul/Library/Logs/cloudtidy', intervalSec: 600 })).toBe(EXPECTED_PLIST);
});
test('plist escapes XML and uses absolute paths only; never enables apply on its own', () => {
 const p = renderPlist({ ...plistInput(config, 'config/default.config.json', '/a&b/<x>/_Inbox') });
 expect(p).toContain('/a&amp;b/&lt;x&gt;/_Inbox'); expect(p).not.toContain('--apply');
 for (const m of p.matchAll(/<string>(\/[^<]*)<\/string>/g)) expect(m[1]!.startsWith('/')).toBe(true);
 expect(p).toContain(resolve('config/default.config.json')); expect(p).toContain(process.execPath);
});
test('install --print emits the plist without touching the system (works on Linux)', async () => {
 const sb = await sandbox(); try {
  const cfg = join(sb.dir, 'c.json'); await writeFile(cfg, JSON.stringify({ ...JSON.parse(await readFile('config/default.config.json', 'utf8')), root: sb.root, stateDir: join(sb.dir, 's'), logDir: join(sb.dir, 'l') }));
  const before = await tree(sb.dir);
  const r = await runCli(['install', '--print', '--config', cfg], {});
  expect(r.code).toBe(0); expect(r.out).toContain(`<string>${LABEL}</string>`); expect(r.out).toContain(`<string>${join(sb.root, '_Inbox')}</string>`);
  expect(await tree(sb.dir)).toEqual(before); expect(await stat(plistPath(join(sb.dir, 'home'))).then(() => true, () => false)).toBe(false);
 } finally { await sb.cleanup(); }
});
test('install / uninstall refuse on non-macOS and write nothing', async () => {
 if (process.platform === 'darwin') return;
 const sb = await sandbox(); try {
  const home = join(sb.dir, 'home'); const calls: string[][] = [];
  await expect(installAgent(sb.config, 'c.json', async a => { calls.push(a); return { code: 0, output: '' }; }, home)).rejects.toThrow('requires macOS');
  await expect(uninstallAgent(async a => { calls.push(a); return { code: 0, output: '' }; }, home)).rejects.toThrow('requires macOS');
  expect(calls).toEqual([]); expect(await readdir(sb.dir)).not.toContain('home'); expect(plistPath(home)).toContain('LaunchAgents/at.paul.cloudtidy.plist');
  const r = await runCli(['install'], {}); expect(r.code).toBe(1);
 } finally { await sb.cleanup(); }
});
const item = (o: Partial<Item>): Item => ({ file: 'secret-name.pdf', action: 'move', outcome: 'moved', route: 'uni', tier: 'rule', reason: 'r', destination: '01_Uni/secret-name.pdf', renamed: false, cached: false, sha256: 'x', size: 1, ...o });
test('notification: one batch message with counts/folders only; argv passing, no interpolation into AppleScript', async () => {
 const items = [item({}), item({ file: 'b "quoted" \\ $(rm -rf).pdf', destination: '02_Admin & Finanzen/Rechnungen/b.pdf' }), item({ outcome: 'review', destination: '_Inbox/Needs_Review/c.pdf' }), item({ outcome: 'duplicate' })];
 const text = message(summarize(items))!;
 expect(text).toBe('Sorted 2 files (01_Uni 1, Rechnungen 1) · 2 to Needs_Review'); expect(text).not.toContain('secret-name'); expect(text).not.toContain('quoted');
 const argv = notificationArgv('He said "hi" \\ $(x)');
 expect(argv).toEqual(['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', '--', 'He said "hi" \\ $(x)', 'cloudtidy']);
 expect(argv.slice(0, 7).join('\n')).not.toContain('hi');
 const calls: string[][] = [];
 expect(await notify(items, async a => { calls.push(a); }, true)).toBe(true); expect(calls).toHaveLength(1);
 expect(await notify(items, async a => { calls.push(a); }, false)).toBe(false); expect(await notify([], async a => { calls.push(a); }, true)).toBe(false); expect(calls).toHaveLength(1);
 expect(await notify(items, async () => { throw new Error('x'); }, true)).toBe(false);
});
test('notifications are off in tests and never fire in a run', async () => {
 const sb = await sandbox(); try {
  const { notificationsEnabled } = await import('../src/notify'); expect(notificationsEnabled()).toBe(false);
  await writeFile(join(sb.inbox, 'sheet.txt'), 'VO 123.456'); const { runOnce } = await import('../src/run');
  expect((await runOnce(sb.config, { apply: true, model: model() })).counts.moved).toBe(1);
 } finally { await sb.cleanup(); }
});
test('rules: exactly one matching route is definite; conflicts and no match defer to the model', () => {
 expect(heuristics('x.txt', 'Zahlungsziel 14 Tage', config)?.id).toBe('invoices');
 expect(heuristics('x.txt', 'Polizze Nr 5', config)?.id).toBe('contracts');
 expect(heuristics('x.txt', 'see github.com/foo', config)?.id).toBe('dev');
 expect(heuristics('x.txt', 'UE 123.456', config)?.id).toBe('uni');
 expect(heuristics('JKU_notes.txt', 'x', config)?.id).toBe('uni');
 expect(heuristics('x.txt', 'ATU12345678', config)?.id).toBe('invoices');
 expect(heuristics('x.txt', 'IBAN schema', config)).toBeNull();
 expect(heuristics('x.txt', 'VO 123.456 Rechnung', config)).toBeNull();
 expect(heuristics('x.txt', 'nothing here', config)).toBeNull();
});
test('personal Tier-1 rules: single match is definite, conflicts and unknown documents defer to the model', () => {
 for (const t of ['Reisepass Nr. P1234567', 'Personalausweis', 'Arztbrief Dr. Muster', 'Meine e-card', 'Flugticket VIE-LHR', 'Boarding Pass OS 871', 'Führerschein Klasse B']) expect(heuristics('scan.pdf', t, config)?.id).toBe('personal');
 expect(heuristics('Arztbrief.pdf', 'Versicherung Polizze', config)).toBeNull(); // conflict with contracts -> model
 expect(heuristics('x.txt', 'Flugticket Rechnung IBAN', config)).toBeNull();
 expect(heuristics('x.txt', 'Befunde und Sozialversicherung', config)?.id).toBe('contracts'); // not a personal word; only the contracts word matches
 expect(heuristics('x.txt', 'Steuerbescheid 2025', config)).toBeNull(); // anything else is left to the model / review
});
test('model text excerpt never splits a surrogate pair; the helper request stays valid UTF-8 JSON', async () => {
 const emoji = '😀', text = 'a'.repeat(2399) + emoji + 'tail'; // the pair straddles the 2400 limit
 const cut = safeSlice(text, 2400);
 expect(cut).toBe('a'.repeat(2399)); expect(cut.length).toBe(2399);
 expect(safeSlice('abc', 2400)).toBe('abc'); expect(safeSlice('a'.repeat(2398) + emoji, 2400)).toBe('a'.repeat(2398) + emoji);
 const sb = await sandbox(); try {
  const script = `#!${process.execPath}\nlet i=[];process.stdin.on('data',d=>i.push(d));process.stdin.on('end',()=>{const raw=Buffer.concat(i);const s=new TextDecoder('utf-8',{fatal:true}).decode(raw);const x=JSON.parse(s);const lone=/[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]/.test(x.text);console.log(JSON.stringify({version:2,route:lone||x.text.length>2400?'review':'uni',documentDate:'',sender:'',needsReview:false}));});`;
  await writeFile(sb.config.classifier, script, { mode: 0o755 });
  const out = await callHelper('f.txt', text, sb.config) as { route: string };
  expect(out.route).toBe('uni');
 } finally { await sb.cleanup(); }
});
test('protocol v2 parsing is strict', () => {
 const good = { version: 2, route: 'uni', documentDate: '', sender: '', needsReview: false };
 expect(parseModelResult(good, config)).not.toBeNull();
 for (const bad of [{ ...good, extra: 1 }, { ...good, version: 1 }, { ...good, route: 'x' }, { ...good, sender: undefined }, { ...good, documentDate: 'x'.repeat(40) }, [], 'x']) expect(parseModelResult(bad, config)).toBeNull();
 expect(validateResult({ ...good, route: 'review' }, config).reason).toBe('model_uncertain');
 expect(validateResult({ ...good, needsReview: true }, config).needsReview).toBe(true);
});
test('missing helper fails closed to review; subprocess bounds', async () => {
 expect((await classify('a.txt', 'unclear', { ...config, classifier: '/nonexistent/classify' })).reason).toBe('model_unavailable');
 expect((await checkModel({ ...config, classifier: '/nonexistent/classify' })).reason).toBe('helper_not_built');
 await expect(run(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], '', 30)).rejects.toThrow('helper_timeout');
 await expect(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], '', 5000, 100)).rejects.toThrow('helper_output_limit');
});
test('eval: read-only report with accuracy vs labels, review rate and cold/warm latency', async () => {
 const sb = await sandbox(); try {
  const d = join(sb.dir, 'docs'); await mkdir(d);
  await writeFile(join(d, 'a.txt'), 'VO 123.456 sheet'); await writeFile(join(d, 'b.txt'), 'unclear one'); await writeFile(join(d, 'c.txt'), 'unclear two'); await writeFile(join(d, 'd.txt'), 'unclear three'); await writeFile(join(d, 'e.zip'), 'PK');
  const labels = parseLabels({ 'a.txt': 'uni', 'b.txt': 'personal', 'c.txt': 'dev', 'd.txt': 'review', 'e.zip': 'review' }, config);
  const answers: Record<string, object> = { 'b.txt': { route: 'personal' }, 'c.txt': { route: 'personal' }, 'd.txt': { route: 'uni' } };
  let t = 0; const now = () => (t += 10);
  const before = await tree(d);
  const r = await evaluate(d, config, labels, { now, model: async (f) => ({ version: 2, route: 'review', documentDate: '', sender: '', needsReview: false, ...answers[f] }) });
  expect(await tree(d)).toEqual(before);
  expect(r.files).toBe(5); expect(r.distribution).toEqual({ uni: 2, personal: 2, review: 1 });
  expect(r.correct).toBe(3); expect(r.misrouted).toBe(1); expect(r.autoInsteadOfReview).toBe(1); expect(r.reviewInstead).toBe(0); expect(r.accuracy).toBeCloseTo(0.6);
  expect(r.reviewRate).toBeCloseTo(0.2);
  expect(r.latency.modelColdMs).not.toBeNull(); expect(r.latency.modelCallWarm.n).toBe(2); expect(r.latency.ruleTier.n).toBe(1);
  expect(formatReport(r)).toContain('Accuracy vs labels: 3/5 (60%)');
  expect(() => parseLabels({ 'a.txt': 'nonsense' }, config)).toThrow(); expect(() => parseLabels([], config)).toThrow();
  expect(stats([]).n).toBe(0); expect(stats([1, 2, 3, 4]).medianMs).toBe(2);
 } finally { await sb.cleanup(); }
});
test('CLI: help, usage errors and read-only commands', async () => {
 const sb = await sandbox(); try {
  const cfg = join(sb.dir, 'c.json'); await writeFile(cfg, JSON.stringify({ ...JSON.parse(await readFile('config/default.config.json', 'utf8')), root: sb.root, stateDir: join(sb.dir, 's'), logDir: join(sb.dir, 'l'), classifier: join(sb.dir, 'none'), debounceMs: 0 }));
  const help = await runCli(['--help']); expect(help.code).toBe(0);
  for (const w of ['classify', 'scan --dry-run', 'run', 'review', 'undo', 'history', 'sweep', 'install', 'uninstall', 'status', 'eval', 'doctor']) expect(help.out).toContain(w);
  expect((await runCli(['scan', '--config', cfg])).code).toBe(2);
  expect((await runCli(['undo', '--config', cfg])).code).toBe(2);
  expect((await runCli(['bogus', '--config', cfg])).code).toBe(2);
  expect((await runCli(['sweep', '--apply', '--daemon', '--config', cfg])).code).toBe(1);
  expect((await runCli(['sweep', '--config', cfg], { CLOUDTIDY_CONTEXT: 'launchd' })).code).toBe(1);
  expect((await runCli(['sweep', '--yes', '--config', cfg])).code).toBe(2);
  await writeFile(join(sb.inbox, 'sheet.txt'), 'VO 123.456');
  const before = await tree(sb.root);
  const scan = await runCli(['scan', '--dry-run', '--config', cfg]); expect(scan.code).toBe(0);
  expect(JSON.parse(scan.out).proposals[0]).toMatchObject({ file: 'sheet.txt', destination: '01_Uni/sheet.txt', action: 'move' });
  const run1 = await runCli(['run', '--config', cfg]); expect(run1.out).toContain('DRY-RUN'); expect(await tree(sb.root)).toEqual(before);
  expect((await runCli(['review', '--config', cfg])).out).toContain('empty');
  expect((await runCli(['history', '--config', cfg])).out).toContain('No history');
  expect((await runCli(['status', '--config', cfg])).out).toContain('Daemon apply mode: OFF');
  const cl = await runCli(['classify', join(sb.inbox, 'sheet.txt'), '--config', cfg]); expect(JSON.parse(cl.out)).toMatchObject({ route: 'uni', tier: 'rule' });
  const applied = await runCli(['run', '--apply', '--config', cfg]); expect(applied.out).toContain('APPLY'); expect(await readdir(join(sb.root, '01_Uni'))).toEqual(['sheet.txt']);
  expect((await runCli(['history', '--config', cfg])).out).toContain('01_Uni/sheet.txt');
  const prev = await runCli(['undo', '--last', '--config', cfg]); expect(prev.out).toContain('would_restore'); expect(await readdir(sb.inbox)).toEqual([]);
  const undo = await runCli(['undo', '--last', '--apply', '--config', cfg]); expect(undo.out).toContain('restored'); expect(await readdir(sb.inbox)).toEqual(['sheet.txt']);
  const dr = await runCli(['doctor', '--config', cfg]); expect(dr.code).toBe(1); expect(dr.out).toContain('exclusive no-clobber rename');
 } finally { await sb.cleanup(); }
});
