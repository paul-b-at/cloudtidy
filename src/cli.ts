import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, record } from './config';
import { inspect, scan } from './pipeline';
import { run } from './process';
const usage='Usage: bun src/cli.ts doctor | classify <file> | scan --dry-run [--config <file>]';
async function main() {
 const args=process.argv.slice(2); const idx=args.indexOf('--config'); let file='config/default.config.json';
 if(idx>=0) { if(!args[idx+1]) throw Error(usage); file=args[idx+1]!; args.splice(idx,2); }
 const c=await loadConfig(file);
 if(args[0]==='scan' && args.length===2 && args[1]==='--dry-run') { console.log(JSON.stringify({dryRun:true,proposals:await scan(c)},null,2)); return; }
 if(args[0]==='classify' && args.length===2) { console.log(JSON.stringify(await inspect(resolve(args[1]!),c),null,2)); return; }
 if(args[0]==='doctor' && args.length===1) {
  const checks: Record<string,boolean>={macOS:process.platform==='darwin'};
  try { const x: unknown=JSON.parse(await run(c.classifier,['--check'],'',c.timeoutMs)); checks.appleModel=record(x) && x.version===1 && x.available===true; } catch { checks.appleModel=false; }
  try { await access(c.ocr,constants.X_OK); checks.ocrHelper=true; } catch { checks.ocrHelper=false; }
  try { await access(resolve(c.root,'_Inbox'),constants.R_OK); checks.inboxReadable=true; } catch { checks.inboxReadable=false; }
  console.log(JSON.stringify({checks,note:'Doctor does not install or modify anything. PDF text extraction can fall back to native OCR.'},null,2));
  if(Object.values(checks).some(v=>!v)) process.exitCode=1; return;
 }
 throw Error(usage);
}
main().catch(e=>{console.error(e instanceof Error ? e.message : 'cloudtidy failed');process.exitCode=1;});
