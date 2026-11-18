# Progress usage validation — 2026-11-15

The metadata uses `Total｜Input｜Cache｜Reasoning｜Output｜Est. Cr : ...` and `4 rounds | 7 calls`. Credit is a current-rate subscription reference, not an invoice. API engines suppress subscription Credit.

| Case | Verified behavior |
| --- | --- |
| Native tool starts before usage | Call and round counts update before Token arrives; repeated call IDs are deduplicated |
| Native RPC remains connected | Late file statistics still reach the browser and patch the completed text |
| Current item has no complete previous snapshot | Authoritative step boundaries identify its own counters; unrelated cumulative totals are rejected |
| Streaming text | Recorded usage remains visible during streaming; completion timestamps appear on completion |
| Cold long transcript | Recover preceding model and speed receipts, independently per field, before pricing the retained tail; never replay older usage or use future settings |
| Receipt boundaries / read budget | Split JSONL lines, explicit null, oversized records and the 16 MiB backward-read cap remain safe |
| Metadata cleanup / colors | No step or summary prefix; no unknown timing placeholders; Credit purple, rounds/calls blue, both light and dark |
| Mixed models / Fast | Price each request using its recorded context, then sum; do not apply the final model to the entire interval |
| Missing rate, tier or token field | Unknown prices remain unknown; Standard assumptions and partial estimates are marked |
| Earlier incomplete request | A later step can recover exact counters without subtracting poisoned cumulative fields |
| Malformed record inside the current step | Counters and price coverage remain partial |
| Follow-up / next native turn | Step counters reset at their actual boundaries, without inheriting hidden earlier work |
| Parallel tools / code mode | Parallel calls share a round; internal calls hidden by a native code-mode wrapper are not expanded |
| Activity fallback | Bounded activity snapshots provide a lower bound only; they do not override an authoritative recorded interval |
| Cache rate | Same-interval cached input / input, two decimal places, continuous red-to-green hue; unknown on zero or invalid input |
| Theme / narrow screen | Cache colors adapt to light and dark themes; metadata wraps without page overflow |
| Shared request | Shared updates are explicitly labelled rather than presenting duplicated per-message costs |
| Reconnect / reload / privacy | Existing reconciliation, bounded readers, access checks and exclusions of tool arguments/output remain covered |

Validation commands and results:

```bash
npm --prefix server test
# 146 files: 1141 passed, 1 skipped
npm --prefix dashboard test -- --maxWorkers=2
# 111 files: 664 passed
E2E_API_PORT=43520 E2E_UI_PORT=43521 npm run test:e2e -- \
  e2e/conversation-streaming.spec.ts \
  e2e/conversation-statistics-duplicates.spec.ts \
  e2e/conversation-activity.spec.ts \
  e2e/conversation-clock.spec.ts \
  e2e/progress-intervals.spec.ts
# 5 passed
npm run build
# dashboard and server passed
```

The XLSX-to-HTML test is skipped because `/usr/lib/libreoffice/program/libsclo.so` is absent. Browser tests assert that tool starts, tool completion, and Token updates from file writes reach the visible UI within one second in the isolated fixture. This is an event-to-display test, not a guarantee that the upstream engine streams token counts for every generated character. No model requests, production credentials, or developer database are used by these tests. This change adds no polling interval or account-quota requests.

The expanded metadata exposed a Final heading wrapping regression in the first browser run. The heading now gives its metadata the remaining width and aligns it at the top; the complete five-test browser rerun passes, including desktop/mobile layout, reload and live colors. Earlier stored prices are never reconstructed from the currently selected model.
