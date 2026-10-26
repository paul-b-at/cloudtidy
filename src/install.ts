import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { INBOX, repoRoot, type Config } from './config';
import { resolveLayout } from './paths';

export const LABEL = 'at.paul.cloudtidy';
export const plistPath = (home = homedir()) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export interface PlistInput { bun: string; script: string; configPath: string; inbox: string; workDir: string; logDir: string; intervalSec: number; throttleSec?: number }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s: string, pad = '    ') => `${pad}<string>${esc(s)}</string>`;
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
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
${str(join(i.logDir, 'launchd.out.log'), '  ')}
  <key>StandardErrorPath</key>
${str(join(i.logDir, 'launchd.err.log'), '  ')}
</dict>
</plist>
`;
}
export function plistInput(config: Config, configPath: string, inbox: string): PlistInput {
 return { bun: process.execPath, script: resolve(repoRoot, 'src/cli.ts'), configPath: resolve(configPath), inbox, workDir: repoRoot, logDir: config.logDir, intervalSec: config.daemon.intervalSec };
}
export type Exec = (argv: string[]) => Promise<{ code: number; output: string }>;
export const realExec: Exec = async argv => {
 const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
 const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
 return { code, output: `${o}${e}`.trim() };
};
const uid = () => process.getuid?.() ?? 0;
const need = (what: string) => { throw Error(`${what} requires macOS (LaunchAgents). Use "install --print" to inspect the plist on other platforms.`); };
export async function installAgent(config: Config, configPath: string, exec: Exec = realExec, home = homedir()): Promise<string[]> {
 if (process.platform !== 'darwin') need('install');
 const layout = await resolveLayout(config), notes: string[] = [];
 await access(layout.inbox, constants.R_OK).catch(() => { throw Error(`${layout.inbox} does not exist or is unreadable; create the ${INBOX} folder in iCloud Drive first.`); });
 for (const h of [config.classifier, config.ocr]) await access(h, constants.X_OK).catch(() => { throw Error(`helper missing: ${h}. Run: bun run build:helpers`); });
 await mkdir(config.logDir, { recursive: true }); await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
 const file = plistPath(home);
 await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
 await writeFile(file, renderPlist(plistInput(config, configPath, layout.inbox)));
 notes.push(`wrote ${file}`);
 await exec(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]); // not loaded yet is fine
 const r = await exec(['launchctl', 'bootstrap', `gui/${uid()}`, file]);
 if (r.code !== 0) throw Error(`launchctl bootstrap failed: ${r.output}`);
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
