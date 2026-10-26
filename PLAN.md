# cloudtidy — Apple Foundation Models implementation plan

Updated 26 October 2026. Source: [Notion project](https://app.notion.com/p/b7111c0ecd3d4542aacb7044e1de4e3d).

## Approved direction

- Bun + strict TypeScript orchestration, small native Swift helpers.
- Apple Foundation Models **on-device only**; supersedes the former Gemma/Qwen default. No cloud or model-server fallback.
- Inbox first; retain the existing top-level taxonomy. Do not touch native app containers or `_Archiv`.
- Invoice/contract renaming is type-dependent; keep university/code filenames unchanged.
- Test and review dry runs before any autonomous file operation.

## Increment 1 — implemented in this PR, pending Mac verification

- Bun configuration validation and a read-only `classify` / `scan --dry-run` CLI.
- Bounded text extraction, optional PDF text layer extraction, native Vision OCR helper.
- Conservative rules, schema-constrained Swift classifier, strict output validation, review fallback.
- `doctor`, mocked tests, and a CI template for typecheck/tests plus macOS 26 Swift compilation. Workflow activation needs a manual commit because the GitHub connection cannot write workflow files.
- No move/delete/rename command, LaunchAgent installation or drive sweep.

## Increment 2 — real-device verification (not complete)

- Build Swift helpers with Xcode 26+, run doctor and confirm model availability.
- Evaluate at least 20 representative German/English documents on the M4 Pro.
- Record false routes, review rate, naming accuracy, cold and warm latency.
- Test prompt injection text, OCR-only scans, refusals, context overflow and offline use.
- Verify execution in a logged-in-user LaunchAgent context; do not assume hosted CI can run Apple Intelligence.
- Optional comparison against Gemma if already available, not an added runtime dependency.

## Increment 3 — safe ingestion and moves (not implemented)

- File stability polling and safe handling of iCloud placeholders/downloads.
- Per-process locking, idempotent rescan and bounded retry behavior.
- Race-resistant filesystem validation: realpath containment, symlink rejection, app-container blocklist.
- Atomic no-clobber moves with collision suffixes; never overwrite/delete silently.
- Audit history and hash-verified undo implemented and tested before enabling moves.
- Explicit review of dry-run proposals; uncertain files go to review, not guessed destinations.
- Deterministic validation of model-suggested dates/senders or retain original names.

## Increment 4 — daemon and polish (not implemented)

- User LaunchAgent with WatchPaths plus periodic rescan, stable executable path, permission diagnostics.
- Native batch notifications without document contents.
- Inbox-only first; later root sweep requires a preview and explicit confirmation.
- Keep historical archive and native application containers permanently off limits.

## Acceptance gate

No claims of production readiness until model/OCR helpers have compiled and executed on the target Mac, fixture results are reviewed, and moving/undo safety tests pass. CI is build/mock testing, not model-quality validation. See README for commands and remaining limitations.

The older detailed plan is preserved at `docs/legacy-plan-2026-10-07.md` as historical context, not current backend guidance.
