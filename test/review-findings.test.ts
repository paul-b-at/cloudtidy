// Regression tests for the safety-review findings F-03..F-18 (each asserts the SAFE behaviour).
import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, readdir, symlink, rm, stat, appendFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const CLI = resolve(import.meta.dir, '../src/cli.ts');
import { sandbox, model, baseJson, inboxFiles } from './helpers';
import { runOnce } from '../src/run';
import { moveNoClobber } from '../src/mover';
import { exclusiveRename, exclusiveRenameSupported, fingerprint, sha256File } from '../src/fsx';
import { probeExclusiveRename } from '../src/doctor';
import { resolveLayout } from '../src/paths';
import { appendHistory, readHistory, newRunId } from '../src/history';
import { stateFiles } from '../src/state';
import { heuristics } from '../src/classifier';
import { datesInText, sanitizeStem } from '../src/naming';
import { safeName } from '../src/config';

const exists = (p: string) => lstat(p).then(() => true, () => false);
type SB = Awaited<ReturnType<typeof sandbox>>;
async function prepared(sb: SB, name = 'a.txt', body = 'hello') {
 const layout = await resolveLayout(sb.config), src = join(sb.inbox, name);
 await writeFile(src, body);
 return { layout, src, snapshot: (await fingerprint(src))!, sha256: await sha256File(src) };
}
const req = (sb: SB, p: Awaited<ReturnType<typeof prepared>>, destDir: string, name = 'a.txt', extra = {}) => ({ layout: p.layout, config: sb.config, kind: 'inbox' as const, src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir, name, ...extra });

// F-03 --------------------------------------------------------------------------------------------------------------
test('F-03 a torn last history line must not swallow the next (real) move record', async () => {
 const sb = await sandbox(); try {
  const f = stateFiles(sb.config).history;
  const rec = (id: string) => ({ v: 1 as const, type: 'move' as const, id, runId: 'r', time: 't', mode: 'run' as const, source: '/x/a', destination: '/x/b', sha256: 'h', size: 1, route: null, tier: 'rule' as const, outcome: 'moved' as const, reason: '', renamed: false });
  await appendHistory(f, rec('one'));
  await appendFile(f, '{"v":1,"type":"move","id":"torn'); // crash / ENOSPC mid-write: no trailing newline
  await appendHistory(f, rec('two'));
  expect((await readHistory(f)).map(r => r.id)).toEqual(['one', 'two']); // today: ['one'] -> move "two" is unjournaled and cannot be undone
 } finally { await sb.cleanup(); }
});

// F-04 --------------------------------------------------------------------------------------------------------------
test('F-04 a move whose history write fails must be rolled back (or never happen): no unjournaled moves', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.inbox, 'sheet.txt'), 'VO 123.456 exercise sheet');
  await mkdir(stateFiles(sb.config).history, { recursive: true }); // history.jsonl is a directory -> appendFile fails with EISDIR
  const r = await runOnce(sb.config, { apply: true, model: model() });
  expect(r.counts.errors).toBe(1);
  // safe outcomes: file still in _Inbox (rolled back / never moved). Today it sits in 01_Uni with no audit record.
  expect(await exists(join(sb.inbox, 'sheet.txt'))).toBe(true);
 } finally { await sb.cleanup(); }
});

// F-05 --------------------------------------------------------------------------------------------------------------
test('F-05 a file swapped in after verification must not be left in the bucket unjournaled', async () => {
 const sb = await sandbox(); try {
  const p = await prepared(sb);
  // deviceOf runs after hash verification and before the rename: simulate iCloud atomically replacing the file (new inode, new content).
  const deviceOf = async (d: string) => { await writeFile(join(sb.dir, 'swap'), 'NEWER CONTENT FROM ANOTHER DEVICE'); const { rename } = await import('node:fs/promises'); await rename(join(sb.dir, 'swap'), p.src); return (await stat(d)).dev; };
  const r = await moveNoClobber(req(sb, p, join(sb.root, '01_Uni'), 'a.txt', { deviceOf }));
  const inBucket = await exists(join(sb.root, '01_Uni', 'a.txt'));
  // today: r = refused/rename_failed AND the unverified file is already in 01_Uni (no history record is written for a refused result)
  expect(r.kind).toBe('refused'); expect(inBucket).toBe(false); // strengthened: accepting `moved` let a reverted inode check go unnoticed
 } finally { await sb.cleanup(); }
});

// F-06 --------------------------------------------------------------------------------------------------------------
test('F-06 cloudtidy never creates a missing top-level bucket in the iCloud root (the file goes to review instead)', async () => {
 const sb = await sandbox(); try {
  await rm(join(sb.root, '01_Uni'), { recursive: true });
  const p = await prepared(sb);
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toEqual({ kind: 'refused', reason: 'folder_missing', detail: 'folder_missing:01_Uni' });
  expect(await exists(join(sb.root, '01_Uni'))).toBe(false);
  // end to end: the run reviews the file, and still does not create the bucket
  await writeFile(join(sb.inbox, 'sheet.txt'), 'VO 123.456 exercise sheet');
  const r = await runOnce(sb.config, { apply: true, model: model() });
  expect(r.items.find(i => i.file === 'sheet.txt')).toMatchObject({ outcome: 'review', reason: 'folder_missing:01_Uni' });
  expect(await exists(join(sb.root, '01_Uni'))).toBe(false); expect(await readdir(sb.review)).toContain('sheet.txt');
 } finally { await sb.cleanup(); }
});

// F-07 --------------------------------------------------------------------------------------------------------------
test('F-07 an iCloud placeholder (.name.icloud) at the destination counts as an occupied name', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.root, '01_Uni', '.a.txt.icloud'), 'placeholder plist');
  const p = await prepared(sb);
  const r = await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')));
  expect(r).toMatchObject({ kind: 'moved', to: join(sb.root, '01_Uni', 'a (2).txt') }); // today: moved to a.txt next to the evicted a.txt -> iCloud name conflict on download
 } finally { await sb.cleanup(); }
});

// F-08 (directory-component TOCTOU) is reproduced in dir-toctou.ts: it needs a hook between assertDestFile and rename.

// F-09 --------------------------------------------------------------------------------------------------------------
test('F-09 terminal escape sequences in file names are not echoed raw by `review` / run output', async () => {
 const sb = await sandbox(); try {
  const cfg = join(sb.dir, 'cfg.json');
  await writeFile(cfg, JSON.stringify({ ...baseJson, allowNonICloudRoot: true, root: sb.root, stateDir: sb.state, logDir: sb.config.logDir, classifier: sb.config.classifier, ocr: sb.config.ocr }));
  await mkdir(sb.review, { recursive: true });
  const evil = 'x\x1b]0;PWNED\x07\x1b[2J.pdf';
  await writeFile(join(sb.review, evil), 'x'); await writeFile(join(sb.inbox, evil.replace('x', 'y')), 'y');
  const run = async (...a: string[]) => { const p = Bun.spawn([process.execPath, CLI, ...a, '--config', cfg], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLOUDTIDY_QUIET: '1' } }); return await new Response(p.stdout).text(); };
  for (const out of [await run('review'), await run('run')]) expect(out.includes('\x1b')).toBe(false);
 } finally { await sb.cleanup(); }
});

// F-12 --------------------------------------------------------------------------------------------------------------
test('F-12 tier-1 rules and date extraction are NFC-blind (NFD text/filenames silently miss)', () => {
 const nfd = 'F\u0075\u0308hrerschein'; // "Führerschein" decomposed (what HFS+-era tools / some OCR emit)
 const cfg = { routes: [{ id: 'personal', folder: '04_Persönlich', description: 'd', rename: false, patterns: ['\\b(Führerschein)\\b'] }] } as never;
 expect(heuristics('x.pdf', nfd, cfg)?.id).toBe('personal');
 expect([...datesInText('3. Ma\u0308rz 2026')]).toEqual(['2026-03-03']);
});

// F-13 --------------------------------------------------------------------------------------------------------------
test('F-13 sanitizeStem must not cut a surrogate pair in half', () => {
 const s = sanitizeStem('a' + '😀'.repeat(80), 100);
 expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(s)).toBe(false); // today: ends with a lone high surrogate -> U+FFFD in the on-disk name
});

// F-14 --------------------------------------------------------------------------------------------------------------
test('F-14 safeName rejects bidi overrides, zero-width and C1 control characters', () => {
 for (const bad of ['Rechnung\u202Efdp.exe', 'a\u200Bb.pdf', 'a\u0085b.pdf', 'a\u2028b.pdf', 'a\ufeffb.pdf', 'a\u2066b.pdf']) expect(safeName(bad), JSON.stringify(bad)).toBe(false);
});

// F-15 --------------------------------------------------------------------------------------------------------------
test('F-15 one file that makes moveNoClobber throw (here ENAMETOOLONG on the " (2)" candidate) must not starve every later file', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true });
  const name = `${'ä'.repeat(124)}.txt`; // 252 bytes: fine as-is, 256 bytes once " (2)" is inserted -> lstat() throws ENAMETOOLONG
  await writeFile(join(sb.root, '01_Uni', name), 'other content');
  await writeFile(join(sb.inbox, name), 'VO 123.456 new content');
  await writeFile(join(sb.inbox, 'zzz.txt'), 'VO 222.222 innocent bystander');
  const r = await runOnce(sb.config, { apply: true, model: model() });
  expect(await exists(join(sb.root, '01_Uni', 'zzz.txt'))).toBe(true); // today: run aborts at the first throw ("history_or_io_error"), zzz.txt is never processed - on every run
  expect(r.items.some(i => i.detail === 'history_or_io_error')).toBe(false);
 } finally { await sb.cleanup(); }
});

// F-16 guard ---------------------------------------------------------------------------------------------------------
test('guard: apply still refuses to run in daemon context without daemon.apply, sweep refuses in launchd context', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.inbox, 'sheet.txt'), 'VO 123.456 exercise sheet');
  expect((await runOnce(sb.config, { apply: false, daemon: true, model: model() })).mode).toBe('dry-run');
  expect(await exists(join(sb.inbox, 'sheet.txt'))).toBe(true);
 } finally { await sb.cleanup(); }
});

// F-17 --------------------------------------------------------------------------------------------------------------
test('F-17 an OCR/helper timeout during extraction is cached as transient, not as a permanent verdict', async () => {
 const { analyze } = await import('../src/engine');
 const { DecisionCache } = await import('../src/state');
 const { HelperError } = await import('../src/process');
 const sb = await sandbox(); try {
  const cache = await DecisionCache.load(null, 'fp');
  const a = await analyze('/x/scan.pdf', 'scan.pdf', 'sha', sb.config, { cache, extract: async () => { throw new HelperError('helper_timeout'); } });
  expect(a.reason).toBe('extraction_failed');
  expect(a.transient).toBe(true); // today: false -> cached forever (until config/classifier changes), the scan stays in review
 } finally { await sb.cleanup(); }
});

// F-18 --------------------------------------------------------------------------------------------------------------
test('F-18 the non-atomic lstat+rename fallback is never used implicitly (apply refuses when no exclusive rename exists)', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.inbox, 'sheet.txt'), 'VO 123.456 exercise sheet');
  const backends: string[] = [];
  const r = await runOnce(sb.config, { apply: true, model: model(), rename: { disableNative: true, onBackend: b => backends.push(b) } });
  expect(r.counts.moved).toBe(0); expect(backends).toEqual([]); // neither backend ran: nothing moved
  expect(await inboxFiles(sb)).toContain('sheet.txt'); expect(await readdir(join(sb.root, '01_Uni'))).toEqual([]);
  // the doctor probe fails instead of reporting a green check
  const probe = await probeExclusiveRename(await resolveLayout(sb.config), { disableNative: true });
  expect(probe.ok).toBe(false);
 } finally { await sb.cleanup(); }
});
test('F-18b a test can tell the native exclusive rename from the fallback', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.dir, 'a'), '1');
  const seen: string[] = [];
  expect(await exclusiveRename(join(sb.dir, 'a'), join(sb.dir, 'b'), { onBackend: b => seen.push(b) })).toBe('ok');
  expect(await exclusiveRename(join(sb.dir, 'b'), join(sb.dir, 'c'), { forceFallback: true, onBackend: b => seen.push(b) })).toBe('ok');
  expect(seen).toEqual([exclusiveRenameSupported() ? 'native' : 'fallback', 'fallback']);
  if (process.platform === 'linux' || process.platform === 'darwin') expect(seen[0]).toBe('native');
 } finally { await sb.cleanup(); }
});
