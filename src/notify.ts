import { type Item } from './engine';

export interface Counts { moved: number; review: number; duplicate: number; folders: Record<string, number> }
/** Counts and configured folder names only: never filenames or document contents. */
export function summarize(items: Item[]): Counts {
 const c: Counts = { moved: 0, review: 0, duplicate: 0, folders: {} };
 for (const i of items) {
  if (i.outcome === 'moved') { c.moved++; const top = i.destination.split('/').slice(0, -1).join('/'); c.folders[top] = (c.folders[top] ?? 0) + 1; }
  else if (i.outcome === 'review') c.review++;
  else if (i.outcome === 'duplicate') c.duplicate++;
 }
 return c;
}
export function message(c: Counts): string | null {
 const parts: string[] = [];
 if (c.moved) parts.push(`Sorted ${c.moved} ${c.moved === 1 ? 'file' : 'files'} (${Object.entries(c.folders).sort().map(([f, n]) => `${f.split('/').pop()} ${n}`).join(', ')})`);
 const rv = c.review + c.duplicate;
 if (rv) parts.push(`${rv} to Needs_Review`);
 return parts.length ? parts.join(' · ') : null;
}
/** AppleScript receives the text as argv items; nothing is interpolated into the script source. */
export function notificationArgv(text: string, title = 'cloudtidy'): string[] {
 return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', '--', text.slice(0, 240), title];
}
export const notificationsEnabled = () => process.platform === 'darwin' && process.env.NODE_ENV !== 'test' && !process.env.BUN_TEST && !process.env.CLOUDTIDY_NO_NOTIFY;
export async function notify(items: Item[], spawn: (argv: string[]) => Promise<unknown> = async a => { await Bun.spawn(a, { stdout: 'ignore', stderr: 'ignore' }).exited; }, enabled = notificationsEnabled()): Promise<boolean> {
 const text = message(summarize(items));
 if (!enabled || !text) return false;
 try { await spawn(notificationArgv(text)); return true; } catch { return false; }
}
