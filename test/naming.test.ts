import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";
import { buildTargetName, findDocumentDate, findSender, sanitizeStem } from "../src/naming";

const config = parseConfig();
const mtime = new Date(2026, 9, 7);

describe("findDocumentDate", () => {
  test("prefers the labelled invoice date", () => {
    expect(findDocumentDate("Lieferung 01.09.2026\nRechnungsdatum: 12.10.2026")).toBe("2026-10-12");
  });
  test("falls back to the earliest valid date", () => {
    expect(findDocumentDate("gültig bis 31.12.2027, erstellt 2026-03-05")).toBe("2027-12-31");
    expect(findDocumentDate("Linz, am 3. Jänner 2026")).toBe("2026-01-03");
  });
  test("skips impossible dates", () => {
    expect(findDocumentDate("31.02.2026 und 15.04.2026")).toBe("2026-04-15");
    expect(findDocumentDate("no date here")).toBeNull();
  });
});

describe("findSender", () => {
  test("picks the earliest known sender and respects word boundaries", () => {
    expect(
      findSender("Hutchison Drei Austria\nZahlbar an Raiffeisen", "", config.knownSenders),
    ).toBe("Drei");
    expect(findSender("Dreieck A1B2", "", config.knownSenders)).toBeNull();
    expect(findSender("", "rechnung_magenta_okt", config.knownSenders)).toBe("Magenta");
  });
});

describe("sanitizeStem", () => {
  test("never produces a hidden file", () => {
    expect(sanitizeStem("..hidden")).toBe("hidden");
    expect(sanitizeStem(" . ")).toBe("Dokument");
  });
  test("strips separators and control characters, keeps umlauts", () => {
    expect(sanitizeStem("a/b:c\\d\u0007 Größe\n")).toBe("a-b-c-d Größe");
  });
  test("caps the length", () => {
    expect(sanitizeStem("x".repeat(500))).toHaveLength(120);
  });
});

describe("buildTargetName", () => {
  test("standardizes invoices as YYYY-MM-DD_Sender-Rechnung", () => {
    const name = buildTargetName(
      {
        filename: "scan 12.pdf",
        text: "Drei\nRechnungsdatum: 12.10.2026",
        sub: "Rechnungen",
        suggestedName: null,
        mtime,
      },
      config,
    );
    expect(name).toBe("2026-10-12_Drei-Rechnung.pdf");
  });

  test("uses the LLM name when no known sender is found, without doubling the doc type", () => {
    const name = buildTargetName(
      { filename: "x.pdf", text: "", sub: "Verträge", suggestedName: "Fitinn Vertrag", mtime },
      config,
    );
    expect(name).toBe("2026-10-07_Fitinn-Vertrag.pdf");
  });

  test("keeps original names for other categories", () => {
    const name = buildTargetName(
      {
        filename: "VO_ML_Exercise01.pdf",
        text: "Rechnungsdatum 1.1.2026",
        sub: null,
        suggestedName: "x",
        mtime,
      },
      config,
    );
    expect(name).toBe("VO_ML_Exercise01.pdf");
  });

  test("a malicious suggested name cannot escape or hide", () => {
    const name = buildTargetName(
      { filename: "x.pdf", text: "", sub: "Rechnungen", suggestedName: "../../.evil", mtime },
      config,
    );
    expect(name).not.toContain("/");
    expect(name.startsWith(".")).toBe(false);
  });
});
