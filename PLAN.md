# cloudtidy — Apple Foundation Models implementation plan

Updated for the implementation of increments 3 and 4. Source: [Notion project](https://app.notion.com/p/b7111c0ecd3d4542aacb7044e1de4e3d).

## Approved direction

- Bun + strict TypeScript orchestration, small native Swift helpers.
- Apple Foundation Models **on-device only**; supersedes the former Gemma/Qwen default. No cloud or model-server fallback.
- Inbox first; retain the existing top-level taxonomy. Do not touch native app containers or `_Archiv`.
- Invoice/contract renaming is type-dependent; keep university/code filenames unchanged.
- Test and review dry runs before any autonomous file operation.

## Increment 1 — read-only classifier (done, pending Mac verification)

Config validation, `classify` / `scan --dry-run`, bounded text/PDF/Vision-OCR extraction, rules + schema-constrained Swift classifier, strict validation, review fallback, `doctor`, mocked tests, CI template.

## Increment 2 — real-device verification (PENDING: needs the M4 Pro)

- Build helpers with Xcode 26+, run `doctor`, `bin/classify --check`.
- `eval` on ≥ 20 representative German/English documents with labels: accuracy, review rate, naming correctness, cold/warm latency (tooling implemented; numbers are not).
- Prompt-injection text, OCR-only scans, refusals/guardrails, context overflow, offline use.
- Model reachable from a logged-in-user LaunchAgent (`status` shows it); TCC/Full Disk Access for `bun`.

## Increment 3 — safe ingestion and moves (implemented, tested on Linux)

- Stability debounce with bounded retries; skips dotfiles, `.icloud` placeholders, partial downloads, symlinks, folders.
- PID lock with stale detection; content-hash decision cache (idempotent rescans); bounded classifier retries.
- Realpath containment, symlink-component rejection, blocklist (`_Archiv`, app containers, `~` names).
- Atomic no-clobber same-volume moves (exclusive rename via `bun:ffi`), `(n)` suffixes, duplicate → review, EXDEV → review (never copy+delete); source revalidation before the move.
- Append-only audit history and hash-verified `undo` (preview by default).
- Deterministic naming: model date/sender are used only when found verbatim in the text (protocol v2: the model never supplies a name).
- `run`, `review`, `history`, `undo`, `sweep` (preview + explicit confirmation; never from the daemon).

## Increment 4 — daemon and polish (implemented, pending Mac verification)

- `install`/`uninstall`/`status`: LaunchAgent with `WatchPaths` + periodic `StartInterval`, absolute stable paths, `install --print`.
- Daemon is read-only unless `daemon.apply: true`.
- Batch notifications (counts/folders only) via `osascript` argv.
- Not implemented: iCloud placeholder download (`brctl`), non-Mac installs.

## Deviations from the Notion plan (see README)

- Protocol v2 replaces `suggestedName` with `documentDate`/`sender`.
- Tier-1 patterns for `personal` are an addition (Notion lists four routes' patterns); anything outside them goes to the model/review. The model's guardrails may refuse sensitive documents; structured output cannot use permissive guardrails.
- `undo` previews unless `--apply`.

## Acceptance gate

No claim of production readiness until the helpers have compiled and run on the target Mac, the 20-document evaluation has been reviewed, and the LaunchAgent has been observed to reach the model and read `_Inbox`. CI is build/mock testing, not model-quality validation.

The older detailed plan is preserved at `docs/legacy-plan-2026-10-07.md` as historical context, not current backend guidance.
