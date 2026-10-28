import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
/** `skipped`: no helper call was made (the per-run circuit breaker answered); never an attempt, never retried. `token`: the helper's own diagnostic code from stderr (`classification_failed:<code>`), e.g. `refusal`. Never document text. */
export class HelperError extends Error { constructor(message: string, readonly exitCode: number | null = null, readonly token: string | null = null, readonly skipped = false, readonly diag: string | null = null) { super(message); } }
const TOKEN = /^classification_failed:([a-z_]{1,40})$/m;
/** The OCR helper's own step code on stderr (`ocr_failed:pdf_open`, `ocr_failed:vision:com.apple.vision.5`): a fixed vocabulary, never document text. */
const OCR_DIAG = /^ocr_failed(?::([A-Za-z0-9_.]{1,40}(?::[A-Za-z0-9_.-]{1,40})?))?$/m;
/** A helper binary must exist, be a regular file and be executable (a directory also passes access(X_OK)). Checked before every spawn: a missing build is a configuration problem, not a document problem. */
export type HelperState = 'ok' | 'missing' | 'not_executable' | 'not_a_file';
export async function helperState(path: string): Promise<HelperState> {
 try { if (!(await stat(path)).isFile()) return 'not_a_file'; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'missing' : 'not_executable'; }
 return access(path, constants.X_OK).then(() => 'ok' as const, () => 'not_executable' as const);
}
/** Anything that may reach a review reason, log or screen from a helper or the OS: allowlisted characters only, length-capped. */
export const cleanDiag = (s: string, max = 80): string => s.replace(/[^A-Za-z0-9_.:|-]/g, '').slice(0, max);
// No shell, bounded output, enforced timeout. Never log document contents.
export function run(command: string, args: string[], input: string, timeout: number, maxBytes = 32768, env?: Record<string, string>): Promise<string> {
 return new Promise((resolve,reject) => {
  let done = false, size = 0; const output: Buffer[] = []; let err = '';
  let child: ReturnType<typeof spawn>;
  // Some runtimes throw from spawn() itself (instead of emitting 'error'): that is "helper unavailable" too, with the OS error code as diagnostic.
  try { child = spawn(command,args,{stdio:['pipe','pipe','pipe'],...(env ? {env:{...process.env,...env}} : {})}); } catch (e) { reject(new HelperError('helper_unavailable', null, null, false, cleanDiag(`spawn:${(e as NodeJS.ErrnoException).code ?? 'error'}`))); return; }
  const finish = (error?: Error) => { if(done) return; done=true; clearTimeout(timer); if(error) { child.kill('SIGKILL'); reject(error); } else resolve(Buffer.concat(output).toString('utf8')); };
  const timer=setTimeout(()=>finish(new HelperError('helper_timeout')),timeout);
  child.on('error',(e: NodeJS.ErrnoException)=>finish(new HelperError('helper_unavailable', null, null, false, cleanDiag(`spawn:${e?.code ?? 'error'}`))));
  for (const stream of [child.stdout!,child.stderr!]) stream.on('data',(data: Buffer)=>{ size+=data.length; if(size>maxBytes) finish(new HelperError('helper_output_limit')); else if(stream===child.stdout) output.push(data); else if(err.length<2048) err+=data.toString('utf8'); });
  child.stdin!.on('error',()=>{}); child.stdin!.end(input);
  child.on('close',(code,signal)=>finish(code===0 ? undefined : new HelperError('helper_failed',code,TOKEN.exec(err)?.[1] ?? null,false,cleanDiag(OCR_DIAG.exec(err)?.[1] ? `ocr_failed:${OCR_DIAG.exec(err)![1]}` : code === null ? `signal:${signal ?? 'unknown'}` : `exit:${code}`))));
 });
}
