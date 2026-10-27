import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { INBOX, repoRoot, type Config } from './config';
import { resolveLayout } from './paths';
import { ensureLogDir } from './state';

export const LABEL = 'at.paul.cloudtidy';
export const plistPath = (home = homedir()) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export interface PlistInput { bun: string; script: string; configPath: string; inbox: string; workDir: string; logDir: string; intervalSec: number; throttleSec?: number; pdftotext?: string | null }
/** Characters XML 1.0 cannot represent (everything below 0x20 except tab/LF/CR, 0x7f-0x9f is legal but suspicious, lone surrogates, U+FFFE/FFFF). */
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export class PlistError extends Error {}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s: string, pad = '    ') => {
 // A path or config value with a control character would make the plist invalid XML (launchd silently ignores it) or smuggle odd arguments.
 if (XML_INVALID.test(s) || /[\n\r\t\u007f-\u009f]/.test(s)) throw new PlistError('refusing to write the LaunchAgent: a path or value contains a control character');
 return `${pad}<string>${esc(s)}</string>`;
};
/**
 * LaunchAgent: WatchPaths on `_Inbox` (fast reaction) + StartInterval (periodic rescan, catches iCloud arrivals launchd missed).
 * Absolute paths only. `run --daemon` moves files solely when `daemon.apply` is true in the config.
 */
export function renderPlist(i: PlistInput): string {
 return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
${str(LABEL, '  ')}
  <key>ProgramArguments</key>
  <array>
${[i.bun, i.script, 'run', '--daemon', '--config', i.configPath].map(a => str(a)).join('\n')}
  </array>
  <key>WorkingDirectory</key>
${str(i.workDir, '  ')}
  <key>WatchPaths</key>
  <array>
${str(i.inbox)}
  </array>
  <key>StartInterval</key>
  <integer>${i.intervalSec}</integer>
  <key>ThrottleInterval</key>
  <integer>${i.throttleSec ?? 15}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLOUDTIDY_CONTEXT</key>
    <string>launchd</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>${i.pdftotext ? `
    <key>CLOUDTIDY_PDFTOTEXT</key>
${str(i.pdftotext)}` : ''}
  </dict>
  <key>StandardOutPath</key>
${str(join(i.logDir, 'launchd.out.log'), '  ')}
  <key>StandardErrorPath</key>
${str(join(i.logDir, 'launchd.err.log'), '  ')}
</dict>
</plist>
`;
}
/** A path that changes on `brew upgrade bun` (Cellar/<version>) or is not absolute: Full Disk Access and the LaunchAgent would silently break. */
export const isVersionedBunPath = (p: string) => !p.startsWith('/') || /\/Cellar\//.test(p) || /\/bun-v?\d+\.\d+/.test(p) || /\/\d+\.\d+\.\d+\//.test(p);
const executable = (p: string) => access(p, constants.X_OK).then(() => true, () => false);
/**
 * The bun binary the LaunchAgent runs. Stable locations first (`~/.bun/bin/bun` from the official installer, then Homebrew's
 * `/opt/homebrew/bin/bun` symlink), never a versioned Cellar path from `process.execPath`. `override` (install --bun <path>) wins but must be
 * absolute, executable and not versioned.
 */
export async function resolveBunPath(override?: string | null, home = homedir()): Promise<string> {
 if (override) {
  if (!override.startsWith('/')) throw Error(`--bun needs an absolute path (got ${override})`);
  if (isVersionedBunPath(override)) throw Error(`--bun ${override} is a version-specific path that breaks on upgrade; use ~/.bun/bin/bun or /opt/homebrew/bin/bun`);
  if (!(await executable(override))) throw Error(`--bun ${override} is not an executable file`);
  return override;
 }
 for (const p of [join(home, '.bun', 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) if (await executable(p)) return p;
 if (!isVersionedBunPath(process.execPath) && await executable(process.execPath)) return process.execPath;
 throw Error('no stable bun path found (looked for ~/.bun/bin/bun, /opt/homebrew/bin/bun, /usr/local/bin/bun). Install bun from https://bun.sh or pass --bun <absolute path>.');
}
/** Absolute pdftotext path resolved now, because launchd's PATH is minimal. null when poppler is not installed (PDFs fall back to Vision OCR). */
export function resolvePdftotext(): string | null {
 const found = Bun.which('pdftotext');
 return found && found.startsWith('/') ? found : null;
}
export function plistInput(config: Config, configPath: string, inbox: string, bun: string = process.execPath, pdftotext: string | null = null): PlistInput {
 return { bun, script: resolve(repoRoot, 'src/cli.ts'), configPath: resolve(configPath), inbox, workDir: repoRoot, logDir: config.logDir, intervalSec: config.daemon.intervalSec, pdftotext };
}
export interface PlistFacts { bun: string | null; pdftotext: string | null }
/** What the installed LaunchAgent will actually run (doctor): bun path (first ProgramArguments entry) and the pinned pdftotext. */
export async function installedPlist(home = homedir()): Promise<PlistFacts | null> {
 let xml: string; try { xml = await readFile(plistPath(home), 'utf8'); } catch { return null; }
 const un = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
 const bun = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
 const pdf = /<key>CLOUDTIDY_PDFTOTEXT<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
 return { bun: bun === undefined ? null : un(bun), pdftotext: pdf === undefined ? null : un(pdf) };
}
export type Exec = (argv: string[]) => Promise<{ code: number; output: string }>;
export const realExec: Exec = async argv => {
 const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
 const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
 return { code, output: `${o}${e}`.trim() };
};
const uid = () => process.getuid?.() ?? 0;
const need = (what: string) => { throw Error(`${what} requires macOS (LaunchAgents). Use "install --print" to inspect the plist on other platforms.`); };
export async function installAgent(config: Config, configPath: string, exec: Exec = realExec, home = homedir(), opts: { bun?: string | null } = {}): Promise<string[]> {
 if (process.platform !== 'darwin') need('install');
 const layout = await resolveLayout(config), notes: string[] = [];
 await access(layout.inbox, constants.R_OK).catch(() => { throw Error(`${layout.inbox} does not exist or is unreadable; create the ${INBOX} folder in iCloud Drive first.`); });
 for (const h of [config.classifier, config.ocr]) await access(h, constants.X_OK).catch(() => { throw Error(`helper missing: ${h}. Run: bun run build:helpers`); });
 const bun = await resolveBunPath(opts.bun, home), pdftotext = resolvePdftotext();
 const body = renderPlist(plistInput(config, configPath, layout.inbox, bun, pdftotext)); // throws before anything is written if a value is invalid
 await ensureLogDir(config); await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
 for (const f of ['launchd.out.log', 'launchd.err.log']) { const p = join(config.logDir, f); await writeFile(p, '', { flag: 'a', mode: 0o600 }); await chmod(p, 0o600).catch(() => {}); }
 const file = plistPath(home);
 await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
 await writeFile(file, body);
 notes.push(`wrote ${file}`, `bun: ${bun}`, pdftotext ? `pdftotext: ${pdftotext}` : 'pdftotext: not found (PDFs use Vision OCR; brew install poppler, then install again)');
 notes.push(`If the first launchd run cannot read ${INBOX}, grant Full Disk Access to ${bun} (System Settings > Privacy & Security); a bun upgrade at a different path needs the grant again.`);
 await exec(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]); // not loaded yet is fine
 // bootout returns before launchd has fully removed the job; an immediate bootstrap can fail with "Bootstrap failed: 5: Input/output error". Retry briefly.
 let r = await exec(['launchctl', 'bootstrap', `gui/${uid()}`, file]);
 for (let i = 0; r.code !== 0 && i < 4; i++) { await Bun.sleep(500); r = await exec(['launchctl', 'bootstrap', `gui/${uid()}`, file]); }
 if (r.code !== 0) throw Error(`launchctl bootstrap failed: ${r.output}\nIf this persists: launchctl bootout gui/${uid()}/${LABEL}; launchctl enable gui/${uid()}/${LABEL}; then run install again.`);
 notes.push(`loaded ${LABEL}`, config.daemon.apply ? 'daemon apply mode is ON: files are moved automatically' : 'daemon apply mode is OFF (default): the agent only previews; set daemon.apply=true in the config to let it move files');
 return notes;
}
export async function uninstallAgent(exec: Exec = realExec, home = homedir()): Promise<string[]> {
 if (process.platform !== 'darwin') need('uninstall');
 await exec(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]);
 await rm(plistPath(home), { force: true });
 return [`unloaded ${LABEL} and removed ${plistPath(home)} (history, cache and logs are kept)`];
}
export async function agentState(exec: Exec = realExec, home = homedir()): Promise<{ installed: boolean; loaded: boolean; plist: string }> {
 const plist = plistPath(home), installed = await access(plist).then(() => true, () => false);
 const loaded = process.platform === 'darwin' && installed ? (await exec(['launchctl', 'print', `gui/${uid()}/${LABEL}`])).code === 0 : false;
 return { installed, loaded, plist };
}
