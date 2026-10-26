import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, extname, basename } from 'node:path';
import { type Config } from './config';
import { classify, review, type Decision } from './classifier';
import { run } from './process';
export interface Proposal { file: string; destination: string | null; decision: Decision }
export async function extract(file: string, config: Config): Promise<string> {
 const stat=await lstat(file);
 if(!stat.isFile() || stat.isSymbolicLink() || stat.size>25*1024*1024) throw Error('unsupported_or_large_file');
 const ext=extname(file).toLowerCase();
 if(['.txt','.md','.csv','.json','.ts','.py'].includes(ext)) {
  const { open }=await import('node:fs/promises'); const handle=await open(file,'r');
  try { const b=Buffer.alloc(8192); const {bytesRead}=await handle.read(b,0,b.length,0); return b.subarray(0,bytesRead).toString('utf8'); } finally { await handle.close(); }
 }
 if(ext==='.pdf') {
  try { const text=await run('pdftotext',['-f','1','-l','2',file,'-'],'',config.timeoutMs); if(text.trim().length>=30) return text; } catch { /* Native OCR is the fallback. */ }
 }
 if(['.pdf','.png','.jpg','.jpeg','.tiff','.heic'].includes(ext)) return run(config.ocr,[file],'',config.timeoutMs);
 throw Error('unsupported_type');
}
export async function inspect(file: string, config: Config): Promise<Proposal> {
 let decision: Decision;
 try { decision=await classify(basename(file),await extract(file,config),config); }
 catch { decision=review('extraction_failed_or_unsupported'); }
 const route=config.routes.find(r=>r.id===decision.route);
 return {file:basename(file),destination:!decision.needsReview && route ? `${route.folder}/${decision.suggestedName}` : null,decision};
}
export async function scan(config: Config): Promise<Proposal[]> {
 const root=await realpath(config.root), inboxPath=resolve(root,'_Inbox');
 if((await lstat(inboxPath)).isSymbolicLink()) throw Error('_Inbox must not be a symlink');
 const inbox=await realpath(inboxPath);
 if(relative(root,inbox)!=='_Inbox') throw Error('Inbox escapes root');
 const proposals: Proposal[]=[];
 for(const entry of (await readdir(inbox,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  if(!entry.isFile() || entry.name.startsWith('.') || /\.(icloud|part|download|crdownload)$/i.test(entry.name)) continue;
  proposals.push(await inspect(resolve(inbox,entry.name),config));
 }
 return proposals;
}
