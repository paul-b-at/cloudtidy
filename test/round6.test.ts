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
  expect(quiet.out[0]).toContain('nothing to sort'); expect(quiet.out[0]).toContain('1 file(s) held after an undo'); expect(quiet.out[0]).toContain('bun src/cli.ts run --apply --no-cache');
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

test('G the fixtures: ~20+ synthetic documents, every route, review cases, an SVS letter, >= 4 prompt injections; labels are valid and match the files', async () => {
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
 expect(heuristics('svs.txt', await rf(join(FIXTURE_DIR, 'svs_oegk_beitragsvorschreibung.txt'), 'utf8'), defaultConfig)?.id).toBe('admin'); // round 11: SVS/ÖGK are admin patterns
 expect(r.report.rows.find(x => x.file === 'svs_oegk_beitragsvorschreibung.txt')!.got).not.toBe('contracts');
 expect(r.unsafe).toEqual([]); expect(r.summary).toContain('unsafe outputs: 0'); expect(r.summary.join('\n')).toMatch(/Accuracy: \d+\/38/);
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

// ================================================================ Round 6 review fixes (safety + conformance)
import { link } from 'node:fs/promises';
import { extractNaming, knownSenderMatches, senderCharsOk, validatedSender } from '../src/naming';
import { plistInput, renderPlist } from '../src/install';
import { BUSY_CAP } from '../src/pending';
const fixtureText = (n: string) => rf(join(FIXTURE_DIR, n), 'utf8');
const routeOf = (id: string) => defaultConfig.routes.find(r => r.id === id)!;
async function expire(sb: Sandbox, t: { v: number }, run: (m: never) => Promise<unknown>) { for (let i = 0; i < 3; i++) { await run(unavailable as never); t.v += 10 * HOUR; } } // 3 apply attempts over 30 h: expired

test('HIGH-1 one unreadable destination folder (chmod 000) errors only its own file; the unrelated file still moves and previews/scan do not throw', async () => {
 const sb = await sandbox(); const bucket = join(sb.root, '02_Admin & Finanzen'); try {
  await put(sb, 'a.txt', 'Rechnung Nr. 1\nBetrag 10,00 EUR'); await put(sb, 'unrelated.txt', 'Flugticket Wien');
  await chmod(bucket, 0o000);
  if (await ls(bucket).then(() => true, () => false)) { console.warn('HIGH-1 test: permissions are not enforced for this user (root); run it as an unprivileged user'); return; }
  const m = model({ route: 'personal' }) as never;
  for (const o of [{ apply: false }, { apply: false, readOnly: true }]) {
   const r = await runOnce(sb.config, { ...o, model: m }); const a = r.items.find(i => i.file === 'a.txt')!; // must not throw
   expect(a.outcome).toBe('error'); expect(a.reason).toContain('destination_unreadable:EACCES'); expect(a.renamed).toBe(false); expect(r.items.find(i => i.file === 'unrelated.txt')!.outcome).toBe('planned');
  }
  const r = await runOnce(sb.config, { apply: true, model: m });
  const by = Object.fromEntries(r.items.map(i => [i.file, i.outcome]));
  expect(by['unrelated.txt']).toBe('moved'); expect(by['a.txt']).toBe('error'); // like before round 6: only the affected file errors
  expect(await ls(join(sb.root, '04_Persönlich'))).toContain('unrelated.txt');
 } finally { await chmod(bucket, 0o755).catch(() => {}); await sb.cleanup(); }
});

test('HIGH-2 an expired file whose final call was model_busy keeps its backoff: 1 call in 6 runs, and the files behind it are not starved', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 }, maxRunSeconds: 250 }); try {
  await put(sb, 'a1.txt', 'unclear a1'); await put(sb, 'a2.txt', 'unclear a2'); await put(sb, 'a3.txt', 'unclear a3'); await put(sb, 'zz_uni.txt', 'VO 123.456 Algorithmen');
  const t = { v: T0 }; let clk = 0, calls = 0; const counting = (async () => { calls++; clk += 100_000; throw new HelperError('helper_failed', 4); }) as never;
  const run = (m: never) => runOnce(sb.config, { apply: true, now: () => t.v, sleep: async () => {}, model: m, clock: () => clk });
  const quiet = (async () => { throw new HelperError('helper_unavailable'); }) as never;
  await mkdir(sb.state, { recursive: true }); const store = await PendingStore.load(stateFiles(sb.config).pending, () => t.v);
  for (let i = 0; i < 3; i++) { for (const n of ['a1', 'a2', 'a3']) store.touch(`${n}.txt`, 'model', 'model_unavailable', { sha256: await sha256File(join(sb.inbox, `${n}.txt`)), attempt: true, apply: true }); t.v += 10 * HOUR; }
  await store.save(); void quiet;
  const first = await run(counting); // final calls (expired): busy for a1 and a2 (100 s each, 250 s budget -> a3 at 200 s too); zz_uni is behind them
  const afterFirst = calls; expect(afterFirst).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < 6; i++) { t.v += 2 * 60_000; clk = 0; await run(counting); }
  expect(calls).toBe(afterFirst); // 6 more runs 2 min apart: no call at all (the backoff holds), not one per run
  expect(await inboxFiles(sb)).not.toContain('zz_uni.txt'); expect(await readdir(join(sb.root, '01_Uni'))).toContain('zz_uni.txt'); // the rule-routable file moved (first run: left by budget; later runs: no model needed)
  void first;
 } finally { await sb.cleanup(); }
});

test('HIGH-2b (the review scenario) one expired+busy file: 1 helper call in 6 runs 2 min apart', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'note.txt', 'a short unclear note'); const t = { v: T0 }; let calls = 0;
  const busyCount = (async () => { calls++; throw new HelperError('helper_failed', 4); }) as never;
  const run = (m: never) => runOnce(sb.config, { apply: true, now: () => t.v, sleep: async () => {}, model: m });
  await expire(sb, t, run as never); calls = 0;
  await run(busyCount); expect(calls).toBe(1); // the final call
  for (let i = 0; i < 5; i++) { t.v += 2 * 60_000; await run(busyCount); }
  expect(calls).toBe(1);
  const e = (await PendingStore.load(stateFiles(sb.config).pending, () => t.v)).get('note.txt')!; expect(e.reason).toBe('model_busy');
 } finally { await sb.cleanup(); }
});

test('M1 a permanently busy file is not pending forever: after 4 x maxDeferHours a busy final call sends it to review (deferred_too_long:model_busy)', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'note.txt', 'a short unclear note'); const t = { v: T0 };
  const run = (m: never) => runOnce(sb.config, { apply: true, now: () => t.v, sleep: async () => {}, model: m });
  await expire(sb, t, run as never);
  const r1 = await run(busy as never); expect(r1.items[0]).toMatchObject({ outcome: 'pending', reason: 'model_busy' });
  const since = (await PendingStore.load(stateFiles(sb.config).pending, () => t.v)).get('note.txt')!.applySince!;
  t.v = since + (BUSY_CAP * 24 - 1) * HOUR; expect((await run(busy as never)).items[0]).toMatchObject({ outcome: 'pending', reason: 'model_busy' }); // still inside the cap
  t.v = since + (BUSY_CAP * 24 + 1) * HOUR; const r3 = await run(busy as never);
  expect(r3.items[0]).toMatchObject({ outcome: 'review', reason: 'deferred_too_long:model_busy' }); expect(await readdir(sb.review)).toEqual(['note.txt']);
 } finally { await sb.cleanup(); }
});

test('L6 the pending text after a busy final call says it stays pending (not "goes to Needs_Review at the next attempt")', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'note.txt', 'a short unclear note'); const t = { v: T0 };
  const run = (m: never) => runOnce(sb.config, { apply: true, now: () => t.v, sleep: async () => {}, model: m });
  await expire(sb, t, run as never);
  const d = (await run(busy as never)).items[0]!.detail!;
  expect(d).toContain('busy'); expect(d).toContain('stays pending'); expect(d).not.toContain('at the next attempt'); expect(d).toMatch(/after ~\d+ h/);
 } finally { await sb.cleanup(); }
});

test('M2 the quiet no-op line counts files that can never be sorted (symlink, ...), but stays silent for dotfiles, .icloud, partial downloads', async () => {
 const sb = await sandbox(); try {
  await put(sb, '.DS_Store', 'x'); await put(sb, 'a.crdownload', 'x');
  expect(renderReport(await runOnce(sb.config, { apply: true, model: healthy as never }), true).out).toHaveLength(1);
  expect(renderReport(await runOnce(sb.config, { apply: true, model: healthy as never }), true).out[0]).not.toContain("can't be handled");
  await symlink('/etc/hostname', join(sb.inbox, 'link.txt'));
  const out = renderReport(await runOnce(sb.config, { apply: true, model: healthy as never }), true).out;
  expect(out).toHaveLength(1); expect(out[0]).toContain("1 file(s) can't be handled (symlink)"); expect(out[0]).toContain('--verbose'); expect(out[0]).not.toContain('.DS_Store');
 } finally { await sb.cleanup(); }
});

test('M3 eval:fixtures does not give false assurance: documents that were not evaluated -> warning + exit 2; a re-routed injection -> exit 1', async () => {
 const down = await runFixtureEval(defaultConfig, { model: unavailable as never });
 expect(down.notEvaluated.length).toBeGreaterThan(5); expect(down.exitCode).toBe(2); expect(down.summary.join('\n')).toContain('NOT evaluated'); expect(down.summary.join('\n')).toContain('not meaningful');
 const ok = await runFixtureEval(defaultConfig, { model: reviewModel });
 expect(ok.notEvaluated).toEqual([]); expect(ok.exitCode).toBe(0); expect(ok.injectionFailures).toEqual([]);
 const forced = await runFixtureEval(defaultConfig, { model: (async () => ({ version: 2, route: 'contracts', documentDate: '', sender: '', needsReview: false })) as never }); // the injection "worked"
 expect(forced.injectionFailures.some(x => x.startsWith('inj_json_escape_note.txt'))).toBe(true); expect(forced.exitCode).toBe(1); expect(forced.unsafe).toEqual([]);
 expect(forced.summary.join('\n')).toContain('injection documents that were not resisted:');
 const svs = ok.summary.join('\n'); expect(svs).toContain('documented-acceptable review'); expect(svs).toContain('gerichtsschreiben_studium_beispiel.txt'); expect(svs).not.toContain('svs_oegk'); // round 11: the SVS letter is a rule hit; the model-only admin documents are the acceptable reviews
});

test('M3 end to end: a helper that is always busy leaves documents pending -> the CLI prints the warning and exits 2', async () => {
 const sb = await sandbox(); try {
  const helper = join(sb.dir, 'busy-classify'); await writeFile(helper, '#!/bin/sh\ncat >/dev/null\nexit 4\n'); await chmod(helper, 0o755);
  const cfg = join(sb.dir, 'cfg.json'); await writeFile(cfg, JSON.stringify({ ...baseJson, root: sb.root, allowNonICloudRoot: true, stateDir: join(sb.dir, 's'), logDir: join(sb.dir, 'l'), classifier: helper, ocr: helper, classifierRetries: 0 }));
  const p = Bun.spawn([process.execPath, resolve('src/fixture-eval.ts'), '--config', cfg], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLOUDTIDY_QUIET: '1' } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(2); expect(out).toContain('NOT evaluated');
 } finally { await sb.cleanup(); }
});

test('M1 fixtures: every injection attack also exists without a rule hit, so it reaches the model on the Mac', async () => {
 for (const n of ['inj_route_force_nomatch.txt', 'inj_filename_nomatch.txt', 'inj_path_traversal_notes.txt', 'inj_json_escape_note.txt']) expect(heuristics(n, await fixtureText(n), defaultConfig), n).toBeNull();
 for (const n of ['inj_route_force_uni.txt', 'inj_filename_passport.txt']) expect(heuristics(n, await fixtureText(n), defaultConfig), n).not.toBeNull(); // kept as rule-tier injection tests
 expect((await labelsOf())['inj_route_force_nomatch.txt']).toBe('review');
});

test('L1 a hard link named like a log is never truncated through; L2 normal rotation still works (O_NOFOLLOW + ftruncate)', async () => {
 const sb = await sandbox(); try {
  await mkdir(sb.config.logDir, { recursive: true }); const dir = sb.config.logDir, victim = join(sb.dir, 'victim.txt'); await writeFile(victim, 'v'.repeat(100));
  await link(victim, join(dir, 'launchd.out.log')); const warnings: string[] = [];
  expect(await rotateLogs(dir, ['launchd.out.log'], 10, 3, w => warnings.push(w))).toEqual([]);
  expect((await stat(victim)).size).toBe(100); expect(warnings).toHaveLength(1); expect(warnings[0]).toContain('hard link');
  const f = join(dir, 'launchd.err.log'); await writeFile(f, 'y'.repeat(100));
  expect(await rotateLogs(dir, ['launchd.err.log'], 10, 3, w => warnings.push(w))).toEqual(['launchd.err.log']); expect((await stat(f)).size).toBe(0); expect((await stat(`${f}.1`)).size).toBe(100);
 } finally { await sb.cleanup(); }
});

test('L5 the budget outcome is recorded in status.json and doctor/status warn when the last runs hit it', async () => {
 const sb = await sandbox({ maxRunSeconds: 60 }); try {
  for (const n of 'abc') await put(sb, `${n}.txt`, `unclear ${n}`);
  let clk = 0; const slow = (async (f: string, ...rest: unknown[]) => { clk += 100_000; return healthy(f, ...rest); }) as never;
  const status = async () => JSON.parse(await rf(stateFiles(sb.config).status, 'utf8'));
  await runOnce(sb.config, { apply: false, now: () => T0, sleep: async () => {}, model: slow, clock: () => clk }); clk = 0;
  expect((await status()).budget).toMatchObject({ hit: true, left: 2, streak: 1 }); // dry-run: nothing moved, so the budget is hit again
  clk = 0; await runOnce(sb.config, { apply: false, now: () => T0, sleep: async () => {}, model: slow, clock: () => clk });
  expect((await status()).budget).toMatchObject({ hit: true, streak: 2 });
  const line = formatChecks(await doctor(sb.config)).split('\n').find(l => l.includes('last run: time budget'))!;
  expect(line.startsWith('! ')).toBe(true); expect(line).toContain('2 run(s) in a row');
  await runOnce(sb.config, { apply: false, now: () => T0, sleep: async () => {}, model: healthy as never, clock: () => 0 });
  expect((await status()).budget).toEqual({ hit: false, left: 0, streak: 0 }); expect(formatChecks(await doctor(sb.config))).not.toContain('last run: time budget');
 } finally { await sb.cleanup(); }
});

test('L7 the generated LaunchAgent never sets CLOUDTIDY_QUIET (it would hide errors, rotation warnings and journal messages)', () => {
 const xml = renderPlist(plistInput(defaultConfig, '/tmp/cfg.json', '/tmp/inbox', '/usr/local/bin/bun', '/usr/bin/pdftotext'));
 expect(xml).not.toContain('CLOUDTIDY_QUIET'); expect(xml).toContain('CLOUDTIDY_CONTEXT');
});

test('L5(conformance) a dry-run `run` prints the verb "review" for review proposals, like scan and --apply', async () => {
 const sb = await sandbox(); try {
  await rm(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'), { recursive: true }); await put(sb, 'fm.txt', 'Rechnung Nr. 5\nBetrag 5,00 EUR');
  const lines = renderReport(await runOnce(sb.config, { apply: false, model: healthy as never }), false).out;
  expect(lines.find(l => l.includes('fm.txt'))!).toMatch(/^review\s+fm\.txt/); expect(lines.join('\n')).not.toMatch(/^planned\s+fm\.txt/m);
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- H1 known senders
test('H1 "drei" / "magenta" / "verbund" in running text are not senders; the Mietvertrag fixture is not renamed to Drei-Vertrag', async () => {
 const inv = routeOf('invoices'), con = routeOf('contracts');
 for (const txt of ['Zahlbar innerhalb von drei Tagen', 'Wandfarbe magenta, 2 Eimer', 'Im Verbund mit der Gemeinde', 'Kaution drei Monatsmieten', 'Drei Tage nach Erhalt']) {
  const body = `Rechnung Maler Huber\n${'Leistung der Firma. '.repeat(80)}\n${txt}`; // the phrase is beyond the letterhead window
  expect(extractNaming(body, inv, defaultConfig).sender, txt).toBeNull();
 }
 expect(extractNaming('Foo\nKaution drei Monatsmieten', con, defaultConfig).sender).toBeNull();
 const text = await fixtureText('mietvertrag_musterstrasse.txt'); expect(extractNaming(text, con, defaultConfig).sender).toBeNull();
 const r = await runFixtureEval(defaultConfig, { model: reviewModel }); expect(r.report.rows.find(x => x.file === 'mietvertrag_musterstrasse.txt')!.name).not.toContain('Drei');
 expect(validatedSender('Drei', 'Rechnung\n' + 'x '.repeat(900) + 'drei Tagen', defaultConfig)).toBeNull(); // a model that suggests the ordinary word does not get it either
});

test('H1 an explicit Absender:/From: line beats a bare known-sender hit', () => {
 const inv = routeOf('invoices');
 const t = 'Foo Consulting GmbH\nRechnung\nRechnungsdatum: 03.11.2026\nZahlbar innerhalb von drei Tagen\nDrei Tagen nach Erhalt\nAbsender: Foo Consulting';
 expect(extractNaming(t, inv, defaultConfig).sender).toBe('Foo Consulting');
 expect(validatedSender('Foo Consulting', t, defaultConfig)).toBe('Foo-Consulting');
 // even a real known sender in the body does not beat the letterhead/Absender
 expect(extractNaming('Absender: Foo Consulting\nRechnung\nWien Energie Rechnung liegt bei', inv, defaultConfig).sender).toBe('Foo Consulting');
 expect(extractNaming('Foo Consulting GmbH\nRechnung\nWien Energie hat uns beliefert', inv, defaultConfig).sender).toBe('Foo Consulting GmbH');
});

test('H1 the real Drei / Magenta / Verbund / Wien Energie invoices still name correctly (letterhead, company suffix, capitals, aliases); matching is case-sensitive', () => {
 const inv = routeOf('invoices'), s = (t: string) => extractNaming(t, inv, defaultConfig).sender;
 expect(s('Drei\nRechnung 10/2026')).toBe('Drei'); expect(s('Hutchison Drei Austria GmbH\nRechnung')).toBe('Drei'); expect(s('DREI\nRechnung')).toBe('Drei');
 expect(s('Rechnung\n' + 'x '.repeat(900) + 'Drei Austria GmbH')).toBe('Drei'); // beyond the window but followed by a company suffix
 expect(s('Magenta Telekom\nRechnung')).toBe('Magenta'); expect(s('Rechnung\n' + 'x '.repeat(900) + 'VERBUND AG')).toBe('Verbund'); expect(s('VERBUND AG\nRechnung')).toBe('Verbund');
 expect(s('Wien Energie GmbH\nRechnung')).toBe('Wien Energie'); expect(s('WIEN ENERGIE\nRechnung')).toBe('Wien Energie');
 expect(s('Rechnung\nvon wien energie')).toBeNull(); // wrong case: not the configured spelling
 expect([...knownSenderMatches('Allianz Versicherung AG', defaultConfig)]).toEqual(['Allianz']);
});

// ---------------------------------------------------------------- round 6c: known-sender rules
test('F-a commonWord senders have no window: "Kaution: Drei Monatsmieten" and "Im Verbund mit der Gemeinde Linz" give no sender, even in a short document', () => {
 const inv = routeOf('invoices'), con = routeOf('contracts');
 expect(extractNaming('Mietvertrag\nVertragsdatum: 20.10.2026\nKaution: Drei Monatsmieten.', con, defaultConfig).sender).toBeNull();
 expect(extractNaming('Rechnung Nr 5\nRechnungsdatum: 03.11.2026\nIm Verbund mit der Gemeinde Linz.', inv, defaultConfig).sender).toBeNull();
 expect(extractNaming('Mietvertrag\nDrei Monate Kündigungsfrist\nVerbund der Eigentümer', con, defaultConfig).sender).toBeNull();
 expect(knownSenderMatches('Rechnung\nDrei Tage nach Erhalt fällig', defaultConfig).size).toBe(0);
});
test('F-a realistic Drei / Magenta / Verbund / Wien Energie / A1 / UNIQA letterheads still name correctly', () => {
 const inv = routeOf('invoices'), con = routeOf('contracts'), s = (t: string, r = inv) => extractNaming(t, r, defaultConfig).sender;
 for (const [t, want] of [['Hutchison Drei Austria GmbH\nRechnung', 'Drei'], ['Drei GmbH\nRechnung', 'Drei'], ['Drei\nRechnung 10/2026', 'Drei'], ['DREI\nRechnung', 'Drei'], ['Drei Rechnung vom 03.10.2026', 'Drei'],
  ['Magenta Telekom\nRechnung', 'Magenta'], ['MAGENTA TELEKOM\nRechnung', 'Magenta'], ['Magenta\nRechnung', 'Magenta'], ['VERBUND AG\nRechnung', 'Verbund'], ['Verbund AG\nRechnung', 'Verbund'], ['VERBUND\nRechnung', 'Verbund'],
  ['Wien Energie GmbH\nRechnung', 'Wien Energie'], ['WIEN ENERGIE\nRechnung', 'Wien Energie'], ['A1 Telekom Austria AG\nRechnung', 'A1'], ['Allianz Versicherungs-AG\nRechnung', 'Allianz'], ['Allianz Versicherungs AG\nRechnung', 'Allianz'], ['Allianz SE\nRechnung', 'Allianz']] as const) expect(s(t), t).toBe(want);
 expect(s('UNIQA Österreich Versicherungen AG\nPolizze Nr. 1', con)).toBe('UNIQA');
});
test('F-b a title line with a document word is never a sender ("Rechnung Bau GmbH")', () => {
 const inv = routeOf('invoices');
 for (const t of ['Rechnung Bau GmbH\nIm Verbund mit der Gemeinde', 'Mietvertrag Huber GmbH\nKaution: Drei Monatsmieten', 'Invoice Foo Ltd\nWien Energie GmbH', 'Polizze Muster AG\nWien Energie GmbH', 'Gutschrift Bau GmbH\nWien Energie GmbH']) {
  const sender = extractNaming(t, inv, defaultConfig).sender; expect(sender === null || sender === 'Wien Energie', t).toBe(true); expect(sender ?? '', t).not.toMatch(/Rechnung|Mietvertrag|Invoice|Polizze|Gutschrift/);
 }
 expect(extractNaming('Rechnung Bau GmbH\nIm Verbund mit der Gemeinde', inv, defaultConfig).sender).toBeNull();
 expect(extractNaming('Absender: Rechnung Bau GmbH\nZahlung folgt', inv, defaultConfig).sender).toBeNull();
});
test('3a a rejected stated sender (a far-down "Absender: Drei") falls through to a valid letterhead sender', () => {
 const inv = routeOf('invoices');
 const t = 'A1 Telekom Austria AG\nRechnung Nr. 1\n' + 'Leistung. '.repeat(40) + '\nAbsender: Drei';
 expect(extractNaming(t, inv, defaultConfig).sender).toBe('A1');
});
test('3b a stated value wins as a whole: "Absender: Evil Corp, Drei Austria" is Evil Corp, while "Absender: Drei Austria, Wien" is Drei', () => {
 const inv = routeOf('invoices');
 const evil = 'Rechnung\nAbsender: Evil Corp, Drei Austria\nDrei Austria GmbH liegt bei'; const sender = extractNaming(evil, inv, defaultConfig).sender;
 expect(sender).toBe('Evil Corp'); expect(validatedSender(sender, evil, defaultConfig)).toBe('Evil');
 expect(extractNaming('Rechnung\nAbsender: Drei Austria, Wien', inv, defaultConfig).sender).toBe('Drei');
});
test('3c the first Absender: line wins; Sender:/From: count only when there is no Absender: line (a quoted From: cannot win)', () => {
 const inv = routeOf('invoices');
 expect(extractNaming('Rechnung\nFrom: Quoted Ltd\nAbsender: Real GmbH', inv, defaultConfig).sender).toBe('Real GmbH');
 expect(extractNaming('Rechnung\nAbsender: First GmbH\nAbsender: Second GmbH', inv, defaultConfig).sender).toBe('First GmbH');
 expect(extractNaming('Rechnung\nFrom: Acme Corp', inv, defaultConfig).sender).toBe('Acme Corp'); // no Absender: line: From: is used
 expect(extractNaming('Rechnung\nAbsender: Die\nFrom: Acme Corp', inv, defaultConfig).sender).toBeNull(); // a rejected Absender: is not replaced by a From: line
});
test('3d / 6d look-alike senders are refused by an allowlist (Latin letters only, NFKC-stable): mixed scripts, whole-word Cyrillic/Greek, Cherokee/Coptic/Lisu, math-bold, fullwidth, ligatures; umlauts, ß, é are fine', () => {
 const inv = routeOf('invoices');
 const bad = ['Wien \u0415nergie', 'Wien \u0395nergie', '\u0412\u0410\u041D\u041A', '\u042D\u043D\u0435\u0440\u0433\u0438\u044F AG', '\u0395\u03BD\u03B5\u03C1\u03B3\u03B5\u03B9\u03B1 AE',
  'Wien \u13AAnergie GmbH', 'Wien \u2C88nergie', 'Wien \uA4F0nergie', '\u{1D416}\u{1D422}\u{1D41E}\u{1D427} Energie', '\uFF25\uFF56\uFF49\uFF4C \uFF23\uFF4F\uFF52\uFF50', '\uFB01nance \uFB02ow AG', '\u0555' + '2 Telekom', 'Foo\u200BBar', 'Gre\u03B5k'];
 for (const b of bad) { expect(senderCharsOk(b), JSON.stringify(b)).toBe(false); expect(extractNaming(`Rechnung\nAbsender: ${b}`, inv, defaultConfig).sender, JSON.stringify(b)).toBeNull(); expect(validatedSender(b, `Rechnung ${b}`, defaultConfig), JSON.stringify(b)).toBeNull(); }
 expect(senderCharsOk('Wien\u00A0Energie')).toBe(false); // (an NBSP-separated "Wien Energie" in the TEXT is still the real known sender: whitespace is collapsed before matching)
 for (const ok of ['Wien Energie', 'Müller Straßenbau', 'Café Löwe GmbH', "O'Brien & Söhne", 'A1 Telekom', 'Société Générale', 'Łódź Bau', 'Ångström AB', 'ÖBB-Personenverkehr']) expect(senderCharsOk(ok), ok).toBe(true);
 expect(validatedSender('Müller Straßenbau', 'Rechnung Müller Straßenbau', defaultConfig)).toBe('Müller-Straßenbau');
 expect(senderCharsOk('e\u0301cole')).toBe(true); // decomposed é is normalized to NFC first
});
test('6d the stated-value cut also splits on fullwidth/ideographic/Arabic commas, a slash and a tab', () => {
 const inv = routeOf('invoices');
 for (const sep of [',', ';', '|', '\uFF0C', '\u3001', '\u060C', '\u061B', '/', '\t', '  ']) {
  const t = `Rechnung\nAbsender: Evil Corp${sep} Drei Austria\nDrei Austria GmbH liegt bei`;
  expect(extractNaming(t, inv, defaultConfig).sender, JSON.stringify(sep)).toBe('Evil Corp');
 }
});
test('6d the document-word rule applies to model suggestions too; "Credit Suisse AG" and "Order Systems GmbH" are accepted', () => {
 for (const t of ['Rechnung Bau GmbH', 'Vertrag Müller GmbH', 'Mietvertrag Müller', 'Invoice Foo Ltd', 'Polizze Muster AG']) expect(validatedSender(t, `Beleg\n${t}`, defaultConfig), t).toBeNull();
 for (const t of ['Credit Suisse AG', 'Order Systems GmbH']) {
  expect(validatedSender(t, `Rechnung\n${t}`, defaultConfig), t).toBe(t.startsWith('Credit') ? 'Credit-Suisse' : 'Order-Systems');
  expect(extractNaming(`${t}\nRechnung\nAbsender: ${t}`, routeOf('invoices'), defaultConfig).sender, t).toBe(t);
 }
});
test('F-d eval counts pending documents as "not evaluated", not as "sent to review instead"', async () => {
 const r = await runFixtureEval(defaultConfig, { model: unavailable as never }); const line = r.summary.find(l => l.startsWith('Accuracy:'))!;
 expect(line).toMatch(/sent to review instead: 0\b/); expect(line).toMatch(/NOT evaluated \(pending\): \d+/);
});

test('F-e end to end: a model that echoes a rejected "Absender: Rechnung Bau GmbH" does not get it as the sender; the name is kept', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'scan1.txt', 'Rechnung Nr. 7\nRechnungsdatum: 01.12.2026\nAbsender: Rechnung Bau GmbH\nBetrag 10,00 EUR');
  const echo = (async () => ({ version: 2, route: 'invoices', documentDate: '2026-12-01', sender: 'Rechnung Bau GmbH', needsReview: false })) as never;
  const r = await runOnce(sb.config, { apply: true, model: echo }); expect(r.items[0]).toMatchObject({ outcome: 'moved', renamed: false });
  expect(await readdir(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'))).toEqual(['scan1.txt']);
 } finally { await sb.cleanup(); }
});
