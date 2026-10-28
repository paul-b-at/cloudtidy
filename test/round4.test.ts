// Round 4: circuit breaker vs. expiry (only real helper calls are attempts), Sozialversicherung rule, hardening (TOKEN_REASON, log rotation).
import { test, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOnce } from '../src/run';
import { heuristics, modelFailure } from '../src/classifier';
import { HelperError } from '../src/process';
import { PendingStore } from '../src/pending';
import { stateFiles } from '../src/state';
import { rotateLogs } from '../src/log';
import { defaultConfig as config, model, sandbox, type Sandbox, inboxFiles } from './helpers';

const put = (sb: Sandbox, name: string, body: string) => writeFile(join(sb.inbox, name), body);
const HOUR = 3_600_000;
const healthy = model({ route: 'personal' });

/** A fake helper that logs every call per file; `hang` files time out, `down` makes every call report the model unavailable. */
function fake(opts: { hang?: string[]; down?: boolean } = {}) {
 const calls: string[] = [];
 const m = async (filename: string, ...rest: unknown[]) => {
  calls.push(filename);
  if (opts.down) throw new HelperError('helper_unavailable');
  if (opts.hang?.includes(filename)) throw new HelperError('helper_timeout');
  return (healthy as (...a: unknown[]) => Promise<unknown>)(filename, ...rest);
 };
 return { calls, m: m as never };
}

// ---------------------------------------------------------------- F1: breaker vs. expiry
test('F1a one hanging file never gets healthy files reviewed without a real model call; they are classified once they reach the model', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  for (const n of ['aaa_poison', 'bbb_ok', 'ccc_ok']) await put(sb, `${n}.txt`, `an unclear note called ${n}`);
  let t = 1_000_000_000_000; const f = fake({ hang: ['aaa_poison.txt'] });
  const run = async () => { f.calls.length = 0; const r = await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: f.m }); return r; };
  for (let i = 0; i < 3; i++) { // backoff reset between runs (> 60 min): aaa is due every time, bbb/ccc are skipped by the open breaker
   const r = await run(); t += 2 * HOUR;
   expect(r.items.every(x => x.outcome === 'pending'), `run ${i + 1}`).toBe(true);
   expect(new Set(f.calls)).toEqual(new Set(['aaa_poison.txt'])); // the helper log: only the poison file was ever asked
  }
  const store = await PendingStore.load(stateFiles(sb.config).pending, () => t);
  expect(store.get('aaa_poison.txt')!.applyAttempts).toBe(3);
  for (const n of ['bbb_ok.txt', 'ccc_ok.txt']) { const e = store.get(n)!; expect(e.applyAttempts ?? 0, n).toBe(0); expect(e.applySince, n).toBeUndefined(); expect(e.attempts, n).toBe(0); }
  t += 25 * HOUR; // everything is "old"
  const r4 = await run();
  expect(f.calls.filter(c => c === 'aaa_poison.txt').length).toBe(1); // the expired file bypasses the breaker: exactly ONE real call, no retries
  expect(f.calls).not.toContain('bbb_ok.txt'); expect(f.calls).not.toContain('ccc_ok.txt');
  expect(r4.items.find(x => x.file === 'aaa_poison.txt')).toMatchObject({ outcome: 'review', reason: 'deferred_too_long:model_timeout' });
  for (const n of ['bbb_ok.txt', 'ccc_ok.txt']) expect(r4.items.find(x => x.file === n), n).toMatchObject({ outcome: 'pending' }); // NOT reviewed without a call
  expect(await readdir(sb.review)).toEqual(['aaa_poison.txt']);
  t += 2 * HOUR; const r5 = await run(); // aaa is gone: bbb and ccc finally reach the model
  expect(f.calls.sort()).toEqual(['bbb_ok.txt', 'ccc_ok.txt']);
  expect(r5.items.map(x => `${x.file}:${x.outcome}:${x.route}`).sort()).toEqual(['bbb_ok.txt:moved:personal', 'ccc_ok.txt:moved:personal']);
  expect(await inboxFiles(sb)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('F1b model down: a file is only ever reviewed as deferred_too_long if it was really asked in that very run', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'plain_a.txt', 'first unclear note'); await put(sb, 'plain_b.txt', 'second unclear note');
  let t = 1_000_000_000_000; const f = fake({ down: true }); const asked: Record<string, number> = {};
  for (let i = 0; i < 12; i++) {
   f.calls.length = 0; const r = await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: f.m });
   for (const c of f.calls) asked[c] = (asked[c] ?? 0) + 1;
   for (const it of r.items) if (it.reason.startsWith('deferred_too_long')) expect(f.calls, `run ${i + 1}: ${it.file} was reviewed without a call`).toContain(it.file);
   expect(f.calls.length).toBeLessThanOrEqual(2); // never more than the first (unavailable is global) + at most one expired file
   t += i < 6 ? 2 * HOUR : 5 * HOUR; // quickly past 24 h of age
  }
  expect(asked['plain_a.txt'] ?? 0).toBeGreaterThanOrEqual(3); expect(asked['plain_b.txt'] ?? 0).toBeGreaterThanOrEqual(1);
 } finally { await sb.cleanup(); }
});
test('F1c a breaker-skipped new file is pending, not an attempt (no clock, no backoff growth); an expired file whose single real call succeeds is sorted normally', async () => {
 const sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'aaa.txt', 'unclear a'); await put(sb, 'bbb.txt', 'unclear b');
  let t = 1_000_000_000_000; const down = fake({ hang: ['aaa.txt'] });
  const r1 = await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: down.m });
  expect(down.calls.filter(c => c === 'bbb.txt')).toEqual([]);
  expect(r1.items.find(x => x.file === 'bbb.txt')).toMatchObject({ outcome: 'pending' });
  const e = (await PendingStore.load(stateFiles(sb.config).pending, () => t)).get('bbb.txt')!;
  expect(e.next).toBeLessThanOrEqual(t); // due again on the next run
  for (let i = 0; i < 2; i++) { t += 2 * HOUR; await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: down.m }); }
  t += 25 * HOUR; const ok = fake(); // the helper has recovered: the expired aaa gets its one real call and is sorted
  const r = await runOnce(sb.config, { apply: true, now: () => t, sleep: async () => {}, model: ok.m });
  expect(r.items.find(x => x.file === 'aaa.txt')).toMatchObject({ outcome: 'moved', route: 'personal' }); expect(await readdir(sb.review)).toEqual([]);
 } finally { await sb.cleanup(); }
});

// ---------------------------------------------------------------- F2: Sozialversicherung
test('F2 SVS/ÖGK letters never route to contracts by rule; real insurance contracts still do', () => {
 for (const t of [
  'Sozialversicherung der Selbständigen / Versicherungsnummer: 1234 010190 / Beitragsvorschreibung 2026',
  'Österreichische Gesundheitskasse / Sozialversicherung / Versicherungsdatenauszug',
  'Ihre Versicherungsnummer lautet 1234', 'Versicherungsdaten 2026'
 ]) expect(heuristics('x.txt', t, config), t).toBeNull();
 for (const t of ['Versicherung Polizze Nr. 77', 'Haftpflichtversicherung', 'Versicherungsvertrag 2026', 'Versicherungsbedingungen (AVB)', 'Krankenversicherung'])
  expect(heuristics('x.txt', t, config)?.id, t).toBe('contracts');
});

// ---------------------------------------------------------------- hardening
test('TOKEN_REASON lookup ignores Object.prototype keys: a helper token like "constructor" stays model_failed', () => {
 for (const token of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])
  expect(modelFailure(new HelperError('helper_failed', 1, token)), token).toEqual({ kind: 'failed', reason: 'model_failed' });
 expect(modelFailure(new HelperError('helper_failed', 1, 'refusal'))).toEqual({ kind: 'failed', reason: 'model_refusal' });
});
test('log rotation never truncates through a symlink named launchd.out.log, and never overwrites a planted .1', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'ct-rot-')); try {
  const target = join(dir, 'precious.txt'); await writeFile(target, 'x'.repeat(100));
  await symlink(target, join(dir, 'launchd.out.log'));
  expect(await rotateLogs(dir, ['launchd.out.log'], 10, 3)).toEqual([]);
  expect((await stat(target)).size).toBe(100); expect(await readFile(target, 'utf8')).toBe('x'.repeat(100));
  expect((await readdir(dir)).sort()).toEqual(['launchd.out.log', 'precious.txt']); // no launchd.out.log.1 created either
  // a regular oversized file still rotates, and a symlink planted at .1 is not written through
  const f = join(dir, 'launchd.err.log'); await writeFile(f, 'y'.repeat(100)); const victim = join(dir, 'victim.txt'); await writeFile(victim, 'keep');
  await symlink(victim, `${f}.1`);
  await rotateLogs(dir, ['launchd.err.log'], 10, 3).catch(() => {});
  expect(await readFile(victim, 'utf8')).toBe('keep');
 } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- R4-1: an extraction (OCR / pdftotext) timeout is the file's OWN failure: it is an attempt, backs off and may expire
test('R4-1 a file whose OCR/pdftotext times out backs off and eventually expires (is not re-extracted on every run); breaker answers stay non-attempts', async () => {
 const MIN = 60_000, sb = await sandbox({ model: { maxDeferHours: 24 } }); try {
  await put(sb, 'scan.png', 'x'); let t = 1_700_000_000_000, extractCalls = 0;
  const extract = async () => { extractCalls++; throw new HelperError('helper_timeout'); };
  const run = () => runOnce(sb.config, { apply: true, sleep: async () => {}, model: healthy, extract, now: () => t } as never);
  for (let i = 0; i < 90; i++) { await run(); t += 2 * MIN; } // 3 h of 2-minute runs
  const after3h = extractCalls;
  for (let i = 0; i < 12 * 24; i++) { await run(); t += 5 * MIN; } // + 24 h of 5-minute runs
  console.log(`R4-1 extract calls in the first 3 h: ${after3h}; total after 27 h: ${extractCalls}`);
  expect(after3h).toBeLessThanOrEqual(10); // 5/10/20/40/60-minute backoff
  expect(await readdir(sb.review)).toEqual(['scan.png']); // gave up after maxDeferHours and >= 3 attempts
 } finally { await sb.cleanup(); }
});
test('R4-1b extraction timeouts never trip the model breaker: the next file is still asked, and the timeout is an attempt', async () => {
 const sb = await sandbox(); try {
  await put(sb, 'aaa.png', 'x'); await put(sb, 'bbb.txt', 'an unclear note'); const t = 1_700_000_000_000; const asked: string[] = [];
  const extract = async (file: string) => { if (file.endsWith('.png')) throw new HelperError('helper_timeout'); return 'an unclear note'; };
  const m = (async (f: string) => { asked.push(f); return healthy(f as never, '' as never, {} as never, null as never); }) as never;
  const r = await runOnce(sb.config, { apply: true, sleep: async () => {}, model: m, extract, now: () => t } as never);
  expect(asked).toEqual(['bbb.txt']); expect(r.items.find(x => x.file === 'bbb.txt')).toMatchObject({ outcome: 'moved' });
  const e = (await PendingStore.load(stateFiles(sb.config).pending, () => t)).get('aaa.png')!;
  expect(e.applyAttempts).toBe(1); expect(e.attempts).toBe(1); expect(e.next).toBeGreaterThan(t);
 } finally { await sb.cleanup(); }
});
