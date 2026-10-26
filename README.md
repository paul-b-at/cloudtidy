# cloudtidy

Local-first iCloud Drive document organizer: Bun + strict TypeScript orchestration and small Swift helpers that call **Apple Foundation Models on-device only** (no cloud, no model server, no runtime network access, no third-party runtime dependencies).

**Read-only by default.** Nothing is moved unless you pass `--apply` (or set `daemon.apply: true` for the LaunchAgent). Nothing is ever deleted or overwritten. Everything uncertain, duplicated or failed goes to `_Inbox/Needs_Review`.

> Status: all code is implemented and covered by mocked/sandbox tests on Linux (`bun test`). Apple model inference, Vision OCR, `launchd` and iCloud behaviour have **not** been run yet — they need your Apple-silicon Mac. See [Verify on your Mac](#verify-on-your-mac) and `PLAN.md`.

## Requirements

- Apple-silicon Mac, macOS 26+, Apple Intelligence enabled and its model downloaded.
- Xcode 26+ (macOS 26 SDK; `xcode-select -s` to it).
- Bun 1.3.2+. Optional: `brew install poppler` for PDF text layers (Vision OCR is the fallback).

## Setup

```sh
bun install --frozen-lockfile
bun run build:helpers          # builds + ad-hoc signs bin/classify and bin/ocr (arm64, macOS 26)
bun src/cli.ts doctor          # helpers, model availability, inbox, exclusive rename, LaunchAgent
```

`_Inbox` must exist in iCloud Drive (cloudtidy only creates `_Inbox/Needs_Review` and, when moving, the configured bucket sub-folders below the existing top-level buckets). To test without iCloud, copy `config/default.config.json`, point `root` at a folder containing `_Inbox`, and pass `--config <file>` to every command.

## Commands

All commands run from the repo root as `bun src/cli.ts <command>` (alias `bun run cloudtidy -- <command>`).

| Command | What it does |
| --- | --- |
| `classify <file>` | Classify one file (read-only, any path): route, destination, tier, reason. |
| `scan --dry-run` | Preview what would happen to `_Inbox`. No debounce, lock, cache or state writes. |
| `run [--apply] [--no-cache] [--json]` | One `_Inbox` pass: stability debounce → classify → (with `--apply`) move + audit log. Without `--apply` it only reports. `--daemon` marks a LaunchAgent run (apply is then governed by `daemon.apply`). |
| `review` | Lists `_Inbox/Needs_Review` with the recorded reason per file. |
| `history [--limit N] [--run ID] [--json]` | Append-only JSONL audit log. |
| `undo <runId>` / `undo --last` `[--apply]` | **Preview by default**; `--apply` restores. Restores only if the moved file's hash still matches and the original path is free; never overwrites. Undone content is "held" so the daemon does not immediately re-sort it (`run --no-cache` releases it). |
| `sweep [--apply] [--yes]` | Loose files in the iCloud Drive root. Preview first; `--apply` asks for confirmation (or `--yes`). Never run by the daemon. |
| `install [--print]` / `uninstall` | LaunchAgent `at.paul.cloudtidy` (WatchPaths on `_Inbox` + periodic `StartInterval`). `--print` is side-effect-free and works on Linux. Refuses on non-macOS. `uninstall` keeps history/cache/logs. |
| `status` | LaunchAgent state, last run, whether the model was reachable **from the LaunchAgent context**, lock, history size. |
| `eval <dir> [--expected labels.json] [--json]` | Read-only batch report (see below). |
| `doctor [--json]` | Environment checks. |

### The 20-document evaluation

```sh
bun src/cli.ts eval /path/to/20-docs --expected /path/to/labels.json
```

`labels.json` is a flat JSON object `filename → route id | "review"` (route ids: `uni`, `invoices`, `contracts`, `dev`, `personal`), e.g. `{"bill.pdf":"invoices","scan1.jpg":"review"}`. `eval` never writes into the folder. It reports route distribution, review rate, accuracy vs. labels (wrong auto-routes, auto-routed-but-expected-review, review-instead), per-file proposals, and latency (extraction, rule tier, cold first model call, warm model calls). Include ambiguous, scanned/OCR, German + English, and prompt-injection documents. No latency target is assumed.

### Daemon apply mode

`install` loads a LaunchAgent that runs `run --daemon`. It is **read-only until you edit the config**: set `"daemon": { "apply": true }` and reload (`uninstall`, `install`). Notifications (`daemon.notify`) contain only counts and folder names, never filenames or text. `sweep` can never run from the daemon.

## Pipeline and routing

1. List regular direct children of `_Inbox` (skip dotfiles, `.icloud` placeholders, partial downloads such as `.crdownload`/`.part`/`.tmp`, folders, symlinks, protected names).
2. **Stability debounce:** size + mtime must be unchanged over `debounceMs` (bounded retries); unstable files are skipped until the next trigger.
3. Extract text (plain text, PDF text layer, Vision OCR for scans/images; first two PDF pages; German/English). Empty text → review.
4. **Tier 1 rules** (case-insensitive regexes per route in config; exactly one matching route is definite; conflicts or no match go to the model). Shipped patterns: Notion's four (uni/invoices/contracts/dev) plus conservative personal-document words (Reisepass, Personalausweis, Führerschein, Geburtsurkunde, Meldezettel, Arztbrief, Befundbericht, e-card, Flugticket, Boarding Pass, …). Anything else — tax, bank, unknown — stays with the model or review.
5. **Tier 2 model** (`bin/classify`, protocol v2, `docs/protocol.md`): schema-constrained route ID plus the document's own date/sender and a review flag. Greedy sampling, retry on transient failures, content-hash decision cache. Guardrails may refuse sensitive documents or unsupported languages and structured output cannot use the permissive mode — those go to review by design.
6. **Naming (deterministic, in Bun):** invoices/contracts become `YYYY-MM-DD_<Sender>-<Doctype>.<ext>` only if the model's date **and** sender are both found verbatim in the document text; otherwise the original name is kept. University/dev/personal files keep their names (optional `naming.datePrefix` adds a date prefix only in `04_Persönlich`). The model never supplies a filename, extension or path.
7. **Move** (`--apply`): see below. Each route ID maps to one fully configured folder.

## Safety model

- **On-device only.** No network calls at runtime, no cloud/model-server fallback, no new runtime dependencies. Model output is untrusted: strict key set, route membership, date/sender re-validated against the text.
- **Read-only default.** `run`/`sweep`/`undo` change nothing without `--apply`; the daemon needs `daemon.apply: true`. `scan --dry-run`, `classify`, `eval`, `doctor`, `status`, `install --print` are read-only.
- **Writes are confined** to the configured buckets and `_Inbox/Needs_Review` (plus the state/log directories). Destination paths are realpath-contained; symlinked components are rejected; `_Archiv`, native app containers (`Pages`, `Keynote`, `Numbers`, `Obsidian`, …, extendable via `blocklist`) and any name containing `~` are off limits for source and destination.
- **Atomic no-clobber, same-volume moves** via `renamex_np(RENAME_EXCL)` / `renameat2(RENAME_NOREPLACE)` (through `bun:ffi`; falls back to lstat + `rename` where unavailable). Cross-device (`EXDEV`) → refuse and send to review; **no copy+delete, ever.** Name collisions get ` (n)` suffixes; identical content already at the destination → review (never deleted).
- **Source revalidation** just before moving (fingerprint + sha256), so a file that changed after classification is not moved.
- **Single run at a time** (PID lock with stale detection); idempotent rescans via the content-hash cache.
- **Audit + undo:** every move is appended to `history.jsonl`; `undo` is hash-verified and refuses on mismatch, occupied original, missing file or tampered history.
- **Failures fail closed:** uncertain, failed, unsupported, empty, oversized, unsafe → `_Inbox/Needs_Review` with a recorded reason. Logs contain no document text.

State lives in `~/Library/Application Support/cloudtidy` (history, cache, lock, `status.json`), logs in `~/Library/Logs/cloudtidy` (both configurable).

## Limitations and residual risks

- **Not verified on a Mac yet:** model quality/latency, OCR, `launchd` access to Apple Intelligence, iCloud placeholder behaviour, real EXDEV from an iPhone/iCloud mix.
- LaunchAgents may lack permission to read `~/Library/Mobile Documents` (TCC). If `status` shows the inbox unreadable, grant **Full Disk Access** to the `bun` binary (System Settings → Privacy & Security) and reload.
- iCloud placeholders (`.icloud`) are skipped, not downloaded (`brctl` is not used).
- Unsupported formats (docx, zip, …), files over 25 MiB, and files with no extractable text go to review. Ambiguous slash dates (`03/10/2026`) are never used for naming.
- Lock takeover of a stale lock has a small race window; the non-atomic rename fallback (only if exclusive rename is unavailable) and directory-component TOCTOU (no `openat`) are documented residual risks. `doctor` reports whether exclusive rename works.
- Prompt isolation is not a security boundary; guided generation constrains shape, not truth. Model self-confidence is not used.

## Tests

```sh
bun install --frozen-lockfile && bun run typecheck && bun test
```

Tests use temporary roots, fake helpers and fake models. They cover config validation, naming, rules, hostile model output, symlinks/blocklist/traversal, EXDEV, collisions, duplicates, stability, locking, idempotency, history/undo, sweep, LaunchAgent plist, notifications, `eval`, and the CLI. Apple inference/OCR cannot be tested on Linux. The Swift helpers were compile-checked on Linux against a documentation-based FoundationModels stub only; the real SDK compile happens in `bun run build:helpers` on the Mac.

### Enable CI manually

The GitHub connection used for development cannot write `.github/workflows/*`. Copy `docs/ci-workflow.yml.template` to `.github/workflows/ci.yml` with your own credentials. It runs typecheck + tests on Linux (Bun 1.3.2) and builds/signs the Swift helpers on `macos-26`, with a non-blocking `--check` smoke test.

## Verify on your Mac

```sh
bun install --frozen-lockfile
bun run typecheck && bun test
bun run build:helpers
bun src/cli.ts doctor
bin/classify --check
bun src/cli.ts eval /path/to/20-docs --expected /path/to/labels.json
bun src/cli.ts scan --dry-run
bun src/cli.ts run                 # report only
bun src/cli.ts run --apply         # a few test files first
bun src/cli.ts history && bun src/cli.ts undo --last   # preview, then add --apply
bun src/cli.ts install --print && bun src/cli.ts install
bun src/cli.ts status              # after the first launchd run: model reachable? inbox readable?
```

See `PLAN.md` for status per increment and `docs/protocol.md` for the helper contract.
