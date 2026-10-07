import { readdir } from "node:fs/promises";
import path from "node:path";

const PARTIAL_SUFFIXES = [".download", ".crdownload", ".part", ".partial", ".tmp"];

export interface ScanResult {
  files: string[];
  /** iCloud placeholders (`.name.ext.icloud`) whose content has not been downloaded yet. */
  stubs: string[];
}

/** Lists direct children of the inbox only; subfolders such as Needs_Review are never scanned. */
export async function scanInbox(inbox: string): Promise<ScanResult> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(inbox, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], stubs: [] };
    throw error;
  }

  const files: string[] = [];
  const stubs: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".")) {
      if (name.endsWith(".icloud") && entry.isFile()) stubs.push(path.join(inbox, name));
      continue;
    }
    if (!entry.isFile()) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith("icon\r") || PARTIAL_SUFFIXES.some((s) => lower.endsWith(s))) continue;
    files.push(path.join(inbox, name));
  }
  return { files: files.sort(), stubs: stubs.sort() };
}
