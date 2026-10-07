import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { OllamaTier2 } from "../src/classify/llm";
import { extractText } from "../src/extract";
import { ocrText } from "../src/extract/ocr";
import { pdfText } from "../src/extract/pdf";
import { readHistory, undoMoves } from "../src/history";
import { assertWritable } from "../src/paths";
import { processInbox } from "../src/pipeline";
import { fakeOllama, makePdf, makeSandbox, pipelineContext, put, type Sandbox } from "./helpers";

let sb: Sandbox;
let server: ReturnType<typeof fakeOllama>;

beforeEach(async () => {
  server = fakeOllama((input) =>
    input.text.includes("Laborwerte")
      ? {
          category: "04_Persönlich",
          subcategory: "Gesundheit",
          suggestedName: "Labor",
          confidence: 0.92,
        }
      : { category: "03_Projekte & Dev", subcategory: "", suggestedName: "x", confidence: 0.2 },
  );
  sb = await makeSandbox({
    llm: { endpoint: server.url, coldTimeoutMs: 2000, warmTimeoutMs: 2000 },
  });
});
afterEach(async () => {
  await server.stop();
  await sb.cleanup();
});

const ctx = (notifications: string[] = []) =>
  pipelineContext(sb, {
    tier2: new OllamaTier2(sb.config.llm, sb.config.buckets),
    notifier: async (m) => {
      notifications.push(m);
    },
  });

const inbox = (name: string) => path.join(sb.layout.inbox, name);
const rel = (p: string | null) => (p ? path.relative(sb.layout.root, p) : null);

describe("extractText", () => {
  test("reads the text layer of a generated PDF", async () => {
    const file = await put(inbox("r.pdf"), makePdf(["Rechnung Nr. 4711", "Größe: groß"]));
    const result = await extractText(file, sb.config.ocrHelper);
    expect(result.method).toBe("pdf-text");
    expect(result.text).toContain("Rechnung Nr. 4711");
    expect(result.text).toContain("Größe");
  });

  test("falls back to unpdf when pdftotext is not installed", async () => {
    const file = await put(inbox("k.pdf"), makePdf(["Kontoauszug Raiffeisen", "Größe"]));
    const originalPath = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath);
    try {
      expect(await pdfText(file)).toBe("Kontoauszug Raiffeisen\nGröße");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  // CI builds helpers/ocr.swift on macOS and points CLOUDTIDY_OCR_HELPER at it.
  const helper = process.env.CLOUDTIDY_OCR_HELPER;
  test.skipIf(!helper)("OCR helper reads a rendered PDF page", async () => {
    const file = await put(inbox("ocr.pdf"), makePdf(["RECHNUNG 4711", "Gesamtbetrag EUR 25,00"]));
    const text = await ocrText(file, helper ?? "");
    expect(text?.toUpperCase()).toContain("RECHNUNG");
  });
});

describe("processInbox", () => {
  test("sorts, renames, reviews and logs a mixed inbox", async () => {
    await put(
      inbox("scan_0001.pdf"),
      makePdf([
        "Hutchison Drei Austria GmbH",
        "Rechnung Nr. 99887766",
        "Rechnungsdatum: 12.10.2026",
        "Gesamtbetrag EUR 25,00   UID ATU12345678",
      ]),
    );
    await put(
      inbox("VO_ML_Exercise01.pdf"),
      makePdf(["Machine Learning Exercise 1", "Johannes Kepler Universität"]),
    );
    await put(inbox("notiz.txt"), "Laborwerte vom Hausarzt, alles im Normbereich.");
    await put(inbox("IMG_2041.heic"), "not really an image");
    await put(inbox(".Pending.pdf.icloud"), "stub");

    const notifications: string[] = [];
    const rows = await processInbox(ctx(notifications), { dryRun: false });
    const byName = Object.fromEntries(rows.map((r) => [path.basename(r.source), r]));

    expect(rel(byName["scan_0001.pdf"]?.target ?? null)).toBe(
      path.join("02_Admin & Finanzen", "Rechnungen", "2026-10-12_Drei-Rechnung.pdf"),
    );
    expect(rel(byName["VO_ML_Exercise01.pdf"]?.target ?? null)).toBe(
      path.join("01_Uni", "VO_ML_Exercise01.pdf"),
    );
    expect(byName["notiz.txt"]).toMatchObject({ status: "moved", reason: "LLM 0.92" });
    expect(rel(byName["notiz.txt"]?.target ?? null)).toBe(
      path.join("04_Persönlich", "Gesundheit", "notiz.txt"),
    );
    expect(byName["IMG_2041.heic"]).toMatchObject({ status: "review" });
    expect(rel(byName["IMG_2041.heic"]?.target ?? null)).toBe(
      path.join("_Inbox", "Needs_Review", "IMG_2041.heic"),
    );

    expect((await readdir(sb.layout.inbox)).sort()).toEqual([
      ".Pending.pdf.icloud",
      "Needs_Review",
    ]);
    const history = await readHistory(sb.config.historyFile);
    expect(history).toHaveLength(4);
    expect(notifications).toEqual([
      "Sorted 3 files into 01_Uni, 04_Persönlich/Gesundheit, 02_Admin & Finanzen/Rechnungen. 1 file needs review",
    ]);
  });

  test("dry run plans the same targets but touches nothing", async () => {
    await put(inbox("Reisepass_Scan.pdf"), makePdf(["Republik Österreich Reisepass"]));
    const rows = await processInbox(ctx(), { dryRun: true });
    expect(rel(rows[0]?.target ?? null)).toBe(
      path.join("04_Persönlich", "Dokumente", "Reisepass_Scan.pdf"),
    );
    expect(existsSync(inbox("Reisepass_Scan.pdf"))).toBe(true);
    expect(existsSync(sb.config.historyFile)).toBe(false);
  });

  test("a second run on an empty inbox is a no-op", async () => {
    await put(inbox("Reisepass_Scan.pdf"), makePdf(["Reisepass"]));
    await processInbox(ctx(), { dryRun: false });
    const notifications: string[] = [];
    expect(await processInbox(ctx(notifications), { dryRun: false })).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("an identical re-upload ends up in duplicates", async () => {
    const pdf = makePdf(["Reisepass"]);
    await put(inbox("Reisepass_Scan.pdf"), pdf);
    await processInbox(ctx(), { dryRun: false });
    await put(inbox("Reisepass_Scan.pdf"), pdf);
    const [row] = await processInbox(ctx(), { dryRun: false });
    expect(row?.status).toBe("duplicate");
    expect(rel(row?.target ?? null)).toBe(
      path.join("_Inbox", "Needs_Review", "duplicates", "Reisepass_Scan.pdf"),
    );
  });

  test("LLM outage sends ambiguous files to review rather than guessing", async () => {
    await server.stop();
    await put(inbox("notiz.txt"), "Laborwerte");
    const [row] = await processInbox(ctx(), { dryRun: false });
    expect(row?.status).toBe("review");
    expect(row?.reason).toContain("LLM unreachable");
  });

  test("undo moves the last sort into Needs_Review and only once", async () => {
    await put(inbox("Reisepass_Scan.pdf"), makePdf(["Reisepass"]));
    await processInbox(ctx(), { dryRun: false });
    const guard = (p: string) => {
      assertWritable(p, sb.layout, sb.config);
    };
    const [outcome] = await undoMoves(
      sb.config.historyFile,
      { last: 1 },
      sb.layout.needsReview,
      guard,
    );
    expect(outcome?.status).toBe("restored");
    expect(await readFile(path.join(sb.layout.needsReview, "Reisepass_Scan.pdf"))).toBeDefined();
    expect(
      await undoMoves(sb.config.historyFile, { last: 1 }, sb.layout.needsReview, guard),
    ).toEqual([]);
  });
});
