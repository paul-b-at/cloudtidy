import { extname } from 'node:path';
import { safeName, type Config, type Route } from './config';

const MONTHS: Record<string, number> = {
 jan: 1, januar: 1, jänner: 1, january: 1, feb: 2, februar: 2, february: 2, mar: 3, mär: 3, märz: 3, maerz: 3, march: 3, apr: 4, april: 4, mai: 5, may: 5,
 jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, october: 10,
 nov: 11, november: 11, dez: 12, dec: 12, dezember: 12, december: 12
};
const pad = (n: number) => String(n).padStart(2, '0');
function iso(y: number, m: number, d: number): string | null {
 if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
 if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
 return `${y}-${pad(m)}-${pad(d)}`;
}
const year = (s: string) => s.length === 2 ? 2000 + Number(s) : Number(s);
/**
 * Every calendar date the text states, as ISO strings. Handles DD.MM.YYYY / D.M.YY, YYYY-MM-DD, "3. Oktober 2026",
 * "3 Oct 2026", "October 3, 2026" and slash/dash numerics. Slash/dash dates whose day and month are both <= 12 and differ
 * (03/10/2026) are ambiguous between DE and US order and are therefore NOT accepted.
 */
export function datesInText(text: string): Set<string> {
 const out = new Set<string>(), add = (d: string | null) => { if (d) out.add(d); };
 for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?![\d])/g)) add(iso(year(m[3]!), Number(m[2]), Number(m[1])));
 for (const m of text.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) add(iso(Number(m[1]), Number(m[2]), Number(m[3])));
 for (const m of text.matchAll(/(?<![\d])(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)/g)) {
  const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
  if (a <= 12 && b <= 12 && a !== b) continue; // ambiguous DD/MM vs MM/DD
  add(a > 12 ? iso(y, b, a) : b > 12 ? iso(y, a, b) : iso(y, b, a));
 }
 const mon = '([A-Za-zÄÖÜäöüß]{3,9})\\.?';
 for (const m of text.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?${mon},?\\s+(\\d{4})(?!\\d)`, 'gi'))) add(iso(Number(m[3]), MONTHS[m[2]!.toLowerCase()] ?? 0, Number(m[1])));
 for (const m of text.matchAll(new RegExp(`${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'gi'))) add(iso(Number(m[3]), MONTHS[m[1]!.toLowerCase()] ?? 0, Number(m[2])));
 return out;
}
/** The model-suggested date counts only if the extracted text itself states that date. */
export function validatedDate(candidate: string | null, text: string): string | null {
 if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
 return datesInText(text).has(candidate) ? candidate : null;
}
const collapse = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const LEGAL = /[\s,.-]+(?:gmbh(?:\s*&\s*co\.?\s*kg)?|gesmbh|ag|kg|og|e\.u\.|se|ltd\.?|llc|inc\.?|corp\.?|plc|sàrl|sarl|bv|nv)\.?$/i;
/** The model-suggested sender counts only if the text contains it verbatim (case-insensitive, word-bounded). Returns a filename-safe label. */
export function validatedSender(candidate: string | null, text: string): string | null {
 if (!candidate) return null;
 const raw = candidate.normalize('NFC').trim();
 if (raw.length < 2 || raw.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} .,&'\-]*$/u.test(raw)) return null;
 const hay = collapse(text), needle = collapse(raw).replace(/[.\\^$*+?()[\]{}|]/g, m => `\\${m}`);
 if (!new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, 'u').test(hay)) return null;
 let label = raw;
 for (let i = 0; i < 2; i++) { const shorter = label.replace(LEGAL, ''); if (shorter.length >= 2) label = shorter; }
 label = label.replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
 return label.length >= 2 ? label : null;
}
const EXT = /^\.[A-Za-z0-9]{1,10}$/;
export function splitName(filename: string): { stem: string; ext: string } {
 const ext = extname(filename);
 const stem = ext ? filename.slice(0, -ext.length) : filename;
 return stem ? { stem, ext } : { stem: filename, ext: '' };
}
/** NFC, no separators/control chars, no leading dots, length-capped. */
export function sanitizeStem(input: string, max = 120): string {
 const s = [...input.normalize('NFC')].filter(c => { const n = c.codePointAt(0)!; return n >= 0x20 && n !== 0x7f; }).join('').replace(/[/\\:~]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s-]+/, '');
 return (s.length > max ? s.slice(0, max).trimEnd() : s) || 'Dokument';
}
export interface NameInput { filename: string; text: string; route: Route; documentDate: string | null; sender: string | null }
export interface NameResult { name: string; renamed: boolean; reason: string }
const datePrefixed = /^\d{4}-\d{2}-\d{2}[_ -]/;
/**
 * Locked policy: invoices/contracts become `YYYY-MM-DD_<Sender>-<Doctype>.<ext>` only when the model's date AND sender are
 * both found in the extracted text; otherwise the original name is kept. Uni, dev and other assets always keep their names.
 * Optional `naming.datePrefix` adds a validated date prefix to 04_Persönlich documents only. The extension is always the original one.
 */
export function targetName(input: NameInput, config: Config): NameResult {
 const keep = (reason: string): NameResult => ({ name: input.filename, renamed: false, reason });
 const { stem, ext } = splitName(input.filename);
 if (ext && !EXT.test(ext)) return keep('naming_unsafe_extension');
 const personal = config.naming.datePrefix && input.route.folder === '04_Persönlich';
 if (!input.route.rename && !personal) return keep('naming_not_applicable');
 const date = validatedDate(input.documentDate, input.text);
 if (!date) return keep('naming_date_unverified');
 let name: string;
 if (input.route.rename) {
  const sender = validatedSender(input.sender, input.text);
  if (!sender || !input.route.docType) return keep('naming_sender_unverified');
  name = `${date}_${sender}-${input.route.docType}${ext}`;
 } else {
  if (datePrefixed.test(stem)) return keep('naming_already_dated');
  name = `${date}_${sanitizeStem(stem, 100)}${ext}`;
 }
 name = name.normalize('NFC');
 if (!safeName(name) || Buffer.byteLength(name) > 200 || extname(name) !== ext) return keep('naming_unsafe_result');
 return { name, renamed: name !== input.filename, reason: 'naming_validated' };
}
