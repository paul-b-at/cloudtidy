import { stat } from "node:fs/promises";
import path from "node:path";
import { classify, type Decision } from "./classify";
import type { Rule } from "./classify/heuristics";
import type { Tier2 } from "./classify/llm";
import type { Config } from "./config";
import { extractText } from "./extract";
import { appendHistory } from "./history";
import type { Logger } from "./log";
import { moveNoClobber } from "./mover";
import { buildTargetName, sanitizeStem, splitName } from "./naming";
import { notify, type SortedItem, summarize } from "./notify";
import { assertWritable, type Layout } from "./paths";
import { scanInbox } from "./scanner";
import { requestDownload, waitForStable } from "./stability";

export interface PipelineContext {
  config: Config;
  layout: Layout;
  rules: Rule[];
  tier2: Tier2 | null;
  logger: Logger;
  historyFile: string;
  ocrHelper: string;
  notifier?: (message: string) => Promise<void>;
}

export type RowStatus = "moved" | "duplicate" | "review" | "pending" | "error";

export interface Row {
  source: string;
  target: string | null;
  status: RowStatus;
  reason: string;
}

interface Plan {
  decision: Decision;
  destDir: string;
  name: string;
}

async function planFile(ctx: PipelineContext, file: string): Promise<Plan> {
  const filename = path.basename(file);
  const extraction = await extractText(file, ctx.ocrHelper);
  const decision = await classify({ filename, text: extraction.text }, ctx);

  if (decision.kind === "review") {
    const { stem, ext } = splitName(filename);
    return { decision, destDir: ctx.layout.needsReview, name: `${sanitizeStem(stem)}${ext}` };
  }
  const bucketDir = ctx.layout.bucketDirs[decision.category];
  if (!bucketDir) throw new Error(`unknown bucket "${decision.category}"`);
  const mtime = (await stat(file)).mtime;
  const name = buildTargetName(
    {
      filename,
      text: extraction.text,
      sub: decision.sub,
      suggestedName: decision.suggestedName,
      mtime,
    },
    ctx.config,
  );
  return { decision, destDir: decision.sub ? path.join(bucketDir, decision.sub) : bucketDir, name };
}

/**
 * One pass over the inbox. launchd gives no file list, so every run rescans
 * everything and must be safe to repeat; files already moved are simply gone.
 */
export async function processInbox(
  ctx: PipelineContext,
  options: { dryRun: boolean },
): Promise<Row[]> {
  const { files, stubs } = await scanInbox(ctx.layout.inbox);
  const rows: Row[] = [];

  for (const stub of stubs) {
    if (options.dryRun) continue;
    const requested = await requestDownload(stub);
    await ctx.logger.log("info", `iCloud placeholder ${path.basename(stub)}`, { requested });
  }

  let ready = files;
  if (!options.dryRun && files.length > 0) {
    const stability = await waitForStable(files, ctx.config.stability);
    ready = stability.ready;
    for (const file of stability.pending) {
      rows.push({
        source: file,
        target: null,
        status: "pending",
        reason: "still changing; retry on next run",
      });
    }
  }

  const guard = (target: string) => {
    assertWritable(target, ctx.layout, ctx.config);
  };
  const sorted: SortedItem[] = [];
  let reviewCount = 0;

  for (const file of ready) {
    try {
      const plan = await planFile(ctx, file);
      const { decision } = plan;
      const planned = path.join(plan.destDir, plan.name);
      if (options.dryRun) {
        guard(planned);
        rows.push({
          source: file,
          target: planned,
          status: decision.kind === "review" ? "review" : "moved",
          reason: decision.reason,
        });
        continue;
      }

      const result = await moveNoClobber(
        file,
        plan.destDir,
        plan.name,
        ctx.layout.duplicates,
        guard,
      );
      const sortedDecision = decision.kind === "sorted" ? decision : null;
      await appendHistory(ctx.historyFile, {
        type: "move",
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        from: file,
        to: result.to,
        status: result.status,
        tier: decision.tier,
        category: sortedDecision?.category ?? null,
        sub: sortedDecision?.sub ?? null,
        confidence: sortedDecision?.confidence ?? null,
        sha256: result.sha256,
      });

      const status: RowStatus =
        result.status === "duplicate"
          ? "duplicate"
          : decision.kind === "review"
            ? "review"
            : "moved";
      const reason =
        result.status === "duplicate" ? "identical file already exists" : decision.reason;
      rows.push({ source: file, target: result.to, status, reason });
      await ctx.logger.log("info", `${status}: ${path.basename(file)} -> ${result.to}`, { reason });

      if (status === "moved") {
        sorted.push({
          name: path.basename(result.to),
          folder: path.relative(ctx.layout.root, path.dirname(result.to)),
        });
      } else {
        reviewCount++;
      }
    } catch (error) {
      const reason = (error as Error).message;
      rows.push({ source: file, target: null, status: "error", reason });
      await ctx.logger.log("error", `failed: ${path.basename(file)}`, { reason });
    }
  }

  if (!options.dryRun && ctx.config.notifications) {
    const message = summarize(sorted, reviewCount);
    if (message) await (ctx.notifier ?? notify)(message);
  }
  return rows;
}
