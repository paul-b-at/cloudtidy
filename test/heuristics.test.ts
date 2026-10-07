import { describe, expect, test } from "bun:test";
import { buildRules, scoreHeuristics } from "../src/classify/heuristics";
import { parseConfig } from "../src/config";

const config = parseConfig();
const rules = buildRules(config);
const score = (filename: string, text = "") =>
  scoreHeuristics({ filename, text }, rules, config.heuristics);

describe("Tier 1 heuristics", () => {
  test("Austrian invoice is a definite Rechnung", () => {
    const r = score(
      "scan.pdf",
      "Hutchison Drei Austria GmbH\nRechnung Nr. 123\nRechnungsdatum: 12.10.2026\nGesamtbetrag EUR 25,00\nUID ATU12345678\nIBAN AT12 3456",
    );
    expect(r).toMatchObject({ category: "admin", sub: "Rechnungen", definite: true });
  });

  test("JKU course code in the filename is definite Uni", () => {
    expect(score("VL 365.012 Machine Learning.pdf")).toMatchObject({
      category: "uni",
      definite: true,
    });
    expect(score("VO_ML_Exercise01.pdf")).toMatchObject({ category: "uni", definite: true });
    expect(score("UE_344.031_Blatt3.pdf")).toMatchObject({ category: "uni", definite: true });
  });

  test("bank CSV export goes to admin/Bank, not Dev", () => {
    const r = score("umsaetze_2026.csv", "Buchungsdatum;Valutadatum;Betrag;IBAN;Verwendungszweck");
    expect(r).toMatchObject({ category: "admin", sub: "Bank", definite: true });
  });

  test("a code file alone is not enough to be definite", () => {
    expect(score("data.csv", "a,b,c\n1,2,3").definite).toBe(false);
  });

  test("contracts land in Verträge, including German compounds", () => {
    expect(score("Mietvertrag_Linz.pdf", "Mietvertrag zwischen ...")).toMatchObject({
      category: "admin",
      sub: "Verträge",
      definite: true,
    });
  });

  test("passport scan is personal/Dokumente", () => {
    expect(score("Reisepass_Scan.pdf")).toMatchObject({
      category: "personal",
      sub: "Dokumente",
      definite: true,
    });
  });

  test("competing signals are not definite", () => {
    // admin (contract, 3) vs uni (exercise, 2): margin below minMargin.
    const r = score("Mietvertrag Exercise.pdf");
    expect(r).toMatchObject({ category: "admin", runnerUp: 2, definite: false });
  });

  test("nothing matched", () => {
    expect(score("IMG_2041.heic")).toMatchObject({ category: null, definite: false });
  });

  test("configured course numbers are recognized", () => {
    const custom = parseConfig({ courseNumbers: ["365.099"] });
    const r = scoreHeuristics(
      { filename: "notes 365.099.md", text: "" },
      buildRules(custom),
      custom.heuristics,
    );
    expect(r).toMatchObject({ category: "uni", definite: true });
  });
});
