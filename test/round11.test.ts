// Round 11: filename tiebreak, admin Tier-1 patterns (strong authority markers), JKU matriculation number + course names, Lebenslauf.
import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classify, heuristics, routeVerified, ruleMatch } from '../src/classifier';
import { routePatterns } from '../src/config';
import { FIXTURE_DIR, runFixtureEval } from '../src/fixture-eval';
import { defaultConfig as config } from './helpers';

const route = (id: string) => config.routes.find(r => r.id === id)!;
const fx = (name: string) => readFile(join(FIXTURE_DIR, name), 'utf8');
const says = (id: string) => (async () => ({ version: 2, route: id, documentDate: '', sender: '', needsReview: false })) as never;
const hit = (id: string, t: string) => routePatterns(route(id)).some(re => re.test(t));
const COURT = 'gerichtsschreiben_studium_beispiel.txt', HAND = 'handschrift_ocr_k_nummer.txt', CV = 'Lebenslauf_Maria_Muster.txt', VERTRAG = 'Bello_Vertrag_Tierhaftpflicht.txt';
const never = (async () => { throw new Error('model must not be called'); }) as never;

test('R11 tiebreak: the text conflicts, the file name matches exactly one of the conflicting routes -> that route, reason rule_match_filename, no model call', async () => {
 const text = 'Rechnung zur Tierhaftpflichtversicherung, Polizze 1';
 expect(ruleMatch('scan.pdf', text, config)).toBeNull();                                     // no filename word: conflict stays with the model
 expect(ruleMatch('Milo Vertrag.pdf', text, config)).toMatchObject({ route: { id: 'contracts' }, byFilename: true });
 expect(await classify('Milo Vertrag.pdf', text, config, { model: never })).toMatchObject({ route: 'contracts', tier: 'rule', reason: 'rule_match_filename', needsReview: false });
 expect(await classify('Rechnung_Mai.pdf', text, config, { model: never })).toMatchObject({ route: 'invoices', tier: 'rule', reason: 'rule_match_filename' });
 expect(heuristics('Milo Vertrag.pdf', text, config)?.id).toBe('contracts');                // heuristics() keeps its signature
 expect(await classify('scan.txt', 'Rechnung Nr. 5', config, { model: never })).toMatchObject({ reason: 'rule_match', route: 'invoices' }); // a plain single hit keeps rule_match
});
test('R11 tiebreak: a file name that matches none or more than one of the conflicting routes changes nothing', () => {
 const text = 'Rechnung zur Tierhaftpflichtversicherung, Polizze 1';
 expect(ruleMatch('scan.pdf', text, config)).toBeNull();
 expect(ruleMatch('Rechnung Vertrag.pdf', text, config)).toBeNull();                         // two of the conflicting routes match the name
 expect(ruleMatch('Kontoauszug.pdf', text, config)).toBeNull();                              // the name matches a route that the text does NOT match: never picked
 expect(ruleMatch('Kontoauszug Vertrag.pdf', text, config)).toMatchObject({ route: { id: 'contracts' }, byFilename: true }); // bank is ignored, contracts is the only conflicting route named
 expect(ruleMatch('Vertrag.pdf', 'nothing relevant here', config)).toMatchObject({ route: { id: 'contracts' }, byFilename: false }); // the file name is part of the match window (as before): a lone hit is a plain rule_match
});
test('R11 tiebreak never creates a hit and never picks a route the text does not match', () => {
 expect(ruleMatch('Vertrag.pdf', 'x', config)?.byFilename).toBe(false);
 expect(ruleMatch('Vertrag.pdf', 'Rechnung 5 Betrag', config)).toBeNull(); // the text matches invoices only, the name only contracts: contracts is not text-matched, so no tiebreak -> model
 expect(ruleMatch('foto.jpg', 'Rechnung 5', config)).toMatchObject({ route: { id: 'invoices' }, byFilename: false });
});
test('R11 admin Tier-1 patterns: strong authority markers fire; weak words (and the evidence-only words) do not', () => {
 for (const t of ['Bezirksgericht Liesing', 'des Bezirksgerichtes', 'Landesgericht Linz', 'Oberlandesgericht Wien', 'Verwaltungsgericht', 'Bundesverwaltungsgericht', 'Pflegschaftsgericht', 'Familienrechtssache', 'Bezirkshauptmannschaft Linz', 'Magistrat Wien', 'Magistratsabteilung 35', 'Sozialversicherungsanstalt', 'Gesundheitskasse', 'SVS', 'ÖGK', 'Unterhalt', 'Unterhaltserhöhung', 'Unterhaltsvorschuss']) expect(hit('admin', t), t).toBe(true);
 for (const t of ['admin', 'Amt', 'Behörde', 'Bescheid', 'Gericht', 'Beschluss', 'Polizei', 'Unfallbericht', 'Landesregierung', 'AUVA', 'Unterhaltung', 'Unterhaltungselektronik', 'SVSX', 'Bezirksgerichtsgebäude']) expect(hit('admin', t), t).toBe(false);
 expect(route('admin').evidence!.length).toBeLessThanOrEqual(16); expect(route('admin').description).not.toMatch(/model-only/i);
});
test('R11 admin vs contracts: SVS/ÖGK/Sozialversicherung words are admin by rule and never contracts; a real insurance contract naming the ÖGK is a conflict for the model', () => {
 expect(heuristics('x.txt', 'Sozialversicherung der Selbständigen SVS Versicherungsnummer 1234', config)?.id).toBe('admin');
 expect(heuristics('x.txt', 'Österreichische Gesundheitskasse Versicherungsdatenauszug', config)?.id).toBe('admin');
 expect(heuristics('x.txt', 'Haftpflichtversicherung Polizze, erwähnt ÖGK', config)).toBeNull();
 expect(heuristics('Polizze.pdf', 'Haftpflichtversicherung Polizze, erwähnt ÖGK', config)?.id).toBe('contracts'); // filename tiebreak
});
test('R11 court letter that mentions a university: uni + admin conflict -> model (admin accepted through evidence); a file name with an admin word decides at once', async () => {
 const text = await fx(COURT); expect(text).toMatch(/Johannes Kepler/);
 expect(hit('uni', text) && hit('admin', text)).toBe(true);
 expect(ruleMatch(COURT, text, config)).toBeNull();
 expect(await classify(COURT, text, config, { model: says('admin') })).toMatchObject({ route: 'admin', tier: 'model', needsReview: false });
 expect(await classify(COURT, text, config, { model: says('uni') })).toMatchObject({ route: 'uni', tier: 'model' }); // the model's call, uni has no evidence list
 expect(await classify('Unterhaltserhöhung 2026.pdf', text, config, { model: never })).toMatchObject({ route: 'admin', tier: 'rule', reason: 'rule_match_filename' });
 expect(await classify('Unterhaltserhöhung 2026.pdf'.normalize('NFD'), text, config, { model: never })).toMatchObject({ route: 'admin', reason: 'rule_match_filename' });
});
test('R11 uni: JKU matriculation number K + 8 digits (no space; an OCR-lowercase k counts), course names, Exercise Sheet N; whole words only', async () => {
 for (const t of ['K12345678', 'k12345678', 'Matr.Nr. K12345678.', 'Mathematics for AI 2 — Exercise Sheet 7', 'Exercise Sheet7', 'Computational Logic', 'Algorithms and Data Structures', 'Programming in Python', 'Machine Learning and Pattern Classification', 'Machine Learning & Pattern Classification', 'Statistics for AI', 'Introduction to AI', 'Introduction to Artificial Intelligence', 'Formal Languages']) expect(hit('uni', t), t).toBe(true);
 for (const t of ['K 12345678', 'K1234567', 'K123456789', 'AK12345678', '12345678', 'K-12345678', 'Statistics for AIs', 'Introduction to AIDS', 'Formal Language']) expect(hit('uni', t), t).toBe(false);
 // an OCR text with only a K number and formulas is a uni rule hit; the existing fixtures never carry a K+8-digit number by accident
 expect(heuristics('scan.pdf', await fx(HAND), config)?.id).toBe('uni');
 for (const f of ['invoice_acme_en.txt', 'drei_rechnung_oktober.txt', 'kontoauszug_sparkasse_10_2026.txt', 'wien_energie_jahresabrechnung.txt', 'kassabon_billa.txt', 'finanzamt_einkommensteuerbescheid.txt']) expect(/(?<![\p{L}\p{N}])K\s?\d{8}(?![\p{L}\p{N}])/iu.test(await fx(f)), f).toBe(false);
});
test('R11 personal: Lebenslauf / Curriculum Vitae, but not a bare CV (computer vision)', () => {
 for (const t of ['Lebenslauf', 'Mein Lebenslauf 2026', 'Curriculum Vitae', 'curriculum  vitae']) expect(hit('personal', t), t).toBe(true);
 for (const t of ['CV', 'CV Pipeline für computer vision', 'Lebenslaufbahn']) expect(hit('personal', t), t).toBe(false);
});
test('R11 CV that mentions GitHub and courses: personal via the file name tiebreak; without the name the model decides', async () => {
 const text = await fx(CV);
 expect(hit('personal', text) && hit('dev', text) && hit('uni', text)).toBe(true);
 expect(ruleMatch('scan.pdf', text, config)).toBeNull();
 expect(await classify(CV, text, config, { model: never })).toMatchObject({ route: 'personal', tier: 'rule', reason: 'rule_match_filename' });
});
test('R11 contract with Vertrag in the file name and Rechnung in the text: contracts via the tiebreak', async () => {
 const text = await fx(VERTRAG); expect(hit('invoices', text) && hit('contracts', text)).toBe(true);
 expect(await classify(VERTRAG, text, config, { model: never })).toMatchObject({ route: 'contracts', tier: 'rule', reason: 'rule_match_filename' });
});
test('R11 eval:fixtures with an always-review mock: the four new documents; injections and the mixed Rechnung/Mietvertrag document are untouched by the tiebreak', async () => {
 const r = await runFixtureEval(config, { model: says('review') as never });
 const got = (f: string) => r.report.rows.find(x => x.file === f)!;
 expect(got(HAND).got).toBe('uni'); expect(got(CV).got).toBe('personal'); expect(got(CV).tier).toBe('rule'); expect(got(VERTRAG).got).toBe('contracts');
 expect(got(COURT).got).toBe('review');
 expect(got('rechnung_und_mietvertrag_gemischt.txt').got).toBe('review'); // the name matches both conflicting routes
 for (const f of r.report.rows.filter(x => x.file.startsWith('inj_'))) expect(['review', f.expected]).toContain(f.got);
 expect(r.report.files).toBe(36); expect(r.unsafe).toEqual([]);
 const always = await runFixtureEval(config, { model: says('admin') });
 expect(always.report.rows.find(x => x.file === COURT)!.got).toBe('admin'); expect(always.report.rows.find(x => x.file === 'inj_route_force_nomatch.txt')!.got).toBe('review');
});
test('R11 follow-up: patterns cannot span the file name / text boundary (name and text are matched separately); the K number has no optional space', async () => {
 // multi-word course name split between name and text, "VO" at the end of the name + the number at the start of the text, a name ending in K + digits first in the text
 expect(ruleMatch('Computational', 'Logic und mehr', config)).toBeNull();
 expect(ruleMatch('Mathematics for', 'AI 2 und mehr', config)).toBeNull();
 expect(ruleMatch('Skript VO', '123.456 Algorithmen', config)).toBeNull();
 expect(ruleMatch('Notizen K', '12345678 und mehr', config)).toBeNull();
 expect(ruleMatch('Skript.pdf', 'K 12345678', config)).toBeNull();
 // but each part alone still matches, and so does the union of both
 expect(ruleMatch('Computational Logic.pdf', 'x', config)).toMatchObject({ route: { id: 'uni' }, byFilename: false });
 expect(ruleMatch('x.pdf', 'Computational Logic', config)).toMatchObject({ route: { id: 'uni' } });
 expect(ruleMatch('Vertrag.pdf', 'Exercise Sheet 7', config)).toBeNull();                      // name: contracts, text: uni -> conflict, the name picks a route the text does not match -> model
 expect(ruleMatch('Rechnung_Mai.pdf', 'Rechnung zur Tierhaftpflichtversicherung, Polizze 1', config)).toMatchObject({ route: { id: 'invoices' }, byFilename: true }); // tiebreak unchanged
 // evidence is checked per part as well: a file name word or a text word is enough, nothing spans
 const admin = config.routes.find(r => r.id === 'admin')!;
 expect(routeVerified(admin, 'Beschluss.pdf', 'nichts')).toBe(true); expect(routeVerified(admin, 'x.pdf', 'Beschluss')).toBe(true); expect(routeVerified(admin, 'x.pdf', 'nichts hier')).toBe(false);
});
