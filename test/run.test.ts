import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, readdir, symlink, stat, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from '../src/run';
import type { Item } from '../src/engine';
import { readHistory, undoMoves, selectForUndo, appendHistory, newRunId } from '../src/history';
import { stateFiles } from '../src/state';
import { resolveLayout } from '../src/paths';
import { acquireLock } from '../src/lock';
import { HelperError } from '../src/process';
import { failingModel, model, sandbox, swapForSymlink, tree, type Sandbox, inboxFiles } from './helpers';

const exists = (p: string) => stat(p).then(() => true, () => false);
const UNI = 'VO 123.456 Machine Learning exercise sheet';
const apply = (sb: Sandbox, o = {}) => runOnce(sb.config, { apply: true, model: model(), ...o });
async function put(sb: Sandbox, name: string, body: string) { await writeFile(join(sb.inbox, name), body); }

test('apply: rule match moves into the bucket and journals it', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'sheet.txt', UNI);
  const r = await apply(sb);
  expect(r.mode).toBe('apply'); expect(r.counts.moved).toBe(1);
  expect(await readFile(join(sb.root, '01_Uni', 'sheet.txt'), 'utf8')).toBe(UNI);
  expect(await inboxFiles(sb)).toEqual([]);
  const h = await readHistory(stateFiles(sb.config).history);
  expect(h).toHaveLength(1);
  expect(h[0]).toMatchObject({ type: 'move', runId: r.runId, outcome: 'moved', route: 'uni', tier: 'rule', source: join(sb.inbox, 'sheet.txt'), destination: join(sb.root, '01_Uni', 'sheet.txt'), size: UNI.length, renamed: false });
  expect((h[0] as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  expect((await readFile(stateFiles(sb.config).status, 'utf8'))).toContain('"mode": "apply"');
 } finally { await sb.cleanup(); }
});
test('dry-run never mutates the iCloud tree (also for review items); scan --dry-run writes nothing at all', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'sheet.txt', UNI); await put(sb, 'mystery.txt', 'something unclear'); await put(sb, '.x.pdf.icloud', ''); await symlink('/etc/passwd', join(sb.inbox, 'l.txt'));
  const before = await tree(sb.root);
  const r = await runOnce(sb.config, { apply: false, model: model({ needsReview: true }) });
  expect(r.mode).toBe('dry-run');
  expect(r.items.map(i => `${i.file}:${i.action}:${i.destination}`)).toEqual(['mystery.txt:review:_Inbox/Needs_Review/mystery.txt', 'sheet.txt:move:01_Uni/sheet.txt']);
  expect(await tree(sb.root)).toEqual(before);
  expect(await readdir(sb.review)).toEqual([]);
  expect(await readHistory(stateFiles(sb.config).history)).toEqual([]);
  const ro = await runOnce({ ...sb.config, stateDir: join(sb.dir, 'never') }, { apply: false, readOnly: true, model: model() });
  expect(ro.items).toHaveLength(2); expect(await tree(sb.root)).toEqual(before); expect(await exists(join(sb.dir, 'never'))).toBe(false);
 } finally { await sb.cleanup(); }
});
test('daemon apply gate: --daemon moves only when daemon.apply is true', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'sheet.txt', UNI);
  const off = await runOnce(sb.config, { apply: false, daemon: true, model: model() });
  expect(off.mode).toBe('dry-run'); expect(await inboxFiles(sb)).toEqual(['sheet.txt']);
  process.env.CLOUDTIDY_CONTEXT = 'launchd';
  try { expect((await runOnce(sb.config, { apply: false, model: model() })).mode).toBe('dry-run'); } finally { delete process.env.CLOUDTIDY_CONTEXT; }
  const on = await runOnce({ ...sb.config, daemon: { ...sb.config.daemon, apply: true } }, { apply: false, daemon: true, model: model() });
  expect(on.mode).toBe('apply'); expect(on.context).toBe('launchd'); expect(await exists(join(sb.root, '01_Uni', 'sheet.txt'))).toBe(true);
  // an interactive run is not affected by daemon.apply
  await put(sb, 'sheet2.txt', UNI);
  expect((await runOnce({ ...sb.config, daemon: { ...sb.config.daemon, apply: true } }, { apply: false, model: model() })).mode).toBe('dry-run');
 } finally { await sb.cleanup(); }
});
const hostile: [string, unknown][] = [
 ['unknown route', { route: 'invented' }], ['path as route', { route: '../01_Uni' }], ['absolute route', { route: '/etc' }], ['route with slash', { route: 'uni/../../x' }],
 ['smuggled absolute name', { route: 'personal', suggestedName: '/etc/cron.d/x' }], ['smuggled traversal name', { route: 'personal', suggestedName: '../../evil.txt' }],
 ['smuggled extension change', { route: 'personal', suggestedName: 'note.sh' }], ['wrong protocol version', { route: 'personal', version: 1 }],
 ['non-string sender', { route: 'personal', sender: 5 }], ['non-boolean needsReview', { route: 'personal', needsReview: 'false' }], ['null', null]
];
for (const [label, patch] of hostile) test(`hostile model output fails closed: ${label}`, async () => {
 const sb = await sandbox(); try {
  await put(sb, 'note.txt', 'a short unclear note');
  const m = patch === null ? async () => null : model(patch as Record<string, unknown>);
  const r = await runOnce(sb.config, { apply: true, model: m });
  expect(r.items[0]).toMatchObject({ outcome: 'review', reason: 'invalid_response' });
  expect(await readdir(sb.review)).toEqual(['note.txt']);
  expect((await readdir(sb.root)).sort()).toEqual(['01_Uni', '02_Admin & Finanzen', '03_Projekte & Dev', '04_Persönlich', '_Inbox']);
  expect(await readdir(sb.dir)).not.toContain('evil.txt');
 } finally { await sb.cleanup(); }
});
test('model output can never change the extension, even with a valid route', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'bill.txt', 'Drei Rechnung 03.10.2026');
  const r = await runOnce(sb.config, { apply: true, model: model({ route: 'invoices', documentDate: '2026-10-03', sender: 'Drei', suggestedName: '2026-10-03_Drei.sh' }) });
  // smuggled field => the whole response is rejected (a definite "invalid" answer): the rule's route stays (rule hits are final) and the file keeps its ORIGINAL name
  expect(r.items[0]).toMatchObject({ outcome: 'moved', route: 'invoices', renamed: false, reason: 'rule_match', detail: 'naming_invalid_response' });
  expect(await readdir(sb.review).catch(() => [])).toEqual([]); expect(await readdir(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'))).toEqual(['bill.txt']);
 } finally { await sb.cleanup(); }
});
test('invoice: deterministic date+sender need no model; for missing fields only validated model values are used', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'scan1.txt', 'Hutchison Drei Austria\nRechnung Nr. 4711\nRechnungsdatum 03.10.2026\nIBAN AT12 3456');
  await put(sb, 'scan2.txt', 'Rechnung\nzahlbar innerhalb von 14 Tagen'); // no date, no sender in the text: model is asked, but its values are not in the text
  const calls: (string | null | undefined)[] = [];
  const m: import('../src/classifier').ModelCall = async (f, _t, _c, locked) => { calls.push(f); calls.push(locked); return { version: 2, route: 'invoices', needsReview: false, documentDate: '2026-11-11', sender: 'Drei' }; };
  const r = await runOnce(sb.config, { apply: true, model: m });
  expect(r.counts.moved).toBe(2);
  expect(calls).toEqual(['scan2.txt', 'invoices']); // scan1 never reached the model; scan2's call had the route locked
  expect((await readdir(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'))).sort()).toEqual(['2026-10-03_Drei-Rechnung.txt', 'scan2.txt']);
  const h = await readHistory(stateFiles(sb.config).history);
  expect(h.filter(x => x.type === 'move' && x.renamed)).toHaveLength(1);
 } finally { await sb.cleanup(); }
});
test('conflicting rules go to the model; a rule hit is final; model failures: definite -> review, transient -> pending', async () => {
 const sb = await sandbox(); try {
  let calls = 0; const locks: (string | null | undefined)[] = [];
  const m = (route: string): import('../src/classifier').ModelCall => async (_f, _t, _c, locked) => { calls++; locks.push(locked); return { version: 2, route, documentDate: '', sender: '', needsReview: false }; };
  await put(sb, 'conflict.txt', 'Rechnung for the github.com repository');
  await runOnce(sb.config, { apply: false, model: m('dev') });
  expect(calls).toBe(1); expect(locks).toEqual([null]);
  await put(sb, 'contract.txt', 'Mietvertrag Wohnung 5'); // rule: contracts; the model is only asked for the missing date/sender, route locked
  const r = await runOnce(sb.config, { apply: false, model: m('personal') });
  expect(r.items.find(i => i.file === 'contract.txt')).toMatchObject({ action: 'move', route: 'contracts', tier: 'rule', destination: '02_Admin & Finanzen/Verträge/contract.txt' });
  expect(locks.at(-1)).toBe('contracts');
  const down = await runOnce(sb.config, { apply: false, model: failingModel, useCache: false });
  expect(down.items.find(i => i.file === 'contract.txt')).toMatchObject({ action: 'move', route: 'contracts', renamed: false, reason: 'rule_match', detail: 'naming_model_failed' }); // definite failure: the rule route stays, the name is kept, the reason is shown
  expect(down.items.find(i => i.file === 'conflict.txt')).toMatchObject({ action: 'review', reason: 'model_failed' });
  const busy = await runOnce(sb.config, { apply: false, model: async () => { throw new HelperError('helper_unavailable'); }, useCache: false });
  expect(busy.items.find(i => i.file === 'conflict.txt')).toMatchObject({ action: 'defer', outcome: 'pending', reason: 'model_unavailable' }); // transient: stays in _Inbox
  expect(busy.items.find(i => i.file === 'contract.txt')).toMatchObject({ action: 'defer', outcome: 'pending', reason: 'model_unavailable' });
 } finally { await sb.cleanup(); }
});
test('unavailable model / empty text / unsupported type / unsafe name all end in review', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'a.txt', 'unclear'); await put(sb, 'empty.txt', ' \n'); await put(sb, 'x.zip', 'PK'); await put(sb, 'h~x.txt', 'x');
  const r = await runOnce(sb.config, { apply: true, model: failingModel });
  expect(Object.fromEntries(r.items.map(i => [i.file, i.reason]))).toEqual({ 'a.txt': 'model_failed', 'empty.txt': 'empty_text', 'x.zip': 'unsupported_type' });
  expect(r.skipped.map(s => s.name)).toContain('h~x.txt');
  expect(await readdir(sb.review)).toEqual(['a.txt', 'empty.txt', 'x.zip']);
 } finally { await sb.cleanup(); }
});
test('transient helper failures are retried a bounded number of times; definite failures are not retried', async () => {
 const sb = await sandbox({ classifierRetries: 2 }); try {
  await put(sb, 'a.txt', 'unclear'); let n = 0;
  const flaky = async () => { if (++n < 3) throw new HelperError('helper_timeout'); return { version: 2, route: 'personal', documentDate: '', sender: '', needsReview: false }; };
  const r = await runOnce(sb.config, { apply: false, model: flaky, sleep: async () => {} });
  expect(n).toBe(3); expect(r.items[0]).toMatchObject({ route: 'personal' });
  n = -10; const r2 = await runOnce(sb.config, { apply: false, model: flaky, sleep: async () => {}, useCache: false });
  expect(n).toBe(-7); expect(r2.items[0]).toMatchObject({ outcome: 'pending', reason: 'model_timeout' });
  let k = 0; const r3 = await runOnce(sb.config, { apply: false, model: async () => { k++; throw new HelperError('helper_failed', 1); }, sleep: async () => {}, useCache: false, now: () => Date.now() + 2 * 3_600_000 }); // later: the backoff of r2 has elapsed
  expect(k).toBe(1); expect(r3.items[0]).toMatchObject({ action: 'review', reason: 'model_failed' });
 } finally { await sb.cleanup(); }
});
test('idempotent rescans: unchanged files are served from the content-hash cache; changes and --no-cache re-classify', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'a.txt', 'unclear'); let calls = 0;
  const m = async () => { calls++; return { version: 2, route: 'review', documentDate: '', sender: '', needsReview: true }; };
  await runOnce(sb.config, { apply: false, model: m }); expect(calls).toBe(1);
  const again = await runOnce(sb.config, { apply: false, model: m }); expect(calls).toBe(1); expect(again.items[0]!.cached).toBe(true);
  await runOnce(sb.config, { apply: false, model: m, useCache: false }); expect(calls).toBe(2);
  await put(sb, 'a.txt', 'unclear but different'); await runOnce(sb.config, { apply: false, model: m }); expect(calls).toBe(3);
  await runOnce({ ...sb.config, naming: { datePrefix: true } }, { apply: false, model: m }); expect(calls).toBe(4); // config change invalidates
 } finally { await sb.cleanup(); }
});
test('duplicate of an existing destination file goes to review; nothing is deleted or overwritten', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.root, '01_Uni', 'sheet.txt'), UNI);
  await put(sb, 'sheet.txt', UNI);
  const r = await apply(sb);
  expect(r.items[0]).toMatchObject({ outcome: 'duplicate', reason: 'duplicate_of_existing:01_Uni/sheet.txt', detail: 'same content as 01_Uni/sheet.txt' });
  expect(await readFile(join(sb.review, 'sheet.txt'), 'utf8')).toBe(UNI);
  expect(await readFile(join(sb.root, '01_Uni', 'sheet.txt'), 'utf8')).toBe(UNI);
  expect((await readHistory(stateFiles(sb.config).history))[0]).toMatchObject({ outcome: 'duplicate' });
 } finally { await sb.cleanup(); }
});
test('different content with the same name is suffixed, never overwritten', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.root, '01_Uni', 'sheet.txt'), `${UNI} v1`);
  await put(sb, 'sheet.txt', UNI); await apply(sb);
  expect(await readFile(join(sb.root, '01_Uni', 'sheet.txt'), 'utf8')).toBe(`${UNI} v1`);
  expect(await readFile(join(sb.root, '01_Uni', 'sheet (2).txt'), 'utf8')).toBe(UNI);
 } finally { await sb.cleanup(); }
});
test('symlinked destination bucket ends in review inside _Inbox/Needs_Review', async () => {
 const sb = await sandbox(); try {
  const outside = join(sb.dir, 'outside'); await mkdir(outside); await swapForSymlink(sb, '01_Uni', outside);
  await put(sb, 'sheet.txt', UNI);
  const r = await apply(sb);
  expect(r.items[0]).toMatchObject({ outcome: 'review', reason: 'destination_unsafe' });
  expect(await readdir(outside)).toEqual([]); expect(await readdir(sb.review)).toEqual(['sheet.txt']);
 } finally { await sb.cleanup(); }
});
test('EXDEV in a run ends in review, never copy+delete', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'sheet3.txt', 'UE 111.222 exercise');
  const ex = await runOnce(sb.config, { apply: true, model: model(), deviceOf: async d => (d.includes('Needs_Review') ? (await stat(d)).dev : -1) });
  expect(ex.items[0]).toMatchObject({ outcome: 'review', reason: 'exdev' });
  expect(await readdir(sb.review)).toEqual(['sheet3.txt']); expect(await readdir(join(sb.root, '01_Uni'))).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('lock contention: a second run does nothing while the first holds the lock', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'sheet.txt', UNI);
  const held = await acquireLock(stateFiles(sb.config).lock, { waitMs: 0 });
  const r = await apply(sb);
  expect(r.locked).toBe(true); expect(await inboxFiles(sb)).toEqual(['sheet.txt']);
  await held!.release();
  expect((await apply(sb)).counts.moved).toBe(1);
 } finally { await sb.cleanup(); }
});
test('unstable (still-changing) files are skipped by run and picked up later', async () => {
 const sb = await sandbox({ debounceMs: 5 }); try {
  await put(sb, 'sheet.txt', UNI);
  const r = await apply(sb, { sleep: async () => { await appendFile(join(sb.inbox, 'sheet.txt'), '.'); } });
  expect(r.items).toMatchObject([{ file: 'sheet.txt', outcome: 'pending', reason: 'unstable' }]); expect(r.counts.moved).toBe(0);
  expect((await apply(sb, { sleep: async () => {} })).counts.moved).toBe(1);
 } finally { await sb.cleanup(); }
});
test('undo: restores to the original path; refuses on hash mismatch, occupied original, missing file, tampered history', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'a.txt', 'VO 111.111 a'); await put(sb, 'b.txt', 'VO 222.222 b'); await put(sb, 'c.txt', 'VO 333.333 c'); await put(sb, 'd.txt', 'VO 444.444 d');
  const r = await apply(sb);
  const files = stateFiles(sb.config), layout = await resolveLayout(sb.config), uni = (n: string) => join(sb.root, '01_Uni', n);
  await writeFile(uni('a.txt'), 'edited after the move'); // hash mismatch
  await writeFile(join(sb.inbox, 'b.txt'), 'new file at the original path'); // occupied
  const { rm } = await import('node:fs/promises'); await rm(uni('c.txt')); // missing
  const preview = await undoMoves(sb.config, layout, files.history, { runId: r.runId }, { apply: false, undoRunId: newRunId() });
  expect(Object.fromEntries(preview.map(i => [i.to.split('/').pop(), i.status]))).toEqual({ 'a.txt': 'skipped_changed', 'b.txt': 'skipped_original_occupied', 'c.txt': 'skipped_missing', 'd.txt': 'would_restore' });
  expect(await exists(uni('d.txt'))).toBe(true); // preview moved nothing
  const done = await undoMoves(sb.config, layout, files.history, { runId: r.runId }, { apply: true, undoRunId: newRunId() });
  expect(done.filter(i => i.status === 'restored').map(i => i.to.split('/').pop())).toEqual(['d.txt']);
  expect(await readFile(join(sb.inbox, 'd.txt'), 'utf8')).toBe('VO 444.444 d');
  expect(await readFile(uni('a.txt'), 'utf8')).toBe('edited after the move');
  expect(await readFile(join(sb.inbox, 'b.txt'), 'utf8')).toBe('new file at the original path');
  expect(await readFile(uni('b.txt'), 'utf8')).toBe('VO 222.222 b');
  // already-undone moves are not offered again
  expect(selectForUndo(await readHistory(files.history), { runId: r.runId }).map(m => m.source.split('/').pop()).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  // restored content is held, so the daemon does not immediately re-sort it
  const again = await apply(sb);
  expect(again.items.find(i => i.file === 'd.txt')).toMatchObject({ outcome: 'skipped', detail: 'held_after_undo' });
  expect(await exists(join(sb.inbox, 'd.txt'))).toBe(true);
  const forced = await apply(sb, { useCache: false }); expect(forced.items.find(i => i.file === 'd.txt')?.outcome).toBe('moved');
 } finally { await sb.cleanup(); }
});
test('undo --last picks the most recent run; tampered history paths are refused', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'a.txt', 'VO 111.111 a'); await apply(sb);
  await put(sb, 'b.txt', 'VO 222.222 b'); const second = await apply(sb);
  const files = stateFiles(sb.config), layout = await resolveLayout(sb.config);
  expect(selectForUndo(await readHistory(files.history), { last: true }).map(m => m.runId)).toEqual([second.runId]);
  await writeFile(join(sb.dir, 'victim.txt'), 'victim');
  const bad = { v: 1 as const, type: 'move' as const, id: 'evil', runId: 'evil-run', time: new Date().toISOString(), mode: 'run' as const, source: join(sb.dir, 'victim2.txt'), destination: join(sb.dir, 'victim.txt'), sha256: await (await import('../src/fsx')).sha256File(join(sb.dir, 'victim.txt')), size: 6, route: null, tier: 'none' as const, outcome: 'moved' as const, reason: 'x', renamed: false };
  await appendHistory(files.history, bad);
  expect((await undoMoves(sb.config, layout, files.history, { runId: 'evil-run' }, { apply: true, undoRunId: 'u' }))[0]!.status).toBe('skipped_unsafe');
  expect(await readFile(join(sb.dir, 'victim.txt'), 'utf8')).toBe('victim'); expect(await exists(join(sb.dir, 'victim2.txt'))).toBe(false);
  await appendFile(files.history, '{"torn":'); // a torn last line must not hide earlier records
  expect((await readHistory(files.history)).length).toBe(3);
 } finally { await sb.cleanup(); }
});
test('sweep: preview never moves, declined confirmation moves nothing, confirmed sweep moves only loose root files', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.root, 'loose.txt'), UNI); await writeFile(join(sb.root, 'mystery.txt'), 'unclear');
  await writeFile(join(sb.root, 'Pages'), 'x'); await writeFile(join(sb.root, 'a~b.txt'), 'x'); await writeFile(join(sb.root, '.hidden'), 'x');
  await mkdir(join(sb.root, 'Numbers')); await writeFile(join(sb.root, 'Numbers', 'inside.txt'), UNI); await mkdir(join(sb.root, '_Archiv')); await writeFile(join(sb.root, '_Archiv', 'old.txt'), UNI);
  const before = await tree(sb.root);
  const sweep = (o: { apply: boolean; confirm?: (items: Item[]) => Promise<boolean> }) => runOnce(sb.config, { kind: 'root', mode: 'sweep', notify: false, model: model({ needsReview: true }), ...o });
  const preview = await sweep({ apply: false });
  expect(preview.items.map(i => i.file)).toEqual(['loose.txt', 'mystery.txt']); expect(await tree(sb.root)).toEqual(before);
  let shown: string[] = [];
  const declined = await sweep({ apply: true, confirm: async items => { shown = items.map(i => i.file); return false; } });
  expect(declined.aborted).toBe(true); expect(shown).toEqual(['loose.txt', 'mystery.txt']); expect(await tree(sb.root)).toEqual(before);
  const done = await sweep({ apply: true, confirm: async () => true });
  expect(done.counts).toMatchObject({ moved: 1, review: 1 });
  expect(await exists(join(sb.root, '01_Uni', 'loose.txt'))).toBe(true); expect(await exists(join(sb.review, 'mystery.txt'))).toBe(true);
  expect((await tree(sb.root)).filter(l => /Pages|a~b|\.hidden|Numbers|_Archiv/.test(l))).toEqual(before.filter(l => /Pages|a~b|\.hidden|Numbers|_Archiv/.test(l)));
  expect((await readHistory(stateFiles(sb.config).history)).every(h => h.type === 'move' && h.mode === 'sweep')).toBe(true);
 } finally { await sb.cleanup(); }
});
test('end to end through a real helper subprocess (protocol v2) incl. availability check', async () => {
 const sb = await sandbox(); try {
  const script = `#!${process.execPath}\nif (process.argv[2]==='--check') { console.log(JSON.stringify({version:2,available:true,reason:'available'})); process.exit(0); }\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const x=JSON.parse(i);if(x.version!==2)process.exit(3);console.log(JSON.stringify({version:2,route:'personal',documentDate:'',sender:'',needsReview:false}));});`;
  await writeFile(sb.config.classifier, script, { mode: 0o755 });
  await put(sb, 'trip.txt', 'packing list for the weekend');
  const r = await runOnce(sb.config, { apply: true });
  expect(r.model).toEqual({ available: true, reason: 'available' });
  expect(await readFile(join(sb.root, '04_Persönlich', 'trip.txt'), 'utf8')).toBe('packing list for the weekend');
  expect(JSON.parse(await readFile(stateFiles(sb.config).status, 'utf8')).model.available).toBe(true);
  await writeFile(sb.config.classifier, '#!/bin/sh\nexit 2\n', { mode: 0o755 }); await put(sb, 'x.txt', 'whatever');
  const down = await runOnce(sb.config, { apply: false });
  expect(down.model?.available).toBe(false); expect(down.items[0]).toMatchObject({ reason: 'model_unavailable' });
 } finally { await sb.cleanup(); }
});
test('real helper subprocess: lockedRoute is sent for rule hits, exit codes 2/4/1 map to pending/pending/review', async () => {
 const sb = await sandbox(); try {
  const seen = join(sb.dir, 'seen.json');
  const script = `#!${process.execPath}\nif (process.argv[2]==='--check') { console.log(JSON.stringify({version:2,available:true})); process.exit(0); }\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(seen)}, i+'\\n');const x=JSON.parse(i);console.log(JSON.stringify({version:2,route:x.lockedRoute||'personal',documentDate:'',sender:'',needsReview:false}));});`;
  await writeFile(sb.config.classifier, script, { mode: 0o755 });
  await put(sb, 'mv.txt', 'Mietvertrag Wohnung 5'); await put(sb, 'free.txt', 'packing list for the weekend');
  const r = await runOnce(sb.config, { apply: true });
  expect(r.counts.moved).toBe(2);
  const reqs = (await readFile(seen, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  expect(reqs.find(q => q.filename === 'mv.txt')).toMatchObject({ version: 2, lockedRoute: 'contracts' }); expect('lockedRoute' in reqs.find(q => q.filename === 'free.txt')!).toBe(false);
  for (const [code, outcome, reason] of [[2, 'pending', 'model_unavailable'], [4, 'pending', 'model_busy'], [1, 'review', 'model_failed'], [3, 'review', 'model_failed']] as const) {
   await writeFile(sb.config.classifier, `#!/bin/sh\nif [ "$1" = "--check" ]; then echo '{"version":2,"available":true}'; exit 0; fi\ncat >/dev/null\nexit ${code}\n`, { mode: 0o755 });
   await put(sb, `n${code}.txt`, 'unclear note');
   const x = await runOnce(sb.config, { apply: false, sleep: async () => {}, useCache: false });
   expect(x.items.find(i => i.file === `n${code}.txt`), `exit ${code}`).toMatchObject({ outcome: code === 1 || code === 3 ? 'planned' : outcome, reason });
   await rm(join(sb.inbox, `n${code}.txt`));
  }
 } finally { await sb.cleanup(); }
});
