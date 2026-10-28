import { type Item } from './engine';

export interface Counts { moved: number; review: number; duplicate: number; folders: Record<string, number>; /** Route id of the moved file when exactly one file was moved. */ route: string | null }
/** Counts and configured folder names only: never filenames or document contents. */
export function summarize(items: Item[]): Counts {
 const c: Counts = { moved: 0, review: 0, duplicate: 0, folders: {}, route: null };
 for (const i of items) {
  if (i.outcome === 'moved') { c.moved++; c.route = i.route; const top = i.destination.split('/')[0]!; c.folders[top] = (c.folders[top] ?? 0) + 1; }
  else if (i.outcome === 'review') c.review++;
  else if (i.outcome === 'duplicate') c.duplicate++;
 }
 return c;
}
/** "invoices" -> "invoice"; ids that are not plural read as "<id> file". Route ids are configuration, never file content. */
const kindOf = (route: string | null) => !route ? 'file' : route.endsWith('s') && route.length > 3 ? route.slice(0, -1) : `${route} file`;
/**
 * One file: "Sorted invoice into 02_Admin & Finanzen". Several: "Sorted 3 files (01_Uni 2, 02_Admin & Finanzen 1)". Pending files are not announced.
 * Only counts, route ids and configured top-level folder names appear: never file names or contents.
 */
export function message(c: Counts): string | null {
 const parts: string[] = [];
 const buckets = Object.entries(c.folders).sort();
 if (c.moved === 1 && buckets.length === 1) parts.push(`Sorted ${kindOf(c.route)} into ${buckets[0]![0]}`);
 else if (c.moved) parts.push(`Sorted ${c.moved} files (${buckets.map(([f, n]) => `${f} ${n}`).join(', ')})`);
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
