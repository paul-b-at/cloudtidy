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

```sh
bun src/cli.ts init            # preview: which taxonomy folders are missing
bun src/cli.ts init --yes      # create them (only after iCloud Drive has fully synced!)
```

**Folders.** cloudtidy never creates a top-level bucket (`01_Uni`, `02_Admin & Finanzen`, …) while moving files: on a Mac whose iCloud Drive has not finished syncing, a locally created `04_Persönlich` would later collide with the real one as `04_Persönlich 2`. A file whose bucket is missing goes to `_Inbox/Needs_Review` with reason `bucket_missing`, and `doctor` lists the missing folders. `init` is the only command that creates `_Inbox` and the buckets (plus the configured sub-folders such as `02_Admin & Finanzen/Rechnungen`); it previews by default and `--yes` creates what is missing. **Run it only after iCloud Drive has fully synced** (Finder shows no cloud/progress icons on the folders). Sub-folders inside an existing bucket and `_Inbox/Needs_Review` are still created on demand. Keep this repo (and `bun`) outside `~/Desktop`, `~/Documents`, `~/Downloads` and iCloud Drive: the LaunchAgent would otherwise need extra privacy permissions just to read its own source. To test without iCloud, copy `config/default.config.json`, point `root` at a folder containing `_Inbox`, and pass `--config <file>` to every command.

## Commands

All commands run from the repo root as `bun src/cli.ts <command>` (alias `bun run cloudtidy -- <command>`).

| Command | What it does |
| --- | --- |
| `classify <file>` | Classify one file (read-only, any path): route, destination, tier, reason. |
| `init [--yes]` | Preview (default) or create the missing taxonomy folders (`_Inbox`, the buckets, configured sub-folders). Refuses outside iCloud Drive. |
| `scan --dry-run` | Preview what would happen to `_Inbox` as JSON. Same single debounce as `run`, but no lock, cache or state writes; fails (exit 1) if `_Inbox` is unreadable. |
| `run [--apply] [--no-cache] [--json]` | One `_Inbox` pass: stability debounce → classify → (with `--apply`) move + audit log. Without `--apply` it only reports (user files untouched; it still writes the lock, decision cache and `status.json` in the state dir). `--daemon` marks a LaunchAgent run (apply is then governed by `daemon.apply`). |
| `review` | Lists `_Inbox/Needs_Review` with the recorded reason per file, then the files still *pending* in `_Inbox` (unstable, empty, waiting for the model). |
| `history [--limit N] [--run ID] [--json]` | Append-only JSONL audit log. |
| `undo <runId>` / `undo --last` `[--apply]` | **Preview by default**; `--apply` restores. Restores only if the moved file's hash still matches and the original path is free; never overwrites. Undone content is "held" so the daemon does not immediately re-sort it (`run --no-cache` releases it). |
| `sweep [--apply] [--yes]` | Loose files in the iCloud Drive root. Preview first; `--apply` asks for confirmation (or `--yes`). Never run by the daemon. |
| `install [--print] [--bun <path>]` / `uninstall` | LaunchAgent `at.paul.cloudtidy` (WatchPaths on `_Inbox` + periodic `StartInterval`). bun is `~/.bun/bin/bun` (then `/opt/homebrew/bin/bun`), never a versioned Homebrew Cellar path; `--bun` overrides (absolute, executable, not versioned). `pdftotext` is resolved to an absolute path at install time (the agent's PATH is only `/usr/bin:/bin:/usr/sbin:/sbin`). `--print` is side-effect-free and works on Linux. Refuses on non-macOS. `uninstall` keeps history/cache/logs. |
| `status` | LaunchAgent state, last run, whether the model was reachable **from the LaunchAgent context**, pending count, history size. |
| `eval <dir> [--expected labels.json] [--max-files N] [--json]` | Read-only batch report (see below). |
| `doctor [--json]` | Environment checks, including a real no-clobber rename probe on the iCloud volume, missing buckets, root/bun-path warnings. |

### The 20-document evaluation

```sh
bun src/cli.ts eval /path/to/20-docs --expected /path/to/labels.json
```

`labels.json` is a flat JSON object `filename → route id | "review"` (route ids: `uni`, `invoices`, `contracts`, `admin`, `dev`, `personal`), e.g. `{"bill.pdf":"invoices","scan1.jpg":"review"}`. `eval` skips dotfiles, symlinks, the file passed to `--expected` and any file named `labels.json`, never writes into the folder, stops at 500 files (`--max-files N` changes the cap; the report warns when files were left out) and exits 1 with a clear message if the folder does not exist. It reports route distribution, review rate, accuracy vs. labels (wrong auto-routes, auto-routed-but-expected-review, review-instead), per-file proposals, and latency:

- **Rule-tier routing** (heuristics only, no extraction, no model) is reported on its own, with a **p95 > 10 ms flag** (Notion: Tier 1 "< 5 ms", success criterion "< 10 ms"). Rule hits are final and instant.
- **Naming** of rule hits (deterministic date/sender extraction; the model is only asked for missing fields) is a separate row.
- Extraction, cold first model call and warm model calls are reported separately. "Cold" is the first model call of the `eval` process; reboot or wait for the model to unload for a truly cold number.

Files that would be deferred because the model is unavailable show up as `pending`. Include ambiguous, scanned/OCR, German + English, and prompt-injection documents.

### Daemon apply mode

`install` loads a LaunchAgent that runs `run --daemon`. It is **read-only until you edit the config it was installed with** (`config/default.config.json`, or the copy you passed via `install --config <file>`; the path is baked into the plist): set `"daemon": { "apply": true }`. The config is re-read on every run, so no reload is needed for that; only a changed `daemon.intervalSec` (stored in the plist) needs `uninstall` + `install`. Notifications (`daemon.notify`, title "cloudtidy") read `Sorted invoice into 02_Admin & Finanzen` for one file and `Sorted 3 files (01_Uni 2, 02_Admin & Finanzen 1) · 1 to Needs_Review` for several; they contain route kinds, counts and configured folder names, never filenames or text. `sweep` can never run from the daemon.

**Before you set `daemon.apply: true`:** run `doctor` (every required line ✓, in particular the no-clobber probe on your iCloud volume and "top-level folders exist"), run `init` after iCloud has synced, check `status` after the first launchd run, and enable it on **one Mac only**. Two Macs running `apply` against the same iCloud `_Inbox` race each other: the local no-clobber rename cannot see the other Mac's pending iCloud changes, so the same file may be handled twice or end up as a conflict copy. Apply modes also refuse a `root` outside `~/Library/Mobile Documents/com~apple~CloudDocs` unless the config sets `"allowNonICloudRoot": true`.

## Pipeline and routing

1. List regular direct children of `_Inbox` (skip dotfiles, `.icloud` placeholders, partial downloads such as `.crdownload`/`.part`/`.tmp`, folders, symlinks, protected names).
2. **One shared debounce** (`debounceMs`, default 3 s) for the whole batch: files whose size/mtime changed meanwhile are *pending* (reason `unstable`), as are **empty files** (reason `empty_file`; an empty file that stays unchanged for `emptyGraceMinutes`, default 10, goes to review). Scan, run, review and status report pending files the same way, with a reason; nothing is skipped silently.
3. Extract text (plain text, PDF text layer, Vision OCR for scans/images; first two PDF pages; German/English). Text-less documents → review.
4. **Tier 1 rules** (case-insensitive, Unicode-aware regexes per route; patterns match **whole words**, e.g. `Betrag` does not fire on `Bankbetrag`; German compounds are listed explicitly where wanted, such as `Rechnungsnummer` or `…versicherung`). Exactly one matching route is definite **and final**: no model call decides the route, so a rule hit is instant. Conflicts (two routes match) and no match go to the model. Shipped routes: `uni`, `invoices`, `contracts`, **`admin`** (`02_Admin & Finanzen`: Kontoauszug, Finanzamt, Steuerbescheid, Lohnzettel, Kassenbon, Quittung, Beleg, Receipt; keeps its file names), `dev`, `personal`.
5. **Naming of invoices/contracts is deterministic first.** Bun reads the labelled issue date (`Rechnungsdatum`, `Invoice date`, `Vertragsdatum`, … four-digit year; two different dates under the same label → none) and recognises known senders (`knownSenders` in the config, seeded with Austrian providers such as Drei, A1, Magenta, Wien Energie, ÖBB, Wiener Linien, Wiener Netze, EVN, Verbund, Wiener Städtische, UNIQA, Generali, Allianz) without any model. Only when the date or sender is missing, the model is called with the **route locked** (it can only fill in `documentDate`/`sender`, never change the route); its values count only if they appear in the document text (whole word, ≥ 3 characters or a known sender). If the model ran but nothing validates, the original name is kept. Result: `YYYY-MM-DD_<Sender>-<Doctype>.<ext>`. University/dev/admin/personal files keep their names (`naming.datePrefix`, off by default, adds a date prefix in `04_Persönlich` and `02_Admin & Finanzen`). The model never supplies a filename, extension or path.
6. **Tier 2 model** for rule-less files (`bin/classify`, protocol v2, `docs/protocol.md`): schema-constrained route ID plus date/sender and a review flag. Greedy sampling, content-hash decision cache.
7. **Model unavailable? Defer, don't dump.** Transient failures (model not ready / Apple Intelligence off, timeout, rate limited, helper crash) leave the file **in `_Inbox` as pending** (first seen, attempts, backoff 5/10/20/40/60 min; it is retried at once when the model comes back). This applies to every file that needs the model, including rule hits waiting for date/sender. After `model.maxDeferHours` (default 24) the file goes to `_Inbox/Needs_Review` with the reason `deferred_too_long:<reason>`. Definite answers — refusal, guardrail, unsupported language, invalid output — go to review immediately.
8. **Move** (`--apply`): see below. Each route ID maps to one fully configured folder.

## Safety model

- **On-device only.** No network calls at runtime, no cloud/model-server fallback, no new runtime dependencies. Model output is untrusted: strict key set, route membership, date/sender re-validated against the text.
- **Read-only default.** `run`/`sweep`/`undo` change nothing without `--apply`; the daemon needs `daemon.apply: true`. `scan --dry-run`, `classify`, `eval`, `doctor`, `status`, `install --print` are read-only.
- **Writes are confined** to the configured buckets and `_Inbox/Needs_Review` (plus the state/log directories). Destination paths are realpath-contained; symlinked components are rejected; `_Archiv`, native app containers (`Pages`, `Keynote`, `Numbers`, `Obsidian`, …, extendable via `blocklist`) and any name containing `~` are off limits for source and destination.
- **Atomic no-clobber, same-volume moves** via `renamex_np(RENAME_EXCL)` / `renameat2(RENAME_NOREPLACE)` (through `bun:ffi`). If it is unavailable, cloudtidy **refuses to move** (`atomic_rename_unavailable`, `doctor` fails); the non-atomic lstat + `rename` fallback needs an explicit `CLOUDTIDY_ALLOW_NONATOMIC_RENAME=1`. Cross-device (`EXDEV`) → refuse and send to review; **no copy+delete, ever.** Name collisions get ` (n)` suffixes; identical content already at the destination → review (never deleted).
- **Source revalidation** just before moving (fingerprint + sha256), so a file that changed after classification is not moved.
- **Write-ahead journal.** Every move writes an fsync'd `intent` record before the rename and a `commit` after it (`abort` if it did not happen). If the process dies in between, the next apply run reconciles: a landed move is committed (so `undo` works), an unfinished one is aborted. A move whose journal cannot be written does not happen; a failed commit rolls the file back.
- **Apply only in iCloud Drive.** `run --apply`, daemon apply, `sweep --apply` and `init --yes` refuse a root outside `~/Library/Mobile Documents/com~apple~CloudDocs` unless `allowNonICloudRoot` is true.
- **Single run at a time** (PID lock with stale detection); idempotent rescans via the content-hash cache.
- **Audit + undo:** every move is appended to `history.jsonl`; `undo` is hash-verified and refuses on mismatch, occupied original, missing file or tampered history.
- **Failures fail closed:** uncertain, failed, unsupported, empty, oversized, unsafe → `_Inbox/Needs_Review` with a recorded reason. Logs contain no document text.

State lives in `~/Library/Application Support/cloudtidy` (`history.jsonl`, decision cache, `held.json` for undo holds, `pending.json`, lock, `status.json`), logs in `~/Library/Logs/cloudtidy` (both configurable). The state and log directories are `0700`, history/state/log files `0600` (file names are personal data).

## Limitations and residual risks

- **Not verified on a Mac yet:** model quality/latency, OCR, `launchd` access to Apple Intelligence, iCloud placeholder behaviour, real EXDEV from an iPhone/iCloud mix.
- **`RENAME_EXCL` on iCloud (F-01).** The no-clobber guarantee depends on the filesystem under iCloud Drive honouring `renamex_np(RENAME_EXCL)`. Linux CI cannot prove that; `doctor` probes it on your real `_Inbox` volume (a dot-prefixed `.cloudtidy-probe-*` folder inside `_Inbox`, removed again, only its own files) and fails if it is unsupported. cloudtidy then refuses to move rather than falling back silently.
- **Directory TOCTOU (F-08), accepted.** Bun has no `openat`, so a path component swapped for a symlink between the check and the rename is not prevented; the mover re-checks `realpath` afterwards and rolls the move back, but the window itself remains. Requires a local attacker/process with write access to your iCloud folders.
- **Rules are steerable (F-16), accepted.** A rule hit is final, so text inside a document (including hidden text) can steer its route. Whole-word matching and the "exactly one route matches" requirement limit accidental matches only. Nothing leaves your Mac and nothing is deleted, but a document can end up in the wrong bucket.
- **Two Macs (F-24).** Enable `daemon.apply` on one Mac only (see above).
- **Stale lock.** A crashed run leaves a lock file; it is taken over once its PID is dead (or the lock is old). A live PID is respected.
- **Probe folder.** While `doctor` runs, a hidden `.cloudtidy-probe-*` folder briefly exists in `_Inbox` (iCloud may sync it for a moment); cloudtidy ignores dotfiles.
- **Permissions (TCC).** LaunchAgents may lack permission to read `~/Library/Mobile Documents`. If `status` shows `_Inbox readable: NO`: System Settings → Privacy & Security → Full Disk Access → `+` → press ⌘⇧G and enter the **exact bun path** printed by `install` (`~/.bun/bin/bun`; `doctor` warns if the installed plist points to a versioned or missing binary). Replacing the binary on a bun upgrade may drop the grant; re-run `install` after changing the bun location. Then `launchctl kickstart -k gui/$(id -u)/at.paul.cloudtidy` and re-check `status`. Interactive runs need the same access for your terminal app.
- iCloud placeholders (`.icloud`) are skipped, not downloaded (`brctl` is not used).
- Unsupported formats (docx, zip, …), files over 25 MiB, and files with no extractable text go to review. Ambiguous slash dates (`03/10/2026`) are never used for naming.
- Prompt isolation is not a security boundary; guided generation constrains shape, not truth. Model self-confidence is not used.
- Known-sender spellings with fewer than 3 characters (e.g. `A1`) only count in the first 1,500 characters of a document (letterhead), so a paper size "A1" in the body is not a sender.

## Tests

```sh
bun install --frozen-lockfile && bun run typecheck && bun test
```

Tests use temporary roots (pre-created buckets, `allowNonICloudRoot: true`), fake helpers and fake models. They cover config validation, whole-word rules, deterministic naming, hostile model output, symlinks/blocklist/traversal, EXDEV, collisions, duplicates, the write-ahead journal and crash recovery, missing buckets/`init`, the non-iCloud refusal, deferral/backoff/give-up, empty and unstable files, undo holds, LaunchAgent plist (control characters, bun path), notifications, `eval`, and the CLI. `test/review-*.test.ts` are the guard and regression tests from the safety review. Apple inference/OCR cannot be tested on Linux. The Swift helpers were compile-checked on Linux against a documentation-based FoundationModels stub only; the real SDK compile happens in `bun run build:helpers` on the Mac.

### Enable CI manually

The GitHub connection used for development cannot write `.github/workflows/*`. Copy `docs/ci-workflow.yml.template` to `.github/workflows/ci.yml` with your own credentials. It runs on pushes to `main` and on pull requests (not twice for a PR branch): typecheck + tests on Linux (Bun 1.3.2), and on `macos-26` `bun test` (so `renamex_np` and macOS path behaviour are exercised) plus the Swift helper build/sign, with a non-blocking `--check` smoke test.

## Verify on your Mac

Run from the repo root, in this order. Use a few test files in `_Inbox` for the `run --apply` step.

```sh
bun install --frozen-lockfile
bun run typecheck && bun test
bun run build:helpers
bun src/cli.ts doctor                       # every required line must be ✓ — above all the no-clobber probe on your iCloud volume
bin/classify --check
bun src/cli.ts init                         # preview of missing folders; `init --yes` only after iCloud Drive has fully synced
bun src/cli.ts classify /path/to/one.pdf    # read-only, any file
bun src/cli.ts eval /path/to/20-docs --expected /path/to/labels.json
bun src/cli.ts scan --dry-run               # JSON preview of _Inbox
bun src/cli.ts run                          # report only
bun src/cli.ts run --apply                  # moves everything in _Inbox: keep only test files there
bun src/cli.ts review && bun src/cli.ts history
bun src/cli.ts undo --last                  # preview; add --apply to restore
bun src/cli.ts sweep                        # preview of loose files in the iCloud root; --apply asks to confirm
bun src/cli.ts install --print && bun src/cli.ts install   # optionally: install --bun ~/.bun/bin/bun
bun src/cli.ts status                       # after the first launchd run: model reachable? inbox readable? else grant Full Disk Access to the printed bun path
bun src/cli.ts doctor                       # again, now with the LaunchAgent installed
# only then, on ONE Mac: set "daemon": { "apply": true } in the config; test with a file dropped from your iPhone
bun src/cli.ts uninstall                    # when done testing
```

See `PLAN.md` for status per increment and `docs/protocol.md` for the helper contract.
