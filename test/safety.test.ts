import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, symlink, readdir, stat, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exclusiveRename } from '../src/fsx';
import { fingerprint, sha256File } from '../src/fsx';
import { moveNoClobber, withCounter } from '../src/mover';
import { assertDestDir, assertSource, resolveLayout, UnsafePathError } from '../src/paths';
import { listCandidates, waitForStable } from '../src/ingest';
import { acquireLock, lockIsStale } from '../src/lock';
import { sandbox, swapForSymlink, inboxFiles } from './helpers';

async function prepared(sb: Awaited<ReturnType<typeof sandbox>>, name = 'a.txt', body = 'hello') {
 const layout = await resolveLayout(sb.config);
 const src = join(sb.inbox, name);
 await writeFile(src, body);
 return { layout, src, snapshot: (await fingerprint(src))!, sha256: await sha256File(src) };
}
const req = (sb: Awaited<ReturnType<typeof sandbox>>, p: Awaited<ReturnType<typeof prepared>>, destDir: string, name = 'a.txt', extra = {}) => ({ layout: p.layout, config: sb.config, kind: 'inbox' as const, src: p.src, snapshot: p.snapshot, sha256: p.sha256, destDir, name, ...extra });

test('path traversal in destinations is refused', async () => {
 const sb = await sandbox(); try {
  const p = await prepared(sb);
  for (const dir of [join(sb.root, '01_Uni', '..', '..', 'escape'), join(sb.root, '..', 'escape'), '/tmp', join(sb.root, '01_Uni', '..'), sb.root, sb.inbox, join(sb.root, 'Unconfigured')])
   await expect(assertDestDir(p.layout, sb.config, dir)).rejects.toBeInstanceOf(UnsafePathError);
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni', '..', '..', 'x')))).toEqual({ kind: 'refused', reason: 'destination_unsafe' });
  expect(await readFile(p.src, 'utf8')).toBe('hello');
 } finally { await sb.cleanup(); }
});
test('_Archiv, app containers and ~ names are never writable (relative to the iCloud root)', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config);
  expect(layout.root).toContain('~'); // the root itself may contain ~, entries below it may not
  for (const rel of ['_Archiv/x', '_archiv', 'Pages/x', 'Keynote', 'Numbers/a', 'Obsidian', 'Goodnotes', 'Shortcuts', '01_Uni/Obsidian', '01_Uni/a~b', '01_Uni/_ARCHIV', '_Inbox/Pages', '01_Uni/com~apple~CloudDocs'])
   await expect(assertDestDir(layout, sb.config, join(layout.root, rel)), rel).rejects.toBeInstanceOf(UnsafePathError);
  await expect(assertDestDir(layout, sb.config, join(layout.root, '01_Uni', 'Semester 1')), 'missing sub-folders are never created').rejects.toMatchObject({ reason: 'folder_missing:01_Uni/Semester 1' });
  await mkdir(join(layout.root, '01_Uni', 'Semester 1'));
  await expect(assertDestDir(layout, sb.config, join(layout.root, '01_Uni', 'Semester 1'))).resolves.toBeString();
  expect(await readdir(join(layout.root, '01_Uni'))).toEqual(['Semester 1']);
  await expect(assertDestDir(layout, sb.config, layout.review)).resolves.toBeString();
  const extra = { ...sb.config, blocklist: ['Secrets'] };
  await expect(assertDestDir(layout, extra, join(layout.root, '01_Uni', 'secrets'))).rejects.toBeInstanceOf(UnsafePathError);
 } finally { await sb.cleanup(); }
});
test('blocklisted / ~ entries in the iCloud root are skipped as sweep sources', async () => {
 const sb = await sandbox(); try {
  for (const n of ['Pages', 'Keynote', 'notes~1.txt', 'ok.txt', '.hidden', 'x.icloud']) await writeFile(join(sb.root, n), 'x');
  await mkdir(join(sb.root, 'Numbers')); await mkdir(join(sb.root, '_Archiv'));
  const c = await listCandidates(await resolveLayout(sb.config), sb.config, 'root');
  expect(c.files.map(f => f.name)).toEqual(['ok.txt']);
  expect(c.skipped.map(s => `${s.name}:${s.reason}`).sort()).toEqual(['.hidden:dotfile', '01_Uni:directory', '02_Admin & Finanzen:directory', '03_Projekte & Dev:directory', '04_Persönlich:directory', 'Keynote:protected_name', 'Numbers:directory', 'Pages:protected_name', '_Archiv:directory', '_Inbox:directory', 'notes~1.txt:protected_name', 'x.icloud:icloud_placeholder'].sort());
 } finally { await sb.cleanup(); }
});
test('symlink source is refused (inbox scan skips it, mover refuses it)', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.dir, 'secret.txt'), 'secret');
  await symlink(join(sb.dir, 'secret.txt'), join(sb.inbox, 'link.txt'));
  const layout = await resolveLayout(sb.config);
  expect((await listCandidates(layout, sb.config, 'inbox')).skipped).toEqual([{ name: 'Needs_Review', reason: 'directory' }, { name: 'link.txt', reason: 'symlink' }]);
  await expect(assertSource(layout, sb.config, join(sb.inbox, 'link.txt'), 'inbox')).rejects.toBeInstanceOf(UnsafePathError);
  const p = await prepared(sb);
  await Bun.write(p.src, 'hello'); // keep real file
  const fake = { ...p, src: join(sb.inbox, 'link.txt') };
  expect(await moveNoClobber(req(sb, fake, join(sb.root, '01_Uni'), 'link.txt'))).toEqual({ kind: 'refused', reason: 'source_unsafe' });
  expect(await readFile(join(sb.dir, 'secret.txt'), 'utf8')).toBe('secret');
 } finally { await sb.cleanup(); }
});
test('symlinked _Inbox is rejected as a source parent', async () => {
 const sb = await sandbox(); try {
  const layout = await resolveLayout(sb.config);
  await mkdir(join(sb.dir, 'elsewhere'));
  await writeFile(join(sb.dir, 'elsewhere', 'f.txt'), 'x');
  const { rm, rename } = await import('node:fs/promises');
  await rm(sb.inbox, { recursive: true }); await symlink(join(sb.dir, 'elsewhere'), sb.inbox);
  await expect(assertSource(layout, sb.config, join(sb.inbox, 'f.txt'), 'inbox')).rejects.toBeInstanceOf(UnsafePathError);
  void rename;
 } finally { await sb.cleanup(); }
});
test('symlink in a destination component is refused (bucket and sub-folder)', async () => {
 const sb = await sandbox(); try {
  const outside = join(sb.dir, 'outside'); await mkdir(outside);
  await swapForSymlink(sb, '01_Uni', outside);
  await rm(join(sb.root, '02_Admin & Finanzen', 'Rechnungen'), { recursive: true }); await symlink(outside, join(sb.root, '02_Admin & Finanzen', 'Rechnungen'));
  const p = await prepared(sb);
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toEqual({ kind: 'refused', reason: 'destination_unsafe' });
  expect(await moveNoClobber(req(sb, p, join(sb.root, '02_Admin & Finanzen', 'Rechnungen')))).toEqual({ kind: 'refused', reason: 'destination_unsafe' });
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni', 'sub')))).toEqual({ kind: 'refused', reason: 'destination_unsafe' });
  expect(await readdir(outside)).toEqual([]);
  expect(await readFile(p.src, 'utf8')).toBe('hello');
 } finally { await sb.cleanup(); }
});
test('symlink as destination FILE is never followed or replaced', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.dir, 'target.txt'), 'orig');
  await symlink(join(sb.dir, 'target.txt'), join(sb.root, '01_Uni', 'a.txt'));
  const p = await prepared(sb);
  const r = await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')));
  expect(r).toMatchObject({ kind: 'refused', reason: 'destination_unsafe' });
  expect(await readFile(join(sb.dir, 'target.txt'), 'utf8')).toBe('orig');
 } finally { await sb.cleanup(); }
});
for (const forceFallback of [false, true]) test(`no-clobber collision gets a deterministic suffix (${forceFallback ? 'fallback' : 'exclusive rename'})`, async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.root, '01_Uni', 'a.txt'), 'existing'); await writeFile(join(sb.root, '01_Uni', 'a (2).txt'), 'existing2');
  const p = await prepared(sb);
  const r = await moveNoClobber(req(sb, p, join(sb.root, '01_Uni'), 'a.txt', { rename: { forceFallback } }));
  expect(r).toEqual({ kind: 'moved', to: join(sb.root, '01_Uni', 'a (3).txt'), suffixed: true });
  expect(await readFile(join(sb.root, '01_Uni', 'a.txt'), 'utf8')).toBe('existing');
  expect(await readFile(join(sb.root, '01_Uni', 'a (2).txt'), 'utf8')).toBe('existing2');
  expect(await readFile(join(sb.root, '01_Uni', 'a (3).txt'), 'utf8')).toBe('hello');
  expect(await inboxFiles(sb)).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('withCounter keeps the extension', () => { expect(withCounter('Rechnung.pdf', 1)).toBe('Rechnung.pdf'); expect(withCounter('Rechnung.pdf', 2)).toBe('Rechnung (2).pdf'); expect(withCounter('README', 3)).toBe('README (3)'); });
test('exclusiveRename never replaces an existing file', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.dir, 'a'), '1'); await writeFile(join(sb.dir, 'b'), '2');
  for (const forceFallback of [false, true]) {
   expect(await exclusiveRename(join(sb.dir, 'a'), join(sb.dir, 'b'), { forceFallback })).toBe('exists');
   expect(await exclusiveRename(join(sb.dir, 'nope'), join(sb.dir, 'c'), { forceFallback })).toBe('missing');
  }
  expect(await readFile(join(sb.dir, 'b'), 'utf8')).toBe('2');
  expect(await exclusiveRename(join(sb.dir, 'a'), join(sb.dir, 'c'))).toBe('ok');
 } finally { await sb.cleanup(); }
});
test('identical content at the destination is a duplicate (reported, nothing deleted or moved)', async () => {
 const sb = await sandbox(); try {
  await mkdir(join(sb.root, '01_Uni'), { recursive: true }); await writeFile(join(sb.root, '01_Uni', 'a.txt'), 'hello');
  const p = await prepared(sb);
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toEqual({ kind: 'duplicate', existing: join(sb.root, '01_Uni', 'a.txt') });
  expect(await readFile(p.src, 'utf8')).toBe('hello');
  expect(await readFile(join(sb.root, '01_Uni', 'a.txt'), 'utf8')).toBe('hello');
 } finally { await sb.cleanup(); }
});
test('EXDEV is refused, never copy+delete (simulated device mismatch)', async () => {
 const sb = await sandbox(); try {
  const p = await prepared(sb);
  const r = await moveNoClobber(req(sb, p, join(sb.root, '01_Uni'), 'a.txt', { deviceOf: async () => p.snapshot.dev + 1 }));
  expect(r).toEqual({ kind: 'refused', reason: 'exdev' });
  expect(await readFile(p.src, 'utf8')).toBe('hello');
  expect(await readdir(join(sb.root, '01_Uni'))).toEqual([]);
 } finally { await sb.cleanup(); }
});
test('exclusiveRename reports a real cross-device rename as exdev (when /dev/shm is a different device)', async () => {
 const shm = '/dev/shm', here = tmpdir();
 const ok = await stat(shm).then(a => stat(here).then(b => a.dev !== b.dev), () => false);
 if (!ok) return;
 const { mkdtemp, rm } = await import('node:fs/promises');
 const d = await mkdtemp(join(here, 'cloudtidy-x-')), e = await mkdtemp(join(shm, 'cloudtidy-x-'));
 try { await writeFile(join(d, 'a'), '1'); expect(await exclusiveRename(join(d, 'a'), join(e, 'a'))).toBe('exdev'); expect(await readFile(join(d, 'a'), 'utf8')).toBe('1'); }
 finally { await rm(d, { recursive: true, force: true }); await rm(e, { recursive: true, force: true }); }
});
test('pre-move revalidation: file changed after classification is not moved', async () => {
 const sb = await sandbox(); try {
  const p = await prepared(sb);
  await writeFile(p.src, 'hello!!'); // modified between classification and move
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toEqual({ kind: 'refused', reason: 'source_changed' });
  await writeFile(p.src, 'hello'); await utimes(p.src, 1, 1); // same bytes, different mtime
  expect(await moveNoClobber(req(sb, p, join(sb.root, '01_Uni')))).toEqual({ kind: 'refused', reason: 'source_changed' });
  const gone = { ...p, src: join(sb.inbox, 'gone.txt') };
  expect(await moveNoClobber(req(sb, gone, join(sb.root, '01_Uni'), 'gone.txt'))).toMatchObject({ kind: 'refused' });
 } finally { await sb.cleanup(); }
});
test('.icloud placeholders, dotfiles, partial downloads and folders are skipped', async () => {
 const sb = await sandbox(); try {
  for (const n of ['.Rechnung.pdf.icloud', '.DS_Store', 'movie.mp4.crdownload', 'x.part', 'real.txt']) await writeFile(join(sb.inbox, n), 'x');
  
  const c = await listCandidates(await resolveLayout(sb.config), sb.config, 'inbox');
  expect(c.files.map(f => f.name)).toEqual(['real.txt']);
  expect(c.skipped.find(s => s.name === '.Rechnung.pdf.icloud')?.reason).toBe('icloud_placeholder');
  expect(c.skipped.find(s => s.name === 'Needs_Review')?.reason).toBe('directory');
 } finally { await sb.cleanup(); }
});
test('unstable file (still growing) is skipped; stable file passes', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.inbox, 'growing.txt'), 'a'); await writeFile(join(sb.inbox, 'done.txt'), 'b'); await writeFile(join(sb.inbox, 'empty.txt'), '');
  const files = ['done.txt', 'empty.txt', 'growing.txt'].map(name => ({ name, path: join(sb.inbox, name) }));
  const sleep = async () => { const { appendFile } = await import('node:fs/promises'); await appendFile(join(sb.inbox, 'growing.txt'), 'more'); };
  const r = await waitForStable(files, { debounceMs: 5, stabilityRetries: 0 }, sleep);
  // Empty files are stable (they are handled by the empty-file grace logic in run.ts); only the growing file is unstable.
  expect(r.stable.map(s => s.name)).toEqual(['done.txt', 'empty.txt']);
  expect(r.unstable.map(s => s.name)).toEqual(['growing.txt']);
  // a file that stops changing becomes stable on a retry round
  let n = 0; const settle = async () => { if (n++ === 0) { const { appendFile } = await import('node:fs/promises'); await appendFile(join(sb.inbox, 'growing.txt'), 'x'); } };
  expect((await waitForStable([files[2]!], { debounceMs: 5, stabilityRetries: 2 }, settle)).stable.length).toBe(1);
 } finally { await sb.cleanup(); }
});
test('lock contention: second acquirer times out while the first holds it, then succeeds after release', async () => {
 const sb = await sandbox(); try {
  const file = join(sb.state, 'run.lock');
  const a = await acquireLock(file, { waitMs: 0 });
  expect(a).not.toBeNull();
  expect(await acquireLock(file, { waitMs: 60, pollMs: 10 })).toBeNull();
  await a!.release();
  const b = await acquireLock(file, { waitMs: 0 }); expect(b).not.toBeNull(); await b!.release();
 } finally { await sb.cleanup(); }
});
test('stale lock (dead PID) is taken over; live PID and young unparsable locks are respected', async () => {
 const sb = await sandbox(); try {
  const file = join(sb.state, 'run.lock'); await mkdir(sb.state, { recursive: true });
  await writeFile(file, JSON.stringify({ pid: 2 ** 22 + 1, token: 'dead', startedAt: new Date().toISOString() }));
  expect(await lockIsStale(file)).toBe(true);
  const l = await acquireLock(file, { waitMs: 0 }); expect(l).not.toBeNull(); expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(process.pid); await l!.release();
  await writeFile(file, JSON.stringify({ pid: process.ppid, token: 'live', startedAt: new Date().toISOString() }));
  expect(await lockIsStale(file)).toBe(false);
  expect(await acquireLock(file, { waitMs: 30, pollMs: 10 })).toBeNull();
  await writeFile(file, 'garbage'); expect(await lockIsStale(file)).toBe(false);
  await utimes(file, 1, 1); expect(await lockIsStale(file)).toBe(true);
  expect(await lockIsStale(file, { isAlive: () => true })).toBe(true);
 } finally { await sb.cleanup(); }
});
