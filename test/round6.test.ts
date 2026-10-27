// Round 6: bounded runs, final busy call, quiet logs, honest previews, messages, log rotation warnings.
import { test, expect } from 'bun:test';
import { mkdir, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runOnce } from '../src/run';
import { HelperError } from '../src/process';
import { PendingStore } from '../src/pending';
import { HeldStore, stateFiles, writeStatus } from '../src/state';
import { sha256File } from '../src/fsx';
import { renderReport, budgetLine } from '../src/report';
import { doctor, formatChecks } from '../src/doctor';
import { rotateLogs } from '../src/log';
import { oneFileMaxSeconds, validateConfig, worstCaseLockSeconds } from '../src/config';
import { baseJson, defaultConfig, model, sandbox, type Sandbox, inboxFiles } from './helpers';

const put = (sb: Sandbox, name: string, body: string) => writeFile(join(sb.inbox, name), body);
const HOUR = 3_600_000, T0 = 1_700_000_000_000;
const healthy = model({ route: 'personal' }) as (...a: unknown[]) => Promise<unknown>;
const busy = async () => { throw new HelperError('helper_failed', 4); };
const unavailable = async () => { throw new HelperError('helper_unavailable'); };
async function cliHelp() { const p = Bun.spawn([process.execPath, resolve('src/cli.ts'), '--help'], { stdout: 'pipe', stderr: 'pipe' }); return new Response(p.stdout).text(); }

// ---------------------------------------------------------------- A. time budget
test('A config: maxRunSeconds defaults to 300, range 60-3600, validated like the other numbers; the worst-case lock hold is budget + one file', () => {
 expect(defaultConfig.maxRunSeconds).toBe(300); expect(baseJson.maxRunSeconds).toBe(300);
 expect(validateConfig({ ...baseJson, maxRunSeconds: undefined }).maxRunSeconds).toBe(300);
 for (const bad of [59, 3601, 1.5, '300', null]) expect(() => validateConfig({ ...baseJson, maxRunSeconds: bad }), String(bad)).toThrow('"maxRunSeconds"');
 expect(validateConfig({ ...baseJson, maxRunSeconds: 60 }).maxRunSeconds).toBe(60); expect(validateConfig({ ...baseJson, maxRunSeconds: 3600 }).maxRunSeconds).toBe(3600);
 expect(worstCaseLockSeconds(defaultConfig)).toBe(300 + oneFileMaxSeconds(defaultConfig)); expect(oneFileMaxSeconds(defaultConfig)).toBeGreaterThanOrEqual(2 * 60);
});
test('A once the budget is spent no further file is started: the rest is untouched (no pending entry, no attempt, no review) and is processed on the next run', async () => {
 const sb = await sandbox({ maxRunSeconds: 250 }); try {
  for (const n of 'abcde') await put(sb, `${n}.txt`, `unclear note ${n}`);
  let clk = 0; const asked: string[] = [];
  const slow = (async (f: string, ...rest: unknown[]) => { asked.push(f); clk += 100_000; return healthy(f, ...rest); }) as never; // every call "takes" 100 s
  const r1 = await runOnce(sb.config, { apply: true, now: () => T0, sleep: async () => {}, model: slow, clock: () => clk });
  expect(asked).toEqual(['a.txt', 'b.txt', 'c.txt']); // started at 0 s, 100 s, 200 s; at 300 s the budget (250 s) is spent
  expect(r1.budget).toEqual({ seconds: 250, elapsedSeconds: 300, left: 2 });
  expect(r1.items.map(i => i.file).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  expect((await inboxFiles(sb)).sort()).toEqual(['d.txt', 'e.txt']); expect(await readdir(sb.review)).toEqual([]);
  expect((await PendingStore.load(stateFiles(sb.config).pending, () => T0)).list()).toEqual([]); // untouched: not even a pending entry
  expect(renderReport(r1, true).out.join('\n')).toContain('time budget reached after 300s: 2 file(s) left for the next run');
  expect(budgetLine(r1.budget!)).toBe('time budget reached after 300s: 2 file(s) left for the next run');
  asked.length = 0; clk = 0;
  const r2 = await runOnce(sb.config, { apply: true, now: () => T0, sleep: async () => {}, model: slow, clock: () => clk });
  expect(asked).toEqual(['d.txt', 'e.txt']); expect(r2.budget).toBeNull(); expect(await inboxFiles(sb)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('A expired final calls draw on the same budget: with a hanging helper only as many expired files are called as fit in it', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 }, maxRunSeconds: 100 }); try {
  for (const n of ['e1', 'e2', 'e3']) await put(sb, `${n}.txt`, `unclear ${n}`);
  let t = T0, clk = 0; const asked: string[] = [];
  const hang = (async (f: string) => { asked.push(f); clk += 60_000; throw new HelperError('helper_timeout'); }) as never;
  const run = () => runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: hang, clock: () => clk });
  await mkdir(sb.state, { recursive: true }); const store = await PendingStore.load(stateFiles(sb.config).pending, () => t);
  for (let i = 0; i < 3; i++) { for (const n of ['e1', 'e2', 'e3']) store.touch(`${n}.txt`, 'model', 'model_timeout', { sha256: await sha256File(join(sb.inbox, `${n}.txt`)), attempt: true, apply: true }); t += 2 * HOUR; } // 3 apply attempts each
  await store.save();
  t += 25 * HOUR; asked.length = 0; clk = 0;
  const r = await run(); // all three are expired now: 60 s per call, budget 100 s -> e1 (0 s), e2 (60 s), then 120 s >= 100 s: stop
  expect(asked).toEqual(['e1.txt', 'e2.txt']); expect(r.budget).toMatchObject({ left: 1 });
  expect((await readdir(sb.review)).sort()).toEqual(['e1.txt', 'e2.txt']); expect(await inboxFiles(sb)).toEqual(['e3.txt']);
  const e3 = (await PendingStore.load(stateFiles(sb.config).pending, () => t)).get('e3.txt')!; expect(e3.applyAttempts).toBe(3); // e3 got no extra attempt from the skipped run
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- B. a busy final call stays pending
test('B the final pre-expiry call returning model_busy counts as an attempt but never sends the file to review; unavailable/timeout/crash still do', async () => {
 for (const [name, fail, review] of [['busy', busy, false], ['unavailable', unavailable, true], ['timeout', async () => { throw new HelperError('helper_timeout'); }, true], ['crash', async () => { throw new HelperError('helper_failed', null); }, true]] as const) {
  const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
   await put(sb, 'note.txt', 'a short unclear note'); let t = T0;
   const run = (m: never) => runOnce(sb.config, { apply: true, model: m, now: () => t, sleep: async () => {} });
   for (let i = 0; i < 3; i++) { await run(unavailable as never); t += 10 * HOUR; } // 3 apply attempts over 30 h: expired
   const before = (await PendingStore.load(stateFiles(sb.config).pending, () => t)).get('note.txt')!.applyAttempts;
   const last = await run(fail as never);
   if (review) { expect(last.items[0], name).toMatchObject({ outcome: 'review' }); expect(last.items[0]!.reason, name).toMatch(/^deferred_too_long:/); expect(await readdir(sb.review)).toEqual(['note.txt']); }
   else {
    expect(last.items[0]).toMatchObject({ outcome: 'pending', reason: 'model_busy' }); expect(await inboxFiles(sb)).toEqual(['note.txt']); expect(await readdir(sb.review)).toEqual([]);
    expect((await PendingStore.load(stateFiles(sb.config).pending, () => t)).get('note.txt')!.applyAttempts).toBe((before ?? 0) + 1); // counted as an attempt
    t += 2 * HOUR; const again = await run(unavailable as never); // the next due run is a final call again; this time it fails transiently: review
    expect(again.items[0]).toMatchObject({ outcome: 'review', reason: 'deferred_too_long:model_unavailable' });
   }
  } finally { await sb.cleanup(); }
 }
});

// ---------------------------------------------------------------- C. quiet logs
test('C a run with nothing to sort is exactly one line even with dotfiles, .icloud placeholders, partial downloads and held files; --verbose lists everything', async () => {
 const sb = await sandbox(); try {
  await put(sb, '.DS_Store', 'x'); await put(sb, '.report.pdf.icloud', 'x'); await put(sb, 'movie.crdownload', 'x'); await put(sb, 'held.txt', 'unclear held note');
  const held = await HeldStore.load(stateFiles(sb.config).held); held.add(await sha256File(join(sb.inbox, 'held.txt')), 'held.txt'); await mkdir(sb.state, { recursive: true }); await held.save();
  const r = await runOnce(sb.config, { apply: true, model: healthy as never });
  const quiet = renderReport(r, true); expect(quiet.err).toEqual([]);
  expect(quiet.out.length).toBe(1);
  expect(quiet.out[0]).toContain('nothing to sort'); expect(quiet.out[0]).toContain('1 file(s) held after an undo'); expect(quiet.out[0]).toContain('--no-cache --apply');
  expect(quiet.out[0]).not.toContain('.DS_Store'); expect(quiet.out[0]).not.toContain('held.txt'); expect(quiet.out[0]).not.toContain('available: nothing');
  const loud = renderReport(r, true, true).out.join('\n');
  for (const n of ['.DS_Store', '.report.pdf.icloud', 'movie.crdownload', 'held.txt']) expect(loud).toContain(n);
  expect(renderReport(await runOnce(sb.config, { apply: false, readOnly: true, model: healthy as never }), false).out.length).toBe(1); // previews too
 } finally { await sb.cleanup(); }
});
test('C with real work, held files and skipped entries are summarized as one line each (no per-file lines, 20 held files = 1 line)', async () => {
 const sb = await sandbox(); try {
  await mkdir(sb.state, { recursive: true }); const held = await HeldStore.load(stateFiles(sb.config).held);
  for (let i = 0; i < 20; i++) { await put(sb, `held${i}.txt`, `held body ${i}`); held.add(await sha256File(join(sb.inbox, `held${i}.txt`)), `held${i}.txt`); }
  await held.save(); await put(sb, '.DS_Store', 'x'); await put(sb, 'b.part', 'x'); await put(sb, 'real.txt', 'VO 123.456 exercise');
  const r = await runOnce(sb.config, { apply: true, model: healthy as never }); const out = renderReport(r, true).out;
  expect(out.filter(l => l.includes('held'))).toHaveLength(1); expect(out.some(l => l.startsWith('moved'))).toBe(true);
  expect(out.filter(l => l.startsWith('skipped'))).toHaveLength(1); expect(out.join('\n')).not.toContain('.DS_Store');
  expect(out.length).toBeLessThanOrEqual(5); // head, 1 item, held line, skipped line, counts
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- D. previews tell the truth
test('D previews show the review (folder_missing:<path>) that --apply produces, and a review never carries `renamed`', async () => {
 const sb = await sandbox(); try {
  await rm(join(sb.root, '02_Admin & Finanzen'), { recursive: true });
  await put(sb, 'k2.txt', 'Kontoauszug Oktober 2026\nDatum 31.10.2026\nWiener Städtische');
  const on = { ...sb.config, naming: { datePrefix: true } };
  const want = { action: 'review', reason: 'folder_missing:02_Admin & Finanzen', renamed: false, destination: '_Inbox/Needs_Review/k2.txt' };
  for (const [label, o] of [['run preview', { apply: false }], ['scan --dry-run', { apply: false, readOnly: true }]] as const) {
   const r = await runOnce(on, { ...o, model: healthy as never }); expect(r.items[0], label).toMatchObject(want); expect(renderReport(r, false).out.join('\n'), label).not.toContain('renamed');
  }
  const sweepPrev = await runOnce(on, { apply: false, kind: 'root', mode: 'sweep', model: healthy as never }); expect(sweepPrev.items.filter(i => i.file === 'k2.txt')).toEqual([]); // (sweep looks at the root, not _Inbox)
  const applied = await runOnce(on, { apply: true, model: healthy as never });
  expect(applied.items[0]).toMatchObject({ ...want, outcome: 'review' }); expect(await readdir(sb.review)).toEqual(['k2.txt']);
 } finally { await sb.cleanup(); }
});
test('D a sweep preview shows folder_missing too; a missing Needs_Review is reported in the preview', async () => {
 const sb = await sandbox(); try {
  await rm(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.root, 'loose.txt'), 'VO 123.456 exercise');
  const p = await runOnce(sb.config, { apply: false, kind: 'root', mode: 'sweep', model: healthy as never });
  expect(p.items.find(i => i.file === 'loose.txt')).toMatchObject({ action: 'review', reason: 'folder_missing:01_Uni', renamed: false });
  await rm(sb.review, { recursive: true }); await put(sb, 'a.txt', 'unclear');
  const q = await runOnce(sb.config, { apply: false, model: model({ needsReview: true }) as never });
  expect(q.items.find(i => i.file === 'a.txt')!.detail ?? '').toContain('Needs_Review');
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- E. messages
test('E pending text: no "~0h" once the limit is over; it says how many attempts remain; a breaker-skipped file reads as not counted', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'a.txt', 'unclear a'); await put(sb, 'b.txt', 'unclear b'); let t = T0;
  const hang = (async (f: string) => { if (f === 'a.txt') throw new HelperError('helper_timeout'); return healthy(f); }) as never;
  const run = () => runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: hang });
  const r1 = await run(); t += 30 * HOUR; // the 24 h are over after one attempt only
  expect(r1.items.find(i => i.file === 'b.txt')!.detail).toContain('model failed earlier in this run, not counted as an attempt');
  expect(r1.items.find(i => i.file === 'b.txt')!.detail).not.toContain('attempt 0');
  const r2 = await run(); const d = r2.items.find(i => i.file === 'a.txt')!.detail!;
  expect(d).not.toMatch(/~0\s*h/); expect(d).toMatch(/1 more attempt has been made/); expect(d).toContain('the 24 h are over');
 } finally { await sb.cleanup(); }
});
test('E doctor: a missing root says "root folder not found: <path>"; a last run with file errors is a clear warning, not a neutral dot', async () => {
 const sb = await sandbox(); try {
  const missing = join(sb.dir, 'nope', 'iCloud');
  const checks = await doctor({ ...sb.config, root: missing }); const inbox = checks.find(c => c.name === '_Inbox readable')!;
  expect(inbox.ok).toBe(false); expect(inbox.detail).toContain(`root folder not found: ${missing}`);
  await writeStatus(sb.config, { v: 1, time: new Date().toISOString(), context: 'interactive', mode: 'apply', runId: 'r', model: { available: true, reason: 'ok' }, inboxReadable: true, counts: { errors: 1 } });
  const line = formatChecks(await doctor(sb.config)).split('\n').find(l => l.includes('last run: file errors'))!;
  expect(line.startsWith('! ')).toBe(true); expect(line).toContain('1 file(s) ended in an error'); expect(line).not.toContain('no file errors');
  expect(formatChecks(await doctor(sb.config))).toContain('run time budget bounds the lock'); expect(formatChecks(await doctor(sb.config))).toContain(`${worstCaseLockSeconds(sb.config)}s`);
 } finally { await sb.cleanup(); }
});
test('E an unreadable _Inbox is reported on stderr, not stdout', async () => {
 const sb = await sandbox(); try {
  await rm(sb.inbox, { recursive: true });
  const r = await runOnce(sb.config, { apply: false, model: healthy as never }).catch(() => null);
  if (r) { const x = renderReport(r, false); expect(x.out).toEqual([]); expect(x.err.join('\n')).toContain('not readable'); }
  const fake = renderReport({ locked: false, inboxReadable: false } as never, false); expect(fake.out).toEqual([]); expect(fake.err[0]).toContain('is not readable');
 } finally { await sb.cleanup(); }
});
test('E a file sent to review leaves pending.json in the same run', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'note.txt', 'a short unclear note'); let t = T0;
  for (let i = 0; i < 3; i++) { await runOnce(sb.config, { apply: true, model: unavailable as never, now: () => t, sleep: async () => {} }); t += 10 * HOUR; }
  const r = await runOnce(sb.config, { apply: true, model: unavailable as never, now: () => t, sleep: async () => {} });
  expect(r.items[0]).toMatchObject({ outcome: 'review' }); expect((await PendingStore.load(stateFiles(sb.config).pending, () => t)).list()).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('E --help describes init (Needs_Review, never creates any folder), classify (namingReason), doctor (taxonomy, arm64) and the run budget', async () => {
 const h = await cliHelp();
 expect(h).toContain('Needs_Review'); expect(h).not.toContain('Moves never create top-level buckets'); expect(h).toContain('Moves never create any folder');
 expect(h).toContain('namingReason'); expect(h).toContain('arm64'); expect(h).toContain('taxonomy'); expect(h).toContain('maxRunSeconds');
});

// ---------------------------------------------------------------- F. log rotation visibility
test('F rotation warns once per problem instead of skipping silently: symlinked log, unshiftable .1; never writes through a symlink', async () => {
 const sb = await sandbox(); try {
  await mkdir(sb.config.logDir, { recursive: true }); const dir = sb.config.logDir, target = join(sb.dir, 'precious.txt'); await writeFile(target, 'x'.repeat(100));
  await symlink(target, join(dir, 'launchd.out.log'));
  const warnings: string[] = [];
  expect(await rotateLogs(dir, ['launchd.out.log'], 10, 3, w => warnings.push(w))).toEqual([]);
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain('launchd.out.log'); expect(warnings[0]).toContain('symlink'); expect((await stat(target)).size).toBe(100);
  const f = join(dir, 'launchd.err.log'); await writeFile(f, 'y'.repeat(100)); await writeFile(`${f}.1`, 'old');
  await mkdir(`${f}.2`); await writeFile(join(`${f}.2`, 'blocker'), 'x'); // .1 cannot shift to .2 (a non-empty directory is there)
  warnings.length = 0;
  expect(await rotateLogs(dir, ['launchd.err.log'], 10, 3, w => warnings.push(w))).toEqual([]);
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain('launchd.err.log'); expect(warnings[0]).toContain('failed'); expect((await stat(f)).size).toBe(100); // nothing truncated when it could not be saved
  warnings.length = 0; expect(await rotateLogs(dir, ['missing.log'], 10, 3, w => warnings.push(w))).toEqual([]); expect(warnings).toEqual([]); // a missing file is not a problem
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- G. Mac eval fixtures
import { readdir as ls, readFile as rf, chmod } from 'node:fs/promises';
import { FIXTURE_DIR, runFixtureEval } from '../src/fixture-eval';
import { heuristics } from '../src/classifier';
import { parseLabels, unsafeOutputs } from '../src/evaluate';
const labelsOf = async () => JSON.parse(await rf(join(FIXTURE_DIR, 'labels.json'), 'utf8')) as Record<string, string>;
const reviewModel = (async () => ({ version: 2, route: 'review', documentDate: '', sender: '', needsReview: true })) as never;

test('G the fixtures: ~20+ synthetic documents, all 6 routes, review cases, an SVS letter, >= 4 prompt injections; labels are valid and match the files', async () => {
 const labels = await labelsOf(), files = (await ls(FIXTURE_DIR)).filter(f => f !== 'labels.json').sort();
 expect(files.length).toBeGreaterThanOrEqual(20); expect(Object.keys(labels).sort()).toEqual(files); parseLabels(labels, defaultConfig);
 for (const id of defaultConfig.routes.map(r => r.id)) expect(Object.values(labels), id).toContain(id);
 expect(Object.values(labels).filter(l => l === 'review').length).toBeGreaterThanOrEqual(3);
 expect(files.filter(f => f.startsWith('inj_')).length).toBeGreaterThanOrEqual(4);
 expect(files.some(f => f.startsWith('svs_'))).toBe(true);
 for (const f of files) expect((await rf(join(FIXTURE_DIR, f), 'utf8')).length, f).toBeLessThan(1500); // small plain text, no binaries
});
test('G eval:fixtures against the mock model: every deterministic rule-hit label is met, the SVS letter is not a contract, and unsafe outputs: 0', async () => {
 const labels = await labelsOf(), r = await runFixtureEval(defaultConfig, { model: reviewModel });
 expect(r.report.files).toBe(Object.keys(labels).length);
 let rules = 0;
 for (const row of r.report.rows) {
  const rule = heuristics(row.file, await rf(join(FIXTURE_DIR, row.file), 'utf8'), defaultConfig);
  if (rule) { rules++; expect(row.got, row.file).toBe(labels[row.file]!); expect(row.tier, row.file).toBe('rule'); }
 }
 expect(rules).toBeGreaterThanOrEqual(15); // the deterministic part of the set
 expect(r.report.misrouted).toBe(0); expect(r.report.autoInsteadOfReview).toBe(0); // the mock model never auto-routes anything wrongly
 expect(heuristics('svs.txt', await rf(join(FIXTURE_DIR, 'svs_oegk_beitragsvorschreibung.txt'), 'utf8'), defaultConfig)).toBeNull();
 expect(r.report.rows.find(x => x.file === 'svs_oegk_beitragsvorschreibung.txt')!.got).not.toBe('contracts');
 expect(r.unsafe).toEqual([]); expect(r.summary).toContain('unsafe outputs: 0'); expect(r.summary.join('\n')).toMatch(/Accuracy: \d+\/26/);
 for (const inj of r.report.rows.filter(x => x.file.startsWith('inj_'))) { expect(inj.name, inj.file).toBe(inj.file); expect(['review', labels[inj.file]!]).toContain(inj.got); } // never an unsafe name, the right route or review
});
test('G a hostile MODEL answer (path in the sender, shell in the date, route words) cannot produce an unsafe name or path either', async () => {
 const hostile = (async () => ({ version: 2, route: 'invoices', documentDate: '2026-10-03; rm -rf ~', sender: '../../etc/passwd', needsReview: false })) as never;
 const r = await runFixtureEval(defaultConfig, { model: hostile });
 expect(r.unsafe).toEqual([]);
 for (const row of r.report.rows) { expect(row.name, row.file).not.toMatch(/[\/\\;`$|]/); expect(row.name.includes('..'), row.file).toBe(false); }
});
test('G unsafeOutputs is not vacuous: it flags unknown routes, separators, .., shell characters, a changed extension and odd rename shapes', () => {
 const row = (o: object) => ({ file: 'a.txt', got: 'review', name: 'a.txt', renamed: false, ...o });
 expect(unsafeOutputs([row({}), row({ got: 'invoices', name: '2026-10-03_Drei-Rechnung.txt', renamed: true })], defaultConfig)).toEqual([]);
 for (const bad of [row({ got: 'root' }), row({ name: '../x.txt' }), row({ name: 'a/b.txt' }), row({ name: 'x;rm.txt' }), row({ name: '$(id).txt' }), row({ name: 'a.pdf' }), row({ name: '..' }), row({ name: 'x y.txt', renamed: true }), row({ name: 'a\u0000.txt' })])
  expect(unsafeOutputs([bad], defaultConfig).length, JSON.stringify(bad)).toBeGreaterThan(0);
});
test('G `bun run eval:fixtures` end to end with a real helper process: prints accuracy, review rate, latency and "unsafe outputs: 0"', async () => {
 const sb = await sandbox(); try {
  const helper = join(sb.dir, 'fake-classify'); await writeFile(helper, '#!/bin/sh\ncat >/dev/null\necho \'{"version":2,"route":"review","documentDate":"","sender":"","needsReview":true}\'\n'); await chmod(helper, 0o755);
  const cfg = join(sb.dir, 'cfg.json'); await writeFile(cfg, JSON.stringify({ ...baseJson, root: sb.root, allowNonICloudRoot: true, stateDir: join(sb.dir, 's'), logDir: join(sb.dir, 'l'), classifier: helper, ocr: helper }));
  const p = Bun.spawn([process.execPath, resolve('src/fixture-eval.ts'), '--config', cfg], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLOUDTIDY_QUIET: '1' } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0); expect(out).toContain('unsafe outputs: 0'); expect(out).toMatch(/Accuracy: \d+\/\d+/); expect(out).toContain('Review rate:'); expect(out).toContain('Latency:');
  expect(JSON.parse(await rf(resolve('package.json'), 'utf8')).scripts['eval:fixtures']).toBe('bun src/fixture-eval.ts');
 } finally { await sb.cleanup(); }
});
