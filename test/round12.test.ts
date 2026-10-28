// Round 12: widened filename tiebreak, narrower Unterhalt, Unfallbericht rule, Comp Logic / Algo, rule diagnostics (classify / eval --verbose).
import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classify, explainRules, formatRuleTrace, heuristics, routeVerified, ruleMatch } from '../src/classifier';
import { routeEvidence, routePatterns } from '../src/config';
import { evaluate, formatReport, inspectFile } from '../src/evaluate';
import { runOnce } from '../src/run';
import { stateFiles } from '../src/state';
import { FIXTURE_DIR } from '../src/fixture-eval';
import { defaultConfig as config, sandbox } from './helpers';

const route = (id: string) => config.routes.find(r => r.id === id)!;
const fx = (name: string) => readFile(join(FIXTURE_DIR, name), 'utf8');
const hit = (id: string, t: string) => routePatterns(route(id)).some(re => re.test(t));
const never = (async () => { throw new Error('model must not be called'); }) as never;
const PASS = 'Reisepass_scan_beispiel.txt', KRAN = 'Gescanntes_Dokument_Kran_Wartung.txt';

test('R12 tiebreak widened: on any conflict a file name that matches exactly ONE route wins, even if the text does not match it (authority words in the text must not block it)', async () => {
 const pass = await fx(PASS);
 expect(pass).not.toMatch(/Reisepass|Personalausweis/i); expect(hit('admin', pass)).toBe(true); expect(hit('personal', pass)).toBe(false);
 expect(ruleMatch('scan.pdf', pass, config)).toMatchObject({ route: { id: 'admin' }, byFilename: false }); // without a name it is a plain admin hit (as before)
 expect(await classify('Reisepass.pdf', pass, config, { model: never })).toMatchObject({ route: 'personal', tier: 'rule', reason: 'rule_match_filename' });
 expect(await classify('Reisepass_scan_beispiel', pass, config, { model: never })).toMatchObject({ route: 'personal', reason: 'rule_match_filename' });
 const mz = 'Meldebestätigung, ausgestellt von der Bezirkshauptmannschaft Musterstadt, Wohnsitz Musterstraße 1';
 expect(ruleMatch('Meldezettel Seybelgasse.pdf', mz, config)).toMatchObject({ route: { id: 'personal' }, byFilename: true });
 // the text conflicts between two OTHER routes, the name picks a third one
 const t = 'Rechnung zur Tierhaftpflichtversicherung, Polizze 1';
 expect(ruleMatch('Kontoauszug.pdf', t, config)).toMatchObject({ route: { id: 'bank' }, byFilename: true });
 expect(ruleMatch('Vertrag.pdf', 'Rechnung 5 Betrag', config)).toMatchObject({ route: { id: 'contracts' }, byFilename: true });
});
test('R12 tiebreak: a name that matches no route or several routes, and a text without any conflict, change nothing', () => {
 const t = 'Rechnung zur Tierhaftpflichtversicherung, Polizze 1';
 expect(ruleMatch('scan.pdf', t, config)).toBeNull();
 expect(ruleMatch('Rechnung Vertrag.pdf', t, config)).toBeNull();
 expect(ruleMatch('Reisepass Rechnung.pdf', t, config)).toBeNull(); // personal + invoices in the name
 expect(ruleMatch('Reisepass.pdf', 'nichts besonderes', config)).toMatchObject({ route: { id: 'personal' }, byFilename: false }); // a lone hit stays a plain rule_match
 expect(ruleMatch('scan.pdf', 'nichts besonderes', config)).toBeNull();
});
test('R12 Unterhalt is narrowed to family-law forms (patterns and evidence); maintenance words never match', () => {
 const ev = routeEvidence(route('admin')), e = (t: string) => ev.some(re => re.test(t));
 for (const t of ['Unterhaltserhöhung', 'Unterhaltsanspruch', 'Unterhaltsansprüche', 'Unterhaltsvereinbarung', 'Unterhaltspflicht', 'Unterhaltsbetrag', 'Unterhaltsleistung', 'Unterhaltsfestsetzung', 'Unterhaltssache', 'Unterhaltsverfahren', 'Unterhaltsbemessung', 'Unterhalt Volljähriger', 'Unterhalt  Minderjähriger', 'Kindesunterhalt', 'Geldunterhalt']) { expect(hit('admin', t), t).toBe(true); expect(e(t), `evidence ${t}`).toBe(true); }
 for (const t of ['Unterhaltsarbeiten', 'Unterhaltskosten', 'Unterhalt der Anlage', 'Unterhalt', 'Unterhaltung', 'Unterhaltungselektronik']) { expect(hit('admin', t), t).toBe(false); expect(e(t), `evidence ${t}`).toBe(false); }
});
test('R12 admin Tier-1: Unfallbericht / Unfallmeldung', async () => {
 for (const t of ['Unfallbericht', 'Unfallmeldung', 'unfallbericht']) expect(hit('admin', t), t).toBe(true);
 expect(hit('admin', 'Unfallversicherung')).toBe(false);
 expect(await classify('Unfallbericht.pdf', 'Polizeiinspektion Urfahr', config, { model: never })).toMatchObject({ route: 'admin', tier: 'rule', reason: 'rule_match' });
});
test('R12 uni: Comp Logic, Computational Logic, Algo / Algorithmen / Algorithms as whole words', () => {
 for (const t of ['Comp logic 1', 'Comp Logic', 'Computational Logic', 'Algo', 'Algo.pdf', 'Algorithmen', 'Algorithms', 'Algorithms and Data Structures']) expect(hit('uni', t), t).toBe(true);
 for (const t of ['Compass Logic', 'Algorithmic', 'Algorithmus', 'Algolia', 'Computation Logic']) expect(hit('uni', t), t).toBe(false);
 expect(heuristics('Algo.pdf', 'K12345678', config)?.id).toBe('uni');
});
test('R12 fixtures: passport OCR naming the Magistrat -> personal via the file name; crane maintenance contract (Unterhaltsarbeiten + Vertrag) -> contracts, not admin', async () => {
 const kran = await fx(KRAN); expect(kran).toMatch(/Unterhaltsarbeiten/); expect(kran).toMatch(/Vertrag/i);
 expect(hit('admin', kran)).toBe(false);
 expect(await classify(KRAN, kran, config, { model: (async () => { throw new Error('x'); }) as never })).toMatchObject({ route: 'contracts', tier: 'rule' });
 expect(await classify(PASS, await fx(PASS), config, { model: never })).toMatchObject({ route: 'personal', reason: 'rule_match_filename' });
});
test('R12 diagnostics: explainRules lists routes per name / text with sanitized keywords (<= 40 chars) and the outcome', () => {
 const t = explainRules('Reisepass.pdf', 'Magistrat der Stadt Wien Rechnung', config);
 expect(t.matches).toEqual(expect.arrayContaining([{ route: 'personal', name: ['Reisepass'], text: [] }, { route: 'admin', name: [], text: ['Magistrat'] }, { route: 'invoices', name: [], text: ['Rechnung'] }]));
 expect(t.result).toBe('rule_match_filename:personal');
 expect(formatRuleTrace(t)).toContain('personal[name: Reisepass]'); expect(formatRuleTrace(t)).toContain('admin[text: Magistrat]'); expect(formatRuleTrace(t)).toContain('=> rule_match_filename:personal');
 expect(explainRules('x.pdf', 'nichts', config)).toEqual({ matches: [], result: 'no_match' });
 expect(explainRules('x.pdf', 'Rechnung Vertrag', config).result).toBe('conflict');
 const long = explainRules('x.pdf', `Rechnung${'x'.repeat(5)} Vertrag${'\u0007'}en Moodle`, config);
 for (const m of long.matches) for (const k of [...m.name, ...m.text]) { expect(k.length).toBeLessThanOrEqual(40); expect(k).not.toMatch(/[\u0000-\u001f]/); }
 expect(formatRuleTrace(explainRules('x.pdf', 'K12345678', config))).toContain('uni[text: K12345678]');
});
test('R12 diagnostics: `classify <file>` (inspectFile) and `eval --verbose` show the rule trace; plain eval, run items, history and logs never do', async () => {
 const sb = await sandbox(); try {
  const f = join(sb.inbox, 'Reisepass.txt'); await Bun.write(f, 'Magistrat der Stadt Wien, Ausweis Nr 5');
  const r = await inspectFile(f, sb.config);
  expect(r).toMatchObject({ route: 'personal', reason: 'rule_match_filename' }); expect(r.rules).toContain('admin[text: Magistrat]'); expect(r.rules).toContain('personal[name: Reisepass]');
  const stub = { extract: async (p: string) => readFile(p, 'utf8'), model: never };
  const plain = await evaluate(sb.inbox, sb.config, null, stub); expect(formatReport(plain)).not.toContain('rules:'); expect(plain.rows[0]!.rules).toBeUndefined();
  const verbose = await evaluate(sb.inbox, sb.config, null, stub, [], { verbose: true });
  expect(formatReport(verbose)).toContain('    rules: admin[text: Magistrat]'); expect(verbose.rows[0]!.rules).toContain('=> rule_match_filename:personal');
  // a real run: neither the items, nor the history, nor the log carry keywords
  const run = await runOnce(sb.config, { apply: true, model: never });
  expect(JSON.stringify(run)).not.toContain('Magistrat'); expect(JSON.stringify(run)).not.toContain('"rules"');
  const files = stateFiles(sb.config); const hist = await readFile(files.history, 'utf8').catch(() => '');
  expect(hist).not.toContain('Magistrat'); expect(hist).not.toContain('rules');
 } finally { await sb.cleanup(); }
});
test('R12 evidence still decides model picks: a court decision that mentions a university is accepted as admin; admin without evidence words is not', async () => {
 const text = await fx('gerichtsschreiben_studium_beispiel.txt');
 expect(routeVerified(route('admin'), 'x.pdf', text)).toBe(true); expect(routeVerified(route('admin'), 'x.pdf', 'Unterhaltsarbeiten an der Anlage')).toBe(false);
});
