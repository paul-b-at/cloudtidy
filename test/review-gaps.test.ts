// Guard tests from the safety review (test-gaps): behaviour the first suite did not pin down (found by mutation testing). Removing any of these guards must fail loudly.
import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, readdir, utimes, stat, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const CLI = resolve(import.meta.dir, '../src/cli.ts');
import { sandbox, baseJson, inboxFiles } from './helpers';
import { validateConfig } from '../src/config';
import { moveNoClobber } from '../src/mover';
import { exclusiveRenameSupported, fingerprint, sha256File } from '../src/fsx';
import { resolveLayout } from '../src/paths';
import { appendHistory, undoMoves, newRunId, type MoveRecord } from '../src/history';
import { stateFiles } from '../src/state';

type SB = Awaited<ReturnType<typeof sandbox>>;
async function prepared(sb: SB, name = 'a.txt', body = 'hello', dir = sb.inbox) {
 const layout = await resolveLayout(sb.config), src = join(dir, name);
 await writeFile(src, body);
 return { layout, src, snapshot: (await fingerprint(src))!, sha256: await sha256File(src) };
}
const req = (sb: SB, p: Awaited<ReturnType<typeof prepared>>, destDir: string, name = 'a.txt', extra = {}) => ({ layout: p.layout, config: sb.config, kind: 'inbox' as const, src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir, name, ...extra });

test('gap: daemon.apply defaults to false when the key (or the whole daemon block) is absent', () => {
 const { daemon: _d, ...noDaemon } = baseJson;
 expect(validateConfig(noDaemon).daemon.apply).toBe(false);
 expect(validateConfig({ ...baseJson, daemon: { notify: true } }).daemon.apply).toBe(false);
 expect(() => validateConfig({ ...baseJson, daemon: { apply: 'true' } })).toThrow();
 expect(() => validateConfig({ ...baseJson, daemon: { apply: 1 } })).toThrow();
});

test('gap: native exclusive rename is actually loaded on linux/darwin (otherwise every "no-clobber" test silently runs the fallback)', () => {
 if (process.platform === 'linux' || process.platform === 'darwin') expect(exclusiveRenameSupported()).toBe(true);
});

test('gap: sweep --apply from a non-TTY session without --yes moves nothing (CLI level)', async () => {
 const sb = await sandbox(); try {
  const cfg = join(sb.dir, 'cfg.json');
  await writeFile(cfg, JSON.stringify({ ...baseJson, allowNonICloudRoot: true, root: sb.root, stateDir: sb.state, logDir: sb.config.logDir, classifier: sb.config.classifier, ocr: sb.config.ocr, debounceMs: 0, stabilityRetries: 0 }));
  await writeFile(join(sb.root, 'loose.txt'), 'VO 123.456 exercise');
  for (const stdin of ['pipe', 'ignore'] as const) {
   const p = Bun.spawn([process.execPath, CLI, 'sweep', '--apply', '--config', cfg], { stdin, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLOUDTIDY_QUIET: '1' } });
   if (stdin === 'pipe') { p.stdin!.write('yes\n'); p.stdin!.end(); } // even a piped "yes" must not count as interactive confirmation
   const out = await new Response(p.stdout).text(); await p.exited;
   expect(out).toContain('Refusing to move files without confirmation');
   expect(await readFile(join(sb.root, 'loose.txt'), 'utf8')).toBe('VO 123.456 exercise');
   expect(await readdir(join(sb.root, '01_Uni'))).toEqual([]);
  }
 } finally { await sb.cleanup(); }
});

test('gap: same-size, same-mtime, same-inode content change after classification is caught by the sha256 re-check', async () => {
 const sb = await sandbox(); try {
  const p0 = await prepared(sb, 'a.txt', 'hello');
  await utimes(p0.src, 1_700_000_000, 1_700_000_000); // whole-second mtime: restoring it later is exact (no float rounding flakiness)
  const p = { ...p0, snapshot: (await fingerprint(p0.src))! };
  await writeFile(p.src, 'HELLO'); await utimes(p.src, 1_700_000_000, 1_700_000_000); // in-place edit + mtime restored
  expect(await fingerprint(p.src)).toEqual(p.snapshot); // fingerprint cannot see it
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toEqual({ kind: 'refused', reason: 'source_changed' });
  expect(await inboxFiles(sb)).toEqual(['a.txt']);
 } finally { await sb.cleanup(); }
});

test('gap: same-size but different-content file at the destination is NOT a duplicate; the move is suffixed', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.root, '01_Uni', 'a.txt'), 'world');
  const p = await prepared(sb, 'a.txt', 'hello');
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toMatchObject({ kind: 'moved', to: join(sb.root, '01_Uni', 'a (2).txt') });
  expect(await readFile(join(sb.root, '01_Uni', 'a.txt'), 'utf8')).toBe('world');
 } finally { await sb.cleanup(); }
});

test('gap: sources below _Inbox (e.g. in Needs_Review) are refused by the mover', async () => {
 const sb = await sandbox(); try {
  await mkdir(sb.review, { recursive: true });
  const p = await prepared(sb, 'a.txt', 'hello', sb.review);
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toEqual({ kind: 'refused', reason: 'source_unsafe' });
  expect(await readFile(p.src, 'utf8')).toBe('hello');
 } finally { await sb.cleanup(); }
});

function rec(over: Partial<MoveRecord>): MoveRecord { return { v: 1, type: 'move', id: 'x', runId: 'run-x', time: new Date().toISOString(), mode: 'run', source: '', destination: '', sha256: '', size: 0, route: null, tier: 'none', outcome: 'moved', reason: '', renamed: false, ...over }; }
test('gap: tampered history - valid original path but destination OUTSIDE the root is refused (cannot pull arbitrary files into iCloud)', async () => {
 const sb = await sandbox(); try {
  const victim = join(sb.dir, 'victim.txt'); await writeFile(victim, 'victim');
  const layout = await resolveLayout(sb.config), f = stateFiles(sb.config).history;
  await appendHistory(f, rec({ id: 'evil1', runId: 'evil1', source: join(sb.inbox, 'pulled.txt'), destination: victim, sha256: await sha256File(victim) }));
  const r = await undoMoves(sb.config, layout, f, { runId: 'evil1' }, { apply: true, undoRunId: newRunId() });
  expect(r.map(i => i.status)).toEqual(['skipped_unsafe']);
  expect(await readFile(victim, 'utf8')).toBe('victim'); expect(await inboxFiles(sb)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('gap: tampered history - valid destination but original path in an unexpected place (Needs_Review / nested bucket) is refused', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); const d = join(sb.root, '01_Uni', 'a.txt'); await writeFile(d, 'hello');
  const layout = await resolveLayout(sb.config), f = stateFiles(sb.config).history, sha = await sha256File(d);
  for (const [i, source] of [join(sb.root, '_Inbox', 'Needs_Review', 'a.txt'), join(sb.root, '02_Admin & Finanzen', 'a.txt'), join(sb.root, '01_Uni', 'sub', 'a.txt')].entries())
   await appendHistory(f, rec({ id: `e${i}`, runId: `e${i}`, source, destination: d, sha256: sha }));
  for (const i of [0, 1, 2]) expect((await undoMoves(sb.config, layout, f, { runId: `e${i}` }, { apply: true, undoRunId: newRunId() })).map(x => x.status)).toEqual(['skipped_unsafe']);
  expect(await readFile(d, 'utf8')).toBe('hello');
 } finally { await sb.cleanup(); }
});
