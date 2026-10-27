import { access, mkdir, rm, rmdir, writeFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { checkModel } from './classifier';
import { oneFileMaxSeconds, worstCaseLockSeconds, type Config } from './config';
import { exclusiveRename, exclusiveRenameSupported, type RenameOptions } from './fsx';
import { agentState, installedPlist, isVersionedBunPath, type Exec, realExec } from './install';
import { INBOX } from './config';
import { isICloudRoot, resolveLayout, type Layout } from './paths';
import { taxonomy } from './init';
import { readStatus, stateFiles } from './state';
import { pendingIntents, readRawHistory } from './history';

/** `warn`: an optional check that failed in a way worth noticing (shown as `!`, not as the neutral `·`). */
export interface Check { name: string; ok: boolean; required: boolean; detail: string; warn?: boolean }
const ok = (p: string, mode: number) => access(p, mode).then(() => true, () => false);
/**
 * No-clobber rename probe on the volume that really matters: a dot-prefixed probe folder inside `_Inbox` (same volume/filesystem as the
 * files that get moved; iCloud may not support RENAME_EXCL the way a temp dir does). Creates and removes only its own files.
 */
export async function probeExclusiveRename(layout: Layout, opts: RenameOptions = {}): Promise<{ ok: boolean; detail: string; native?: boolean }> {
 const dir = join(layout.inbox, `.cloudtidy-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`), a = join(dir, 'a'), b = join(dir, 'b'), c = join(dir, 'c');
 let made = false;
 try {
  await mkdir(dir); made = true;
  await writeFile(a, '1'); await writeFile(b, '2');
  let backend = 'native'; const clash = await exclusiveRename(a, b, { ...opts, onBackend: x => { backend = x; opts.onBackend?.(x); } });
  if (clash !== 'exists') return { ok: false, detail: `RENAME_EXCL not enforced on ${layout.inbox}'s volume (result: ${clash})` };
  const free = await exclusiveRename(a, c, opts);
  if (free !== 'ok') return { ok: false, detail: `exclusive rename into a free name failed (${free})` };
  return { ok: true, native: backend === 'native', detail: backend === 'native' ? `OS-level (renamex_np / renameat2) verified in ${INBOX}` : `WARNING: the NON-ATOMIC lstat+rename fallback is active (CLOUDTIDY_ALLOW_NONATOMIC_RENAME=1); OS-level exclusive rename is NOT verified, a race can overwrite a file. Unset the variable and fix the cause` };
 } catch (e) { return { ok: false, detail: `probe failed: ${(e as NodeJS.ErrnoException).code ?? 'error'} (cannot write to ${INBOX}?)` }; }
 finally { if (made) { for (const f of [a, b, c]) await rm(f, { force: true }).catch(() => {}); await rmdir(dir).catch(() => {}); } }
}
/** Read-only diagnostics except the probe above (own dot-folder in _Inbox, removed again). Never creates taxonomy folders. */
export async function doctor(config: Config, exec: Exec = realExec): Promise<Check[]> {
 const checks: Check[] = [], add = (name: string, pass: boolean, required: boolean, detail: string, warn = false) => checks.push({ name, ok: pass, required, detail, ...(warn ? { warn: true } : {}) });
 const darwin = process.platform === 'darwin', major = Number.parseInt(release(), 10);
 add('macOS 26+', darwin && major >= 25, true, darwin ? `Darwin ${release()}` : `not macOS (${process.platform})`);
 // Apple Foundation Models need Apple silicon, and a bun running under Rosetta (x64) is a different binary for Full Disk Access / the helper's model access.
 const translated = darwin ? (await exec(['/usr/sbin/sysctl', '-n', 'sysctl.proc_translated']).catch(() => ({ code: 1, output: '' }))).output.trim() === '1' : false;
 add('native Apple silicon (arm64, not Rosetta)', process.arch === 'arm64' && !translated, true, `${process.arch}${translated ? ', running under Rosetta: install the arm64 bun (https://bun.sh) and re-run install' : ''}`);
 add('classifier helper built', await ok(config.classifier, constants.X_OK), true, config.classifier);
 const model = await checkModel(config);
 add('Apple Foundation Model available', model.available, true, model.reason);
 add('OCR helper built', await ok(config.ocr, constants.X_OK), true, config.ocr);
 const pdf = process.env.CLOUDTIDY_PDFTOTEXT || Bun.which('pdftotext');
 add('pdftotext (optional, brew install poppler)', !!pdf, false, pdf ? `${pdf} (install pins this absolute path in the LaunchAgent)` : 'absent: PDFs fall back to Vision OCR');
 let inboxOk = false, detail = config.root, layout: Layout | null = null;
 try { layout = await resolveLayout(config); inboxOk = (await lstat(layout.inbox)).isDirectory() && await ok(layout.inbox, constants.R_OK); detail = layout.inbox; } catch (e) { detail = (e as Error).message; } // e.g. `root folder not found: <path>`
 add('_Inbox readable', inboxOk, true, detail);
 if (layout) {
  const icloud = await isICloudRoot(layout);
  add('root is iCloud Drive', icloud || config.allowNonICloudRoot, false, icloud ? layout.root : `${layout.root} is not under ~/Library/Mobile Documents/com~apple~CloudDocs: apply modes will refuse${config.allowNonICloudRoot ? ' (allowNonICloudRoot is true)' : ''}`);
  const missing: string[] = [];
  for (const rel of taxonomy(config)) if (!(await lstat(join(layout.root, rel)).then(s => s.isDirectory() && !s.isSymbolicLink(), () => false))) missing.push(rel);
  add('taxonomy folders exist (buckets, sub-folders, Needs_Review)', missing.length === 0, true, missing.length ? `missing: ${missing.join(', ')}. cloudtidy never creates folders while moving (files whose folder is missing go to review, or stay put if Needs_Review is missing); run "init" after iCloud has fully synced` : `all ${taxonomy(config).length} folders present`);
 }
 const probe = inboxOk && layout ? await probeExclusiveRename(layout) : { ok: false, detail: `needs a readable ${INBOX} on the real volume` };
 add('exclusive no-clobber rename (on the iCloud volume)', probe.ok && probe.native !== false, true, probe.ok ? probe.detail : `${probe.detail}; cloudtidy refuses to move files (non-atomic fallback needs CLOUDTIDY_ALLOW_NONATOMIC_RENAME=1)`);
 let dir = config.stateDir; while (!(await ok(dir, constants.F_OK)) && dirname(dir) !== dir) dir = dirname(dir);
 add('state dir writable', await ok(dir, constants.W_OK), true, config.stateDir);
 const agent = await agentState(exec), plist = agent.installed ? await installedPlist() : null;
 add('LaunchAgent installed', agent.installed, false, agent.plist);
 add('LaunchAgent loaded', agent.loaded, false, agent.loaded ? 'loaded' : 'not loaded');
 if (plist) {
  const bunOk = !!plist.bun && !isVersionedBunPath(plist.bun) && await ok(plist.bun, constants.X_OK);
  add('LaunchAgent bun path is stable', bunOk, false, bunOk ? plist.bun! : `${plist.bun ?? 'missing'} is versioned or no longer exists (brew upgrade?). Re-run: install  (Full Disk Access is granted per binary path)`);
  if (plist.pdftotext) add('LaunchAgent pdftotext path exists', await ok(plist.pdftotext, constants.X_OK), false, plist.pdftotext);
 }
 const dangling = await readRawHistory(stateFiles(config).history).then(r => pendingIntents(r).length, () => -1);
 add('history journal has no unresolved moves', dangling === 0, false, dangling === 0 ? 'clean' : dangling > 0 ? `${dangling} move(s) with a write-ahead intent but no commit/abort (a crash or a failed rollback): the next apply run reconciles them; check "history" and the files` : 'history file unreadable');
 add('run time budget bounds the lock', true, false, `maxRunSeconds ${config.maxRunSeconds}s, checked before each file; one file takes at most ~${oneFileMaxSeconds(config)}s, so the lock is held for at most ~${worstCaseLockSeconds(config)}s (LaunchAgent interval ${config.daemon.intervalSec}s${worstCaseLockSeconds(config) > config.daemon.intervalSec ? `: a long run makes the triggers during it skip` : ''})`);
 const st = await readStatus(config);
 if (st) {
  add('last run: file errors', !(st.counts?.errors), false, st.counts?.errors ? `${st.counts.errors} file(s) ended in an error (rollback_failed, folder_missing for Needs_Review, history/io): see the log and "review"/"history"` : 'none', true);
  add('last run: model reachable', !!st.model?.available, false, `${st.context} run at ${st.time}: ${st.model ? `${st.model.available ? 'available' : 'unavailable'} (${st.model.reason})` : 'not checked'}`);
  add('last run: _Inbox readable', st.inboxReadable, false, `${st.context} context`);
  const launchd = st.context === 'launchd';
  add('LaunchAgent context has reached the model', launchd && !!st.model?.available, false, launchd ? 'verified by a daemon run' : 'no launchd run recorded yet (install, then wait for a run, then re-check status)');
 } else add('LaunchAgent context has reached the model', false, false, 'no run recorded yet');
 return checks;
}
export const formatChecks = (cs: Check[]) => cs.map(c => `${c.ok ? '✓' : c.required ? '✗' : c.warn ? '!' : '·'} ${c.name} — ${c.detail}`).join('\n');
