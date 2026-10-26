import { access, mkdtemp, rm, writeFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkModel } from './classifier';
import { type Config } from './config';
import { exclusiveRename, exclusiveRenameSupported } from './fsx';
import { agentState, type Exec, realExec } from './install';
import { resolveLayout } from './paths';
import { readStatus } from './state';

export interface Check { name: string; ok: boolean; required: boolean; detail: string }
const ok = (p: string, mode: number) => access(p, mode).then(() => true, () => false);
/** Read-only diagnostics (the exclusive-rename probe uses a temp dir). Never installs or creates anything in iCloud or the state dir. */
export async function doctor(config: Config, exec: Exec = realExec): Promise<Check[]> {
 const checks: Check[] = [], add = (name: string, pass: boolean, required: boolean, detail: string) => checks.push({ name, ok: pass, required, detail });
 const darwin = process.platform === 'darwin', major = Number.parseInt(release(), 10);
 add('macOS 26+', darwin && major >= 25, true, darwin ? `Darwin ${release()}` : `not macOS (${process.platform})`);
 add('classifier helper built', await ok(config.classifier, constants.X_OK), true, config.classifier);
 const model = await checkModel(config);
 add('Apple Foundation Model available', model.available, true, model.reason);
 add('OCR helper built', await ok(config.ocr, constants.X_OK), true, config.ocr);
 add('pdftotext (optional, brew install poppler)', !!Bun.which('pdftotext'), false, Bun.which('pdftotext') ?? 'absent: PDFs fall back to Vision OCR');
 let inboxOk = false, detail = config.root;
 try { const l = await resolveLayout(config); inboxOk = (await lstat(l.inbox)).isDirectory() && await ok(l.inbox, constants.R_OK); detail = l.inbox; } catch { detail = `${config.root}: cannot resolve root/_Inbox`; }
 add('_Inbox readable', inboxOk, true, detail);
 let probe = false;
 try { const d = await mkdtemp(join(tmpdir(), 'cloudtidy-probe-')); try { await writeFile(join(d, 'a'), '1'); await writeFile(join(d, 'b'), '2'); probe = (await exclusiveRename(join(d, 'a'), join(d, 'b'))) === 'exists'; } finally { await rm(d, { recursive: true, force: true }); } } catch { probe = false; }
 add('exclusive no-clobber rename', probe, true, exclusiveRenameSupported() ? 'OS-level (renamex_np / renameat2)' : 'FFI unavailable: lstat+rename fallback (see README: residual risk)');
 let dir = config.stateDir; while (!(await ok(dir, constants.F_OK)) && dirname(dir) !== dir) dir = dirname(dir);
 add('state dir writable', await ok(dir, constants.W_OK), true, config.stateDir);
 const agent = await agentState(exec);
 add('LaunchAgent installed', agent.installed, false, agent.plist);
 add('LaunchAgent loaded', agent.loaded, false, agent.loaded ? 'loaded' : 'not loaded');
 const st = await readStatus(config);
 if (st) {
  add('last run: model reachable', !!st.model?.available, false, `${st.context} run at ${st.time}: ${st.model ? `${st.model.available ? 'available' : 'unavailable'} (${st.model.reason})` : 'not checked'}`);
  add('last run: _Inbox readable', st.inboxReadable, false, `${st.context} context`);
  const launchd = st.context === 'launchd';
  add('LaunchAgent context has reached the model', launchd && !!st.model?.available, false, launchd ? 'verified by a daemon run' : 'no launchd run recorded yet (install, then wait for a run, then re-check status)');
 } else add('LaunchAgent context has reached the model', false, false, 'no run recorded yet');
 return checks;
}
export const formatChecks = (cs: Check[]) => cs.map(c => `${c.ok ? '✓' : c.required ? '✗' : '·'} ${c.name} — ${c.detail}`).join('\n');
