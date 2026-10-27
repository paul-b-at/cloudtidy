import { extname } from 'node:path';
import { safeName, type Config, type KnownSender, type Route } from './config';

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
export interface FoundDate { iso: string; index: number; raw: string }
/** Every unambiguous calendar date in the text with its position (see datesInText for the accepted formats). */
export function scanDates(text: string): FoundDate[] {
 text = text.normalize('NFC');
 const out: FoundDate[] = [], add = (d: string | null, m: RegExpMatchArray) => { if (d) out.push({ iso: d, index: m.index ?? 0, raw: m[0] }); };
 for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?![\d])/g)) add(iso(year(m[3]!), Number(m[2]), Number(m[1])), m);
 for (const m of text.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) add(iso(Number(m[1]), Number(m[2]), Number(m[3])), m);
 for (const m of text.matchAll(/(?<![\d])(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)/g)) {
  const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
  if (a <= 12 && b <= 12 && a !== b) continue; // ambiguous DD/MM vs MM/DD
  add(a > 12 ? iso(y, b, a) : b > 12 ? iso(y, a, b) : iso(y, b, a), m);
 }
 const mon = '([A-Za-zÄÖÜäöüß]{3,9})\\.?';
 for (const m of text.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?${mon},?\\s+(\\d{4})(?!\\d)`, 'gi'))) add(iso(Number(m[3]), MONTHS[m[2]!.toLowerCase()] ?? 0, Number(m[1])), m);
 for (const m of text.matchAll(new RegExp(`${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'gi'))) add(iso(Number(m[3]), MONTHS[m[1]!.toLowerCase()] ?? 0, Number(m[2])), m);
 return out.sort((x, y) => x.index - y.index);
}
/**
 * Every calendar date the text states, as ISO strings. Handles DD.MM.YYYY / D.M.YY, YYYY-MM-DD, "3. Oktober 2026",
 * "3 Oct 2026", "October 3, 2026" and slash/dash numerics. Slash/dash dates whose day and month are both <= 12 and differ
 * (03/10/2026) are ambiguous between DE and US order and are therefore NOT accepted.
 */
export function datesInText(text: string): Set<string> { return new Set(scanDates(text).map(d => d.iso)); }
const LABELS_STRONG = /(?<![\p{L}\p{N}])(?:Rechnungs-?datum|Rechnung\s+vom|Invoice\s+date|Date\s+of\s+(?:invoice|issue)|Issue\s+date|Issued\s+on|Ausstellungsdatum|Ausgestellt\s+am|Datum\s+der\s+(?:Rechnung|Ausstellung)|Belegdatum|Vertragsdatum|Vertrag\s+vom|Abschlussdatum)(?![\p{L}\p{N}])/giu;
const LABELS_GENERIC = /(?<![\p{L}\p{N}])(?<!(?:Fälligkeit|Zahlung|Lieferung?|Leistung|Geburt|Ablauf|Druck|Due|Delivery|Payment|Print|Birth|Expiry|Valid|Gültig)s?[\s-]*)(?:Datum|Date)(?![\p{L}\p{N}])/giu;
/**
 * The date a document labels as its own (Rechnungsdatum, Invoice date, Datum, ...), in an unambiguous format with a 4-digit year,
 * found without any model. Several different dates under the most specific label that matches => ambiguous => null.
 */
export function labelledDate(text: string): string | null {
 text = text.normalize('NFC');
 const dates = scanDates(text);
 for (const re of [LABELS_STRONG, LABELS_GENERIC]) {
  const found = new Set<string>();
  for (const m of text.matchAll(re)) {
   const end = (m.index ?? 0) + m[0].length;
   // `dates` is sorted by position: binary-search the first date after the label instead of scanning all of them (quadratic on date-heavy OCR text).
   let lo = 0, hi = dates.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid]!.index < end) lo = mid + 1; else hi = mid; }
   let d: FoundDate | undefined;
   for (let k = lo; k < dates.length && dates[k]!.index - end <= 14; k++) { const x = dates[k]!; if (/^[\s:.\-–—]*$/.test(text.slice(end, x.index)) && /\d{4}/.test(x.raw)) { d = x; break; } }
   if (d) found.add(d.iso);
  }
  if (found.size === 1) return [...found][0]!;
  if (found.size > 1) return null;
 }
 return null;
}
/** The model-suggested date counts only if the extracted text itself states that date. */
export function validatedDate(candidate: string | null, text: string): string | null {
 if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
 return datesInText(text).has(candidate) ? candidate : null;
}
const collapse = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const LEGAL = /[\s,.-]+(?:gmbh(?:\s*&\s*co\.?\s*kg)?|gesmbh|ag|kg|og|e\.u\.|se|ltd\.?|llc|inc\.?|corp\.?|plc|sàrl|sarl|bv|nv)\.?$/i;
const esc = (s: string) => s.replace(/[.\\^$*+?()[\]{}|]/g, m => `\\${m}`);
const wordIn = (needle: string, hay: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(collapse(needle))}(?![\\p{L}\\p{N}])`, 'u').test(hay);
/** Filename-safe sender label: legal forms removed, spaces to hyphens, at most 40 characters. */
export function senderLabel(raw: string): string | null {
 let label = raw.normalize('NFC').trim();
 for (let i = 0; i < 2; i++) { const shorter = label.replace(LEGAL, ''); if (shorter.length >= 2) label = shorter; }
 label = label.replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
 return label.length >= 2 ? label : null;
}
const SHORT_SENDER_WINDOW = 1500;
/** A company form or country right after the name: "Drei Austria", "VERBUND AG", "Allianz SE". */
const COMPANY_SUFFIX = /^[\s,.-]*(?:austria|österreich|gmbh|gesmbh|ag|kg|og|se|e\.u\.|ltd|llc|inc|corp|plc)(?![\p{L}\p{N}])/iu;
const spellingRe = (v: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(v)}(?![\\p{L}\\p{N}])`, 'gu');
/** The configured spelling or its ALL-CAPS form (invoices often print the letterhead in capitals): never any other case ("drei" in a sentence is a number). */
const spellings = (k: KnownSender) => [k.name, ...k.aliases].map(sp => ({ sp: sp.normalize('NFC'), alias: sp !== k.name }));
/**
 * Canonical names of configured known senders (Drei, A1, Wien Energie, ...) that the text mentions as a whole word in the configured
 * spelling (or an alias, or the same in capitals). Case matters: "Kaution drei Monatsmieten" is not Drei.
 * - Names shorter than 3 characters (A1) only count in the first 1500 characters (letterhead), where "A1" is a company and not a paper size.
 * - Ordinary words (`commonWord`: Drei, Magenta, Verbund, Allianz, ...) only count in that letterhead window, or when a company suffix follows ("Drei Austria", "VERBUND AG"). Aliases are specific names and always count.
 */
export function knownSenderMatches(text: string, config: Pick<Config, 'knownSenders'>): Set<string> {
 const hay = text.normalize('NFC').replace(/\s+/g, ' '), out = new Set<string>();
 for (const k of config.knownSenders) {
  found: for (const { sp, alias } of spellings(k)) {
   for (const v of new Set([sp, sp.toUpperCase()])) {
    for (const m of hay.matchAll(spellingRe(v))) {
     const inWindow = m.index! < SHORT_SENDER_WINDOW, common = !!k.commonWord && !alias;
     if (common ? inWindow || COMPANY_SUFFIX.test(hay.slice(m.index! + v.length, m.index! + v.length + 24)) : sp.length < 3 ? inWindow : true) { out.add(k.name); break found; }
    }
   }
  }
 }
 return out;
}
const LABELLED_SENDER = /^[ \t]*(?:Absender|Rechnungssteller|Sender|From)[ \t]*[:：][ \t]*(.{2,80}?)[ \t]*$/imu;
/** A sender the document states itself: an `Absender:`/`From:` line, else (only to settle a known-sender hit) a letterhead line that ends in a company form. Validated like any model suggestion. */
function statedSender(text: string, config: Pick<Config, 'knownSenders'>, letterhead: boolean): string | null {
 const resolve = (c: string): string | null => {
  const k = config.knownSenders.find(k => knownSenderMatches(c, { knownSenders: [k] }).size > 0);
  if (k) return k.name;
  return validatedSender(c, text, config) ? c : null;
 };
 const labelled = LABELLED_SENDER.exec(text)?.[1];
 const l = labelled ? resolve(labelled) : null;
 if (l) return l;
 if (!letterhead) return null;
 for (const line of text.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 8)) {
  if (line.length <= 80 && LEGAL.test(line) && /^[\p{L}\p{N}][\p{L}\p{N} .,&'\-]*$/u.test(line)) { const r = resolve(line); if (r) return r; }
 }
 return null;
}
/** A known sender found without any model: the canonical configured name when exactly one distinct sender is in the text, else null (several => ambiguous). */
export function knownSenderIn(text: string, config: Pick<Config, 'knownSenders'>): string | null {
 const m = knownSenderMatches(text, config);
 return m.size === 1 ? [...m][0]! : null; // canonical name, not the hyphenated label: validatedSender() re-checks it against the text and builds the label (a label like "Wien-Energie" never matches "Wien Energie")
}
/** Words that appear in almost every document but are never an issuing organisation (articles, pronouns, greetings, mail/letter headers, document words). A candidate made only of these is rejected unless it is a configured known sender. */
const SENDER_STOPWORDS = new Set(`der die das den dem des ein eine einen einem einer eines und oder aber von vom zu zum zur an am im in auf aus bei mit nach nur für fuer über ueber unter als auch wir sie ich du er es ihr ihre ihren ihrem ihrer ihres uns unser unsere sehr geehrte geehrter geehrten herr frau hallo guten tag liebe lieber grüße gruesse gruß mfg
re aw wg fw fwd betreff anrede absender empfänger empfaenger kunde kunden kundin firma seite datum rechnung rechnungen vertrag verträge vertraege betrag summe gesamt summen nummer nr anlage anhang kopie
the a an and or of to from for with by on in at as is are this that these those you your we our they their he she it his her dear sir madam mr mrs ms hello hi regards sincerely subject re fw fwd cc bcc to sender recipient customer company page date invoice invoices contract contracts amount total number no attachment copy`.split(/\s+/));
const onlyStopwords = (s: string) => { const words = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); return words.length === 0 || words.every(w => SENDER_STOPWORDS.has(w)); };
/**
 * A suggested sender counts only if (a) the text contains it as a whole word (case-insensitive), and (b) it has at least 3
 * characters or is a configured known sender; or it is the canonical name of a known sender whose spelling appears in the text.
 * Returns a filename-safe label.
 */
export function validatedSender(candidate: string | null, text: string, config: Pick<Config, 'knownSenders'> = { knownSenders: [] }): string | null {
 if (!candidate) return null;
 const raw = candidate.normalize('NFC').trim();
 if (raw.length < 2 || raw.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} .,&'\-]*$/u.test(raw)) return null;
 const key = collapse(raw), known = config.knownSenders.find(k => [k.name, ...k.aliases].some(x => collapse(x) === key));
 if (known) return knownSenderMatches(text, config).has(known.name) ? senderLabel(known.name) : null; // a known name only counts where knownSenderMatches accepts it ("im Verbund" is not VERBUND): never via the generic whole-word check below
 if (raw.length < 3 && !known) return null;
 if (!known && onlyStopwords(raw)) return null; // `Die`, `Der`, `Re`, `An`, `Sehr`, `Dear` ... would pass the whole-word check in any document: a prompt-injected or confused model must not pick them
 if (!wordIn(raw, collapse(text))) return null;
 return senderLabel(raw);
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
 const cps = [...s]; // cut on code points: slicing UTF-16 units can leave a lone surrogate (written to disk as U+FFFD)
 return (cps.length > max ? cps.slice(0, max).join('').trimEnd() : s) || 'Dokument';
}
export interface NameInput { filename: string; text: string; route: Route; documentDate: string | null; sender: string | null }
export interface NameResult { name: string; renamed: boolean; reason: string }
/** Folders whose files may get an optional date prefix (`naming.datePrefix`): personal and admin documents. Uni/dev/invoice/contract names are never prefixed here. */
export const DATE_PREFIX_FOLDERS = ['04_Persönlich', '02_Admin & Finanzen'];
const datePrefixed = /^\d{4}-\d{2}-\d{2}[_ -]/;
/**
 * Locked policy: invoices/contracts become `YYYY-MM-DD_<Sender>-<Doctype>.<ext>` only when the model's date AND sender are
 * both found in the extracted text; otherwise the original name is kept. Uni, dev and other assets always keep their names.
 * Optional `naming.datePrefix` adds a validated date prefix to 04_Persönlich and 02_Admin & Finanzen (admin route) documents only. The extension is always the original one.
 */
export function targetName(input: NameInput, config: Config): NameResult {
 const keep = (reason: string): NameResult => ({ name: input.filename, renamed: false, reason });
 const { stem, ext } = splitName(input.filename);
 if (ext && !EXT.test(ext)) return keep('naming_unsafe_extension');
 const personal = config.naming.datePrefix && DATE_PREFIX_FOLDERS.includes(input.route.folder);
 if (!input.route.rename && !personal) return keep('naming_not_applicable');
 const date = validatedDate(input.documentDate, input.text);
 if (!date) return keep('naming_date_unverified');
 let name: string;
 if (input.route.rename) {
  const sender = validatedSender(input.sender, input.text, config);
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
/** Deterministic naming inputs found in the text itself (no model): the document's labelled date and a configured known sender. */
export function extractNaming(text: string, route: Route, config: Config): { date: string | null; sender: string | null } {
 if (!route.rename) return { date: labelledDate(text), sender: null };
 // A sender the document states itself beats a bare known-sender hit (a letterhead line with a company form settles several hits too).
 const hits = knownSenderMatches(text, config), stated = statedSender(text, config, hits.size > 0);
 return { date: labelledDate(text), sender: stated ?? (hits.size === 1 ? [...hits][0]! : null) };
}
