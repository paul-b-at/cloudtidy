import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRules } from "../src/classify/heuristics";
import type { LlmInput } from "../src/classify/llm";
import { type Config, parseConfig } from "../src/config";
import { silentLogger } from "../src/log";
import { type Layout, resolveLayout } from "../src/paths";
import type { PipelineContext } from "../src/pipeline";

export interface Sandbox {
  dir: string;
  config: Config;
  layout: Layout;
  cleanup(): Promise<void>;
}

export async function makeSandbox(override: Record<string, unknown> = {}): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(tmpdir(), "cloudtidy-test-"));
  const root = path.join(dir, "iCloud");
  const config = parseConfig({
    root,
    ocrHelper: path.join(dir, "no-ocr-helper"),
    historyFile: path.join(dir, "state", "history.jsonl"),
    lockFile: path.join(dir, "state", "cloudtidy.lock"),
    logFile: path.join(dir, "state", "cloudtidy.log"),
    stability: { intervalMs: 5, maxWaitMs: 200 },
    lockTimeoutMs: 2000,
    ...override,
  });
  const layout = resolveLayout(config);
  await mkdir(layout.inbox, { recursive: true });
  return { dir, config, layout, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function pipelineContext(
  sandbox: Sandbox,
  extra: Partial<PipelineContext> = {},
): PipelineContext {
  return {
    config: sandbox.config,
    layout: sandbox.layout,
    rules: buildRules(sandbox.config),
    tier2: null,
    logger: silentLogger,
    historyFile: sandbox.config.historyFile,
    ocrHelper: sandbox.config.ocrHelper,
    notifier: async () => {},
    ...extra,
  };
}

export async function put(file: string, content: string | Uint8Array): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** A minimal one-page PDF with a real text layer (Helvetica, WinAnsi, so umlauts work). */
export function makePdf(lines: string[]): Uint8Array {
  const pdfEscape = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = [
    "BT",
    "/F1 12 Tf",
    "72 760 Td",
    "16 TL",
    ...lines.map((l) => `(${pdfEscape(l)}) '`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // latin1: one byte per character, so the xref offsets above are byte offsets.
  return Uint8Array.from(body, (ch) => ch.charCodeAt(0));
}

export type FakeAnswer = {
  category: string;
  subcategory: string;
  suggestedName: string;
  confidence: number;
};

/** A stand-in for Ollama's /api/chat that answers via `respond` and records requests. */
export function fakeOllama(respond: (input: LlmInput) => FakeAnswer | Response) {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      requests.push(body);
      const user = body.messages.find((m) => m.role === "user")?.content ?? "";
      const filename = /^Filename: (.*)$/m.exec(user)?.[1] ?? "";
      const text = user.split("Content (truncated):\n")[1] ?? "";
      const answer = respond({ filename, text });
      if (answer instanceof Response) return answer;
      return Response.json({ message: { role: "assistant", content: JSON.stringify(answer) } });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}
