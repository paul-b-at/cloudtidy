import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateConfig, safeName, type Config } from '../src/config';
import { classify, validateResult, heuristics } from '../src/classifier';
import { scan, inspect } from '../src/pipeline';
import { run } from '../src/process';
const base=JSON.parse(await readFile(new URL('../config/default.config.json',import.meta.url),'utf8'));
const config=validateConfig(base);
const good={version:1,route:'invoices',suggestedName:'2026-10_Drei.pdf',needsReview:false};
test('default config validates',()=>expect(config.routes.length).toBe(5));
for(const folder of ['../oops','/tmp/oops','_Archiv/anything','01_Uni/../Shortcuts','01_Uni/.secret','01_Uni/a\\b']) {
 test(`reject route traversal or protected bucket: ${folder}`,()=>expect(()=>validateConfig({...base,routes:[{...base.routes[0],folder}]})).toThrow());
}
test('reject duplicate route IDs',()=>expect(()=>validateConfig({...base,routes:[base.routes[0],base.routes[0]]})).toThrow());
test('reject rename outside invoices/contracts',()=>expect(()=>validateConfig({...base,routes:[{...base.routes[0],rename:true}]})).toThrow());
for(const name of ['../evil.pdf','.hidden.pdf','x/y.pdf','x\\y.pdf','x\u0000.pdf','x:evil.pdf',' foo.pdf']) test(`reject unsafe filename ${JSON.stringify(name)}`,()=>expect(safeName(name)).toBe(false));
test('allow Unicode filename',()=>expect(safeName('ÖGK Rechnung.pdf')).toBe(true));
test('validate invoice result',()=>expect(validateResult(good,'original.pdf',config).suggestedName).toBe('2026-10_Drei.pdf'));
test('preserve university filenames',()=>expect(validateResult({...good,route:'uni'},'sheet.pdf',config).suggestedName).toBe('sheet.pdf'));
for(const raw of [{...good,route:'invented'},{...good,suggestedName:'../../x.pdf'},{...good,suggestedName:'script.sh'},{...good,version:2},{...good,needsReview:'false'},null]) test(`bad model output fails closed: ${JSON.stringify(raw)}`,()=>expect(validateResult(raw,'a.pdf',config).needsReview).toBe(true));
test('uncertain response routes to review',()=>expect(validateResult({...good,needsReview:true},'a.pdf',config).needsReview).toBe(true));
test('specific course number rule',()=>expect(heuristics('sheet.pdf','VO 123.456',config)?.route).toBe('uni'));
test('conflicting rules defer to model',()=>expect(heuristics('sheet.pdf','VO 123.456 Rechnungsnummer 1',config)).toBeNull());
test('broad keywords do not decide',()=>expect(heuristics('a.txt','IBAN schema',config)).toBeNull());
test('empty text fails closed',async()=>expect((await classify('a.txt','',config)).needsReview).toBe(true));
test('missing helper fails closed',async()=>expect((await classify('a.txt','unclear', {...config,classifier:'/nonexistent/classify'})).needsReview).toBe(true));
test('subprocess timeout is enforced',async()=>{await expect(run(process.execPath,['-e','setTimeout(()=>{}, 10000)'],'',30)).rejects.toThrow('helper_timeout');});
test('subprocess output is bounded',async()=>{await expect(run(process.execPath,['-e','process.stdout.write("x".repeat(5000))'],'',5000,100)).rejects.toThrow('helper_output_limit');});
test('mocked Apple contract executes end to end',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloudtidy-'));
 try {
  const helper=join(dir,'classifier');
  await writeFile(helper,`#!/usr/bin/env node\nlet input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const x=JSON.parse(input);if(x.version!==1)process.exit(1);console.log(JSON.stringify({version:1,route:'personal',suggestedName:x.filename,needsReview:false}));});`,{mode:0o755});
  const c={...config,classifier:helper};
  const result=await classify('notes.txt','A short personal note',c);
  expect(result.route).toBe('personal');expect(result.tier).toBe('apple');
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('dry-run leaves source and destination tree untouched',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cloudtidy-'));
 try {
  await mkdir(join(root,'_Inbox')); await mkdir(join(root,'_Inbox','Needs_Review'));
  await writeFile(join(root,'_Inbox','sheet.txt'),'VO 123.456 Exercises');
  await writeFile(join(root,'_Inbox','.stub.icloud'),'');
  await writeFile(join(root,'_Inbox','partial.download'),'not ready');
  await symlink('/etc/passwd',join(root,'_Inbox','link.txt'));
  const before=await readdir(join(root,'_Inbox'));
  const rows=await scan({...config,root});
  expect(rows.length).toBe(1);expect(rows[0]!.destination).toBe('01_Uni/sheet.txt');
  expect(await readdir(join(root,'_Inbox'))).toEqual(before);
  expect(await readFile(join(root,'_Inbox','sheet.txt'),'utf8')).toBe('VO 123.456 Exercises');
  expect(await readdir(root)).toEqual(['_Inbox']);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('reject symlinked inbox',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cloudtidy-'));
 try { await symlink(tmpdir(),join(root,'_Inbox')); await expect(scan({...config,root})).rejects.toThrow('symlink'); }
 finally { await rm(root,{recursive:true,force:true}); }
});
test('unsupported types require review',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cloudtidy-'));
 try { const file=join(root,'archive.zip');await writeFile(file,'not a document');expect((await inspect(file,config)).decision.needsReview).toBe(true); }
 finally {await rm(root,{recursive:true,force:true});}
});
