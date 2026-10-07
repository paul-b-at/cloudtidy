import { stat } from "node:fs/promises";
import path from "node:path";

export interface StabilityOptions {
  intervalMs: number;
  maxWaitMs: number;
}

export interface StabilityResult {
  ready: string[];
  /** Still changing (or empty) when the wait ran out; left for the next run. */
  pending: string[];
}

/** undefined = file vanished, null = exists but empty (iCloud often creates the file before writing it). */
async function fingerprint(file: string): Promise<string | null | undefined> {
  try {
    const s = await stat(file);
    if (!s.isFile()) return undefined;
    return s.size === 0 ? null : `${s.size}:${s.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * launchd WatchPaths does not fire again while a file inside the inbox is still
 * being written, so unstable files are polled here instead of waiting for a trigger.
 */
export async function waitForStable(
  files: string[],
  options: StabilityOptions,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<StabilityResult> {
  const deadline = Date.now() + options.maxWaitMs;
  const previous = new Map<string, string | null>();
  let pending: string[] = [];
  for (const file of files) {
    const fp = await fingerprint(file);
    if (fp === undefined) continue;
    previous.set(file, fp);
    pending.push(file);
  }

  const ready: string[] = [];
  while (pending.length > 0) {
    await sleep(options.intervalMs);
    const next: string[] = [];
    for (const file of pending) {
      const fp = await fingerprint(file);
      if (fp === undefined) continue;
      if (fp !== null && fp === previous.get(file)) {
        ready.push(file);
      } else {
        previous.set(file, fp);
        next.push(file);
      }
    }
    pending = next;
    if (Date.now() >= deadline) break;
  }
  return { ready, pending };
}

/** `.Rechnung.pdf.icloud` -> `Rechnung.pdf` in the same folder. */
export function stubTarget(stub: string): string {
  const name = path.basename(stub);
  return path.join(path.dirname(stub), name.slice(1, -".icloud".length));
}

/** Asks iCloud to download a placeholder. Its arrival changes the inbox, which retriggers launchd. */
export async function requestDownload(stub: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const proc = Bun.spawn(["brctl", "download", stubTarget(stub)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}
