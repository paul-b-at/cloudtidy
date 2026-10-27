// Round-2 re-review regression tests (N-xx ids = safety-rereview.md). All pass with safety-rereview.patch; N-01..N-05b, N-10 fail on 169fcd0.
// Not included (policy decisions, see the re-review): N-06c rule-hit naming failure, N-08 sub-folder creation, N-11 stop-word senders.
import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, readdir, rm, symlink, lstat, chmod, stat, rename } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, tree, type Sandbox } from './helpers';
import { runOnce } from '../src/run';
import { moveNoClobber } from '../src/mover';
import { fingerprint, sha256File } from '../src/fsx';
import { resolveLayout } from '../src/paths';
import { appendHistory, readHistory, reconcileIntents, undoMoves, makeJournal } from '../src/history';
import { stateFiles, HeldStore } from '../src/state';
import { HelperError } from '../src/process';
import { classify, callHelper } from '../src/classifier';
import { applyInit, planInit, taxonomy } from '../src/init';
import { doctor, probeExclusiveRename } from '../src/doctor';

const exists = (p: string) => lstat(p).then(() => true, () => false);
const unavailable = async () => { throw new HelperError('helper_unavailable'); };
const personal = async () => ({ version: 2, route: 'personal', documentDate: '', sender: '', needsReview: false });
const put = (sb: Sandbox, name: string, body: string) => writeFile(join(sb.inbox, name), body);
async function prep(sb: Sandbox, name = 'a.txt', body = 'hello') {
 const layout = await resolveLayout(sb.config), src = join(sb.inbox, name); await writeFile(src, body);
 return { layout, src, snapshot: (await fingerprint(src))!, sha256: await sha256File(src) };
}
const jbase = (p: Awaited<ReturnType<typeof prep>>, ino?: number) => ({ runId: 'r1', mode: 'run' as const, source: p.src, sha256: p.sha256, size: p.snapshot.size, route: 'uni', tier: 'rule' as const, outcome: 'moved' as const, reason: 'rule_match', renamed: false, ...(ino === undefined ? {} : { ino }) });

// ---- N-01: the 24 h clock
test('N-01 a stale pending entry (dry-run clock / machine off for days) must not send a file to review before the model was asked again', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'note.txt', 'a short unclear note'); let t = 1_000_000_000_000, calls = 0;
  await runOnce(sb.config, { apply: false, model: unavailable, now: () => t, sleep: async () => {} });
  expect(await exists(stateFiles(sb.config).pending)).toBe(true); // documents: a dry-run starts the clock
  t += 72 * 3_600_000;
  const r = await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: async () => { calls++; return personal(); } });
  expect(r.items[0]!.reason.startsWith('deferred_too_long')).toBe(false);
  expect(calls).toBeGreaterThan(0);
 } finally { await sb.cleanup(); }
});

// ---- N-02: journal recovery
test('N-02 recovery must not "recover" a user file that merely has the same bytes/size at the planned destination (inode differs)', async () => {
 const sb = await sandbox(); try {
  const p = await prep(sb), f = stateFiles(sb.config).history, dest = join(sb.root, '01_Uni', 'a.txt');
  const j = makeJournal(f, jbase(p, p.snapshot.ino)); await j.intent(dest);
  await rm(p.src); await writeFile(dest, 'hello');
  const rec = await reconcileIntents(f);
  expect(rec.recovered).toBe(0);
  expect((await readHistory(f)).length).toBe(0);
 } finally { await sb.cleanup(); }
});
test('N-02b guard: genuinely landed move is recovered; dest replaced / missing / both present => abort; no user file is touched', async () => {
 const sb = await sandbox(); try {
  const f = stateFiles(sb.config).history, uni = join(sb.root, '01_Uni');
  const mk = async (n: string, body: string) => { const p = await prep(sb, n, body); const j = makeJournal(f, jbase(p, p.snapshot.ino)); const dest = join(uni, n); await j.intent(dest); return { p, dest }; };
  const a = await mk('landed.txt', 'one'); await rename(a.p.src, a.dest);
  const b = await mk('replaced.txt', 'two'); await rm(b.p.src); await writeFile(b.dest, 'TWO'); // same size, other bytes: only the sha check can tell
  const c = await mk('gone.txt', 'three'); await rm(c.p.src);
  const d = await mk('both.txt', 'four'); await writeFile(d.dest, 'four');
  const before = await tree(sb.root);
  const rec = await reconcileIntents(f);
  expect(rec).toEqual({ recovered: 1, aborted: 3 });
  expect(await tree(sb.root)).toEqual(before);
  expect((await readHistory(f)).map(m => (m as any).destination)).toEqual([a.dest]);
 } finally { await sb.cleanup(); }
});
test('N-02c guard: tampered intent pointing outside the iCloud root can be committed in the journal but undo refuses it', async () => {
 const sb = await sandbox(); try {
  const secret = join(sb.dir, 'outside.pdf'); await writeFile(secret, 'secret'); const sha = await sha256File(secret), f = stateFiles(sb.config).history;
  await mkdir(sb.state, { recursive: true });
  await appendHistory(f, { v: 1, type: 'intent', id: 'evil', runId: 'r', time: new Date().toISOString(), mode: 'run', source: join(sb.inbox, 'x.pdf'), destination: secret, sha256: sha, size: 6, route: null, tier: 'rule', outcome: 'moved', reason: 'x', renamed: false });
  await reconcileIntents(f);
  const layout = await resolveLayout(sb.config);
  const items = await undoMoves(sb.config, layout, f, { last: true }, { apply: true, undoRunId: 'u' });
  expect(items.every(i => i.status.startsWith('skipped'))).toBe(true);
  expect(await readFile(secret, 'utf8')).toBe('secret'); expect(await exists(join(sb.inbox, 'x.pdf'))).toBe(false);
 } finally { await sb.cleanup(); }
});

// ---- N-03: rollback that cannot roll back
test('N-03 if the post-rename rollback itself fails, the file that sits in the bucket must still be visible in history', async () => {
 const sb = await sandbox(); try {
  const p = await prep(sb), f = stateFiles(sb.config).history; let calls = 0;
  const rn = { onBackend: () => { calls++;
    if (calls === 1) { rmSync(p.src); writeFileSync(p.src, 'hello'); }
    if (calls === 2) writeFileSync(p.src, 'someone else'); } };
  const r = await moveNoClobber({ layout: p.layout, config: sb.config, kind: 'inbox', src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir: join(sb.root, '01_Uni'), name: 'a.txt', rename: rn, journal: makeJournal(f, jbase(p, p.snapshot.ino)) });
  const inBucket = await exists(join(sb.root, '01_Uni', 'a.txt'));
  const visible = (await readHistory(f)).length > 0;
  expect(r).toMatchObject({ kind: 'refused', reason: 'rollback_failed' });
  expect(inBucket && visible).toBe(true); // the file in the bucket is journaled (visible to history/undo), never silently left there
 } finally { await sb.cleanup(); }
});

// ---- N-04: circuit breaker
test('N-04 when the model hangs, one run must not pay (retries x timeout) for every single file', async () => {
 const sb = await sandbox({ classifierRetries: 1 }); try {
  for (let i = 0; i < 6; i++) await put(sb, `note${i}.txt`, `unclear note number ${i}`); await put(sb, 'zz.txt', 'VO 123.456 exercise');
  let calls = 0; const t = 1_000_000_000_000;
  const r = await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: async () => { calls++; throw new HelperError('helper_timeout'); } });
  expect(r.counts.moved).toBe(1);
  expect(r.counts.pending).toBe(6);
  console.log(`N-04 model calls in one run for 6 deferred files: ${calls}`);
  expect(calls).toBeLessThanOrEqual(2);
 } finally { await sb.cleanup(); }
});
test('N-04b guard: deferred files are not asked again inside the backoff window and rule hits are not starved', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'a_note.txt', 'unclear'); await put(sb, 'z_rule.txt', 'VO 123.456 exercise'); let t = 1_000_000_000_000, calls = 0;
  const run = () => runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: async () => { calls++; throw new HelperError('helper_failed', 4); } });
  const r1 = await run(); expect(r1.counts.moved).toBe(1); const c1 = calls;
  for (let i = 0; i < 5; i++) { t += 30_000; await run(); }
  expect(calls).toBe(c1);
 } finally { await sb.cleanup(); }
});

// ---- N-05: pending.json
test('N-05 pending.json with non-numeric timestamps must not wedge a file in _Inbox forever', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'note.txt', 'a short unclear note'); const sha = await sha256File(join(sb.inbox, 'note.txt'));
  await mkdir(sb.state, { recursive: true });
  await writeFile(stateFiles(sb.config).pending, JSON.stringify({ v: 1, entries: { 'note.txt': { kind: 'model', reason: 'model_timeout', sha256: sha, since: 'x', lastSeen: 0, attempts: 1, next: 'x' } } }));
  let t = 1_000_000_000_000; let outcome = 'pending', runs = 0;
  while (outcome === 'pending' && runs < 3) { runs++; t += 1000 * 3_600_000; const r = await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: personal }); outcome = r.items[0]?.outcome ?? 'gone'; }
  console.log('N-05 outcome after', runs, 'runs, 1000 h apart:', outcome);
  expect(outcome).not.toBe('pending');
 } finally { await sb.cleanup(); }
});
test('N-05b empty files named like Object.prototype keys go through pending -> grace -> review like any other empty file', async () => {
 const sb = await sandbox(); try {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'kind', 'next', 'since'];
  for (const n of names) await writeFile(join(sb.inbox, n), '');
  let t = 1_000_000_000_000; const run = () => runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: personal });
  const r1 = await run(); expect(r1.items.map(i => `${i.file}:${i.outcome}`).sort()).toEqual(names.map(n => `${n}:pending`).sort());
  t += 11 * 60_000; const r2 = await run();
  expect((await readdir(sb.review)).sort()).toEqual([...names].sort()); expect(r2.counts.errors).toBe(0);
 } finally { await sb.cleanup(); }
});
test('N-05c guard: pending entries for files that left _Inbox are dropped (store cannot grow beyond the inbox)', async () => {
 const sb = await sandbox(); try {
  for (let i = 0; i < 20; i++) await put(sb, `n${i}.txt`, `unclear ${i}`);
  const run = () => runOnce(sb.config, { apply: false, now: () => 1_000_000_000_000, sleep: async () => {}, model: unavailable });
  await run(); const size = async () => Object.keys(JSON.parse(await readFile(stateFiles(sb.config).pending, 'utf8')).entries).length;
  expect(await size()).toBe(20);
  for (let i = 0; i < 20; i++) await rm(join(sb.inbox, `n${i}.txt`));
  await run(); expect(await size()).toBe(0);
 } finally { await sb.cleanup(); }
});

// ---- N-06: lockedRoute end to end in TypeScript
const INV = 'Rechnung Nr. 5 IBAN AT12 3456 Betrag 10 EUR Wien Energie';
test('N-06 lockedRoute: a model answer for another route / review cannot change a rule route; the model is told the locked route', async () => {
 const sb = await sandbox(); try {
  const seen: (string | null | undefined)[] = [];
  for (const answer of [{ route: 'uni', documentDate: '2026-01-02', sender: 'Evil Corp' }, { route: 'review', needsReview: true }, { route: 'invoices', documentDate: '1999-01-01', sender: 'Nobody' }]) {
   const d = await classify('x.txt', 'Rechnung IBAN AT12 Betrag 10 EUR 2026-01-02 Evil Corp', sb.config, { model: async (_f, _t, _c, locked) => { seen.push(locked); return { version: 2, documentDate: '', sender: '', needsReview: false, ...answer }; } });
   expect(d.route).toBe('invoices'); expect(d.tier).toBe('rule'); expect(d.needsReview).toBe(false);
   if (answer.route !== 'invoices') { expect(d.documentDate).toBeNull(); expect(d.sender).toBeNull(); } // an answer for another route contributes nothing
  }
  expect(seen).toEqual(['invoices', 'invoices', 'invoices']);
 } finally { await sb.cleanup(); }
});
test('N-06b the real TS->helper call carries lockedRoute in the JSON request (what the Swift side enforces)', async () => {
 const sb = await sandbox(); try {
  const log = join(sb.dir, 'req.json'), bin = join(sb.dir, 'fake-classify');
  await writeFile(bin, `#!/bin/sh\ncat > '${log}'\nprintf '{"version":2,"route":"invoices","documentDate":"","sender":"","needsReview":false}'\n`); await chmod(bin, 0o755);
  const cfg = { ...sb.config, classifier: bin };
  await callHelper('x.txt', 'text', cfg, 'invoices'); expect(JSON.parse(await readFile(log, 'utf8')).lockedRoute).toBe('invoices');
  await callHelper('x.txt', 'text', cfg, null); expect('lockedRoute' in JSON.parse(await readFile(log, 'utf8'))).toBe(false);
 } finally { await sb.cleanup(); }
});
test('N-07 init creates exactly the taxonomy and nothing else; preview creates nothing; existing files untouched', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config);
  await rm(join(sb.root, '01_Uni'), { recursive: true }); await rm(join(sb.root, '02_Admin & Finanzen'), { recursive: true });
  await writeFile(join(sb.root, 'loose.txt'), 'x'); await writeFile(join(sb.root, '03_Projekte & Dev', 'keep.txt'), 'k');
  const before = await tree(sb.root);
  const plan0 = await planInit(layout, sb.config); expect(await tree(sb.root)).toEqual(before);
  await applyInit(layout, sb.config);
  const after = await tree(sb.root), added = after.filter(x => !before.includes(x));
  const tax = taxonomy(sb.config);
  expect(added.every(a => a.endsWith('/') && tax.some(t => t.toLowerCase() + '/' === a.toLowerCase()))).toBe(true);
  expect(before.every(b => after.includes(b))).toBe(true);
  expect(plan0.problems).toBe(0);
 } finally { await sb.cleanup(); }
});
test('N-07b init refuses when a taxonomy folder is a symlink; creates nothing (not even siblings), nothing outside the root', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config), outside = join(sb.dir, 'outside'); await mkdir(outside);
  await rm(join(sb.root, '01_Uni'), { recursive: true }); await symlink(outside, join(sb.root, '01_Uni'));
  await rm(join(sb.root, '02_Admin & Finanzen'), { recursive: true });
  await expect(applyInit(layout, sb.config)).rejects.toThrow(/init refused/);
  expect(await readdir(outside)).toEqual([]); expect(await exists(join(sb.root, '02_Admin & Finanzen'))).toBe(false);
 } finally { await sb.cleanup(); }
});
test('N-07c init refuses a non-iCloud root unless allowNonICloudRoot', async () => {
 const sb = await sandbox({ allowNonICloudRoot: false }); try {
  const layout = await resolveLayout(sb.config); await rm(join(sb.root, '01_Uni'), { recursive: true });
  await expect(applyInit(layout, sb.config)).rejects.toThrow(/not under/); expect(await exists(join(sb.root, '01_Uni'))).toBe(false);
 } finally { await sb.cleanup(); }
});
test('N-07d probe never deletes a user dir that already has the probe name, and doctor never writes through a symlinked _Inbox', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config), orig = Math.random, R = () => 0.123456789;
  const name = `.cloudtidy-probe-${process.pid}-${(0.123456789).toString(36).slice(2, 8)}`;
  const mine = join(sb.inbox, name); await mkdir(mine); for (const [n, b] of [['a', 'USER'], ['b', 'USER-B'], ['c', 'USER-C']]) await writeFile(join(mine, n!), b!);
  Math.random = R; const r = await probeExclusiveRename(layout); Math.random = orig;
  expect(r.ok).toBe(false);
  expect([await readFile(join(mine, 'a'), 'utf8'), await readFile(join(mine, 'b'), 'utf8'), await readFile(join(mine, 'c'), 'utf8')]).toEqual(['USER', 'USER-B', 'USER-C']);
  await rm(sb.inbox, { recursive: true }); const outside = join(sb.dir, 'outside'); await mkdir(outside); await symlink(outside, sb.inbox);
  await doctor(sb.config).catch(() => {}); expect(await readdir(outside)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('N-07e probe leaves _Inbox exactly as it found it', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config); await put(sb, 'keep.txt', 'k'); const before = await tree(sb.inbox);
  const r = await probeExclusiveRename(layout); expect(r.ok).toBe(true); expect(await tree(sb.inbox)).toEqual(before);
 } finally { await sb.cleanup(); }
});

// ---- N-08: residual F-06 one level down
test('N-10 a PREVIEW (`run --no-cache` without --apply) must not release undo holds', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'back.txt', 'a short unclear note'); const sha = await sha256File(join(sb.inbox, 'back.txt'));
  const h = await HeldStore.load(stateFiles(sb.config).held); await mkdir(sb.state, { recursive: true }); h.add(sha, 'back.txt'); await h.save();
  await runOnce(sb.config, { apply: false, useCache: false, now: () => 1_000_000_000_000, sleep: async () => {}, model: personal });
  const after = await HeldStore.load(stateFiles(sb.config).held);
  expect(after.has(sha, 'back.txt')).toBe(true); // today: released by a dry run; the daemon then re-sorts the file the user just undid
 } finally { await sb.cleanup(); }
});
test('N-12 guard: a file with a bidi-override name is skipped as unsafe_name, not an error on every run', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.inbox, 'Rechnung\u202Efdp.exe.txt'), 'VO 123.456 exercise'); await put(sb, 'ok.txt', 'VO 123.456 exercise');
  const r = await runOnce(sb.config, { apply: true, now: () => 1_000_000_000_000, sleep: async () => {}, model: personal });
  expect(r.skipped.map(s => s.reason)).toContain('unsafe_name'); expect(r.counts.errors).toBe(0); expect(r.counts.moved).toBe(1);
 } finally { await sb.cleanup(); }
});
