# model-router verification (V1–V7)

Spec: docs/superpowers/specs/2026-10-16-model-router-design.md §10. Each item: result, evidence, decision.

| # | Result | Decision |
|---|---|---|
| V1 | pending (Task 3) | |
| V2 | headless: PASS; interactive: pending (Task 3) | `x-claude-code-session-id` equals `$.session.id()` in headless mode |
| V3 | pending (Task 3) | |
| V4 | pending (Task 2) | |
| V5 | pending (Task 3) | |
| V6 | pending (Task 3) | |
| V7 | PASS | keep '#' |

## Captured request shape (unrecognized model, Claude Code 2.1.301)

- `anthropic-beta`: `claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,advisor-tool-2026-03-01,effort-2025-11-24`
- `context_management`: `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`
- `thinking`: `{"type":"adaptive","display":"omitted"}`; `output_config`: `{"effort":"medium"}`; `max_tokens`: `128000`

## Evidence

Run printed `spike-ok from router:Test/fake-model#claude-opus-5-5` (exit 0). One `/v1/messages` request; its `rawModel` matched exactly, and `session` equals the mark data.

```
$ grep -E '"path":"/v1/messages"' capture.jsonl | head -3   (key fields)
"path":"/v1/messages","model":"router:Test/fake-model#claude-opus-5-5", ... "session":"58d81224-8093-49ea-827a-63e0f77e4b12", "rawModel":"router:Test/fake-model#claude-opus-5-5"
$ grep -E '"mark":"session-id"' capture.jsonl
{"t":5454,"mark":"session-id","data":"58d81224-8093-49ea-827a-63e0f77e4b12"}
$ grep -c unrecognized_model stderr.txt
0
```
