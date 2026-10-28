// Round 9: real-document findings — helper diagnostics, text layer first (Swift: static checks only), OCR smoke test in doctor, textutil, NFC labels in eval.
import { test, expect } from 'bun:test';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelperError, cleanDiag, run } from '../src/process';
import { ExtractError, extract, textutilPath } from '../src/extract';
import { runOnce } from '../src/run';
import { doctor, ocrSmoke, smokePdf, OCR_SMOKE_TEXT } from '../src/doctor';
import { evaluate, parseLabels, formatReport } from '../src/evaluate';
import { model, sandbox, type Sandbox } from './helpers';

const script = async (sb: Sandbox, name: string, body: string) => { const p = join(sb.dir, name); await writeFile(p, `#!/bin/sh\n${body}\n`); await chmod(p, 0o755); return p; };
const NOPDF = '/nonexistent/pdftotext'; // pdftotext absent, as on Paul's Mac
const caught = async (p: Promise<unknown>) => p.then(() => null, e => e as Error);
const withEnv = async (k: string, v: string | undefined, f: () => Promise<void>) => { const old = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; try { await f(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; } };

test('R9 process.run: spawn failure, exit code, signal and the OCR step code become a sanitized diagnostic (never stderr text)', async () => {
 const sb = await sandbox(); try {
  const e1 = await caught(run('/nonexistent/helper', [], '', 2000)) as HelperError; expect(e1).toBeInstanceOf(HelperError); expect(e1.message).toBe('helper_unavailable'); expect(e1.diag).toBe('spawn:ENOENT');
  const fail = (stderr: string) => script(sb, 'f.sh', `echo '${stderr}' >&2; exit 1`);
  expect(((await caught(run(await fail('ocr_failed:pdf_open'), [], '', 2000))) as HelperError).diag).toBe('ocr_failed:pdf_open');
  expect(((await caught(run(await fail('ocr_failed:vision:com.apple.vision.5'), [], '', 2000))) as HelperError).diag).toBe('ocr_failed:vision:com.apple.vision.5');
  expect(((await caught(run(await fail('ocr_failed'), [], '', 2000))) as HelperError).diag).toBe('exit:1');
  const hostile = ((await caught(run(await fail('ocr_failed:../../etc; rm -rf ~ Rechnung Max Mustermann'), [], '', 2000))) as HelperError).diag!;
  expect(hostile).toBe('exit:1'); expect(hostile).not.toMatch(/Mustermann|\//);
  expect(((await caught(run(await script(sb, 'k.sh', 'kill -9 $$'), [], '', 2000))) as HelperError).diag).toBe('signal:SIGKILL');
  expect(cleanDiag('a b/c\n;$(x)é:vision.5|z-1' + 'x'.repeat(200)).length).toBe(80); expect(cleanDiag('a b/c\n;$(x)é:vision.5|z-1')).toBe('abcx:vision.5|z-1');
  expect(((await caught(run(await script(sb, 'slow.sh', 'sleep 5'), [], '', 100))) as HelperError).message).toBe('helper_timeout');
 } finally { await sb.cleanup(); }
});
test('R9 extract: a failing OCR helper gives extraction_failed:ocr:<step>; a timeout stays transient; pdftotext absence is not the failure', async () => {
 const sb = await sandbox(); try {
  const pdf = join(sb.inbox, 'scan.pdf'); await writeFile(pdf, '%PDF-1.4 not really');
  await withEnv('CLOUDTIDY_PDFTOTEXT', NOPDF, async () => {
   const cfg = (ocr: string) => ({ ...sb.config, ocr });
   let e = await caught(extract(pdf, cfg(await script(sb, 'o1.sh', "echo 'ocr_failed:pdf_open' >&2; exit 1")))) as ExtractError; expect(e).toBeInstanceOf(ExtractError); expect(e.reason).toBe('extraction_failed:ocr:pdf_open');
   e = await caught(extract(pdf, cfg(await script(sb, 'o2.sh', "echo 'ocr_failed:vision:com.apple.vision.5' >&2; exit 1")))) as ExtractError; expect(e.reason).toBe('extraction_failed:ocr:vision:com.apple.vision.5');
   // a missing / non-executable / non-file helper is a build problem (HelperError helper_missing -> pending), not an extraction verdict
   for (const [path, state] of [['/nonexistent/bin/ocr', 'missing'], [join(sb.dir, 'noexec'), 'not_executable'], [sb.dir, 'not_a_file']] as const) {
    if (state === 'not_executable') await writeFile(path, '#!/bin/sh\n', { mode: 0o644 });
    const m = await caught(extract(pdf, cfg(path))) as HelperError; expect(m).toBeInstanceOf(HelperError); expect(m.message).toBe('helper_missing'); expect(m.diag).toBe(`ocr:${state}`);
   }
   e = await caught(extract(pdf, cfg(await script(sb, 'o3.sh', 'exit 3')))) as ExtractError; expect(e.reason).toBe('extraction_failed:ocr:exit:3');
   const slow = await caught(extract(pdf, { ...cfg(await script(sb, 'o4.sh', 'sleep 5')), timeoutMs: 150 })); expect(slow).toBeInstanceOf(HelperError); expect((slow as HelperError).message).toBe('helper_timeout');
   expect(await extract(pdf, cfg(await script(sb, 'ok.sh', 'echo "Rechnung Nr. 5 Betrag 10,00"')))).toContain('Rechnung');
  });
 } finally { await sb.cleanup(); }
});
test('R9 run/eval: the diagnostic reaches the review reason (history, review list, eval row) and a timeout is still pending', async () => {
 const sb = await sandbox(); try {
  const ocr = await script(sb, 'o.sh', "echo 'ocr_failed:thumbnail' >&2; exit 1");
  await writeFile(join(sb.inbox, 'a.pdf'), '%PDF-1.4'); await writeFile(join(sb.inbox, 'b.txt'), 'Rechnung Betrag 5');
  await withEnv('CLOUDTIDY_PDFTOTEXT', NOPDF, async () => {
   const cfg = { ...sb.config, ocr };
   const r = await runOnce(cfg, { apply: true, model: model({ route: 'review', needsReview: true }) });
   expect(r.items.find(i => i.file === 'a.pdf')).toMatchObject({ outcome: 'review', reason: 'extraction_failed:ocr:thumbnail' });
   expect(await readdir(sb.review)).toEqual(['a.pdf']);
   await writeFile(join(sb.inbox, 'c.pdf'), '%PDF-1.4');
   const rep = await evaluate(sb.inbox, cfg, null, { model: model({ route: 'review', needsReview: true }) });
   expect(rep.rows.find(x => x.file === 'c.pdf')).toMatchObject({ got: 'review', reason: 'extraction_failed:ocr:thumbnail' });
   expect(formatReport(rep)).toContain('extraction_failed:ocr:thumbnail');
  });
 } finally { await sb.cleanup(); }
});
test('R9 textutil: docx/doc/rtf/odt are converted with textutil (absolute path, UTF-8, bounded); without textutil they stay unsupported_type', async () => {
 const sb = await sandbox(); try {
  const log = join(sb.dir, 'args.txt');
  const fake = await script(sb, 'textutil', `printf '%s\\n' "$@" > '${log}'\nprintf 'Unterhaltserh\\303\\266hung Rechnung Betrag 5'`);
  await withEnv('CLOUDTIDY_TEXTUTIL', fake, async () => {
   expect(textutilPath()).toBe(fake);
   for (const ext of ['docx', 'doc', 'rtf', 'odt', 'DOCX']) {
    const f = join(sb.inbox, `brief.${ext}`); await writeFile(f, 'binary-ish');
    expect(await extract(f, sb.config)).toBe('Unterhaltserhöhung Rechnung Betrag 5');
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['-convert', 'txt', '-encoding', 'UTF-8', '-stdout', f]);
   }
   // end to end: the document text decides the route
   await writeFile(join(sb.inbox, 'schreiben.docx'), 'x');
   const r = await runOnce(sb.config, { apply: false, model: model({ route: 'review', needsReview: true }) });
   expect(r.items.find(i => i.file === 'schreiben.docx')).toMatchObject({ route: 'invoices', tier: 'rule' });
   // failure / bounded output / output cap
   const bad = await script(sb, 'textutil-bad', 'echo boom >&2; exit 2');
   await withEnv('CLOUDTIDY_TEXTUTIL', bad, async () => { expect(((await caught(extract(join(sb.inbox, 'brief.docx'), sb.config))) as ExtractError).reason).toBe('extraction_failed:textutil:exit:2'); });
   const big = await script(sb, 'textutil-big', "yes 'Rechnung ' | head -c 100000");
   await withEnv('CLOUDTIDY_TEXTUTIL', big, async () => { expect((await extract(join(sb.inbox, 'brief.docx'), sb.config)).length).toBe(20000); });
  });
  await withEnv('CLOUDTIDY_TEXTUTIL', 'relative/textutil', async () => { expect(textutilPath()).toBe(process.platform === 'darwin' ? '/usr/bin/textutil' : null); }); // only absolute overrides count
  if (process.platform !== 'darwin') await withEnv('CLOUDTIDY_TEXTUTIL', undefined, async () => {
   expect(textutilPath()).toBeNull();
   expect(((await caught(extract(join(sb.inbox, 'brief.docx'), sb.config))) as ExtractError).reason).toBe('unsupported_type');
  });
  await writeFile(join(sb.inbox, 'x.pages'), 'x'); expect(((await caught(extract(join(sb.inbox, 'x.pages'), sb.config))) as ExtractError).reason).toBe('unsupported_type');
 } finally { await sb.cleanup(); }
});
test('R9 doctor runs a real OCR smoke test on a generated PDF: ok / fails with the diagnostic / wrong text; temp files are removed', async () => {
 const pdf = smokePdf().toString('latin1');
 expect(pdf.startsWith('%PDF-1.4')).toBe(true); expect(pdf).toContain(`(${OCR_SMOKE_TEXT})`); expect(OCR_SMOKE_TEXT.length).toBeGreaterThanOrEqual(30);
 const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]); expect(pdf.slice(xref, xref + 4)).toBe('xref');
 for (const m of pdf.matchAll(/(\d{10}) 00000 n /g)) expect(pdf.slice(Number(m[1]), Number(m[1]) + 7)).toMatch(/^\d 0 obj/);
 const sb = await sandbox(); try {
  const before = (await readdir(tmpdir())).filter(n => n.startsWith('cloudtidy-ocr-')).length;
  const seen = join(sb.dir, 'seen.txt');
  const good = await script(sb, 'good.sh', `head -c 8 "$1" > '${seen}'; echo '${OCR_SMOKE_TEXT}'`);
  expect(await ocrSmoke({ ...sb.config, ocr: good })).toMatchObject({ ok: true }); expect(await readFile(seen, 'utf8')).toBe('%PDF-1.4');
  const bad = await ocrSmoke({ ...sb.config, ocr: await script(sb, 'bad.sh', "echo 'ocr_failed:pdf_open' >&2; exit 1") }); expect(bad.ok).toBe(false); expect(bad.detail).toContain('ocr_failed:pdf_open');
  const gone = await ocrSmoke({ ...sb.config, ocr: '/nonexistent/ocr' }); expect(gone.ok).toBe(false); expect(gone.detail).toContain('spawn:ENOENT'); expect(gone.detail).toContain('build:helpers');
  expect((await ocrSmoke({ ...sb.config, ocr: await script(sb, 'empty.sh', 'true') })).ok).toBe(false);
  expect((await readdir(tmpdir())).filter(n => n.startsWith('cloudtidy-ocr-')).length).toBe(before);
  // doctor: the smoke check only exists when the helper is built; a failing helper is a failed REQUIRED line
  const ex = async () => ({ code: 1, output: '' });
  expect((await doctor({ ...sb.config, ocr: '/nonexistent/ocr' }, ex)).some(c => c.name.startsWith('OCR helper works'))).toBe(false);
  const okChecks = await doctor({ ...sb.config, ocr: good }, ex); expect(okChecks.find(c => c.name.startsWith('OCR helper works'))).toMatchObject({ ok: true, required: true });
  const badChecks = await doctor({ ...sb.config, ocr: await script(sb, 'bad2.sh', 'exit 4') }, ex); expect(badChecks.find(c => c.name.startsWith('OCR helper works'))).toMatchObject({ ok: false, required: true, detail: expect.stringContaining('exit:4') });
 } finally { await sb.cleanup(); }
});
test('R9 eval compares labels and file names in NFC: an NFD file name (APFS) matches an NFC label key and vice versa; conflicts are refused', async () => {
 const sb = await sandbox(); try {
  const nfc = 'Unterhaltserhöhung Paul.txt', nfd = nfc.normalize('NFD'); expect(nfd).not.toBe(nfc);
  await writeFile(join(sb.inbox, nfd), 'Rechnung Betrag 5'); await writeFile(join(sb.inbox, 'plain.txt'), 'Rechnung Betrag 5');
  const stub = { extract: async (f: string) => readFile(f, 'utf8'), model: model({ route: 'review', needsReview: true }) };
  const r1 = await evaluate(sb.inbox, sb.config, parseLabels({ [nfc]: 'invoices', 'plain.txt': 'invoices' }, sb.config), stub);
  expect(r1.unmatchedLabels).toEqual([]); expect(r1.labeled).toBe(2); expect(r1.correct).toBe(2); expect(formatReport(r1)).not.toContain('match no file');
  const r2 = await evaluate(sb.inbox, sb.config, parseLabels({ [nfd]: 'invoices', 'plain.txt': 'invoices' }, sb.config), stub); // NFD key, NFC-saved file system works too
  expect(r2.unmatchedLabels).toEqual([]); expect(r2.correct).toBe(2);
  const r3 = await evaluate(sb.inbox, sb.config, parseLabels({ 'gibt-es-nicht.txt': 'uni' }, sb.config), stub); expect(r3.unmatchedLabels).toEqual(['gibt-es-nicht.txt']);
  expect(() => parseLabels({ [nfc]: 'invoices', [nfd]: 'uni' }, sb.config)).toThrow('conflicting labels');
  expect(Object.keys(parseLabels({ [nfc]: 'invoices', [nfd]: 'invoices' }, sb.config))).toEqual([nfc]);
  expect(Object.keys(parseLabels({ [nfd]: 'invoices' }, sb.config))).toEqual([nfc]);
  expect(() => parseLabels({ a: 'nope' }, sb.config)).toThrow('unknown route');
 } finally { await sb.cleanup(); }
});
test('R9 ocr.swift (cannot be compiled on Linux): text layer first, OCR only below 30 characters, fixed diagnostic vocabulary without paths or document text', async () => {
 const src = await readFile(new URL('../helpers/ocr.swift', import.meta.url), 'utf8');
 expect(src).toContain('$0.string'); expect(src).toContain('let minTextLayer = 30'); expect(src).toContain('layer.count >= minTextLayer');
 expect(src.indexOf('layer.count >= minTextLayer')).toBeLessThan(src.indexOf('recognize(image)'));
 const steps = [...src.matchAll(/Step\("([a-z_]+)"/g)].map(m => m[1]!);
 for (const s of ['usage', 'stat', 'too_large', 'pdf_open', 'locked', 'cgimage', 'vision', 'image_open', 'image_size', 'thumbnail']) expect(steps).toContain(s);
 expect(src).toContain('ocr_failed:'); expect(src).not.toMatch(/standardError\.write\([^)]*(url|path|parts|layer)/);
 expect(src).toContain('prefix(6000)'); expect(src).toContain('25 * 1024 * 1024'); expect(src).toContain('min(document.pageCount, 2)'); expect(src).toContain('120_000_000');
});
test('R9 a missing OCR helper is a build problem: the file stays pending as ocr_helper_missing (not review), is retried at once when the helper appears, and every report says what to do', async () => {
 const sb = await sandbox(); try {
  await writeFile(join(sb.inbox, 'scan.pdf'), '%PDF-1.4');
  await withEnv('CLOUDTIDY_PDFTOTEXT', NOPDF, async () => {
   const missing = { ...sb.config, ocr: join(sb.dir, 'bin-ocr') };
   const r1 = await runOnce(missing, { apply: true, model: model({ route: 'review', needsReview: true }) });
   expect(r1.items[0]).toMatchObject({ outcome: 'pending', reason: 'ocr_helper_missing' }); expect(await readdir(sb.review)).toEqual([]);
   const rendered = (await import('../src/report')).renderReport(r1, true).out.join('\n');
   expect(rendered).toContain('OCR helper'); expect(rendered).toContain('build:helpers');
   // still missing on the very next run: still pending, backoff applies (no extra attempt)
   const r2 = await runOnce(missing, { apply: true, model: model({ route: 'review', needsReview: true }) }); expect(r2.items[0]).toMatchObject({ outcome: 'pending' });
   // helper appears: retried at once (backoff bypassed) and sorted
   const fixed = { ...missing, ocr: await script(sb, 'bin-ocr', 'echo "Rechnung Nr. 7 Zahlungsziel 14 Tage"') };
   const r3 = await runOnce(fixed, { apply: true, model: model({ route: 'review', needsReview: true }) });
   expect(r3.items[0]).toMatchObject({ outcome: 'moved', route: 'invoices' });
  });
  // not executable / a directory: same reason family
  await writeFile(join(sb.inbox, 'scan2.pdf'), '%PDF-1.4 2'); await writeFile(join(sb.dir, 'noexec2'), '#!/bin/sh\n', { mode: 0o644 });
  await withEnv('CLOUDTIDY_PDFTOTEXT', NOPDF, async () => {
   expect((await runOnce({ ...sb.config, ocr: join(sb.dir, 'noexec2') }, { apply: false, model: model() })).items[0]).toMatchObject({ outcome: 'pending', reason: 'ocr_helper_missing:not_executable' });
   await writeFile(join(sb.inbox, 'scan3.pdf'), '%PDF-1.4 3');
   expect((await runOnce({ ...sb.config, ocr: sb.dir }, { apply: false, model: model() })).items.find(i => i.file === 'scan3.pdf')).toMatchObject({ outcome: 'pending', reason: 'ocr_helper_missing:not_a_file' });
  });
 } finally { await sb.cleanup(); }
});
test('R9 a missing classifier helper is reported as classifier_helper_missing (pending); eval prints one prominent warning per missing helper; doctor requires regular executable files', async () => {
 const sb = await sandbox(); try {
  const cfg = { ...sb.config, classifier: join(sb.dir, 'nope-classify'), ocr: join(sb.dir, 'nope-ocr') };
  await writeFile(join(sb.inbox, 'n.txt'), 'Gesprächsnotiz ohne Signalwort');
  expect((await runOnce(cfg, { apply: true })).items[0]).toMatchObject({ outcome: 'pending', reason: 'classifier_helper_missing' });
  const rep = await evaluate(sb.inbox, cfg, null, {});
  expect(rep.helperWarnings).toHaveLength(2); const text = formatReport(rep).split('\n');
  expect(text[0]).toContain('WARNING'); expect(text[1]).toContain('WARNING'); expect(text.join('\n')).toMatch(/OCR helper MISSING[^\n]*PDFs and images[^\n]*build:helpers/); expect(text.join('\n')).toMatch(/classifier helper MISSING/);
  expect(rep.rows[0]).toMatchObject({ got: 'pending', reason: 'classifier_helper_missing' });
  expect((await evaluate(sb.inbox, cfg, null, { extract: async f => readFile(f, 'utf8'), model: model() })).helperWarnings).toEqual([]); // injected doubles: nothing to warn about
  const checks = await doctor({ ...cfg, classifier: sb.dir }, async () => ({ code: 1, output: '' }));
  expect(checks.find(c => c.name === 'classifier helper built')).toMatchObject({ ok: false, detail: expect.stringContaining('not_a_file') });
  expect(checks.find(c => c.name === 'OCR helper built')).toMatchObject({ ok: false, detail: expect.stringContaining('missing') });
 } finally { await sb.cleanup(); }
});
