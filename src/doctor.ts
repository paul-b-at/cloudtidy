import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { type Config, expandHome } from "./config";
import { hasPdftotext } from "./extract/pdf";
import { isLoaded, plistPath } from "./install";
import type { Layout } from "./paths";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkOllama(config: Config): Promise<Check> {
  const name = "LLM";
  if (!config.llm.enabled)
    return { name, ok: true, detail: "disabled in config; ambiguous files go to Needs_Review" };
  try {
    const res = await fetch(`${config.llm.endpoint.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json()) as { models?: { name: string }[] };
    const names = (body.models ?? []).map((m) => m.name);
    const wanted = config.llm.model;
    const pulled = names.some((n) => n === wanted || n === `${wanted}:latest`);
    return pulled
      ? { name, ok: true, detail: `${wanted} available at ${config.llm.endpoint}` }
      : { name, ok: false, detail: `model ${wanted} not pulled; run: ollama pull ${wanted}` };
  } catch {
    return {
      name,
      ok: false,
      detail: `Ollama not reachable at ${config.llm.endpoint}; start it with: ollama serve`,
    };
  }
}

export async function runDoctor(config: Config, layout: Layout): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({
    name: "platform",
    ok: process.platform === "darwin",
    detail:
      process.platform === "darwin"
        ? "macOS"
        : `${process.platform}: only dry runs are meaningful here`,
  });
  checks.push({
    name: "iCloud root",
    ok: existsSync(layout.root),
    detail: layout.root,
  });
  try {
    await readdir(layout.inbox);
    checks.push({ name: "inbox", ok: true, detail: layout.inbox });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail =
      code === "EPERM" || code === "EACCES"
        ? "permission denied; grant cloudtidy access in System Settings > Privacy & Security > Files and Folders (or Full Disk Access)"
        : `missing; run cloudtidy install or create ${layout.inbox}`;
    checks.push({ name: "inbox", ok: false, detail });
  }
  checks.push({
    name: "pdftotext",
    ok: hasPdftotext(),
    detail: hasPdftotext() ? "found" : "not found; brew install poppler (falls back to unpdf)",
  });
  const helper = expandHome(config.ocrHelper);
  checks.push({
    name: "OCR helper",
    ok: existsSync(helper),
    detail: existsSync(helper)
      ? helper
      : "not built; run cloudtidy install (images and scans will go to Needs_Review)",
  });
  checks.push(await checkOllama(config));
  const loaded = await isLoaded();
  checks.push({
    name: "launchd agent",
    ok: loaded,
    detail: loaded ? plistPath() : "not loaded; run cloudtidy install",
  });
  return checks;
}
