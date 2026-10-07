import { existsSync } from "node:fs";

/** Runs the compiled Vision helper (helpers/ocr.swift). Returns null when it is not installed or fails. */
export async function ocrText(file: string, helperPath: string): Promise<string | null> {
  if (!existsSync(helperPath)) return null;
  const proc = Bun.spawn([helperPath, file], { stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? text : null;
}
