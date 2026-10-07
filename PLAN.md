# cloudtidy — Implementation Plan

Source spec: [cloudtidy — semantic iCloud organizer](https://app.notion.com/p/b7111c0ecd3d4542aacb7044e1de4e3d) (Notion, status: Planned).

cloudtidy is a local-first Bun + TypeScript CLI that a macOS LaunchAgent wakes whenever `iCloud Drive/_Inbox` changes. For each file it extracts text (PDF text layer or on-device Vision OCR), classifies it with a regex heuristics tier and a local-LLM fallback tier, renames it according to type, and moves it into one of the top-level buckets without ever overwriting anything.

## Locked decisions (from the spec)

- **Naming is type-dependent.** Invoices and contracts become `YYYY-MM-DD_Sender.pdf` (e.g. `2026-10-12_Drei-Rechnung.pdf`); uni documents, code and assets keep their original name.
- **LLM backend is local only** (Ollama or llama.cpp on the M4 Pro, Gemma / Qwen). No document text ever leaves the machine.
- **Inbox first.** v1 only processes `_Inbox`. The sweep over existing loose files is Phase 4.
- **Runtime:** Bun + strict TypeScript. **Trigger:** `launchd` `WatchPaths`.

## Taxonomy

Root: `~/Library/Mobile Documents/com~apple~CloudDocs/`

| Bucket | Subfolders (proposed) |
| --- | --- |
| `01_Uni` | (flat; optional per-course subfolders later) |
| `02_Admin & Finanzen` | `Rechnungen`\*, `Verträge`\*, `Steuer`, `Bank` |
| `03_Projekte & Dev` | (flat) |
| `04_Persönlich` | `Gesundheit`, `Reisen`, `Dokumente` |
| `_Archiv` | never written by the daemon |
| `_Inbox` | watched dropzone; `_Inbox/Needs_Review/` for low-confidence items and `Needs_Review/duplicates/` for exact duplicates |

\* Named in the spec. The other subfolders are proposals and live in config, so they can change without code changes.

The LLM may only pick a subcategory from the configured list. Letting it make up folder names would grow the folder tree out of control.

## Repository layout

```text
cloudtidy/
  src/
    cli.ts               # entry: `run`, `scan --dry-run`, `sweep`, `undo`, `install`, `doctor`
    config.ts            # load + validate config (zod), defaults, path resolution
    paths.ts             # iCloud root, bucket resolution, container blocklist guard
    scanner.ts           # list candidate files in _Inbox (non-recursive)
    stability.ts         # .icloud stub detection, size/mtime stability check, download trigger
    extract/
      index.ts           # dispatch by file type
      pdf.ts             # text layer via pdftotext (fallback: unpdf)
      text.ts            # .txt/.md/.csv/.json head read
      ocr.ts             # spawn the Swift Vision helper
    classify/
      heuristics.ts      # Tier 1: weighted regex rules -> {category, sub, score}
      llm.ts             # Tier 2: Ollama /api/chat with JSON-schema `format`
      index.ts           # routing: tier 1 -> tier 2 -> Needs_Review
    naming.ts            # type-dependent rename, date + sender extraction, sanitizing
    mover.ts             # collision-safe move, lock, history append
    history.ts           # JSONL audit log + undo
    notify.ts            # osascript `display notification`
    log.ts               # structured logging to ~/Library/Logs/cloudtidy/
  helpers/
    ocr.swift            # Vision + PDFKit OCR helper, compiled with swiftc
  launchd/
    at.paul.cloudtidy.plist.tmpl
  config/
    default.config.json
  test/
    fixtures/            # anonymized sample PDFs, images, text files
    *.test.ts
```

Runtime files live outside the repo:

- Config: `~/.config/cloudtidy/config.json`, which overrides `config/default.config.json`.
- History: `~/Library/Application Support/cloudtidy/history.jsonl`.
- Logs: `~/Library/Logs/cloudtidy/cloudtidy.log`. The plist's stdout and stderr also go there.

## Phases

### Phase 0 — Scaffolding and dry-run CLI

1. `bun init`, strict `tsconfig` (`strict`, `noUncheckedIndexedAccess`), Biome or ESLint, and `bun test`.
2. `config.ts`: a zod schema for the root path, buckets, subfolders, blocklist, thresholds and LLM endpoint/model. Every path can be overridden so tests can point the root at a temp directory.
3. `paths.ts` safety guard: one `assertWritable(target)` that every move passes through. It throws unless `target` resolves (after `realpath` and Unicode NFC normalization) inside one of the configured buckets or `_Inbox/Needs_Review`. It also hard-rejects anything under app containers (`com~apple~*` siblings, `Obsidian`, `Shortcuts`, `Pages`, `Keynote`, `Numbers`, `Goodnotes`, …).
4. `scanner.ts`: list only the direct children of `_Inbox`. Skip dotfiles, `*.icloud` stubs, directories (including `Needs_Review`) and partial-download markers.
5. `mover.ts`: a no-clobber move. Check whether the target exists, and on collision append ` (2)`, ` (3)`, … before the extension. If the bytes are identical (same size and sha256), treat it as a duplicate: move the source to `_Inbox/Needs_Review/duplicates/` and record it in the history log, so it can still be undone. Never delete. Use a process lockfile so a manual run and the daemon never run at the same time.
6. `cloudtidy scan --dry-run` prints a table of source, target and reason, and touches nothing.

**Done when** the dry run against a temp-dir fixture tree prints the right targets, and the tests prove that a collision never overwrites and that a blocklisted target throws.

### Phase 1 — Extraction and Tier 1 heuristics

1. `extract/pdf.ts`: `pdftotext -l 2 file -` (poppler from Homebrew) for the first two pages, with `unpdf` as the pure-JS fallback. Avoid `pdf-parse`: the 1.x package runs debug code on import under Bun.
2. `helpers/ocr.swift`: one small binary that takes a file path.
   - Images: `VNRecognizeTextRequest`, `.accurate`, languages `de-DE` and `en-US`.
   - PDFs with no text layer (scans): render the first 2 pages with PDFKit, then OCR them.
   - Text goes to stdout. Build it with `swiftc -O` during `cloudtidy install`, because macOS has no built-in Vision CLI.
3. `extract/index.ts`: dispatch on extension and magic bytes, and cap text at about 4 kB. If a PDF's text layer comes back nearly empty, fall back to OCR.
4. `classify/heuristics.ts`: rules are `{pattern, field: "text" | "filename", category, sub?, weight}`. Sum the weights per category. The result is **definite** only when the top score is at least a threshold *and* beats the runner-up by a margin. This matters because single keywords like `IBAN` or `schema` show up in unrelated documents. Starting rules:
   - Uni: `\b(VL|VO|UE|KV|PR|SE|KS|PS)\s?\d{3}\.\d{3}\b`, `JKU|Johannes Kepler`, course-number list from config
   - Rechnungen: `Rechnung|Invoice|Zahlungsziel|Rechnungsnummer`, `ATU\d{8}`, `IBAN` (low weight)
   - Verträge: `Vertrag|Polizze|Versicherung|Mietvertrag|Kündigung`
   - Dev: file extensions (`.ts`, `.py`, `.csv`, `.ipynb`, `.drawio`) at low weight, `github\.com`. Extensions alone must not decide: bank statement exports are `.csv` too, and text matches like `IBAN` or bank names should outvote them.
   - Persönlich: `Reisepass|Personalausweis|Boarding|Flugticket|Befund|Arzt`
5. `naming.ts`: for `Rechnungen` and `Verträge`, find the document date (prefer invoice or contract date labels, then the first `dd.mm.yyyy` / `yyyy-mm-dd` match, then the file's mtime). Take the sender from a known-sender map in config (`Drei`, `A1`, `Magenta`, `ÖGK`, …), or fall back to the Tier 2 `suggestedName`. Sanitize the name: strip `/:`, control characters and leading dots (a leading dot would turn the file into a dotfile the scanner skips), collapse whitespace, keep umlauts, and cap the length at about 120 characters.

**Done when** about 20 real sample files are run through `scan --dry-run` and checked by hand. Tier 1 should resolve the obvious ones in under 10 ms each, with zero wrong targets. It is fine for unclear files to be marked "ambiguous".

### Phase 2 — Tier 2 local LLM

1. `classify/llm.ts`: `POST http://localhost:11434/api/chat` with `format` set to a JSON schema whose `category` and `subcategory` are **enums** built from config, plus `suggestedName: string` and `confidence: number`. Use `temperature: 0`, the first 1,000 characters of text plus the original filename, and `keep_alive` so the model stays loaded between runs. Allow about 60 s for a call that has to cold-load the model and 15 s once it's warm.
2. Validate the response with zod. If it's invalid, or the server is down, or `confidence` is below the threshold (start at 0.7), the file goes to `_Inbox/Needs_Review/`. Never guess.
3. `cloudtidy doctor` checks that Ollama is reachable, the model is pulled, the OCR helper is built, `pdftotext` is present and the plist is loaded.
4. Benchmark: run the fixture set through `gemma` and `qwen2.5` and record latency and accuracy in `test/BENCHMARK.md`. Choose the default model from that.

**Done when** the Tier 2 path sorts the ambiguous fixtures correctly or routes them to Needs_Review, in under about 2 s each with the model warm. Record the actual numbers in `test/BENCHMARK.md`. The spec's 300 ms estimate is optimistic for a 12B model once prompt processing and JSON generation are counted.

### Phase 3 — launchd daemon and notifications

1. `bun build --compile src/cli.ts --outfile ~/.local/bin/cloudtidy` gives a single stable binary. A fixed path also means macOS remembers its file-access permission (TCC grant) between runs.
2. `cloudtidy install` renders the plist template and writes it to `~/Library/LaunchAgents/at.paul.cloudtidy.plist`. The plist sets `ProgramArguments` to `[binary, "run"]`, `WatchPaths` to the `_Inbox` path, `ThrottleInterval` to 5, `StartInterval` to 300 as a backstop rescan, and log paths for stdout and stderr. The command then runs `launchctl bootstrap gui/$UID …`, and `uninstall` reverses it.
3. `run` semantics: `WatchPaths` fires when the directory changes but doesn't say which file, so `run` rescans all of `_Inbox` every time. It has to be idempotent. The daemon's own moves out of `_Inbox` fire `WatchPaths` again, and the lockfile plus the "nothing left to do, exit" path keep that loop harmless. If the lock is held, `run` waits for it (timeout about 60 s) instead of exiting, so a trigger is never dropped.
4. Debounce and stability: a file is ready when it isn't a stub and its size and mtime are unchanged across two checks 3 s apart. `WatchPaths` does not fire while a file inside `_Inbox` is still being written, so `run` keeps polling unstable files itself, every 3 s for up to about 60 s. Anything still unstable after that is left for the `StartInterval` rescan. If a `.name.icloud` stub is seen, run `brctl download <path>` and move on. The stub being replaced by the real file is a directory change, so it fires another trigger.
5. `notify.ts`: `osascript -e 'display notification "Sorted Rechnung into 02_Admin & Finanzen" with title "cloudtidy"'`. Batch the messages when several files arrive at once.

**Done when** a PDF saved from the iPhone Share Sheet into `_Inbox` is sorted on the Mac within about 10 s after sync, and the notification shows up.

### Phase 4 — Drive sweep, history and polish

1. `history.ts`: every move appends `{ts, from, to, tier, category, confidence, sha256}` to the JSONL history file.
2. `cloudtidy undo [--last N | --id]` moves files back, but only if they are still at the recorded target with the same hash. This is a cheap safety net, and it's worth having before the sweep.
3. `cloudtidy sweep [--dry-run]` takes loose files in the iCloud Drive root (never inside buckets, `_Archiv` or app containers). It shows the proposed table, and then the user confirms per item or in bulk.
4. Optional `--date-prefix` renaming for other categories, behind a config flag.

**Done when** a dry-run sweep of the real drive root shows a reviewed plan, the confirmed moves have been applied, and `undo --last` restores them.

## Testing strategy

- Unit tests (`bun test`): heuristics scoring, naming and date parsing (German formats), sanitizing, collision suffixes, the blocklist guard (including NFD and NFC look-alike paths and symlinks), and config validation.
- Integration tests: a temp-dir fake iCloud root built from `test/fixtures`. Run `run` end to end with Tier 2 mocked (a fake HTTP server) and assert the final tree plus the history file.
- Manual: the cross-device Share Sheet flow and the first-run permission prompts. Neither can be automated in CI.
- CI: GitHub Actions on `macos-latest` for typecheck, lint, tests and building the Swift helper.

## Risks and gaps in the spec

| Risk | Mitigation |
| --- | --- |
| `WatchPaths` gives no file list and refires on the daemon's own moves | Full idempotent rescan, a lockfile, and early exit when idle |
| Files stuck in `_Inbox`: no trigger while a file is still being written, or when the lock is held | In-process stability polling (up to about 60 s), wait for the lock instead of exiting, `StartInterval` 300 s backstop rescan |
| macOS has no Vision CLI | Ship and compile `helpers/ocr.swift` (Vision + PDFKit) |
| Scanned PDFs have no text layer | Detect near-empty text and fall back to OCR on rendered pages |
| `.icloud` stubs and half-synced files | Skip stubs, call `brctl download`, check size and mtime for stability |
| macOS file-access permission (TCC) for a launchd job reading `~/Library/Mobile Documents` | Compiled binary at a fixed path; `doctor` explains how to grant access if a read fails |
| Unicode normalization (iCloud filenames can be NFD) | NFC-normalize every path before comparing or applying the blocklist |
| Broad single keywords (`IBAN`, `schema`) misroute files | Weighted scoring with a margin; anything uncertain goes to Tier 2 or Needs_Review |
| LLM invents categories or folders | JSON-schema enums from config, zod validation, Needs_Review fallback |
| Ollama not running | Treat as low confidence and send to Needs_Review; `doctor` reports it |

## Open questions

1. Should `01_Uni` get per-course subfolders (e.g. `01_Uni/ML/`) inferred from course numbers, or stay flat for v1?
2. Ollama or a plain llama.cpp server as the default backend? Ollama's `format` JSON schema is simpler to integrate, and llama.cpp needs a GBNF grammar or its `json_schema` option.
3. Exact duplicates go to `_Inbox/Needs_Review/duplicates/` by default. Once that has proven reliable, should it switch to deleting them silently?
4. Should Needs_Review items trigger their own notification, with a "click to open folder" action?
