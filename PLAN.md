# cloudtidy — Apple Foundation Models implementation plan

Updated after the safety and Notion-conformance review fixes (round 6). Source: [Notion project](https://app.notion.com/p/b7111c0ecd3d4542aacb7044e1de4e3d).

## Approved direction

- Bun + strict TypeScript orchestration, small native Swift helpers.
- Apple Foundation Models **on-device only**; supersedes the former Gemma/Qwen default. No cloud or model-server fallback.
- Inbox first; retain the existing top-level taxonomy. Do not touch native app containers or `_Archiv`.
- Invoice/contract renaming is type-dependent; keep university/code filenames unchanged.
- Test and review dry runs before any autonomous file operation.

## Increment 1 — read-only classifier (done, pending Mac verification)

Round 9: PDF text layer via PDFKit before Vision OCR, short helper diagnostics in review reasons, a missing helper keeps files pending (`ocr_helper_missing` / `classifier_helper_missing`), doctor OCR smoke test, `textutil` for .docx/.doc/.rtf/.odt, NFC label matching in `eval`.
Round 10 (real-document tuning): `invoices` loses `IBAN`/`Betrag`/`Beträge` (court letters and contracts contain them) and gains `Zahlungsaufforderung`; `Mahnung` stays out (model decides). `uni` gains Übungsblatt/Exercise sheet/Assignment N/Lecture notes/Johannes Kepler/Moodle. `admin` evidence gains courts (`…gericht…`), `Beschluss`, `Polizei…`, `Unfallbericht`/`Unfallmeldung`, `Landesregierung` (merged into alternations: 14 of 16 entries) and the admin description names courts, police and accident reports. Four new fixtures (32 total).

Config validation, `classify` / `scan --dry-run`, bounded text/PDF/Vision-OCR extraction, rules + schema-constrained Swift classifier, strict validation, review fallback, `doctor`, mocked tests, CI template.

## Increment 2 — real-device verification (PENDING: needs the M4 Pro)

- Build helpers with Xcode 26+, run `doctor`, `bin/classify --check`.
- `eval` on ≥ 20 representative German/English documents with labels: accuracy, review rate, cold/warm latency (tooling implemented; numbers are not). Naming is only shown as a proposed name per file, not scored.
- `bun run eval:fixtures` first, right after the helper build (32 synthetic DE/EN documents incl. 7 prompt-injection ones; exit 0 required: 1 = unsafe output / successful injection, 2 = documents not evaluated), then the 20 real documents.
- Prompt-injection text, OCR-only scans, refusals/guardrails, context overflow, offline use.
- Model reachable from a logged-in-user LaunchAgent (`status` shows it); TCC/Full Disk Access for `bun`.

## Increment 3 — safe ingestion and moves (implemented, tested on Linux)

- One shared stability debounce; unstable and empty files are *pending* with a reason (empty past a grace period → review); skips dotfiles, `.icloud` placeholders, partial downloads, symlinks, folders.
- PID lock with stale detection; content-hash decision cache (idempotent rescans); bounded classifier retries.
- Realpath containment, symlink-component rejection, blocklist (`_Archiv`, app containers, `~` names).
- Atomic no-clobber same-volume moves (exclusive rename via `bun:ffi`), `(n)` suffixes, duplicate → review, EXDEV → review (never copy+delete); source revalidation before the move.
- Append-only audit history with a write-ahead journal (fsync'd intent/commit/abort + crash reconciliation) and hash-verified `undo` (preview by default); undo holds in their own store.
- The mover never creates ANY folder (bucket, sub-folder or `_Inbox/Needs_Review`): a missing destination → review with `folder_missing:<relative path>`; a missing `Needs_Review` → the file stays in `_Inbox` and the run reports an error. `init [--yes]` creates the full taxonomy; `doctor` checks all of it. Apply modes only run inside iCloud Drive unless `allowNonICloudRoot`.
- Deterministic naming first (labelled issue date; known senders matched case-sensitively, ordinary-word senders such as Drei/Magenta/Verbund/Allianz only with a company suffix or alone on a letterhead line; a stated `Absender:` line beats a bare hit; look-alike senders rejected by a Latin-letters allowlist); the model only fills missing date/sender with the route locked, and its values are used only when found in the text (protocol v2: the model never supplies a name).
- Transient model failures defer files in `_Inbox` as pending (backoff 5–60 min). Review only after `model.maxDeferHours` since the first **apply-mode** attempt, ≥ 3 apply-mode attempts and a final failed attempt in the current run (dry-runs never start the clock); a per-run circuit breaker limits the cost of a hung model. Real helper calls for that file in that run and the file's own extraction timeouts count as attempts (a busy final call is an attempt but never a review); files answered by an open breaker count nothing, and an expired file bypasses the breaker for exactly one real call (no retries). Definite failures review immediately with their specific reason (`model_refusal`, `model_guardrail`, `model_unsupported_language`, `model_context_overflow`, `model_invalid_output`, …), except on a rule hit: the rule's route and the original name are kept and the naming reason is recorded.
- Bounded runs: `maxRunSeconds` (default 300; 60–3600) is checked before each file; files not started are left untouched and reported in one line; worst-case lock hold = budget + one file's maximum (shown by `status`/`doctor`). Quiet daemon log: a run with nothing to sort is one line; skipped/held files are only counted (`--verbose` lists them). Previews show `folder_missing:<path>` reviews like `--apply`.
- State files are validated entry by entry (`pending.json`, `held.json`, cache); a failed rollback is journaled (never an unjournaled file); logs from launchd are rotated by size (5 MB × 3).
- `run`, `review`, `history`, `undo`, `sweep` (preview + explicit confirmation; never from the daemon).

## Increment 4 — daemon and polish (implemented, pending Mac verification)

- `install`/`uninstall`/`status`: LaunchAgent with `WatchPaths` + periodic `StartInterval`, absolute stable paths, `install --print`.
- Daemon is read-only unless `daemon.apply: true`.
- Notifications (kind/counts/folders only) via `osascript` argv: `Sorted invoice into 02_Admin & Finanzen`, or a batch line.
- Stable bun path in the plist (never a versioned Cellar path), minimal PATH, absolute `pdftotext`; `doctor` probes `RENAME_EXCL` on the iCloud volume and warns about a stale plist.
- Not implemented: iCloud placeholder download (`brctl`), non-Mac installs.

## Mapping to the Notion plan

| Notion phase | Status here |
| --- | --- |
| 0 Scaffolding, dry-run CLI, collisions | implemented (Linux-tested) |
| 1 Extraction, Vision OCR, Tier-1 rules | implemented: whole-word Unicode rules, instant final rule hits, `bank`/`tax`/`receipts` routes (`admin` root is model-only); "20 real sample files" pending (Mac) |
| 2 Foundation Models classifier | implemented against a doc-based stub (Swift 5 and 6 compile, exit-code matrix); real compile/inference, 20-doc dry-run review, LaunchAgent model access and Gemma comparison (optional) pending (Mac) |
| 3 launchd, 3 s debounce, notifications | implemented (one shared 3 s debounce, `Sorted invoice into 02_Admin & Finanzen`-style notifications); installed behaviour and the iPhone → Mac flow pending (Mac) |
| 4 sweep, date-prefix option, audit log | implemented (date prefix for `04_Persönlich`, `02_Admin & Finanzen` and its Bank/Steuern/Belege sub-folders, off by default; JSONL write-ahead audit log) |

## Deviations from the Notion plan (see README)

- Protocol v2 replaces `suggestedName` with `documentDate`/`sender` and adds an optional `lockedRoute`; transient failures use their own exit code (4 for rate limited/concurrent requests).
- Tier-1 patterns for `personal` are an addition (Notion lists four routes' patterns); anything outside them goes to the model/review. The model's guardrails may refuse sensitive documents; structured output cannot use permissive guardrails.
- Admin documents are split into sub-folders (Round 7, decided by Paul): `bank` → `02_Admin & Finanzen/Bank`, `tax` → `…/Steuern`, `receipts` → `…/Belege` (names kept, conservative whole-word patterns), and `admin` stays the `02_Admin & Finanzen` root with **no patterns** (model-only: authorities, SVS/ÖGK, official notices). Overlapping matches (two routes) go to the model. Round 8: routes may carry `evidence` patterns; a model answer for such a route (default: only `admin`) is accepted only when the document matches one of them, else review `model_route_unverified:<id>` (evidence is never Tier 1). Reason: a real-model eval showed the model-only root being chosen for an injection that merely said "admin". `init --yes` creates the three new folders for an existing setup; configs are replaced, not merged (see README upgrade note).
- Patterns match whole words (Unicode aware) instead of free substrings, so `Betrag` no longer fires on `Bankbetrag`; German compounds that should match are listed explicitly.
- A rule hit is final and instant (no model check of the route). Notion's "model must confirm" step is replaced by "exactly one route matches"; the cost is that hidden document text can steer a rule route (accepted risk, documented).
- Invoice/contract naming does not need the model when the labelled date and a known or stated sender (`Absender:`) are in the text; the model is only asked for what is missing (route locked). A rule hit is therefore instant for routing; naming latency is reported separately by `eval`.
- Files are never put into `Needs_Review` just because the model is temporarily unavailable: they wait in `_Inbox` as pending and are only reviewed after `model.maxDeferHours` (24 h) of *apply-mode* attempts, at least 3 of them, and one more failed attempt (see README step 7).
- cloudtidy does not create any folder while moving (`folder_missing:<path>` → review); `cloudtidy init` creates the taxonomy (buckets, sub-folders, `_Inbox/Needs_Review`) explicitly, after iCloud has synced. Notion's "sub-folders `Rechnungen/`, `Verträge/` are created" is therefore done by `init`, not on demand.
- Defaults `daemon.intervalSec: 120` and `stabilityRetries: 2` (shared window) replace the original 600 s / 0 so that "sorted within seconds" holds for files that are still being written and leftover waits stay about two minutes.
- The `Sozialversicherung…` compound, `Versicherungsnummer` and `Versicherungsdaten…` are excluded from the contracts rule; senders that are only stop-words (`Die`, `Re`, `An`, `Sehr`, …) never count.
- `undo` previews unless `--apply`.
- Route IDs (`uni`, `invoices`, `contracts`, `bank`, `tax`, `receipts`, `admin`, `dev`, `personal`) replace the Notion JSON's category/subcategory pair; each ID maps to one configured folder.
- Notifications are single-file (`Sorted invoice into 02_Admin & Finanzen`) or batched counts (`Sorted 2 files (01_Uni 1, 02_Admin & Finanzen 1) · 1 to Needs_Review`); never filenames.
- Moves, sweep, undo and the LaunchAgent are implemented although the Notion page still describes the first increment as read-only; the review gate before `run --apply` / `daemon.apply` is a documented process, not enforced in code.

## Accepted and documented residual risks

F-08 directory-component TOCTOU (no `openat` in Bun); F-16 steerable rules (a rule hit is final); F-24 `daemon.apply` on one Mac only; F-01 iCloud's `RENAME_EXCL` support can only be proven by `doctor` on the Mac; stale-lock takeover; the transient `.cloudtidy-probe-*` folder in `_Inbox` while `doctor` runs; TCC/Full Disk Access is per bun path (with Homebrew the resolved Cellar binary, so `brew upgrade bun` can drop the grant); macOS 14+ dataless files under their real name are not detected (Mac-only, F-07).

## Acceptance gate

No claim of production readiness until the helpers have compiled and run on the target Mac, the 20-document evaluation has been reviewed, and the LaunchAgent has been observed to reach the model and read `_Inbox`. CI is build/mock testing, not model-quality validation.

The older detailed plan is preserved at `docs/legacy-plan-2026-10-07.md` as historical context, not current backend guidance.

## Known follow-ups (round 6 reviews, not fixed)

- L3: a permanently symlinked launchd log warns on every run (~every 2 min) and never rotates; warn once per day or rotate the other file.
- L4: the time budget is checked only in `plan()`; planning finishes before the first move, so a kill during planning loses the whole pass (safe: moves revalidate). An apply-as-you-go loop would make progress incremental.
- L8: `sha256File` runs before any per-file timeout, so one huge or iCloud-evicted file can exceed the "lock held ≤ budget + one file" figure printed by `doctor`.
- Naming (round 6d, known): a lone `Drei`-style line in the first 6 non-empty lines forces that sender (mislabel only); a rejected `Absender:` does not fall through to `Sender:`/`From:`.
