import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { INBOX, safeName, type Config } from './config';
import { assertApplyAllowed, key, protectedName, type Layout } from './paths';

export interface InitStep { path: string; action: 'create' | 'exists' | 'problem'; detail?: string }
export interface InitPlan { steps: InitStep[]; create: number; problems: number }
/** Every directory cloudtidy expects: `_Inbox`, each route's bucket and the configured sub-folders (all prefixes), deduplicated. */
export function taxonomy(config: Config): string[] {
 const seen = new Map<string, string>(), add = (p: string) => { if (!seen.has(key(p))) seen.set(key(p), p); };
 add(INBOX);
 for (const r of config.routes) { const parts = r.folder.split('/'); for (let i = 1; i <= parts.length; i++) add(parts.slice(0, i).join('/')); }
 return [...seen.values()];
}
async function inspect(layout: Layout, config: Config, rel: string): Promise<InitStep> {
 const parts = rel.split('/'), abs = join(layout.root, ...parts);
 if (parts.some(p => !safeName(p) || protectedName(p, config))) return { path: rel, action: 'problem', detail: 'unsafe or protected name in the configuration' };
 try {
  const s = await lstat(abs);
  if (s.isSymbolicLink()) return { path: rel, action: 'problem', detail: 'is a symlink' };
  if (!s.isDirectory()) return { path: rel, action: 'problem', detail: 'exists but is not a folder' };
  if (key(await realpath(abs)) !== key(abs)) return { path: rel, action: 'problem', detail: 'real path differs (symlinked parent?)' };
  return { path: rel, action: 'exists' };
 } catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path: rel, action: 'create' };
  throw e;
 }
}
/** Read-only: what `init --yes` would create. */
export async function planInit(layout: Layout, config: Config): Promise<InitPlan> {
 const steps: InitStep[] = [];
 for (const rel of taxonomy(config)) {
  const s = await inspect(layout, config, rel);
  // A child of a missing/problem parent is created together with it (or blocked with it).
  steps.push(s);
 }
 return { steps, create: steps.filter(s => s.action === 'create').length, problems: steps.filter(s => s.action === 'problem').length };
}
/**
 * Creates the missing folders, parents first, one `mkdir` each (never recursive, never over an existing entry). Run it only once iCloud Drive
 * has fully synced: a folder created locally before the cloud copy arrives would later appear as "01_Uni 2". Refuses outside iCloud Drive.
 */
export async function applyInit(layout: Layout, config: Config): Promise<InitPlan> {
 await assertApplyAllowed(layout, config);
 const plan = await planInit(layout, config);
 if (plan.problems) throw Error(`init refused: ${plan.steps.filter(s => s.action === 'problem').map(s => `${s.path} (${s.detail})`).join('; ')}`);
 for (const s of plan.steps) if (s.action === 'create') await mkdir(join(layout.root, ...s.path.split('/')), { mode: 0o755 });
 return plan;
}
export const formatInit = (p: InitPlan, applied: boolean) => [
 ...p.steps.map(s => `${(s.action === 'create' ? (applied ? 'created' : 'would create') : s.action === 'exists' ? 'exists' : 'PROBLEM').padEnd(12)} ${s.path}${s.detail ? `  (${s.detail})` : ''}`),
 p.create ? (applied ? `Created ${p.create} folder(s).` : `${p.create} folder(s) missing. Run only after iCloud Drive has fully synced, then: bun src/cli.ts init --yes`) : 'Nothing to create.'
].join('\n');
