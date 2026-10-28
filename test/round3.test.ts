// Final fix round: pending expiry, definitive naming failures, specific reasons, state validation, stop-words, defaults, logs, UX.
import { test, expect } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOnce } from '../src/run';
import { classify, heuristics, modelFailure } from '../src/classifier';
import { HelperError } from '../src/process';
import { PendingStore } from '../src/pending';
import { HeldStore, stateFiles } from '../src/state';
import { labelledDate, validatedSender } from '../src/naming';
import { loadConfig, validateConfig } from '../src/config';
import { resolveLayout } from '../src/paths';
import { doctor, probeExclusiveRename } from '../src/doctor';
import { makeJournal, readHistory, readRawHistory, reconcileIntents, appendHistory } from '../src/history';
import { applyInit } from '../src/init';
import { fingerprint } from '../src/fsx';
import { rotateLogs } from '../src/log';
import { baseJson, defaultConfig as config, model, sandbox, type Sandbox, inboxFiles } from './helpers';

const put = (sb: Sandbox, name: string, body: string) => writeFile(join(sb.inbox, name), body);
const unavailable = async () => { throw new HelperError('helper_unavailable'); };
const healthy = model({ route: 'personal' });
const HOUR = 3_600_000;
const cli = (args: string[]) => Bun.spawn([process.execPath, resolve('src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLOUDTIDY_QUIET: '1' } });
async function runCli(args: string[]) { const p = cli(args); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { out, err, code }; }
const cfgFor = async (sb: Sandbox, extra: Record<string, unknown> = {}) => {
 const cfg = join(sb.dir, 'cli.json');
 await writeFile(cfg, JSON.stringify({ ...baseJson, allowNonICloudRoot: true, root: sb.root, stateDir: join(sb.dir, 's'), logDir: join(sb.dir, 'l'), classifier: join(sb.dir, 'none'), debounceMs: 0, ...extra }));
 return cfg;
};

// ---------------------------------------------------------------- 1. pending expiry
test('expiry 1: dry-run runs never start the give-up clock; the first apply run after days of dry-runs asks the model and sorts the file', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'note.txt', 'a short unclear note'); let t = 1_000_000_000_000;
  const run = (apply: boolean, m = unavailable) => runOnce(sb.config, { apply, model: m, now: () => t, sleep: async () => {} });
  for (let i = 0; i < 4; i++) { const r = await run(false); expect(r.items[0]).toMatchObject({ outcome: 'pending', reason: 'model_unavailable' }); t += 30 * HOUR; }
  const e = (await PendingStore.load(stateFiles(sb.config).pending, () => t)).get('note.txt')!;
  expect(e.attempts).toBeGreaterThanOrEqual(4); expect(e.applySince).toBeUndefined(); expect(e.applyAttempts).toBeUndefined();
  const first = await run(true, healthy as never); // 120 h after the first dry-run: still asked once more, and sorted
  expect(first.items[0]).toMatchObject({ outcome: 'moved', route: 'personal' }); expect(await inboxFiles(sb)).toEqual([]); expect(await readdir(sb.review)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('expiry 2: review only after maxDeferHours AND >= 3 apply-mode attempts AND a final failed attempt; a healthy final attempt sorts the file', async () => {
 for (const finalHealthy of [false, true]) {
  const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
   await put(sb, 'note.txt', 'a short unclear note'); let t = 1_000_000_000_000;
   const run = (m: typeof unavailable | typeof healthy) => runOnce(sb.config, { apply: true, model: m as never, now: () => t, sleep: async () => {} });
   await run(unavailable); t += 30 * HOUR;                       // attempt 1; 30 h later: attempt 2 (only 2 apply attempts so far, no give-up)
   expect((await run(unavailable)).items[0]).toMatchObject({ outcome: 'pending' }); t += 2 * HOUR;
   expect((await run(unavailable)).items[0]).toMatchObject({ outcome: 'pending' }); t += 2 * HOUR; // attempt 3
   const last = await run(finalHealthy ? healthy : unavailable);  // 3 attempts over > 24 h, now the final attempt
   if (finalHealthy) { expect(last.items[0]).toMatchObject({ outcome: 'moved', route: 'personal' }); expect(await readdir(sb.review)).toEqual([]); }
   else { expect(last.items[0]).toMatchObject({ outcome: 'review', reason: 'deferred_too_long:model_unavailable' }); expect(await readdir(sb.review)).toEqual(['note.txt']); }
  } finally { await sb.cleanup(); }
 }
});

// ---------------------------------------------------------------- 2./3. definitive naming failures and specific reasons
const TOKENS: [number, string, string][] = [
 [1, 'refusal', 'model_refusal'], [1, 'guardrail_violation', 'model_guardrail'], [1, 'unsupported_language', 'model_unsupported_language'], [1, 'context_window_exceeded', 'model_context_overflow'],
 [1, 'decoding_failure', 'model_invalid_output'], [3, 'invalid_request', 'model_invalid_request'], [1, 'generation_error', 'model_failed'], [1, '', 'model_failed']
];
test('modelFailure keeps the helper token: refusal / guardrail / unsupported language / context overflow / invalid output are distinct reasons; transient ones stay transient', () => {
 for (const [code, token, reason] of TOKENS) expect(modelFailure(new HelperError('helper_failed', code, token || null)), token).toEqual({ kind: 'failed', reason });
 expect(modelFailure(new HelperError('helper_failed', 4, 'rate_limited'))).toMatchObject({ kind: 'transient', reason: 'model_busy' });
 expect(modelFailure(new HelperError('helper_failed', 2, 'assets_unavailable'))).toMatchObject({ kind: 'transient', reason: 'model_unavailable' });
 expect(modelFailure(new HelperError('helper_timeout'))).toMatchObject({ kind: 'transient', reason: 'model_timeout' });
});
test('a real helper subprocess: stderr tokens give specific reasons; a definitive failure on a rule hit keeps the rule route and the original name', async () => {
 const sb = await sandbox(); try {
  for (const [code, token, reason] of TOKENS) {
   await writeFile(sb.config.classifier, `#!/bin/sh\nif [ "$1" = "--check" ]; then echo '{"version":2,"available":true}'; exit 0; fi\ncat >/dev/null\n${token ? `echo "classification_failed:${token}" >&2\n` : ''}exit ${code}\n`, { mode: 0o755 });
   await put(sb, 'free.txt', 'unclear note'); await put(sb, 'mv.txt', 'Mietvertrag Wohnung 5');
   const x = await runOnce(sb.config, { apply: false, sleep: async () => {}, useCache: false });
   expect(x.items.find(i => i.file === 'free.txt'), token).toMatchObject({ action: 'review', reason });
   expect(x.items.find(i => i.file === 'mv.txt'), token).toMatchObject({ action: 'move', route: 'contracts', renamed: false, reason: 'rule_match', detail: `naming_${reason}`, destination: '02_Admin & Finanzen/Verträge/mv.txt' });
   await rm(join(sb.inbox, 'free.txt')); await rm(join(sb.inbox, 'mv.txt'));
  }
  await writeFile(sb.config.classifier, `#!/bin/sh\nif [ "$1" = "--check" ]; then echo '{"version":2,"available":true}'; exit 0; fi\ncat >/dev/null\necho "classification_failed:refusal" >&2\nexit 1\n`, { mode: 0o755 });
  await put(sb, 'bill.txt', 'Rechnung\nDrei Betrag 10 EUR'); // rule hit (invoices), no labelled date: the model is asked for the date and refuses
  const r = await runOnce(sb.config, { apply: true, sleep: async () => {} });
  expect(r.items[0]).toMatchObject({ outcome: 'moved', route: 'invoices', renamed: false, detail: 'naming_model_refusal' });
  expect(await readdir(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'))).toEqual(['bill.txt']); expect(await readdir(sb.review)).toEqual([]);
  const h = await readHistory(stateFiles(sb.config).history);
  expect(h.find(x => x.type === 'move')).toMatchObject({ outcome: 'moved', reason: 'rule_match:naming_model_refusal' }); // the specific naming reason is logged
  const cl = await runCli(['classify', join(sb.dir, 'x.txt')]); expect(cl.code).toBe(1);
  const f = join(sb.dir, 'k.txt'); await writeFile(f, 'Rechnung\nDrei Betrag 10 EUR');
  expect(JSON.parse((await runCli(['classify', f, '--config', await cfgFor(sb, { classifier: sb.config.classifier })])).out)).toMatchObject({ route: 'invoices', renamed: false, namingReason: 'naming_model_refusal' });
 } finally { await sb.cleanup(); }
});
test('classify(): a definitive failure on a rule hit does not become a review; a rule-less file with the same failure does', async () => {
 const refuse = async () => { throw new HelperError('helper_failed', 1, 'guardrail_violation'); };
 const hit = await classify('c.txt', 'Mietvertrag Wohnung 5', config, { model: refuse });
 expect(hit).toMatchObject({ route: 'contracts', tier: 'rule', needsReview: false, reason: 'rule_match', namingReason: 'naming_model_guardrail' });
 expect(await classify('n.txt', 'a short unclear note', config, { model: refuse })).toMatchObject({ route: null, needsReview: true, reason: 'model_guardrail' });
});

// ---------------------------------------------------------------- 6. validated state files
test('pending.json: invalid entries are dropped (warning), never wedge a file or flush it; __proto__ is an ordinary file name', async () => {
 const sb = await sandbox(); try {
  const f = stateFiles(sb.config).pending; await mkdir(sb.state, { recursive: true });
  const sha = 'ab'.repeat(32), good = { kind: 'model', reason: 'model_busy', sha256: sha, since: 1, lastSeen: 2, attempts: 1, next: 3 };
  const entries = JSON.parse(`{"good.txt":${JSON.stringify(good)},"str.txt":{"kind":"model","reason":"x","since":"x","lastSeen":2,"attempts":1,"next":3},"null.txt":{"kind":"model","reason":"x","since":null,"lastSeen":2,"attempts":1,"next":3},
   "kind.txt":{"kind":"evil","reason":"x","since":1,"lastSeen":2,"attempts":1,"next":3},"neg.txt":{"kind":"model","reason":"x","since":1,"lastSeen":2,"attempts":-4,"next":3},"huge.txt":{"kind":"model","reason":"x","since":1,"lastSeen":2,"attempts":1,"next":1e300},
   "sha.txt":{"kind":"model","reason":"x","sha256":"zz","since":1,"lastSeen":2,"attempts":1,"next":3},"arr.txt":[1],"num.txt":5,"__proto__":{"kind":"model","reason":"model_busy","since":1,"lastSeen":2,"attempts":1,"next":3}}`);
  await writeFile(f, JSON.stringify({ v: 1, entries: 'x' })); expect((await PendingStore.load(f)).list()).toEqual([]);
  await writeFile(f, JSON.stringify({ v: 1, entries })); const store = await PendingStore.load(f);
  expect(store.list().map(e => e.name).sort()).toEqual(['__proto__', 'good.txt']);
  expect(store.get('__proto__')).toMatchObject({ reason: 'model_busy' }); expect(store.get('constructor')).toBeUndefined(); expect(store.get('toString')).toBeUndefined();
  store.touch('other.txt', 'empty', 'empty_file'); await store.save();
  const saved = JSON.parse(await readFile(f, 'utf8')).entries; expect(Object.keys(saved).sort()).toEqual(['__proto__', 'good.txt', 'other.txt']);
  // end to end: a corrupt entry for a real file is dropped, the file is processed normally (not wedged, not flushed to review)
  await writeFile(f, JSON.stringify({ v: 1, entries: { 'note.txt': { kind: 'model', reason: 'model_busy', sha256: null, since: 'x', lastSeen: 0, attempts: 9, next: 'x' } } }));
  await put(sb, 'note.txt', 'a short unclear note');
  const r = await runOnce(sb.config, { apply: true, model: healthy, sleep: async () => {} });
  expect(r.items[0]).toMatchObject({ outcome: 'moved', route: 'personal' });
 } finally { await sb.cleanup(); }
});
test('held.json: entries are validated; bad keys/values are dropped, null-prototype map, valid holds survive', async () => {
 const sb = await sandbox(); try {
  const f = stateFiles(sb.config).held; await mkdir(sb.state, { recursive: true });
  const sha = 'cd'.repeat(32);
  await writeFile(f, JSON.stringify({ v: 1, entries: { [`${sha}:a.txt`]: { at: 5 }, 'abc:b.txt': { at: 5 }, [`${sha}:c.txt`]: { at: 'x' }, [`${sha}:d.txt`]: 7, [`${sha}:e.txt`]: null, '__proto__': { at: 1 }, [`${sha}:`]: { at: 1 } } }));
  const held = await HeldStore.load(f);
  expect(held.size).toBe(1); expect(held.has(sha, 'a.txt')).toBe(true); expect(held.has(sha, 'c.txt')).toBe(false); expect(held.has('abc', 'b.txt')).toBe(false);
  await held.save(); expect(Object.keys(JSON.parse(await readFile(f, 'utf8')).entries)).toEqual([`${sha}:a.txt`]); // rewritten without the bad entries
  await writeFile(f, '[1,2]'); expect((await HeldStore.load(f)).size).toBe(0);
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- 7. sender stop-words, 8. linear-time dates, 10. contracts rule
test('stop-words are never accepted as a sender (articles, pronouns, greetings, mail headers); real names and known senders still are', () => {
 const text = 'Die Rechnung. Der Kunde. Re: Anfrage. An Herr Müller. Sehr geehrte Damen. Dear Sir. Und Von The. Die Presse GmbH, Drei Austria, Billa';
 for (const w of ['Die', 'der', 'Und', 'The', 'Von', 'Sehr', 'Re', 'An', 'Dear', 'Die Rechnung', 'Sehr geehrte', 'Herr', 'Kunde']) expect(validatedSender(w, text, config), w).toBeNull();
 expect(validatedSender('Die Presse', text, config)).toBe('Die-Presse'); expect(validatedSender('Billa', text, config)).toBe('Billa'); expect(validatedSender('Drei', text, config)).toBe('Drei');
});
test('labelledDate is linear: 256 KiB of date-heavy text finishes quickly, and still finds the labelled date', () => {
 const cap = 256 * 1024;
 const inputs = [
  'Datum 01.02.2026\n'.repeat(Math.floor(cap / 17)),                                   // a label before every date
  '01.02.2026 '.repeat(Math.floor(cap / 11)) + '\nRechnungsdatum 03.04.2026\n',         // dates only, one label at the end
  'Rechnungsdatum '.repeat(Math.floor(cap / 15)) + '03.04.2026',                       // labels only
  ('Datum 1.1.2026 ' + 'x'.repeat(20)).repeat(Math.floor(cap / 35))
 ];
 for (const text of inputs) { const t0 = performance.now(); labelledDate(text); expect(performance.now() - t0, `${text.slice(0, 20)}`).toBeLessThan(300); }
 expect(labelledDate(inputs[1]!)).toBe('2026-04-03'); // the only labelled date wins over 23 000 unlabelled ones
});
test('contracts rule: the Sozialversicherung compound is excluded, other *versicherung compounds stay', () => {
 for (const t of ['Sozialversicherung', 'Sozialversicherungsnummer 1234', 'Bescheid der Sozialversicherung']) expect(heuristics('x.txt', t, config), t).toBeNull();
 expect(heuristics('x.txt', 'Sozialversicherungsanstalt Wien', config)?.id).toBe('admin'); // round 11: a strong authority word, never contracts
 for (const t of ['Krankenversicherung', 'Haftpflichtversicherung Polizze', 'Versicherung', 'Rentenversicherungsträger', 'Sozialversicherung und Mietvertrag']) expect(heuristics('x.txt', t, config)?.id, t).toBe('contracts');
});

// ---------------------------------------------------------------- 9. doctor, 11. defaults, 12. logs
test('doctor: the opt-in non-atomic fallback is reported as such, never as OS-level verified; unresolved journal entries and file errors are listed', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config);
  const fb = await probeExclusiveRename(layout, { forceFallback: true });
  expect(fb).toMatchObject({ ok: true, native: false }); expect(fb.detail).toContain('NON-ATOMIC'); expect(fb.detail).not.toContain('OS-level (renamex_np / renameat2) verified');
  expect(await probeExclusiveRename(layout)).toMatchObject({ ok: true, native: true });
  const checks = async () => doctor(sb.config, async () => ({ code: 1, output: '' }));
  expect((await checks()).find(c => c.name.startsWith('history journal'))).toMatchObject({ ok: true });
  expect((await checks()).find(c => c.name.startsWith('native Apple silicon'))).toMatchObject({ required: true });
  const src = join(sb.inbox, 'a.txt'); await writeFile(src, 'x');
  await makeJournal(stateFiles(sb.config).history, { runId: 'r', mode: 'run', source: src, sha256: 'ab'.repeat(32), size: 1, route: 'uni', tier: 'rule', outcome: 'moved', reason: 'rule_match', renamed: false }).intent(join(sb.root, '01_Uni', 'a.txt'));
  expect((await checks()).find(c => c.name.startsWith('history journal'))).toMatchObject({ ok: false, required: false });
 } finally { await sb.cleanup(); }
});
test('defaults: daemon.intervalSec 120 and stabilityRetries 2 (shared window), in the shipped config and as validation defaults', () => {
 expect(config.daemon.intervalSec).toBe(120); expect(config.stabilityRetries).toBe(2);
 const bare = { ...baseJson }; delete bare.stabilityRetries; bare.daemon = {};
 const v = validateConfig(bare); expect(v.stabilityRetries).toBe(2); expect(v.daemon.intervalSec).toBe(120);
});
test('log rotation: launchd files above the limit are copied to .1/.2 (max 3 files) and truncated in place; small files and missing files are left alone', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'ct-log-'));
 try {
  const f = join(dir, 'launchd.out.log');
  expect(await rotateLogs(dir, ['launchd.out.log', 'missing.log'], 10, 3)).toEqual([]);
  for (const [i, body] of ['first-first-first', 'second-second', 'third-third-third', 'fourth-fourth'].entries()) { await appendFile(f, body); expect(await rotateLogs(dir, ['launchd.out.log'], 10, 3), String(i)).toEqual(['launchd.out.log']); }
  expect((await stat(f)).size).toBe(0);
  expect(await readFile(`${f}.1`, 'utf8')).toBe('fourth-fourth'); expect(await readFile(`${f}.2`, 'utf8')).toBe('third-third-third'); expect((await readdir(dir)).sort()).toEqual(['launchd.out.log', 'launchd.out.log.1', 'launchd.out.log.2']);
  expect(((await stat(`${f}.1`)).mode & 0o777)).toBe(0o600);
  await appendFile(f, 'tiny'); expect(await rotateLogs(dir, ['launchd.out.log'], 10, 3)).toEqual([]);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 13. UX
test('config errors name the key and the reason; a missing config or root is a clean message, not a raw ENOENT', async () => {
 const bad = (patch: Record<string, unknown>) => { try { validateConfig({ ...baseJson, ...patch }); return ''; } catch (e) { return (e as Error).message; } };
 expect(bad({ daemon: { intervalSec: 5 } })).toBe('Invalid configuration: "daemon.intervalSec" must be a whole number from 60 to 86400 (found 5)');
 expect(bad({ model: { maxDeferHours: 'x' } })).toContain('"model.maxDeferHours"');
 expect(bad({ routes: [{ ...baseJson.routes[0], patterns: ['('] }] })).toMatch(/routes\[0\] \("uni"\): "patterns\[0\]" is not a valid regular expression/);
 expect(bad({ routes: [{ ...baseJson.routes[0], folder: '05_Neu' }] })).toContain('"folder" must start with one of the buckets');
 expect(bad({ timeoutMs: 1 })).toContain('"timeoutMs"'); expect(bad({ naming: { datePrefix: 'yes' } })).toContain('"naming.datePrefix" must be true or false');
 await expect(loadConfig('/nonexistent/c.json')).rejects.toThrow('not found');
 const sb = await sandbox(); try {
  const cfg = await cfgFor(sb, { root: join(sb.dir, 'nope') });
  for (const args of [['scan', '--dry-run'], ['init'], ['run']]) { const r = await runCli([...args, '--config', cfg]); expect(r.code, args.join(' ')).toBe(1); expect(r.err).toContain('root folder not found'); expect(r.err).not.toContain('ENOENT'); }
  await writeFile(join(sb.dir, 'broken.json'), '{ nope'); const r = await runCli(['status', '--config', join(sb.dir, 'broken.json')]); expect(r.code).toBe(1); expect(r.err).toContain('not valid JSON');
 } finally { await sb.cleanup(); }
});
test('sweep preview summarizes skipped folders (names only with --verbose); run prints one line when there is nothing to do; install --print shows the resolved root', async () => {
 const sb = await sandbox(); try {
  const cfg = await cfgFor(sb);
  const sweep = await runCli(['sweep', '--config', cfg]); expect(sweep.code).toBe(0);
  expect(sweep.out).toMatch(/skipped\s+\d+ folders/); expect(sweep.out).not.toContain('(directory)'); expect(sweep.out).not.toContain('01_Uni');
  const verbose = await runCli(['sweep', '--verbose', '--config', cfg]); expect(verbose.out).toContain('01_Uni  (directory)');
  const quiet = await runCli(['run', '--config', cfg]); expect(quiet.out.trim().split('\n')).toHaveLength(1); expect(quiet.out).toContain('nothing to sort');
  const pr = await runCli(['install', '--print', '--bun', process.execPath, '--config', cfg]);
  expect(pr.out).toContain(`<string>${sb.inbox}</string>`); expect(pr.err).toContain(`watching ${sb.inbox}`);
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- 4./5. init is the only creator; recovery with a re-created source name
test('N-08: on a bare iCloud folder nothing is created by run; `init --yes` creates the full taxonomy, then moves work and doctor is happy', async () => {
 const sb = await sandbox({}, { taxonomy: false }); try {
  await put(sb, 'sheet.txt', 'VO 123.456 exercise sheet'); await put(sb, 'mystery.txt', 'something unclear');
  const cfg = await cfgFor(sb, { classifier: join(sb.dir, 'none') });
  const r = await runCli(['run', '--apply', '--config', cfg]);
  expect(r.code).toBe(1); expect(r.out).toContain('folder_missing'); // file stays put; the run reports an error
  expect((await readdir(sb.root)).sort()).toEqual(['_Inbox']); expect((await readdir(sb.inbox)).sort()).toEqual(['mystery.txt', 'sheet.txt']);
  const checks = await doctor(sb.config, async () => ({ code: 1, output: '' }));
  expect(checks.find(c => c.name.startsWith('taxonomy'))).toMatchObject({ ok: false, required: true });
  await applyInit(await resolveLayout(sb.config), sb.config);
  expect((await readdir(sb.inbox)).sort()).toEqual(['Needs_Review', 'mystery.txt', 'sheet.txt']);
  const again = await runOnce(sb.config, { apply: true, model: model({ needsReview: true }) });
  expect(again.counts).toMatchObject({ moved: 1, review: 1, errors: 0 });
  expect(await readdir(join(sb.root, '01_Uni'))).toEqual(['sheet.txt']); expect(await readdir(sb.review)).toEqual(['mystery.txt']);
  expect((await doctor(sb.config, async () => ({ code: 1, output: '' }))).find(c => c.name.startsWith('taxonomy'))).toMatchObject({ ok: true });
 } finally { await sb.cleanup(); }
});
test('recovery: a different file re-created at the source name after a failed rollback does not hide that the destination is ours (inode match); a mismatching inode still aborts', async () => {
 for (const sameIno of [true, false]) {
  const sb = await sandbox(); try {
   const f = stateFiles(sb.config).history, dst = join(sb.root, '01_Uni', 'a.txt'), src = join(sb.inbox, 'a.txt');
   await writeFile(dst, 'hello'); const d = (await fingerprint(dst))!; await writeFile(src, 'someone else wrote this');
   const sha = new Bun.CryptoHasher('sha256').update('hello').digest('hex');
   await appendHistory(f, { v: 1, type: 'intent', id: 'i1', runId: 'r1', mode: 'run', time: new Date().toISOString(), source: src, destination: dst, sha256: sha, size: 5, ino: sameIno ? d.ino : d.ino + 12345, route: 'uni', tier: 'rule', outcome: 'moved', reason: 'rule_match', renamed: false });
   expect(await reconcileIntents(f)).toEqual(sameIno ? { recovered: 1, aborted: 0 } : { recovered: 0, aborted: 1 });
   expect((await readRawHistory(f)).map(r => r.type)).toEqual(['intent', sameIno ? 'commit' : 'abort']);
   expect(await readFile(src, 'utf8')).toBe('someone else wrote this'); expect(await readFile(dst, 'utf8')).toBe('hello'); // recovery only writes journal records
  } finally { await sb.cleanup(); }
 }
});
