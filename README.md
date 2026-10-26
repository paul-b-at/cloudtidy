# cloudtidy

Local-first iCloud Drive document classification with Bun + a small Swift Apple Foundation Models helper.

**This first increment is read-only.** It proposes routes and filenames. It cannot move, delete, rename, upload, or install a background service. Existing repository plans describe later phases, not shipped capabilities.

## Requirements

- Apple Intelligence-capable Mac, macOS 26+, Apple Intelligence enabled and its model downloaded.
- Xcode 26+ (or a matching SDK/toolchain providing FoundationModels); select it with `xcode-select` if needed.
- Bun 1.3.2+.
- Optional: `brew install poppler` for PDF text extraction. Native Vision OCR handles scanned PDFs/images and is also the fallback if `pdftotext` is absent.

## Start on your Mac

From the repository root:

```sh
bun install --frozen-lockfile
bun run build:helpers
bun run doctor
bun src/cli.ts classify /absolute/path/to/example.pdf
bun run scan
```

If `_Inbox` does not exist, create it yourself in iCloud Drive before scanning. `doctor` never creates folders. A successful build does not guarantee the model is available; `doctor` checks that separately. Apple model execution must be verified on a real supported Mac; CI only compiles the Swift helpers.

Commands must run from the repository root. To use a fixture folder rather than iCloud, copy `config/default.config.json` to a local file, change `root` to an absolute path containing `_Inbox`, then run:

```sh
bun src/cli.ts scan --dry-run --config /absolute/path/to/test.config.json
```

`scan` without `--dry-run`, move, install, and sweep commands are intentionally unavailable. Output contains filenames and routing suggestions, not document text. Do not publish output containing private filenames.

## Pipeline

1. Scan only regular direct children of `_Inbox`; skip symlinks, folders, hidden files and download placeholders.
2. Read a bounded text excerpt, first two PDF pages, or on-device Vision OCR (German/English).
3. Specific deterministic rules handle obvious university/personal documents. Conflicting signals go to the model.
4. A shell-free subprocess passes a versioned JSON request to the Swift helper on stdin.
5. `SystemLanguageModel.default` generates a schema-constrained route ID, suggested filename and explicit review flag. No network provider or cloud fallback is configured.
6. Bun validates the route, extension, filename and configured taxonomy. Unknown/invalid/uncertain/unavailable results become review proposals with no destination.

Each route ID maps to a complete allowed folder, so the model cannot combine a category with an invalid subcategory. Invoice/contract routes may suggest renames; other routes retain original names. Suggestions can still be semantically wrong: guided generation constrains shape, not truth. Model self-confidence scores are not used.

## Limits and safety

- Treat document text as untrusted. Prompt isolation is not a security boundary. No model tool can access the filesystem.
- Text input to the model is capped at 2,400 JS characters, with a maximum of 32 configured routes. Complex inputs can still exceed model context limits and safely return review.
- Files over 25 MiB and unsupported formats return review. OCR uses at most two PDF pages and bounded image thumbnails; table extraction is not guaranteed.
- Commands execute without a shell. Helpers have time and output limits; failures are not logged with document text.
- This read-only version does **not** promise race-free ingestion of actively syncing files. Only test stable documents. Stability polling and race-resistant no-clobber moves are release gates for the future daemon.
- Review items stay in place. `_Inbox/Needs_Review` is not created or written by this version.
- No background process is installed. LaunchAgent access to Apple Intelligence still needs verification on the actual Mac before daemon work.

## Tests

```sh
bun run typecheck
bun test
```

Tests use temporary roots and a mocked helper. They cover path/filename validation, uncertain/invalid model results, subprocess bounds/timeouts, rule conflicts, symlink exclusion, and a scan that leaves files untouched. Actual Apple inference and OCR cannot be tested in the Linux development environment.

## Before enabling automation

- Build helpers and run `doctor` on the M4 Pro.
- Check at least 20 representative German/English documents, including ambiguous and hostile instructions embedded in documents.
- Record cold/warm latency, classification accuracy, naming correctness, and review rate. Do not assume a latency target has been met.
- Confirm model availability from a logged-in-user LaunchAgent.
- Implement stability checks, locks, validated realpath destination guards, atomic no-clobber behavior, audit history and tested undo.
- Review real dry-run output before enabling moves. Never silently delete duplicates.

See `PLAN.md` for the staged roadmap and `docs/protocol.md` for the helper contract.
