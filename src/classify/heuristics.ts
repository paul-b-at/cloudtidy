import path from "node:path";
import type { Config } from "../config";

export type Field = "text" | "filename" | "ext";

export interface Rule {
  id: string;
  /** Bucket id from config (`uni`, `admin`, …). */
  category: string;
  sub?: string;
  fields: Field[];
  pattern: RegExp;
  weight: number;
}

export interface HeuristicInput {
  filename: string;
  text: string;
}

export interface HeuristicResult {
  category: string | null;
  sub: string | null;
  score: number;
  runnerUp: number;
  definite: boolean;
  matched: string[];
}

const TF: Field[] = ["text", "filename"];

/** German compounds (Mietvertrag, Rechnungsnummer) are why most patterns have no leading \b. */
export const DEFAULT_RULES: Rule[] = [
  {
    id: "uni-course-code",
    category: "uni",
    fields: TF,
    pattern: /\b(VL|VO|UE|KV|PR|SE|KS|PS)\s?\d{3}\.\d{3}\b/,
    weight: 4,
  },
  {
    id: "uni-jku",
    category: "uni",
    fields: TF,
    pattern: /\bJKU\b|Johannes Kepler|KUSSS|Moodle/i,
    weight: 3,
  },
  {
    id: "uni-course-type",
    category: "uni",
    fields: ["filename"],
    pattern: /\b(VL|VO|UE|KV)\b/,
    weight: 2,
  },
  {
    id: "uni-terms",
    category: "uni",
    fields: TF,
    pattern:
      /\b(Übung|Uebung|Übungsblatt|Exercise|Assignment|Lecture|Vorlesung|Klausur|Exam|Prüfung|Cheat ?Sheet|Skript|Tutorium|Lecture Notes)/i,
    weight: 2,
  },
  {
    id: "admin-invoice",
    category: "admin",
    sub: "Rechnungen",
    fields: TF,
    pattern: /(Rechnung|Invoice|Zahlungsziel|Zahlungsbedingungen|Fälligkeit|Quittung|Receipt)/i,
    weight: 3,
  },
  {
    id: "admin-uid",
    category: "admin",
    sub: "Rechnungen",
    fields: ["text"],
    pattern: /\bATU\s?\d{8}\b/,
    weight: 2,
  },
  {
    id: "admin-amount",
    category: "admin",
    sub: "Rechnungen",
    fields: ["text"],
    pattern: /\b(Betrag|Gesamtbetrag|Summe|USt|MwSt|Total)\b/i,
    weight: 1,
  },
  { id: "admin-iban", category: "admin", fields: ["text"], pattern: /\bIBAN\b/i, weight: 1 },
  {
    id: "admin-bank",
    category: "admin",
    sub: "Bank",
    fields: TF,
    pattern:
      /(Kontoauszug|Kontostand|Umsatzliste|Umsätze|Buchungsdatum|Valutadatum|Account statement)/i,
    weight: 4,
  },
  {
    id: "admin-contract",
    category: "admin",
    sub: "Verträge",
    fields: TF,
    pattern:
      /(Vertrag|Polizze|Versicherung|Kündigung|Vereinbarung|Allgemeine Geschäftsbedingungen)/i,
    weight: 3,
  },
  {
    id: "admin-tax",
    category: "admin",
    sub: "Steuer",
    fields: TF,
    pattern:
      /(Finanzamt|Einkommensteuer|Steuernummer|Arbeitnehmerveranlagung|Lohnzettel|Steuerbescheid|FinanzOnline)/i,
    weight: 4,
  },
  {
    id: "dev-ext",
    category: "dev",
    fields: ["ext"],
    pattern: /^(ts|tsx|js|jsx|py|ipynb|drawio|sql|csv|json|ya?ml|swift|rs|go|java|c|cpp|h|sh)$/,
    weight: 1,
  },
  {
    id: "dev-repo",
    category: "dev",
    fields: TF,
    pattern: /github\.com|gitlab\.com|\brepository\b|pull request/i,
    weight: 3,
  },
  {
    id: "dev-terms",
    category: "dev",
    fields: TF,
    pattern: /\b(architecture|schema|diagram|README|dataset|API spec)\b/i,
    weight: 1,
  },
  {
    id: "personal-id",
    category: "personal",
    sub: "Dokumente",
    fields: TF,
    pattern:
      /(Reisepass|Personalausweis|Passport|Führerschein|Meldezettel|Geburtsurkunde|Staatsbürgerschaft)/i,
    weight: 4,
  },
  {
    id: "personal-travel",
    category: "personal",
    sub: "Reisen",
    fields: TF,
    pattern:
      /(Boarding ?Pass|Bordkarte|Flugticket|Buchungsbestätigung|Booking confirmation|Zugticket|\bÖBB\b)/i,
    weight: 3,
  },
  {
    id: "personal-health",
    category: "personal",
    sub: "Gesundheit",
    fields: TF,
    pattern: /(Befund|Arztbrief|Ärztin|\bArzt\b|Krankenhaus|Impfpass|Impfung|Laborbefund|e-card)/i,
    weight: 3,
  },
  {
    id: "personal-fitness",
    category: "personal",
    fields: TF,
    pattern: /(Trainingsplan|Workout|\bGym\b|Fitness)/i,
    weight: 2,
  },
];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildRules(config: Config): Rule[] {
  const rules = DEFAULT_RULES.filter((rule) => rule.category in config.buckets);
  if (config.courseNumbers.length > 0 && "uni" in config.buckets) {
    rules.push({
      id: "uni-course-list",
      category: "uni",
      fields: TF,
      pattern: new RegExp(`\\b(${config.courseNumbers.map(escapeRegex).join("|")})\\b`),
      weight: 4,
    });
  }
  return rules;
}

/** Underscores and dashes act as word separators in filenames so `JKU_Exam` matches `\bJKU\b`. */
function fieldsOf(input: HeuristicInput): Record<Field, string> {
  const ext = path.extname(input.filename);
  return {
    text: input.text,
    filename: input.filename.slice(0, input.filename.length - ext.length).replace(/[_-]+/g, " "),
    ext: ext.slice(1).toLowerCase(),
  };
}

/**
 * Sums rule weights per category. Only a clear winner (score >= minScore and
 * ahead of the runner-up by minMargin) counts as definite; everything else goes to Tier 2.
 */
export function scoreHeuristics(
  input: HeuristicInput,
  rules: Rule[],
  thresholds: Config["heuristics"],
): HeuristicResult {
  const fields = fieldsOf(input);
  const scores = new Map<string, number>();
  const subScores = new Map<string, Map<string, number>>();
  const matched: string[] = [];

  for (const rule of rules) {
    if (!rule.fields.some((field) => rule.pattern.test(fields[field]))) continue;
    matched.push(rule.id);
    scores.set(rule.category, (scores.get(rule.category) ?? 0) + rule.weight);
    if (rule.sub) {
      const subs = subScores.get(rule.category) ?? new Map<string, number>();
      subs.set(rule.sub, (subs.get(rule.sub) ?? 0) + rule.weight);
      subScores.set(rule.category, subs);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top) return { category: null, sub: null, score: 0, runnerUp: 0, definite: false, matched };

  const [category, score] = top;
  const runnerUp = second?.[1] ?? 0;
  let sub: string | null = null;
  let best = 0;
  for (const [name, value] of subScores.get(category) ?? []) {
    if (value > best) {
      sub = name;
      best = value;
    }
  }
  const definite = score >= thresholds.minScore && score - runnerUp >= thresholds.minMargin;
  return { category, sub, score, runnerUp, definite, matched };
}
