export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SortedItem {
  name: string;
  folder: string;
}

export function summarize(sorted: SortedItem[], reviewCount: number): string | null {
  const parts: string[] = [];
  const [first] = sorted;
  if (sorted.length === 1 && first) {
    parts.push(`Sorted ${first.name} into ${first.folder}`);
  } else if (sorted.length > 1) {
    const folders = [...new Set(sorted.map((s) => s.folder))];
    parts.push(`Sorted ${sorted.length} files into ${folders.join(", ")}`);
  }
  if (reviewCount > 0) {
    parts.push(`${reviewCount} ${reviewCount === 1 ? "file needs" : "files need"} review`);
  }
  return parts.length > 0 ? parts.join(". ") : null;
}

export async function notify(message: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const script = `display notification ${appleScriptString(message)} with title "cloudtidy"`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}
