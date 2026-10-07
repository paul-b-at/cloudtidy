import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type Guard = (target: string) => void;

export interface MoveResult {
  status: "moved" | "duplicate";
  to: string;
  sha256: string;
}

export class LockTimeoutError extends Error {
  constructor(lockFile: string) {
    super(`Timed out waiting for lock ${lockFile}`);
    this.name = "LockTimeoutError";
  }
}

export async function sha256File(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** `Rechnung.pdf`, 2 -> `Rechnung (2).pdf` */
export function withCounter(name: string, n: number): string {
  if (n <= 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

async function renameOrCopy(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(src, dest, constants.COPYFILE_EXCL);
    await unlink(src);
  }
}

/** Moves `src` to the first free `dir/name`, `dir/name (2)`, … */
export async function moveToFreeName(
  src: string,
  dir: string,
  name: string,
  guard: Guard,
): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, withCounter(name, n));
    guard(candidate);
    if (await exists(candidate)) continue;
    await mkdir(dir, { recursive: true });
    await renameOrCopy(src, candidate);
    return candidate;
  }
}

/**
 * Moves `src` to `destDir/name` and never overwrites. Name collisions get a
 * ` (n)` counter; a byte-identical existing file makes `src` a duplicate, which
 * is parked in `duplicatesDir` rather than deleted.
 */
export async function moveNoClobber(
  src: string,
  destDir: string,
  name: string,
  duplicatesDir: string,
  guard: Guard,
): Promise<MoveResult> {
  const hash = await sha256File(src);
  const size = (await stat(src)).size;

  for (let n = 1; ; n++) {
    const candidate = path.join(destDir, withCounter(name, n));
    guard(candidate);
    if (!(await exists(candidate))) {
      await mkdir(destDir, { recursive: true });
      await renameOrCopy(src, candidate);
      return { status: "moved", to: candidate, sha256: hash };
    }
    const existing = await stat(candidate);
    if (existing.isFile() && existing.size === size && (await sha256File(candidate)) === hash) {
      const to = await moveToFreeName(src, duplicatesDir, path.basename(src), guard);
      return { status: "duplicate", to, sha256: hash };
    }
  }
}

async function lockIsStale(lockFile: string): Promise<boolean> {
  let content: string;
  let ageMs: number;
  try {
    content = await readFile(lockFile, "utf8");
    ageMs = Date.now() - (await stat(lockFile)).mtimeMs;
  } catch {
    return false;
  }
  const pid = Number.parseInt(content, 10);
  // The owner may have created the file but not written its pid yet.
  if (!Number.isInteger(pid) || pid <= 0) return ageMs > 5000;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Waits for the lock instead of giving up, so a launchd trigger is never dropped while another run is active. */
export async function withLock<T>(
  lockFile: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockIsStale(lockFile)) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockFile);
      await Bun.sleep(250);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}
