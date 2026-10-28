import { lstat, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { type Config } from './config';
import { HelperError, cleanDiag, helperState, run } from './process';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEXT = new Set(['.txt', '.md', '.csv', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.swift', '.java', '.c', '.h', '.cpp', '.rs', '.go', '.html', '.xml', '.yml', '.yaml', '.toml', '.tex', '.sql', '.sh']);
/** Word-processor formats converted by macOS's own `textutil` (absolute path, macOS only). */
const TEXTUTIL = new Set(['.docx', '.doc', '.rtf', '.odt']);
/** `CLOUDTIDY_TEXTUTIL` (an absolute path) exists for tests and non-standard setups, like `CLOUDTIDY_PDFTOTEXT`. */
export const textutilPath = (): string | null => { const o = process.env.CLOUDTIDY_TEXTUTIL; return o && o.startsWith('/') ? o : process.platform === 'darwin' ? '/usr/bin/textutil' : null; };
const OCR = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.heic']);
export class ExtractError extends Error { constructor(readonly reason: string) { super(reason); } }
/** A helper failure becomes a review reason with a short diagnostic (`extraction_failed:ocr:pdf_open`, `…:textutil:exit:1`, `…:ocr:spawn:ENOENT`): allowlisted characters only, never document text. A timeout stays a HelperError (transient). */
function failed(tool: string, e: unknown): never {
 if (e instanceof HelperError) {
  if (e.message === 'helper_timeout') throw e;
  throw new ExtractError(`extraction_failed:${tool}:${cleanDiag((e.diag ?? e.message.replace(/^helper_/, '')).replace(/^ocr_failed:?/, '') || 'failed', 60)}`);
 }
 throw new ExtractError(`extraction_failed:${tool}:error`);
}
/** Bounded text for rules (<=16 KiB text, <=200 KB PDF text layer) and the model (further capped by the classifier). */
export async function extract(file: string, config: Config): Promise<string> {
 const stat = await lstat(file);
 if (!stat.isFile() || stat.isSymbolicLink()) throw new ExtractError('unsupported_or_large_file');
 if (stat.size > MAX_FILE_BYTES) throw new ExtractError('too_large');
 const ext = extname(file).toLowerCase();
 if (TEXT.has(ext)) {
  const handle = await open(file, 'r');
  try { const b = Buffer.alloc(16384); const { bytesRead } = await handle.read(b, 0, b.length, 0); return b.subarray(0, bytesRead).toString('utf8'); } finally { await handle.close(); }
 }
 if (ext === '.pdf') {
  try { const text = await run(process.env.CLOUDTIDY_PDFTOTEXT || Bun.which('pdftotext') || 'pdftotext', ['-f', '1', '-l', '2', file, '-'], '', config.timeoutMs, 262144); if (text.trim().length >= 30) return text.slice(0, 20000); } catch { /* Native OCR is the fallback. */ }
 }
 if (TEXTUTIL.has(ext)) {
  const tool = textutilPath();
  if (!tool) throw new ExtractError('unsupported_type');
  try { return (await run(tool, ['-convert', 'txt', '-encoding', 'UTF-8', '-stdout', file], '', config.timeoutMs, 262144)).slice(0, 20000); } catch (e) { return failed('textutil', e); }
 }
 if (OCR.has(ext)) {
  const st = await helperState(config.ocr);
  if (st !== 'ok') throw new HelperError('helper_missing', null, null, false, `ocr:${st}`); // build problem: the caller keeps the file pending instead of reviewing it
  try { return await run(config.ocr, [file], '', config.timeoutMs, 262144); } catch (e) { return failed('ocr', e); } }
 throw new ExtractError('unsupported_type');
}
