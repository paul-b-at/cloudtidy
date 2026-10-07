import { realpathSync } from "node:fs";
import path from "node:path";
import { type Config, expandHome } from "./config";

export const nfc = (p: string): string => p.normalize("NFC");

export interface Layout {
  root: string;
  inbox: string;
  needsReview: string;
  duplicates: string;
  bucketDirs: Record<string, string>;
}

export class UnsafePathError extends Error {
  constructor(target: string, reason: string) {
    super(`Refusing to write ${target}: ${reason}`);
    this.name = "UnsafePathError";
  }
}

export function resolveLayout(config: Config): Layout {
  const root = nfc(path.resolve(expandHome(config.root)));
  const inbox = path.join(root, nfc(config.inbox));
  const needsReview = path.join(inbox, nfc(config.needsReview));
  const bucketDirs: Record<string, string> = {};
  for (const [id, bucket] of Object.entries(config.buckets)) {
    bucketDirs[id] = path.join(root, nfc(bucket.dir));
  }
  return {
    root,
    inbox,
    needsReview,
    duplicates: path.join(needsReview, nfc(config.duplicates)),
    bucketDirs,
  };
}

/** realpath that tolerates a not-yet-existing tail: resolves the nearest existing ancestor and re-appends the rest. */
function realpathLenient(p: string): string {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      return nfc(path.join(realpathSync(current), ...tail));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return nfc(p);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The only gate for writes. A target is allowed only inside a configured bucket
 * (below its top folder) or inside _Inbox/Needs_Review, and never inside an app
 * container or blocklisted folder, even if reached through a symlink.
 */
export function assertWritable(target: string, layout: Layout, config: Config): string {
  const root = realpathLenient(layout.root);
  const resolved = realpathLenient(nfc(path.resolve(target)));
  const rel = path.relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new UnsafePathError(target, "outside the iCloud Drive root");
  }

  const segments = rel.split(path.sep);
  const blocked = new Set(config.blocklist.map((name) => nfc(name).toLowerCase()));
  for (const segment of segments) {
    if (segment.startsWith("com~apple~") || blocked.has(segment.toLowerCase())) {
      throw new UnsafePathError(target, `"${segment}" is a protected app container`);
    }
  }

  const [top, second] = segments;
  const bucketTops = new Set(Object.values(config.buckets).map((b) => nfc(b.dir)));
  if (top !== undefined && bucketTops.has(top) && segments.length >= 2) return resolved;
  if (top === nfc(config.inbox) && second === nfc(config.needsReview) && segments.length >= 3) {
    return resolved;
  }
  throw new UnsafePathError(target, "not inside a configured bucket or Needs_Review");
}
