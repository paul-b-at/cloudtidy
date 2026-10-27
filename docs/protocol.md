# Classifier protocol v2

One process per request (`bin/classify`). One UTF-8 JSON object on stdin; one JSON object on stdout followed by a newline. Diagnostics on stderr never include document content. The parent (Bun) enforces a timeout and a combined stdout/stderr size bound.

v2 replaces v1's `suggestedName` with explicit `documentDate` and `sender` fields: **the model never supplies a filename, path, command or extension.** Bun builds any new name deterministically (`YYYY-MM-DD_<Sender>-<Doctype>.<original ext>`) and only if both values can be found verbatim in the extracted text. Readers must reject any other protocol version and any response with unknown or missing keys.

## Request

```json
{"version":2,"filename":"bill.pdf","text":"bounded extracted text","routes":[{"id":"invoices","description":"Invoices and payment requests"}]}
```

`routes` is the configured route list (`id` + `description`), so it contains every route, including routes without Tier-1 patterns such as the `admin` root (the model is the only way to reach it). The model must answer with one of these ids or `review`; Bun rejects any other id (`invalid_response`).

Optional `lockedRoute` (a route id from `routes`): a deterministic rule in Bun already chose the route, so the model is only asked for `documentDate` and `sender`. The helper then restricts the generation schema to that one route, tells the model "the route is already decided", and fails closed (exit 3) if the id is unknown or the output names any other route. Without `lockedRoute` the model picks a route (or `review`) as before.

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

On failure the helper prints nothing on stdout and writes exactly one fixed token to stderr: `classification_failed:<code>`, with `<code>` one of `context_window_exceeded`, `guardrail_violation`, `refusal`, `unsupported_language`, `assets_unavailable`, `rate_limited`, `concurrent_requests`, `decoding_failure`, `generation_error`, `model_unavailable`, `invalid_request`, `oversized_request`, `other`. Tokens never contain document text.

| Exit | Meaning | Bun treats it as |
| --- | --- | --- |
| `0` | success | answer |
| `2` | model unavailable (`modelNotReady`, Apple Intelligence off, assets not downloaded) | **transient**: file stays in `_Inbox` as *pending*, retried later with backoff |
| `4` | `rateLimited` / `concurrentRequests` | **transient** (same) |
| timeout / killed by signal | no answer in `timeoutMs` / helper crashed | **transient** (same) |
| `3` | invalid or oversized request, invalid output (route outside the allowed set) | non-transient: `Needs_Review` (`model_invalid_request`) |
| `1` | refusal, guardrail, unsupported language, context overflow after the retry, decoding failure, anything else | non-transient: `Needs_Review` (specific reason, see below) |

Bun reads the stderr token and keeps the reason specific: `refusal` → `model_refusal`, `guardrail_violation` → `model_guardrail`, `unsupported_language` → `model_unsupported_language`, `context_window_exceeded` → `model_context_overflow`, `decoding_failure` → `model_invalid_output`, `invalid_request`/`oversized_request` → `model_invalid_request`; any other token or none → `model_failed`. A malformed or non-conforming answer on stdout is `invalid_response`. Transient exits map to `model_unavailable` (2), `model_busy` (4), `model_timeout`, `model_crashed`. When the file already matched a rule (`lockedRoute` was sent), a definite failure does **not** send it to review: it keeps the rule's folder and its original name, with the reason recorded as `naming_<reason>`.

Transient failures never cause a review decision by themselves: a pending file is retried (backoff 5, 10, 20, 40, then every 60 minutes) and only moves to `_Inbox/Needs_Review` with reason `deferred_too_long:<reason>` after `model.maxDeferHours` (default 24) of apply-mode attempts, at least 3 of them, and one final attempt that also fails transiently (a final call that returns exit 4 / `model_busy` counts as an attempt but leaves the file pending and keeps its backoff (it is not re-asked on every run); only after 4 x `maxDeferHours` of wall-clock time since the first apply attempt (not time spent busy) does a busy final call give `deferred_too_long:model_busy`; only timeout, unavailable and crash give `deferred_too_long:*`). Real helper calls for that file in that run and the file's own extraction (OCR/pdftotext) timeouts count as attempts: a file answered by the per-run circuit breaker (opened by an earlier file's transient failure) counts nothing, starts no clock and gets no longer backoff; an expired file bypasses the breaker and gets exactly one real call (no retries). Only a definite "no" (refusal, guardrail, invalid output) reviews immediately. Bun retries timeouts and exit 4 a bounded number of times within one run (`classifierRetries`) before deferring.

Guardrails may refuse sensitive documents or unsupported languages, and structured (guided) output cannot use the permissive guardrails mode. Such documents end in `_Inbox/Needs_Review` — the intended behaviour.
