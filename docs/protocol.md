# Classifier protocol v2

One process per request (`bin/classify`). One UTF-8 JSON object on stdin; one JSON object on stdout followed by a newline. Diagnostics on stderr never include document content. The parent (Bun) enforces a timeout and a combined stdout/stderr size bound.

v2 replaces v1's `suggestedName` with explicit `documentDate` and `sender` fields: **the model never supplies a filename, path, command or extension.** Bun builds any new name deterministically (`YYYY-MM-DD_<Sender>-<Doctype>.<original ext>`) and only if both values can be found verbatim in the extracted text. Readers must reject any other protocol version and any response with unknown or missing keys.

## Request

```json
{"version":2,"filename":"bill.pdf","text":"bounded extracted text","routes":[{"id":"invoices","description":"Invoices and payment requests"}]}
```

Limits: 32 KiB request, 2,400 characters of text (Bun slices on a code-point boundary, never through a surrogate pair), at most 32 routes, route IDs `^[a-z][a-z0-9_-]{0,31}$` (ASCII, checked scalar by scalar so `"uni\n"` is rejected), `review` is reserved, descriptions at most 240 characters.

## Response

```json
{"version":2,"route":"invoices","documentDate":"2026-10-07","sender":"Drei","needsReview":false}
```

Uncertain:

```json
{"version":2,"route":"review","documentDate":"","sender":"","needsReview":true}
```

- `route`: one of the supplied IDs or `review` (restricted by the dynamic generation schema and re-checked in the helper and again in Bun).
- `documentDate`: `YYYY-MM-DD` or `""`. A suggestion only: Bun accepts it only if the same date is written in the document text.
- `sender`: organisation name or `""`. Bun accepts it only if it appears in the document text.
- `needsReview`: true if uncertain (the helper also forces it for `route:"review"`). `needsReview:false` is not proof of correctness.

Invalid output, refusal, helper failure or unavailability produce a review proposal, never a cloud retry. Routes with `rename:false` need no valid name (there is none in v2).

## Model options

Greedy sampling (repeatable for a given model version) and a 256-token response cap. On a context-window overflow (4,096 tokens input + output) the helper retries once with a 600-character excerpt before failing.

## `--check`

`bin/classify --check` does not generate. It prints `{"version":2,"available":true}` or `{"version":2,"available":false,"reason":"<code>"}` where `reason` is one of `device_not_eligible`, `apple_intelligence_not_enabled`, `model_not_ready`, `unknown`. Readers must ignore unknown fields.

## Failure and exit codes

On failure the helper prints nothing on stdout and writes exactly one fixed token to stderr: `classification_failed:<code>`, with `<code>` one of `context_window_exceeded`, `guardrail_violation`, `refusal`, `unsupported_language`, `assets_unavailable`, `decoding_failure`, `generation_error`, `model_unavailable`, `invalid_request`, `oversized_request`, `other`. Tokens never contain document text. Exit codes: `0` success, `2` model unavailable, `3` invalid or oversized request, `1` any other failure. Bun records every non-zero exit as a (transient) review reason and retries a bounded number of times.

Guardrails may refuse sensitive documents or unsupported languages, and structured (guided) output cannot use the permissive guardrails mode. Such documents end in `_Inbox/Needs_Review` — the intended behaviour.
