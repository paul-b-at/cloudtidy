import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import ocrSource from "../helpers/ocr.swift" with { type: "text" };
import plistTemplate from "../launchd/at.paul.cloudtidy.plist.tmpl" with { type: "text" };
import { type Config, expandHome } from "./config";
import type { Layout } from "./paths";

export const LABEL = "at.paul.cloudtidy";
export const plistPath = (): string =>
  path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Compiled binaries run from Bun's virtual filesystem; `bun src/cli.ts` needs the script path too. */
export function programArguments(configPath?: string): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
  const base = compiled ? [process.execPath] : [process.execPath, path.resolve(Bun.main)];
  return [
    ...base,
    "run",
    ...(configPath ? ["--config", path.resolve(expandHome(configPath))] : []),
  ];
}

export function renderPlist(args: string[], layout: Layout, config: Config): string {
  const logDir = path.dirname(expandHome(config.logFile));
  const values: Record<string, string> = {
    LABEL,
    PROGRAM_ARGUMENTS: args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n"),
    INBOX: xmlEscape(layout.inbox),
    STDOUT: xmlEscape(path.join(logDir, "launchd.out.log")),
    STDERR: xmlEscape(path.join(logDir, "launchd.err.log")),
  };
  return plistTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

async function run(cmd: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${out}${err}`.trim() };
}

export async function compileOcrHelper(
  helperPath: string,
): Promise<{ ok: boolean; message: string }> {
  if (!Bun.which("swiftc")) {
    return {
      ok: false,
      message: "swiftc not found; install the Xcode command line tools (xcode-select --install)",
    };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "cloudtidy-ocr-"));
  try {
    const source = path.join(dir, "ocr.swift");
    await writeFile(source, ocrSource);
    await mkdir(path.dirname(helperPath), { recursive: true });
    const result = await run(["swiftc", "-O", "-o", helperPath, source]);
    return result.code === 0
      ? { ok: true, message: `built ${helperPath}` }
      : { ok: false, message: `swiftc failed: ${result.output}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function install(
  config: Config,
  layout: Layout,
  configPath?: string,
): Promise<string[]> {
  if (process.platform !== "darwin") throw new Error("install only works on macOS");
  const notes: string[] = [];

  await mkdir(layout.needsReview, { recursive: true });
  await mkdir(path.dirname(expandHome(config.logFile)), { recursive: true });
  notes.push(`inbox ready: ${layout.inbox}`);

  const ocr = await compileOcrHelper(expandHome(config.ocrHelper));
  notes.push(ocr.ok ? ocr.message : `OCR helper not built: ${ocr.message}`);

  const file = plistPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderPlist(programArguments(configPath), layout, config));
  notes.push(`wrote ${file}`);

  const domain = `gui/${process.getuid?.() ?? ""}`;
  await run(["launchctl", "bootout", `${domain}/${LABEL}`]);
  const loaded = await run(["launchctl", "bootstrap", domain, file]);
  if (loaded.code !== 0) throw new Error(`launchctl bootstrap failed: ${loaded.output}`);
  notes.push(`loaded ${LABEL}; it now runs whenever ${layout.inbox} changes`);
  return notes;
}

export async function uninstall(): Promise<string[]> {
  if (process.platform !== "darwin") throw new Error("uninstall only works on macOS");
  await run(["launchctl", "bootout", `gui/${process.getuid?.() ?? ""}/${LABEL}`]);
  await rm(plistPath(), { force: true });
  return [`unloaded ${LABEL} and removed ${plistPath()}`];
}

export async function isLoaded(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return (await run(["launchctl", "print", `gui/${process.getuid?.() ?? ""}/${LABEL}`])).code === 0;
}
