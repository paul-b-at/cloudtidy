import { spawn } from 'node:child_process';
// No shell, bounded output, enforced timeout. Never log document contents.
export function run(command: string, args: string[], input: string, timeout: number, maxBytes = 32768): Promise<string> {
 return new Promise((resolve,reject) => {
  let done = false, size = 0; const output: Buffer[] = [];
  const child = spawn(command,args,{stdio:['pipe','pipe','pipe']});
  const finish = (error?: Error) => { if(done) return; done=true; clearTimeout(timer); if(error) { child.kill('SIGKILL'); reject(error); } else resolve(Buffer.concat(output).toString('utf8')); };
  const timer=setTimeout(()=>finish(Error('helper_timeout')),timeout);
  child.on('error',()=>finish(Error('helper_unavailable')));
  for (const stream of [child.stdout,child.stderr]) stream.on('data',(data: Buffer)=>{ size+=data.length; if(size>maxBytes) finish(Error('helper_output_limit')); else if(stream===child.stdout) output.push(data); });
  child.stdin.on('error',()=>{}); child.stdin.end(input);
  child.on('close',code=>finish(code===0 ? undefined : Error('helper_failed')));
 });
}
