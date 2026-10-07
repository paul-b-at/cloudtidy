#!/usr/bin/env bun
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRules } from "./classify/heuristics";
import { OllamaTier2 } from "./classify/llm";
import { type Config, expandHome, loadConfig } from "./config";
import { runDoctor } from "./doctor";
import { undoMoves } from "./history";
import { install, programArguments, renderPlist, uninstall } from "./install";
import { createLogger } from "./log";
import { withLock } from "./mover";
import { assertWritable, type Layout, resolveLayout } from "./paths";
import { processInbox, type Row } from "./pipeline";

const HELP = `cloudtidy - sorts iCloud Drive/_Inbox into your folder structure

Usage:
  cloudtidy run [--dry-run]     process _Inbox once (this is what launchd calls)
  cloudtidy scan                same as run --dry-run: show what would happen
  cloudtidy undo [--last N | --id ID]
                                move recent sorts into _Inbox/Needs_Review
  cloudtidy install [--print]   build the OCR helper and load the LaunchAgent
  cloudtidy uninstall           unload and remove the LaunchAgent
  cloudtidy doctor              check dependencies and permissions

Options:
  --config PATH   config file (default ~/.config/cloudtidy/config.json or $CLOUDTIDY_CONFIG)
  --no-llm        never call the local LLM; ambiguous files go to Needs_Review
`;

const STATUS_LABEL: Record<Row["status"], [dry: string, live: string]> = {
  moved: ["would sort", "sorted"],
  review: ["would review", "review"],
  duplicate: ["duplicate", "duplicate"],
  pending: ["pending", "pending"],
  error: ["error", "error"],
};

function printRows(rows: Row[], layout: Layout, dryRun: boolean): void {
  if (rows.length === 0) {
    console.log("Inbox is empty.");
    return;
  }
  const rel = (p: string | null) => (p ? path.relative(layout.root, p) : "-");
  for (const row of rows) {
    const label = STATUS_LABEL[row.status][dryRun ? 0 : 1].padEnd(12);
    console.log(`${label} ${rel(row.source)} -> ${rel(row.target)}\n             ${row.reason}`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-llm": { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      last: { type: "string" },
      id: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    console.log(HELP);
    return 0;
  }

  const config: Config = await loadConfig(values.config);
  if (values["no-llm"]) config.llm.enabled = false;
  const layout = resolveLayout(config);
  const guard = (target: string) => {
    assertWritable(target, layout, config);
  };

  switch (command) {
    case "run":
    case "scan": {
      const dryRun = command === "scan" || values["dry-run"];
      const ctx = {
        config,
        layout,
        rules: buildRules(config),
        tier2: config.llm.enabled ? new OllamaTier2(config.llm, config.buckets) : null,
        logger: createLogger(
          dryRun ? null : expandHome(config.logFile),
          Boolean(process.stderr.isTTY),
        ),
        historyFile: expandHome(config.historyFile),
        ocrHelper: expandHome(config.ocrHelper),
      };
      const rows = dryRun
        ? await processInbox(ctx, { dryRun })
        : await withLock(expandHome(config.lockFile), config.lockTimeoutMs, () =>
            processInbox(ctx, { dryRun }),
          );
      if (dryRun || process.stdout.isTTY) printRows(rows, layout, dryRun);
      return rows.some((r) => r.status === "error") ? 1 : 0;
    }
    case "undo": {
      const last = values.last ? Number.parseInt(values.last, 10) : undefined;
      if (last !== undefined && (!Number.isInteger(last) || last < 1))
        throw new Error("--last must be a positive number");
      const outcomes = await withLock(expandHome(config.lockFile), config.lockTimeoutMs, () =>
        undoMoves(
          expandHome(config.historyFile),
          { last, id: values.id },
          layout.needsReview,
          guard,
        ),
      );
      if (outcomes.length === 0) console.log("Nothing to undo.");
      for (const o of outcomes) {
        const detail =
          o.status === "restored"
            ? `-> ${path.relative(layout.root, o.to ?? "")}`
            : "(skipped: file moved or changed since)";
        console.log(`${o.status.padEnd(9)} ${path.relative(layout.root, o.from)} ${detail}`);
      }
      return outcomes.some((o) => o.status !== "restored") ? 1 : 0;
    }
    case "install": {
      if (values.print) {
        console.log(renderPlist(programArguments(values.config), layout, config));
        return 0;
      }
      for (const note of await install(config, layout, values.config)) console.log(note);
      return 0;
    }
    case "uninstall": {
      for (const note of await uninstall()) console.log(note);
      return 0;
    }
    case "doctor": {
      const checks = await runDoctor(config, layout);
      for (const c of checks)
        console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(14)} ${c.detail}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`cloudtidy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
