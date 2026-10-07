import path from "node:path";
import type { Config } from "./config";

export const MAX_STEM_LENGTH = 120;
const MAX_SENDER_LENGTH = 40;

const MONTHS: Record<string, number> = {
  jänner: 1,
  januar: 1,
  january: 1,
  februar: 2,
  february: 2,
  märz: 3,
  march: 3,
  april: 4,
  mai: 5,
  may: 5,
  juni: 6,
  june: 6,
  juli: 7,
  july: 7,
  august: 8,
  september: 9,
  oktober: 10,
  october: 10,
  november: 11,
  dezember: 12,
  december: 12,
};

const LABELLED_DATE =
  /(Rechnungsdatum|Belegdatum|Ausstellungsdatum|Vertragsdatum|Vertragsbeginn|Invoice date|Datum|Date)\s*[:.]?\s*(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})\b/i;
const DMY = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTH_NAME = new RegExp(
  `\\b(\\d{1,2})\\.?\\s(${Object.keys(MONTHS).join("|")})\\s(\\d{4})\\b`,
  "gi",
);

function toIso(year: number, month: number, day: number): string | null {
  const y = year < 100 ? 2000 + year : year;
  if (y < 2000 || y > 2100 || month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(y, month, 0)).getUTCDate()) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Prefers a labelled date ("Rechnungsdatum: 12.10.2026"), else the earliest valid date in the text. */
export function findDocumentDate(text: string): string | null {
  const labelled = LABELLED_DATE.exec(text);
  if (labelled) {
    const iso = toIso(Number(labelled[4]), Number(labelled[3]), Number(labelled[2]));
    if (iso) return iso;
  }

  const candidates: { index: number; iso: string }[] = [];
  for (const m of text.matchAll(DMY)) {
    const iso = toIso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (iso) candidates.push({ index: m.index, iso });
  }
  for (const m of text.matchAll(ISO)) {
    const iso = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) candidates.push({ index: m.index, iso });
  }
  for (const m of text.matchAll(MONTH_NAME)) {
    const month = MONTHS[(m[2] ?? "").toLowerCase()];
    const iso = month ? toIso(Number(m[3]), month, Number(m[1])) : null;
    if (iso) candidates.push({ index: m.index, iso });
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.iso ?? null;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const senderPattern = (sender: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(sender)}(?![\\p{L}\\p{N}])`, "iu");

/** The known sender that appears earliest in the text (letterheads come first), else in the filename. */
export function findSender(text: string, filename: string, senders: string[]): string | null {
  let best: { index: number; sender: string } | null = null;
  for (const sender of senders) {
    const match = senderPattern(sender).exec(text);
    if (match && (!best || match.index < best.index)) best = { index: match.index, sender };
  }
  if (best) return best.sender;
  const spacedName = filename.replace(/[_-]+/g, " ");
  return senders.find((sender) => senderPattern(sender).test(spacedName)) ?? null;
}

/**
 * Makes a safe file stem: no path separators or control characters, and no
 * leading dots (a dotfile would be skipped by the scanner and effectively vanish).
 */
export function sanitizeStem(input: string, maxLength = MAX_STEM_LENGTH): string {
  const printable = [...input.normalize("NFC")]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  let stem = printable
    .replace(/[/\\:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
  if (stem.length > maxLength) stem = stem.slice(0, maxLength).trimEnd();
  return stem || "Dokument";
}

export function splitName(filename: string): { stem: string; ext: string } {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  // ".pdf" alone is a dotfile name, not an extension.
  return stem ? { stem, ext } : { stem: filename, ext: "" };
}

export interface NamingInput {
  filename: string;
  text: string;
  sub: string | null;
  suggestedName: string | null;
  mtime: Date;
}

/** Rechnungen/Verträge get `YYYY-MM-DD_Sender-Rechnung.ext`; everything else keeps its (sanitized) name. */
export function buildTargetName(input: NamingInput, config: Config): string {
  const { stem, ext } = splitName(input.filename);
  const safeExt = ext.replace(/[^\p{L}\p{N}.]/gu, "");
  const docType = input.sub ? config.standardizedNames[input.sub] : undefined;
  if (!docType) return `${sanitizeStem(stem)}${safeExt}`;

  const date =
    findDocumentDate(input.text) ??
    toIso(input.mtime.getFullYear(), input.mtime.getMonth() + 1, input.mtime.getDate()) ??
    "undatiert";
  const sender = findSender(input.text, stem, config.knownSenders);
  let label: string;
  if (sender) {
    label = `${sender}-${docType}`;
  } else if (input.suggestedName?.trim()) {
    const suggested = sanitizeStem(input.suggestedName, MAX_SENDER_LENGTH);
    label = suggested.toLowerCase().includes(docType.toLowerCase())
      ? suggested
      : `${suggested}-${docType}`;
  } else {
    label = `${sanitizeStem(stem, MAX_SENDER_LENGTH)}-${docType}`;
  }
  return `${sanitizeStem(`${date}_${label.replace(/\s+/g, "-")}`)}${safeExt}`;
}
