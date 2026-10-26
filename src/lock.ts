import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Lock { file: string; token: string; release(): Promise<void> }
export interface LockOptions { waitMs: number; maxAgeMs?: number; pollMs?: number; isAlive?: (pid: number) => boolean }
export const pidAlive = (pid: number): boolean => {
 try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
interface Content { pid: number; token: string; startedAt: string }
async function readLock(file: string): Promise<{ raw: string; content: Content | null; ageMs: number } | null> {
 try {
  const [raw, s] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  let content: Content | null = null;
  try { const j = JSON.parse(raw); if (Number.isInteger(j?.pid) && typeof j.token === 'string') content = j; } catch { /* created but not yet written, or torn */ }
  return { raw, content, ageMs: Date.now() - s.mtimeMs };
 } catch { return null; }
}
/** Stale = owner PID is gone, the lock is absurdly old (PID reuse), or an unparsable lock outlived a crashed writer. */
export async function lockIsStale(file: string, opts: Pick<LockOptions, 'maxAgeMs' | 'isAlive'> = {}): Promise<boolean> {
 const l = await readLock(file);
 if (!l) return false;
 if (!l.content) return l.ageMs > 10000;
 if (l.ageMs > (opts.maxAgeMs ?? 6 * 3600 * 1000)) return true;
 return l.content.pid !== process.pid && !(opts.isAlive ?? pidAlive)(l.content.pid);
}
/**
 * Per-process exclusive lock file (`wx`), with stale-PID takeover. Returns null when another live cloudtidy holds it for longer than `waitMs`.
 * Residual risk: two processes that simultaneously detect the same stale lock can race on its removal; the post-acquire token
 * re-check narrows but cannot fully close that window. Moves are additionally protected by the exclusive rename.
 */
export async function acquireLock(file: string, opts: LockOptions): Promise<Lock | null> {
 await mkdir(dirname(file), { recursive: true, mode: 0o700 });
 const deadline = Date.now() + opts.waitMs, token = randomBytes(8).toString('hex');
 for (;;) {
  try {
   const h = await open(file, 'wx', 0o600);
   await h.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() } satisfies Content));
   await h.close();
   if ((await readLock(file))?.content?.token === token) return { file, token, release: async () => { if ((await readLock(file))?.content?.token === token) await unlink(file).catch(() => {}); } };
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const seen = await readLock(file);
  if (seen && await lockIsStale(file, opts)) { if ((await readLock(file))?.raw === seen.raw) await unlink(file).catch(() => {}); continue; }
  if (Date.now() >= deadline) return null;
  await Bun.sleep(opts.pollMs ?? 200);
 }
}
