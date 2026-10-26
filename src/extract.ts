import { lstat, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { type Config } from './config';
import { run } from './process';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEXT = new Set(['.txt', '.md', '.csv', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.swift', '.java', '.c', '.h', '.cpp', '.rs', '.go', '.html', '.xml', '.yml', '.yaml', '.toml', '.tex', '.sql', '.sh']);
const OCR = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.heic']);
export class ExtractError extends Error { constructor(readonly reason: string) { super(reason); } }
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
  try { const text = await run('pdftotext', ['-f', '1', '-l', '2', file, '-'], '', config.timeoutMs, 262144); if (text.trim().length >= 30) return text.slice(0, 20000); } catch { /* Native OCR is the fallback. */ }
 }
 if (OCR.has(ext)) return run(config.ocr, [file], '', config.timeoutMs, 262144);
 throw new ExtractError('unsupported_type');
}
