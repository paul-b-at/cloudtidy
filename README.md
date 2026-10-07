# cloudtidy

Local-first organizer for iCloud Drive on macOS. Drop a file into `iCloud Drive/_Inbox` from any Apple device, and a LaunchAgent sorts it into your folder structure:

```text
01_Uni/  02_Admin & Finanzen/{Rechnungen,Verträge,Steuer,Bank}/  03_Projekte & Dev/
04_Persönlich/{Gesundheit,Reisen,Dokumente}/  _Archiv/  _Inbox/Needs_Review/
```

Text comes from the PDF text layer (`pdftotext`, falling back to `unpdf`) or on-device Vision OCR. Classification uses weighted regex rules first, then a local LLM via Ollama for anything ambiguous. Nothing leaves the Mac. Files are never overwritten: collisions get a ` (2)` suffix, and exact duplicates are parked in `_Inbox/Needs_Review/duplicates/`. Anything uncertain goes to `_Inbox/Needs_Review/`.

The design and roadmap are in [PLAN.md](PLAN.md).

## Requirements

- macOS on Apple silicon, with iCloud Drive enabled
- [Bun](https://bun.sh) 1.4+
- Xcode command line tools (`xcode-select --install`), for the OCR helper
- `brew install poppler` (optional, faster PDF text extraction)
- [Ollama](https://ollama.com) with a model pulled, e.g. `ollama pull gemma3:12b` (optional; without it ambiguous files go to Needs_Review)

## Setup

```bash
bun install
bun run build:install          # compiles to ~/.local/bin/cloudtidy
~/.local/bin/cloudtidy doctor  # check dependencies and permissions
~/.local/bin/cloudtidy scan    # dry run: shows what would happen, moves nothing
~/.local/bin/cloudtidy install # builds the OCR helper and loads the LaunchAgent
```

`install` writes `~/Library/LaunchAgents/at.paul.cloudtidy.plist`. The agent runs when `_Inbox` changes, every 5 minutes as a backstop, and at login. If macOS blocks access to iCloud Drive, grant `~/.local/bin/cloudtidy` access under System Settings > Privacy & Security.

## Commands

| Command | What it does |
| --- | --- |
| `cloudtidy scan` | Dry run over `_Inbox` |
| `cloudtidy run` | Process `_Inbox` once (what launchd calls) |
| `cloudtidy undo [--last N \| --id ID]` | Move recent sorts into `_Inbox/Needs_Review` |
| `cloudtidy doctor` | Check platform, folders, permissions, `pdftotext`, OCR helper, Ollama and the agent |
| `cloudtidy install [--print]` / `uninstall` | Load or remove the LaunchAgent (`--print` only prints the plist) |

`--no-llm` skips the LLM tier. `--config PATH` uses a different config file.

## Configuration

Defaults are in [config/default.config.json](config/default.config.json). Put overrides in `~/.config/cloudtidy/config.json`, or point `CLOUDTIDY_CONFIG` at a file. Objects are merged and arrays are replaced. For example:

```json
{
  "courseNumbers": ["365.012", "344.031"],
  "knownSenders": ["Drei", "A1", "Linz AG", "Raiffeisen"],
  "llm": { "model": "qwen2.5:14b" }
}
```

Invoices and contracts are renamed to `YYYY-MM-DD_Sender-Rechnung.pdf` (or `-Vertrag`). Every other file keeps its original name.

Runtime files:

- History: `~/Library/Application Support/cloudtidy/history.jsonl`
- Log: `~/Library/Logs/cloudtidy/cloudtidy.log`

## Development

```bash
bun test          # unit + integration tests (temp-dir iCloud root, fake Ollama server)
bun run typecheck
bun run lint
```
