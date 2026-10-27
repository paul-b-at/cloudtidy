import { INBOX } from './config';
import { type Item } from './engine';
import { type RunReport } from './run';

/** File names are untrusted: never echo raw control / bidi / invisible characters to a terminal or log (terminal escape injection, spoofing). */
export const show = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, c => `\\u{${c.codePointAt(0)!.toString(16)}}`);
export const INBOX_UNREADABLE = `${INBOX} is not readable (check the path, iCloud sync and Full Disk Access for bun).`;
const HELD = 'held_after_undo';
export const isHeld = (i: Item) => i.detail === HELD;
const HELD_HINT = 'run "run --no-cache --apply" to release them';
export const itemLines = (items: Item[]) => items.map(i => show(`${i.outcome.padEnd(9)} ${i.file}  →  ${i.destination}   [${i.tier}${i.cached ? ', cached' : ''}: ${i.reason}${i.renamed ? ', renamed' : ''}${i.detail ? `, ${i.detail}` : ''}]`));
/** Skipped entries: nothing is listed without `--verbose`; they are only counted (folders, dotfiles, iCloud placeholders, partial downloads, ...), grouped by reason. */
export function skippedLines(skipped: RunReport['skipped'], verbose: boolean): string[] {
 if (verbose) return skipped.map(s => show(`skipped   ${s.name}  (${s.reason})`));
 if (!skipped.length) return [];
 const by = new Map<string, number>();
 for (const s of skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
 return [`skipped   ${[...by].map(([r, n]) => `${n} ${r === 'directory' ? (n === 1 ? 'folder' : 'folders') : r}`).join(', ')} (never touched; --verbose lists them)`];
}
export const budgetLine = (b: NonNullable<RunReport['budget']>) => `time budget reached after ${b.elapsedSeconds}s: ${b.left} file(s) left for the next run`;
/** What `run` prints. A run with nothing to sort is exactly one line, whatever else is in `_Inbox` (dotfiles, placeholders, partial downloads, held files). */
export function renderReport(r: RunReport, apply: boolean, verbose = false): { out: string[]; err: string[] } {
 if (r.locked) return { out: ['Another cloudtidy run holds the lock; nothing done.'], err: [] };
 if (!r.inboxReadable) return { out: [], err: [INBOX_UNREADABLE] };
 const model = r.model ? (r.model.available ? 'model available' : `model UNAVAILABLE: ${r.model.reason}`) : '';
 const head = `${apply ? 'APPLY' : 'DRY-RUN'} ${r.runId}`;
 const held = r.items.filter(isHeld), shown = verbose ? r.items : r.items.filter(i => !isHeld(i));
 const heldLine = `${held.length} file(s) held after an undo, left in place (${HELD_HINT})`;
 if (!verbose && !shown.length && !r.recovered.recovered && !r.recovered.aborted && !r.budget) return { out: [`${head}: nothing to sort${model ? ` (${model})` : ''}${held.length ? `; ${heldLine}` : ''}`], err: [] };
 const out = [`${head}${model ? `   ${model}` : ''}`, ...itemLines(shown)];
 if (!verbose && held.length) out.push(heldLine);
 out.push(...skippedLines(r.skipped, verbose));
 if (r.recovered.recovered || r.recovered.aborted) out.push(`journal: ${r.recovered.recovered} interrupted move(s) recovered, ${r.recovered.aborted} aborted (see "history")`);
 if (r.budget) out.push(budgetLine(r.budget));
 out.push(`counts: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ')}${apply ? '' : '\nNo files were changed. Use --apply to move files.'}`);
 return { out, err: [] };
}
