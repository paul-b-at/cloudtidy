// Fix round 2: write-ahead journal, init/bucket_missing, non-iCloud refusal, deferral/pending, deterministic naming, admin route, doctor, plist, eval.
import { test, expect } from 'bun:test';
import { appendFile, chmod, mkdir, readFile, readdir, rm, stat, writeFile, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runOnce } from '../src/run';
import { appendHistory, deriveHistory, makeJournal, pendingIntents, readHistory, readRawHistory, reconcileIntents, undoMoves, newRunId, HistoryWriteError } from '../src/history';
import { exclusiveRename, fingerprint, sha256File } from '../src/fsx';
import { moveNoClobber } from '../src/mover';
import { assertApplyAllowed, NonICloudRootError, resolveLayout } from '../src/paths';
import { applyInit, planInit, taxonomy } from '../src/init';
import { doctor, probeExclusiveRename } from '../src/doctor';
import { extractNaming, knownSenderIn, labelledDate, validatedSender, targetName } from '../src/naming';
import { classify, heuristics, modelFailure } from '../src/classifier';
import { routePatterns, validateConfig } from '../src/config';
import { HelperError } from '../src/process';
import { DecisionCache, HeldStore, configFingerprint, ensureLogDir, holdInCache, stateFiles } from '../src/state';
import { PendingStore, backoffMs } from '../src/pending';
import { renderPlist, plistInput, resolveBunPath, isVersionedBunPath, installedPlist, installAgent, PlistError } from '../src/install';
import { evaluate, formatReport, ruleTierSlow, stats } from '../src/evaluate';
import { analyze } from '../src/engine';
import { baseJson, defaultConfig as config, failingModel, model, sandbox, tree, type Sandbox, inboxFiles } from './helpers';

const exists = (p: string) => lstat(p).then(() => true, () => false);
const UNI = 'VO 123.456 Machine Learning exercise sheet';
const put = (sb: Sandbox, name: string, body: string) => writeFile(join(sb.inbox, name), body);
const route = (id: string) => config.routes.find(r => r.id === id)!;
const unavailable = async () => { throw new HelperError('helper_unavailable'); };
const mode = async (p: string) => (await stat(p)).mode & 0o777;

// ---------------------------------------------------------------- write-ahead journal (F-04 / F-25)
async function prep(sb: Sandbox, name = 'a.txt', body = 'hello') {
 const layout = await resolveLayout(sb.config), src = join(sb.inbox, name); await writeFile(src, body);
 return { layout, src, snapshot: (await fingerprint(src))!, sha256: await sha256File(src) };
}
const jbase = (p: Awaited<ReturnType<typeof prep>>) => ({ runId: 'r1', mode: 'run' as const, source: p.src, sha256: p.sha256, size: 5, route: 'uni', tier: 'rule' as const, outcome: 'moved' as const, reason: 'rule_match', renamed: false });
test('journal: a move writes intent before the rename and commit after; history shows it as a move', async () => {
 const sb = await sandbox(); try {
  const p = await prep(sb), f = stateFiles(sb.config).history, seen: string[] = [];
  const j = makeJournal(f, jbase(p)), wrapped = { intent: async (d: string) => { seen.push(`intent(src exists: ${await exists(p.src)})`); return j.intent(d); }, commit: j.commit, abort: j.abort };
  const r = await moveNoClobber({ layout: p.layout, config: sb.config, kind: 'inbox', src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir: join(sb.root, '01_Uni'), name: 'a.txt', journal: wrapped });
  expect(r.kind).toBe('moved'); expect(seen).toEqual(['intent(src exists: true)']);
  expect((await readRawHistory(f)).map(x => x.type)).toEqual(['intent', 'commit']);
  expect((await readHistory(f)).map(x => x.type)).toEqual(['move']); expect(await mode(f)).toBe(0o600);
 } finally { await sb.cleanup(); }
});
test('journal: no intent record, no move (history unwritable); non-ok rename leaves an abort', async () => {
 const sb = await sandbox(); try {
  const p = await prep(sb), f = stateFiles(sb.config).history;
  await mkdir(f, { recursive: true });
  await expect(moveNoClobber({ layout: p.layout, config: sb.config, kind: 'inbox', src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir: join(sb.root, '01_Uni'), name: 'a.txt', journal: makeJournal(f, jbase(p)) })).rejects.toBeInstanceOf(HistoryWriteError);
  expect(await exists(p.src)).toBe(true); expect(await readdir(join(sb.root, '01_Uni'))).toEqual([]);
  await rm(f, { recursive: true });
  const r = await moveNoClobber({ layout: p.layout, config: sb.config, kind: 'inbox', src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir: join(sb.root, '01_Uni'), name: 'a.txt', journal: makeJournal(f, jbase(p)), rename: { disableNative: true } });
  expect(r.kind).toBe('refused'); expect((await readRawHistory(f)).map(x => x.type)).toEqual(['intent', 'abort']); expect(await readHistory(f)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('journal: commit failure after the rename rolls the file back and reports a history error', async () => {
 const sb = await sandbox(); try {
  const p = await prep(sb), f = stateFiles(sb.config).history, real = makeJournal(f, jbase(p));
  const journal = { intent: real.intent, abort: real.abort, commit: async () => { throw new HistoryWriteError('disk full', false); } };
  await expect(moveNoClobber({ layout: p.layout, config: sb.config, kind: 'inbox', src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir: join(sb.root, '01_Uni'), name: 'a.txt', journal })).rejects.toBeInstanceOf(HistoryWriteError);
  expect(await readFile(p.src, 'utf8')).toBe('hello'); expect(await readdir(join(sb.root, '01_Uni'))).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('crash between rename and commit: the next apply run recovers the move (undo works); a crash before the rename is aborted', async () => {
 const sb = await sandbox(); try {
  const p = await prep(sb, 'a.txt', 'hello'), q = await prep(sb, 'b.txt', 'second'), f = stateFiles(sb.config).history;
  const dest = join(sb.root, '01_Uni', 'a.txt');
  const ja = makeJournal(f, jbase(p)); await ja.intent(dest); expect(await exclusiveRename(p.src, dest)).toBe('ok'); // process "dies" here: no commit
  const jb = makeJournal(f, { ...jbase(q), source: q.src, sha256: q.sha256 }); await jb.intent(join(sb.root, '01_Uni', 'b.txt')); // dies before the rename
  expect(pendingIntents(await readRawHistory(f))).toHaveLength(2); expect(await readHistory(f)).toEqual([]);
  await put(sb, 'other.txt', 'VO 222.222 exercise');
  const r = await runOnce(sb.config, { apply: true, model: model() });
  expect(r.recovered).toEqual({ recovered: 1, aborted: 1 });
  const hist = await readHistory(f); expect(hist.filter(h => h.type === 'move').map(h => (h as { destination: string }).destination).sort()).toContain(dest);
  expect(pendingIntents(await readRawHistory(f))).toEqual([]);
  const undone = await undoMoves(sb.config, await resolveLayout(sb.config), f, { runId: 'r1' }, { apply: true, undoRunId: newRunId() });
  expect(undone.map(u => u.status)).toContain('restored'); expect(await readFile(p.src, 'utf8')).toBe('hello');
  expect(await reconcileIntents(f)).toEqual({ recovered: 0, aborted: 0 }); // idempotent
 } finally { await sb.cleanup(); }
});
test('reconcile: a destination with different content is never adopted as the recorded move', async () => {
 const sb = await sandbox(); try {
  const p = await prep(sb), f = stateFiles(sb.config).history, dest = join(sb.root, '01_Uni', 'a.txt');
  await makeJournal(f, jbase(p)).intent(dest); await writeFile(dest, 'someone else wrote this');
  expect(await reconcileIntents(f)).toEqual({ recovered: 0, aborted: 1 }); expect(await readHistory(f)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('history: torn lines are tolerated, only valid records count; files are 0600, log dir 0700', async () => {
 const sb = await sandbox(); try {
  const f = stateFiles(sb.config).history;
  await appendHistory(f, { v: 1, type: 'abort', id: 'x', runId: 'r', time: 't', of: 'y', why: 'z' }); await appendFile(f, '{"v":1,"type":"inte');
  await appendHistory(f, { v: 1, type: 'abort', id: 'x2', runId: 'r', time: 't', of: 'y2', why: 'z' });
  expect((await readRawHistory(f)).map(x => x.id)).toEqual(['x', 'x2']); expect(await mode(f)).toBe(0o600);
  await ensureLogDir(sb.config); expect(await mode(sb.config.logDir)).toBe(0o700);
  expect(deriveHistory([{ v: 1, type: 'commit', id: 'c', runId: 'r', time: 't', of: 'missing' }])).toEqual([]);
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- F-06 bucket_missing, init, doctor
test('N-08: the mover never creates ANY folder: a missing bucket or sub-folder sends the file to review with folder_missing:<path>', async () => {
 const sb = await sandbox(); try {
  await rm(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'), { recursive: true }); await rm(join(sb.root, '04_Persönlich'), { recursive: true });
  await put(sb, 'bill.txt', 'Rechnung\nRechnungsdatum 03.10.2026\nDrei'); await put(sb, 'sheet.txt', UNI); await put(sb, 'trip.txt', 'Urlaub Familie Foto');
  const before = (await tree(sb.root)).filter(l => !l.startsWith('_Inbox/'));
  const r = await runOnce(sb.config, { apply: true, model: model({ route: 'personal' }) });
  expect(r.items.find(i => i.file === 'bill.txt')).toMatchObject({ outcome: 'review', reason: 'folder_missing:02_Admin & Finanzen/Rechnungen' });
  expect(r.items.find(i => i.file === 'trip.txt')).toMatchObject({ outcome: 'review', reason: 'folder_missing:04_Persönlich' });
  expect(await exists(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'))).toBe(false); expect(await exists(join(sb.root, '04_Persönlich'))).toBe(false);
  expect(await readdir(join(sb.root, '01_Uni'))).toEqual(['sheet.txt']); expect((await readdir(sb.review)).sort()).toEqual(['bill.txt', 'trip.txt']);
  expect((await tree(sb.root)).filter(l => !l.startsWith('_Inbox/') && !l.startsWith('01_Uni/'))).toEqual(before.filter(l => !l.startsWith('01_Uni/')));
  await applyInit(await resolveLayout(sb.config), sb.config); // iCloud has synced: init is the only creator
  await rm(join(sb.review, 'bill.txt')); await put(sb, 'bill2.txt', 'Rechnung\nRechnungsdatum 03.10.2026\nDrei');
  expect((await runOnce(sb.config, { apply: true, model: model() })).counts.moved).toBe(1);
  expect(await readdir(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'))).toHaveLength(1);
 } finally { await sb.cleanup(); }
});
test('N-08b: if Needs_Review itself is missing the file stays in _Inbox and the problem is reported; doctor lists every missing folder', async () => {
 const sb = await sandbox(); try {
  await rm(sb.review, { recursive: true }); await rm(join(sb.root, '02_Admin & Finanzen', 'Verträge'), { recursive: true });
  await put(sb, 'mystery.txt', 'something unclear'); await put(sb, 'v.txt', 'Mietvertrag Wohnung 5');
  const r = await runOnce(sb.config, { apply: true, model: model({ needsReview: true }) });
  expect(r.items.find(i => i.file === 'mystery.txt')).toMatchObject({ outcome: 'error', detail: 'folder_missing:_Inbox/Needs_Review' });
  expect(r.items.find(i => i.file === 'v.txt')).toMatchObject({ outcome: 'error', detail: 'folder_missing:_Inbox/Needs_Review' }); // wanted review (Verträge missing), but review is missing too
  expect((await inboxFiles(sb)).sort()).toEqual(['mystery.txt', 'v.txt']); expect(await exists(sb.review)).toBe(false);
  const d = await doctor(sb.config, async () => ({ code: 1, output: '' }));
  const tx = d.find(c => c.name.startsWith('taxonomy'))!; expect(tx.ok).toBe(false); expect(tx.detail).toContain('_Inbox/Needs_Review'); expect(tx.detail).toContain('02_Admin & Finanzen/Verträge');
 } finally { await sb.cleanup(); }
});
test('init: preview creates nothing; --yes creates only missing taxonomy folders (buckets, sub-folders, _Inbox); problems are refused', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config);
  await rm(join(sb.root, '01_Uni'), { recursive: true }); await rm(join(sb.root, '02_Admin & Finanzen'), { recursive: true });
  const before = await tree(sb.root), plan = await planInit(layout, sb.config);
  expect(plan.steps.filter(s => s.action === 'create').map(s => s.path)).toEqual(['01_Uni', '02_Admin & Finanzen', '02_Admin & Finanzen/Rechnungen', '02_Admin & Finanzen/Verträge']);
  expect(await tree(sb.root)).toEqual(before);
  const done = await applyInit(layout, sb.config); expect(done.create).toBe(4);
  expect(await readdir(join(sb.root, '02_Admin & Finanzen'))).toEqual(['Rechnungen', 'Verträge']);
  expect((await planInit(layout, sb.config)).create).toBe(0); expect(taxonomy(sb.config)[0]).toBe('_Inbox');
  await rm(join(sb.root, '04_Persönlich'), { recursive: true }); await writeFile(join(sb.root, '04_Persönlich'), 'a file, not a folder');
  await expect(applyInit(layout, sb.config)).rejects.toThrow('init refused');
  await rm(join(sb.root, '03_Projekte & Dev'), { recursive: true }); await symlink(sb.dir, join(sb.root, '03_Projekte & Dev'));
  expect((await planInit(layout, sb.config)).steps.find(s => s.path === '03_Projekte & Dev')).toMatchObject({ action: 'problem' });
 } finally { await sb.cleanup(); }
});
test('doctor: probes RENAME_EXCL inside _Inbox, cleans up after itself, flags missing buckets, non-iCloud roots and a versioned bun path', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config), before = await tree(sb.root);
  const probe = await probeExclusiveRename(layout); expect(probe.ok).toBe(true);
  expect(await tree(sb.root)).toEqual(before); // dot-prefixed probe folder and its files are gone again
  await put(sb, 'mine.txt', 'x'); // user files in _Inbox are untouched by the probe
  await probeExclusiveRename(layout); expect(await inboxFiles(sb)).toEqual(['mine.txt']);
  await rm(join(sb.root, '01_Uni'), { recursive: true });
  const checks = await doctor({ ...sb.config, allowNonICloudRoot: false }, async () => ({ code: 1, output: '' }));
  const by = (n: string) => checks.find(c => c.name.includes(n))!;
  expect(by('taxonomy folders')).toMatchObject({ ok: false, required: true }); expect(by('taxonomy folders').detail).toContain('01_Uni');
  expect(by('root is iCloud Drive')).toMatchObject({ ok: false }); expect(by('root is iCloud Drive').detail).toContain('refuse');
  expect(by('exclusive no-clobber')).toMatchObject({ ok: true, required: true });
  expect((await probeExclusiveRename(layout, { disableNative: true })).ok).toBe(false);
  await rm(sb.inbox, { recursive: true });
  expect((await doctor(sb.config, async () => ({ code: 1, output: '' }))).find(c => c.name.includes('exclusive no-clobber'))!.ok).toBe(false); // cannot write to _Inbox
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- F-20 non-iCloud root
test('apply modes refuse a root outside iCloud Drive unless allowNonICloudRoot; previews still work', async () => {
 const sb = await sandbox({ allowNonICloudRoot: false }); try {
  await put(sb, 'sheet.txt', UNI);
  const layout = await resolveLayout(sb.config);
  await expect(assertApplyAllowed(layout, sb.config)).rejects.toBeInstanceOf(NonICloudRootError);
  await expect(runOnce(sb.config, { apply: true, model: model() })).rejects.toThrow('not under');
  await expect(runOnce({ ...sb.config, daemon: { ...sb.config.daemon, apply: true } }, { apply: false, daemon: true, model: model() })).rejects.toThrow('not under');
  await expect(runOnce(sb.config, { apply: true, kind: 'root', mode: 'sweep', model: model(), confirm: async () => true })).rejects.toThrow('not under');
  await expect(applyInit(layout, sb.config)).rejects.toBeInstanceOf(NonICloudRootError);
  expect((await runOnce(sb.config, { apply: false, model: model() })).items[0]).toMatchObject({ action: 'move' }); // dry-run is fine
  expect(await inboxFiles(sb)).toEqual(['sheet.txt']);
  // a root that really is iCloud Drive passes (HOME-relative)
  const home = join(sb.dir, 'home'), icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'); await mkdir(join(icloud, '_Inbox'), { recursive: true });
  const l2 = await resolveLayout({ ...sb.config, root: icloud }); await expect(assertApplyAllowed(l2, { ...sb.config, root: icloud }, home)).resolves.toBeUndefined();
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- deterministic naming, known senders, labelled dates (decision 12)
test('labelled dates: the labelled issue date wins; unlabelled or ambiguous dates are not guessed', () => {
 expect(labelledDate('Rechnungsdatum: 03.10.2026\nFällig am 17.10.2026')).toBe('2026-10-03');
 expect(labelledDate('Invoice date: 2026-10-03\nDue date: 2026-11-03')).toBe('2026-10-03');
 expect(labelledDate('Datum 03.10.2026')).toBe('2026-10-03');
 expect(labelledDate('Rechnungsdatum 03.10.2026 und Rechnungsdatum 04.10.2026')).toBeNull(); // two different dates under the best label
 expect(labelledDate('Am 03.10.2026 haben wir das besprochen')).toBeNull();
 expect(labelledDate('Rechnungsdatum 03.10.26')).toBeNull(); // 4-digit year required
});
test('known senders: whole word, exactly one, short names only in the letterhead', () => {
 expect(knownSenderIn('Hutchison Drei Austria GmbH\nRechnung', config)).toBe('Drei');
 expect(knownSenderIn('Wien Energie GmbH Rechnung', config)).toBe('Wien Energie');
 expect(knownSenderIn('Wiener Linien und Wien Energie', config)).toBeNull(); // two senders: ambiguous
 expect(knownSenderIn('Dreieck Rechnung', config)).toBeNull(); // "Drei" inside another word
 expect(knownSenderIn(`A1 Telekom Austria\n${'x '.repeat(1000)}`, config)).toBe('A1');
 expect(knownSenderIn(`${'x '.repeat(1000)}Format A1 plan`, config)).toBeNull(); // paper size far from the letterhead
});
test('validatedSender: whole word and (>= 3 characters or a known sender)', () => {
 const t = 'Rechnung der Muster GmbH, IBAN AT12. Kontakt: ab@ex.at. A1 Telekom Austria';
 expect(validatedSender('Muster GmbH', t, config)).toBe('Muster');
 expect(validatedSender('Must', t, config)).toBeNull(); // not a whole word
 expect(validatedSender('ab', t, config)).toBeNull(); // 2 chars, not a known sender
 expect(validatedSender('A1', t, config)).toBe('A1'); // known sender
 expect(validatedSender('Erfunden AG', t, config)).toBeNull();
});
test('rule hit is instant and final: no model call when date and sender are in the text; locked route when only one is missing', async () => {
 const calls: (string | null | undefined)[] = [];
 const m = async (_f: string, _t: string, _c: unknown, locked?: string | null) => { calls.push(locked); return { version: 2, route: 'invoices', documentDate: '2026-10-03', sender: 'Muster GmbH', needsReview: false }; };
 const full = await classify('b.pdf', 'Drei\nRechnung\nRechnungsdatum 03.10.2026', config, { model: m });
 expect(full).toMatchObject({ route: 'invoices', tier: 'rule', documentDate: '2026-10-03', sender: 'Drei', modelCalls: 0 }); expect(calls).toEqual([]);
 const part = await classify('b.pdf', 'Muster GmbH\nRechnung\nRechnungsdatum 03.10.2026', config, { model: m });
 expect(part).toMatchObject({ route: 'invoices', tier: 'rule', documentDate: '2026-10-03', sender: 'Muster GmbH', modelCalls: 1 }); expect(calls).toEqual(['invoices']);
 const uni = await classify('u.txt', UNI, config, { model: m }); expect(uni).toMatchObject({ route: 'uni', modelCalls: 0 }); expect(calls).toHaveLength(1);
 expect(full.routeMs!).toBeLessThan(50); // heuristics only
});
test('model ran but its date/sender are not in the text: route stays, original name is kept', async () => {
 const m = async () => ({ version: 2, route: 'invoices', documentDate: '2030-01-01', sender: 'Erfunden', needsReview: false });
 const d = await classify('scan.txt', 'Rechnung zahlbar sofort', config, { model: m });
 expect(d).toMatchObject({ route: 'invoices', tier: 'rule', transient: false });
 const named = targetName({ filename: 'scan.txt', text: 'Rechnung zahlbar sofort', route: route('invoices'), documentDate: d.documentDate, sender: d.sender }, config);
 expect(named).toMatchObject({ name: 'scan.txt', renamed: false });
});
test('admin route: 02_Admin & Finanzen, keeps names, date prefix only when enabled; conflicts with other routes go to the model', async () => {
 const adm = route('admin');
 expect(adm).toMatchObject({ folder: '02_Admin & Finanzen', rename: false });
 for (const t of ['Kontoauszug Oktober', 'Ihr Steuerbescheid 2025', 'Finanzamt Wien', 'Kassenbon Billa', 'Quittung 4711', 'Receipt #3']) expect(heuristics('x.pdf', t, config)?.id, t).toBe('admin');
 for (const t of ['Belegung der Räume', 'Quittungsblock', 'Finanzamtsleiter']) expect(heuristics('x.pdf', t, config)?.id, t).not.toBe('admin');
 expect(heuristics('x.pdf', 'Kontoauszug mit Rechnung', config)).toBeNull(); // admin + invoices
 const sb = await sandbox(); try {
  await put(sb, 'kontoauszug.txt', 'Kontoauszug Oktober 2026\nDatum 31.10.2026\nWiener Städtische');
  const r = await runOnce(sb.config, { apply: true, model: failingModel });
  expect(r.items[0]).toMatchObject({ outcome: 'moved', route: 'admin', destination: '02_Admin & Finanzen/kontoauszug.txt', renamed: false });
  await put(sb, 'k2.txt', 'Kontoauszug Oktober 2026\nDatum 31.10.2026\nWiener Städtische');
  const on = { ...sb.config, naming: { datePrefix: true } };
  const r2 = await runOnce(on, { apply: false, model: failingModel });
  expect(r2.items[0]).toMatchObject({ route: 'admin', destination: '02_Admin & Finanzen/2026-10-31_k2.txt', renamed: true });
 } finally { await sb.cleanup(); }
 expect(validateConfig(baseJson).routes.map(r => r.id)).toContain('admin');
});
test('F-16: sender and rule words are matched as whole words (accepted risk documented: rules remain steerable by document text)', () => {
 const inv = routePatterns(route('invoices'));
 expect(inv.some(re => re.test('Bankbetrag'))).toBe(false); expect(inv.some(re => re.test('der Betrag'))).toBe(true);
 expect(heuristics('x.txt', 'F\u0075\u0308hrerschein', config)?.id).toBe('personal');
});

// ---------------------------------------------------------------- decision 13: transient failures defer, definite ones review
test('modelFailure maps exit codes: 2 / 4 / timeout / crash are transient, 1 / 3 / refusal are definite', () => {
 const kind = (e: unknown) => modelFailure(e).kind;
 expect(kind(new HelperError('helper_failed', 2))).toBe('transient'); expect(kind(new HelperError('helper_failed', 4))).toBe('transient');
 expect(kind(new HelperError('helper_timeout'))).toBe('transient'); expect(kind(new HelperError('helper_unavailable'))).toBe('transient');
 expect(kind(new HelperError('helper_failed', null))).toBe('transient'); // killed by a signal
 expect(modelFailure(new HelperError('helper_failed', 4))).toMatchObject({ reason: 'model_busy', retry: true });
 expect(kind(new HelperError('helper_failed', 1))).toBe('failed'); expect(kind(new HelperError('helper_failed', 3))).toBe('failed');
 expect(kind(new SyntaxError('x'))).toBe('failed'); expect(kind(new Error('x'))).toBe('failed');
});
test('transient model failure: the file stays in _Inbox as pending with backoff, is not re-asked early, then retried', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'note.txt', 'a short unclear note'); let t = 1_000_000_000_000, calls = 0;
  const flaky = (ok: boolean) => async () => { calls++; if (!ok) throw new HelperError('helper_failed', 4); return { version: 2, route: 'personal', documentDate: '', sender: '', needsReview: false }; };
  const run = (m: ReturnType<typeof flaky>, apply = true) => runOnce(sb.config, { apply, model: m, now: () => t, sleep: async () => {} });
  const r1 = await run(flaky(false));
  expect(r1.items[0]).toMatchObject({ file: 'note.txt', outcome: 'pending', action: 'defer', reason: 'model_busy' }); expect(r1.counts.pending).toBe(1);
  expect(await inboxFiles(sb)).toEqual(['note.txt']); expect(await readdir(sb.review)).toEqual([]);
  t += 60_000; const n = calls; const r2 = await run(flaky(true)); // 1 minute later: still backing off (5 min), no model call
  expect(calls).toBe(n); expect(r2.items[0]).toMatchObject({ outcome: 'pending', reason: 'model_busy' });
  t += 6 * 60_000; const r3 = await run(flaky(true)); // backoff over: retried and sorted
  expect(calls).toBe(n + 1); expect(r3.items[0]).toMatchObject({ outcome: 'moved', route: 'personal' }); expect(await readdir(join(sb.root, '04_Persönlich'))).toEqual(['note.txt']);
  expect(backoffMs(1)).toBe(5 * 60_000); expect(backoffMs(3)).toBe(20 * 60_000); expect(backoffMs(9)).toBe(60 * 60_000);
 } finally { await sb.cleanup(); }
});
test('deferral gives up after model.maxDeferHours with a reason in Needs_Review; applies to rule hits that need the model too', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'note.txt', 'a short unclear note'); await put(sb, 'contract.txt', 'Mietvertrag Wohnung 5'); let t = 1_000_000_000_000;
  const run = () => runOnce(sb.config, { apply: true, model: unavailable, now: () => t, sleep: async () => {} });
  expect((await run()).counts.pending).toBe(2);
  t += 23 * 3_600_000; const mid = await run(); expect(mid.counts.pending).toBe(2); expect((await inboxFiles(sb)).sort()).toEqual(['contract.txt', 'note.txt']);
  t += 2 * 3_600_000; const late = await run(); // 25 h, but only 2 attempts so far: still pending (give-up needs >= 3 apply-mode attempts)
  expect(late.counts.pending).toBe(2);
  t += 3_600_000; const end = await run(); // >= 24 h, 3 earlier attempts, and this final attempt fails too
  expect(end.items.map(i => `${i.file}:${i.outcome}:${i.reason}`).sort()).toEqual(['contract.txt:review:deferred_too_long:model_unavailable', 'note.txt:review:deferred_too_long:model_unavailable']);
  expect((await readdir(sb.review)).sort()).toEqual(['contract.txt', 'note.txt']);
 } finally { await sb.cleanup(); }
});
test('non-transient model failures (refusal, invalid answer) go to review immediately', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'note.txt', 'a short unclear note');
  const r = await runOnce(sb.config, { apply: true, model: async () => { throw new HelperError('helper_failed', 1); } });
  expect(r.items[0]).toMatchObject({ outcome: 'review', reason: 'model_failed' }); expect(await readdir(sb.review)).toEqual(['note.txt']);
 } finally { await sb.cleanup(); }
});
test('OCR/extraction timeout is transient (pending), never cached as a verdict', async () => {
 const cache = await DecisionCache.load(null, 'fp'), sb = await sandbox();
 try {
  const a = await analyze('/x/scan.pdf', 'scan.pdf', 'sha', sb.config, { cache, extract: async () => { throw new HelperError('helper_timeout'); } });
  expect(a).toMatchObject({ transient: true, needsReview: false }); expect(cache.get('sha', 'scan.pdf')).toBeNull();
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- decision 14: one shared debounce, nothing skipped silently
test('unstable and empty files are reported as pending with a reason by scan, run, review-state and status; empty past the grace goes to review', async () => {
 const sb = await sandbox({ debounceMs: 5 }); try {
  await put(sb, 'grow.txt', 'VO 123.456'); await put(sb, 'empty.txt', ''); await put(sb, 'ok.txt', UNI); let t = 1_000_000_000_000;
  const grow = async () => { await appendFile(join(sb.inbox, 'grow.txt'), '.'); };
  const scan = await runOnce(sb.config, { apply: false, readOnly: true, model: model(), sleep: grow, now: () => t });
  const pend = (r: Awaited<ReturnType<typeof runOnce>>) => Object.fromEntries(r.items.filter(i => i.outcome === 'pending').map(i => [i.file, i.reason]));
  expect(pend(scan)).toEqual({ 'grow.txt': 'unstable', 'empty.txt': 'empty_file' }); expect(scan.skipped.map(s => s.name)).not.toContain('grow.txt');
  const run = await runOnce(sb.config, { apply: true, model: model(), sleep: grow, now: () => t });
  expect(pend(run)).toEqual({ 'grow.txt': 'unstable', 'empty.txt': 'empty_file' }); expect(run.counts).toMatchObject({ moved: 1, pending: 2 });
  const store = await PendingStore.load(stateFiles(sb.config).pending, () => t);
  expect(store.list().map(e => `${e.name}:${e.kind}`)).toEqual(['empty.txt:empty', 'grow.txt:unstable']); // what review/status print
  t += 11 * 60_000;
  const later = await runOnce(sb.config, { apply: true, model: model(), sleep: async () => {}, now: () => t });
  expect(later.items.map(i => `${i.file}:${i.outcome}:${i.reason}`).sort()).toEqual(['empty.txt:review:empty_file', 'grow.txt:moved:rule_match']);
  expect((await PendingStore.load(stateFiles(sb.config).pending, () => t)).list()).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('a file that is deleted or moved away by the user is dropped from the pending list', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'e.txt', ''); await runOnce(sb.config, { apply: true, model: model() });
  expect((await PendingStore.load(stateFiles(sb.config).pending)).list()).toHaveLength(1);
  await rm(join(sb.inbox, 'e.txt')); await runOnce(sb.config, { apply: true, model: model() });
  expect((await PendingStore.load(stateFiles(sb.config).pending)).list()).toEqual([]);
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- F-19 held store
test('undo holds live in their own store: they survive a config fingerprint change and cache eviction', async () => {
 const sb = await sandbox(); const H1 = 'ab'.repeat(32); try {
  await holdInCache(sb.config, H1, 'a.txt');
  const files = stateFiles(sb.config);
  let held = await HeldStore.load(files.held); expect(held.has(H1, 'a.txt')).toBe(true);
  const fp1 = await configFingerprint(sb.config), fp2 = await configFingerprint({ ...sb.config, routes: [...sb.config.routes].reverse() });
  expect(fp1).not.toBe(fp2);
  const c1 = await DecisionCache.load(files.cache, fp1); for (let i = 0; i < 5200; i++) c1.set(`h${i}`, 'f.txt', { route: null, name: 'f.txt', tier: 'none', reason: 'x', needsReview: true, renamed: false }); await c1.save();
  const c2 = await DecisionCache.load(files.cache, fp2); expect(c2.get('h5000', 'f.txt')).toBeNull();
  held = await HeldStore.load(files.held); expect(held.has(H1, 'a.txt')).toBe(true);
  held.release(H1, 'a.txt'); await held.save(); expect((await HeldStore.load(files.held)).has(H1, 'a.txt')).toBe(false);
 } finally { await sb.cleanup(); }
});
test('a restored (undone) file is not re-sorted by the next run, even after the cache is rebuilt', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'sheet.txt', UNI);
  const r = await runOnce(sb.config, { apply: true, model: model() });
  await undoMoves(sb.config, await resolveLayout(sb.config), stateFiles(sb.config).history, { runId: r.runId }, { apply: true, undoRunId: newRunId() });
  await rm(stateFiles(sb.config).cache, { force: true });
  const again = await runOnce(sb.config, { apply: true, model: model() });
  expect(again.items[0]).toMatchObject({ outcome: 'skipped', detail: 'held_after_undo' }); expect(await inboxFiles(sb)).toEqual(['sheet.txt']);
  const forced = await runOnce(sb.config, { apply: true, model: model(), useCache: false }); expect(forced.counts.moved).toBe(1);
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- F-23 plist / F-17-conf bun path
const PL = { bun: '/Users/paul/.bun/bin/bun', script: '/Users/paul/dev/cloudtidy/src/cli.ts', configPath: '/Users/paul/c.json', inbox: '/Users/paul/_Inbox', workDir: '/Users/paul/dev/cloudtidy', logDir: '/Users/paul/Library/Logs/cloudtidy', intervalSec: 600 };
test('plist: control characters in any value are refused; minimal PATH; pdftotext pinned by absolute path', () => {
 for (const bad of ['a\u0000b', 'a\u0001b', 'a\u001bb', 'a\nb', 'a\tb', 'a\u0085b', '\ud800']) expect(() => renderPlist({ ...PL, configPath: `/x/${bad}` }), JSON.stringify(bad)).toThrow(PlistError);
 const p = renderPlist({ ...PL, pdftotext: '/opt/homebrew/bin/pdftotext' });
 expect(p).toContain('<key>PATH</key>\n    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>'); expect(p).toContain('<key>CLOUDTIDY_PDFTOTEXT</key>\n    <string>/opt/homebrew/bin/pdftotext</string>');
 expect(renderPlist(PL)).not.toContain('CLOUDTIDY_PDFTOTEXT'); expect(p).toContain('<string>/Users/paul/.bun/bin/bun</string>');
 expect(() => renderPlist({ ...PL, inbox: '/x/emoji 😀/_Inbox' })).not.toThrow(); // valid astral characters are fine
});
test('bun path: stable locations win, versioned Cellar paths are rejected, --bun override is validated', async () => {
 const sb = await sandbox(); try {
  const home = join(sb.dir, 'home'); await mkdir(join(home, '.bun', 'bin'), { recursive: true });
  const stable = join(home, '.bun', 'bin', 'bun'); await writeFile(stable, '#!/bin/sh\n'); await chmod(stable, 0o755);
  expect(await resolveBunPath(null, home)).toBe(stable);
  expect(isVersionedBunPath('/opt/homebrew/Cellar/bun/1.3.2/bin/bun')).toBe(true); expect(isVersionedBunPath('/opt/homebrew/bin/bun')).toBe(false); expect(isVersionedBunPath('bun')).toBe(true);
  await expect(resolveBunPath('/opt/homebrew/Cellar/bun/1.3.2/bin/bun', home)).rejects.toThrow('version-specific');
  await expect(resolveBunPath('relative/bun', home)).rejects.toThrow('absolute'); await expect(resolveBunPath(join(home, 'nope'), home)).rejects.toThrow('not an executable');
  const other = join(sb.dir, 'mybun'); await writeFile(other, ''); await chmod(other, 0o755); expect(await resolveBunPath(other, home)).toBe(other);
  expect(plistInput(sb.config, 'c.json', '/i', stable, '/usr/bin/pdftotext')).toMatchObject({ bun: stable, pdftotext: '/usr/bin/pdftotext' });
  // doctor warns about an installed plist that points to a versioned/missing binary
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(join(home, 'Library', 'LaunchAgents', 'at.paul.cloudtidy.plist'), renderPlist({ ...PL, bun: '/opt/homebrew/Cellar/bun/1.2.0/bin/bun', pdftotext: '/opt/homebrew/bin/pdftotext' }));
  expect(await installedPlist(home)).toEqual({ bun: '/opt/homebrew/Cellar/bun/1.2.0/bin/bun', pdftotext: '/opt/homebrew/bin/pdftotext' });
  expect(await installedPlist(join(sb.dir, 'nohome'))).toBeNull();
 } finally { await sb.cleanup(); }
});
test('install refuses (and writes nothing) on non-macOS', async () => {
 if (process.platform === 'darwin') return;
 const sb = await sandbox(); try { await expect(installAgent(sb.config, 'c.json', async () => ({ code: 0, output: '' }), join(sb.dir, 'h'), { bun: '/bin/true' })).rejects.toThrow('macOS'); expect(await exists(join(sb.dir, 'h'))).toBe(false); } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- decision 18 / 12: eval
test('eval: rule-tier routing latency is reported separately and flagged above 10 ms; max-files cap warns; labels file and dotfiles are excluded', async () => {
 const sb = await sandbox(); try {
  const dir = join(sb.dir, 'docs'); await mkdir(dir);
  await writeFile(join(dir, 'a.txt'), UNI); await writeFile(join(dir, 'b.txt'), 'Rechnung\nRechnungsdatum 03.10.2026\nDrei'); await writeFile(join(dir, 'c.txt'), 'something unclear');
  await writeFile(join(dir, '.DS_Store'), 'x'); await writeFile(join(dir, 'labels.json'), JSON.stringify({ 'a.txt': 'uni' })); await writeFile(join(dir, 'my-labels.json'), JSON.stringify({ 'a.txt': 'uni' }));
  const r = await evaluate(dir, sb.config, { 'a.txt': 'uni' }, { model: model({ route: 'personal' }) }, [join(dir, 'my-labels.json')]);
  expect(r.rows.map(x => x.file)).toEqual(['a.txt', 'b.txt', 'c.txt']); expect(r.capped).toBeNull();
  expect(r.latency.ruleTier.n).toBe(2); expect(r.latency.ruleTierSlow).toBe(false); expect(r.latency.ruleTier.p95Ms!).toBeLessThan(10);
  expect(r.rows.find(x => x.file === 'b.txt')).toMatchObject({ tier: 'rule', modelCalls: 0, renamed: true });
  expect(formatReport(r)).toContain('rule-tier routing (heuristics only)');
  const capped = await evaluate(dir, sb.config, null, { model: model() }, [], { maxFiles: 2 });
  expect(capped.files).toBe(2); expect(capped.capped).toEqual({ total: 4, evaluated: 2 }); expect(formatReport(capped)).toContain('only the first 2 were evaluated');
  expect(ruleTierSlow(stats([1, 2, 11]))).toBe(true); expect(ruleTierSlow(stats([1, 2, 3]))).toBe(false); expect(ruleTierSlow(stats([]))).toBe(false);
  expect(formatReport({ ...r, latency: { ...r.latency, ruleTier: stats([20, 30]), ruleTierSlow: true } })).toContain('budget');
 } finally { await sb.cleanup(); }
});
test('classify / eval do not crash on a transient model failure: the file is reported as pending', async () => {
 const sb = await sandbox(); try {
  const dir = join(sb.dir, 'docs'); await mkdir(dir); await writeFile(join(dir, 'u.txt'), 'something unclear');
  const r = await evaluate(dir, sb.config, { 'u.txt': 'personal' }, { model: unavailable });
  expect(r.rows[0]).toMatchObject({ got: 'pending', verdict: 'review_instead', reason: 'model_unavailable' }); expect(r.distribution).toEqual({ pending: 1 });
  const { inspectFile } = await import('../src/evaluate');
  expect(await inspectFile(join(dir, 'u.txt'), { ...sb.config, classifier: join(sb.dir, 'missing') })).toMatchObject({ reason: 'model_unavailable', needsReview: false });
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- re-review: multi-word known senders must produce a name without the model
test('re-review: a multi-word known sender (Wien Energie, Wiener Wohnen) renames deterministically, no model call', async () => {
 let calls = 0;
 for (const [file, text, expected] of [
  ['strom.txt', 'Wien Energie GmbH\nRechnung\nRechnungsdatum: 15.03.2025\nBetrag 80 EUR\n', '2025-03-15_Wien-Energie-Rechnung.txt'],
  ['miete.txt', 'Mietvertrag\nVertragsdatum: 01.09.2026\nWiener Wohnen\n', '2026-09-01_Wiener-Wohnen-Vertrag.txt'],
  ['drei.txt', 'Hutchison Drei Austria GmbH\nRechnung\nRechnungsdatum: 07.10.2026\n', '2026-10-07_Drei-Rechnung.txt']
 ] as const) {
  const d = await classify(file, text, config, { model: async () => { calls++; throw Error('model must not be called'); } });
  const route = config.routes.find(r => r.id === d.route)!;
  expect(targetName({ filename: file, text, route, documentDate: d.documentDate, sender: d.sender }, config)).toMatchObject({ name: expected, renamed: true });
 }
 expect(calls).toBe(0);
});
