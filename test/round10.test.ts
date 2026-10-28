// Round 10: routing tuning from real documents (invoices no longer fire on IBAN/Betrag, uni words, admin evidence for courts/police/accident reports).
import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classify, heuristics, routeVerified } from '../src/classifier';
import { routeEvidence, routePatterns, validateConfig } from '../src/config';
import { FIXTURE_DIR, runFixtureEval } from '../src/fixture-eval';
import { baseJson, defaultConfig as config } from './helpers';

const route = (id: string) => config.routes.find(r => r.id === id)!;
const fx = (name: string) => readFile(join(FIXTURE_DIR, name), 'utf8');
const says = (id: string) => (async () => ({ version: 2, route: id, documentDate: '', sender: '', needsReview: false })) as never;
const hit = (id: string, t: string) => routePatterns(route(id)).some(re => re.test(t));
const EXERCISE = 'uebungsblatt_exercise_sheet_en.txt', SERVICE = 'servicevertrag_iban_betrag.txt', COURT = 'bezirksgericht_unterhaltserhoehung.txt', ACCIDENT = 'unfallbericht_kfz_beispiel.txt';

test('R10 invoices: IBAN, Betrag and Beträge alone are no invoice words any more; real invoice words still are', () => {
 for (const t of ['IBAN AT61 1904 3002 3457 3201', 'Betrag: 12,00', 'Beträge', 'der Betrag', 'Zahlungsbetrag EUR 5']) expect(hit('invoices', t), t).toBe(false);
 for (const t of ['Rechnung', 'Rechnungsnummer 5', 'Rechnungen 2026', 'Invoice 42', 'Invoices', 'ATU12345678', 'Zahlungsziel: 14 Tage', 'Zahlungsaufforderung', 'zahlungsaufforderung']) expect(hit('invoices', t), t).toBe(true);
 expect(hit('invoices', 'Mahnung')).toBe(false); // deliberately not a rule word: a reminder goes to the model
 expect(route('invoices').description.length).toBeLessThanOrEqual(240);
});
test('R10 uni: exercise sheets, assignments, lecture notes, JKU names — whole words only, conflicts still go to the model', () => {
 for (const t of ['Übungsblatt 3', 'Übungsblätter', 'Übungszettel', 'Exercise sheet 7', 'exercise sheets', 'Assignment 3', 'Lecture notes week 2', 'Johannes Kepler Universität', 'Moodle', 'JKU', 'VO 123.456']) expect(hit('uni', t), t).toBe(true);
 for (const t of ['Assignment', 'Assignments overview', 'Lecture 5', 'Moodlerei', 'Übungsblattsammlung', 'Exercise', 'Kepler', 'Johannes Müller']) expect(hit('uni', t), t).toBe(false);
 expect(heuristics('x.txt', 'Exercise sheet 7 Rechnung', config)).toBeNull(); // uni + invoices -> conflict -> model
 expect(heuristics('x.txt', 'Moodle Vertrag', config)).toBeNull();
 expect(route('uni').description).toMatch(/JKU/); expect(route('uni').description.length).toBeLessThanOrEqual(240);
});
test('R10 fixtures: the exercise sheet is uni by rule without any JKU / UE number; the service contract is contracts by rule although it has IBAN and Betrag', async () => {
 const ex = await fx(EXERCISE); expect(ex).not.toMatch(/JKU|UE\s+\d{3}\.\d{3}|VO\s+\d{3}/);
 expect(heuristics(EXERCISE, ex, config)).toMatchObject({ id: 'uni' });
 const sv = await fx(SERVICE); expect(sv).toMatch(/IBAN/); expect(sv).toMatch(/Betrag/);
 expect(hit('invoices', sv)).toBe(false);
 expect(heuristics(SERVICE, sv, config)).toMatchObject({ id: 'contracts' });
});
test('R10 court letter: no invoice rule, model `admin` accepted via evidence; without evidence words the same answer goes to review', async () => {
 const text = await fx(COURT); expect(text).toMatch(/Betrag/);
 expect(heuristics(COURT, text, config)).toBeNull(); expect(routeVerified(route('admin'), COURT, text)).toBe(true);
 expect(await classify(COURT, text, config, { model: says('admin') })).toMatchObject({ route: 'admin', tier: 'model', needsReview: false });
 const bare = 'Ein Brief mit dem Betrag 120 EUR, bitte lesen.';
 expect(routeVerified(route('admin'), 'x.txt', bare)).toBe(false);
 expect(await classify('x.txt', bare, config, { model: says('admin') })).toMatchObject({ route: null, needsReview: true, reason: 'model_route_unverified:admin' });
});
test('R10 accident report: admin via evidence (Unfallbericht, Polizei)', async () => {
 const text = await fx(ACCIDENT);
 expect(heuristics(ACCIDENT, text, config)).toBeNull(); expect(routeVerified(route('admin'), ACCIDENT, text)).toBe(true);
 expect(await classify(ACCIDENT, text, config, { model: says('admin') })).toMatchObject({ route: 'admin', needsReview: false });
});
test('R10 admin evidence additions: courts, police, accident reports, Landesregierung; bare Bescheid / Behörde / admin still do not count', () => {
 const ev = routeEvidence(route('admin')), e = (t: string) => ev.some(re => re.test(t));
 for (const t of ['Bezirksgericht Linz', 'Landesgericht', 'Arbeitsgericht', 'Gericht', 'Beschluss', 'Polizei', 'Polizeiinspektion Urfahr', 'Landespolizeidirektion', 'Unfallbericht', 'Unfallmeldung', 'Landesregierung', 'SVS', 'ÖGK', 'AUVA', 'Gesundheitskasse', 'Sozialversicherungsanstalt', 'Magistratsabteilung 35']) expect(e(t), t).toBe(true);
 for (const t of ['admin', 'admin mode', 'Behörde', 'Bescheid', 'Amt', 'Beschlussfassung', 'Er weiß schon Bescheid']) expect(e(t), t).toBe(false);
 expect(ev.length).toBeLessThanOrEqual(16);
 expect(route('admin').description).toMatch(/courts/); expect(route('admin').description).toMatch(/police/); expect(route('admin').description).toMatch(/accident/); expect(route('admin').description.length).toBeLessThanOrEqual(240);
 expect(() => validateConfig({ ...baseJson, routes: [{ ...baseJson.routes[0], id: 'admin', patterns: [], evidence: Array.from({ length: 17 }, (_, i) => `w${i}`) }] })).toThrow();
});
test('R10 eval with an always-admin mock model: court + accident report are admin, injection and the unclear note go to review', async () => {
 const r = await runFixtureEval(config, { model: says('admin') });
 const got = (f: string) => r.report.rows.find(x => x.file === f)!.got;
 expect(got(COURT)).toBe('admin'); expect(got(ACCIDENT)).toBe('admin'); expect(got(EXERCISE)).toBe('uni'); expect(got(SERVICE)).toBe('contracts');
 expect(got('inj_route_force_nomatch.txt')).toBe('review'); expect(got('notiz_unklar.txt')).toBe('review');
 expect(r.unsafe).toEqual([]); expect(r.report.files).toBe(32);
});
test('R10 README procedure: a file given up as deferred_too_long:classifier_helper_missing is not retried by itself; moved back to _Inbox with a working model it is sorted', async () => {
 const { sandbox } = await import('./helpers'); const { runOnce } = await import('../src/run'); const { rename, writeFile, readdir } = await import('node:fs/promises');
 const HOUR = 3_600_000, ok = (async () => ({ version: 2, route: 'personal', documentDate: '', sender: '', needsReview: false })) as never;
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  const cfg = { ...sb.config, classifier: '/nonexistent/classify' };
  await writeFile(join(sb.inbox, 'note.txt'), 'a short unclear note'); let t = 1_000_000_000_000;
  const run = (c: typeof cfg, m?: never) => runOnce(c, { apply: true, ...(m ? { model: m } : {}), now: () => t, sleep: async () => {} });
  await run(cfg); t += 30 * HOUR; await run(cfg); t += 2 * HOUR; await run(cfg); t += 2 * HOUR;
  expect((await run(cfg)).items[0]).toMatchObject({ outcome: 'review', reason: 'deferred_too_long:classifier_helper_missing' });
  expect(await readdir(sb.review)).toEqual(['note.txt']);
  t += HOUR; await run(sb.config, ok); expect(await readdir(sb.review)).toEqual(['note.txt']); // not retried automatically
  await rename(join(sb.review, 'note.txt'), join(sb.inbox, 'note.txt')); t += HOUR;
  expect((await run(sb.config, ok)).items[0]).toMatchObject({ outcome: 'moved', route: 'personal' });
  expect(await readdir(sb.review)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('R10 a Word file whose converted text exceeds 256 KiB goes to review with extraction_failed:textutil:output_limit (not truncated)', async () => {
 const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { extract, ExtractError } = await import('../src/extract');
 const d = await mkdtemp(join(tmpdir(), 'ct-tu-')), old = process.env.CLOUDTIDY_TEXTUTIL;
 try {
  const fake = join(d, 'textutil'); await writeFile(fake, '#!/bin/sh\nhead -c 300000 /dev/zero | tr "\\0" "a"\n'); await chmod(fake, 0o755);
  const doc = join(d, 'big.docx'); await writeFile(doc, 'x'); process.env.CLOUDTIDY_TEXTUTIL = fake;
  const err = await extract(doc, config).then(() => null, e => e); expect(err).toBeInstanceOf(ExtractError); expect((err as Error).message).toBe('extraction_failed:textutil:output_limit');
 } finally { if (old === undefined) delete process.env.CLOUDTIDY_TEXTUTIL; else process.env.CLOUDTIDY_TEXTUTIL = old; await rm(d, { recursive: true, force: true }); }
});
