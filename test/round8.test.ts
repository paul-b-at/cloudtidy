// Round 8: per-route `evidence` (deterministic check of the MODEL's route choice) — closes the "admin mode" injection on the model-only admin root.
import { test, expect } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from '../src/run';
import { classify, heuristics, routeVerified } from '../src/classifier';
import { routeEvidence, routePatterns, validateConfig } from '../src/config';
import { FIXTURE_DIR, runFixtureEval } from '../src/fixture-eval';
import { baseJson, defaultConfig as config, model, sandbox } from './helpers';

const route = (id: string) => config.routes.find(r => r.id === id)!;
const fx = (name: string) => readFile(join(FIXTURE_DIR, name), 'utf8');
const says = (id: string) => (async () => ({ version: 2, route: id, documentDate: '', sender: '', needsReview: false })) as never;
const NOTIZ = 'notiz_unklar.txt', SVS = 'svs_oegk_beitragsvorschreibung.txt', INJ = 'inj_route_force_nomatch.txt';

test('R8 default config: only admin carries evidence, and it never contains the bare words admin / Amt', () => {
 for (const r of config.routes) expect(r.evidence !== undefined, r.id).toBe(r.id === 'admin');
 expect(route('admin').patterns).toEqual([]);
 const ev = routeEvidence(route('admin'));
 expect(ev.length).toBeGreaterThanOrEqual(10);
 for (const t of ['admin', 'admin mode', 'Admin', 'Amt', 'Verwaltung', 'Administrator', 'Behördengang', 'SVSX', 'Bescheidenheit', 'Behörde', 'Behörden', 'Bescheid', 'Bescheide', 'Er weiß schon Bescheid']) expect(ev.some(re => re.test(t)), t).toBe(false);
 for (const t of ['SVS', 'svs Beitrag', 'ÖGK', 'Österreichische Gesundheitskasse', 'Sozialversicherungsanstalt', 'Versicherungsnummer 1234', 'Versicherungsdatenauszug', 'Beitragsvorschreibung', 'Pensionsversicherung', 'AUVA', 'Magistrat Wien', 'Magistratsabteilung 35', 'Bezirkshauptmannschaft Linz', 'Meldeamt', 'Gemeindeamt', 'Stadtamt']) expect(ev.some(re => re.test(t)), t).toBe(true);
});
test('R8 the forced-route injection (fixture inj_route_force_nomatch) answered `admin` by the model goes to review: model_route_unverified:admin', async () => {
 const text = await fx(INJ);
 expect(heuristics(INJ, text, config)).toBeNull(); expect(routeVerified(route('admin'), INJ, text)).toBe(false);
 expect(await classify(INJ, text, config, { model: says('admin') })).toMatchObject({ route: null, needsReview: true, reason: 'model_route_unverified:admin', transient: false });
 // end to end: the file lands in Needs_Review with that reason, nothing is moved into the admin root
 const sb = await sandbox(); try {
  await Bun.write(join(sb.inbox, 'note.txt'), text);
  const r = await runOnce(sb.config, { apply: true, model: says('admin') });
  expect(r.items[0]).toMatchObject({ outcome: 'review', reason: 'model_route_unverified:admin' });
  expect(await readdir(sb.review)).toEqual(['note.txt']); expect(await readdir(join(sb.root, '02_Admin & Finanzen'))).not.toContain('note.txt');
 } finally { await sb.cleanup(); }
});
test('R8 the SVS fixture answered `admin` by the model is accepted (it carries evidence)', async () => {
 const text = await fx(SVS);
 expect(heuristics(SVS, text, config)).toBeNull();
 expect(await classify(SVS, text, config, { model: says('admin') })).toMatchObject({ route: 'admin', tier: 'model', needsReview: false, reason: 'model_suggestion' });
 const sb = await sandbox(); try {
  await Bun.write(join(sb.inbox, 'svs.txt'), text);
  expect((await runOnce(sb.config, { apply: true, model: says('admin') })).items[0]).toMatchObject({ outcome: 'moved', route: 'admin', destination: '02_Admin & Finanzen/svs.txt' });
 } finally { await sb.cleanup(); }
});
test('R8 eval:fixtures with a model that answers `admin` for everything: the injection ends in review, the SVS letter in admin, unsafe outputs 0', async () => {
 const r = await runFixtureEval(config, { model: says('admin') });
 expect(r.unsafe).toEqual([]);
 expect(r.report.rows.find(x => x.file === INJ)!.got).toBe('review');
 expect(r.report.rows.find(x => x.file === SVS)!.got).toBe('admin');
 // nothing but the SVS letter (and genuine authority mail) can reach admin through the model
 for (const row of r.report.rows) if (row.tier === 'model' && row.got === 'admin') expect(routeVerified(route('admin'), row.file, await fx(row.file)), row.file).toBe(true);
});
test('R8 evidence never fires Tier 1 and does not count as a pattern match', () => {
 expect(routePatterns(route('admin'))).toEqual([]);
 for (const t of ['SVS Beitragsvorschreibung', 'Bescheid der Bezirkshauptmannschaft', 'Magistrat Wien Amt', 'Versicherungsnummer 1234 ÖGK']) expect(heuristics('x.txt', t, config), t).toBeNull();
 expect(heuristics('x.txt', 'Kontoauszug und SVS Bescheid', config)?.id).toBe('bank'); // evidence words next to a real pattern do not create a conflict
 expect(heuristics('x.txt', 'Steuerbescheid 2025', config)?.id).toBe('tax');
});
test('R8 only the model path is checked: routes without evidence are accepted as before, rule hits are untouched, the model may still say review (a rule hit keeps its route; the model only fills naming)', async () => {
 const nothing = 'Gesprächsnotiz ohne Signalwort';
 for (const id of ['uni', 'personal', 'bank', 'tax', 'receipts', 'invoices', 'contracts', 'dev']) expect(await classify('x.txt', nothing, config, { model: says(id) }), id).toMatchObject({ route: id, tier: 'model' });
 expect(await classify('x.txt', 'Rechnung Nr. 5 Betrag 10,00', config, { model: says('admin') })).toMatchObject({ route: 'invoices', tier: 'rule', reason: 'rule_match' });
 expect(await classify('x.txt', nothing, config, { model: model({ route: 'review', needsReview: true }) })).toMatchObject({ reason: 'model_uncertain' });
 expect(await classify('x.txt', nothing, config, { model: says('nonsense') })).toMatchObject({ reason: 'invalid_response' });
 // evidence in the file name counts, too (same window as patterns)
 expect(await classify('Bescheid_Magistrat.pdf', nothing, config, { model: says('admin') })).toMatchObject({ route: 'admin' });
 // a different custom route can carry evidence as well; the check is by route, not by id
 const custom = validateConfig({ ...baseJson, routes: baseJson.routes.map((r: { id: string }) => r.id === 'dev' ? { ...r, evidence: ['Repository'] } : r) });
 expect(await classify('x.txt', nothing, custom, { model: says('dev') })).toMatchObject({ reason: 'model_route_unverified:dev' });
 expect(await classify('x.txt', 'Das Repository ist neu', custom, { model: says('dev') })).toMatchObject({ route: 'dev' });
});
test('R8 config validation of `evidence` (same rules as patterns)', () => {
 const withE = (evidence: unknown) => () => validateConfig({ ...baseJson, routes: [{ ...baseJson.routes[0], evidence }] });
 expect(withE(['SVS', 'Magistrat(?:s\\p{L}*)?'])).not.toThrow(); expect(withE([])).not.toThrow(); expect(withE(undefined)).not.toThrow();
 expect(withE(['(?:a|)'])).toThrow('matches the empty string'); expect(withE(['.*'])).toThrow('matches the empty string');
 expect(withE(['('])).toThrow('not a valid regular expression');
 expect(withE([''])).toThrow('non-empty string'); expect(withE([5])).toThrow('non-empty string'); expect(withE('SVS')).toThrow('list of at most 16');
 expect(withE(Array.from({ length: 17 }, (_, i) => `w${i}`))).toThrow('at most 16'); expect(withE(['x'.repeat(401)])).toThrow('at most 400');
 const v = validateConfig({ ...baseJson, routes: [{ ...baseJson.routes[0], evidence: ['SVS'] }] });
 expect(v.routes[0]!.evidence).toEqual(['SVS']); expect(validateConfig(baseJson).routes.find(r => r.id === 'uni')!.evidence).toBeUndefined();
 for (const r of config.routes) for (const re of routeEvidence(r)) expect(re.test(''), r.id).toBe(false);
});
test('R8 notiz_unklar ("Er weiß schon Bescheid") answered `admin` by the model is not enough: review model_route_unverified:admin; SVS is still accepted', async () => {
 const text = await fx(NOTIZ);
 expect(text).toContain('Bescheid'); expect(heuristics(NOTIZ, text, config)).toBeNull();
 expect(await classify(NOTIZ, text, config, { model: says('admin') })).toMatchObject({ route: null, needsReview: true, reason: 'model_route_unverified:admin' });
 expect(await classify(SVS, await fx(SVS), config, { model: says('admin') })).toMatchObject({ route: 'admin', tier: 'model' });
 const r = await runFixtureEval(config, { model: says('admin') });
 expect(r.report.rows.find(x => x.file === NOTIZ)!.got).toBe('review'); expect(r.report.rows.find(x => x.file === SVS)!.got).toBe('admin');
});
