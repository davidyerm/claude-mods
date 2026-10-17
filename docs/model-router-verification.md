# model-router verification (V1–V7)

Spec: docs/superpowers/specs/2026-10-16-model-router-design.md §10. Each item: result, evidence, decision.

| # | Result | Decision |
|---|---|---|
| V1 | PASS | Keep the `/model` takeover. A `command.run` hook answers the built-in `/model`, and `next(e)` opens the built-in picker. Finding: `$.command.run` called *inside* a `command.run` hook is refused (see V1 note); model-router only calls it from the picker's `onSelect` (V1b pending). |
| V2 | headless: PASS; interactive: PASS (main requests) | `x-claude-code-session-id` equals `$.session.id()`. Keep session-scoped toasts. No tool-less title request reached the fake API, so the header on background calls was not observed. Check it in the release checklist via `router.log`. |
| V3 | PASS | Keep `spawn(..., { detached: true })`. The launcher exited 0 in 372 ms, and the child survived hot reload and `/exit`. |
| V4 | pending (Task 2) | |
| V5 | PASS | A built-in pick is visible right after `next(e)` and through `$.session.model()` within 1 s. The 2 s tick detection works. |
| V6 | PASS | `$.fs.write` on `~/.claude/settings.json` succeeded with no prompt reported. The product writes through `launch.mjs write` anyway. |
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

## Interactive probe session (dev machine, Claude Code 2.1.301, 2026-10-17)

Probe mod `docs/model-router-spike/probe`, against the capture server with a dummy key.

- V2: session id `63450ef1-257f-4c3e-94b3-5fd488220274`. Both `/v1/messages` requests (41 tools each) carried it. No tool-less request (title) was captured.
- V1: `/model probe-answer` printed "V1: answered by mr-probe". Bare `/model` reached `next(e)` and the built-in picker opened (only Claude models listed).
- V5: `after next(e): model claude-opus-5-5 -> claude-sonnet-5-5, result={"ref":1}`, plus the 1 s line `session.model changed claude-opus-5-5 -> claude-sonnet-5-5`.
- V1 note: `/probe builtin` (a `$.command.run({ command: 'model' })` made inside the probe's own `command.run` hook) was refused: `HooksError: mr-probe: command.run: called from a command.run hook, it would wait on the turn this hook is holding`. The built-in picker did not open. model-router makes this call only from the picker pane's `onSelect` ("Claude Code's picker…" and the Claude alias entries), which is not a `command.run` hook. **V1b** checks that path in a real session.
- V6: `$.fs.write OK on C:\Users\Duduy/.claude/settings.json`. The mixed slashes come from `USERPROFILE + '/.claude'`; Windows accepts them, and only the display is affected.
- V3: `launcher exit 0 after 372 ms: spawned pid=15984`. `curl :4198` answered `alive pid=15984` before reload, after reload, and after `/exit`. `/quit` stopped it.
