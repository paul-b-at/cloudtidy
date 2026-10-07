import path from "node:path";
import { ocrText } from "./ocr";
import { pdfText } from "./pdf";
import { plainText } from "./text";

export type Kind = "pdf" | "image" | "text" | "other";
export type Method = "pdf-text" | "ocr" | "plain" | "none";

export interface Extraction {
  kind: Kind;
  method: Method;
  text: string;
}

export const MAX_TEXT_CHARS = 4000;
/** Below this many non-whitespace characters a PDF is treated as a scan. */
const MIN_TEXT_LAYER = 40;

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "heic",
  "heif",
  "tif",
  "tiff",
  "gif",
  "webp",
  "bmp",
]);
const TEXT_EXT = new Set([
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "ts",
  "tsx",
  "js",
  "py",
  "sql",
  "tex",
  "log",
  "ics",
  "vcf",
]);

export async function detectKind(file: string): Promise<Kind> {
  const head = Buffer.from(await Bun.file(file).slice(0, 5).arrayBuffer()).toString("latin1");
  if (head === "%PDF-") return "pdf";
  const ext = path.extname(file).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "other";
}

const cap = (text: string): string =>
  text
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);

export async function extractText(file: string, ocrHelper: string): Promise<Extraction> {
  const kind = await detectKind(file);
  switch (kind) {
    case "pdf": {
      const layer = await pdfText(file);
      if (layer.replace(/\s/g, "").length >= MIN_TEXT_LAYER) {
        return { kind, method: "pdf-text", text: cap(layer) };
      }
      const ocr = await ocrText(file, ocrHelper);
      if (ocr?.trim()) return { kind, method: "ocr", text: cap(ocr) };
      return { kind, method: layer.trim() ? "pdf-text" : "none", text: cap(layer) };
    }
    case "image": {
      const ocr = await ocrText(file, ocrHelper);
      return ocr?.trim()
        ? { kind, method: "ocr", text: cap(ocr) }
        : { kind, method: "none", text: "" };
    }
    case "text":
      return { kind, method: "plain", text: cap(await plainText(file)) };
    case "other":
      return { kind, method: "none", text: "" };
  }
}
