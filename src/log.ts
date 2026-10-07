import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: Level, msg: string, data?: Record<string, unknown>): Promise<void>;
}

export function createLogger(file: string | null, echo: boolean): Logger {
  let dirReady = false;
  return {
    async log(level, msg, data) {
      if (echo && level !== "debug") console.error(`[${level}] ${msg}`);
      if (!file) return;
      if (!dirReady) {
        await mkdir(path.dirname(file), { recursive: true });
        dirReady = true;
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
      await appendFile(file, `${line}\n`, "utf8");
    },
  };
}

export const silentLogger: Logger = { log: async () => {} };
