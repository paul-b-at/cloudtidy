import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import defaults from "../config/default.config.json";

const BucketSchema = z.object({
  dir: z.string().min(1),
  description: z.string(),
  subfolders: z.array(z.string().min(1)),
});

export const ConfigSchema = z
  .object({
    root: z.string().min(1),
    inbox: z.string().min(1),
    needsReview: z.string().min(1),
    duplicates: z.string().min(1),
    buckets: z.record(z.string(), BucketSchema),
    standardizedNames: z.record(z.string(), z.string()),
    blocklist: z.array(z.string()),
    courseNumbers: z.array(z.string()),
    knownSenders: z.array(z.string()),
    heuristics: z.object({
      minScore: z.number().positive(),
      minMargin: z.number().nonnegative(),
    }),
    llm: z.object({
      enabled: z.boolean(),
      endpoint: z.url(),
      model: z.string().min(1),
      keepAlive: z.string(),
      maxChars: z.number().int().positive(),
      confidenceThreshold: z.number().min(0).max(1),
      coldTimeoutMs: z.number().int().positive(),
      warmTimeoutMs: z.number().int().positive(),
    }),
    stability: z.object({
      intervalMs: z.number().int().nonnegative(),
      maxWaitMs: z.number().int().nonnegative(),
    }),
    lockTimeoutMs: z.number().int().nonnegative(),
    notifications: z.boolean(),
    ocrHelper: z.string(),
    historyFile: z.string(),
    lockFile: z.string(),
    logFile: z.string(),
  })
  .superRefine((config, ctx) => {
    const dirs = Object.values(config.buckets).map((b) => b.dir.normalize("NFC"));
    if (Object.keys(config.buckets).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["buckets"],
        message: "at least one bucket is required",
      });
    }
    if (new Set(dirs).size !== dirs.length) {
      ctx.addIssue({ code: "custom", path: ["buckets"], message: "bucket dirs must be unique" });
    }
    if (dirs.includes(config.inbox.normalize("NFC"))) {
      ctx.addIssue({ code: "custom", path: ["inbox"], message: "inbox cannot also be a bucket" });
    }
    for (const dir of [config.inbox, ...dirs]) {
      if (dir.includes("/") || dir === "." || dir === "..") {
        ctx.addIssue({ code: "custom", message: `"${dir}" must be a single folder name` });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Bucket = z.infer<typeof BucketSchema>;

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function defaultConfigPath(): string {
  return (
    process.env.CLOUDTIDY_CONFIG ?? path.join(homedir(), ".config", "cloudtidy", "config.json")
  );
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

export function parseConfig(override: Json = {}): Config {
  return ConfigSchema.parse(deepMerge(defaults as Json, override));
}

/** Loads defaults, then the user's config file on top. A missing default-path file is fine; a missing explicit file is not. */
export async function loadConfig(explicitPath?: string): Promise<Config> {
  const file = explicitPath ?? defaultConfigPath();
  let override: Json = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(expandHome(file), "utf8"));
    if (!isPlainObject(parsed)) throw new Error(`${file}: config must be a JSON object`);
    override = parsed;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing || explicitPath) throw error;
  }
  return parseConfig(override);
}
