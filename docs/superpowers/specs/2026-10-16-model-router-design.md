# model-router: design spec

- **Status:** approved in brainstorming (sections 1–4), awaiting user review of this written spec
- **Date:** 2026-10-16
- **Target:** Claude Code 2.1.300, Node 24.13, Windows 11
- **Location:** `C:\dev\llm\mods\model-router\`
- **Brainstorm record:** `docs/model-router-brainstorm.md` (decisions D1–D18, spike results)

## 1. Goal

Let a Claude Code user:

1. Add models from other **Anthropic-compatible** providers, shown with the provider's name (`[DeepSeek] deepseek-chat`).
2. Switch the session's main model to one of them **mid-session**, from the built-in `/model` or from `/router`.
3. **Override** a Claude family (`haiku`, `sonnet`, `opus`, `fable`) so its requests go to an added model.
4. Have overrides apply to **every** request of that family, including background calls (titles, summaries, compaction) and subagents.

### Non-goals

- **Non-Anthropic API formats** (OpenAI, Gemini). Providers must speak the Messages API.
- **Per-model context and output *policy* for all models.** That's the separate `model-limits` plugin (§11).
- **Translating between thinking or tool formats.** Unsupported fields are stripped, not emulated.
- **Exposing the router to the network.**

## 2. Environment assumptions

- Claude Code reaches Anthropic through a **corporate gateway** that speaks the Anthropic API (`ANTHROPIC_BASE_URL`). Auth is via **`apiKeyHelper`** (short-lived token).
- The path to the gateway needs an **internal CA**: no proxy, no mTLS, no custom headers.
- Several Claude Code sessions may run in parallel.

## 3. Verified platform facts (spike, 2026-10-15)

- `turn.step` fires before every model request in the main loop **and subagents** (`agentId` set on subagents). `next({ ...e, model: 'router:X/y' })` is sent **verbatim** as the request's `model`. The engine only logs `[claude-code:unrecognized_model]`.
- Subagent steps carry the resolved Claude ID (e.g. `claude-haiku-5-5`).
- `session.start` is awaited before the first model request. **`HEAD {base}/api/hello` is sent before `session.start`.**
- Background engine calls are **not** `turn.step`s and aren't reachable by any mod hook. They only pass through `ANTHROPIC_BASE_URL`, which is why there's a router.
- For an unrecognized model the engine still sends:
  - 9 `anthropic-beta` values.
  - Body fields `thinking`, `context_management`, `output_config.effort`, `metadata`.
  - `cache_control` markers.
  - `max_tokens: 32000`.
  - An `x-anthropic-billing-header` system text block.
  - 45–54 tools.
- A child started with `$.process.spawn` is killed when the module unloads. Only a process "a command let go of" outlives it.
- A `command.run` hook may match a built-in command (e.g. `model`) and answer it or pass it on with `next(e)`.

## 4. Architecture

```
                         ANTHROPIC_BASE_URL=http://127.0.0.1:4141
Claude Code (any session) ───────────────────────────────▶ router (Node, detached, shared)
   ▲  mod: /model + /router, turn.step,                     │
   │  status line, toasts, lifecycle                        ├─ unrouted ──▶ upstream = corporate gateway (byte-for-byte)
   └──── GET /_router/status, /_router/events ◀────────────┤
                                                            └─ routed ────▶ provider baseUrl (provider key)
                                                                  └─ failure before 1st byte ─▶ upstream with original Claude ID
```

There are two parts, with one job each:

| Unit | Job | Depends on |
|---|---|---|
| **Router** (`router/`) | Route each HTTP request; make it compatible with the provider; fall back; learn compatibility limits; report status and events | Config file, environment (keys, CA). Knows nothing about the mod |
| **Mod** (`hooks/`) | UI (`/model`, `/router`, status line, toasts); per-session main pick; router lifecycle; setup/uninstall/doctor | Router's HTTP contract (§6.6), config file |

They communicate **only** through the config file (written by the mod, read by the router) and the router's HTTP endpoints (versioned).

## 5. Configuration

### 5.1 Files

| Path | Writer | Contents | Persistence |
|---|---|---|---|
| `~/.claude/model-router.json` | User / mod (never the router) | Settings (§5.2) | Permanent |
| `~/.claude/model-router/token` | Mod (setup) | Local access token (D18), user-readable only | Permanent |
| `~/.claude/model-router/setup-backup.json` | Mod (setup) | Original `ANTHROPIC_BASE_URL`, its source, and the original `ANTHROPIC_CUSTOM_HEADERS` | Until uninstall |
| `~/.claude/model-router/events.jsonl` | Router | Event log (rotated, 1 MB × 3) | Short |
| `~/.claude/model-router/router.log` | Router | One line per routed request (rotated, 5 MB × 3) | Short |

Circuit-breaker state and learned limits (§5.3) live only in router memory. The session main pick lives in mod `$.state`.

**Writes are atomic:** re-read, write a temp file, rename. Logs never contain prompts, responses or keys.

### 5.2 `model-router.json` schema

```jsonc
{
  "version": 1,
  "port": 4141,                                  // router listen port, 127.0.0.1 only
  "upstream": "https://llm-gw.corp.example",     // set by /router setup
  "providers": [
    {
      "name": "DeepSeek",                        // display label; [A-Za-z0-9._-], unique
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY",           // preferred; or "apiKey": "sk-…"
      "strip": ["anthropic-beta", "thinking", "context_management", "output_config"],  // optional, default shown
      "models": [
        { "id": "deepseek-chat" }                // no limits here (§5.3)
      ]
    }
  ],
  "overrides": { "haiku": "DeepSeek/deepseek-chat" },        // family → "Provider/model"
  "defaultMainModel": "DeepSeek/deepseek-chat"               // optional
}
```

- A **model reference** is `Provider/model-id`. The wire form of a routed main-model pick is `router:Provider/model-id#<original-claude-id>`. The part after `#` is the Claude model the step would otherwise have used (from `turn.step`'s `e.model`), and it's what fallback uses.
- **Validation:**
  - Unique provider names.
  - Every override or default references an existing model.
  - Families limited to `haiku|sonnet|opus|fable`.
  - Exactly one of `apiKeyEnv` / `apiKey`.
  - `baseUrl` is https, or http on loopback.

### 5.3 Limits: mechanism in the router, configuration in model-limits

The router has **no limit configuration**. Configured limits (caps, context windows, limits for Claude models) belong only to model-limits (§11). The router keeps two separate in-memory tables, each with one writer:

| Table | Writer | Contents | Lifetime |
|---|---|---|---|
| **learned** | Router, from provider 400s (§6.4) | Facts: `{ maxOutputTokens, learnedAt, source }` per routed `Provider/model-id` | Router memory only. Cleared by restart or `/router forget` |
| **policy** | model-limits, via `POST /_router/policy` (§11) | Intent: output caps the user configured | Until model-limits replaces or withdraws it |

- **Applied limit:** `max_tokens = min(requested, learned, policy)`, using whichever exist. Never raised.
- **Learn-and-retry always stays in the router.** Without it, routed models fail whenever model-limits isn't installed, because Claude Code asks for more than providers allow (e.g. 32000 vs. 8192).
- **Not persisted.** The cost is one fast 400 and a retry per model after each router restart, and no tokens are spent on it. In return there are no stale values and no cache file to manage.
- **model-limits reads but never writes the learned table.** It reads it through `GET /_router/limits` (§6.1) to display it, warn (for example when a configured cap is higher than a learned limit) and decide its policy. It never copies learned values into its policy. If it did, the router could no longer tell fact from intent, and `/router forget` would be undone by the next policy push.

## 6. Router

A Node 24 ESM program with **no dependencies**, `router/router.mjs`, plus focused modules in `router/lib/`:
- `resolve.mjs`
- `rewrite.mjs`
- `forward.mjs`
- `breaker.mjs`
- `learned.mjs`
- `config.mjs`
- `events.mjs`
- `status.mjs`

### 6.1 Listening and identity

- Binds **`127.0.0.1:<port>` only**.
- `HEAD /api/hello` → 200, answered locally.
- `GET /_router/status` → `{ name: "model-router", version, pid, uptimeMs, upstream, providers: [{ name, available, reason?, breaker }], models: [{ ref }], policyApi: 1 }`. The `name` field is the identity check: a port answering without it is "not ours".
- `GET /_router/limits` → `{ learned: { "<Provider/model-id>": { maxOutputTokens, learnedAt, source } }, policy: <current policy or null> }`. Read-only. No token is needed, because it holds no secrets.
- `POST /_router/forget` (token required), body `{ ref: "<Provider/model-id>" | "all" }`: clears entries from the learned table.
- `POST /_router/shutdown?drain=1` (token required): stop accepting, finish in-flight streams, exit.
- Reserved for model-limits: `POST /_router/policy` (§11), version `policyApi: 1`. **Answers 501 in this release.**

### 6.2 Resolve (per `/v1/messages` and `/v1/messages/count_tokens`)

1. `model` starts with `router:` → parse `Provider/model#fallback-id`. If it's unknown, unavailable or its breaker is open → **fall back** (§6.4) with `fallback-id`. A missing `#` part is treated as `claude-sonnet-5-5`.
2. Otherwise, if `model` contains a family name that has an override, and the override target is available and its breaker isn't open → that target. The fallback ID is the request's own `model`.
3. Otherwise → **pass-through** to `upstream`.

A request is never routed twice: fallback goes straight to upstream.

### 6.3 Rewrite (routed requests only)

1. **Auth and identity (D9, always):**
   - Remove `authorization`, `x-api-key`, `x-claude-code-session-id`, `x-router-token`, and any `ANTHROPIC_CUSTOM_HEADERS`-originated headers.
   - Remove body `metadata`.
   - Set `x-api-key: <provider key>`.
   - Keep `anthropic-version`.
2. **Model:** `model ← provider model ID`.
3. **Strip (D10):** remove the listed headers/body fields. The default list is above. `cache_control` is kept unless listed.
4. **Clamp (D11):** `max_tokens ← min(max_tokens, learned, policy)` with whichever limits are known (§5.3). Never raised.
5. Pass-through requests are forwarded **byte-for-byte** with all headers except hop-by-hop ones (`host`, `connection`, `content-length` recomputed only if needed). The router still removes `x-router-token`, which only exists for the router.

### 6.4 Forward, fallback, learning

- Responses (SSE or JSON) are **streamed through unbuffered**.
- **Before the first response byte:** on a connection error, timeout (connect 10 s, first byte 120 s), 5xx, 429 or 4xx:
  - **400 matching a `max_tokens` limit message** → parse the limit (fallback value 8192), store it in the in-memory learned table, retry **once on the same provider** with the clamped value, and emit `learned` event.
  - **Otherwise** → retry **once on upstream** with the original Claude model ID and the request's **original inbound headers**, kept in memory for this request only. Emit a `fallback` event with status and the provider's error text (≤200 chars). Count a breaker failure.
- **After the first byte:** errors pass through unchanged (D8).
- **Pass-through errors are only observed:** emit an `upstream-error` event (for model-limits) and change nothing.
- **Routed-provider errors** (every failure, the context-length ones included) also emit a `provider-error` event with status and error text. The router doesn't learn context windows; model-limits can learn from these events.

### 6.5 Circuit breaker

- Per provider: **3 consecutive failures → open for 5 minutes** (routed traffic goes straight to Claude), then **half-open:** the next request is a trial. Success → closed; failure → open again.
- Emit `breaker-open` / `breaker-close` events (global, not session-scoped).

### 6.6 Events

- An event is `{ seq, t, kind, session?, provider?, model?, status?, text? }`.
- `session` comes from the inbound `x-claude-code-session-id`.
- Kinds: `fallback`, `learned`, `breaker-open`, `breaker-close`, `upstream-error`, `provider-error`, `config-error`, `config-reloaded`.
- Served at `GET /_router/events?after=<seq>`, which returns the in-memory ring of the last 500 events, and also appended to `events.jsonl`.

### 6.7 Config, keys, environment

- Config is reloaded on file change (debounced 300 ms). Invalid config → **keep the last valid one** and emit `config-error`.
- Keys are read from `process.env[apiKeyEnv]` at each request. A missing key marks the provider unavailable (`reason: "env DEEPSEEK_API_KEY not set"`).
- **Local token (D18):** routed requests need `x-router-token` equal to the token file's content, otherwise 401 with an explanation. Pass-through doesn't need it.
- **TLS:** trust comes from Node's `NODE_EXTRA_CA_CERTS`. On Windows the launcher also passes `--use-system-ca`.
- **Idle exit:** after 30 minutes without requests.
- **Second instance:** if the port is taken and `/_router/status` identifies a router, exit 0 quietly.

### 6.8 `count_tokens` for routed models

Forward to the provider if it supports it. On 404/400, answer `{ input_tokens: ceil(bodyChars / 4) }` locally.

## 7. Mod

### 7.1 Layout

```
model-router/
  .claude-plugin/plugin.json      name, version, description, author, types, userConfig
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              wires the hooks below
  hooks/lifecycle.ts              ensureRouter(): status → launch → wait
  hooks/picker.tsx                unified picker (used by /model and /router)
  hooks/commands.ts               /router subcommand parsing + handlers
  hooks/setup.ts                  setup / uninstall
  hooks/doctor.ts                 doctor checks + report
  hooks/status.ts                 status-line text, event → toast
  hooks/config.ts                 read/validate/atomic-write model-router.json
  types/index.d.ts                $.state contract (session pick)
  router/…                        §6, plus router/launch.mjs
  tests/*.test.ts                 mod tests (claude plugin test)
  router/test/*.test.mjs          router tests (node --test)
  e2e/                            headless end-to-end scripts + fakes
```

`userConfig`:
- `takeOverModelCommand: boolean`, default `true` (D15).

### 7.2 `session.start`

1. `ensureRouter()`:
   - Call `GET /_router/status` (1 s timeout).
   - If not ours or no answer: run `node [--use-system-ca] router/launch.mjs` via `$.process.run`. The launcher spawns the router **detached**, waits for its listen line and exits.
   - Poll status every 250 ms for up to 5 s.
   - **Version mismatch:** `POST /_router/shutdown?drain=1`, then launch.
2. Register `/router`.
3. Session pick ← `defaultMainModel`, if set and valid.
4. Set the status line.
5. Start the timers:
   - `$.clock.every(2s)` polls `/_router/events`. It toasts events whose `session` equals this session, plus global ones.
   - `$.clock.every(10s)` health-checks and respawns, toasting "model-router restarted".

Failure → status line `model-router DOWN — /router doctor`. The session continues; model calls will fail until the router is fixed.

### 7.3 `turn.step`

- If `e.agentId` is unset **and** the session pick is set → `yield* next({ ...e, model: 'router:' + pick + '#' + e.model })`.
- If the last status says the pick's provider is unavailable, the mod passes `e` unchanged, avoiding a pointless fallback round-trip.
- Otherwise `yield* next(e)`. `effort` is never changed.

### 7.4 Session pick and built-in model changes

- The pick lives in `$.state` (`model-router.pick: string | null`).
- If `session.model` changes to a Claude model the user picked (built-in picker), the pick is cleared.

### 7.5 `/model` (D15, D16)

The hook is `command.run`, matching `{ command: 'model' }`, wrapped in `.catch(… → next(e))`.

| Toggle | Input | Behavior |
|---|---|---|
| on | `/model` | Unified picker. Groups:<br>1. "Claude": the session's current Claude model and aliases `opus`, `sonnet`, `haiku`, `fable`, with override annotations, e.g. `haiku → [DeepSeek] deepseek-chat`.<br>2. One group per provider: `[Provider] model`, with unavailable entries greyed plus the reason.<br>3. "Claude Code's picker…" (runs `next(e)`).<br>Footer: `manage: /router`. Picking a Claude entry clears the pick and passes `/model <alias>` to `next`. Picking a routed entry sets the pick |
| on | `/model <routed name>` | Set the pick. Print `Main model: [Provider] model` |
| on/off | `/model <anything else>` | `next(e)` unchanged |
| off | `/model` | `next(e)` (stock) |
| off | `/model <routed name>` | Set the pick. Print the confirmation plus `tip: use /router` |

**Name matching**, in order:
1. Exact `Provider/model`.
2. Bare model ID, if unique across providers.
3. Ambiguous → listed with a hint.

**Management actions are never offered in `/model`.**

### 7.6 `/router` (D14)

| Command | Behavior |
|---|---|
| `/router` | Same unified picker, plus management actions: set default, override…, add provider, doctor |
| `/router <name>` / `/router claude` | Set / clear the session pick |
| `/router default <name\|clear>` | Write `defaultMainModel` (new sessions only) |
| `/router override <family> <name\|clear>` | Write `overrides[family]` (global, takes effect on the next request in all sessions) |
| `/router add` | Wizard: name → base URL → key (`apiKeyEnv` name by default, a literal key allowed with a warning) → model IDs → test call → save |
| `/router remove <provider\|provider/model>` | Remove, and clear overrides/default pointing at it (with a warning) |
| `/router setup` | §7.8 |
| `/router uninstall` | Restore from `setup-backup.json` (future sessions). Never stops the router |
| `/router doctor [--offline]` | §7.9 |
| `/router forget <provider/model\|all>` | Clear entries from the router's in-memory learned table (`POST /_router/forget`) |

A subcommand name beats a same-named model; the user then writes `Provider/model`.

### 7.7 Status line and toasts

**Status line:**
- `main: [DeepSeek] deepseek-chat · haiku→[DeepSeek] deepseek-chat`
- With nothing routed: `router: /router to pick` (plus overrides, if any).
- A paused provider appears as `[DeepSeek] ⚠  paused` (**two spaces** after ⚠).
- When the router is down: `model-router DOWN — /router doctor`.

**Toasts** come from events:

| Event | Toast |
|---|---|
| `fallback` | `[DeepSeek] 429 → used claude-haiku-5-5` |
| `fallback`, with provider error text | `[Kimi] rejected (400: unknown field 'thinking') — /router doctor` |
| `learned` | `[DeepSeek] max output 8192 learned` |
| `breaker-open` / `breaker-close` | One toast each |
| `config-error` | File plus field/line |

### 7.8 `/router setup` (idempotent)

1. **Find the gateway:** read the current `ANTHROPIC_BASE_URL` and its source (`~/.claude/settings.json` env, OS env, managed settings).
   - If the router is already the base URL → report the state and stop.
   - If a higher-precedence source sets it → print the manual change and stop.
2. **Save:** write `upstream` to config. Generate a token if none exists (user-only permissions).
3. **Back up** the original values to `setup-backup.json`.
4. **Wire Claude Code:** write `env.ANTHROPIC_BASE_URL = http://127.0.0.1:<port>` to `~/.claude/settings.json`, and **merge** `x-router-token: <token>` into `env.ANTHROPIC_CUSTOM_HEADERS` (newline-separated).
5. **Check the router:** start it and confirm `/_router/status`.
6. **Report:**
   - What changed.
   - The manual undo (restore the `ANTHROPIC_BASE_URL` line).
   - "Restart Claude Code to activate". The upstream auth check runs in doctor after the restart.

### 7.9 `/router doctor`

A checklist with ✓ / ⚠ / ✗ marks and a fix line for every non-✓ item:
- Router running, version, port ownership.
- Wiring: base URL → router, with its source. Project-level `.claude/settings.json` bypass.
- Token header present.
- Upstream reachable, **with auth**: a 1-token `$.model.complete` on a non-overridden family through the normal path. If every family is overridden, show ⚠ "can't test upstream auth while all families are overridden".
- Upstream TLS trust, with a specific "untrusted certificate" fix.
- Config validity.
- Per provider:
  - Key variable set, and changed since router start (offer a restart).
  - TLS.
  - A **test request** reporting the rejected field or the learned `max_tokens` (skipped with `--offline`).
- Breakers.
- Learned limits and any registered policy, read-only (from `GET /_router/limits`).
- Literal keys in config (warn).
- One line: `Optional: model-limits (per-model context/output policies)`.

## 8. Security

- The router listens only on loopback.
- Provider keys are injected only for requests carrying the local token (D18).
- Inbound gateway credentials never reach a provider (D9). They're held in memory for at most one request's fallback.
- Nothing secret is logged.
- Doctor warns about literal keys in config.
- If the corporate network does TLS inspection, provider traffic is visible to it. This is documented in the README.

## 9. Error handling summary

| Situation | Behavior |
|---|---|
| Provider fails before first byte | Fallback to Claude plus a session toast |
| `max_tokens` 400 | Learn the limit, retry on the same provider |
| Provider fails mid-stream | Error passes through |
| 3 consecutive failures | Breaker open for 5 min |
| Invalid config | Keep last valid, toast |
| Missing key | Provider unavailable, overrides go to Claude |
| Removed pick | Pick cleared, toast |
| Router down | Spawn / respawn; status-line warning |
| Port taken by a foreign process | Error with port hint |
| Parallel spawns | Bind race; loser exits |
| Router version mismatch | Graceful drain, then restart |
| `/model` hook error | Built-in `/model` |
| Project-level base URL | Reported by doctor |

## 10. Testing

TDD throughout: test first, then code.

1. **Router unit** (`node --test router/test`):
   - Resolve.
   - Rewrite: D9 headers/metadata, strip defaults, clamp never raises, pass-through identical.
   - Limit parsing from a fixture set of real provider error strings.
   - Limits: `min(requested, learned, policy)` for every combination of present/absent; forget one/all.
   - Breaker with a fake clock.
   - Config validation and keep-last-valid.
   - Event ring.
2. **Router integration** (real HTTP; fake upstream and fake provider on random ports):
   - **Unbuffered SSE**: timing assertion.
   - Byte-identical pass-through.
   - Fallback for each failure class, using the original inbound auth.
   - Mid-stream pass-through.
   - `max_tokens` learn and retry; the learned value shows in `GET /_router/limits` and is gone after a restart.
   - Token required for routed requests only.
   - `HEAD /api/hello`, status identity, drain, bind race, idle exit.
   - **HTTPS upstream with a self-signed CA**, trusted vs. untrusted.
3. **Mod** (`claude plugin test`):
   - `turn.step` rewrites only when there's no `agentId` and a pick is set.
   - `/model` takeover matrix (§7.5), including the `.catch` fallback.
   - `/router` parsing and the subcommand-vs-model rule.
   - Session-scoped toasts.
   - Exact status-line strings, including the two-space `⚠  paused`.
   - `ensureRouter` paths: router HTTP mocked through the test kit's `http.fetch` hook.
   - Plus `claude plugin validate` and `tsc -p`.
4. **Headless E2E** (`e2e/`): `claude -p` → real router → fakes, covering:
   - Routed main model.
   - Haiku subagent via override.
   - Provider failure → fallback succeeds.
5. **Manual release checklist** (real gateway plus one real provider):
   - Setup with `apiKeyHelper` and the internal CA.
   - Interactive session: title and compaction requests go to the override (`router.log`).
   - `/model` picker and "Claude Code's picker…" entry.
   - A Claude pick clears the routed pick.
   - `unrecognized_model` visibility.
   - A session longer than the token TTL.
   - Two parallel sessions: toast isolation, kill/respawn, uninstall while another session runs.

### Verification items: first tasks of the plan

Each one, if it fails, changes the design at the noted point.

| # | Check | If it fails |
|---|---|---|
| V1 | A `command.run` hook on built-in `model` can answer it, and `next(e)` opens the original picker | Drop the takeover; `/router` only, plus a `/model <routed>` catch if possible |
| V2 | `x-claude-code-session-id` equals `$.session.id()` (interactive, background calls included) | Toasts go global, with a session hint where known |
| V3 | A router started via `$.process.run` → detached launcher survives session exit and hot reload | Windows `start /b` or a scheduled-task launcher |
| V4 | `--use-system-ca` on Node 24.13 trusts the Windows store CA | Require `NODE_EXTRA_CA_CERTS` and document the export |
| V5 | How a Claude pick in the built-in picker shows up (`session.model`, `command.run` args) | Clear the pick on any `/model` passed to `next` |
| V6 | Writing `~/.claude/settings.json` from the mod (`$.fs.write`, permissions) | Setup prints the exact JSON for the user to paste |
| V7 | The engine accepts `#` inside the model string (`router:P/m#claude-opus-5-5`). The spike sent `:` and `/` verbatim | Use another separator (e.g. `~`) |

## 11. Related: model-limits (separate plugin, later)

- **Owns all limit configuration**, for **all** models: per-model `contextWindow` and `maxOutputTokens`, and compaction via `$.session.usage()` + `$.session.compact()`. The user configures limits in one place only.
- **What its config is for**, given that the router learns provider maximums anyway:
  - Caps below the provider's maximum (cost, speed).
  - Known limits set ahead of time, so there is no first 400.
  - Limits for the org's Claude models (e.g. a gateway that caps silently, leaving nothing to learn).
  - Context windows, which the router never learns.
- **With the router present** (the two directions are separate):
  - **Writes policy:** turns its config into output-cap rules and registers them at `POST /_router/policy` (`policyApi: 1`). The router applies them, including to pass-through traffic, only while rules are registered.
  - **Reads facts:** `GET /_router/limits` for the learned table, plus the `upstream-error` / `provider-error` events. It combines these with its config however its own logic decides, but never writes learned values back as policy (§5.3).
  - **Applied limit:** `max_tokens = min(requested, learned, policy)`. Every term is an upper bound, so no tiebreak is needed.
- Any persistence of its own (e.g. `~/.claude/model-limits/`) is its own decision. The router persists no limits.
- **Without the router:** context compaction only. It tells users about the router when a rule needs it (inline on rule creation, one toast per session if rules are inactive, `/limits status`).
- **Scope for Claude models (answered 2026-10-16):** assume **both** context and output. Context is handled in-engine by compaction. Output caps go through the router's policy, applied to pass-through traffic, which is why `POST /_router/policy` must cover Claude models and not only routed ones.
- Gets its own brainstorm, spec and plan.

## 12. Packaging

- One marketplace at `C:\dev\llm\mods\.claude-plugin\marketplace.json` lists `rtl-mode`, `model-router` and, later, `model-limits`. It replaces `rtl-mode/.claude-plugin/marketplace.json`.
- No `dependencies` link between the plugins.
- README per plugin, plus a root README with a "Which do I need?" table and the install line `/plugin install model-router@<marketplace>`.
