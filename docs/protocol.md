# Classifier protocol v1

One process per request. One UTF-8 JSON object on stdin; one JSON object on stdout followed by newline. Diagnostics on stderr never include document content. The parent enforces timeout and combined stdout/stderr bounds. `--check` prints `{"version":1,"available":true}` or false and does not perform generation.

Request:
```json
{"version":1,"filename":"bill.pdf","text":"bounded extracted text","routes":[{"id":"invoices","description":"Invoices and payment requests"}]}
```

Success:
```json
{"version":1,"route":"invoices","suggestedName":"2026-10_Drei.pdf","needsReview":false}
```

Uncertain:
```json
{"version":1,"route":"review","suggestedName":"bill.pdf","needsReview":true}
```

The dynamic generation schema restricts route IDs to supplied IDs plus `review`. IDs map to complete configured destinations; the model cannot choose an absolute path. JSON names/extensions and route membership are revalidated by Bun. Invalid output, refusal, helper failure or unavailability produce a review proposal, never a cloud retry. `needsReview:false` is not proof of correctness.

Maximum request: 32 KiB; model text excerpt: 2,400 JS characters; routes: at most 32. Invoice dates and senders are suggestions, not verified facts. Review all proposals before future automated naming.
