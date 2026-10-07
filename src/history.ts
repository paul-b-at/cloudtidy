import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type Guard, moveToFreeName, sha256File } from "./mover";

export interface MoveRecord {
  type: "move";
  id: string;
  ts: string;
  from: string;
  to: string;
  status: "moved" | "duplicate";
  tier: 1 | 2 | null;
  category: string | null;
  sub: string | null;
  confidence: number | null;
  sha256: string;
}

export interface UndoRecord {
  type: "undo";
  id: string;
  ts: string;
  of: string;
  from: string;
  to: string;
}

export type HistoryRecord = MoveRecord | UndoRecord;

export async function appendHistory(file: string, record: HistoryRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readHistory(file: string): Promise<HistoryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: HistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as HistoryRecord);
    } catch {
      // A torn final line from a crash should not make the whole history unreadable.
    }
  }
  return records;
}

export interface UndoOutcome {
  id: string;
  status: "restored" | "missing" | "changed";
  from: string;
  to: string | null;
}

/**
 * Undone files go to Needs_Review, not back to the inbox: a file put back into
 * the inbox would immediately retrigger the daemon and be sorted again.
 */
export async function undoMoves(
  historyFile: string,
  selection: { last?: number; id?: string },
  restoreDir: string,
  guard: Guard,
): Promise<UndoOutcome[]> {
  const records = await readHistory(historyFile);
  const undone = new Set(records.filter((r) => r.type === "undo").map((r) => r.of));
  const moves = records
    .filter((r): r is MoveRecord => r.type === "move" && !undone.has(r.id))
    .reverse();
  const chosen = selection.id
    ? moves.filter((r) => r.id === selection.id)
    : moves.slice(0, selection.last ?? 1);

  const outcomes: UndoOutcome[] = [];
  for (const record of chosen) {
    const present = await stat(record.to).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!present) {
      outcomes.push({ id: record.id, status: "missing", from: record.to, to: null });
      continue;
    }
    if ((await sha256File(record.to)) !== record.sha256) {
      outcomes.push({ id: record.id, status: "changed", from: record.to, to: null });
      continue;
    }
    const to = await moveToFreeName(record.to, restoreDir, path.basename(record.from), guard);
    await appendHistory(historyFile, {
      type: "undo",
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      of: record.id,
      from: record.to,
      to,
    });
    outcomes.push({ id: record.id, status: "restored", from: record.to, to });
  }
  return outcomes;
}
