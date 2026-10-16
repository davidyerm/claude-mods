# Model Router mod — brainstorming checkpoint

> **Resume point.** A fresh session should read this whole file, then continue at
> [Next steps](#next-steps). Process in use: `superpowers:brainstorming`, **architectural path**.
> Mod-API knowledge comes from the `plugin-authoring` skill (load it again in the new session).

Date: 2026-10-15 · Claude Code build at time of research: 2.1.300

## Status

| Brainstorming step | State |
|---|---|
| Classify (architectural) | done |
| Explore context / mod API | done |
| Clarifying questions | done (answers below) |
| Propose approaches | done → **Approach A chosen** |
| Present design sections | Sections 1–4 (architecture, data flow, error handling, testing) **all approved** |
| Spike: open risks (a), (b), (d) | **done**, see Spike results |
| Write spec | **done:** `docs/superpowers/specs/2026-10-16-model-router-design.md` (self-reviewed; not committed, since `C:\dev\llm\mods` isn't a git repo) |
| User reviews spec → `superpowers:writing-plans` | **awaiting user review of the spec** |

> **The spec is now the authoritative design.** Where this file and the spec differ, the spec wins. Spec-time refinements: events are served over HTTP (`/_router/events`) as well as the file; the fallback model is encoded in the routed ID (`router:P/m#<claude-id>`); `x-router-fallback-model` was dropped; verification items V1–V7 come first in the plan.

## Goal (user's words, condensed)

1. Add LLM models from other providers to the model list (like the built-in `/model`), each **marked with its provider name**.
2. Switch the main model **mid-session**, like `/model`.
3. **Override** built-in models, e.g. "Haiku" actually goes to an added model (for cheaper pricing).
4. **Background calls** (session titles, summaries, compaction, some subagents, which use Haiku or Sonnet) must respect the overrides.

## User's environment

- Windows 11, PowerShell + Git Bash. Mods workspace: `C:\dev\llm\mods` (existing sibling mod: `rtl-mode/`).
- Claude Code reaches Anthropic through a **corporate gateway**: `ANTHROPIC_BASE_URL` points at an internal gateway that speaks the **Anthropic Messages API**. No Bedrock, Vertex or subscription OAuth.
- Third-party providers to add are **Anthropic-compatible** (Messages API, e.g. OpenRouter's Anthropic endpoint, DeepSeek, Kimi/Moonshot, GLM/Z.ai). **No format translation needed.**

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Overall approach | **A: mod + local router.** Pure-mod approach B rejected: it can't reach background calls. |
| D2 | Router lifecycle | Router script **ships inside the mod**. The mod **spawns it on `session.start`** if a health check fails. **One shared router** for all sessions, reused. |
| D3 | Adding providers/models | **Both:** a JSON config file is the source of truth, and a `/router add` wizard edits it. Keys are given as `apiKeyEnv` (env var name, preferred) or a literal `apiKey`. |
| D4 | Persistence | **Middle ground.** Overrides are **global** (stored in config). The `/router` main-model pick is **per-session**. `/router default <model>` (or a picker action) saves `defaultMainModel` for new sessions. |
| D5 | Override granularity | **By family:** `haiku`, `sonnet`, `opus` (and `fable`). Any request whose model ID contains the family name is routed. Survives Claude version bumps. |
| D6 | Provider failure | **Fall back to the original Claude model** via the corporate gateway, and show a **toast**, e.g. `[DeepSeek] failed (429), used Haiku`. |

| D7 | Unrouted traffic | Passed through to `upstream` **byte-for-byte untouched**. The router never modifies Claude traffic. |
| D8 | Failure timing | Fallback to Claude only **before the first response byte**. A provider failing mid-stream just errors (no fallback). |
| D9 | Credential safety | For routed requests, **always** drop all inbound auth headers (gateway key, `apiKeyHelper` token) plus identifying headers (`x-claude-code-session-id`) and `metadata`, then set only the provider's key. Not configurable. |
| D10 | Compatibility strip | Per-provider configurable `strip` list. Defaults: drop `anthropic-beta`, `thinking`, `context_management`, `output_config`; **keep** `cache_control`. `/router doctor` reports which field a provider rejects. |
| D11 | `max_tokens` clamp | Routed requests only: `max_tokens = min(requested, learned, policy)`, never raised. On a 400 mentioning `max_tokens`, read the limit from the error (else use 8192), retry once, and remember it per model **in memory only**. Use this rather than `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, which would cap real Claude too. *(Revised by D19: no `maxOutputTokens` in the router config.)* |

| D12 | Limits split | `maxOutputTokens` / `contextWindow` **policy** moves to a **separate limits mod** that works across all models (Claude and routed). The router keeps only the **compatibility** clamp for routed models (needed for them to work at all). **Option 1 chosen:** the router exposes `POST /_router/policy`; the limits mod registers rules there and the router *executes* them, including on pass-through traffic, **only while the limits mod has registered rules** (D7 holds otherwise). The router *observes* (never modifies) pass-through errors and publishes them as events for the limits mod to learn from. The limits mod owns `limits-cache.json`, compaction (`$.session.usage()` + `$.session.compact()`), and works without the router at a reduced level (context only). **Build the router first** with the `/_router/policy` hook point designed but unused; the limits mod gets its own brainstorm, spec and plan later. |

| D13 | Packaging | **Two separate plugins** (`model-router`, `model-limits`), sibling folders, **no `dependencies` link**. They talk only through the router's HTTP contract (`/_router/status`, `/_router/policy`, versioned). **One marketplace for all mods:** `C:\dev\llm\mods` root gets a single `.claude-plugin/marketplace.json` listing `rtl-mode`, `model-router`, `model-limits`. `rtl-mode`'s own marketplace.json gets replaced or merged. |

| D14 | Command name | The mod's command is **`/router`** (not `/models`, which is too close to the built-in `/model`). Subcommands: `/router` (picker), `/router <name>`, `/router claude`, `/router default <name\|clear>`, `/router override <family> <name\|clear>`, `/router add`, `/router remove <provider\|provider/model>`, `/router setup`, `/router uninstall`, `/router doctor`, `/router forget <provider/model\|all>`. A subcommand name beats a same-named model; use the `Provider/model` form then. |
| D15 | Built-in `/model` | **Route 2: take over `/model` with a `command.run` hook** (matcher `{ command: 'model' }`). Bare `/model` → the mod's unified picker (Claude models plus `[Provider] model`), including an entry that opens Claude Code's original picker (`next(e)`). `/model <routed name>` → mod switch. Anything else → `next(e)` unchanged. Guarded with `.catch` → `next(e)` so a mod bug never breaks `/model`. **On by default**, with a `userConfig` toggle to turn it off. Output is labelled with the plugin name. **Route 1** (native `ANTHROPIC_CUSTOM_MODEL_OPTION[_NAME/_DESCRIPTION/_SUPPORTED_CAPABILITIES]` and `ANTHROPIC_DEFAULT_<FAMILY>_MODEL_NAME/_DESCRIPTION`, found in the 2.1.300 binary, one custom slot only, startup-read) was **not chosen**. Its `_SUPPORTED_CAPABILITIES` may still be worth checking as a way to stop the engine sending thinking/effort. **To verify in implementation:** hooking a built-in command with `command.run` works as documented, `next(e)` from inside our picker can open the original picker, and how picking a Claude model in the original picker interacts with our session pick. |

| D16 | `/model` vs `/router` roles | **`/model` (toggle on) = selection only:** the unified list (Claude plus `[Provider] model`) to switch this session's main model, a "Claude Code's picker…" entry, and a one-line footer hint `manage: /router`. **All management lives only in `/router`:** set default, overrides, add/remove, setup/uninstall, doctor, forget. **Toggle off:** stock `/model`, except the hook still catches `/model <routed name>` (a name the built-in would reject), switches to it, and prints "tip: use /router". The status line shows `router: /router to pick` when nothing is routed. |

| D17 | Upstream auth | User's gateway auth is **`apiKeyHelper`** (a short-lived token printed by a script; Claude Code refreshes it). The network path uses an **internal CA**: no proxy, no mTLS, no custom headers. The router is **transparent**: inbound auth headers are forwarded byte-for-byte upstream, the router stores no gateway credentials, and token refresh stays Claude Code's job. On fallback, the inbound auth headers are kept **in memory for that request only**. Upstream checks (setup/doctor) are made by the **mod via `$.model.complete`** (the real path, the session's auth). **CA:** the router must trust the internal CA. Node honours `NODE_EXTRA_CA_CERTS` (a PEM file) at startup, and the router inherits Claude Code's env. If the CA is only in the Windows cert store, start Node with `--use-system-ca`. The launcher passes it by default on Windows (verify with Node 24.13). Doctor reports an untrusted certificate specifically, with the fix. TLS inspection may also affect provider traffic; the same CA trust covers it. |
| D18 | Local access token | Closes the gap where any local process could spend provider credit through the router. Setup generates a random token and adds `x-router-token: <token>` to **`ANTHROPIC_CUSTOM_HEADERS`** in `settings.json` env, **merging** with existing headers (newline-separated). The router **rejects routed requests** without a valid token. Pass-through still works, since it needs gateway auth anyway. The router strips the token before forwarding anywhere. The token file is user-readable only, and doctor verifies it. |
| D19 | Limits ownership (2026-10-16) | **The router has no limit configuration**: `maxOutputTokens` is removed from `model-router.json`, and `limits-cache.json` is dropped. The router keeps learn-and-retry (it is needed for routed models to work at all) in an **in-memory learned table** (facts). model-limits owns all limit configuration and **writes** it as policy via `POST /_router/policy` (intent). It **reads** learned facts via the new `GET /_router/limits` and never writes them back. Applied limit: `min(requested, learned, policy)`. Cost: one fast 400 per model after each router restart. Spec §5.3 and §11. |

### Limits mod: router discoverability (APPROVED, belongs to the limits-mod spec)

The limits mod checks `GET /_router/status` at session start.
1. **When a rule is created** that needs the router (output cap) and no router is reachable, warn inline with the exact install line plus `/router setup`.
2. **At session start**, only if inactive rules exist: **one toast per session**. Silent otherwise.
3. `/limits status` shows a capabilities table (✓/✗ with what's needed) and per-rule active/inactive.

The message depends on the cause: not installed → `/plugin install model-router@<marketplace>`; installed but not set up → `/router setup`; set up but down → `/router doctor`. Telling "not installed" from "not set up" needs a plugin-list or `enabledPlugins` read, **unverified**; fall back to listing both steps. Marketplace descriptions plus a README "Which do I need?" table. The router's `/router doctor` mentions model-limits once as optional.

### OPEN QUESTION for the user (asked 2026-10-15; the user will answer later, do not forget)

> For the org's **Claude** models, is the need for the limits mod **context** (gateway rejects/caps long prompts), **output** (gateway caps `max_tokens`), or **both**?
> If it's mostly context, the limits mod barely needs the router.

### Pending design notes not yet presented as sections (from discussion, to fold into Section 3)

- Circuit breaker **kept** (3 consecutive failures → provider paused 5 min → requests go to Claude). Status-line text is exactly `[DeepSeek] ⚠  paused`, with **two spaces** after ⚠ (user's request).
- **Section 3 (error handling, consolidated) APPROVED 2026-10-16**, including D17/D18. Contents: 3.1 request failures (fallback before first byte, mid-stream errors pass, `max_tokens` learn+retry, other 400 → fallback with error text, circuit breaker, pass-through observed only); 3.2 config (keep last valid, missing key → provider unavailable, removed pick cleared, atomic writes); 3.3 lifecycle (detached launcher, `/_router/status` identity+version, ~5 s spawn wait, 10 s health/respawn, bind race, graceful drain on version mismatch, 30 min idle exit, uninstall never kills, project bypass reported); 3.4 `/model` `.catch` fallback; 3.5 security (D9, **bind 127.0.0.1 only**, no prompts/keys in logs, doctor warns on literal keys); 3.6 state layout (below). It was presented with: It adds: router binds **127.0.0.1 only**; `.catch` → `next(e)` on the `/model` takeover; the "not ours" port check via the identity in `/_router/status`.
- Parallel sessions:
  1. Events are tagged by the `x-claude-code-session-id` header so toasts reach only their own session (verify the header equals `$.session.id()`).
  2. **The router must be started DETACHED** through a launcher run by `$.process.run`, because a `$.process.spawn` child is killed when the module unloads (session exit or hot reload).
  3. Version handshake via `GET /_router/status`, with a graceful drain-and-restart on mismatch.
  4. `/router uninstall` doesn't kill the router; it exits on its own after ~30 min idle.
  5. Atomic config writes (temp file + rename, re-read first).
  6. A single `upstream`: a project-level `ANTHROPIC_BASE_URL` bypasses the router, and doctor reports it.
- State layout:
  - `~/.claude/model-router.json`: user config. **The router never writes it.**
  - Learned limits live in router memory only (D19). There is no `limits-cache.json`.
  - Circuit-breaker state is in memory only.
  - `events.jsonl` and `router.log` are rotated, with no prompts or keys.
  - The mod reads limits and health from `GET /_router/status`, not from files.

## Section 2: Data flow (APPROVED)

- **Router:**
  - `HEAD /api/hello` is answered locally.
  - For `/v1/messages[/count_tokens]`, resolve the target in this order:
    1. `router:<Provider>/<model>` (main pick).
    2. Family override (`haiku|sonnet|opus|fable` in the ID).
    3. Otherwise pass-through.
  - Rewrite routed requests per D9–D11 and stream the provider's SSE back as-is.
  - Fall back per D6/D8: retry once on upstream with the original Claude ID.
  - `count_tokens` for routed models: forward if supported, otherwise return an estimate.
  - Write events to `~/.claude/model-router/events.jsonl`.
- **Mod:**
  - `session.start`: health-check, spawn if needed, load config, apply `defaultMainModel`, set the status line.
  - `turn.step`: rewrite the model only when there's no `agentId` and a session pick exists.
  - A ~2 s `$.clock.every` timer reads events and turns them into toasts.
- **Commands:**
  - `/router` picker: main-model list with `[Provider]` labels, override summary, set default / override / add actions.
  - `/router <name>`, `/router default <name|clear>`, `/router override <family> <name|clear>`, `/router add`, `/router setup`, `/router uninstall`, `/router doctor`.
  - Picking a Claude model in the built-in `/model` clears the session pick (detect via `session.model`).

## Mod-API research findings (build 2.1.300)

The types file is regenerated per skill load. Find it from the `plugin-authoring` skill header (`.../plugin-authoring/types/claude-code.d.ts`, ~22k lines) and grep for the names below.

- **No hook into the built-in `/model` picker.** `RenderComponent` has no picker, and there is no `model.register`. So the mod provides its **own `/router` command** (`$.command.register` + a `command.run` hook) with its own picker (Pane or `ui.select`).
- **`turn.step`** (a streaming event, so the hook is an `async function*`) fires before **every model request in a turn, main loop and subagents** (`e.agentId` is set for subagents). `next({ ...e, model })` **rewrites the model**, and `effort` is rewritable too. A hook can also skip `next` and yield its own response chunks. `TurnStepInput` = `{ turnId, index, model, effort?, messageCount, agentId? }`. Messages are not on it; read them with `$.session.messages()`.
- **Background engine calls** (titles, summaries, compaction) are **not** `turn.step`s. `model.complete` hooks only see calls made through `$.model.complete` by plugins. **So a mod can't reroute them, and that's why the router exists.**
- Other useful APIs: `$.process.spawn` (start the router), `$.http.fetch` (health check), `$.fs.read/write` (config), `$.ui.status` (status line), `$.ui.toast`, `$.store` (persists across sessions), `$.state` (per-session, needs a `types/index.d.ts` contract), `session.model` (current model), `env.get/env.set`.
- Mod layout (from the skill): `.claude-plugin/plugin.json`, `hooks/hooks.json` → `{ "modules": ["./register.tsx"] }`, `hooks/register.tsx` exporting `register: Register`, and optionally `types/index.d.ts`. Validate with `claude plugin validate <dir>`, type-check with `tsc -p <dir>`, test with `claude plugin test <dir>`. The skill says dev mods go in `C:\Users\Duduy\.claude\dev-mods\<session-id>\<mod-name>\`; the user's own mods live in `C:\dev\llm\mods\`. **Ask where to put it.**

## Architecture (Section 1, presented, awaiting approval)

```
Claude Code ──(ANTHROPIC_BASE_URL=http://127.0.0.1:<port>)──▶ local router ──┬──▶ corporate gateway (auth headers forwarded unchanged)
     ▲                                                                       └──▶ provider X (its baseUrl + its key)
     │ mod: /router picker, overrides, status line, toasts, turn.step hook, spawns router
```

### Components

1. **Config** at `~/.claude/model-router.json`, the single source of truth, read by both the mod and the router (the router reloads on change):
   ```jsonc
   {
     "port": 4141,                                   // illustrative
     "upstream": "https://<corporate-gateway>",      // former ANTHROPIC_BASE_URL
     "providers": [
       { "name": "DeepSeek", "baseUrl": "https://api.deepseek.com/anthropic",
         "apiKeyEnv": "DEEPSEEK_API_KEY",            // or "apiKey": "..."
         "models": ["deepseek-chat"],
         "strip": ["anthropic-beta", "context_management"] }   // fields/headers this provider rejects
     ],
     "overrides": { "haiku": "DeepSeek/deepseek-chat" },        // family → provider/model
     "defaultMainModel": "DeepSeek/deepseek-chat"               // optional
   }
   ```
2. **Router**: a small Bun/Node script in the mod folder, with no dependencies. For `/v1/messages` and `/v1/messages/count_tokens` it resolves the target in this order:
   1. An explicit routed ID like `router:DeepSeek/deepseek-chat`.
   2. A family override (the model ID contains `haiku`, `sonnet`, `opus` or `fable`).
   3. Otherwise, pass-through to `upstream` with the original headers.

   For routed requests it swaps in the provider's model ID and key and applies the per-provider `strip` list. On provider failure it retries on the original Claude model via `upstream` and records a fallback event that the mod turns into a toast.
3. **Mod** (`hooks/register.tsx`):
   - `session.start`: health-checks the router and spawns it if it's down.
   - `/router`: picker listing Claude models plus `[Provider] model` entries, with "set as default" and "override haiku/sonnet/opus" actions.
   - `/router add`: wizard that writes the config.
   - `turn.step` hook: applies this session's main-model pick.
   - Status line, e.g. `main: [DeepSeek] deepseek-chat · haiku→[Kimi] k2`.
4. **One-time setup** (`/router setup`, explicit and never automatic):
   1. Reads the current `ANTHROPIC_BASE_URL` (the corporate gateway) and **detects its source**: `~/.claude/settings.json` env, an OS env var, or managed settings. If a source with higher precedence sets it, setup tells the user what to change by hand instead of writing.
   2. Saves it as config `upstream`.
   3. Writes `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` into `~/.claude/settings.json` `env`.
   4. Tells the user to restart (the base URL is read only at startup).

   Gateway auth headers (API key, `apiKeyHelper` token) are forwarded untouched. **Undo:** `/router uninstall` restores the original value, and setup prints the manual undo (remove or restore the line in `settings.json`). The router answers `HEAD /api/hello` itself.

### Open risks (spike before writing the spec)

- **(a)** Does `turn.step` accept `next({ ...e, model: 'router:…' })` with a non-Claude ID (an allowlist or validation might refuse it)? **Fallback design:** keep the Claude ID and let the router know the session's main pick some other way, e.g. a per-session header, or the mod tells the router "session X main = Y". Note that the router alone can't tell main-loop requests from subagent requests, which is why the `turn.step` route is preferred.
- **(b)** Race between router start and the first request. Expected fix: `session.start` awaits the spawn plus health check.
- **(c)** If the router is down, **all** model access fails, since `ANTHROPIC_BASE_URL` points at it. It needs a robust spawn plus a clear error message.
- **(d)** Third-party "Anthropic-compatible" endpoints may reject newer fields, betas, server tools, thinking params or `cache_control`. The per-provider `strip` list should cover this; verify against each real provider.

## Spike results (2026-10-15, build 2.1.300). Section 1 approved by user

Method (throwaway, in the session scratchpad): a Node capture server on `127.0.0.1:4199` faking the Anthropic API and logging every request, plus a spike mod (`session.start` with a 3 s delay, and `turn.step` rewriting `model` to `router:Test/fake-model`), run with `ANTHROPIC_BASE_URL=http://127.0.0.1:4199 ANTHROPIC_API_KEY=dummy claude -p ... --plugin-dir <spike>`. The second run had the fake server answer with an `Agent` tool call (`model: "haiku"`).

- **(a) RESOLVED, it works.** `next({ ...e, model: 'router:Test/fake-model' })` is sent verbatim as the request `model`. The engine only prints a warning, `[claude-code:unrecognized_model] {"model":"router:Test/fake-model",...}` (stderr in `-p`; may surface in the interactive UI, so check that). The response flows back normally and `usage.model` reports the routed ID. **The `router:` prefix design stands.**
- **Subagents:** a subagent step arrives in `turn.step` with `agentId` set and `model: "claude-haiku-5-5"` (the alias resolved to a full ID). **Rule: the main-model pick rewrites only steps with no `agentId`.** Subagent steps keep their model, and the router's family override handles them.
- **(b) Mostly resolved.** `session.start` is fully awaited before the first model request (start-end at 9.4 s, first `/v1/messages` at 9.7 s). **But** the engine sends a connectivity check, `HEAD {base}/api/hello`, **before** `session.start` runs, so the router must answer it (200), and that check can't be covered by the mod spawning the router. Expect a startup warning if the router isn't up yet. Background calls (titles etc.) weren't observable in `-p`, but they happen after the first prompt, so after `session.start`.
- **(d) CONFIRMED, stripping is required.** The engine treats an unrecognized model like a full Claude model. Every request carries:
  - 9 `anthropic-beta` values (claude-code, interleaved-thinking, thinking-token-count, context-management, prompt-caching-scope, mid-conversation-tool-changes, inline-tools, advisor-tool, effort).
  - Body keys `thinking: {type:"adaptive",display:"omitted"}`, `context_management`, `output_config: {effort:"high"}`, `metadata`, `cache_control` on blocks, and `max_tokens: 32000`.
  - The system prompt starts with an `x-anthropic-billing-header: ...` text block, and requests send 45–54 tools.

  So the router needs per-provider handling for: beta header, `thinking`, `context_management`, `output_config`, `cache_control`, a **`max_tokens` clamp** (learned from 400s, D19), and possibly the billing text block.
- **New risk (e):** the engine doesn't know an unrecognized model's **context window**, so the auto-compact threshold and context % will be computed with defaults. Config should carry a `contextWindow` per model, and we need to check whether the engine exposes a way to set it (otherwise this is a known limitation).

## Next steps

1. ~~Approve Architecture (Section 1)~~ **Approved.** ~~Spike~~ **Done** (see Spike results).
2. ~~Ask where the mod lives~~ **Decided:** `C:\dev\llm\mods\model-router\`, next to `rtl-mode`.
3. Run the **spike** on risk (a), plus (b) if cheap. Results are throwaway and get recorded here.
4. Present the remaining design sections one at a time, each needing approval: **data flow** (request lifecycle, `/router` UX), **error handling** (fallback, router down, bad config), **testing** (router unit tests, `claude plugin test`, a manual end-to-end check against one real provider).
5. Write the spec to `docs/superpowers/specs/2026-10-15-model-router-design.md`, self-review it, and have the user review it.
6. Invoke `superpowers:writing-plans`.
