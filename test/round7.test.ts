// Round 7: admin sub-folders (bank / tax / receipts) and the model-only admin root.
import { test, expect } from 'bun:test';
import { chmod, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from '../src/run';
import { applyInit, planInit, taxonomy } from '../src/init';
import { doctor } from '../src/doctor';
import { callHelper, classify, heuristics, parseModelResult, validateResult } from '../src/classifier';
import { routePatterns, validateConfig } from '../src/config';
import { targetName } from '../src/naming';
import { resolveLayout } from '../src/paths';
import { baseJson, defaultConfig as config, failingModel, model, sandbox, tree, type Sandbox } from './helpers';

const route = (id: string) => config.routes.find(r => r.id === id)!;
const exists = (p: string) => lstat(p).then(() => true, () => false);
const put = (sb: Sandbox, name: string, body: string) => writeFile(join(sb.inbox, name), body);
const A = '02_Admin & Finanzen';
const SUBFOLDERS: [string, string, string][] = [['bank', 'Bank', 'Kontoauszug Oktober 2026\nKontostand 1.234,50'], ['tax', 'Steuern', 'Einkommensteuerbescheid 2025\nFinanzamt Wien'], ['receipts', 'Belege', 'Kassabon Billa\nSumme 12,40']];

test('R7 routes: bank/tax/receipts are rename:false sub-folders, admin is the root with no patterns', () => {
 for (const [id, folder] of SUBFOLDERS.map(([i, f]) => [i, f] as const)) expect(route(id)).toMatchObject({ folder: `${A}/${folder}`, rename: false });
 expect(route('admin')).toMatchObject({ folder: A, rename: false }); expect(route('admin').patterns.length).toBeGreaterThan(0);
 for (const id of ['bank', 'tax', 'receipts']) expect(route(id).patterns.length).toBeGreaterThan(0);
 expect(route('admin').description).toMatch(/SVS/);
});
for (const [id, folder, text] of SUBFOLDERS) {
 test(`R7 Tier 1: a ${id} document is routed by the rule alone (model never consulted) into ${A}/${folder}, name kept`, async () => {
  expect(heuristics('scan.txt', text, config)?.id).toBe(id);
  const sb = await sandbox(); try {
   await put(sb, 'doc.txt', text);
   const r = await runOnce(sb.config, { apply: true, model: failingModel }); // a model call would throw -> proves the rule decided
   expect(r.items[0]).toMatchObject({ outcome: 'moved', route: id, destination: `${A}/${folder}/doc.txt`, renamed: false });
   expect(await readdir(join(sb.root, A, folder))).toEqual(['doc.txt']);
  } finally { await sb.cleanup(); }
 });
}
test('R7 overlaps are never Tier 1: Kontoauszug+Steuerbescheid, Rechnung+Beleg, bank+invoices go to the model tier', async () => {
 for (const t of ['Kontoauszug mit Steuerbescheid 2025', 'Rechnung und Beleg', 'Kassabon Rechnung Nr. 5', 'Finanzamt Quittung']) expect(heuristics('x.txt', t, config), t).toBeNull();
 const calls: string[] = [];
 const m = (async (f: string) => { calls.push(f); return { version: 2, route: 'tax', documentDate: '', sender: '', needsReview: false }; }) as never;
 const d = await classify('x.txt', 'Kontoauszug mit Steuerbescheid 2025', config, { model: m });
 expect(d).toMatchObject({ route: 'tax', tier: 'model' }); expect(calls).toHaveLength(1);
 const d2 = await classify('y.txt', 'Rechnung und Beleg', config, { model: (async () => ({ version: 2, route: 'receipts', documentDate: '', sender: '', needsReview: false })) as never });
 expect(d2).toMatchObject({ route: 'receipts', tier: 'model' });
});
test('R7 the model may answer bank / tax / receipts / admin; unknown ids are still rejected', () => {
 const ans = (route: string) => ({ version: 2, route, documentDate: '', sender: '', needsReview: false });
 for (const id of ['bank', 'tax', 'receipts', 'admin']) { expect(parseModelResult(ans(id), config)?.route).toBe(id); expect(validateResult(ans(id), config)).toMatchObject({ route: id, tier: 'model', needsReview: false }); }
 for (const id of ['banking', 'Bank', 'steuern', 'belege', 'admin/', '02_Admin & Finanzen/Bank', '../Bank', 'receipt']) { expect(parseModelResult(ans(id), config), id).toBeNull(); expect(validateResult(ans(id), config).reason).toBe('invalid_response'); }
});
test('R7 admin (round 11: strong authority patterns only): weak words never match in Tier 1, it is still offered to the model and accepted from it', async () => {
 for (const t of ['', 'Bescheid der Gemeinde Wien', 'Beitragsvorschreibung', 'admin', '02_Admin & Finanzen', 'Verwaltung']) expect(heuristics('x.txt', t, config)?.id, t).not.toBe('admin');
 expect(heuristics('x.txt', 'Bescheid der Gemeinde Wien', config)).toBeNull();
 // a patterns-less route validates (the key may even be absent) and is not dropped
 const { patterns: _p, ...noKey } = route('admin');
 const v = validateConfig({ ...baseJson, routes: baseJson.routes.map((r: { id: string }) => r.id === 'admin' ? noKey : r) });
 expect(v.routes.find(r => r.id === 'admin')).toMatchObject({ folder: A, patterns: [] });
 expect(v.routes.map(r => r.id)).toContain('admin');
 // the helper request lists admin (and every other route) for the model
 const sb = await sandbox(); try {
  const log = join(sb.dir, 'req.json'), bin = join(sb.dir, 'fake-classify');
  await writeFile(bin, `#!/bin/sh\ncat > '${log}'\nprintf '{"version":2,"route":"admin","documentDate":"","sender":"","needsReview":false}'\n`); await chmod(bin, 0o755);
  const cfg = { ...sb.config, classifier: bin };
  const out = await callHelper('x.txt', 'Bescheid der Gemeinde', cfg) as { route: string };
  const req = JSON.parse(await readFile(log, 'utf8')) as { routes: { id: string; description: string }[] };
  expect(req.routes.map(r => r.id)).toEqual(cfg.routes.map(r => r.id)); expect(req.routes.map(r => r.id)).toEqual(expect.arrayContaining(['bank', 'tax', 'receipts', 'admin']));
  expect(out.route).toBe('admin');
  // a keyword-less document goes to the model tier and lands in the admin root
  await put(sb, 'amt.txt', 'Schreiben der Bezirkshauptmannschaft, ohne Signalwort');
  const r = await runOnce(cfg, { apply: true, model: model({ route: 'admin' }) });
  expect(r.items[0]).toMatchObject({ outcome: 'moved', route: 'admin', destination: `${A}/amt.txt` });
 } finally { await sb.cleanup(); }
});
test('R7 patterns that match the empty string are rejected (no accidental match-all route); real patterns and the empty list are fine', () => {
 const withP = (patterns: string[]) => () => validateConfig({ ...baseJson, routes: [{ ...baseJson.routes[0], patterns }] });
 for (const p of ['(?:a|)', 'a*', '.*', '(?:)', 'x?', '|Rechnung']) expect(withP([p]), p).toThrow('matches the empty string');
 expect(withP(['Kontoauszug'])).not.toThrow(); expect(withP([])).not.toThrow(); expect(withP(['('])).toThrow('not a valid regular expression');
 for (const r of config.routes) for (const re of routePatterns(r)) expect(re.test(''), r.id).toBe(false);
});
test('R7 init creates all 11 folders (idempotent); only the three new ones for an existing setup', async () => {
 const sb = await sandbox({}, { taxonomy: false }); try {
  await rm(sb.inbox, { recursive: true }); // nothing exists yet: a fresh iCloud root
  const layout = await resolveLayout(sb.config);
  expect(taxonomy(sb.config)).toEqual(['_Inbox', '_Inbox/Needs_Review', '01_Uni', A, `${A}/Rechnungen`, `${A}/Verträge`, `${A}/Bank`, `${A}/Steuern`, `${A}/Belege`, '03_Projekte & Dev', '04_Persönlich']);
  expect(taxonomy(sb.config)).toHaveLength(11);
  const done = await applyInit(layout, sb.config); expect(done.create).toBe(11);
  for (const rel of taxonomy(sb.config)) expect(await exists(join(sb.root, ...rel.split('/'))), rel).toBe(true);
  const after = await tree(sb.root); expect((await applyInit(layout, sb.config)).create).toBe(0); expect(await tree(sb.root)).toEqual(after); // idempotent
  for (const f of ['Bank', 'Steuern', 'Belege']) await rm(join(sb.root, A, f), { recursive: true }); // an older setup
  const plan = await planInit(layout, sb.config); expect(plan.steps.filter(s => s.action === 'create').map(s => s.path)).toEqual([`${A}/Bank`, `${A}/Steuern`, `${A}/Belege`]);
  expect((await applyInit(layout, sb.config)).create).toBe(3);
 } finally { await sb.cleanup(); }
});
test('R7 doctor flags a missing sub-folder; the mover sends the file to review with folder_missing and never creates it', async () => {
 const sb = await sandbox(); try {
  expect((await doctor(sb.config, async () => ({ code: 1, output: '' }))).find(c => c.name.startsWith('taxonomy'))!.ok).toBe(true);
  await rm(join(sb.root, A, 'Steuern'), { recursive: true });
  const tx = (await doctor(sb.config, async () => ({ code: 1, output: '' }))).find(c => c.name.startsWith('taxonomy'))!;
  expect(tx.ok).toBe(false); expect(tx.detail).toContain(`${A}/Steuern`); expect(tx.detail).not.toContain(`${A}/Bank`);
  await put(sb, 'bescheid.txt', 'Steuerbescheid 2025'); await put(sb, 'auszug.txt', 'Kontoauszug 10/2026');
  const r = await runOnce(sb.config, { apply: true, model: failingModel });
  expect(r.items.find(i => i.file === 'bescheid.txt')).toMatchObject({ outcome: 'review', reason: `folder_missing:${A}/Steuern` });
  expect(r.items.find(i => i.file === 'auszug.txt')).toMatchObject({ outcome: 'moved', destination: `${A}/Bank/auszug.txt` });
  expect(await exists(join(sb.root, A, 'Steuern'))).toBe(false); expect(await readdir(sb.review)).toEqual(['bescheid.txt']);
 } finally { await sb.cleanup(); }
});
test('R7 naming.datePrefix applies to the admin root and the three sub-folders only; names are otherwise kept', () => {
 const on = { ...config, naming: { datePrefix: true } };
 for (const id of ['bank', 'tax', 'receipts', 'admin']) {
  expect(targetName({ filename: 'a.pdf', text: 'Kontoauszug\nDatum 31.10.2026', route: route(id), documentDate: '2026-10-31', sender: null }, config), id).toMatchObject({ name: 'a.pdf', renamed: false });
  expect(targetName({ filename: 'a.pdf', text: 'Kontoauszug\nDatum 31.10.2026', route: route(id), documentDate: '2026-10-31', sender: null }, on), id).toMatchObject({ name: '2026-10-31_a.pdf', renamed: true });
 }
 expect(targetName({ filename: 'a.pdf', text: 'x 31.10.2026', route: route('uni'), documentDate: '2026-10-31', sender: null }, on).renamed).toBe(false);
});
