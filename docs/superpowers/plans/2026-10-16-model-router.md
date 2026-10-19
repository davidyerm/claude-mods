# model-router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `model-router` Claude Code plugin: a shared local Node router that sends chosen requests to Anthropic-compatible providers (with fallback to Claude), plus a mod that adds routed models to `/model`, a `/router` command, overrides, a status line, toasts, setup and doctor.

**Architecture:** Two units that talk only through `~/.claude/model-router.json` and the router's versioned HTTP endpoints. The router (`model-router/router/`, Node 24 ESM, no dependencies) answers `ANTHROPIC_BASE_URL` for every session: pass-through to the corporate gateway byte-for-byte, or rewrite-and-forward to a provider with fallback, learn-and-retry for `max_tokens`, a circuit breaker and an event ring. The mod (`model-router/hooks/`, a Claude Code hooks module) starts the router detached through `router/launch.mjs`, rewrites the main-loop model in `turn.step`, and owns all UI.

**Tech Stack:** Node 24.13 (`node:http`, `node:https`, `node:test`), Claude Code 2.1.300+ function hooks (`claude-code` API, `claude-code/testing` kit), TypeScript 5.6 for type-checking only (`npx`), Git Bash on Windows 11.

**Spec:** `docs/superpowers/specs/2026-10-16-model-router-design.md` (authoritative). Background: `docs/model-router-brainstorm.md` (decisions D1–D19).

## Global Constraints

- Node **24.13**; router code imports only `node:` built-ins. No `package.json`, no npm dependencies. TypeScript is used only through `npx -y -p typescript@5.6.3 tsc`.
- Router binds **`127.0.0.1` only**; default port **4141** (`port` in config).
- Files exactly as spec §5.1: `~/.claude/model-router.json` (never written by the router), `~/.claude/model-router/token`, `~/.claude/model-router/setup-backup.json`, `~/.claude/model-router/events.jsonl` (1 MB × 3), `~/.claude/model-router/router.log` (5 MB × 3). `~` is resolved as: `MODEL_ROUTER_HOME` → `CLAUDE_CONFIG_DIR` → `<home>/.claude` (same order in router and mod; `MODEL_ROUTER_HOME` exists for tests and e2e). The launcher adds `~/.claude/model-router/router.out` (the detached router's stdout/stderr, truncated at each launch) for crash diagnosis.
- Logs and events never contain prompts, responses or keys. Event `text` is cut to **200** characters.
- Timeouts and limits: connect **10 s**, first byte **120 s**, breaker **3 failures → open 5 min**, idle exit **30 min**, event ring **500**, config reload debounce **300 ms**, `max_tokens` fallback value **8192**, mod health poll **10 s**, event poll **2 s**.
- Wire form of a routed main-model pick: **`router:Provider/model-id#<claude-id>`** (V7 may change `#`; it is the single constant `FALLBACK_SEP` in `router/lib/resolve.mjs` and `hooks/pick.ts`). Missing `#` part → `claude-sonnet-5-5`.
- Status-line strings exactly as spec §7.7, including **`[DeepSeek] ⚠  paused`** with **two spaces** after `⚠`.
- Validation rules exactly as spec §5.2: unique provider names `[A-Za-z0-9._-]+`; overrides/default reference existing models; families `haiku|sonnet|opus|fable`; exactly one of `apiKeyEnv`/`apiKey`; `baseUrl` https, or http on loopback.
- Hook budget is **10 s of the hook's own time** and `$.clock.sleep` counts against it; every wait longer than a second happens inside `node router/launch.mjs …` run through `$.process.run` (whose time is free). This is why the launcher, not the mod, polls the router after spawning it (spec §7.2 step 1 moves into the launcher; behaviour is the same).
- The mod environment has no Node, no fs, no network: everything goes through `$`. `$.env.get` takes **string literals only**, so env-var values named in config (`apiKeyEnv`) are read only by `launch.mjs` subcommands. File writes from the mod go through `node router/launch.mjs write <path>` (atomic temp + rename), because `$.fs` has no rename.
- All paths in this plan are relative to the repo root `C:\dev\llm\mods`. The plugin root is `model-router/`.
- Shell: Git Bash. Use `rtk <cmd>` when `rtk` is on PATH (the user's global rule); it is not on Git Bash's PATH on this machine, so plain `git`/`node` is fine there. On Git Bash, prefix `openssl` commands that take `-subj "/CN=…"` with `MSYS_NO_PATHCONV=1`.
- Every commit message ends with the attribution trailer lines your session's instructions specify. Work on branch `model-router`; do not push.
- Before any mod task, load the `plugin-authoring` skill: its header names this process's API types file (`…/plugin-authoring/types/claude-code.d.ts`). That file is the authority for every `$` call used below; when a signature in this plan disagrees with it, follow the types file and note the change in the task's commit message.

## Review Focus

1. **Query strings on the messages path.** Claude Code may send `POST /v1/messages?beta=true`. The router must still resolve and route it (provider URL without the query), and pass-through must keep the query byte-for-byte. Pinned in Task 13 (pass-through) and Task 14 (routed).
2. **Model IDs that contain `/`** (OpenRouter style: `OpenRouter/anthropic/claude-x`). A ref splits on the **first** `/` only, everywhere (schema, resolve, `/model` name matching, display). Pinned in Task 5 and Task 7 and Task 19.
3. **Provider error bodies that are not Anthropic JSON**: HTML error pages, huge bodies, gzip. The router must still fall back, events carry ≤200 readable characters, and routed requests drop `accept-encoding` so error bodies are readable. Pinned in Task 9 (rewrite) and Task 14 (HTML 502).
4. **Existing `~/.claude/settings.json` content**: other keys, other env vars, CRLF-separated `ANTHROPIC_CUSTOM_HEADERS`, a missing file. Setup must merge without clobbering anything, run twice without adding a second token line, and uninstall must restore exactly. Pinned in Task 27.
5. **Client disconnects mid-stream** (Esc in Claude Code). The router must abort the provider/upstream request, not crash, and keep serving. Pinned in Task 14.

---

## File Structure

```
.claude-plugin/marketplace.json            root marketplace: rtl-mode + model-router (Task 31)
README.md                                  root README with "Which do I need?" (Task 31)
rtl-mode/.claude-plugin/marketplace.json   deleted (Task 31)
docs/model-router-verification.md          V1–V7 results and decisions (Tasks 1–4)
docs/model-router-spike/…                  spike helpers, extended for V-items (Tasks 1, 3)
model-router/
  .claude-plugin/plugin.json               manifest + userConfig.takeOverModelCommand
  .claude-plugin/types/                    API types copied for tsc (gitignored)
  hooks/hooks.json                         { "modules": ["./register.tsx"] }
  hooks/register.tsx                       wires every hook; owns the monitor timers
  hooks/paths.ts                           where every file lives (env-literal lookups)
  hooks/host.ts                            runTool/readText/writeFile/deleteFile via launch.mjs
  hooks/config.ts                          load/validate/update model-router.json; display; findModel
  hooks/client.ts                          router HTTP client (status, events, limits, keys, forget, shutdown)
  hooks/lifecycle.ts                       ensureRouter()
  hooks/pick.ts                            $.state atoms, setPick/clearPick, wireModel, isRoutable
  hooks/status.ts                          statusLine(), toastFor(), isForSession()
  hooks/monitor.ts                         refresh(), tick(), health() — the timers' bodies
  hooks/picker.tsx                         unified picker pane (used by /model and /router)
  hooks/add.tsx                            /router add wizard pane
  hooks/commands.ts                        parseRouterArgs() + runRouterCommand()
  hooks/setup.ts                           /router setup and /router uninstall
  hooks/doctor.ts                          /router doctor
  types/index.d.ts                         $.state contract
  tsconfig.json                            type-check config
  tests/world.ts                           test stubs for fs/env/http/process/settings/ui
  tests/*.test.ts(x)                       mod tests (claude plugin test)
  router/version.mjs                       VERSION (imported by router, launcher and mod)
  router/router.mjs                        CLI entry: start the server, second-instance rule
  router/launch.mjs                        detached start + tool subcommands (probe, env-check, write, ensure-token)
  router/lib/schema.mjs (+ .d.mts)         pure config validation, refs (imported by the mod too)
  router/lib/config.mjs                    paths, file read, watched store with keep-last-valid
  router/lib/resolve.mjs                   §6.2
  router/lib/learned.mjs                   limit parsing, learned table, appliedLimit
  router/lib/rewrite.mjs                   §6.3
  router/lib/breaker.mjs                   §6.5
  router/lib/events.mjs                    event ring + rotating files
  router/lib/forward.mjs                   outbound request with timeouts and failure classes
  router/lib/status.mjs                    /_router/status body
  router/lib/client.mjs                    Node-side status/shutdown client (CLI + launcher)
  router/lib/fingerprint.mjs               sha256 prefix of a key
  router/lib/probe-request.mjs             the representative request doctor/add send
  router/lib/server.mjs                    createRouter(): the HTTP server
  router/test/*.test.mjs                   node --test
  router/test/helpers.mjs, fakes.mjs       temp homes, fake Anthropic servers, raw client
  router/test/fixtures/                    limit-error strings, test CA + server cert
  e2e/run.mjs                              headless claude -p scenarios
  docs/release-checklist.md                manual release checklist (spec §10.5)
  README.md                                plugin README
```

---

## Phase 0 — Verification items (spec §10, V1–V7)

These run before any product code. Each records its outcome in `docs/model-router-verification.md`. Tasks 1–2 are runnable by an agent; Task 3 needs the human in an interactive session; Task 4 is the decision gate.

### Task 1: V7 and V2 (headless) with the capture server

**Files:**
- Modify: `docs/model-router-spike/capture-server.mjs` (log the session header and `context_management`)
- Modify: `docs/model-router-spike/mod/hooks/register.ts` (send `#` in the model; report `$.session.id()`)
- Create: `docs/model-router-verification.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/model-router-verification.md` with sections `V1`…`V7` and **"Captured request shape"** (the exact `anthropic-beta` header value and `context_management` body value an unrecognized model gets). Task 17 copies those two values into `router/lib/probe-request.mjs`.

- [ ] **Step 1: Extend the capture server's log line**

In `docs/model-router-spike/capture-server.mjs`, inside the `log({ method: req.method, … })` call, add three fields after `beta: h['anthropic-beta'],`:

```js
          session: h['x-claude-code-session-id'], contextManagement: json.context_management, rawModel: json.model,
```

- [ ] **Step 2: Make the spike mod send `#` and report the session id**

Replace `docs/model-router-spike/mod/hooks/register.ts` with:

```ts
// THROWAWAY spike: V7 (does '#' survive in the model string?) and V2
// (does x-claude-code-session-id equal $.session.id()?).
import type { Register } from 'claude-code'

const BASE = 'http://127.0.0.1:4199'
const ROUTED = 'router:Test/fake-model#claude-opus-5-5'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    await $.http.fetch(`${BASE}/mark?ev=session-id&d=${encodeURIComponent(id)}`)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    await $.http.fetch(`${BASE}/mark?ev=step-in&d=${encodeURIComponent(JSON.stringify({ model: e.model, agentId: e.agentId }))}`)
    return yield* next({ ...e, model: ROUTED })
  })
}
```

- [ ] **Step 3: Run the capture**

```bash
cd /c/dev/llm/mods
rm -f docs/model-router-spike/capture.jsonl
node docs/model-router-spike/capture-server.mjs &
SERVER=$!
ANTHROPIC_BASE_URL=http://127.0.0.1:4199 ANTHROPIC_API_KEY=dummy \
  claude -p "say hi" --plugin-dir docs/model-router-spike/mod 2> docs/model-router-spike/stderr.txt
kill $SERVER
```

Expected: the command prints `spike-ok from router:Test/fake-model#claude-opus-5-5`.

- [ ] **Step 4: Read the results**

```bash
grep -E '"path":"/v1/messages"' docs/model-router-spike/capture.jsonl | head -3
grep -E '"mark":"session-id"' docs/model-router-spike/capture.jsonl
grep -c unrecognized_model docs/model-router-spike/stderr.txt
```

- **V7 passes** when every `/v1/messages` line has `"rawModel":"router:Test/fake-model#claude-opus-5-5"` exactly.
- **V2 (headless) passes** when every `/v1/messages` line's `"session"` equals the `session-id` mark's `data`.

- [ ] **Step 5: Write `docs/model-router-verification.md`**

```markdown
# model-router verification (V1–V7)

Spec: docs/superpowers/specs/2026-10-16-model-router-design.md §10. Each item: result, evidence, decision.

| # | Result | Decision |
|---|---|---|
| V1 | pending (Task 3) | |
| V2 | headless: <PASS/FAIL>; interactive: pending (Task 3) | |
| V3 | pending (Task 3) | |
| V4 | pending (Task 2) | |
| V5 | pending (Task 3) | |
| V6 | pending (Task 3) | |
| V7 | <PASS/FAIL> | <keep '#' / switch FALLBACK_SEP to '~'> |

## Captured request shape (unrecognized model, Claude Code <version from `claude --version`>)

- `anthropic-beta`: `<paste the "beta" value of the first /v1/messages line verbatim>`
- `context_management`: `<paste the "contextManagement" JSON verbatim>`
- `thinking`: `<paste>`; `output_config`: `<paste>`; `max_tokens`: `<paste maxTokens>`

## Evidence

<paste the grep output from Step 4>
```

Fill every `<…>` from the Step 4 output (these are recorded observations, not plan placeholders). Keep `docs/model-router-spike/capture.jsonl` and `stderr.txt` out of git (they may hold prompts): add both to `docs/model-router-spike/.gitignore`:

```
capture.jsonl
stderr.txt
```

- [ ] **Step 6: Commit**

```bash
git add docs/model-router-spike docs/model-router-verification.md
git commit -m "Verify V7 and headless V2 with the capture server"
```

### Task 2: V4 — `--use-system-ca` on Node 24.13

**Files:**
- Create: `docs/model-router-spike/tls-check.mjs`
- Modify: `docs/model-router-verification.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the V4 row. If V4 fails, Task 17's `nodeFlags()` returns `[]` and the README/doctor require `NODE_EXTRA_CA_CERTS`.

- [ ] **Step 1: Write the check script**

```js
// THROWAWAY: V4. Does node:https trust the gateway's certificate?
// Usage: node [--use-system-ca] tls-check.mjs <https-url>
import https from 'node:https'

const url = process.argv[2]
const req = https.request(url, { method: 'HEAD', timeout: 10_000 }, res => {
  console.log(JSON.stringify({ ok: true, status: res.statusCode, flags: process.execArgv }))
  res.resume()
})
req.on('timeout', () => req.destroy(new Error('timeout')))
req.on('error', err => console.log(JSON.stringify({ ok: false, code: err.code ?? err.message, flags: process.execArgv })))
req.end()
```

- [ ] **Step 2: Run it with and without the flag against the gateway**

```bash
cd /c/dev/llm/mods
GW="$(node -e "const s=require(require('os').homedir()+'/.claude/settings.json');console.log((s.env&&s.env.ANTHROPIC_BASE_URL)||process.env.ANTHROPIC_BASE_URL||'')")"
echo "gateway: $GW"
env -u NODE_EXTRA_CA_CERTS node docs/model-router-spike/tls-check.mjs "$GW"
env -u NODE_EXTRA_CA_CERTS node --use-system-ca docs/model-router-spike/tls-check.mjs "$GW"
```

If `GW` is empty, ask the human for the gateway URL. Expected for **V4 PASS**: the first line may be `"ok":false` with a code like `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`; the second line is `"ok":true`. If both are `ok:true`, the CA is public or already in Node's store: record "PASS (not needed)". If the second is `ok:false`, V4 FAILS.

- [ ] **Step 3: Record and commit**

Fill the V4 row: result, both output lines, decision (`keep --use-system-ca on win32` or `drop flag; require NODE_EXTRA_CA_CERTS`).

```bash
git add docs/model-router-spike/tls-check.mjs docs/model-router-verification.md
git commit -m "Verify V4: Node system CA trust for the gateway"
```

### Task 3: V1, V2 (interactive), V3, V5, V6 — human-driven probe session

**Files:**
- Create: `docs/model-router-spike/probe/.claude-plugin/plugin.json`
- Create: `docs/model-router-spike/probe/hooks/hooks.json`
- Create: `docs/model-router-spike/probe/hooks/register.ts`
- Create: `docs/model-router-spike/probe/detached.mjs`
- Modify: `docs/model-router-verification.md`

**Interfaces:**
- Consumes: the capture server from Task 1.
- Produces: rows V1, V2 (interactive), V3, V5, V6.

- [ ] **Step 1: Write the probe mod**

`docs/model-router-spike/probe/.claude-plugin/plugin.json`:

```json
{ "name": "mr-probe", "version": "0.0.1", "description": "THROWAWAY: model-router verification probe" }
```

`docs/model-router-spike/probe/hooks/hooks.json`:

```json
{ "modules": ["./register.ts"] }
```

`docs/model-router-spike/probe/hooks/register.ts`:

```ts
// THROWAWAY probe for V1, V3, V5, V6 (and V2 in an interactive session).
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'mr-probe: builtin | launch | settings' })
    $.ui.log(`mr-probe: V2 session id = ${await $.session.id()}`)
    let seen = await $.session.model()
    $.ui.log(`mr-probe: V5 session model at start = ${seen}`)
    $.clock.every(1000, async () => {
      const now = await $.session.model()
      if (now !== seen) { $.ui.log(`mr-probe: V5 session.model changed ${seen} -> ${now}`); seen = now }
    })
    return next(e)
  })

  // V1: can a command.run hook answer the built-in /model, and does next(e) still open the picker?
  on('command.run', { command: 'model' }, async ($, e, next) => {
    $.ui.log(`mr-probe: V1/V5 /model args=${JSON.stringify(e.args)} origin=${JSON.stringify(e.origin)}`)
    if (e.args.trim() === 'probe-answer') return { text: 'V1: answered by mr-probe' }
    const before = await $.session.model()
    const result = await next(e)
    $.ui.log(`mr-probe: V5 after next(e): model ${before} -> ${await $.session.model()}, result=${JSON.stringify(result)}`)
    return result
  })

  on('command.run', { command: 'probe' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'builtin') {
      // V1 second half: does $.command.run reach the built-in picker (skipping this plugin's own hook)?
      await $.command.run({ command: 'model' })
      return { text: 'V1: asked $.command.run({ command: "model" })' }
    }
    if (arg === 'launch') {
      // V3: a detached child started through a short-lived launcher.
      const started = await $.clock.now()
      const r = await $.process.run(['node', `${$.plugin.root}/detached.mjs`], { timeoutMs: 20_000 })
      return { text: `V3: launcher exit ${r.exitCode} after ${(await $.clock.now()) - started} ms: ${r.stdout.trim()} ${r.stderr.trim()}` }
    }
    if (arg === 'settings') {
      // V6: may the mod rewrite ~/.claude/settings.json? Rewrites identical text.
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
      const file = `${home}/.claude/settings.json`
      const text = await $.fs.read(file)
      try { await $.fs.write(file, text); return { text: `V6: $.fs.write OK on ${file}` } }
      catch (err) { return { text: `V6: $.fs.write refused: ${String(err)}` } }
    }
    return { text: 'usage: /probe builtin | launch | settings' }
  })
}
```

`docs/model-router-spike/probe/detached.mjs`:

```js
// THROWAWAY: V3 launcher. Spawns a detached child that serves :4198 until /quit.
import { spawn } from 'node:child_process'
import http from 'node:http'

if (process.argv[2] === 'child') {
  const server = http.createServer((req, res) => {
    res.end(`alive pid=${process.pid}\n`)
    if (req.url === '/quit') server.close(() => process.exit(0))
  })
  server.listen(4198, '127.0.0.1')
} else {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'child'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  console.log(`spawned pid=${child.pid}`)
}
```

- [ ] **Step 2: Validate the probe**

```bash
cd /c/dev/llm/mods && claude plugin validate docs/model-router-spike/probe
```

Expected: no errors (a `gating hook without .catch` line for `command.run (model)` is a fact, not an error).

- [ ] **Step 3: Hand the session to the human**

Print these instructions for the human and wait for their report:

```
1. In a Git Bash window:  cd /c/dev/llm/mods && node docs/model-router-spike/capture-server.mjs
2. In a second window:    cd /c/dev/llm/mods && ANTHROPIC_BASE_URL=http://127.0.0.1:4199 ANTHROPIC_API_KEY=dummy claude --plugin-dir docs/model-router-spike/probe
3. Type: hello            (wait for "spike-ok"; this also triggers the background title request)
4. Type: /model probe-answer      → expect "V1: answered by mr-probe"
5. Type: /model                   → expect the built-in picker; pick a DIFFERENT model (e.g. Sonnet); note the mr-probe lines
6. Type: /probe builtin           → does the built-in picker open? Do mr-probe "/model args" lines appear (they should not)?
7. Type: /probe settings          → note the V6 line; was there a permission prompt?
8. Type: /probe launch            → note the V3 line (exit code and ms; > 15000 ms means it hung)
9. In a third window: curl -s http://127.0.0.1:4198/   → "alive pid=…"
10. Save docs/model-router-spike/probe/hooks/register.ts unchanged-but-touched (add a blank line) → the mod hot-reloads; curl again
11. Type: /exit ; then curl again      → still alive?
12. curl -s http://127.0.0.1:4198/quit
13. Copy every "mr-probe:" line from the transcript and paste them back here.
```

- [ ] **Step 4: Check V2 interactive from the capture**

```bash
grep -E '"path":"/v1/messages"' docs/model-router-spike/capture.jsonl | grep -o '"session":"[^"]*"' | sort | uniq -c
```

**V2 PASS** when every `/v1/messages` request (including the title request, which carries no tools) has the session id the probe logged.

- [ ] **Step 5: Record V1, V2, V3, V5, V6 and commit**

Pass criteria:
- **V1 PASS**: step 4 printed the probe's answer **and** step 5 opened the built-in picker. Also record whether step 6 opened the built-in picker without re-entering the probe's hook (the picker's "Claude Code's picker…" entry depends on it; if it re-entered, Task 25 must keep its `origin` guard — it does).
- **V3 PASS**: step 8 exited 0 in under 5 s, and steps 9, 10 and 11 all answered `alive`.
- **V5**: record which of these showed the change after the built-in pick: the `after next(e)` line, the 1 s `session.model changed` line, or neither. Task 22's timer detection works if the 1 s line appeared.
- **V6 PASS** if `$.fs.write OK` with no prompt. Either way the product writes settings through `launch.mjs write` (Task 17), so V6 FAIL changes nothing unless `$.process.run` itself prompted — record that too.

```bash
git add docs/model-router-spike/probe docs/model-router-verification.md
git commit -m "Verify V1, V2, V3, V5, V6 in an interactive probe session"
```

### Task 4: Decision gate

**Files:**
- Modify: `docs/model-router-verification.md`
- Modify: this plan (only if an item failed)

- [ ] **Step 1: Apply the spec's fallback for every failed item**

| Failed | Change in this plan |
|---|---|
| V1 | Task 25: drop the bare-`/model` takeover (always `next(e)` for bare `/model`); keep the `/model <routed name>` catch. `userConfig.takeOverModelCommand` is removed from Task 18's manifest. |
| V2 | Task 22's `isForSession()` returns `true` for every event; `toastFor()` prefixes session-scoped events with `(other session?) ` when `ev.session !== sessionId`. |
| V3 | Task 17's `start()` launches through `cmd.exe /c start "" /b <node> …` on win32 instead of `spawn(..., { detached: true })`; re-run Task 3 step 8–11 against it. |
| V4 | Task 17's `nodeFlags()` returns `[]`; Task 28 doctor's TLS fix text says "set NODE_EXTRA_CA_CERTS"; README (Task 31) documents exporting the CA. |
| V5 | Task 25: clear the pick on **every** `/model` passed to `next` (already done for `/model <name>`), and for bare `/model` in toggle-off mode too. |
| V6 | Only if `$.process.run` prompted: Task 27 prints the exact JSON for the user to paste instead of writing. |
| V7 | Set `FALLBACK_SEP = '~'` in Task 7 and Task 21 (both constants), and in every test string that contains `#claude-`. |

- [ ] **Step 2: Summarize decisions in the verification table and commit**

```bash
git add docs/model-router-verification.md docs/superpowers/plans/2026-10-16-model-router.md
git commit -m "Record V1-V7 decisions"
```

Stop here and show the human the table before starting Phase 1.

---

## Phase 1 — Router (`node --test`)

All router tests run from the plugin root:

```bash
cd /c/dev/llm/mods/model-router && node --test "router/test/*.test.mjs"
```

A single file: `node --test router/test/<name>.test.mjs`.

### Task 5: Router scaffold, version, config schema

**Files:**
- Create: `model-router/router/version.mjs`, `model-router/router/version.d.mts`
- Create: `model-router/router/lib/schema.mjs`, `model-router/router/lib/schema.d.mts`
- Test: `model-router/router/test/schema.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (pure ESM, no `node:` imports — the mod imports these two files):
  - `VERSION: string` (`'0.1.0'`)
  - `FAMILIES: readonly ['haiku','sonnet','opus','fable']`, `DEFAULT_STRIP: string[]`, `DEFAULT_PORT = 4141`
  - `parseRef(ref: string): { provider: string, model: string } | null` — splits on the **first** `/`
  - `isLoopbackHost(hostname: string): boolean`
  - `checkBaseUrl(value: unknown): string | null` — error message or null
  - `validateConfig(raw: unknown): { ok: true, config: Config } | { ok: false, errors: ConfigError[] }`
  - `formatErrors(errors: ConfigError[]): string`
  - `allRefs(config: Config): string[]` — every `Provider/model-id`
  - Types: `Config = { version: 1, port: number, upstream?: string, providers: Provider[], overrides: Partial<Record<Family,string>>, defaultMainModel?: string }`, `Provider = { name, baseUrl, apiKeyEnv?, apiKey?, strip: string[], models: { id: string }[] }`, `ConfigError = { path: string, message: string }`

- [ ] **Step 1: Write the failing tests**

`model-router/router/test/schema.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, parseRef, formatErrors, allRefs, checkBaseUrl, DEFAULT_STRIP } from '../lib/schema.mjs'

const good = () => ({
  version: 1,
  port: 4141,
  upstream: 'https://llm-gw.corp.example/',
  providers: [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic/', apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or', strip: ['thinking'], models: [{ id: 'anthropic/claude-x' }] },
  ],
  overrides: { haiku: 'DeepSeek/deepseek-chat' },
  defaultMainModel: 'OpenRouter/anthropic/claude-x',
})

const errorPaths = raw => {
  const r = validateConfig(raw)
  assert.equal(r.ok, false)
  return r.errors.map(e => e.path)
}

test('a valid config normalizes urls, defaults and strip', () => {
  const r = validateConfig(good())
  assert.equal(r.ok, true)
  assert.equal(r.config.upstream, 'https://llm-gw.corp.example')
  assert.equal(r.config.providers[0].baseUrl, 'https://api.deepseek.com/anthropic')
  assert.deepEqual(r.config.providers[0].strip, DEFAULT_STRIP)
  assert.deepEqual(r.config.providers[1].strip, ['thinking'])
  assert.deepEqual(allRefs(r.config), ['DeepSeek/deepseek-chat', 'OpenRouter/anthropic/claude-x'])
})

test('an empty object is a valid config with defaults', () => {
  const r = validateConfig({})
  assert.equal(r.ok, true)
  assert.equal(r.config.port, 4141)
  assert.deepEqual(r.config.providers, [])
  assert.deepEqual(r.config.overrides, {})
})

test('parseRef splits on the first slash only', () => {
  assert.deepEqual(parseRef('OpenRouter/anthropic/claude-x'), { provider: 'OpenRouter', model: 'anthropic/claude-x' })
  assert.equal(parseRef('noslash'), null)
  assert.equal(parseRef('/model'), null)
  assert.equal(parseRef('Provider/'), null)
})

test('provider names must be unique and well formed', () => {
  const dup = good(); dup.providers[1].name = 'DeepSeek'
  assert.deepEqual(errorPaths(dup).filter(p => p.endsWith('.name')), ['providers[1].name'])
  const bad = good(); bad.providers[0].name = 'Deep Seek'
  assert.ok(errorPaths(bad).includes('providers[0].name'))
})

test('overrides and default must reference existing models and known families', () => {
  const c = good()
  c.overrides = { haiku: 'DeepSeek/nope', gpt: 'DeepSeek/deepseek-chat' }
  c.defaultMainModel = 'Nobody/x'
  assert.deepEqual(errorPaths(c).sort(), ['defaultMainModel', 'overrides.gpt', 'overrides.haiku'])
})

test('exactly one of apiKeyEnv and apiKey', () => {
  const both = good(); both.providers[0].apiKey = 'sk'
  assert.ok(errorPaths(both).includes('providers[0]'))
  const none = good(); delete none.providers[0].apiKeyEnv
  assert.ok(errorPaths(none).includes('providers[0]'))
})

test('baseUrl is https, or http on loopback', () => {
  assert.equal(checkBaseUrl('https://x.example'), null)
  assert.equal(checkBaseUrl('http://127.0.0.1:9000'), null)
  assert.equal(checkBaseUrl('http://localhost:9000'), null)
  assert.match(checkBaseUrl('http://x.example'), /https/)
  assert.match(checkBaseUrl('not a url'), /URL/)
  const c = good(); c.providers[0].baseUrl = 'http://api.example'
  assert.ok(errorPaths(c).includes('providers[0].baseUrl'))
})

test('models must be a non-empty list of unique ids', () => {
  const c = good(); c.providers[0].models = []
  assert.ok(errorPaths(c).includes('providers[0].models'))
  const d = good(); d.providers[0].models = [{ id: 'a' }, { id: 'a' }]
  assert.ok(errorPaths(d).includes('providers[0].models[1].id'))
})

test('formatErrors joins path: message', () => {
  assert.equal(formatErrors([{ path: 'port', message: 'bad' }, { path: '', message: 'whole' }]), 'port: bad; whole')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/dev/llm/mods/model-router && node --test router/test/schema.test.mjs`
Expected: FAIL with `Cannot find module …/router/lib/schema.mjs`.

- [ ] **Step 3: Implement**

`model-router/router/version.mjs`:

```js
// The one version number: the router reports it, the launcher and the mod compare against it.
export const VERSION = '0.1.0'
```

`model-router/router/version.d.mts`:

```ts
export declare const VERSION: string
```

`model-router/router/lib/schema.mjs`:

```js
// Config validation and model references. Pure ESM with no node: imports,
// because the mod's hooks module imports this file too.

export const FAMILIES = Object.freeze(['haiku', 'sonnet', 'opus', 'fable'])
export const DEFAULT_STRIP = Object.freeze(['anthropic-beta', 'thinking', 'context_management', 'output_config'])
export const DEFAULT_PORT = 4141

const NAME = /^[A-Za-z0-9._-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const trimSlash = url => url.replace(/\/+$/, '')

export function parseRef(ref) {
  if (typeof ref !== 'string') return null
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return null
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
}

export function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

export function checkBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { return 'must be a URL' }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null
  return 'must be https (or http on 127.0.0.1/localhost)'
}

export function allRefs(config) {
  return config.providers.flatMap(p => p.models.map(m => `${p.name}/${m.id}`))
}

export function formatErrors(errors) {
  return errors.map(e => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')
}

function validateProvider(p, at, seen, errors) {
  if (!isObject(p)) { errors.push({ path: at, message: 'must be an object' }); return null }
  if (typeof p.name !== 'string' || !NAME.test(p.name)) errors.push({ path: `${at}.name`, message: 'must match [A-Za-z0-9._-]+' })
  else if (seen.has(p.name)) errors.push({ path: `${at}.name`, message: `duplicate provider "${p.name}"` })
  else seen.add(p.name)

  if (typeof p.baseUrl !== 'string') errors.push({ path: `${at}.baseUrl`, message: 'is required' })
  else { const bad = checkBaseUrl(p.baseUrl); if (bad) errors.push({ path: `${at}.baseUrl`, message: bad }) }

  const hasEnv = p.apiKeyEnv !== undefined
  const hasKey = p.apiKey !== undefined
  if (hasEnv === hasKey) errors.push({ path: at, message: 'needs exactly one of apiKeyEnv / apiKey' })
  if (hasEnv && (typeof p.apiKeyEnv !== 'string' || !ENV_NAME.test(p.apiKeyEnv))) errors.push({ path: `${at}.apiKeyEnv`, message: 'must be an environment variable name' })
  if (hasKey && (typeof p.apiKey !== 'string' || p.apiKey === '')) errors.push({ path: `${at}.apiKey`, message: 'must be a non-empty string' })

  const strip = p.strip ?? DEFAULT_STRIP
  if (!Array.isArray(strip) || !strip.every(s => typeof s === 'string')) errors.push({ path: `${at}.strip`, message: 'must be a list of strings' })

  const models = []
  if (!Array.isArray(p.models) || p.models.length === 0) errors.push({ path: `${at}.models`, message: 'must be a non-empty list' })
  else {
    const ids = new Set()
    p.models.forEach((m, j) => {
      if (!isObject(m) || typeof m.id !== 'string' || m.id === '') errors.push({ path: `${at}.models[${j}].id`, message: 'must be a non-empty string' })
      else if (ids.has(m.id)) errors.push({ path: `${at}.models[${j}].id`, message: `duplicate model "${m.id}"` })
      else { ids.add(m.id); models.push({ id: m.id }) }
    })
  }
  return {
    name: p.name,
    baseUrl: typeof p.baseUrl === 'string' ? trimSlash(p.baseUrl) : p.baseUrl,
    ...(hasEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
    ...(hasKey ? { apiKey: p.apiKey } : {}),
    strip: Array.isArray(strip) ? [...strip] : [...DEFAULT_STRIP],
    models,
  }
}

export function validateConfig(raw) {
  if (!isObject(raw)) return { ok: false, errors: [{ path: '', message: 'must be a JSON object' }] }
  const errors = []
  if (raw.version !== undefined && raw.version !== 1) errors.push({ path: 'version', message: 'must be 1' })
  const port = raw.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push({ path: 'port', message: 'must be an integer 1-65535' })
  if (raw.upstream !== undefined) {
    if (typeof raw.upstream !== 'string') errors.push({ path: 'upstream', message: 'must be a URL' })
    else { const bad = checkBaseUrl(raw.upstream); if (bad) errors.push({ path: 'upstream', message: bad }) }
  }

  const providers = []
  const rawProviders = raw.providers ?? []
  if (!Array.isArray(rawProviders)) errors.push({ path: 'providers', message: 'must be a list' })
  else {
    const seen = new Set()
    rawProviders.forEach((p, i) => { const v = validateProvider(p, `providers[${i}]`, seen, errors); if (v) providers.push(v) })
  }
  const refs = new Set(providers.flatMap(p => p.models.map(m => `${p.name}/${m.id}`)))

  const overrides = {}
  const rawOverrides = raw.overrides ?? {}
  if (!isObject(rawOverrides)) errors.push({ path: 'overrides', message: 'must be an object' })
  else for (const [family, ref] of Object.entries(rawOverrides)) {
    if (!FAMILIES.includes(family)) errors.push({ path: `overrides.${family}`, message: 'family must be one of haiku|sonnet|opus|fable' })
    else if (typeof ref !== 'string' || !refs.has(ref)) errors.push({ path: `overrides.${family}`, message: `references unknown model "${ref}"` })
    else overrides[family] = ref
  }

  if (raw.defaultMainModel !== undefined && (typeof raw.defaultMainModel !== 'string' || !refs.has(raw.defaultMainModel)))
    errors.push({ path: 'defaultMainModel', message: `references unknown model "${raw.defaultMainModel}"` })

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    config: {
      version: 1,
      port,
      ...(raw.upstream !== undefined ? { upstream: trimSlash(raw.upstream) } : {}),
      providers,
      overrides,
      ...(raw.defaultMainModel !== undefined ? { defaultMainModel: raw.defaultMainModel } : {}),
    },
  }
}
```

`model-router/router/lib/schema.d.mts` (types for the mod's TypeScript):

```ts
export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type ModelEntry = { id: string }
export type Provider = { name: string; baseUrl: string; apiKeyEnv?: string; apiKey?: string; strip: string[]; models: ModelEntry[] }
export type Config = { version: 1; port: number; upstream?: string; providers: Provider[]; overrides: Partial<Record<Family, string>>; defaultMainModel?: string }
export type ConfigError = { path: string; message: string }
export type ValidateResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] }

export declare const FAMILIES: readonly Family[]
export declare const DEFAULT_STRIP: readonly string[]
export declare const DEFAULT_PORT: number
export declare function parseRef(ref: string): { provider: string; model: string } | null
export declare function isLoopbackHost(hostname: string): boolean
export declare function checkBaseUrl(value: unknown): string | null
export declare function allRefs(config: Config): string[]
export declare function formatErrors(errors: readonly ConfigError[]): string
export declare function validateConfig(raw: unknown): ValidateResult
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/dev/llm/mods/model-router && node --test router/test/schema.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): config schema, model refs and version"
```

### Task 6: Config paths and the watched store (keep-last-valid)

**Files:**
- Create: `model-router/router/lib/config.mjs`
- Create: `model-router/router/test/helpers.mjs` (shared helpers, extended in Task 13)
- Test: `model-router/router/test/config.test.mjs`

**Interfaces:**
- Consumes: `validateConfig`, `formatErrors` (Task 5).
- Produces:
  - `routerHome(env = process.env): string` — `MODEL_ROUTER_HOME || CLAUDE_CONFIG_DIR || <homedir>/.claude`
  - `routerPaths(home): { config, stateDir, token, backup, events, log, out }`
  - `readConfigFile(file): { ok: true, config } | { ok: false, missing?: true, errors }`
  - `createConfigStore({ file, onEvent, debounceMs = 300 }): { current(): Config | null, reload(): void, close(): void }` — emits `{ kind: 'config-error', text }` and `{ kind: 'config-reloaded' }` through `onEvent`
  - helpers: `tempHome(): string`, `writeJson(file, value)`, `waitFor(fn, timeoutMs = 3000, everyMs = 20): Promise<any>`

- [ ] **Step 1: Write the helpers and the failing tests**

`model-router/router/test/helpers.mjs`:

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-test-'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

// Polls fn until it returns a truthy value; resolves that value, rejects on timeout.
export async function waitFor(fn, timeoutMs = 3000, everyMs = 20) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > until) throw new Error(`waitFor timed out after ${timeoutMs} ms`)
    await new Promise(r => setTimeout(r, everyMs))
  }
}
```

`model-router/router/test/config.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { routerHome, routerPaths, readConfigFile, createConfigStore } from '../lib/config.mjs'
import { tempHome, writeJson, waitFor } from './helpers.mjs'

test('routerHome prefers MODEL_ROUTER_HOME, then CLAUDE_CONFIG_DIR', () => {
  assert.equal(routerHome({ MODEL_ROUTER_HOME: 'A', CLAUDE_CONFIG_DIR: 'B' }), 'A')
  assert.equal(routerHome({ CLAUDE_CONFIG_DIR: 'B' }), 'B')
  assert.match(routerHome({}), /\.claude$/)
})

test('routerPaths lays out the files of spec 5.1', () => {
  const p = routerPaths('H')
  assert.equal(p.config, path.join('H', 'model-router.json'))
  assert.equal(p.token, path.join('H', 'model-router', 'token'))
  assert.equal(p.events, path.join('H', 'model-router', 'events.jsonl'))
  assert.equal(p.log, path.join('H', 'model-router', 'router.log'))
})

test('readConfigFile reports missing files and bad JSON', () => {
  const home = tempHome()
  const file = path.join(home, 'model-router.json')
  assert.equal(readConfigFile(file).missing, true)
  writeJson(file, '{ nope')
  const r = readConfigFile(file)
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /invalid JSON/)
})

test('the store keeps the last valid config and reports errors and reloads', async () => {
  const home = tempHome()
  const file = path.join(home, 'model-router.json')
  writeJson(file, { port: 5000 })
  const events = []
  const store = createConfigStore({ file, onEvent: e => events.push(e), debounceMs: 30 })
  try {
    assert.equal(store.current().port, 5000)
    writeJson(file, '{ "port": ')               // an editor's half-written save
    await waitFor(() => events.some(e => e.kind === 'config-error'))
    assert.equal(store.current().port, 5000)
    writeJson(file, { port: 5001 })
    await waitFor(() => events.some(e => e.kind === 'config-reloaded'))
    assert.equal(store.current().port, 5001)
  } finally { store.close() }
})

test('a store over a missing file starts empty and reports it', () => {
  const home = tempHome()
  const events = []
  const store = createConfigStore({ file: path.join(home, 'model-router.json'), onEvent: e => events.push(e) })
  try {
    assert.equal(store.current(), null)
    assert.equal(events[0].kind, 'config-error')
  } finally { store.close() }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/dev/llm/mods/model-router && node --test router/test/config.test.mjs`
Expected: FAIL with `Cannot find module …/lib/config.mjs`.

- [ ] **Step 3: Implement `model-router/router/lib/config.mjs`**

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateConfig, formatErrors } from './schema.mjs'

export function routerHome(env = process.env) {
  return env.MODEL_ROUTER_HOME || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function routerPaths(home) {
  const stateDir = path.join(home, 'model-router')
  return {
    config: path.join(home, 'model-router.json'),
    stateDir,
    token: path.join(stateDir, 'token'),
    backup: path.join(stateDir, 'setup-backup.json'),
    events: path.join(stateDir, 'events.jsonl'),
    log: path.join(stateDir, 'router.log'),
    out: path.join(stateDir, 'router.out'),
  }
}

export function readConfigFile(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true, errors: [{ path: '', message: `${file} not found` }] }
    return { ok: false, errors: [{ path: '', message: `cannot read ${file}: ${err.code ?? err.message}` }] }
  }
  let raw
  try { raw = JSON.parse(text) } catch (err) { return { ok: false, errors: [{ path: '', message: `invalid JSON: ${err.message}` }] } }
  return validateConfig(raw)
}

// Watches the config's folder (an atomic save is a rename, which a file watch misses)
// and keeps the last valid config when a save is invalid.
export function createConfigStore({ file, onEvent = () => {}, debounceMs = 300 }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const first = readConfigFile(file)
  let current = first.ok ? first.config : null
  if (!first.ok) onEvent({ kind: 'config-error', text: formatErrors(first.errors) })

  let timer
  const reload = () => {
    const next = readConfigFile(file)
    if (next.ok) { current = next.config; onEvent({ kind: 'config-reloaded' }) }
    else onEvent({ kind: 'config-error', text: formatErrors(next.errors) })
  }
  const watcher = fs.watch(path.dirname(file), (_type, name) => {
    if (name !== null && name !== path.basename(file)) return
    clearTimeout(timer)
    timer = setTimeout(reload, debounceMs)
  })
  return {
    current: () => current,
    reload,
    close: () => { clearTimeout(timer); watcher.close() },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/dev/llm/mods/model-router && node --test router/test/config.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): config paths and watched store with keep-last-valid"
```

### Task 7: Resolve (spec §6.2)

**Files:**
- Create: `model-router/router/lib/resolve.mjs`
- Test: `model-router/router/test/resolve.test.mjs`

**Interfaces:**
- Consumes: `FAMILIES`, `parseRef` (Task 5); a normalized `Config`.
- Produces:
  - `ROUTED_PREFIX = 'router:'`, `FALLBACK_SEP = '#'`, `DEFAULT_FALLBACK = 'claude-sonnet-5-5'`
  - `familyOf(model: string): Family | undefined`
  - `resolveTarget(model, config, availability): Target` where `availability(providerName) → { ok: true } | { ok: false, reason }` and
    `Target = { kind: 'pass' } | { kind: 'fallback', fallbackModel, ref, provider?, reason } | { kind: 'routed', provider: Provider, providerModel, ref, fallbackModel }`

- [ ] **Step 1: Write the failing tests**

`model-router/router/test/resolve.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTarget, familyOf, DEFAULT_FALLBACK } from '../lib/resolve.mjs'
import { validateConfig } from '../lib/schema.mjs'

const { config } = validateConfig({
  upstream: 'https://gw.example',
  providers: [
    { name: 'DeepSeek', baseUrl: 'https://ds.example', apiKeyEnv: 'K', models: [{ id: 'deepseek-chat' }] },
    { name: 'OpenRouter', baseUrl: 'https://or.example', apiKeyEnv: 'K', models: [{ id: 'anthropic/claude-x' }] },
  ],
  overrides: { haiku: 'DeepSeek/deepseek-chat' },
})
const up = () => ({ ok: true })
const down = () => ({ ok: false, reason: 'env K not set' })

test('a router: id routes to its model and keeps the fallback id', () => {
  const t = resolveTarget('router:DeepSeek/deepseek-chat#claude-opus-5-5', config, up)
  assert.equal(t.kind, 'routed')
  assert.equal(t.provider.name, 'DeepSeek')
  assert.equal(t.providerModel, 'deepseek-chat')
  assert.equal(t.ref, 'DeepSeek/deepseek-chat')
  assert.equal(t.fallbackModel, 'claude-opus-5-5')
})

test('a router: id without # falls back to sonnet', () => {
  assert.equal(resolveTarget('router:DeepSeek/deepseek-chat', config, up).fallbackModel, DEFAULT_FALLBACK)
  assert.equal(resolveTarget('router:DeepSeek/deepseek-chat#', config, up).fallbackModel, DEFAULT_FALLBACK)
})

test('a model id with a slash resolves on the first slash', () => {
  const t = resolveTarget('router:OpenRouter/anthropic/claude-x#claude-opus-5-5', config, up)
  assert.equal(t.kind, 'routed')
  assert.equal(t.providerModel, 'anthropic/claude-x')
})

test('unknown or unavailable router: ids fall back with a reason', () => {
  const unknown = resolveTarget('router:Nobody/x#claude-opus-5-5', config, up)
  assert.deepEqual([unknown.kind, unknown.fallbackModel], ['fallback', 'claude-opus-5-5'])
  assert.match(unknown.reason, /unknown model/)
  const off = resolveTarget('router:DeepSeek/deepseek-chat#claude-opus-5-5', config, down)
  assert.deepEqual([off.kind, off.provider, off.reason], ['fallback', 'DeepSeek', 'env K not set'])
})

test('a family override routes a Claude id, with that id as fallback', () => {
  const t = resolveTarget('claude-haiku-5-5', config, up)
  assert.deepEqual([t.kind, t.ref, t.fallbackModel], ['routed', 'DeepSeek/deepseek-chat', 'claude-haiku-5-5'])
  assert.equal(resolveTarget('Claude-3-5-HAIKU-latest', config, up).kind, 'routed')
})

test('no override, or an unavailable target, passes through', () => {
  assert.equal(resolveTarget('claude-opus-5-5', config, up).kind, 'pass')
  assert.equal(resolveTarget('claude-haiku-5-5', config, down).kind, 'pass')
  assert.equal(resolveTarget(undefined, config, up).kind, 'pass')
})

test('familyOf finds the family inside an id', () => {
  assert.equal(familyOf('claude-sonnet-5-5'), 'sonnet')
  assert.equal(familyOf('gpt-4'), undefined)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test router/test/resolve.test.mjs` (from `model-router/`)
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `model-router/router/lib/resolve.mjs`**

```js
import { FAMILIES, parseRef } from './schema.mjs'

export const ROUTED_PREFIX = 'router:'
export const FALLBACK_SEP = '#'
export const DEFAULT_FALLBACK = 'claude-sonnet-5-5'

export function familyOf(model) {
  const lower = model.toLowerCase()
  return FAMILIES.find(f => lower.includes(f))
}

function lookup(config, refText) {
  const parsed = parseRef(refText)
  if (!parsed) return null
  const provider = config.providers.find(p => p.name === parsed.provider)
  if (!provider || !provider.models.some(m => m.id === parsed.model)) return null
  return { provider, providerModel: parsed.model }
}

export function resolveTarget(model, config, availability) {
  if (typeof model !== 'string') return { kind: 'pass' }

  if (model.startsWith(ROUTED_PREFIX)) {
    const rest = model.slice(ROUTED_PREFIX.length)
    const cut = rest.indexOf(FALLBACK_SEP)
    const ref = cut === -1 ? rest : rest.slice(0, cut)
    const fallbackModel = cut === -1 || cut === rest.length - 1 ? DEFAULT_FALLBACK : rest.slice(cut + 1)
    const target = lookup(config, ref)
    if (!target) return { kind: 'fallback', fallbackModel, ref, provider: parseRef(ref)?.provider, reason: `unknown model "${ref}"` }
    const avail = availability(target.provider.name)
    if (!avail.ok) return { kind: 'fallback', fallbackModel, ref, provider: target.provider.name, reason: avail.reason }
    return { kind: 'routed', ...target, ref, fallbackModel }
  }

  const family = familyOf(model)
  const ref = family && config.overrides[family]
  if (!ref) return { kind: 'pass' }
  const target = lookup(config, ref)
  if (!target || !availability(target.provider.name).ok) return { kind: 'pass' }
  return { kind: 'routed', ...target, ref, fallbackModel: model }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test router/test/resolve.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): resolve routed ids, family overrides and pass-through"
```

### Task 8: Limits — parsing, learned table, applied limit (spec §5.3, D11, D19)

**Files:**
- Create: `model-router/router/lib/learned.mjs`
- Create: `model-router/router/test/fixtures/limit-errors.json`
- Test: `model-router/router/test/learned.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FALLBACK_LIMIT = 8192`
  - `parseMaxTokensLimit(status: number, text: string, requested: number): number | null` — `null` means "not a max_tokens error, or nothing to learn"
  - `createLearnedTable({ now = Date.now }): { get(ref): number | undefined, set(ref, maxOutputTokens, source), forget(refOrAll): number, toJSON(): Record<ref, { maxOutputTokens, learnedAt, source }> }`
  - `appliedLimit(requested: number, { learned?, policy? }): number` — never above `requested`

- [ ] **Step 1: Write the fixtures and failing tests**

`model-router/router/test/fixtures/limit-errors.json` — representative provider messages. The release checklist (Task 31) asks for real captured strings to be added here.

```json
{
  "limits": [
    { "requested": 32000, "expect": 8192, "text": "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Invalid max_tokens value, the valid range of max_tokens is [1, 8192]\"}}" },
    { "requested": 64000, "expect": 32000, "text": "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-x\"}}" },
    { "requested": 32000, "expect": 16384, "text": "max_tokens must be less than or equal to 16384" },
    { "requested": 32000, "expect": 8192, "text": "The max_tokens you requested is too large for this model" },
    { "requested": 40000, "expect": 32768, "text": "Requested max_output_tokens 40000 exceeds the model limit of 32768 (model glm-4.5)" }
  ],
  "notLimits": [
    { "requested": 32000, "text": "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens (38000 in the messages, 32000 in the completion)." },
    { "requested": 32000, "text": "{\"error\":{\"message\":\"unknown field 'thinking'\"}}" },
    { "requested": 32000, "text": "prompt is too long: 210000 tokens > 200000 maximum" }
  ]
}
```

`model-router/router/test/learned.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseMaxTokensLimit, createLearnedTable, appliedLimit, FALLBACK_LIMIT } from '../lib/learned.mjs'

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/limit-errors.json', import.meta.url), 'utf8'))

for (const f of fixtures.limits) {
  test(`learns ${f.expect} from: ${f.text.slice(0, 60)}`, () => {
    assert.equal(parseMaxTokensLimit(400, f.text, f.requested), f.expect)
  })
}

for (const f of fixtures.notLimits) {
  test(`does not learn from: ${f.text.slice(0, 60)}`, () => {
    assert.equal(parseMaxTokensLimit(400, f.text, f.requested), null)
  })
}

test('only a 400 teaches, and nothing is learned at or below the fallback', () => {
  assert.equal(parseMaxTokensLimit(500, 'max_tokens [1, 8192]', 32000), null)
  assert.equal(parseMaxTokensLimit(400, 'max_tokens too large', 4096), null)
  assert.equal(FALLBACK_LIMIT, 8192)
})

test('appliedLimit is min(requested, learned, policy) and never raises', () => {
  const cases = [
    [32000, {}, 32000],
    [32000, { learned: 8192 }, 8192],
    [32000, { policy: 4000 }, 4000],
    [32000, { learned: 8192, policy: 4000 }, 4000],
    [32000, { learned: 4000, policy: 8192 }, 4000],
    [1000, { learned: 8192, policy: 4000 }, 1000],
    [1000, { learned: undefined, policy: null }, 1000],
  ]
  for (const [requested, limits, expected] of cases) assert.equal(appliedLimit(requested, limits), expected)
})

test('the learned table stores facts and forgets one or all', () => {
  const table = createLearnedTable({ now: () => Date.UTC(2026, 9, 16) })
  table.set('A/x', 8192, 'provider-400')
  table.set('B/y', 4096, 'provider-400')
  assert.equal(table.get('A/x'), 8192)
  assert.deepEqual(table.toJSON()['A/x'], { maxOutputTokens: 8192, learnedAt: '2026-10-16T00:00:00.000Z', source: 'provider-400' })
  assert.equal(table.forget('A/x'), 1)
  assert.equal(table.get('A/x'), undefined)
  assert.equal(table.forget('nope'), 0)
  assert.equal(table.forget('all'), 1)
  assert.deepEqual(table.toJSON(), {})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test router/test/learned.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `model-router/router/lib/learned.mjs`**

```js
export const FALLBACK_LIMIT = 8192

const MENTIONS_OUTPUT = /max_tokens|max_output_tokens|max output|maximum output|output tokens|max tokens/i
const MENTIONS_CONTEXT = /context length|context window|prompt is too long|maximum context/i

// The largest number in the message that is below what was asked for (the
// provider's ceiling); when the message names none, the fallback value.
export function parseMaxTokensLimit(status, text, requested) {
  if (status !== 400 || typeof text !== 'string') return null
  if (!MENTIONS_OUTPUT.test(text) || MENTIONS_CONTEXT.test(text)) return null
  const numbers = (text.match(/\d+/g) ?? []).map(Number).filter(n => n >= 256 && n < requested)
  if (numbers.length > 0) return Math.max(...numbers)
  return requested > FALLBACK_LIMIT ? FALLBACK_LIMIT : null
}

export function appliedLimit(requested, { learned, policy } = {}) {
  let limit = requested
  for (const cap of [learned, policy]) if (Number.isFinite(cap) && cap < limit) limit = cap
  return limit
}

export function createLearnedTable({ now = Date.now } = {}) {
  const entries = new Map()
  return {
    get: ref => entries.get(ref)?.maxOutputTokens,
    set(ref, maxOutputTokens, source) {
      entries.set(ref, { maxOutputTokens, learnedAt: new Date(now()).toISOString(), source })
    },
    forget(ref) {
      if (ref === 'all') { const n = entries.size; entries.clear(); return n }
      return entries.delete(ref) ? 1 : 0
    },
    toJSON: () => Object.fromEntries(entries),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test router/test/learned.test.mjs`
Expected: PASS (5 + 3 fixture tests, 3 unit tests). If a fixture fails, fix `parseMaxTokensLimit`, never the fixture's `expect`.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): max_tokens limit parsing, learned table, applied limit"
```

### Task 9: Rewrite (spec §6.3, D9, D10, D11)

**Files:**
- Create: `model-router/router/lib/rewrite.mjs`
- Test: `model-router/router/test/rewrite.test.mjs`

**Interfaces:**
- Consumes: `appliedLimit` (Task 8).
- Produces:
  - `HOP_BY_HOP: Set<string>`
  - `customHeaderNames(envValue: string | undefined): string[]` — lowercased names from `ANTHROPIC_CUSTOM_HEADERS` (`Name: value` lines, LF or CRLF)
  - `passThroughHeaders(inbound): object` — drops hop-by-hop and `x-router-token` only
  - `rewriteRouted({ headers, body, providerModel, apiKey, strip, customNames, limits }): { headers, body: string, maxTokens: number | undefined }`
  - `withModel(body: string, model: string): string` — same text when the model already matches

- [ ] **Step 1: Write the failing tests**

`model-router/router/test/rewrite.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteRouted, passThroughHeaders, customHeaderNames, withModel } from '../lib/rewrite.mjs'
import { DEFAULT_STRIP } from '../lib/schema.mjs'

const inbound = {
  host: '127.0.0.1:4141',
  connection: 'keep-alive',
  'content-length': '999',
  'accept-encoding': 'gzip, br',
  authorization: 'Bearer gateway-token',
  'x-api-key': 'gateway-key',
  'x-claude-code-session-id': 'sess-1',
  'x-router-token': 'tok',
  'x-corp-trace': 'abc',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,effort-2025-11-24',
  'user-agent': 'claude-cli',
}
const body = JSON.stringify({
  model: 'router:DeepSeek/deepseek-chat#claude-opus-5-5',
  max_tokens: 32000,
  thinking: { type: 'adaptive' },
  context_management: { edits: [] },
  output_config: { effort: 'high' },
  metadata: { user_id: 'u' },
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
})
const base = { headers: inbound, body, providerModel: 'deepseek-chat', apiKey: 'sk-ds', strip: [...DEFAULT_STRIP], customNames: ['x-corp-trace'], limits: {} }

test('D9: inbound auth, identity, token and custom headers never reach a provider', () => {
  const { headers } = rewriteRouted(base)
  for (const gone of ['authorization', 'x-claude-code-session-id', 'x-router-token', 'x-corp-trace', 'host', 'connection', 'content-length', 'accept-encoding'])
    assert.equal(headers[gone], undefined, gone)
  assert.equal(headers['x-api-key'], 'sk-ds')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['user-agent'], 'claude-cli')
})

test('D9/D10: metadata always goes, the strip list goes, cache_control stays, model is swapped', () => {
  const out = JSON.parse(rewriteRouted(base).body)
  assert.equal(out.model, 'deepseek-chat')
  for (const gone of ['metadata', 'thinking', 'context_management', 'output_config']) assert.equal(out[gone], undefined, gone)
  assert.equal(rewriteRouted(base).headers['anthropic-beta'], undefined)
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' })
})

test('cache_control in the strip list is removed everywhere', () => {
  const out = JSON.parse(rewriteRouted({ ...base, strip: ['cache_control'] }).body)
  assert.equal(out.system[0].cache_control, undefined)
  assert.equal(out.messages[0].content[0].cache_control, undefined)
  assert.deepEqual(out.thinking, { type: 'adaptive' })
})

test('D11: max_tokens is clamped by learned and policy and never raised', () => {
  assert.equal(rewriteRouted({ ...base, limits: { learned: 8192 } }).maxTokens, 8192)
  assert.equal(JSON.parse(rewriteRouted({ ...base, limits: { learned: 8192, policy: 4000 } }).body).max_tokens, 4000)
  assert.equal(rewriteRouted({ ...base, limits: { learned: 64000 } }).maxTokens, 32000)
})

test('pass-through keeps every header but hop-by-hop ones and the router token', () => {
  const h = passThroughHeaders(inbound)
  assert.equal(h.authorization, 'Bearer gateway-token')
  assert.equal(h['x-claude-code-session-id'], 'sess-1')
  assert.equal(h['accept-encoding'], 'gzip, br')
  assert.equal(h['x-router-token'], undefined)
  assert.equal(h.host, undefined)
  assert.equal(h['content-length'], undefined)
})

test('customHeaderNames reads LF and CRLF header lists', () => {
  assert.deepEqual(customHeaderNames('X-Corp-Trace: a\r\nx-router-token: t\n\nbroken line'), ['x-corp-trace', 'x-router-token'])
  assert.deepEqual(customHeaderNames(undefined), [])
})

test('withModel swaps the model and leaves identical bodies untouched', () => {
  const raw = '{"model":"claude-haiku-5-5",  "x":1}'
  assert.equal(withModel(raw, 'claude-haiku-5-5'), raw)
  assert.equal(JSON.parse(withModel(body, 'claude-opus-5-5')).model, 'claude-opus-5-5')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test router/test/rewrite.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `model-router/router/lib/rewrite.mjs`**

```js
import { appliedLimit } from './learned.mjs'

export const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer'])
const ROUTER_TOKEN = 'x-router-token'
const IDENTITY = ['authorization', 'x-api-key', 'x-claude-code-session-id', ROUTER_TOKEN]

export function customHeaderNames(envValue) {
  if (!envValue) return []
  return envValue.split(/\r?\n/).flatMap(line => {
    const colon = line.indexOf(':')
    const name = colon === -1 ? '' : line.slice(0, colon).trim().toLowerCase()
    return name ? [name] : []
  })
}

export function passThroughHeaders(inbound) {
  const out = {}
  for (const [name, value] of Object.entries(inbound))
    if (value !== undefined && !HOP_BY_HOP.has(name) && name !== ROUTER_TOKEN) out[name] = value
  return out
}

function deleteDeep(value, key) {
  if (Array.isArray(value)) for (const item of value) deleteDeep(item, key)
  else if (value !== null && typeof value === 'object') {
    delete value[key]
    for (const item of Object.values(value)) deleteDeep(item, key)
  }
}

export function rewriteRouted({ headers, body, providerModel, apiKey, strip, customNames, limits }) {
  // accept-encoding goes so a provider's error body stays readable for learning and events.
  const drop = new Set([...HOP_BY_HOP, ...IDENTITY, ...customNames, 'accept-encoding', ...strip.map(s => s.toLowerCase())])
  const out = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !drop.has(name)) out[name] = value
  out['x-api-key'] = apiKey
  out['content-type'] = 'application/json'

  const json = JSON.parse(body)
  delete json.metadata
  json.model = providerModel
  for (const field of strip) {
    if (field === 'cache_control') deleteDeep(json, 'cache_control')
    else delete json[field]
  }
  if (typeof json.max_tokens === 'number') json.max_tokens = appliedLimit(json.max_tokens, limits)
  return { headers: out, body: JSON.stringify(json), maxTokens: json.max_tokens }
}

export function withModel(body, model) {
  const json = JSON.parse(body)
  if (json.model === model) return body
  json.model = model
  return JSON.stringify(json)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test router/test/rewrite.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): routed request rewrite and pass-through headers"
```

### Task 10: Circuit breaker (spec §6.5)

**Files:**
- Create: `model-router/router/lib/breaker.mjs`
- Test: `model-router/router/test/breaker.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `createBreaker({ now = Date.now, threshold = 3, openMs = 300_000, onChange = (kind, provider) => {} }): { status(name): 'closed'|'open'|'half-open', canRoute(name): boolean, success(name), failure(name) }`. `onChange` receives `'breaker-open'` / `'breaker-close'`. Half-open lets requests through as trials; the first result closes or re-opens it.

- [ ] **Step 1: Write the failing tests**

`model-router/router/test/breaker.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBreaker } from '../lib/breaker.mjs'

function setup() {
  let t = 0
  const changes = []
  const b = createBreaker({ now: () => t, onChange: (kind, name) => changes.push(`${kind}:${name}`) })
  return { b, changes, advance: ms => { t += ms } }
}

test('three consecutive failures open the breaker for five minutes', () => {
  const { b, changes, advance } = setup()
  b.failure('P'); b.failure('P')
  assert.equal(b.status('P'), 'closed')
  b.failure('P')
  assert.equal(b.status('P'), 'open')
  assert.equal(b.canRoute('P'), false)
  assert.deepEqual(changes, ['breaker-open:P'])
  advance(299_999)
  assert.equal(b.status('P'), 'open')
  advance(1)
  assert.equal(b.status('P'), 'half-open')
  assert.equal(b.canRoute('P'), true)
})

test('a success resets the count', () => {
  const { b } = setup()
  b.failure('P'); b.failure('P'); b.success('P'); b.failure('P'); b.failure('P')
  assert.equal(b.status('P'), 'closed')
})

test('half-open: success closes, failure re-opens', () => {
  const { b, changes, advance } = setup()
  for (let i = 0; i < 3; i++) b.failure('P')
  advance(300_000)
  b.success('P')
  assert.equal(b.status('P'), 'closed')
  for (let i = 0; i < 3; i++) b.failure('P')
  advance(300_000)
  b.failure('P')
  assert.equal(b.status('P'), 'open')
  assert.deepEqual(changes, ['breaker-open:P', 'breaker-close:P', 'breaker-open:P', 'breaker-open:P'])
})

test('providers are independent', () => {
  const { b } = setup()
  for (let i = 0; i < 3; i++) b.failure('A')
  assert.equal(b.canRoute('B'), true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test router/test/breaker.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `model-router/router/lib/breaker.mjs`**

```js
export function createBreaker({ now = Date.now, threshold = 3, openMs = 5 * 60_000, onChange = () => {} } = {}) {
  const states = new Map() // name -> { failures, openedAt | null }
  const get = name => states.get(name) ?? { failures: 0, openedAt: null }

  function status(name) {
    const s = get(name)
    if (s.openedAt === null) return 'closed'
    return now() - s.openedAt >= openMs ? 'half-open' : 'open'
  }

  function success(name) {
    const was = status(name)
    states.set(name, { failures: 0, openedAt: null })
    if (was !== 'closed') onChange('breaker-close', name)
  }

  function failure(name) {
    const was = status(name)
    if (was === 'open') return
    if (was === 'half-open') {
      states.set(name, { failures: threshold, openedAt: now() })
      onChange('breaker-open', name)
      return
    }
    const failures = get(name).failures + 1
    if (failures >= threshold) {
      states.set(name, { failures, openedAt: now() })
      onChange('breaker-open', name)
    } else states.set(name, { failures, openedAt: null })
  }

  return { status, canRoute: name => status(name) !== 'open', success, failure }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test router/test/breaker.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): per-provider circuit breaker"
```

### Task 11: Events ring and rotating files (spec §6.6)

**Files:**
- Create: `model-router/router/lib/events.mjs`
- Test: `model-router/router/test/events.test.mjs`

**Interfaces:**
- Consumes: `tempHome` (Task 6 helpers).
- Produces:
  - `createRotatingFile(file, { maxBytes, keep }): { append(text) }` — `keep` counts files in total (`file`, `file.1`, … `file.<keep-1>`)
  - `createEventLog({ file?, capacity = 500, now = Date.now }): { emit(fields): Event, after(seq): Event[], lastSeq(): number }` where `Event = { seq, t, kind, session?, provider?, model?, status?, text? }`; undefined/null fields are dropped and `text` is cut to 200 characters

- [ ] **Step 1: Write the failing tests**

`model-router/router/test/events.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createEventLog, createRotatingFile } from '../lib/events.mjs'
import { tempHome } from './helpers.mjs'

test('events get increasing seq, drop undefined fields and cut text to 200', () => {
  const log = createEventLog({ now: () => 0 })
  const a = log.emit({ kind: 'fallback', session: 's', provider: 'P', status: undefined, text: 'x'.repeat(500) })
  assert.deepEqual(Object.keys(a).sort(), ['kind', 'provider', 'seq', 'session', 't', 'text'])
  assert.equal(a.seq, 1)
  assert.equal(a.text.length, 200)
  assert.equal(log.emit({ kind: 'learned' }).seq, 2)
  assert.deepEqual(log.after(1).map(e => e.seq), [2])
  assert.equal(log.lastSeq(), 2)
})

test('the ring keeps the last N events', () => {
  const log = createEventLog({ capacity: 3 })
  for (let i = 0; i < 5; i++) log.emit({ kind: 'learned' })
  assert.deepEqual(log.after(0).map(e => e.seq), [3, 4, 5])
})

test('events are appended to the jsonl file', () => {
  const file = path.join(tempHome(), 'events.jsonl')
  const log = createEventLog({ file })
  log.emit({ kind: 'config-reloaded' })
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(JSON.parse(lines[0]).kind, 'config-reloaded')
})

test('rotating files keep at most `keep` files of about maxBytes', () => {
  const file = path.join(tempHome(), 'r.log')
  const out = createRotatingFile(file, { maxBytes: 100, keep: 3 })
  for (let i = 0; i < 10; i++) out.append(`${String(i).repeat(60)}\n`)
  assert.ok(fs.existsSync(file))
  assert.ok(fs.existsSync(`${file}.1`))
  assert.ok(fs.existsSync(`${file}.2`))
  assert.equal(fs.existsSync(`${file}.3`), false)
  assert.ok(fs.statSync(file).size <= 100)
  assert.match(fs.readFileSync(file, 'utf8'), /^9+\n$/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test router/test/events.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `model-router/router/lib/events.mjs`**

```js
import fs from 'node:fs'
import path from 'node:path'

const TEXT_MAX = 200

export function createRotatingFile(file, { maxBytes, keep }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  function rotate() {
    for (let i = keep - 2; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch {}
    }
    try { fs.renameSync(file, `${file}.1`) } catch {}
  }
  return {
    append(text) {
      let size = 0
      try { size = fs.statSync(file).size } catch {}
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) rotate()
      fs.appendFileSync(file, text)
    },
  }
}

export function createEventLog({ file, capacity = 500, now = Date.now } = {}) {
  const ring = []
  let seq = 0
  const out = file ? createRotatingFile(file, { maxBytes: 1_048_576, keep: 3 }) : null
  return {
    emit(fields) {
      const event = { seq: ++seq, t: new Date(now()).toISOString() }
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) event[k] = v
      if (typeof event.text === 'string') event.text = event.text.slice(0, TEXT_MAX)
      ring.push(event)
      if (ring.length > capacity) ring.shift()
      try { out?.append(`${JSON.stringify(event)}\n`) } catch {}
      return event
    },
    after: n => ring.filter(e => e.seq > n),
    lastSeq: () => seq,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test router/test/events.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): event ring and rotating log files"
```

### Task 12: Forward — outbound requests, timeouts, failure classes; test fakes

**Files:**
- Create: `model-router/router/lib/forward.mjs`
- Create: `model-router/router/test/fakes.mjs`
- Test: `model-router/router/test/forward.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CONNECT_TIMEOUT_MS = 10_000`, `FIRST_BYTE_TIMEOUT_MS = 120_000`
  - `send({ url, method = 'POST', headers, body?, signal?, connectTimeoutMs?, firstByteTimeoutMs? }): Promise<{ ok: true, res } | { ok: false, kind: 'connect'|'timeout'|'tls'|'aborted', error }>` — resolves at the response headers (the first byte); never rejects
  - `readText(res, limit = 65536): Promise<string>`
  - `errorMessage(text): string` — `error.message` from Anthropic-style JSON, else tag-stripped, whitespace-collapsed text, ≤200 chars
  - `describeFailure(r): string` — e.g. `tls: SELF_SIGNED_CERT_IN_CHAIN`
  - Fakes: `startFake({ tls?: { key, cert }, handler? }): Promise<{ url, port, requests, setHandler(fn), close() }>`; each recorded request is `{ method, url, headers, body }`; `handler(req, res, body)`; helpers `sseReply(res, model, { gapMs = 0, events = 2 } = {})`, `jsonReply(res, status, value)`, `closedPort(): Promise<number>`

- [ ] **Step 1: Write the fakes**

`model-router/router/test/fakes.mjs`:

```js
// Fake Anthropic-style servers for integration tests and e2e.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

export function jsonReply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(typeof value === 'string' ? value : JSON.stringify(value))
}

// An SSE reply of `events` text deltas, `gapMs` apart.
export async function sseReply(res, model, { gapMs = 0, events = 2 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  for (let i = 0; i < events; i++) {
    if (i > 0 && gapMs > 0) await new Promise(r => setTimeout(r, gapMs))
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `part${i} from ${model}` } })
  }
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
  ev('message_stop', {})
  res.end()
}

export const defaultHandler = (req, res, body) => {
  const json = body ? JSON.parse(body) : {}
  if (req.url.includes('count_tokens')) return jsonReply(res, 200, { input_tokens: 7 })
  if (json.stream) return sseReply(res, json.model)
  return jsonReply(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'text', text: `ok from ${json.model}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
}

export async function startFake({ tls, handler = defaultHandler } = {}) {
  const requests = []
  let current = handler
  const onRequest = (req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      Promise.resolve(current(req, res, body)).catch(() => res.destroy())
    })
  }
  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: fn => { current = fn },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

export async function closedPort() {
  const s = net.createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise(r => s.close(r))
  return port
}
```

- [ ] **Step 2: Write the failing tests**

`model-router/router/test/forward.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { send, readText, errorMessage, describeFailure } from '../lib/forward.mjs'
import { startFake, closedPort, jsonReply } from './fakes.mjs'

test('send resolves at the response with status and body readable', async () => {
  const fake = await startFake()
  try {
    const body = JSON.stringify({ model: 'm' })
    const r = await send({ url: `${fake.url}/v1/messages`, headers: { 'content-type': 'application/json' }, body })
    assert.equal(r.ok, true)
    assert.equal(r.res.statusCode, 200)
    assert.match(await readText(r.res), /ok from m/)
    assert.equal(fake.requests[0].headers['content-length'], String(Buffer.byteLength(body)))
  } finally { await fake.close() }
})

test('a refused connection is a connect failure', async () => {
  const r = await send({ url: `http://127.0.0.1:${await closedPort()}/x`, headers: {}, body: '' })
  assert.deepEqual([r.ok, r.kind], [false, 'connect'])
  assert.match(describeFailure(r), /^connect: ECONNREFUSED/)
})

test('no first byte within the limit is a timeout', async () => {
  const fake = await startFake({ handler: () => {} }) // never answers
  try {
    const r = await send({ url: `${fake.url}/x`, headers: {}, body: '{}', firstByteTimeoutMs: 100 })
    assert.deepEqual([r.ok, r.kind], [false, 'timeout'])
  } finally { await fake.close() }
})

test('an aborted signal is an aborted failure', async () => {
  const fake = await startFake({ handler: () => {} })
  try {
    const ac = new AbortController()
    const p = send({ url: `${fake.url}/x`, headers: {}, body: '{}', signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    assert.equal((await p).kind, 'aborted')
  } finally { await fake.close() }
})

test('readText stops at the limit', async () => {
  const fake = await startFake({ handler: (req, res) => jsonReply(res, 502, 'x'.repeat(100_000)) })
  try {
    const r = await send({ url: `${fake.url}/x`, headers: {}, body: '{}' })
    assert.equal((await readText(r.res, 1000)).length, 1000)
  } finally { await fake.close() }
})

test('errorMessage reads Anthropic JSON and tames HTML', () => {
  assert.equal(errorMessage('{"type":"error","error":{"type":"invalid_request_error","message":"unknown field \'thinking\'"}}'), "unknown field 'thinking'")
  assert.equal(errorMessage('{"message":"flat"}'), 'flat')
  assert.equal(errorMessage(`<html><body><h1>502   Bad Gateway</h1>${'<p>x</p>'.repeat(200)}</body></html>`).slice(0, 15), '502 Bad Gateway')
  assert.ok(errorMessage('<p>x</p>'.repeat(500)).length <= 200)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test router/test/forward.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `model-router/router/lib/forward.mjs`**

```js
import http from 'node:http'
import https from 'node:https'

export const CONNECT_TIMEOUT_MS = 10_000
export const FIRST_BYTE_TIMEOUT_MS = 120_000

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

function classify(error) {
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return 'aborted'
  if (TLS_CODES.has(error.code)) return 'tls'
  if (error.code === 'ETIMEDOUT_CONNECT' || error.code === 'ETIMEDOUT_FIRST_BYTE') return 'timeout'
  return 'connect'
}

const timeoutError = (message, code) => Object.assign(new Error(message), { code })

// Resolves once response headers arrive (the first byte) or the request fails; never rejects.
export function send({ url, method = 'POST', headers, body, signal, connectTimeoutMs = CONNECT_TIMEOUT_MS, firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS }) {
  return new Promise(resolve => {
    const target = new URL(url)
    const lib = target.protocol === 'https:' ? https : http
    const outHeaders = { ...headers }
    if (body !== undefined) outHeaders['content-length'] = String(Buffer.byteLength(body))
    let connectTimer, firstByteTimer, settled = false
    const done = result => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(firstByteTimer)
      resolve(result)
    }
    const req = lib.request(target, { method, headers: outHeaders, signal })
    connectTimer = setTimeout(() => req.destroy(timeoutError('connect timeout', 'ETIMEDOUT_CONNECT')), connectTimeoutMs)
    req.on('socket', socket => {
      const connected = () => clearTimeout(connectTimer)
      if (!socket.connecting) connected()
      else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
    })
    req.on('finish', () => {
      firstByteTimer = setTimeout(() => req.destroy(timeoutError('first byte timeout', 'ETIMEDOUT_FIRST_BYTE')), firstByteTimeoutMs)
    })
    req.on('response', res => done({ ok: true, res }))
    req.on('error', error => done({ ok: false, kind: classify(error), error }))
    req.end(body)
  })
}

export function readText(res, limit = 65_536) {
  return new Promise(resolve => {
    let text = ''
    let finished = false
    const finish = () => { if (!finished) { finished = true; resolve(text.slice(0, limit)) } }
    res.setEncoding('utf8')
    res.on('data', chunk => {
      text += chunk
      if (text.length >= limit) { finish(); res.destroy() }
    })
    res.on('end', finish)
    res.on('error', finish)
    res.on('close', finish)
  })
}

export function errorMessage(text) {
  try {
    const json = JSON.parse(text)
    const message = json?.error?.message ?? json?.message
    if (typeof message === 'string') return message.slice(0, 200)
  } catch {}
  return String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function describeFailure(r) {
  return `${r.kind}: ${r.error?.code ?? r.error?.message ?? 'failed'}`
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test router/test/forward.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): outbound send with timeouts and failure classes; test fakes"
```

### Task 13: Server — control endpoints and byte-for-byte pass-through

**Files:**
- Create: `model-router/router/lib/status.mjs`
- Create: `model-router/router/lib/fingerprint.mjs`
- Create: `model-router/router/lib/server.mjs`
- Modify: `model-router/router/test/helpers.mjs` (add `makeHome`, `startRouter`, `request`)
- Test: `model-router/router/test/server-pass.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 5–12.
- Produces:
  - `buildStatus({ version, pid, uptimeMs, config, keyAvailability, breaker, eventsSeq })` → the `/_router/status` body of spec §6.1 plus `configOk` and `eventsSeq`
  - `fingerprint(value: string): string` — first 12 hex chars of sha256
  - `createRouter({ home?, env?, port?, now?, idleMs?, debounceMs?, connectTimeoutMs?, firstByteTimeoutMs? })` → `{ start(): Promise<{ port }>, stop({ drain }): Promise<void>, onStopped(fn), paths, events, learned, breaker }`
  - `TOKEN_HELP: string` (the 401 explanation)
  - HTTP: `HEAD /api/hello`; `GET /_router/status`; `GET /_router/limits`; `GET /_router/events?after=<seq>` → `{ events, lastSeq }`; `POST /_router/policy` → 501; token-protected `GET /_router/keys` → `{ keys: { NAME: fingerprint | null } }`, `POST /_router/forget` `{ ref }` → `{ forgotten }`, `POST /_router/shutdown[?drain=1]` → 202
  - Test helpers: `makeHome({ config?, token = 'test-token' })`, `startRouter(home, options?) → { router, port, url, close() }`, `request(url, { method, path, headers, body, abortAfterFirstChunk }) → { status, headers, text, firstChunkMs, totalMs, isAborted }`

The routed path (`toProvider`) is written here in full so the file is complete; Task 14 adds its tests.

- [ ] **Step 1: Extend the test helpers**

Append to `model-router/router/test/helpers.mjs`:

```js
import http from 'node:http'
import { createRouter } from '../lib/server.mjs'

export function makeHome({ config, token = 'test-token' } = {}) {
  const home = tempHome()
  if (config) writeJson(path.join(home, 'model-router.json'), config)
  if (token !== null) writeJson(path.join(home, 'model-router', 'token'), token)
  return home
}

export async function startRouter(home, options = {}) {
  const router = createRouter({ home, port: 0, env: {}, debounceMs: 30, ...options })
  const { port } = await router.start()
  return { router, port, url: `http://127.0.0.1:${port}`, close: () => router.stop({ drain: false }) }
}

// A raw client that times the first body chunk; with abortAfterFirstChunk it
// hangs up as soon as one arrives (a person pressing Esc).
export function request(url, { method = 'POST', path: p = '/v1/messages', headers = {}, body, abortAfterFirstChunk = false } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    let firstChunkMs, text = ''
    const req = http.request(`${url}${p}`, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } }, res => {
      const done = isAborted => resolve({ status: res.statusCode, headers: res.headers, text, firstChunkMs, totalMs: Date.now() - started, isAborted })
      res.setEncoding('utf8')
      res.on('data', chunk => {
        firstChunkMs ??= Date.now() - started
        text += chunk
        if (abortAfterFirstChunk) { req.destroy(); done(true) }
      })
      res.on('end', () => done(false))
      res.on('error', () => done(true))
      res.on('aborted', () => done(true))
    })
    req.on('error', error => resolve({ status: 0, error, text, isAborted: true }))
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}
```

Move the existing `import path from 'node:path'` to the top if it is not already there (it is, from Task 6).

- [ ] **Step 2: Write the failing tests**

`model-router/router/test/server-pass.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHome, startRouter, request } from './helpers.mjs'
import { startFake, jsonReply, closedPort } from './fakes.mjs'
import { VERSION } from '../version.mjs'

async function setup({ upstreamHandler, env = {}, config = {} } = {}) {
  const upstream = await startFake(upstreamHandler ? { handler: upstreamHandler } : {})
  const home = makeHome({ config: {
    upstream: upstream.url,
    providers: [{ name: 'DS', baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }] }],
    ...config,
  } })
  const r = await startRouter(home, { env })
  return { upstream, ...r, cleanup: async () => { await r.close(); await upstream.close() } }
}

test('HEAD /api/hello is answered locally', async () => {
  const s = await setup()
  try {
    const r = await request(s.url, { method: 'HEAD', path: '/api/hello' })
    assert.equal(r.status, 200)
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('status identifies the router and reports providers', async () => {
  const s = await setup({ env: {} })
  try {
    const status = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/status' })).text)
    assert.equal(status.name, 'model-router')
    assert.equal(status.version, VERSION)
    assert.equal(status.policyApi, 1)
    assert.equal(status.upstream, s.upstream.url)
    assert.deepEqual(status.providers, [{ name: 'DS', available: false, reason: 'env DS_KEY not set', breaker: 'closed' }])
    assert.deepEqual(status.models, [{ ref: 'DS/ds-chat' }])
    assert.equal(typeof status.eventsSeq, 'number')
  } finally { await s.cleanup() }
})

test('limits are empty and policy is reserved (501)', async () => {
  const s = await setup()
  try {
    assert.deepEqual(JSON.parse((await request(s.url, { method: 'GET', path: '/_router/limits' })).text), { learned: {}, policy: null })
    assert.equal((await request(s.url, { path: '/_router/policy', body: {} })).status, 501)
  } finally { await s.cleanup() }
})

test('token-protected control endpoints refuse without the token', async () => {
  const s = await setup()
  try {
    assert.equal((await request(s.url, { method: 'GET', path: '/_router/keys' })).status, 401)
    assert.equal((await request(s.url, { path: '/_router/forget', body: { ref: 'all' } })).status, 401)
    assert.equal((await request(s.url, { path: '/_router/shutdown' })).status, 401)
    const ok = await request(s.url, { path: '/_router/forget', headers: { 'x-router-token': 'test-token' }, body: { ref: 'all' } })
    assert.deepEqual([ok.status, JSON.parse(ok.text)], [200, { forgotten: 0 }])
  } finally { await s.cleanup() }
})

test('keys reports fingerprints of the router env, never values', async () => {
  const s = await setup({ env: { DS_KEY: 'sk-secret' } })
  try {
    const r = await request(s.url, { method: 'GET', path: '/_router/keys', headers: { 'x-router-token': 'test-token' } })
    const { keys } = JSON.parse(r.text)
    assert.match(keys.DS_KEY, /^[0-9a-f]{12}$/)
    assert.ok(!r.text.includes('sk-secret'))
  } finally { await s.cleanup() }
})

test('pass-through is byte-for-byte, keeps the query and auth, drops only the router token', async () => {
  const s = await setup()
  try {
    const body = '{"model":"claude-opus-5-5",   "messages":[],"stream":false}'
    const r = await request(s.url, {
      path: '/v1/messages?beta=true',
      headers: { authorization: 'Bearer gw', 'x-router-token': 'test-token', 'x-claude-code-session-id': 's1', 'anthropic-beta': 'b1' },
      body,
    })
    assert.equal(r.status, 200)
    const seen = s.upstream.requests[0]
    assert.equal(seen.url, '/v1/messages?beta=true')
    assert.equal(seen.body, body)
    assert.equal(seen.headers.authorization, 'Bearer gw')
    assert.equal(seen.headers['x-claude-code-session-id'], 's1')
    assert.equal(seen.headers['anthropic-beta'], 'b1')
    assert.equal(seen.headers['x-router-token'], undefined)
    assert.match(r.text, /ok from claude-opus-5-5/)
  } finally { await s.cleanup() }
})

test('other paths pass through too', async () => {
  const s = await setup({ upstreamHandler: (req, res) => jsonReply(res, 200, { path: req.url }) })
  try {
    const r = await request(s.url, { method: 'GET', path: '/v1/models' })
    assert.deepEqual(JSON.parse(r.text), { path: '/v1/models' })
  } finally { await s.cleanup() }
})

test('an upstream error passes unchanged and is observed as an event', async () => {
  const s = await setup({ upstreamHandler: (req, res) => jsonReply(res, 413, { type: 'error', error: { type: 'request_too_large', message: 'too big' } }) })
  try {
    const r = await request(s.url, { headers: { 'x-claude-code-session-id': 's1' }, body: { model: 'claude-opus-5-5' } })
    assert.equal(r.status, 413)
    assert.match(r.text, /too big/)
    const { events } = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/events?after=0' })).text)
    const e = events.find(x => x.kind === 'upstream-error')
    assert.deepEqual([e.status, e.text, e.session], [413, 'too big', 's1'])
  } finally { await s.cleanup() }
})

test('an unreachable upstream is a 502 with an explanation and an event', async () => {
  const s = await setup({ config: { upstream: `http://127.0.0.1:${await closedPort()}` } })
  try {
    const r = await request(s.url, { body: { model: 'claude-opus-5-5' } })
    assert.equal(r.status, 502)
    assert.match(JSON.parse(r.text).error.message, /model-router: upstream .* failed \(connect: ECONNREFUSED\)/)
  } finally { await s.cleanup() }
})

test('with no config the router answers 503 and still serves status', async () => {
  const home = makeHome({})
  const s = await startRouter(home)
  try {
    const r = await request(s.url, { body: { model: 'claude-opus-5-5' } })
    assert.equal(r.status, 503)
    assert.match(r.text, /model-router\.json/)
    assert.equal(JSON.parse((await request(s.url, { method: 'GET', path: '/_router/status' })).text).configOk, false)
  } finally { await s.close() }
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test router/test/server-pass.test.mjs`
Expected: FAIL, `Cannot find module …/lib/server.mjs`.

- [ ] **Step 4: Implement `status.mjs` and `fingerprint.mjs`**

`model-router/router/lib/status.mjs`:

```js
import { allRefs } from './schema.mjs'

export function buildStatus({ version, pid, uptimeMs, config, keyAvailability, breaker, eventsSeq }) {
  return {
    name: 'model-router',
    version,
    pid,
    uptimeMs,
    upstream: config?.upstream ?? null,
    configOk: config !== null,
    providers: (config?.providers ?? []).map(p => {
      const a = keyAvailability(p.name)
      return { name: p.name, available: a.ok, ...(a.ok ? {} : { reason: a.reason }), breaker: breaker.status(p.name) }
    }),
    models: config ? allRefs(config).map(ref => ({ ref })) : [],
    policyApi: 1,
    eventsSeq,
  }
}
```

`model-router/router/lib/fingerprint.mjs`:

```js
import crypto from 'node:crypto'

// Enough to tell two keys apart, not enough to recover one.
export const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)
```

- [ ] **Step 5: Implement `model-router/router/lib/server.mjs`**

```js
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { VERSION } from '../version.mjs'
import { DEFAULT_PORT } from './schema.mjs'
import { routerHome, routerPaths, createConfigStore } from './config.mjs'
import { resolveTarget } from './resolve.mjs'
import { passThroughHeaders, rewriteRouted, withModel, customHeaderNames } from './rewrite.mjs'
import { createLearnedTable, parseMaxTokensLimit } from './learned.mjs'
import { createBreaker } from './breaker.mjs'
import { createEventLog, createRotatingFile } from './events.mjs'
import { send, readText, errorMessage, describeFailure, CONNECT_TIMEOUT_MS, FIRST_BYTE_TIMEOUT_MS } from './forward.mjs'
import { buildStatus } from './status.mjs'
import { fingerprint } from './fingerprint.mjs'

const MESSAGES = '/v1/messages'
const COUNT_TOKENS = '/v1/messages/count_tokens'
export const TOKEN_HELP = 'model-router: routed requests need the x-router-token header. Run /router setup, then restart Claude Code.'

const apiError = (type, message) => ({ type: 'error', error: { type, message } })

function sendJson(res, status, value) {
  if (res.headersSent) return res.destroy()
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Aborts when the client hangs up before its response was fully written.
function clientGone(res) {
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableEnded) ac.abort() })
  return ac.signal
}

const RESPONSE_HOP = ['connection', 'keep-alive', 'transfer-encoding']

// Streams a response through as it arrives; `observe` sees each chunk too.
function pipe(from, to, observe) {
  const headers = { ...from.headers }
  for (const h of RESPONSE_HOP) delete headers[h]
  to.writeHead(from.statusCode, headers)
  to.flushHeaders()
  if (observe) from.on('data', observe)
  from.on('error', () => to.destroy())
  to.on('close', () => from.destroy())
  from.pipe(to)
}

export function createRouter(options = {}) {
  const env = options.env ?? process.env
  const paths = routerPaths(options.home ?? routerHome(env))
  const now = options.now ?? Date.now
  const idleMs = options.idleMs ?? Number(env.MODEL_ROUTER_IDLE_MS ?? 30 * 60_000)
  const timeouts = {
    connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    firstByteTimeoutMs: options.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS,
  }
  // Pass-through has no first-byte limit: the gateway's own pace is not ours to judge.
  const upstreamTimeouts = { connectTimeoutMs: timeouts.connectTimeoutMs, firstByteTimeoutMs: Infinity }

  fs.mkdirSync(paths.stateDir, { recursive: true })
  const events = createEventLog({ file: paths.events, now })
  const requestLog = createRotatingFile(paths.log, { maxBytes: 5 * 1_048_576, keep: 3 })
  const learned = createLearnedTable({ now })
  const breaker = createBreaker({ now, onChange: (kind, provider) => events.emit({ kind, provider }) })
  const store = createConfigStore({ file: paths.config, onEvent: e => events.emit(e), debounceMs: options.debounceMs ?? 300 })
  const customNames = customHeaderNames(env.ANTHROPIC_CUSTOM_HEADERS)
  const startedAt = now()

  let server
  let idleTimer
  let active = 0
  let stopping = null
  let finished = false
  let stopped = () => {}

  function keyFor(provider) {
    if (provider.apiKey !== undefined) return { ok: true, key: provider.apiKey }
    const key = env[provider.apiKeyEnv]
    return key ? { ok: true, key } : { ok: false, reason: `env ${provider.apiKeyEnv} not set` }
  }
  function keyAvailability(name) {
    const provider = store.current()?.providers.find(p => p.name === name)
    if (!provider) return { ok: false, reason: 'unknown provider' }
    const k = keyFor(provider)
    return k.ok ? { ok: true } : k
  }
  function routeAvailability(name) {
    const k = keyAvailability(name)
    if (!k.ok) return k
    return breaker.canRoute(name) ? { ok: true } : { ok: false, reason: 'paused after repeated failures' }
  }
  function tokenOk(req) {
    let expected
    try { expected = fs.readFileSync(paths.token, 'utf8').trim() } catch { return false }
    const got = req.headers['x-router-token']
    if (typeof got !== 'string' || expected === '') return false
    const a = Buffer.from(got.trim())
    const b = Buffer.from(expected)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  function logRequest(fields) {
    try { requestLog.append(`${JSON.stringify({ t: new Date(now()).toISOString(), ...fields })}\n`) } catch {}
  }
  const status = () => buildStatus({
    version: VERSION, pid: process.pid, uptimeMs: now() - startedAt, config: store.current(),
    keyAvailability, breaker, eventsSeq: events.lastSeq(),
  })

  function touch() {
    if (stopping) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => void stop({ drain: true }), idleMs)
  }

  async function toUpstream({ req, res, config, body, session, signal = clientGone(res) }) {
    const hasBody = !(body.length === 0 && (req.method === 'GET' || req.method === 'HEAD'))
    const r = await send({ url: config.upstream + req.url, method: req.method, headers: passThroughHeaders(req.headers), body: hasBody ? body : undefined, signal, ...upstreamTimeouts })
    if (!r.ok) {
      if (r.kind === 'aborted') return
      const why = describeFailure(r)
      events.emit({ kind: 'upstream-error', session, text: why })
      return sendJson(res, 502, apiError('api_error', `model-router: upstream ${config.upstream} failed (${why})`))
    }
    if (r.res.statusCode < 400) return pipe(r.res, res)
    let seen = ''
    r.res.on('end', () => events.emit({ kind: 'upstream-error', session, status: r.res.statusCode, text: errorMessage(seen) }))
    pipe(r.res, res, chunk => { if (seen.length < 4096) seen += chunk.toString('utf8') })
  }

  async function toProvider({ req, res, config, url, body, session, target }) {
    const { provider, providerModel, ref } = target
    const isCount = url.pathname === COUNT_TOKENS
    const key = keyFor(provider).key
    const signal = clientGone(res)
    const started = now()
    const text = body.toString('utf8')
    const rewrite = learnedLimit => rewriteRouted({ headers: req.headers, body: text, providerModel, apiKey: key, strip: provider.strip, customNames, limits: { learned: learnedLimit } })
    const attempt = async sent => {
      const r = await send({ url: provider.baseUrl + url.pathname, headers: sent.headers, body: sent.body, signal, ...timeouts })
      if (!r.ok) return { isAborted: r.kind === 'aborted', failure: { text: describeFailure(r) } }
      if (r.res.statusCode >= 400) return { failure: { status: r.res.statusCode, raw: await readText(r.res) } }
      return { res: r.res }
    }

    let sent = rewrite(learned.get(ref))
    let result = await attempt(sent)
    if (result.failure?.status === 400 && !isCount && typeof sent.maxTokens === 'number') {
      const limit = parseMaxTokensLimit(400, result.failure.raw, sent.maxTokens)
      if (limit !== null) {
        learned.set(ref, limit, 'provider-400')
        events.emit({ kind: 'learned', session, provider: provider.name, model: providerModel, text: String(limit) })
        sent = rewrite(limit)
        result = await attempt(sent)
      }
    }
    if (result.isAborted) return
    if (result.res) {
      breaker.success(provider.name)
      logRequest({ session, ref, outcome: 'routed', status: result.res.statusCode, ms: now() - started })
      return pipe(result.res, res)
    }

    const { status: failedStatus } = result.failure
    if (isCount && (failedStatus === 404 || failedStatus === 400)) return sendJson(res, 200, { input_tokens: Math.ceil(body.length / 4) })
    const message = result.failure.raw !== undefined ? errorMessage(result.failure.raw) : result.failure.text
    breaker.failure(provider.name)
    events.emit({ kind: 'provider-error', session, provider: provider.name, model: providerModel, status: failedStatus, text: message })
    events.emit({ kind: 'fallback', session, provider: provider.name, model: target.fallbackModel, status: failedStatus, text: message })
    logRequest({ session, ref, outcome: 'fallback', status: failedStatus, ms: now() - started })
    return toUpstream({ req, res, config, body: Buffer.from(withModel(text, target.fallbackModel)), session, signal })
  }

  async function control(req, res, url) {
    const route = `${req.method} ${url.pathname}`
    switch (route) {
      case 'GET /_router/status': return sendJson(res, 200, status())
      case 'GET /_router/limits': return sendJson(res, 200, { learned: learned.toJSON(), policy: null })
      case 'GET /_router/events': {
        const after = Number(url.searchParams.get('after') ?? 0)
        return sendJson(res, 200, { events: events.after(Number.isFinite(after) ? after : 0), lastSeq: events.lastSeq() })
      }
      case 'POST /_router/policy':
        return sendJson(res, 501, apiError('not_implemented', 'model-router: policyApi 1 is reserved for model-limits and not implemented in this release'))
    }
    if (!tokenOk(req)) return sendJson(res, 401, apiError('authentication_error', TOKEN_HELP))
    switch (route) {
      case 'GET /_router/keys': {
        const names = (store.current()?.providers ?? []).flatMap(p => (p.apiKeyEnv ? [p.apiKeyEnv] : []))
        return sendJson(res, 200, { keys: Object.fromEntries(names.map(n => [n, env[n] ? fingerprint(env[n]) : null])) })
      }
      case 'POST /_router/forget': {
        let ref
        try { ref = JSON.parse((await readBody(req)).toString('utf8')).ref } catch {}
        if (typeof ref !== 'string') return sendJson(res, 400, apiError('invalid_request_error', 'body must be {"ref": "<Provider/model-id>" | "all"}'))
        return sendJson(res, 200, { forgotten: learned.forget(ref) })
      }
      case 'POST /_router/shutdown':
        res.on('finish', () => void stop({ drain: url.searchParams.get('drain') === '1' }))
        return sendJson(res, 202, { stopping: true })
    }
    return sendJson(res, 404, apiError('not_found_error', `model-router: no ${route}`))
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'HEAD' && url.pathname === '/api/hello') { res.writeHead(200); return res.end() }
    if (url.pathname.startsWith('/_router/')) return control(req, res, url)

    const body = await readBody(req)
    const config = store.current()
    if (!config) return sendJson(res, 503, apiError('api_error', `model-router: ${paths.config} is missing or invalid. Run /router doctor.`))
    if (!config.upstream) return sendJson(res, 503, apiError('api_error', 'model-router: no upstream is set. Run /router setup.'))
    const session = typeof req.headers['x-claude-code-session-id'] === 'string' ? req.headers['x-claude-code-session-id'] : undefined

    const isMessages = req.method === 'POST' && (url.pathname === MESSAGES || url.pathname === COUNT_TOKENS)
    if (!isMessages) return toUpstream({ req, res, config, body, session })
    let model
    try { model = JSON.parse(body.toString('utf8')).model } catch { return toUpstream({ req, res, config, body, session }) }

    const target = resolveTarget(model, config, routeAvailability)
    if (target.kind === 'pass') return toUpstream({ req, res, config, body, session })
    if (target.kind === 'fallback') {
      events.emit({ kind: 'fallback', session, provider: target.provider, model: target.fallbackModel, text: target.reason })
      return toUpstream({ req, res, config, body: Buffer.from(withModel(body.toString('utf8'), target.fallbackModel)), session })
    }
    if (!tokenOk(req)) return sendJson(res, 401, apiError('authentication_error', TOKEN_HELP))
    return toProvider({ req, res, config, url, body, session, target })
  }

  async function handle(req, res) {
    active += 1
    res.on('close', () => { active -= 1; if (stopping && active === 0) finish() })
    touch()
    try { await route(req, res) }
    catch (err) { sendJson(res, 500, apiError('api_error', `model-router: ${err.message}`)) }
  }

  function finish() {
    if (finished) return
    finished = true
    server?.closeAllConnections()
    stopping.resolve()
    stopped()
  }

  function stop({ drain = true } = {}) {
    if (!stopping) {
      let resolve
      const promise = new Promise(r => { resolve = r })
      stopping = { promise, resolve }
      clearTimeout(idleTimer)
      store.close()
      if (server) { server.close(); server.closeIdleConnections() }
      if (!server || !drain || active === 0) finish()
    }
    return stopping.promise
  }

  function start() {
    const port = options.port ?? store.current()?.port ?? DEFAULT_PORT
    server = http.createServer({ noDelay: true }, (req, res) => void handle(req, res))
    return new Promise((resolve, reject) => {
      server.once('error', err => { err.port = port; store.close(); reject(err) })
      server.listen(port, '127.0.0.1', () => { touch(); resolve({ port: server.address().port }) })
    })
  }

  return { start, stop, onStopped: fn => { stopped = fn }, paths, events, learned, breaker }
}
```

- [ ] **Step 6: Let `send` skip the first-byte timer when it is `Infinity`**

In `model-router/router/lib/forward.mjs`, replace the `req.on('finish', …)` block with:

```js
    req.on('finish', () => {
      if (Number.isFinite(firstByteTimeoutMs))
        firstByteTimer = setTimeout(() => req.destroy(timeoutError('first byte timeout', 'ETIMEDOUT_FIRST_BYTE')), firstByteTimeoutMs)
    })
```

(A non-finite `setTimeout` delay fires after 1 ms in Node, which would time out every pass-through request.)

- [ ] **Step 7: Run to verify it passes**

Run: `node --test router/test/server-pass.test.mjs && node --test router/test/forward.test.mjs`
Expected: PASS, 10 tests and 6 tests.

- [ ] **Step 8: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): HTTP server with control endpoints and byte-for-byte pass-through"
```

### Task 14: Server — routed path: rewrite, fallback, learning, breaker, streaming

**Files:**
- Test: `model-router/router/test/server-routed.test.mjs`
- Modify: `model-router/router/lib/server.mjs` only if a test below fails

**Interfaces:**
- Consumes: `createRouter` (Task 13), fakes (Task 12), helpers (Task 13).
- Produces: nothing new; this task pins spec §6.3–§6.5 and Review Focus 1, 3, 5.

- [ ] **Step 1: Write the tests**

`model-router/router/test/server-routed.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHome, startRouter, request, waitFor } from './helpers.mjs'
import { startFake, jsonReply, sseReply, closedPort } from './fakes.mjs'

const TOKEN = { 'x-router-token': 'test-token' }
const INBOUND = { authorization: 'Bearer gw', 'x-claude-code-session-id': 's1', 'x-corp': 'c', ...TOKEN }
const MAIN = 'router:DS/ds-chat#claude-opus-5-5'
const bodyFor = (model, extra = {}) => ({ model, max_tokens: 32000, stream: true, thinking: { type: 'adaptive' }, metadata: { user_id: 'u' }, messages: [{ role: 'user', content: 'hi' }], ...extra })

async function setup({ providerHandler, env = { DS_KEY: 'sk-ds', ANTHROPIC_CUSTOM_HEADERS: 'x-corp: c\nx-router-token: test-token' }, routerOptions = {}, providerUrl } = {}) {
  const upstream = await startFake()
  const provider = await startFake(providerHandler ? { handler: providerHandler } : {})
  const home = makeHome({ config: {
    upstream: upstream.url,
    providers: [{ name: 'DS', baseUrl: providerUrl ?? provider.url, apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }] }],
    overrides: { haiku: 'DS/ds-chat' },
  } })
  const r = await startRouter(home, { env, ...routerOptions })
  const events = async () => JSON.parse((await request(r.url, { method: 'GET', path: '/_router/events?after=0' })).text).events
  return { upstream, provider, home, events, ...r, cleanup: async () => { await r.close(); await upstream.close(); await provider.close() } }
}

test('a routed main pick reaches the provider rewritten (D9, D10), query dropped', async () => {
  const s = await setup()
  try {
    const r = await request(s.url, { path: '/v1/messages?beta=true', headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(r.status, 200)
    assert.match(r.text, /from ds-chat/)
    const seen = s.provider.requests[0]
    assert.equal(seen.url, '/v1/messages')
    assert.equal(seen.headers['x-api-key'], 'sk-ds')
    for (const gone of ['authorization', 'x-claude-code-session-id', 'x-router-token', 'x-corp']) assert.equal(seen.headers[gone], undefined, gone)
    const json = JSON.parse(seen.body)
    assert.equal(json.model, 'ds-chat')
    assert.equal(json.metadata, undefined)
    assert.equal(json.thinking, undefined)
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('a routed request without the local token is refused with 401', async () => {
  const s = await setup()
  try {
    const r = await request(s.url, { headers: { authorization: 'Bearer gw' }, body: bodyFor(MAIN) })
    assert.equal(r.status, 401)
    assert.match(r.text, /router setup/)
    assert.equal(s.provider.requests.length, 0)
  } finally { await s.cleanup() }
})

test('a family override routes a Claude haiku request', async () => {
  const s = await setup()
  try {
    await request(s.url, { headers: INBOUND, body: bodyFor('claude-haiku-5-5') })
    assert.equal(JSON.parse(s.provider.requests[0].body).model, 'ds-chat')
  } finally { await s.cleanup() }
})

test('SSE is streamed through unbuffered', async () => {
  const s = await setup({ providerHandler: (req, res, body) => sseReply(res, JSON.parse(body).model, { gapMs: 600, events: 2 }) })
  try {
    const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.ok(r.firstChunkMs < 400, `first chunk after ${r.firstChunkMs} ms`)
    assert.ok(r.totalMs >= 600, `total ${r.totalMs} ms`)
    assert.match(r.text, /part1/)
  } finally { await s.cleanup() }
})

const failures = [
  ['500', { handler: (req, res) => jsonReply(res, 500, { error: { message: 'boom' } }) }, 500, 'boom'],
  ['429', { handler: (req, res) => jsonReply(res, 429, { error: { message: 'slow down' } }) }, 429, 'slow down'],
  ['400 field', { handler: (req, res) => jsonReply(res, 400, { error: { message: "unknown field 'thinking'" } }) }, 400, "unknown field 'thinking'"],
  ['refused', { closed: true }, undefined, 'connect: ECONNREFUSED'],
  ['first-byte timeout', { handler: () => {}, routerOptions: { firstByteTimeoutMs: 200 } }, undefined, 'timeout: ETIMEDOUT_FIRST_BYTE'],
]
for (const [name, how, status, text] of failures) {
  test(`fallback on ${name}: upstream gets the Claude id and the original inbound auth`, async () => {
    const s = await setup({
      providerHandler: how.handler,
      routerOptions: how.routerOptions,
      providerUrl: how.closed ? `http://127.0.0.1:${await closedPort()}` : undefined,
    })
    try {
      const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
      assert.equal(r.status, 200)
      const up = s.upstream.requests[0]
      assert.equal(JSON.parse(up.body).model, 'claude-opus-5-5')
      assert.equal(up.headers.authorization, 'Bearer gw')
      assert.equal(up.headers['x-claude-code-session-id'], 's1')
      const evs = await s.events()
      const fb = evs.find(e => e.kind === 'fallback')
      assert.deepEqual([fb.provider, fb.model, fb.status, fb.session], ['DS', 'claude-opus-5-5', status, 's1'])
      assert.equal(fb.text, text)
      assert.ok(evs.some(e => e.kind === 'provider-error'))
    } finally { await s.cleanup() }
  })
}

test('an HTML error page still falls back with a short readable event text', async () => {
  const s = await setup({ providerHandler: (req, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end(`<html><body><h1>Bad Gateway</h1>${'<p>filler</p>'.repeat(2000)}</body></html>`) } })
  try {
    assert.equal((await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })).status, 200)
    const fb = (await s.events()).find(e => e.kind === 'fallback')
    assert.ok(fb.text.length <= 200)
    assert.ok(!fb.text.includes('<'))
    assert.match(fb.text, /^Bad Gateway/)
  } finally { await s.cleanup() }
})

test('after the first byte, a provider failure passes through (no fallback)', async () => {
  const s = await setup({ providerHandler: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ping\ndata: {}\n\n'); setTimeout(() => res.destroy(), 50) } })
  try {
    const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(r.status, 200)
    assert.match(r.text, /ping/)
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('a max_tokens 400 is learned, retried once on the provider, shown in limits, and gone after a restart', async () => {
  const s = await setup({ providerHandler: (req, res, body) => {
    const json = JSON.parse(body)
    if (json.max_tokens > 8192) return jsonReply(res, 400, { error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } })
    return sseReply(res, json.model)
  } })
  try {
    assert.equal((await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })).status, 200)
    assert.deepEqual(s.provider.requests.map(r => JSON.parse(r.body).max_tokens), [32000, 8192])
    assert.equal(s.upstream.requests.length, 0)
    const learned = (await s.events()).find(e => e.kind === 'learned')
    assert.deepEqual([learned.provider, learned.model, learned.text], ['DS', 'ds-chat', '8192'])
    const limits = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/limits' })).text)
    assert.equal(limits.learned['DS/ds-chat'].maxOutputTokens, 8192)
    await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(s.provider.requests.length, 3)
    assert.equal(JSON.parse(s.provider.requests[2].body).max_tokens, 8192)

    await s.close()
    const again = await startRouter(s.home, { env: { DS_KEY: 'sk-ds' } })
    try {
      assert.deepEqual(JSON.parse((await request(again.url, { method: 'GET', path: '/_router/limits' })).text).learned, {})
    } finally { await again.close() }
  } finally { await s.upstream.close(); await s.provider.close() }
})

test('three failures open the breaker; then requests go straight to Claude', async () => {
  const s = await setup({ providerHandler: (req, res) => jsonReply(res, 500, { error: { message: 'down' } }) })
  try {
    for (let i = 0; i < 3; i++) await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(s.provider.requests.length, 3)
    await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(s.provider.requests.length, 3)
    assert.equal(s.upstream.requests.length, 4)
    const evs = await s.events()
    assert.ok(evs.some(e => e.kind === 'breaker-open' && e.provider === 'DS'))
    assert.match(evs.at(-1).text, /paused/)
    const status = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/status' })).text)
    assert.equal(status.providers[0].breaker, 'open')
  } finally { await s.cleanup() }
})

test('a missing key: a router: id falls back with the reason; an override passes through untouched', async () => {
  const s = await setup({ env: {} })
  try {
    await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(JSON.parse(s.upstream.requests[0].body).model, 'claude-opus-5-5')
    assert.equal((await s.events()).find(e => e.kind === 'fallback').text, 'env DS_KEY not set')
    const raw = JSON.stringify(bodyFor('claude-haiku-5-5'))
    await request(s.url, { headers: INBOUND, body: raw })
    assert.equal(s.upstream.requests[1].body, raw)
    assert.equal(s.provider.requests.length, 0)
  } finally { await s.cleanup() }
})

test('a client that hangs up mid-stream aborts the provider request and the router keeps serving', async () => {
  let providerClosedAt
  const s = await setup({ providerHandler: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: ping\ndata: {}\n\n')
    res.on('close', () => { providerClosedAt = Date.now() })
    setTimeout(() => res.end(), 5000)
  } })
  try {
    const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN), abortAfterFirstChunk: true })
    assert.equal(r.isAborted, true)
    const hungUpAt = Date.now()
    await waitFor(() => providerClosedAt !== undefined, 2000)
    assert.ok(providerClosedAt - hungUpAt < 1000)
    assert.equal((await request(s.url, { method: 'GET', path: '/_router/status' })).status, 200)
  } finally { await s.cleanup() }
})
```

- [ ] **Step 2: Run the tests**

Run: `node --test router/test/server-routed.test.mjs`
Expected: PASS, 15 tests. Any failure is a bug in `server.mjs` (or a lower module): fix the code, not the assertion, and re-run the whole suite: `node --test "router/test/*.test.mjs"`.

- [ ] **Step 3: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "test(router): routed path, fallback classes, learning, breaker, streaming, client abort"
```

### Task 15: count_tokens, drain, idle exit, the CLI and the second-instance rule

**Files:**
- Create: `model-router/router/lib/client.mjs`
- Create: `model-router/router/router.mjs`
- Modify: `model-router/router/test/helpers.mjs` (re-export `waitFor` from `client.mjs`; add `spawnCli`)
- Test: `model-router/router/test/lifecycle.test.mjs`

**Interfaces:**
- Consumes: `createRouter` (Task 13).
- Produces:
  - `client.mjs`: `requestJson(port, path, { method, headers, body, timeoutMs = 1000 }) → { ok: true, status, json } | { ok: false, error }`, `getStatus(port) → { kind: 'ours', status } | { kind: 'foreign' } | { kind: 'down', reason }`, `postShutdown(port, token) → boolean`, `waitFor(fn, timeoutMs, everyMs)`
  - `router.mjs`: CLI; prints `model-router <version> listening on 127.0.0.1:<port> (pid <pid>)`; exit 0 on stop, idle, or a router already on the port; exit 2 with `port <n> is used by another program` otherwise
  - helper `spawnCli(home, env = {}) → { child, output(): string, exited: Promise<number> }`

- [ ] **Step 1: Write `client.mjs` and update the helpers**

`model-router/router/lib/client.mjs`:

```js
// The Node-side client of a router on 127.0.0.1: used by router.mjs and launch.mjs.
import http from 'node:http'

export function requestJson(port, path, { method = 'GET', headers = {}, body, timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', c => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ ok: true, status: res.statusCode, json })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', error => resolve({ ok: false, error }))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export async function getStatus(port) {
  const r = await requestJson(port, '/_router/status')
  if (!r.ok) return { kind: 'down', reason: r.error.code ?? r.error.message }
  return r.json?.name === 'model-router' ? { kind: 'ours', status: r.json } : { kind: 'foreign' }
}

export async function postShutdown(port, token) {
  const r = await requestJson(port, '/_router/shutdown?drain=1', { method: 'POST', headers: { 'x-router-token': token } })
  return r.ok && r.status === 202
}

export async function waitFor(fn, timeoutMs = 3000, everyMs = 20) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > until) throw new Error(`waitFor timed out after ${timeoutMs} ms`)
    await new Promise(r => setTimeout(r, everyMs))
  }
}
```

In `model-router/router/test/helpers.mjs`, delete the local `waitFor` function and add instead:

```js
export { waitFor } from '../lib/client.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../router.mjs', import.meta.url))

export function spawnCli(home, env = {}) {
  const base = { ...process.env }
  delete base.NODE_EXTRA_CA_CERTS
  const child = spawn(process.execPath, [CLI], { env: { ...base, MODEL_ROUTER_HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', c => { out += c })
  child.stderr.on('data', c => { out += c })
  const exited = new Promise(r => child.on('exit', code => r(code)))
  return { child, output: () => out, exited }
}
```

(Keep `import` lines at the top of the file: ES modules hoist them anyway, but move them up for readability.)

- [ ] **Step 2: Write the failing tests**

`model-router/router/test/lifecycle.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { makeHome, startRouter, request, spawnCli, waitFor } from './helpers.mjs'
import { startFake, jsonReply, sseReply, closedPort } from './fakes.mjs'
import { getStatus } from '../lib/client.mjs'

const TOKEN = { 'x-router-token': 'test-token' }

async function routedSetup(providerHandler) {
  const upstream = await startFake()
  const provider = await startFake(providerHandler ? { handler: providerHandler } : {})
  const home = makeHome({ config: { upstream: upstream.url, providers: [{ name: 'DS', baseUrl: provider.url, apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }] }] } })
  const r = await startRouter(home, { env: { DS_KEY: 'k' } })
  return { upstream, provider, ...r, cleanup: async () => { await r.close(); await upstream.close(); await provider.close() } }
}
const countBody = { model: 'router:DS/ds-chat#claude-opus-5-5', messages: [{ role: 'user', content: 'hello there' }] }

test('count_tokens is forwarded to a provider that supports it', async () => {
  const s = await routedSetup()
  try {
    const r = await request(s.url, { path: '/v1/messages/count_tokens', headers: TOKEN, body: countBody })
    assert.deepEqual(JSON.parse(r.text), { input_tokens: 7 })
  } finally { await s.cleanup() }
})

test('count_tokens is estimated locally on a provider 404, without counting a failure', async () => {
  const s = await routedSetup((req, res) => jsonReply(res, 404, { error: { message: 'not found' } }))
  try {
    for (let i = 0; i < 3; i++) {
      const r = await request(s.url, { path: '/v1/messages/count_tokens', headers: TOKEN, body: countBody })
      assert.deepEqual(JSON.parse(r.text), { input_tokens: Math.ceil(JSON.stringify(countBody).length / 4) })
    }
    assert.equal(s.router.breaker.status('DS'), 'closed')
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('shutdown with drain lets an in-flight stream finish, then stops', async () => {
  const s = await routedSetup((req, res, body) => sseReply(res, JSON.parse(body).model, { gapMs: 400, events: 2 }))
  try {
    const streaming = request(s.url, { headers: TOKEN, body: { ...countBody, stream: true } })
    await waitFor(() => s.provider.requests.length === 1)
    const stop = await request(s.url, { path: '/_router/shutdown?drain=1', headers: TOKEN })
    assert.equal(stop.status, 202)
    const done = await streaming
    assert.match(done.text, /part1/)
    await waitFor(async () => (await getStatus(s.port)).kind === 'down')
  } finally { await s.upstream.close(); await s.provider.close() }
})

test('idle routers stop by themselves', async () => {
  const home = makeHome({ config: {} })
  const s = await startRouter(home, { idleMs: 200 })
  let stopped = false
  s.router.onStopped(() => { stopped = true })
  await waitFor(() => stopped, 3000)
})

test('the CLI prints its listen line and serves status', async () => {
  const port = await closedPort()
  const cli = spawnCli(makeHome({ config: { port } }))
  try {
    await waitFor(() => cli.output().includes('listening on 127.0.0.1:'), 5000)
    assert.equal((await getStatus(port)).kind, 'ours')
  } finally { cli.child.kill(); await cli.exited }
})

test('two CLIs racing for one port: one serves, the other exits 0', async () => {
  const port = await closedPort()
  const home = makeHome({ config: { port } })
  const a = spawnCli(home)
  const b = spawnCli(home)
  try {
    const first = await Promise.race([a.exited.then(code => ({ who: 'a', code })), b.exited.then(code => ({ who: 'b', code }))])
    assert.equal(first.code, 0)
    assert.equal((await getStatus(port)).kind, 'ours')
  } finally { a.child.kill(); b.child.kill(); await Promise.all([a.exited, b.exited]) }
})

test('a port held by another program: the CLI exits 2 with a hint', async () => {
  const foreign = http.createServer((req, res) => res.end('{"hello":"world"}'))
  await new Promise(r => foreign.listen(0, '127.0.0.1', r))
  const port = foreign.address().port
  try {
    const cli = spawnCli(makeHome({ config: { port } }))
    assert.equal(await cli.exited, 2)
    assert.match(cli.output(), /port \d+ is used by another program/)
  } finally { foreign.close() }
})

test('the CLI exits 0 when idle', async () => {
  const port = await closedPort()
  const cli = spawnCli(makeHome({ config: { port } }), { MODEL_ROUTER_IDLE_MS: '300' })
  assert.equal(await cli.exited, 0)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test router/test/lifecycle.test.mjs`
Expected: FAIL — the CLI tests fail (`router.mjs` missing); the count/drain/idle tests may already pass because `server.mjs` implements them.

- [ ] **Step 4: Implement `model-router/router/router.mjs`**

```js
#!/usr/bin/env node
// The router process. launch.mjs starts it detached. It exits on shutdown or
// idle, and quietly when another router already owns the port.
import { createRouter } from './lib/server.mjs'
import { getStatus } from './lib/client.mjs'
import { VERSION } from './version.mjs'

const router = createRouter()
router.onStopped(() => process.exit(0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void router.stop({ drain: true }))

try {
  const { port } = await router.start()
  console.log(`model-router ${VERSION} listening on 127.0.0.1:${port} (pid ${process.pid})`)
} catch (err) {
  if (err.code !== 'EADDRINUSE') throw err
  if ((await getStatus(err.port)).kind === 'ours') process.exit(0)
  console.error(`model-router: port ${err.port} is used by another program. Set "port" in ${router.paths.config} to a free port.`)
  process.exit(2)
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test router/test/lifecycle.test.mjs`, then the whole suite: `node --test "router/test/*.test.mjs"`
Expected: PASS everywhere.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): CLI entry, second-instance rule; test count_tokens, drain and idle exit"
```

### Task 16: HTTPS upstream trust (self-signed CA)

**Files:**
- Create: `model-router/router/test/fixtures/tls/ca.pem`, `server.pem`, `server.key`
- Create: `model-router/router/test/fixtures/tls/README.md`
- Test: `model-router/router/test/tls.test.mjs`

**Interfaces:**
- Consumes: `spawnCli` (Task 15), `startFake({ tls })` (Task 12).
- Produces: test certificates valid for `127.0.0.1` and `localhost`, signed by a test CA.

- [ ] **Step 1: Generate the test certificates (Git Bash)**

```bash
cd /c/dev/llm/mods/model-router/router/test/fixtures && mkdir -p tls && cd tls
export MSYS_NO_PATHCONV=1
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 -subj "/CN=model-router test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=127.0.0.1"
printf "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 3650 -extfile server.ext
rm -f ca.key ca.srl server.csr server.ext
ls
```

Expected: `README.md` (next step), `ca.pem`, `server.key`, `server.pem`.

`model-router/router/test/fixtures/tls/README.md`:

```markdown
Test-only certificates for router/test/tls.test.mjs: a CA (key discarded) and a
server certificate for 127.0.0.1/localhost. Never trust ca.pem anywhere else.
Regenerate with the commands in Task 16 of docs/superpowers/plans/2026-10-16-model-router.md.
```

- [ ] **Step 2: Write the tests**

`model-router/router/test/tls.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeHome, spawnCli, request, waitFor } from './helpers.mjs'
import { startFake, closedPort } from './fakes.mjs'
import { getStatus } from '../lib/client.mjs'

const dir = new URL('./fixtures/tls/', import.meta.url)
const tls = { key: fs.readFileSync(new URL('server.key', dir)), cert: fs.readFileSync(new URL('server.pem', dir)) }
const CA = fileURLToPath(new URL('ca.pem', dir))

async function run(env) {
  const upstream = await startFake({ tls })
  const port = await closedPort()
  const cli = spawnCli(makeHome({ config: { port, upstream: upstream.url } }), env)
  try {
    await waitFor(async () => (await getStatus(port)).kind === 'ours', 5000)
    return await request(`http://127.0.0.1:${port}`, { body: { model: 'claude-opus-5-5' } })
  } finally { cli.child.kill(); await cli.exited; await upstream.close() }
}

test('an HTTPS upstream signed by a CA in NODE_EXTRA_CA_CERTS is trusted', async () => {
  const r = await run({ NODE_EXTRA_CA_CERTS: CA })
  assert.equal(r.status, 200)
})

test('an untrusted upstream certificate is a 502 that says tls', async () => {
  const r = await run({})
  assert.equal(r.status, 502)
  assert.match(JSON.parse(r.text).error.message, /\(tls: [A-Z_]+\)/)
})
```

- [ ] **Step 3: Run the tests**

Run: `node --test router/test/tls.test.mjs`
Expected: PASS, 2 tests. If the untrusted case reports `connect:` instead of `tls:`, add the reported code to `TLS_CODES` in `forward.mjs`.

- [ ] **Step 4: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "test(router): HTTPS upstream trusted via NODE_EXTRA_CA_CERTS, untrusted reported as tls"
```

### Task 17: The launcher and its tool subcommands

**Files:**
- Create: `model-router/router/lib/probe-request.mjs`
- Create: `model-router/router/launch.mjs`
- Test: `model-router/router/test/launch.test.mjs`

**Interfaces:**
- Consumes: `docs/model-router-verification.md` "Captured request shape" (Task 1); V3 and V4 decisions (Task 4); Tasks 5–15.
- Produces — the only process interface the mod uses. Every subcommand prints **one JSON line** on stdout; `ok: false` exits 1:
  - `node router/launch.mjs start [--force]` → `{ ok: true, started: boolean, pid, version } | { ok: false, error }` — reuses a same-version router (unless `--force`); drains and replaces an older one (needs the token); refuses a foreign port; spawns `router.mjs` **detached** with `stdio` to `router.out` (not pipes, so `$.process.run` returns), with `nodeFlags()` (`--use-system-ca` on win32 unless V4 said otherwise); waits up to 5 s for `/_router/status`
  - `node router/launch.mjs probe` with stdin `{ mode: 'tls', url }` or `{ mode: 'provider', provider: { baseUrl, apiKeyEnv?, apiKey?, strip? }, model }` → `{ ok, kind?, status?, text?, learnedMaxTokens? }`; `kind` is `'no-key'|'http'|'tls'|'connect'|'timeout'`. Re-executes itself with `nodeFlags()` so TLS trust matches the router's.
  - `node router/launch.mjs env-check NAME…` → `{ ok: true, keys: { NAME: fingerprint | null } }`
  - `node router/launch.mjs write PATH [--private]` with stdin → `{ ok: true, warning? }` — temp file + rename; `--private` makes it user-only (chmod 600, or `icacls` on Windows)
  - `node router/launch.mjs delete PATH` → `{ ok: true }` (missing is fine)
  - `node router/launch.mjs ensure-token PATH` → `{ ok: true, token, created }`
  - `probe-request.mjs`: `PROBE_HEADERS`, `probeRequest(model)`

- [ ] **Step 1: Write `probe-request.mjs` from the captured shape**

Open `docs/model-router-verification.md`, section "Captured request shape". Copy the recorded `anthropic-beta` value into `PROBE_BETA` and the recorded `context_management` JSON into `PROBE_CONTEXT_MANAGEMENT`, verbatim:

```js
// A request shaped like what Claude Code sends an unrecognized model, so a test
// call meets the same fields a real one does. The two constants are copied from
// docs/model-router-verification.md ("Captured request shape"); refresh them when
// Claude Code changes what it sends.
export const PROBE_BETA = 'PASTE THE RECORDED anthropic-beta VALUE HERE'
export const PROBE_CONTEXT_MANAGEMENT = { PASTE: 'THE RECORDED context_management JSON HERE' }

export const PROBE_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': PROBE_BETA,
  'content-type': 'application/json',
}

export function probeRequest(model) {
  return {
    model,
    max_tokens: 32000,
    stream: false,
    thinking: { type: 'adaptive', display: 'omitted' },
    context_management: PROBE_CONTEXT_MANAGEMENT,
    output_config: { effort: 'high' },
    metadata: { user_id: 'model-router-probe' },
    system: [{ type: 'text', text: 'You are a connectivity probe. Reply with OK.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  }
}
```

The test in Step 2 fails while either `PASTE` marker remains, so the copy cannot be skipped.

- [ ] **Step 2: Write the failing tests**

`model-router/router/test/launch.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeHome, tempHome } from './helpers.mjs'
import { startFake, jsonReply, closedPort } from './fakes.mjs'
import { getStatus, postShutdown } from '../lib/client.mjs'
import { fingerprint } from '../lib/fingerprint.mjs'
import { PROBE_BETA, PROBE_CONTEXT_MANAGEMENT } from '../lib/probe-request.mjs'

const LAUNCH = fileURLToPath(new URL('../launch.mjs', import.meta.url))

function launch(args, { input, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [LAUNCH, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.on('exit', code => resolve({ code, json: JSON.parse(out.trim().split('\n').at(-1) || 'null') }))
    child.stdin.end(input ?? '')
  })
}

test('the probe request carries the captured shape', () => {
  assert.ok(!PROBE_BETA.includes('PASTE') && PROBE_BETA.includes('claude-code'))
  assert.ok(!JSON.stringify(PROBE_CONTEXT_MANAGEMENT).includes('PASTE'))
})

test('write is atomic, --private works, delete tolerates a missing file', async () => {
  const file = path.join(tempHome(), 'a', 'b.json')
  assert.deepEqual((await launch(['write', file], { input: '{"x":1}' })).json.ok, true)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1}')
  assert.equal((await launch(['write', file, '--private'], { input: 'secret' })).code, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), 'secret')
  assert.ok(!fs.readdirSync(path.dirname(file)).some(n => n.includes('.tmp-')))
  assert.equal((await launch(['delete', file])).json.ok, true)
  assert.equal(fs.existsSync(file), false)
  assert.equal((await launch(['delete', file])).json.ok, true)
})

test('ensure-token creates once and then returns the same token', async () => {
  const file = path.join(tempHome(), 'model-router', 'token')
  const a = (await launch(['ensure-token', file])).json
  const b = (await launch(['ensure-token', file])).json
  assert.match(a.token, /^[0-9a-f]{64}$/)
  assert.deepEqual([a.created, b.created, b.token], [true, false, a.token])
})

test('env-check reports fingerprints, never values', async () => {
  const r = (await launch(['env-check', 'MR_A', 'MR_B'], { env: { MR_A: 'value-a' } })).json
  assert.deepEqual(r.keys, { MR_A: fingerprint('value-a'), MR_B: null })
})

test('probe: a provider with a max_tokens ceiling is learned and retried', async () => {
  const provider = await startFake({ handler: (req, res, body) => {
    const json = JSON.parse(body)
    if (json.max_tokens > 8192) return jsonReply(res, 400, { error: { message: 'max_tokens must be less than or equal to 8192' } })
    return jsonReply(res, 200, { type: 'message', content: [{ type: 'text', text: 'OK' }] })
  } })
  try {
    const r = (await launch(['probe'], { input: JSON.stringify({ mode: 'provider', provider: { baseUrl: provider.url, apiKeyEnv: 'MR_KEY' }, model: 'm' }), env: { MR_KEY: 'sk-probe' } })).json
    assert.deepEqual([r.ok, r.learnedMaxTokens], [true, 8192])
    const seen = provider.requests[0]
    assert.equal(seen.headers['x-api-key'], 'sk-probe')
    assert.equal(JSON.parse(seen.body).thinking, undefined)
    assert.equal(seen.headers['anthropic-beta'], undefined)
  } finally { await provider.close() }
})

test('probe: a rejected field is reported with status and text', async () => {
  const provider = await startFake({ handler: (req, res, body) => JSON.parse(body).thinking
    ? jsonReply(res, 400, { error: { message: "unknown field 'thinking'" } })
    : jsonReply(res, 200, {}) })
  try {
    const r = (await launch(['probe'], { input: JSON.stringify({ mode: 'provider', provider: { baseUrl: provider.url, apiKey: 'k', strip: [] }, model: 'm' }) })).json
    assert.deepEqual([r.ok, r.kind, r.status, r.text], [false, 'http', 400, "unknown field 'thinking'"])
  } finally { await provider.close() }
})

test('probe: a missing key and an unreachable host are reported', async () => {
  const noKey = (await launch(['probe'], { input: JSON.stringify({ mode: 'provider', provider: { baseUrl: 'https://x.example', apiKeyEnv: 'MR_UNSET' }, model: 'm' }) })).json
  assert.deepEqual([noKey.ok, noKey.kind, noKey.text], [false, 'no-key', 'env MR_UNSET not set'])
  const down = (await launch(['probe'], { input: JSON.stringify({ mode: 'tls', url: `http://127.0.0.1:${await closedPort()}` }) })).json
  assert.deepEqual([down.ok, down.kind], [false, 'connect'])
})

test('start launches a detached router, reuses it, and refuses a foreign port', async () => {
  const port = await closedPort()
  const home = makeHome({ config: { port } })
  const env = { MODEL_ROUTER_HOME: home }
  const first = await launch(['start'], { env })
  try {
    assert.deepEqual([first.json.ok, first.json.started], [true, true])
    assert.equal((await getStatus(port)).kind, 'ours')
    const second = await launch(['start'], { env })
    assert.deepEqual([second.json.started, second.json.pid], [false, first.json.pid])
    const forced = await launch(['start', '--force'], { env })
    assert.equal(forced.json.started, true)
    assert.notEqual(forced.json.pid, first.json.pid)
  } finally { await postShutdown(port, 'test-token') }

  const foreign = http.createServer((req, res) => res.end('{}'))
  await new Promise(r => foreign.listen(0, '127.0.0.1', r))
  try {
    const home2 = makeHome({ config: { port: foreign.address().port } })
    const r = await launch(['start'], { env: { MODEL_ROUTER_HOME: home2 } })
    assert.equal(r.code, 1)
    assert.match(r.json.error, /used by another program/)
  } finally { foreign.close() }
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test router/test/launch.test.mjs`
Expected: FAIL — `launch.mjs` missing (and the first test fails until Step 1's values are pasted).

- [ ] **Step 4: Implement `model-router/router/launch.mjs`**

```js
#!/usr/bin/env node
// What the mod runs through $.process.run. Every subcommand prints one JSON line.
//   node launch.mjs [start] [--force]       start the router detached (--force: replace a running one); wait until it answers
//   node launch.mjs probe < request.json    one test request ({ mode: 'tls' | 'provider', ... })
//   node launch.mjs env-check NAME...       { keys: { NAME: fingerprint | null } } from this env
//   node launch.mjs write PATH [--private]  write stdin to PATH atomically
//   node launch.mjs delete PATH             delete PATH (missing is fine)
//   node launch.mjs ensure-token PATH       create the token file if needed; print { token }
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.mjs'
import { DEFAULT_PORT, DEFAULT_STRIP } from './lib/schema.mjs'
import { routerHome, routerPaths, readConfigFile } from './lib/config.mjs'
import { getStatus, postShutdown, waitFor } from './lib/client.mjs'
import { send, readText, errorMessage, describeFailure } from './lib/forward.mjs'
import { rewriteRouted } from './lib/rewrite.mjs'
import { parseMaxTokensLimit } from './lib/learned.mjs'
import { fingerprint } from './lib/fingerprint.mjs'
import { PROBE_HEADERS, probeRequest } from './lib/probe-request.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROUTER = fileURLToPath(new URL('./router.mjs', import.meta.url))

// Trust the Windows certificate store, where an internal CA usually lives (V4).
const nodeFlags = () => (process.platform === 'win32' ? ['--use-system-ca'] : [])

const readToken = file => { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } }
const tail = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-5).join(' | ') } catch { return '' } }

async function start({ force = false } = {}) {
  const paths = routerPaths(routerHome())
  const cfg = readConfigFile(paths.config)
  const port = cfg.ok ? cfg.config.port : DEFAULT_PORT
  const before = await getStatus(port)
  if (before.kind === 'ours' && before.status.version === VERSION && !force) return { ok: true, started: false, pid: before.status.pid, version: VERSION }
  if (before.kind === 'foreign') return { ok: false, error: `port ${port} is used by another program; set "port" in ${paths.config}` }
  if (before.kind === 'ours') {
    const token = readToken(paths.token)
    if (!token || !(await postShutdown(port, token)))
      return { ok: false, error: `router ${before.status.version} (pid ${before.status.pid}) is running and could not be asked to stop` }
    const gone = await waitFor(async () => (await getStatus(port)).kind === 'down', 30_000, 250).catch(() => false)
    if (!gone) return { ok: false, error: `router ${before.status.version} did not stop within 30 s` }
  }
  fs.mkdirSync(paths.stateDir, { recursive: true })
  const fd = fs.openSync(paths.out, 'w')
  // Files, not pipes: a child holding the launcher's pipes would keep $.process.run waiting.
  const child = spawn(process.execPath, [...nodeFlags(), ROUTER], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
  child.unref()
  fs.closeSync(fd)
  const up = await waitFor(async () => { const s = await getStatus(port); return s.kind === 'ours' ? s : null }, 5000, 100).catch(() => null)
  if (up) return { ok: true, started: true, pid: up.status.pid, version: up.status.version }
  return { ok: false, error: tail(paths.out) || 'the router did not answer within 5 s' }
}

async function probe(input) {
  if (input.mode === 'tls') {
    const r = await send({ url: input.url, method: 'HEAD', headers: {}, firstByteTimeoutMs: 15_000 })
    if (!r.ok) return { ok: false, kind: r.kind, text: describeFailure(r) }
    r.res.resume()
    return { ok: true, status: r.res.statusCode }
  }
  const p = input.provider
  const key = p.apiKey ?? process.env[p.apiKeyEnv]
  if (!key) return { ok: false, kind: 'no-key', text: `env ${p.apiKeyEnv} not set` }
  const url = `${p.baseUrl.replace(/\/+$/, '')}/v1/messages`
  const once = async learned => {
    const sent = rewriteRouted({ headers: PROBE_HEADERS, body: JSON.stringify(probeRequest(input.model)), providerModel: input.model, apiKey: key, strip: p.strip ?? [...DEFAULT_STRIP], customNames: [], limits: { learned } })
    const r = await send({ url, headers: sent.headers, body: sent.body, firstByteTimeoutMs: 60_000 })
    if (!r.ok) return { sent, failure: { kind: r.kind, text: describeFailure(r) } }
    const raw = await readText(r.res)
    return r.res.statusCode >= 400 ? { sent, failure: { kind: 'http', status: r.res.statusCode, raw, text: errorMessage(raw) } } : { sent, status: r.res.statusCode }
  }
  let learnedMaxTokens
  let result = await once(undefined)
  if (result.failure?.status === 400) {
    const limit = parseMaxTokensLimit(400, result.failure.raw, result.sent.maxTokens)
    if (limit !== null) { learnedMaxTokens = limit; result = await once(limit) }
  }
  const learned = learnedMaxTokens === undefined ? {} : { learnedMaxTokens }
  if (result.failure) return { ok: false, kind: result.failure.kind, ...(result.failure.status ? { status: result.failure.status } : {}), text: result.failure.text, ...learned }
  return { ok: true, status: result.status, ...learned }
}

function restrict(file) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return undefined }
  try { execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' }); return undefined }
  catch { return `could not restrict ${file} to the current user` }
}

function writeAtomic(file, text, isPrivate) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, isPrivate ? { mode: 0o600 } : undefined)
  const warning = isPrivate ? restrict(tmp) : undefined
  fs.renameSync(tmp, file)
  return warning
}

function ensureToken(file) {
  const existing = readToken(file)
  if (existing) return { ok: true, token: existing, created: false }
  const token = crypto.randomBytes(32).toString('hex')
  const warning = writeAtomic(file, token, true)
  return { ok: true, token, created: true, ...(warning ? { warning } : {}) }
}

async function run(command, args) {
  switch (command) {
    case 'start': return start({ force: args.includes('--force') })
    case 'probe': return probe(JSON.parse(fs.readFileSync(0, 'utf8')))
    case 'env-check': return { ok: true, keys: Object.fromEntries(args.map(n => [n, process.env[n] ? fingerprint(process.env[n]) : null])) }
    case 'write': {
      const warning = writeAtomic(args[0], fs.readFileSync(0, 'utf8'), args.includes('--private'))
      return { ok: true, ...(warning ? { warning } : {}) }
    }
    case 'delete': fs.rmSync(args[0], { force: true }); return { ok: true }
    case 'ensure-token': return ensureToken(args[0])
    default: return { ok: false, error: `unknown command "${command}"` }
  }
}

const [command = 'start', ...args] = process.argv.slice(2)
const missing = nodeFlags().filter(f => !process.execArgv.includes(f))
if (command === 'probe' && missing.length > 0) {
  const r = spawnSync(process.execPath, [...nodeFlags(), SELF, command, ...args], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
const out = await run(command, args).catch(err => ({ ok: false, error: err.message }))
process.stdout.write(`${JSON.stringify(out)}\n`)
process.exitCode = out.ok === false ? 1 : 0
```

If Task 4 recorded **V4 FAIL**, change `nodeFlags` to `() => []`. If it recorded **V3 FAIL**, replace the `spawn(…, { detached: true … })` call with the `cmd.exe /c start "" /b` form noted in Task 4 and re-run Task 3 steps 8–11.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test router/test/launch.test.mjs`, then `node --test "router/test/*.test.mjs"`
Expected: PASS everywhere.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/router
git commit -m "feat(router): launcher with detached start and probe/env-check/write/token tools"
```

---

## Phase 2 — Mod (`claude plugin test`)

Every mod task runs these three checks at its "verify" step (from the repo root):

```bash
cd /c/dev/llm/mods
claude plugin validate model-router
(cd model-router && npx -y -p typescript@5.6.3 tsc -p .)
claude plugin test model-router
```

Expected: validate reports no errors (a `gating hook` line is a fact, not an error); `tsc` prints nothing; every test passes.

The test kit runs the plugin with nothing beneath it, so `tests/world.ts` (Task 18) stands in for files, env, network, processes and UI. Call-on-`$` hooks answer `{ value }` or `{ deny }`; a `{ deny }` makes the plugin's `$` call reject, which is how a missing file or a refused connection looks.

### Task 18: Mod scaffold, paths, host tools, the test world

**Files:**
- Create: `model-router/.claude-plugin/plugin.json`
- Create: `model-router/hooks/hooks.json`
- Create: `model-router/hooks/register.tsx` (stub; filled in Task 23)
- Create: `model-router/hooks/paths.ts`, `model-router/hooks/host.ts`
- Create: `model-router/types/index.d.ts`
- Create: `model-router/tsconfig.json`, `model-router/.gitignore`
- Create: `model-router/.claude-plugin/types/claude-code/index.d.ts` (copied, gitignored)
- Create: `model-router/tests/world.ts`
- Test: `model-router/tests/host.test.ts`

**Interfaces:**
- Consumes: `VERSION` (Task 5), `launch.mjs` subcommands (Task 17).
- Produces:
  - `Paths = { claudeDir, userSettings, routerHome, config, stateDir, token, backup }`; `getPaths($): Promise<Paths>` — `routerHome = MODEL_ROUTER_HOME ?? CLAUDE_CONFIG_DIR ?? <USERPROFILE|HOME>/.claude`; `claudeDir = CLAUDE_CONFIG_DIR ?? <home>/.claude`
  - `ToolOut = { ok?: boolean, error?: string, [k: string]: unknown }`; `runTool($, args, { stdin?, timeoutMs? }): Promise<ToolOut>`; `readText($, path): Promise<string | null>`; `writeFile($, path, text, { isPrivate? })`; `deleteFile($, path)` (both throw on failure)
  - Contract `PluginState['model-router'] = { pick: Pick, seenModel: string | null, isStarted: boolean, picker: PickerState, wizard: WizardState }` with exported `Pick`, `PickerEntry`, `PickerView`, `PickerState`, `WizardStep`, `WizardState`
  - Test world: constants `HOME, CLAUDE_DIR, CONFIG, STATE_DIR, TOKEN_FILE, BACKUP, USER_SETTINGS, CONFIG_JSON, PANE_PROPS`; `world(on, opts) → World`; `up(w, status?)`, `down(w)`, `routerStatus(patch)`, `run($, command, args)`, `start($)`, `asPlugin($)`, `readJson(w, path)`

- [ ] **Step 1: Write the manifest, hooks.json, a stub module and the contract**

`model-router/.claude-plugin/plugin.json`:

```json
{
  "name": "model-router",
  "version": "0.1.0",
  "description": "Use models from other Anthropic-compatible providers in Claude Code: pick them in /model, override haiku/sonnet/opus/fable, with fallback to Claude",
  "author": { "name": "David Yermiyahu" },
  "types": "./types/index.d.ts",
  "userConfig": {
    "takeOverModelCommand": {
      "type": "boolean",
      "title": "Show routed models in /model",
      "description": "On: /model opens model-router's picker (Claude models plus [Provider] models). Off: the stock /model; /router still works.",
      "default": true
    }
  }
}
```

If `claude plugin validate` rejects a `userConfig` field, fix the field to what it asks for (the manifest schema is the engine's) and keep the name `takeOverModelCommand` and default `true`.

`model-router/hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

`model-router/hooks/register.tsx` (stub, replaced in Task 23):

```tsx
import type { Register } from 'claude-code'

export const register: Register = () => {}
```

`model-router/types/index.d.ts`:

```ts
// model-router's $.state contract: the session's main-model pick and its panes.
export type Pick = string | null
export type PickerEntry = { value: string; label: string; disabledReason?: string }
export type PickerView = { kind: 'main' } | { kind: 'family' } | { kind: 'target'; family: string }
export type PickerState = { mode: 'model' | 'router'; view: PickerView; entries: PickerEntry[] } | null
export type WizardStep = 'name' | 'baseUrl' | 'key' | 'models' | 'test'
export type WizardState = {
  step: WizardStep
  name: string
  baseUrl: string
  key: string
  models: string
  message: string
  isProbeOk: boolean
} | null

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      pick: Pick
      seenModel: string | null
      isStarted: boolean
      picker: PickerState
      wizard: WizardState
    }
  }
}
```

- [ ] **Step 2: Type-check setup**

`model-router/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": [".claude-plugin/types", "hooks", "types", "tests", "router/**/*.d.mts"]
}
```

`model-router/.gitignore`:

```
.claude-plugin/types/
```

Copy this build's API types (path from the `plugin-authoring` skill header loaded this session):

```bash
cd /c/dev/llm/mods/model-router
mkdir -p .claude-plugin/types/claude-code
cp "<the types/claude-code.d.ts path named by the plugin-authoring skill header>" .claude-plugin/types/claude-code/index.d.ts
head -1 .claude-plugin/types/claude-code/index.d.ts
```

Expected: `// Written by Claude Code 2.1.3xx.`

- [ ] **Step 3: Write `paths.ts` and `host.ts`**

`model-router/hooks/paths.ts`:

```ts
import type { EngineInterface } from 'claude-code'

export type Paths = {
  claudeDir: string
  userSettings: string
  routerHome: string
  config: string
  stateDir: string
  token: string
  backup: string
}

// Same order as the router's routerHome(): MODEL_ROUTER_HOME, CLAUDE_CONFIG_DIR, ~/.claude.
export async function getPaths($: EngineInterface): Promise<Paths> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const claudeDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const routerHome = (await $.env.get('MODEL_ROUTER_HOME')) || claudeDir
  const stateDir = `${routerHome}/model-router`
  return {
    claudeDir,
    userSettings: `${claudeDir}/settings.json`,
    routerHome,
    config: `${routerHome}/model-router.json`,
    stateDir,
    token: `${stateDir}/token`,
    backup: `${stateDir}/setup-backup.json`,
  }
}
```

`model-router/hooks/host.ts`:

```ts
// Host work the mod cannot do itself (no Node here): router/launch.mjs does it.
import type { EngineInterface } from 'claude-code'

export type ToolOut = { ok?: boolean; error?: string; [key: string]: unknown }

export async function runTool($: EngineInterface, args: readonly string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<ToolOut> {
  const argv = ['node', `${$.plugin.root}/router/launch.mjs`, ...args]
  let result
  try {
    result = await $.process.run(argv, { ...(options.stdin !== undefined ? { stdin: options.stdin } : {}), timeoutMs: options.timeoutMs ?? 30_000 })
  } catch (err) {
    return { ok: false, error: `could not run node: ${String(err)}` }
  }
  const last = result.stdout.trim().split('\n').at(-1) ?? ''
  try { return JSON.parse(last) as ToolOut }
  catch { return { ok: false, error: (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 500) } }
}

export async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

export async function writeFile($: EngineInterface, path: string, text: string, options: { isPrivate?: boolean } = {}): Promise<void> {
  const out = await runTool($, ['write', path, ...(options.isPrivate ? ['--private'] : [])], { stdin: text })
  if (out.ok !== true) throw new Error(`could not write ${path}: ${out.error ?? 'unknown error'}`)
}

export async function deleteFile($: EngineInterface, path: string): Promise<void> {
  const out = await runTool($, ['delete', path])
  if (out.ok !== true) throw new Error(`could not delete ${path}: ${out.error ?? 'unknown error'}`)
}
```

- [ ] **Step 4: Write the test world**

`model-router/tests/world.ts`:

```ts
// Stand-ins for everything beneath the plugin: the kit has no engine below the
// plugin's hooks, so these hooks answer its files, env, network, processes and UI.
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { EngineInterface, ModelCompleteInput, ModelCompleteResult, On, SettingsSource } from 'claude-code'
import { VERSION } from '../router/version.mjs'
import type { RouterEvent, RouterStatus } from '../hooks/client'

export const HOME = 'C:/Users/test'
export const CLAUDE_DIR = `${HOME}/.claude`
export const CONFIG = `${CLAUDE_DIR}/model-router.json`
export const STATE_DIR = `${CLAUDE_DIR}/model-router`
export const TOKEN_FILE = `${STATE_DIR}/token`
export const BACKUP = `${STATE_DIR}/setup-backup.json`
export const USER_SETTINGS = `${CLAUDE_DIR}/settings.json`

export const CONFIG_JSON = {
  version: 1,
  upstream: 'https://gw.example',
  providers: [
    { name: 'DS', baseUrl: 'https://ds.example/anthropic', apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }, { id: 'ds-reasoner' }] },
    { name: 'OR', baseUrl: 'https://or.example/api', apiKeyEnv: 'OR_KEY', models: [{ id: 'anthropic/claude-x' }, { id: 'ds-chat' }] },
  ],
  overrides: { haiku: 'DS/ds-chat' },
}

export const PANE_PROPS = {
  title: 'test',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

export function routerStatus(patch: Partial<RouterStatus> = {}): RouterStatus {
  return {
    name: 'model-router',
    version: VERSION,
    pid: 42,
    uptimeMs: 1,
    upstream: 'https://gw.example',
    configOk: true,
    providers: [
      { name: 'DS', available: true, breaker: 'closed' },
      { name: 'OR', available: true, breaker: 'closed' },
    ],
    models: [{ ref: 'DS/ds-chat' }, { ref: 'DS/ds-reasoner' }, { ref: 'OR/anthropic/claude-x' }, { ref: 'OR/ds-chat' }],
    policyApi: 1,
    eventsSeq: 0,
    ...patch,
  }
}

type Reply = { status: number; json: unknown }
type Route = (url: URL, body: string | undefined, headers: Record<string, string>) => Reply

export type World = {
  clock: MockClock
  files: Map<string, string>
  settings: Partial<Record<SettingsSource, Record<string, unknown>>>
  http: Map<string, Route>
  fetches: { method: string; url: string; headers: Record<string, string> }[]
  runs: { argv: readonly string[]; stdin?: string }[]
  tool: (sub: string, args: readonly string[], stdin: string | undefined) => Record<string, unknown> | undefined
  events: RouterEvent[]
  toasts: string[]
  statusLines: (string | undefined)[]
  logs: string[]
  opened: string[]
  closed: string[]
  registered: string[]
  commands: { command: string; args: string; origin: string }[]
  stepModels: string[]
  completes: ModelCompleteInput[]
  complete: (input: ModelCompleteInput) => ModelCompleteResult
  sessionId: string
  model: string
  failSessionModel: boolean
  rawRun: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } | null
}

export type WorldOptions = { env?: Record<string, string>; files?: Record<string, string>; config?: unknown; isRouterUp?: boolean }

export function up(w: World, status: RouterStatus = routerStatus()): void {
  w.http.set('GET /_router/status', () => ({ status: 200, json: status }))
  w.http.set('GET /_router/events', url => {
    const after = Number(url.searchParams.get('after') ?? 0)
    return { status: 200, json: { events: w.events.filter(e => e.seq > after), lastSeq: w.events.at(-1)?.seq ?? status.eventsSeq } }
  })
  w.http.set('GET /_router/limits', () => ({ status: 200, json: { learned: {}, policy: null } }))
  w.http.set('GET /_router/keys', () => ({ status: 200, json: { keys: { DS_KEY: 'fp-ds', OR_KEY: 'fp-or' } } }))
  w.http.set('POST /_router/forget', () => ({ status: 200, json: { forgotten: 1 } }))
  w.http.set('POST /_router/shutdown', () => { down(w); return { status: 202, json: { stopping: true } } })
}

export function down(w: World): void {
  w.http.clear()
}

export function world(on: On, { env = {}, files = {}, config = CONFIG_JSON, isRouterUp = true }: WorldOptions = {}): World {
  const w: World = {
    clock: mock.clock(on),
    files: new Map(Object.entries(files)),
    settings: {},
    http: new Map(),
    fetches: [],
    runs: [],
    tool: () => undefined,
    events: [],
    toasts: [],
    statusLines: [],
    logs: [],
    opened: [],
    closed: [],
    registered: [],
    commands: [],
    stepModels: [],
    completes: [],
    complete: () => ({ isAnswered: true, text: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    sessionId: 'sess-1',
    model: 'claude-opus-5-5',
    failSessionModel: false,
    rawRun: null,
  }
  if (config !== null) w.files.set(CONFIG, JSON.stringify(config))
  if (isRouterUp) up(w)
  mock.env(on, { USERPROFILE: HOME, ...env })

  on('fs.read', ($, e) => (w.files.has(e.path) ? { value: w.files.get(e.path)! } : { deny: `ENOENT: ${e.path}` }))
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('settings.read', ($, e) => ({ value: (e.source ? w.settings[e.source] : Object.assign({}, ...Object.values(w.settings))) ?? {} }))
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const headers = e.init?.headers ?? {}
    w.fetches.push({ method, url: e.url, headers })
    const route = w.http.get(`${method} ${url.pathname}`)
    if (!route) return { deny: 'connect ECONNREFUSED' }
    const reply = route(url, e.init?.body, headers)
    return { value: { status: reply.status, ok: reply.status < 400, headers: {}, text: JSON.stringify(reply.json) } }
  })
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin
    w.runs.push({ argv: e.argv, ...(stdin !== undefined ? { stdin } : {}) })
    if (w.rawRun) return { value: w.rawRun }
    const [, script = '', sub = '', ...args] = e.argv
    if (!script.endsWith('/router/launch.mjs')) return { deny: `unexpected command ${e.argv.join(' ')}` }
    const out = w.tool(sub, args, stdin) ?? builtinTool(w, sub, args, stdin)
    return { value: { exitCode: out.ok === false ? 1 : 0, stdout: `${JSON.stringify(out)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { w.statusLines.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.open', ($, e) => { w.opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { w.closed.push(e.id); return { value: undefined } })
  on('command.register', ($, e) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('session.id', () => ({ value: w.sessionId }))
  on('session.model', () => (w.failSessionModel ? { deny: 'session.model failed' } : { value: w.model }))
  on('model.complete', ($, e) => { w.completes.push(e); return { value: w.complete(e) } })
  on('command.run', ($, e) => {
    w.commands.push({ command: e.command, args: e.args, origin: e.origin.kind })
    return { text: `built-in /${e.command} ${e.args}`.trim() }
  })
  on('turn.step', async function* ($, e) {
    w.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

function builtinTool(w: World, sub: string, args: readonly string[], stdin: string | undefined): Record<string, unknown> {
  switch (sub) {
    case 'write': w.files.set(args[0]!, stdin ?? ''); return { ok: true }
    case 'delete': w.files.delete(args[0]!); return { ok: true }
    case 'ensure-token': {
      const existing = w.files.get(args[0]!)
      if (existing) return { ok: true, token: existing, created: false }
      w.files.set(args[0]!, 'tok-1')
      return { ok: true, token: 'tok-1', created: true }
    }
    case 'env-check': return { ok: true, keys: Object.fromEntries(args.map(n => [n, `fp-${n === 'DS_KEY' ? 'ds' : n === 'OR_KEY' ? 'or' : 'x'}`])) }
    case 'start': up(w); return { ok: true, started: true, pid: 42, version: VERSION }
    case 'probe': return { ok: true, status: 200 }
    default: return { ok: false, error: `no stub for ${sub}` }
  }
}

export const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

export const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })

// The kit's $ is the engine's own; plugin helpers take the same interface.
export const asPlugin = ($: Engine) => $ as unknown as EngineInterface

export const readJson = (w: World, path: string): any => JSON.parse(w.files.get(path) ?? 'null')
```

`tests/world.ts` imports types from `../hooks/client` (Task 20). Until then create a minimal `model-router/hooks/client.ts` holding only the types (Task 20 adds the functions below them):

```ts
export type Breaker = 'closed' | 'open' | 'half-open'
export type ProviderStatus = { name: string; available: boolean; reason?: string; breaker: Breaker }
export type RouterStatus = {
  name: 'model-router'
  version: string
  pid: number
  uptimeMs: number
  upstream: string | null
  configOk: boolean
  providers: ProviderStatus[]
  models: { ref: string }[]
  policyApi: number
  eventsSeq: number
}
export type RouterEvent = { seq: number; t: string; kind: string; session?: string; provider?: string; model?: string; status?: number; text?: string }
export type Learned = Record<string, { maxOutputTokens: number; learnedAt: string; source: string }>
```

- [ ] **Step 5: Write the failing tests**

`model-router/tests/host.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { getPaths } from '../hooks/paths'
import { readText, runTool, writeFile } from '../hooks/host'
import { asPlugin, world, CONFIG, HOME } from './world'

test('paths follow USERPROFILE, CLAUDE_CONFIG_DIR and MODEL_ROUTER_HOME', async ($, on) => {
  world(on, { env: {} })
  const p = await getPaths(asPlugin($))
  expect(p.config).toBe(`${HOME}/.claude/model-router.json`)
  expect(p.token).toBe(`${HOME}/.claude/model-router/token`)
  expect(p.userSettings).toBe(`${HOME}/.claude/settings.json`)
})

test('CLAUDE_CONFIG_DIR moves everything, MODEL_ROUTER_HOME moves only the router files', async ($, on) => {
  world(on, { env: { CLAUDE_CONFIG_DIR: 'D:/cc', MODEL_ROUTER_HOME: 'D:/mr' } })
  const p = await getPaths(asPlugin($))
  expect(p.userSettings).toBe('D:/cc/settings.json')
  expect(p.config).toBe('D:/mr/model-router.json')
  expect(p.backup).toBe('D:/mr/model-router/setup-backup.json')
})

test('writeFile goes through launch.mjs write with stdin', async ($, on) => {
  const w = world(on)
  await writeFile(asPlugin($), 'C:/x/y.json', '{"a":1}', { isPrivate: true })
  const last = w.runs.at(-1)!
  expect(last.argv.slice(2)).toEqual(['write', 'C:/x/y.json', '--private'])
  expect(last.stdin).toBe('{"a":1}')
  expect(w.files.get('C:/x/y.json')).toBe('{"a":1}')
})

test('readText answers null for a missing file', async ($, on) => {
  world(on, { config: null })
  expect(await readText(asPlugin($), CONFIG)).toBe(null)
})

test('runTool reports unparseable output as an error', async ($, on) => {
  const w = world(on)
  w.rawRun = { exitCode: 3, stdout: 'not json', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false }
  const out = await runTool(asPlugin($), ['start'])
  expect(out).toEqual({ ok: false, error: 'boom' })
  expect(w.runs.length).toBe(1)
})
```

- [ ] **Step 6: Run the checks**

Run the three Phase 2 checks. Expected: validate passes, `tsc` passes, 5 tests pass.

- [ ] **Step 7: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/.claude-plugin/plugin.json model-router/.gitignore model-router/hooks model-router/types model-router/tsconfig.json model-router/tests
git commit -m "feat(mod): scaffold, paths, host tools and the test world"
```

### Task 19: Mod config — load, update, display, name matching

**Files:**
- Create: `model-router/hooks/config.ts`
- Test: `model-router/tests/config.test.ts`

**Interfaces:**
- Consumes: `validateConfig`, `formatErrors`, `parseRef`, `allRefs`, `Config`, `ConfigError` (Task 5); `readText`, `writeFile` (Task 18); `Paths`.
- Produces:
  - `RawProvider`, `RawConfig` (the file's own JSON shape)
  - `Loaded = { raw: RawConfig | null, config: Config, errors: ConfigError[] }` — `config` is the valid config, or the empty default when the file is missing or invalid
  - `loadConfig($, paths): Promise<Loaded>`
  - `updateConfig($, paths, mutate: (raw: RawConfig) => void): Promise<{ ok: true, config } | { ok: false, message }>` — re-reads, mutates a copy, validates, writes 2-space JSON atomically
  - `display(ref): string` → `[Provider] model`
  - `Match = { kind: 'one', ref } | { kind: 'ambiguous', refs } | { kind: 'none' }`; `findModel(config, name): Match`
  - `ambiguousText(name, refs): string`; `modelList(config): string`

- [ ] **Step 1: Write the failing tests**

`model-router/tests/config.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import { ambiguousText, display, findModel, loadConfig, updateConfig } from '../hooks/config'
import { getPaths } from '../hooks/paths'
import { asPlugin, CONFIG, CONFIG_JSON, readJson, world } from './world'

const config = (validateConfig(CONFIG_JSON) as { ok: true; config: Config }).config

test('a missing file is the empty config, not an error', async ($, on) => {
  world(on, { config: null })
  const loaded = await loadConfig(asPlugin($), await getPaths(asPlugin($)))
  expect(loaded.raw).toBe(null)
  expect(loaded.errors).toEqual([])
  expect(loaded.config.providers).toEqual([])
})

test('invalid JSON and invalid content are reported with paths', async ($, on) => {
  const w = world(on, { config: null })
  w.files.set(CONFIG, '{ nope')
  expect((await loadConfig(asPlugin($), await getPaths(asPlugin($)))).errors[0]!.message).toMatch(/invalid JSON/)
  w.files.set(CONFIG, JSON.stringify({ overrides: { gpt: 'x/y' } }))
  expect((await loadConfig(asPlugin($), await getPaths(asPlugin($)))).errors.map(e => e.path)).toEqual(['overrides.gpt'])
})

test('updateConfig writes a validated copy and refuses an invalid result', async ($, on) => {
  const w = world(on)
  const paths = await getPaths(asPlugin($))
  const ok = await updateConfig(asPlugin($), paths, raw => { raw.defaultMainModel = 'DS/ds-chat' })
  expect(ok.ok).toBe(true)
  expect(readJson(w, CONFIG).defaultMainModel).toBe('DS/ds-chat')
  expect(w.files.get(CONFIG)!.endsWith('}\n')).toBe(true)
  const bad = await updateConfig(asPlugin($), paths, raw => { raw.defaultMainModel = 'Nope/x' })
  expect(bad).toEqual({ ok: false, message: 'defaultMainModel: references unknown model "Nope/x"' })
  expect(readJson(w, CONFIG).defaultMainModel).toBe('DS/ds-chat')
})

test('display shows [Provider] model and keeps slashes in the model', () => {
  expect(display('DS/ds-chat')).toBe('[DS] ds-chat')
  expect(display('OR/anthropic/claude-x')).toBe('[OR] anthropic/claude-x')
})

test('findModel: exact, case-insensitive, unique bare id, ambiguous, none', () => {
  expect(findModel(config, 'OR/anthropic/claude-x')).toEqual({ kind: 'one', ref: 'OR/anthropic/claude-x' })
  expect(findModel(config, 'ds/DS-CHAT')).toEqual({ kind: 'one', ref: 'DS/ds-chat' })
  expect(findModel(config, 'ds-reasoner')).toEqual({ kind: 'one', ref: 'DS/ds-reasoner' })
  expect(findModel(config, 'anthropic/claude-x')).toEqual({ kind: 'one', ref: 'OR/anthropic/claude-x' })
  expect(findModel(config, 'ds-chat')).toEqual({ kind: 'ambiguous', refs: ['DS/ds-chat', 'OR/ds-chat'] })
  expect(findModel(config, 'opus')).toEqual({ kind: 'none' })
})

test('ambiguousText lists the candidates and the fix', () => {
  expect(ambiguousText('ds-chat', ['DS/ds-chat', 'OR/ds-chat'])).toBe(
    '"ds-chat" matches several models:\n  DS/ds-chat\n  OR/ds-chat\nName one as Provider/model.')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, `hooks/config` not found.

- [ ] **Step 3: Implement `model-router/hooks/config.ts`**

```ts
import type { EngineInterface } from 'claude-code'
import { allRefs, formatErrors, parseRef, validateConfig } from '../router/lib/schema.mjs'
import type { Config, ConfigError } from '../router/lib/schema.mjs'
import { readText, writeFile } from './host'
import type { Paths } from './paths'

export type RawProvider = { name: string; baseUrl: string; apiKeyEnv?: string; apiKey?: string; strip?: string[]; models: { id: string }[] }
export type RawConfig = {
  [key: string]: unknown
  version?: number
  port?: number
  upstream?: string
  providers?: RawProvider[]
  overrides?: Record<string, string>
  defaultMainModel?: string
}
export type Loaded = { raw: RawConfig | null; config: Config; errors: ConfigError[] }

const EMPTY = (validateConfig({}) as { ok: true; config: Config }).config

export async function loadConfig($: EngineInterface, paths: Paths): Promise<Loaded> {
  const text = await readText($, paths.config)
  if (text === null) return { raw: null, config: EMPTY, errors: [] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (err) {
    return { raw: null, config: EMPTY, errors: [{ path: '', message: `invalid JSON: ${String(err)}` }] }
  }
  const result = validateConfig(raw)
  return result.ok
    ? { raw: raw as RawConfig, config: result.config, errors: [] }
    : { raw: raw as RawConfig, config: EMPTY, errors: result.errors }
}

export async function updateConfig($: EngineInterface, paths: Paths, mutate: (raw: RawConfig) => void): Promise<{ ok: true; config: Config } | { ok: false; message: string }> {
  const loaded = await loadConfig($, paths)
  if (loaded.raw === null && loaded.errors.length > 0) return { ok: false, message: `${paths.config}: ${formatErrors(loaded.errors)}` }
  const raw: RawConfig = loaded.raw ? JSON.parse(JSON.stringify(loaded.raw)) : { version: 1, providers: [], overrides: {} }
  mutate(raw)
  const result = validateConfig(raw)
  if (!result.ok) return { ok: false, message: formatErrors(result.errors) }
  await writeFile($, paths.config, `${JSON.stringify(raw, null, 2)}\n`)
  return { ok: true, config: result.config }
}

export function display(ref: string): string {
  const r = parseRef(ref)
  return r ? `[${r.provider}] ${r.model}` : ref
}

export type Match = { kind: 'one'; ref: string } | { kind: 'ambiguous'; refs: string[] } | { kind: 'none' }

export function findModel(config: Config, name: string): Match {
  const wanted = name.trim()
  const refs = allRefs(config)
  const exact = refs.find(r => r === wanted) ?? refs.find(r => r.toLowerCase() === wanted.toLowerCase())
  if (exact) return { kind: 'one', ref: exact }
  const bare = refs.filter(r => parseRef(r)?.model === wanted)
  if (bare.length === 1) return { kind: 'one', ref: bare[0]! }
  if (bare.length > 1) return { kind: 'ambiguous', refs: bare }
  return { kind: 'none' }
}

export function ambiguousText(name: string, refs: readonly string[]): string {
  return [`"${name}" matches several models:`, ...refs.map(r => `  ${r}`), 'Name one as Provider/model.'].join('\n')
}

export function modelList(config: Config): string {
  const refs = allRefs(config)
  return refs.length > 0 ? refs.join(', ') : 'none yet — add a provider with /router add'
}
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass (11 tests so far).

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): config load/update, display and model name matching"
```

### Task 20: Router client and `ensureRouter`

**Files:**
- Modify: `model-router/hooks/client.ts` (add functions under the types from Task 18)
- Create: `model-router/hooks/lifecycle.ts`
- Test: `model-router/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `runTool`, `readText` (Task 18); `VERSION` (Task 5); `launch.mjs start [--force]` (Task 17).
- Produces:
  - `routerUrl(port): string`
  - `call($, port, path, init?, timeoutMs = 1000): Promise<{ ok: true, status, json } | { ok: false, reason }>` — races `$.http.fetch` with `$.clock.sleep`
  - `Probe = { kind: 'ours', status } | { kind: 'foreign' } | { kind: 'down', reason }`; `probeRouter($, port): Promise<Probe>`
  - `getEvents($, port, after): Promise<{ events, lastSeq } | null>`, `getLimits($, port): Promise<{ learned: Learned, policy: unknown } | null>`, `getKeys($, port, token): Promise<Record<string, string | null> | null>`, `postForget($, port, token, ref): Promise<number | null>`, `postShutdown($, port, token): Promise<boolean>`
  - `Ensure = { ok: true, status, started } | { ok: false, reason }`; `ensureRouter($, port, { force? }): Promise<Ensure>`

- [ ] **Step 1: Write the failing tests**

`model-router/tests/lifecycle.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { getEvents, postForget, probeRouter } from '../hooks/client'
import { ensureRouter } from '../hooks/lifecycle'
import { asPlugin, down, routerStatus, world } from './world'

test('probeRouter tells ours, foreign and down apart', async ($, on) => {
  const w = world(on)
  expect((await probeRouter(asPlugin($), 4141)).kind).toBe('ours')
  w.http.set('GET /_router/status', () => ({ status: 200, json: { hello: 'world' } }))
  expect((await probeRouter(asPlugin($), 4141)).kind).toBe('foreign')
  down(w)
  const gone = await probeRouter(asPlugin($), 4141)
  expect(gone.kind).toBe('down')
  expect(gone.kind === 'down' && gone.reason.includes('ECONNREFUSED')).toBe(true)
})

test('a running router of this version is reused without launching', async ($, on) => {
  const w = world(on)
  const r = await ensureRouter(asPlugin($), 4141)
  expect(r).toEqual({ ok: true, status: routerStatus(), started: false })
  expect(w.runs.length).toBe(0)
})

test('a down router is launched through launch.mjs start', async ($, on) => {
  const w = world(on, { isRouterUp: false })
  const r = await ensureRouter(asPlugin($), 4141)
  expect(r.ok && r.started).toBe(true)
  expect(w.runs[0]!.argv.slice(2)).toEqual(['start'])
})

test('another version is handed to the launcher (which drains and replaces it)', async ($, on) => {
  const w = world(on)
  w.http.set('GET /_router/status', () => ({ status: 200, json: routerStatus({ version: '0.0.9' }) }))
  w.tool = sub => {
    if (sub !== 'start') return undefined
    w.http.set('GET /_router/status', () => ({ status: 200, json: routerStatus() }))
    return { ok: true, started: true, pid: 43, version: routerStatus().version }
  }
  const r = await ensureRouter(asPlugin($), 4141)
  expect(r.ok && r.status.version).toBe(routerStatus().version)
})

test('a foreign port is reported without launching; a failed launch reports the launcher error', async ($, on) => {
  const w = world(on)
  w.http.set('GET /_router/status', () => ({ status: 200, json: {} }))
  expect(await ensureRouter(asPlugin($), 4141)).toEqual({ ok: false, reason: 'port 4141 is used by another program; set "port" in model-router.json' })
  down(w)
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'EACCES' } : undefined)
  expect(await ensureRouter(asPlugin($), 4141)).toEqual({ ok: false, reason: 'EACCES' })
})

test('force asks the launcher to replace the running router', async ($, on) => {
  const w = world(on)
  await ensureRouter(asPlugin($), 4141, { force: true })
  expect(w.runs[0]!.argv.slice(2)).toEqual(['start', '--force'])
})

test('events and forget go to the router endpoints with the token', async ($, on) => {
  const w = world(on)
  w.events = [{ seq: 1, t: 't', kind: 'learned' }, { seq: 2, t: 't', kind: 'fallback' }]
  expect((await getEvents(asPlugin($), 4141, 1))!.events.map(e => e.seq)).toEqual([2])
  expect(await postForget(asPlugin($), 4141, 'tok', 'all')).toBe(1)
  expect(w.fetches.at(-1)!.headers['x-router-token']).toBe('tok')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, the functions do not exist.

- [ ] **Step 3: Implement**

Append to `model-router/hooks/client.ts`:

```ts
import type { EngineInterface, HttpInit } from 'claude-code'

export const routerUrl = (port: number) => `http://127.0.0.1:${port}`

type Reply = { ok: true; status: number; json: unknown } | { ok: false; reason: string }

// One router call, given up after timeoutMs so a hung port cannot hold a hook.
export async function call($: EngineInterface, port: number, path: string, init: HttpInit = {}, timeoutMs = 1000): Promise<Reply> {
  const timeout = $.clock.sleep(timeoutMs).then((): Reply => ({ ok: false, reason: `no answer within ${timeoutMs} ms` }))
  const fetched = $.http.fetch(`${routerUrl(port)}${path}`, init).then(
    (r): Reply => {
      let json: unknown = null
      try { json = JSON.parse(r.text) } catch {}
      return { ok: true, status: r.status, json }
    },
    (err: unknown): Reply => ({ ok: false, reason: String(err) }),
  )
  return Promise.race([fetched, timeout])
}

export type Probe = { kind: 'ours'; status: RouterStatus } | { kind: 'foreign' } | { kind: 'down'; reason: string }

export async function probeRouter($: EngineInterface, port: number): Promise<Probe> {
  const r = await call($, port, '/_router/status')
  if (!r.ok) return { kind: 'down', reason: r.reason }
  const s = r.json as Partial<RouterStatus> | null
  return s?.name === 'model-router' ? { kind: 'ours', status: s as RouterStatus } : { kind: 'foreign' }
}

export async function getEvents($: EngineInterface, port: number, after: number): Promise<{ events: RouterEvent[]; lastSeq: number } | null> {
  const r = await call($, port, `/_router/events?after=${after}`)
  return r.ok && r.status === 200 ? (r.json as { events: RouterEvent[]; lastSeq: number }) : null
}

export async function getLimits($: EngineInterface, port: number): Promise<{ learned: Learned; policy: unknown } | null> {
  const r = await call($, port, '/_router/limits')
  return r.ok && r.status === 200 ? (r.json as { learned: Learned; policy: unknown }) : null
}

export async function getKeys($: EngineInterface, port: number, token: string): Promise<Record<string, string | null> | null> {
  const r = await call($, port, '/_router/keys', { headers: { 'x-router-token': token } })
  return r.ok && r.status === 200 ? (r.json as { keys: Record<string, string | null> }).keys : null
}

export async function postForget($: EngineInterface, port: number, token: string, ref: string): Promise<number | null> {
  const r = await call($, port, '/_router/forget', { method: 'POST', headers: { 'x-router-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ ref }) })
  return r.ok && r.status === 200 ? (r.json as { forgotten: number }).forgotten : null
}

export async function postShutdown($: EngineInterface, port: number, token: string): Promise<boolean> {
  const r = await call($, port, '/_router/shutdown?drain=1', { method: 'POST', headers: { 'x-router-token': token } })
  return r.ok && r.status === 202
}
```

Move the new `import type` line to the top of the file.

`model-router/hooks/lifecycle.ts`:

```ts
import type { EngineInterface } from 'claude-code'
import { VERSION } from '../router/version.mjs'
import { probeRouter } from './client'
import type { RouterStatus } from './client'
import { runTool } from './host'

export type Ensure = { ok: true; status: RouterStatus; started: boolean } | { ok: false; reason: string }

// Status, then (when needed) the launcher, which spawns detached, drains an older
// version and does all the waiting: a hook's own budget is 10 s and sleeps count.
export async function ensureRouter($: EngineInterface, port: number, { force = false }: { force?: boolean } = {}): Promise<Ensure> {
  const before = await probeRouter($, port)
  if (!force && before.kind === 'ours' && before.status.version === VERSION) return { ok: true, status: before.status, started: false }
  if (before.kind === 'foreign') return { ok: false, reason: `port ${port} is used by another program; set "port" in model-router.json` }
  const out = await runTool($, force ? ['start', '--force'] : ['start'], { timeoutMs: 60_000 })
  if (out.ok !== true) return { ok: false, reason: String(out.error ?? 'the router did not start') }
  const after = await probeRouter($, port)
  if (after.kind === 'ours') return { ok: true, status: after.status, started: true }
  return { ok: false, reason: after.kind === 'down' ? after.reason : 'the port answered, but not as model-router' }
}
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): router client and ensureRouter through the launcher"
```

### Task 21: The session pick and the wire model

**Files:**
- Create: `model-router/hooks/pick.ts`
- Test: `model-router/tests/pick.test.ts`

**Interfaces:**
- Consumes: contract (Task 18), `parseRef` (Task 5), `RouterStatus` (Task 18/20).
- Produces:
  - `ROUTED_PREFIX = 'router:'`, `FALLBACK_SEP = '#'` (keep equal to `router/lib/resolve.mjs`)
  - atoms `pickAtom`, `seenModelAtom`, `startedAtom`
  - `getPick($): Promise<string | null>`; `setPick($, ref)` (records `seenModel = $.session.model()`); `clearPick($)`
  - `wireModel(pick, claudeModel): string` → `router:<pick>#<claudeModel>`
  - `providerState(status, ref): 'ok' | 'paused' | 'unavailable' | 'unknown'`; `isRoutable(status, ref): boolean` (`'ok'` only)

- [ ] **Step 1: Write the failing tests**

`model-router/tests/pick.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { read } from 'claude-code'
import { clearPick, getPick, isRoutable, providerState, seenModelAtom, setPick, wireModel } from '../hooks/pick'
import { asPlugin, routerStatus, world } from './world'

test('the wire model carries the pick and the Claude fallback id', () => {
  expect(wireModel('DS/ds-chat', 'claude-opus-5-5')).toBe('router:DS/ds-chat#claude-opus-5-5')
  expect(wireModel('OR/anthropic/claude-x', 'claude-sonnet-5-5')).toBe('router:OR/anthropic/claude-x#claude-sonnet-5-5')
})

test('provider state comes from the last router status', () => {
  const s = routerStatus({ providers: [
    { name: 'DS', available: true, breaker: 'open' },
    { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' },
  ] })
  expect(providerState(s, 'DS/ds-chat')).toBe('paused')
  expect(providerState(s, 'OR/ds-chat')).toBe('unavailable')
  expect(providerState(s, 'XX/y')).toBe('unknown')
  expect(providerState(null, 'DS/ds-chat')).toBe('unknown')
  expect(isRoutable(routerStatus(), 'DS/ds-chat')).toBe(true)
  expect(isRoutable(null, 'DS/ds-chat')).toBe(false)
})

test('setPick remembers the session model it was made under; clearPick forgets both', async ($, on) => {
  const w = world(on)
  w.model = 'claude-sonnet-5-5'
  await setPick(asPlugin($), 'DS/ds-chat')
  expect(await getPick(asPlugin($))).toBe('DS/ds-chat')
  expect(await read(asPlugin($), seenModelAtom)).toBe('claude-sonnet-5-5')
  await clearPick(asPlugin($))
  expect(await getPick(asPlugin($))).toBe(null)
  expect(await read(asPlugin($), seenModelAtom)).toBe(null)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, `hooks/pick` not found.

- [ ] **Step 3: Implement `model-router/hooks/pick.ts`**

```ts
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { parseRef } from '../router/lib/schema.mjs'
import type { Pick } from '../types'
import type { RouterStatus } from './client'

// Must match router/lib/resolve.mjs.
export const ROUTED_PREFIX = 'router:'
export const FALLBACK_SEP = '#'

export const pickAtom = atom({ plugin: 'model-router', key: 'pick' } as const, null as Pick)
export const seenModelAtom = atom({ plugin: 'model-router', key: 'seenModel' } as const, null as string | null)
export const startedAtom = atom({ plugin: 'model-router', key: 'isStarted' } as const, false)

export const getPick = ($: EngineInterface) => read($, pickAtom)

export async function setPick($: EngineInterface, ref: string): Promise<void> {
  const model = await $.session.model()
  await update($, pickAtom, () => ref)
  await update($, seenModelAtom, () => model)
}

export async function clearPick($: EngineInterface): Promise<void> {
  await update($, pickAtom, () => null)
  await update($, seenModelAtom, () => null)
}

export const wireModel = (pick: string, claudeModel: string) => `${ROUTED_PREFIX}${pick}${FALLBACK_SEP}${claudeModel}`

export function providerState(status: RouterStatus | null, ref: string): 'ok' | 'paused' | 'unavailable' | 'unknown' {
  const name = parseRef(ref)?.provider
  const p = status?.providers.find(x => x.name === name)
  if (!p) return 'unknown'
  if (p.breaker === 'open') return 'paused'
  if (!p.available) return 'unavailable'
  return 'ok'
}

export const isRoutable = (status: RouterStatus | null, ref: string) => providerState(status, ref) === 'ok'
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): session pick state and the routed wire model"
```

### Task 22: Status line, toasts and the monitor timers

**Files:**
- Create: `model-router/hooks/status.ts`
- Create: `model-router/hooks/monitor.ts`
- Test: `model-router/tests/status.test.ts`

**Interfaces:**
- Consumes: `display`, `loadConfig` (Task 19); `getEvents`, `probeRouter` (Task 20); `ensureRouter` (Task 20); pick helpers (Task 21); `FAMILIES`, `allRefs`, `parseRef` (Task 5).
- Produces:
  - `DOWN_LINE = 'model-router DOWN — /router doctor'`
  - `label(ref, status): string` — `[P] m`, `[P] ⚠  paused`, `[P] ⚠  unavailable`
  - `statusLine({ pick, config, status, isDown }): string`
  - `isForSession(ev, sessionId): boolean`; `toastFor(ev): string | null`
  - `Monitor = { status: RouterStatus | null, lastSeq: number, isDown: boolean, port: number }`; `newMonitor(): Monitor`
  - `refresh($, m)`, `tick($, m)` (the 2 s body), `health($, m)` (the 10 s body)

- [ ] **Step 1: Write the failing tests**

`model-router/tests/status.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import { DOWN_LINE, isForSession, statusLine, toastFor } from '../hooks/status'
import { health, newMonitor, tick } from '../hooks/monitor'
import { getPick, setPick } from '../hooks/pick'
import { asPlugin, CONFIG, CONFIG_JSON, down, routerStatus, world } from './world'

const config = (validateConfig(CONFIG_JSON) as { ok: true; config: Config }).config
const noOverrides = { ...config, overrides: {} }
const ev = (patch: object) => ({ seq: 1, t: 't', kind: 'fallback', ...patch })

test('status line: pick and overrides, exact text', () => {
  expect(statusLine({ pick: 'DS/ds-chat', config, status: routerStatus(), isDown: false }))
    .toBe('main: [DS] ds-chat · haiku→[DS] ds-chat')
})

test('status line: nothing routed', () => {
  expect(statusLine({ pick: null, config: noOverrides, status: routerStatus(), isDown: false })).toBe('router: /router to pick')
  expect(statusLine({ pick: null, config, status: routerStatus(), isDown: false })).toBe('router: /router to pick · haiku→[DS] ds-chat')
})

test('status line: a paused provider has two spaces after the warning sign', () => {
  const paused = routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'open' }] })
  expect(statusLine({ pick: 'DS/ds-chat', config, status: paused, isDown: false })).toBe('main: [DS] ⚠  paused · haiku→[DS] ⚠  paused')
})

test('status line: an unavailable provider and a down router', () => {
  const missing = routerStatus({ providers: [{ name: 'DS', available: false, reason: 'env DS_KEY not set', breaker: 'closed' }] })
  expect(statusLine({ pick: null, config, status: missing, isDown: false })).toBe('router: /router to pick · haiku→[DS] ⚠  unavailable')
  expect(statusLine({ pick: 'DS/ds-chat', config, status: null, isDown: true })).toBe(DOWN_LINE)
  expect(DOWN_LINE).toBe('model-router DOWN — /router doctor')
})

test('toasts follow spec 7.7', () => {
  expect(toastFor(ev({ provider: 'DeepSeek', status: 429, model: 'claude-haiku-5-5', text: 'slow down' }))).toBe('[DeepSeek] 429 → used claude-haiku-5-5')
  expect(toastFor(ev({ provider: 'Kimi', status: 400, model: 'claude-opus-5-5', text: "unknown field 'thinking'" }))).toBe("[Kimi] rejected (400: unknown field 'thinking') — /router doctor")
  expect(toastFor(ev({ provider: 'DS', model: 'claude-opus-5-5', text: 'connect: ECONNREFUSED' }))).toBe('[DS] connect: ECONNREFUSED → used claude-opus-5-5')
  expect(toastFor(ev({ kind: 'learned', provider: 'DeepSeek', model: 'deepseek-chat', text: '8192' }))).toBe('[DeepSeek] max output 8192 learned')
  expect(toastFor(ev({ kind: 'breaker-open', provider: 'DS' }))).toBe('[DS] ⚠  paused for 5 min after 3 failures; requests go to Claude')
  expect(toastFor(ev({ kind: 'breaker-close', provider: 'DS' }))).toBe('[DS] resumed')
  expect(toastFor(ev({ kind: 'config-error', text: 'providers[0].baseUrl: must be a URL' }))).toBe('model-router.json: providers[0].baseUrl: must be a URL')
  for (const kind of ['provider-error', 'upstream-error', 'config-reloaded']) expect(toastFor(ev({ kind }))).toBe(null)
})

test('only this session and global events toast', () => {
  expect(isForSession(ev({ session: 's1' }), 's1')).toBe(true)
  expect(isForSession(ev({ session: 's2' }), 's1')).toBe(false)
  expect(isForSession(ev({ kind: 'breaker-open' }), 's1')).toBe(true)
})

test('tick toasts new events for this session once', async ($, on) => {
  const w = world(on)
  w.sessionId = 's1'
  w.events = [
    { seq: 1, t: 't', kind: 'learned', session: 's1', provider: 'DS', model: 'ds-chat', text: '8192' },
    { seq: 2, t: 't', kind: 'learned', session: 's2', provider: 'DS', model: 'ds-chat', text: '4096' },
  ]
  const m = newMonitor()
  await tick(asPlugin($), m)
  await tick(asPlugin($), m)
  expect(w.toasts).toEqual(['[DS] max output 8192 learned'])
  expect(m.lastSeq).toBe(2)
})

test('a restarted router (lower seq) resets the cursor without replaying', async ($, on) => {
  const w = world(on)
  const m = { ...newMonitor(), lastSeq: 50 }
  w.events = [{ seq: 1, t: 't', kind: 'breaker-open', provider: 'DS' }]
  await tick(asPlugin($), m)
  expect(m.lastSeq).toBe(1)
  expect(w.toasts).toEqual([])
})

test('a pick removed from config is cleared with a toast', async ($, on) => {
  const w = world(on)
  await setPick(asPlugin($), 'DS/ds-reasoner')
  w.files.set(CONFIG, JSON.stringify({ ...CONFIG_JSON, providers: [{ ...CONFIG_JSON.providers[0], models: [{ id: 'ds-chat' }] }] }))
  await tick(asPlugin($), newMonitor())
  expect(await getPick(asPlugin($))).toBe(null)
  expect(w.toasts).toEqual(['[DS] ds-reasoner was removed — main model back to Claude'])
})

test('a Claude model picked in the built-in picker clears the pick', async ($, on) => {
  const w = world(on)
  await setPick(asPlugin($), 'DS/ds-chat')
  w.model = 'claude-sonnet-5-5'
  await tick(asPlugin($), newMonitor())
  expect(await getPick(asPlugin($))).toBe(null)
  expect(w.toasts).toEqual(['Main model back to Claude (claude-sonnet-5-5 picked in /model)'])
  expect(w.statusLines.at(-1)).toBe('router: /router to pick · haiku→[DS] ds-chat')
})

test('health respawns a dead router and says so; a failed respawn shows DOWN', async ($, on) => {
  const w = world(on)
  const m = newMonitor()
  down(w)
  await health(asPlugin($), m)
  expect(w.toasts).toEqual(['model-router restarted'])
  expect(m.isDown).toBe(false)
  down(w)
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'boom' } : undefined)
  await health(asPlugin($), m)
  expect(m.isDown).toBe(true)
  expect(w.statusLines.at(-1)).toBe('model-router DOWN — /router doctor')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `model-router/hooks/status.ts`**

```ts
import { FAMILIES, parseRef } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { RouterEvent, RouterStatus } from './client'
import { display } from './config'
import { providerState } from './pick'

export const DOWN_LINE = 'model-router DOWN — /router doctor'

export function label(ref: string, status: RouterStatus | null): string {
  const provider = parseRef(ref)?.provider ?? ref
  switch (providerState(status, ref)) {
    case 'paused': return `[${provider}] ⚠  paused`
    case 'unavailable': return `[${provider}] ⚠  unavailable`
    default: return display(ref)
  }
}

export function statusLine({ pick, config, status, isDown }: { pick: string | null; config: Config; status: RouterStatus | null; isDown: boolean }): string {
  if (isDown) return DOWN_LINE
  const parts = [pick ? `main: ${label(pick, status)}` : 'router: /router to pick']
  for (const family of FAMILIES) {
    const ref = config.overrides[family]
    if (ref) parts.push(`${family}→${label(ref, status)}`)
  }
  return parts.join(' · ')
}

export const isForSession = (ev: RouterEvent, sessionId: string) => ev.session === undefined || ev.session === sessionId

export function toastFor(ev: RouterEvent): string | null {
  const p = `[${ev.provider ?? '?'}]`
  switch (ev.kind) {
    case 'fallback':
      if (ev.status === 400 && ev.text) return `${p} rejected (400: ${ev.text}) — /router doctor`
      if (ev.status !== undefined) return `${p} ${ev.status} → used ${ev.model}`
      return `${p} ${ev.text ?? 'failed'} → used ${ev.model}`
    case 'learned': return `${p} max output ${ev.text} learned`
    case 'breaker-open': return `${p} ⚠  paused for 5 min after 3 failures; requests go to Claude`
    case 'breaker-close': return `${p} resumed`
    case 'config-error': return `model-router.json: ${ev.text}`
    default: return null
  }
}
```

- [ ] **Step 4: Implement `model-router/hooks/monitor.ts`**

```ts
import { read } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { allRefs } from '../router/lib/schema.mjs'
import { getEvents, probeRouter } from './client'
import type { RouterStatus } from './client'
import { display, loadConfig } from './config'
import { ensureRouter } from './lifecycle'
import { getPaths } from './paths'
import { clearPick, getPick, seenModelAtom } from './pick'
import { isForSession, statusLine, toastFor } from './status'

export type Monitor = { status: RouterStatus | null; lastSeq: number; isDown: boolean; port: number }

export const newMonitor = (): Monitor => ({ status: null, lastSeq: 0, isDown: false, port: 4141 })

export async function refresh($: EngineInterface, m: Monitor): Promise<void> {
  const { config } = await loadConfig($, await getPaths($))
  $.ui.status(statusLine({ pick: await getPick($), config, status: m.status, isDown: m.isDown }))
}

// Every 2 s: this session's events as toasts, and the pick's validity.
export async function tick($: EngineInterface, m: Monitor): Promise<void> {
  const sessionId = await $.session.id()
  const r = await getEvents($, m.port, m.lastSeq)
  if (r) {
    if (r.lastSeq < m.lastSeq) m.lastSeq = r.lastSeq
    else for (const ev of r.events) {
      m.lastSeq = Math.max(m.lastSeq, ev.seq)
      const text = isForSession(ev, sessionId) ? toastFor(ev) : null
      if (text) $.ui.toast(text)
    }
  }
  const pick = await getPick($)
  if (pick !== null) {
    const { config } = await loadConfig($, await getPaths($))
    const seen = await read($, seenModelAtom)
    const model = await $.session.model()
    if (!allRefs(config).includes(pick)) {
      await clearPick($)
      $.ui.toast(`${display(pick)} was removed — main model back to Claude`)
    } else if (seen !== null && model !== seen) {
      await clearPick($)
      $.ui.toast(`Main model back to Claude (${model} picked in /model)`)
    }
  }
  await refresh($, m)
}

// Every 10 s: the router's health; respawn it when it is gone.
export async function health($: EngineInterface, m: Monitor): Promise<void> {
  const { config } = await loadConfig($, await getPaths($))
  m.port = config.port
  const probe = await probeRouter($, m.port)
  if (probe.kind === 'ours') {
    m.status = probe.status
    m.isDown = false
  } else {
    const ensured = await ensureRouter($, m.port)
    if (ensured.ok) {
      m.status = ensured.status
      m.lastSeq = ensured.status.eventsSeq
      m.isDown = false
      $.ui.toast('model-router restarted')
    } else {
      m.status = null
      m.isDown = true
    }
  }
  await refresh($, m)
}
```

- [ ] **Step 5: Run the checks**

Run the three Phase 2 checks. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): status line, event toasts and the monitor timers"
```

### Task 23: `register.tsx` — session start, timers, `turn.step`

**Files:**
- Modify: `model-router/hooks/register.tsx` (replace the stub)
- Test: `model-router/tests/mod.test.ts`

**Interfaces:**
- Consumes: Tasks 18–22.
- Produces: the hooks module. `session.start` registers `/router`, ensures the router, applies `defaultMainModel` once per session (not again on hot reload), sets the status line and starts the 2 s/10 s timers. `turn.step` rewrites only main-loop steps (no `agentId`) when a pick is set and routable. Tasks 24–29 add their `on(...)` lines to this file.

- [ ] **Step 1: Write the failing tests**

`model-router/tests/mod.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { getPick } from '../hooks/pick'
import { asPlugin, CONFIG_JSON, down, routerStatus, start, up, world } from './world'

const step = ($: Engine, patch: { model?: string; agentId?: string } = {}) =>
  $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...patch }).result

test('session start registers /router, finds the router and draws the status line', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered).toContain('router')
  expect(w.runs.length).toBe(0)
  expect(w.statusLines.at(-1)).toBe('router: /router to pick · haiku→[DS] ds-chat')
})

test('session start launches a missing router; a failed launch shows DOWN', async ($, on) => {
  const w = world(on, { isRouterUp: false })
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'node not found' } : undefined)
  await start($)
  expect(w.statusLines.at(-1)).toBe('model-router DOWN — /router doctor')
})

test('defaultMainModel becomes the pick once, not again after a reload', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-reasoner' } })
  await start($)
  expect(await getPick(asPlugin($))).toBe('DS/ds-reasoner')
  await $.command.run({ command: 'router', args: 'claude', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await start($)
  expect(await getPick(asPlugin($))).toBe(null)
  expect(w.statusLines.at(-1)).toBe('router: /router to pick · haiku→[DS] ds-chat')
})

test('turn.step: no pick leaves the model alone', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  expect(w.stepModels).toEqual(['claude-opus-5-5'])
})

test('turn.step: a pick rewrites main-loop steps only', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  await start($)
  await step($)
  await step($, { agentId: 'agent-1', model: 'claude-haiku-5-5' })
  await step($, { model: 'router:DS/ds-chat#claude-opus-5-5' })
  expect(w.stepModels).toEqual(['router:DS/ds-chat#claude-opus-5-5', 'claude-haiku-5-5', 'router:DS/ds-chat#claude-opus-5-5'])
})

test('turn.step: a paused or missing provider is not rewritten', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  up(w, routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'open' }] }))
  await start($)
  await step($)
  expect(w.stepModels).toEqual(['claude-opus-5-5'])
})

test('the 10 s health timer respawns the router', async ($, on) => {
  const w = world(on)
  await start($)
  down(w)
  await w.clock.advance(10_000)
  expect(w.toasts).toContain('model-router restarted')
})
```

The third test calls `/router claude`, which Task 29 implements; until then it fails on that line only. That is expected: leave it failing until Task 29, and say so in this task's commit message.

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL (the stub registers nothing).

- [ ] **Step 3: Implement `model-router/hooks/register.tsx`**

```tsx
import { read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { loadConfig } from './config'
import { ensureRouter } from './lifecycle'
import { health, newMonitor, refresh, tick } from './monitor'
import { getPaths } from './paths'
import { getPick, isRoutable, ROUTED_PREFIX, setPick, startedAtom, wireModel } from './pick'

export const register: Register = on => {
  const m = newMonitor()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Pick, override and manage models from other providers (model-router)',
      argumentHint: '[model|claude|default|override|add|remove|setup|uninstall|doctor|forget|restart]',
    })
    const { config } = await loadConfig($, await getPaths($))
    m.port = config.port
    const ensured = await ensureRouter($, m.port)
    if (ensured.ok) {
      m.status = ensured.status
      m.lastSeq = ensured.status.eventsSeq
      m.isDown = false
    } else {
      m.isDown = true
      $.ui.log(`model-router: ${ensured.reason}`, { to: 'debug' })
    }
    // $.state outlives a hot reload; the default applies once per session.
    if (!(await read($, startedAtom))) {
      await update($, startedAtom, () => true)
      if (config.defaultMainModel) await setPick($, config.defaultMainModel)
    }
    await refresh($, m)
    $.clock.every(2_000, () => void tick($, m))
    $.clock.every(10_000, () => void health($, m))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const pick = await getPick($)
    if (e.agentId !== undefined || pick === null || e.model.startsWith(ROUTED_PREFIX) || !isRoutable(m.status, pick)) return yield* next(e)
    return yield* next({ ...e, model: wireModel(pick, e.model) })
  })
}
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass except the `/router claude` line of the defaultMainModel test.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): session start, monitor timers and turn.step routing (one test waits for /router, Task 29)"
```

### Task 24: The unified picker pane

**Files:**
- Create: `model-router/hooks/picker.tsx`
- Modify: `model-router/hooks/register.tsx` (register the pane's render hook)
- Test: `model-router/tests/picker.test.tsx`

**Interfaces:**
- Consumes: `loadConfig`, `updateConfig`, `display` (Task 19); pick helpers (Task 21); `Monitor`, `refresh` (Task 22); `FAMILIES`, `allRefs`, `parseRef` (Task 5).
- Produces:
  - `PICKER_PANE = 'model-router-picker'`, `pickerAtom`
  - `pickerEntries({ mode, config, status, sessionModel, pick }): PickerEntry[]` — values `claude:<model|alias>`, `routed:<ref>`, `builtin`, and in router mode `action:default|override|add|doctor`
  - `openPicker($, m, mode): Promise<CommandRunResult>` (returns `{}`)
  - `choose($, m, value): Promise<void>`
  - `registerPicker(on, m): void`

- [ ] **Step 1: Write the failing tests**

`model-router/tests/picker.test.tsx`:

```tsx
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { read } from 'claude-code'
import type { On } from 'claude-code'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import { choose, openPicker, PICKER_PANE, pickerAtom, pickerEntries } from '../hooks/picker'
import { newMonitor } from '../hooks/monitor'
import { getPick, setPick } from '../hooks/pick'
import { asPlugin, CONFIG, PANE_PROPS, CONFIG_JSON, readJson, routerStatus, start, world } from './world'

const config = (validateConfig(CONFIG_JSON) as { ok: true; config: Config }).config
const labels = (mode: 'model' | 'router', status = routerStatus(), pick: string | null = null) =>
  pickerEntries({ mode, config, status, sessionModel: 'claude-opus-5-5', pick }).map(e => e.label)

test('model mode lists Claude, each provider model, and the built-in picker', () => {
  expect(labels('model')).toEqual([
    'Claude · claude-opus-5-5 (current)',
    'Claude · opus',
    'Claude · sonnet',
    'Claude · haiku → [DS] ds-chat',
    'Claude · fable',
    '[DS] ds-chat',
    '[DS] ds-reasoner',
    '[OR] anthropic/claude-x',
    '[OR] ds-chat',
    "Claude Code's picker…",
  ])
})

test('router mode adds the management actions; model mode never does', () => {
  expect(labels('router').slice(-4)).toEqual([
    'Set the current pick as default for new sessions', 'Override a Claude family…', 'Add a provider…', 'Doctor',
  ])
  expect(labels('model').some(l => l.startsWith('Override'))).toBe(false)
})

test('the current pick, a paused and an unavailable provider are marked', () => {
  const s = routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'open' }, { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' }] })
  const all = labels('model', s, 'DS/ds-chat')
  expect(all[0]).toBe('Claude · claude-opus-5-5')
  expect(all).toContain('[DS] ds-chat (current) — ⚠  paused')
  expect(all).toContain('[OR] ds-chat — unavailable: env OR_KEY not set')
})

async function opened($: Engine, on: On, mode: 'model' | 'router' = 'model') {
  const w = world(on)
  await start($)
  const m = { ...newMonitor(), status: routerStatus() }
  await openPicker(asPlugin($), m, mode)
  return { w, m }
}

test('picking a routed model sets the pick and closes the pane', async ($, on) => {
  const { w, m } = await opened($, on)
  expect(w.opened).toEqual([PICKER_PANE])
  await choose(asPlugin($), m, 'routed:OR/anthropic/claude-x')
  expect(await getPick(asPlugin($))).toBe('OR/anthropic/claude-x')
  expect(w.closed).toEqual([PICKER_PANE])
  expect(w.toasts).toEqual(['Main model: [OR] anthropic/claude-x'])
})

test('picking a Claude alias clears the pick and runs the built-in /model with it', async ($, on) => {
  const { w, m } = await opened($, on)
  await setPick(asPlugin($), 'DS/ds-chat')
  await choose(asPlugin($), m, 'claude:sonnet')
  expect(await getPick(asPlugin($))).toBe(null)
  expect(w.commands).toEqual([{ command: 'model', args: 'sonnet', origin: 'plugin' }])
})

test("Claude Code's picker entry runs the built-in /model bare", async ($, on) => {
  const { w, m } = await opened($, on)
  await choose(asPlugin($), m, 'builtin')
  expect(w.commands).toEqual([{ command: 'model', args: '', origin: 'plugin' }])
})

test('an unavailable entry explains itself and keeps the pane open', async ($, on) => {
  const w = world(on)
  await start($)
  const m = { ...newMonitor(), status: routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'closed' }, { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' }] }) }
  await openPicker(asPlugin($), m, 'model')
  await choose(asPlugin($), m, 'routed:OR/ds-chat')
  expect(w.toasts).toEqual(['[OR] ds-chat is unavailable: env OR_KEY not set'])
  expect(w.closed).toEqual([])
  expect(await getPick(asPlugin($))).toBe(null)
})

test('override flow: family, then target, writes the config', async ($, on) => {
  const { w, m } = await opened($, on, 'router')
  await choose(asPlugin($), m, 'action:override')
  expect((await read(asPlugin($), pickerAtom))!.view).toEqual({ kind: 'family' })
  await choose(asPlugin($), m, 'family:sonnet')
  await choose(asPlugin($), m, 'target:OR/anthropic/claude-x')
  expect(readJson(w, CONFIG).overrides).toEqual({ haiku: 'DS/ds-chat', sonnet: 'OR/anthropic/claude-x' })
  expect(w.toasts.at(-1)).toBe('sonnet → [OR] anthropic/claude-x (all sessions, from the next request)')
})

test('the pane draws a Select on every surface that has one', async ($, on) => {
  await opened($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = await $.ui.render({ surface, component: 'Pane', requestId: PICKER_PANE, props: { ...PANE_PROPS } })
    const text = JSON.stringify(tree)
    expect(text).toContain('[DS] ds-chat')
    expect(text).toContain('manage: /router')
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, `hooks/picker` not found.

- [ ] **Step 3: Implement `model-router/hooks/picker.tsx`**

```tsx
import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, On } from 'claude-code'
import { allRefs, FAMILIES } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { PickerEntry, PickerState } from '../types'
import type { RouterStatus } from './client'
import { display, loadConfig, updateConfig } from './config'
import { refresh } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { clearPick, getPick, providerState, setPick } from './pick'

export const PICKER_PANE = 'model-router-picker'
export const pickerAtom = atom({ plugin: 'model-router', key: 'picker' } as const, null as PickerState)

type EntriesInput = { mode: 'model' | 'router'; config: Config; status: RouterStatus | null; sessionModel: string; pick: string | null }

export function pickerEntries({ mode, config, status, sessionModel, pick }: EntriesInput): PickerEntry[] {
  const entries: PickerEntry[] = [{ value: `claude:${sessionModel}`, label: `Claude · ${sessionModel}${pick === null ? ' (current)' : ''}` }]
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable'] as const) {
    const ref = config.overrides[alias]
    entries.push({ value: `claude:${alias}`, label: `Claude · ${alias}${ref ? ` → ${display(ref)}` : ''}` })
  }
  for (const ref of allRefs(config)) {
    const state = providerState(status, ref)
    const reason = status?.providers.find(p => ref.startsWith(`${p.name}/`))?.reason ?? 'not available'
    const current = ref === pick ? ' (current)' : ''
    if (state === 'unavailable') entries.push({ value: `routed:${ref}`, label: `${display(ref)}${current} — unavailable: ${reason}`, disabledReason: `${display(ref)} is unavailable: ${reason}` })
    else entries.push({ value: `routed:${ref}`, label: `${display(ref)}${current}${state === 'paused' ? ' — ⚠  paused' : ''}` })
  }
  entries.push({ value: 'builtin', label: "Claude Code's picker…" })
  if (mode === 'router') entries.push(
    { value: 'action:default', label: 'Set the current pick as default for new sessions' },
    { value: 'action:override', label: 'Override a Claude family…' },
    { value: 'action:add', label: 'Add a provider…' },
    { value: 'action:doctor', label: 'Doctor' },
  )
  return entries
}

const familyEntries = (config: Config): PickerEntry[] =>
  FAMILIES.map(f => ({ value: `family:${f}`, label: `${f} (now ${config.overrides[f] ? display(config.overrides[f]!) : 'Claude'})` }))

const targetEntries = (config: Config): PickerEntry[] => [
  { value: 'target:clear', label: 'Claude (clear the override)' },
  ...allRefs(config).map(ref => ({ value: `target:${ref}`, label: display(ref) })),
]

export async function openPicker($: EngineInterface, m: Monitor, mode: 'model' | 'router'): Promise<CommandRunResult> {
  const { config } = await loadConfig($, await getPaths($))
  const entries = pickerEntries({ mode, config, status: m.status, sessionModel: await $.session.model(), pick: await getPick($) })
  await update($, pickerAtom, () => ({ mode, view: { kind: 'main' }, entries }))
  await $.ui.open({ id: PICKER_PANE, title: mode === 'model' ? 'Model' : 'model-router', focus: true, closeOnEscape: true })
  return {}
}

async function closePicker($: EngineInterface): Promise<void> {
  await update($, pickerAtom, () => null)
  await $.ui.close({ id: PICKER_PANE })
}

const runCommand = ($: EngineInterface, command: string, args = '') =>
  $.command.run({ command, args }).catch((err: unknown) => $.ui.toast(`/${command} ${args}: ${String(err)}`))

export async function choose($: EngineInterface, m: Monitor, value: string): Promise<void> {
  const state = await read($, pickerAtom)
  if (!state) return
  const entry = state.entries.find(e => e.value === value)
  if (entry?.disabledReason) { $.ui.toast(entry.disabledReason); return }
  const cut = value.indexOf(':')
  const kind = cut === -1 ? value : value.slice(0, cut)
  const rest = cut === -1 ? '' : value.slice(cut + 1)
  const paths = await getPaths($)

  switch (kind) {
    case 'claude': {
      await clearPick($)
      await closePicker($)
      await refresh($, m)
      if (rest !== (await $.session.model())) await runCommand($, 'model', rest)
      return
    }
    case 'routed': {
      await setPick($, rest)
      await closePicker($)
      await refresh($, m)
      $.ui.toast(`Main model: ${display(rest)}`)
      return
    }
    case 'builtin': {
      await closePicker($)
      await runCommand($, 'model')
      return
    }
    case 'action': {
      if (rest === 'default') {
        const pick = await getPick($)
        if (pick === null) { $.ui.toast('Pick a routed model first, then set it as the default'); return }
        const r = await updateConfig($, paths, raw => { raw.defaultMainModel = pick })
        $.ui.toast(r.ok ? `Default main model for new sessions: ${display(pick)}` : r.message)
        await closePicker($)
        return
      }
      if (rest === 'override') {
        const { config } = await loadConfig($, paths)
        await update($, pickerAtom, s => s && { ...s, view: { kind: 'family' }, entries: familyEntries(config) })
        return
      }
      await closePicker($)
      await runCommand($, 'router', rest === 'add' ? 'add' : 'doctor')
      return
    }
    case 'family': {
      const { config } = await loadConfig($, paths)
      await update($, pickerAtom, s => s && { ...s, view: { kind: 'target', family: rest }, entries: targetEntries(config) })
      return
    }
    case 'target': {
      if (state.view.kind !== 'target') return
      const family = state.view.family
      const r = await updateConfig($, paths, raw => {
        const overrides = { ...(raw.overrides ?? {}) }
        if (rest === 'clear') delete overrides[family]
        else overrides[family] = rest
        raw.overrides = overrides
      })
      $.ui.toast(r.ok ? `${family} → ${rest === 'clear' ? 'Claude' : display(rest)} (all sessions, from the next request)` : r.message)
      await closePicker($)
      await refresh($, m)
      return
    }
  }
}

export function registerPicker(on: On, m: Monitor): void {
  on('ui.render', { component: 'Pane', requestId: PICKER_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const state = await read($, pickerAtom)
    if (!('Select' in elements)) {
      const { Text } = elements
      return <Text>Use /router Provider/model on this surface.</Text>
    }
    const { Box, Text, Select } = elements
    if (!state) return <Text dimColor>Nothing to pick. Run /model or /router.</Text>
    const heading = state.view.kind === 'family' ? 'Override which Claude family?'
      : state.view.kind === 'target' ? `Send ${state.view.family} requests to:`
      : state.mode === 'model' ? 'Main model for this session' : 'model-router'
    return (
      <Box flexDirection="column">
        <Text>{heading}</Text>
        <Select key="picker" autoFocus options={state.entries.map(({ value, label }) => ({ value, label }))} onSelect={value => void choose($, m, value)} />
        {state.mode === 'model' && state.view.kind === 'main' ? <Text dimColor>manage: /router</Text> : null}
      </Box>
    )
  })
}
```

In `register.tsx`, add `import { registerPicker } from './picker'` and, after `const m = newMonitor()`, the line `registerPicker(on, m)`.

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass (except the one `/router claude` line from Task 23). If `tsc` rejects `'Select' in elements`, narrow on `e.surface === 'mobile'` instead, whichever the types allow.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): unified picker pane with override flow"
```

### Task 25: Taking over `/model` (spec §7.5, D15, D16)

**Files:**
- Modify: `model-router/hooks/register.tsx`
- Test: `model-router/tests/model-command.test.ts`

**Interfaces:**
- Consumes: `openPicker` (Task 24); `loadConfig`, `findModel`, `display`, `ambiguousText` (Task 19); `setPick`, `clearPick` (Task 21); `refresh` (Task 22); `userConfig.takeOverModelCommand` (Task 18).
- Produces: a `command.run` hook on the built-in `model`, guarded with `.catch(($, e, next) => next(e))`:

| Toggle | Input | Behaviour |
|---|---|---|
| on | `/model` | unified picker pane (model mode) |
| on/off | `/model <routed name>` | set the pick; text `Main model: [P] m` (off adds `\ntip: use /router`) |
| on/off | `/model <ambiguous bare id>` | the candidates list |
| on/off | `/model <anything else>` | clear the pick, then `next(e)` |
| off | `/model` | `next(e)` |
| any | origin is model-router itself | `next(e)` (the picker's own "Claude Code's picker…" and alias runs) |

- [ ] **Step 1: Write the failing tests**

`model-router/tests/model-command.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { PICKER_PANE } from '../hooks/picker'
import { getPick, setPick } from '../hooks/pick'
import { ambiguousText } from '../hooks/config'
import { asPlugin, run, start, world } from './world'

const OFF = { options: { takeOverModelCommand: false } }
const fromPlugin = ($: Engine, args: string) =>
  $.command.run({ command: 'model', args, origin: { kind: 'plugin', name: 'model-router' }, presentation: { isFullscreen: false, columns: 120 } })

test('on: bare /model opens the unified picker, not the built-in one', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'model')
  expect(w.opened).toEqual([PICKER_PANE])
  expect(w.commands).toEqual([])
})

test('on: /model <routed name> sets the pick', async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'model', 'DS/ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner')
  expect(await getPick(asPlugin($))).toBe('DS/ds-reasoner')
})

test('on: an ambiguous bare id lists the candidates', async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'model', 'ds-chat')).text).toBe(ambiguousText('ds-chat', ['DS/ds-chat', 'OR/ds-chat']))
})

test('on: anything else clears the pick and reaches the built-in /model', async ($, on) => {
  const w = world(on)
  await start($)
  await setPick(asPlugin($), 'DS/ds-chat')
  expect((await run($, 'model', 'sonnet')).text).toBe('built-in /model sonnet')
  expect(w.commands).toEqual([{ command: 'model', args: 'sonnet', origin: 'composer' }])
  expect(await getPick(asPlugin($))).toBe(null)
})

test('runs that model-router makes itself go straight to the built-in /model', async ($, on) => {
  const w = world(on)
  await start($)
  await fromPlugin($, '')
  expect(w.commands).toEqual([{ command: 'model', args: '', origin: 'plugin' }])
  expect(w.opened).toEqual([])
})

test('off: bare /model is the stock one', OFF, async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'model')
  expect(w.commands).toEqual([{ command: 'model', args: '', origin: 'composer' }])
  expect(w.opened).toEqual([])
})

test('off: /model <routed name> still switches, with a tip', OFF, async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'model', 'DS/ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner\ntip: use /router')
})

test('a failing hook falls back to the built-in /model', async ($, on) => {
  const w = world(on)
  await start($)
  w.failSessionModel = true
  await run($, 'model', 'DS/ds-reasoner')
  expect(w.commands).toEqual([{ command: 'model', args: 'DS/ds-reasoner', origin: 'composer' }])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL (nothing hooks `model` yet).

- [ ] **Step 3: Implement**

In `model-router/hooks/register.tsx`:
1. Change the signature to `export const register: Register = (on, options) => {` and add, after `const m = newMonitor()`:

```tsx
  const takeOver = options.takeOverModelCommand !== false
```

2. Add these imports:

```tsx
import { ambiguousText, display, findModel, loadConfig } from './config'
import { openPicker, registerPicker } from './picker'
import { clearPick, getPick, isRoutable, ROUTED_PREFIX, setPick, startedAtom, wireModel } from './pick'
```

(merge them with the existing import lines from the same modules).

3. Add the hook after the `turn.step` hook:

```tsx
  // The built-in /model, taken over (D15). A bug here must never break /model,
  // so the .catch hands the command to the built-in one.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'model-router') return next(e)
    const args = e.args.trim()
    if (args === '') return takeOver ? openPicker($, m, 'model') : next(e)
    const { config } = await loadConfig($, await getPaths($))
    const match = findModel(config, args)
    if (match.kind === 'one') {
      await setPick($, match.ref)
      await refresh($, m)
      return { text: `Main model: ${display(match.ref)}${takeOver ? '' : '\ntip: use /router'}` }
    }
    if (match.kind === 'ambiguous') return { text: ambiguousText(args, match.refs) }
    await clearPick($)
    const result = await next(e)
    await refresh($, m)
    return result
  }).catch(($, e, next) => next(e))
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass (except the one `/router claude` line from Task 23). `claude plugin validate` lists this hook as a gating hook **with** `.catch`.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): take over /model with a .catch fallback to the built-in"
```

### Task 26: The `/router add` wizard

**Files:**
- Create: `model-router/hooks/add.tsx`
- Modify: `model-router/hooks/register.tsx` (register the pane)
- Test: `model-router/tests/add.test.tsx`

**Interfaces:**
- Consumes: `checkBaseUrl` (Task 5); `loadConfig`, `updateConfig`, `RawProvider` (Task 19); `runTool`, `ToolOut` (Task 18); `launch.mjs probe` (Task 17); `refresh`, `Monitor` (Task 22).
- Produces:
  - `ADD_PANE = 'model-router-add'`, `wizardAtom`
  - `openWizard($): Promise<CommandRunResult>`
  - `submitStep($, value)`; `finishWizard($, m, choice: 'save' | 'cancel' | string)`
  - `providerOf(state): RawProvider` — upper-case `[A-Z_][A-Z0-9_]*` is an `apiKeyEnv`, anything else a literal `apiKey`
  - `probeSummary(out, model): string`
  - `registerWizard(on, m)`
  - Element keys: `add-name`, `add-baseUrl`, `add-key`, `add-models` (Inputs), `add-finish` (Select: `save` / `cancel`)

- [ ] **Step 1: Write the failing tests**

`model-router/tests/add.test.tsx`:

```tsx
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { read } from 'claude-code'
import { ADD_PANE, openWizard, probeSummary, wizardAtom } from '../hooks/add'
import { asPlugin, CONFIG, PANE_PROPS, readJson, start, world } from './world'

const draw = ($: Engine) => $.ui.render({ surface: 'terminal', component: 'Pane', requestId: ADD_PANE, props: { ...PANE_PROPS } })
const enter = async ($: Engine, key: string, text: string) => { await draw($); await $.ui.input({ plugin: 'model-router', key, text }) }
const message = async ($: Engine) => (await read(asPlugin($), wizardAtom))?.message

test('the wizard walks name, URL, key, models, test call, and saves', async ($, on) => {
  const w = world(on)
  await start($)
  await openWizard(asPlugin($))
  expect(w.opened).toEqual([ADD_PANE])
  await enter($, 'add-name', 'Kimi')
  await enter($, 'add-baseUrl', 'https://api.moonshot.ai/anthropic/')
  await enter($, 'add-key', 'KIMI_API_KEY')
  w.tool = sub => (sub === 'probe' ? { ok: true, status: 200, learnedMaxTokens: 8192 } : undefined)
  await enter($, 'add-models', 'kimi-k2, kimi-k2-turbo')
  expect(JSON.parse(w.runs.at(-1)!.stdin!)).toEqual({
    mode: 'provider',
    provider: { name: 'Kimi', baseUrl: 'https://api.moonshot.ai/anthropic', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'kimi-k2' }, { id: 'kimi-k2-turbo' }] },
    model: 'kimi-k2',
  })
  expect(await message($)).toBe('✓ kimi-k2 answered (max output 8192 learned).')
  await draw($)
  await $.ui.select({ plugin: 'model-router', key: 'add-finish', value: 'save' })
  expect(readJson(w, CONFIG).providers.at(-1)).toEqual({ name: 'Kimi', baseUrl: 'https://api.moonshot.ai/anthropic', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'kimi-k2' }, { id: 'kimi-k2-turbo' }] })
  expect(w.closed).toEqual([ADD_PANE])
  expect(w.toasts.at(-1)).toBe('Added [Kimi] with 2 models. Pick one: /model Kimi/kimi-k2')
})

test('bad input stays on its step with a message', async ($, on) => {
  world(on)
  await start($)
  await openWizard(asPlugin($))
  await enter($, 'add-name', 'Deep Seek')
  expect(await message($)).toBe('Use letters, digits, ".", "_" or "-".')
  await enter($, 'add-name', 'DS')
  expect(await message($)).toBe('"DS" exists already. Remove it first: /router remove DS')
  await enter($, 'add-name', 'New')
  await enter($, 'add-baseUrl', 'http://api.example')
  expect(await message($)).toBe('The URL must be https (or http on 127.0.0.1/localhost).')
  expect((await read(asPlugin($), wizardAtom))!.step).toBe('baseUrl')
})

test('a literal key is allowed with a warning and saved as apiKey', async ($, on) => {
  const w = world(on)
  await start($)
  await openWizard(asPlugin($))
  await enter($, 'add-name', 'Lit')
  await enter($, 'add-baseUrl', 'https://lit.example')
  await enter($, 'add-key', 'sk-literal-123')
  expect(await message($)).toBe('Warning: a literal key is saved in model-router.json. An environment variable is safer.')
  await enter($, 'add-models', 'm1')
  await draw($)
  await $.ui.select({ plugin: 'model-router', key: 'add-finish', value: 'save' })
  expect(readJson(w, CONFIG).providers.at(-1)).toEqual({ name: 'Lit', baseUrl: 'https://lit.example', apiKey: 'sk-literal-123', models: [{ id: 'm1' }] })
})

test('cancel writes nothing', async ($, on) => {
  const w = world(on)
  await start($)
  const before = w.files.get(CONFIG)
  await openWizard(asPlugin($))
  await enter($, 'add-name', 'Gone')
  await enter($, 'add-baseUrl', 'https://gone.example')
  await enter($, 'add-key', 'GONE_KEY')
  w.tool = sub => (sub === 'probe' ? { ok: false, kind: 'no-key', text: 'env GONE_KEY not set' } : undefined)
  await enter($, 'add-models', 'g1')
  expect(JSON.stringify(await draw($))).toContain('Save anyway')
  await $.ui.select({ plugin: 'model-router', key: 'add-finish', value: 'cancel' })
  expect(w.files.get(CONFIG)).toBe(before)
  expect(w.closed).toEqual([ADD_PANE])
})

test('probe results read as advice', () => {
  expect(probeSummary({ ok: false, kind: 'http', status: 400, text: "unknown field 'thinking'" }, 'm')).toBe(`✗ rejected (400: unknown field 'thinking'). After saving, add the rejected field to "strip" for this provider.`)
  expect(probeSummary({ ok: false, kind: 'tls', text: 'tls: SELF_SIGNED_CERT_IN_CHAIN' }, 'm')).toBe('✗ certificate not trusted (tls: SELF_SIGNED_CERT_IN_CHAIN). See /router doctor.')
  expect(probeSummary({ ok: false, kind: 'connect', text: 'connect: ENOTFOUND' }, 'm')).toBe('✗ connect: ENOTFOUND')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, `hooks/add` not found.

- [ ] **Step 3: Implement `model-router/hooks/add.tsx`**

```tsx
import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, On } from 'claude-code'
import { checkBaseUrl } from '../router/lib/schema.mjs'
import type { WizardState, WizardStep } from '../types'
import { loadConfig, updateConfig } from './config'
import type { RawProvider } from './config'
import { runTool } from './host'
import type { ToolOut } from './host'
import { refresh } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'

export const ADD_PANE = 'model-router-add'
export const wizardAtom = atom({ plugin: 'model-router', key: 'wizard' } as const, null as WizardState)

type Draft = NonNullable<WizardState>

const PROMPTS: Record<Exclude<WizardStep, 'test'>, string> = {
  name: 'Provider name (letters, digits, . _ -), e.g. DeepSeek',
  baseUrl: 'Base URL of its Anthropic-compatible API, e.g. https://api.deepseek.com/anthropic',
  key: 'Environment variable that holds the API key (e.g. DEEPSEEK_API_KEY), or the key itself',
  models: 'Model IDs, separated by commas or spaces',
}

const isEnvName = (value: string) => /^[A-Z_][A-Z0-9_]*$/.test(value)
const modelIds = (text: string) => text.split(/[\s,]+/).filter(Boolean)

export function providerOf(d: Draft): RawProvider {
  return {
    name: d.name,
    baseUrl: d.baseUrl,
    ...(isEnvName(d.key) ? { apiKeyEnv: d.key } : { apiKey: d.key }),
    models: modelIds(d.models).map(id => ({ id })),
  }
}

export function probeSummary(out: ToolOut, model: string): string {
  const learned = typeof out.learnedMaxTokens === 'number' ? ` (max output ${out.learnedMaxTokens} learned)` : ''
  if (out.ok === true) return `✓ ${model} answered${learned}.`
  const text = String(out.text ?? out.error ?? 'failed')
  switch (out.kind) {
    case 'no-key': return `✗ ${text}. Set it (for example in ~/.claude/settings.json "env"), restart Claude Code, then /router restart.`
    case 'http': return out.status === 400
      ? `✗ rejected (400: ${text}). After saving, add the rejected field to "strip" for this provider.`
      : `✗ HTTP ${String(out.status)}: ${text}`
    case 'tls': return `✗ certificate not trusted (${text}). See /router doctor.`
    default: return `✗ ${text}`
  }
}

export async function openWizard($: EngineInterface): Promise<CommandRunResult> {
  await update($, wizardAtom, () => ({ step: 'name', name: '', baseUrl: '', key: '', models: '', message: '', isProbeOk: false }))
  await $.ui.open({ id: ADD_PANE, title: 'Add provider', focus: true, closeOnEscape: true })
  return {}
}

export async function submitStep($: EngineInterface, value: string): Promise<void> {
  const draft = await read($, wizardAtom)
  if (!draft) return
  const v = value.trim()
  const set = async (patch: Partial<Draft>) => { await update($, wizardAtom, s => (s ? { ...s, ...patch } : s)) }
  switch (draft.step) {
    case 'name': {
      if (!/^[A-Za-z0-9._-]+$/.test(v)) return set({ message: 'Use letters, digits, ".", "_" or "-".' })
      const { config } = await loadConfig($, await getPaths($))
      if (config.providers.some(p => p.name === v)) return set({ message: `"${v}" exists already. Remove it first: /router remove ${v}` })
      return set({ step: 'baseUrl', name: v, message: '' })
    }
    case 'baseUrl': {
      const bad = checkBaseUrl(v)
      return bad ? set({ message: `The URL ${bad}.` }) : set({ step: 'key', baseUrl: v.replace(/\/+$/, ''), message: '' })
    }
    case 'key':
      if (v === '') return set({ message: 'Enter a variable name or a key.' })
      return set({ step: 'models', key: v, message: isEnvName(v) ? '' : 'Warning: a literal key is saved in model-router.json. An environment variable is safer.' })
    case 'models': {
      const ids = modelIds(v)
      if (ids.length === 0) return set({ message: 'Enter at least one model ID.' })
      const next: Draft = { ...draft, models: ids.join(',') }
      await set({ step: 'test', models: next.models, message: `Testing ${ids[0]}…` })
      const out = await runTool($, ['probe'], { stdin: JSON.stringify({ mode: 'provider', provider: providerOf(next), model: ids[0] }), timeoutMs: 90_000 })
      return set({ message: probeSummary(out, ids[0]!), isProbeOk: out.ok === true })
    }
  }
}

export async function finishWizard($: EngineInterface, m: Monitor, choice: string): Promise<void> {
  const draft = await read($, wizardAtom)
  if (!draft || draft.step !== 'test') return
  if (choice === 'save') {
    const provider = providerOf(draft)
    const r = await updateConfig($, await getPaths($), raw => { raw.providers = [...(raw.providers ?? []), provider] })
    if (!r.ok) { await update($, wizardAtom, s => (s ? { ...s, message: `Not saved: ${r.message}` } : s)); return }
    const n = provider.models.length
    $.ui.toast(`Added [${provider.name}] with ${n} model${n === 1 ? '' : 's'}. Pick one: /model ${provider.name}/${provider.models[0]!.id}`)
    await refresh($, m)
  }
  await update($, wizardAtom, () => null)
  await $.ui.close({ id: ADD_PANE })
}

export function registerWizard(on: On, m: Monitor): void {
  on('ui.render', { component: 'Pane', requestId: ADD_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const draft = await read($, wizardAtom)
    if (!('Input' in elements) || !('Select' in elements)) {
      const { Text } = elements
      return <Text>/router add needs the terminal or the desktop app.</Text>
    }
    const { Box, Text, Input, Select } = elements
    if (!draft) return <Text dimColor>Run /router add to add a provider.</Text>
    const summary = [draft.name, draft.baseUrl, draft.models].filter(Boolean).join(' · ')
    return (
      <Box flexDirection="column">
        {summary ? <Text dimColor>{summary}</Text> : null}
        {draft.step === 'test'
          ? <Select key="add-finish" autoFocus options={[{ value: 'save', label: draft.isProbeOk ? 'Save' : 'Save anyway' }, { value: 'cancel', label: 'Cancel' }]} onSelect={value => void finishWizard($, m, value)} />
          : <Input key={`add-${draft.step}`} autoFocus label={PROMPTS[draft.step]} onSubmit={value => void submitStep($, value)} />}
        {draft.message ? <Text>{draft.message}</Text> : null}
      </Box>
    )
  })
}
```

A literal key reaches the probe on stdin only, never in process arguments.

In `register.tsx`, import `registerWizard` from `./add` and call `registerWizard(on, m)` next to `registerPicker(on, m)`.

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass (except the `/router claude` line from Task 23).

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): /router add wizard with a test call"
```

### Task 27: `/router setup` and `/router uninstall` (spec §7.8)

**Files:**
- Create: `model-router/hooks/setup.ts`
- Test: `model-router/tests/setup.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `updateConfig` (Task 19); `readText`, `writeFile`, `deleteFile`, `runTool` (Task 18); `ensureRouter`, `routerUrl` (Task 20); `launch.mjs ensure-token` (Task 17).
- Produces:
  - `BaseUrlSource = SettingsSource | 'os' | 'none'`; `Backup = { version: 1, baseUrl: string | null, source, customHeaders: string | null, at }`
  - `describeSource(source): string`
  - `findBaseUrl($): Promise<{ value?: string, source: BaseUrlSource }>` — highest of policy, flag, local, project, then user, then the OS env
  - `withTokenHeader(existing, token): string`; `withoutTokenHeader(existing): string | undefined` (LF or CRLF in, LF out, one token line)
  - `runSetup($, m): Promise<string>`; `runUninstall($): Promise<string>`

- [ ] **Step 1: Write the failing tests**

`model-router/tests/setup.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { runSetup, runUninstall, withTokenHeader, withoutTokenHeader } from '../hooks/setup'
import { newMonitor } from '../hooks/monitor'
import type { World } from './world'
import { asPlugin, BACKUP, CONFIG, readJson, TOKEN_FILE, USER_SETTINGS, world } from './world'

const ROUTER = 'http://127.0.0.1:4141'

function userSettings(w: World, value: Record<string, unknown> | null) {
  if (value === null) { w.files.delete(USER_SETTINGS); delete w.settings.user; return }
  w.files.set(USER_SETTINGS, JSON.stringify(value, null, 2))
  w.settings.user = value
}
const reloadSettings = (w: World) => { w.settings.user = readJson(w, USER_SETTINGS) }

test('token header merge keeps other headers, takes CRLF, and never doubles the token', () => {
  expect(withTokenHeader(undefined, 't')).toBe('x-router-token: t')
  expect(withTokenHeader('X-Corp: a\r\nX-Team: b', 't')).toBe('X-Corp: a\nX-Team: b\nx-router-token: t')
  expect(withTokenHeader('X-Corp: a\nX-Router-Token: old', 'new')).toBe('X-Corp: a\nx-router-token: new')
  expect(withoutTokenHeader('x-router-token: t')).toBe(undefined)
})

test('setup from user settings: saves upstream, token, backup, rewires settings and keeps everything else', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp/' } })
  const text = await runSetup(asPlugin($), newMonitor())
  expect(readJson(w, CONFIG)).toEqual({ version: 1, providers: [], overrides: {}, upstream: 'https://gw.corp' })
  expect(w.files.get(TOKEN_FILE)).toBe('tok-1')
  const s = readJson(w, USER_SETTINGS)
  expect(s.theme).toBe('dark')
  expect(s.env).toEqual({ FOO: '1', ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' })
  expect(readJson(w, BACKUP)).toEqual({ version: 1, baseUrl: 'https://gw.corp/', source: 'user', customHeaders: null, at: '1970-01-01T00:00:00.000Z' })
  expect(text).toContain('Restart Claude Code to activate.')
  expect(text).toContain('set env.ANTHROPIC_BASE_URL back to https://gw.corp/')
})

test('existing custom headers are merged and backed up', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp', ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\r\nX-Team: b' } })
  await runSetup(asPlugin($), newMonitor())
  expect(readJson(w, USER_SETTINGS).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Corp: a\nX-Team: b\nx-router-token: tok-1')
  expect(readJson(w, BACKUP).customHeaders).toBe('X-Corp: a\r\nX-Team: b')
})

test('setup twice: the second run reports and changes nothing', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  await runSetup(asPlugin($), newMonitor())
  reloadSettings(w)
  const before = w.files.get(USER_SETTINGS)
  const text = await runSetup(asPlugin($), newMonitor())
  expect(text.startsWith(`Already set up: ANTHROPIC_BASE_URL → ${ROUTER}`)).toBe(true)
  expect(w.files.get(USER_SETTINGS)).toBe(before)
})

test('no settings file and the gateway in the OS env: the file is created, source os', async ($, on) => {
  const w = world(on, { config: null, env: { ANTHROPIC_BASE_URL: 'https://gw.os' } })
  userSettings(w, null)
  await runSetup(asPlugin($), newMonitor())
  expect(readJson(w, USER_SETTINGS)).toEqual({ env: { ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' } })
  expect(readJson(w, BACKUP).source).toBe('os')
  expect(readJson(w, CONFIG).upstream).toBe('https://gw.os')
})

test('nothing set anywhere: the upstream is Anthropic', async ($, on) => {
  const w = world(on, { config: null })
  await runSetup(asPlugin($), newMonitor())
  expect(readJson(w, CONFIG).upstream).toBe('https://api.anthropic.com')
})

test('a project setting outranks user settings: setup explains and writes nothing', async ($, on) => {
  const w = world(on, { config: null })
  w.settings.project = { env: { ANTHROPIC_BASE_URL: 'https://gw.project' } }
  const text = await runSetup(asPlugin($), newMonitor())
  expect(text).toContain("the project's .claude/settings.json, which outranks ~/.claude/settings.json")
  expect(text).toContain(`"ANTHROPIC_BASE_URL": "${ROUTER}"`)
  expect(w.files.has(USER_SETTINGS)).toBe(false)
  expect(w.files.has(CONFIG)).toBe(false)
})

test('uninstall restores the original values and removes the backup', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  await runSetup(asPlugin($), newMonitor())
  const text = await runUninstall(asPlugin($))
  expect(readJson(w, USER_SETTINGS)).toEqual({ theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  expect(w.files.has(BACKUP)).toBe(false)
  expect(text).toContain('The router keeps serving other sessions')
  expect(await runUninstall(asPlugin($))).toBe('Nothing to undo: no setup backup found (/router setup was not run, or was undone).')
})

test('uninstall after an OS-env setup removes the settings env it added', async ($, on) => {
  const w = world(on, { config: null, env: { ANTHROPIC_BASE_URL: 'https://gw.os' } })
  userSettings(w, null)
  await runSetup(asPlugin($), newMonitor())
  await runUninstall(asPlugin($))
  expect(readJson(w, USER_SETTINGS)).toEqual({})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, `hooks/setup` not found.

- [ ] **Step 3: Implement `model-router/hooks/setup.ts`**

```ts
import type { EngineInterface, SettingsSource } from 'claude-code'
import { formatErrors } from '../router/lib/schema.mjs'
import { routerUrl } from './client'
import { loadConfig, updateConfig } from './config'
import { deleteFile, readText, runTool, writeFile } from './host'
import { ensureRouter } from './lifecycle'
import type { Monitor } from './monitor'
import { getPaths } from './paths'

export type BaseUrlSource = SettingsSource | 'os' | 'none'
export type Backup = { version: 1; baseUrl: string | null; source: BaseUrlSource; customHeaders: string | null; at: string }

const ABOVE_USER = ['policy', 'flag', 'local', 'project'] as const
const SOURCE_NAMES: Record<BaseUrlSource, string> = {
  policy: 'managed policy settings',
  flag: 'the --settings flag',
  local: "the project's .claude/settings.local.json",
  project: "the project's .claude/settings.json",
  user: '~/.claude/settings.json',
  os: 'the OS environment',
  none: 'nowhere (the default)',
}
export const describeSource = (source: BaseUrlSource) => SOURCE_NAMES[source]

const envOf = (settings: unknown): Record<string, string> => ((settings as { env?: Record<string, string> } | null)?.env ?? {})

export async function findBaseUrl($: EngineInterface): Promise<{ value: string | undefined; source: BaseUrlSource }> {
  for (const source of ABOVE_USER) {
    const value = envOf(await $.settings.read({ source })).ANTHROPIC_BASE_URL
    if (value) return { value, source }
  }
  const user = envOf(await $.settings.read({ source: 'user' })).ANTHROPIC_BASE_URL
  if (user) return { value: user, source: 'user' }
  const os = await $.env.get('ANTHROPIC_BASE_URL')
  return os ? { value: os, source: 'os' } : { value: undefined, source: 'none' }
}

const TOKEN_LINE = /^\s*x-router-token\s*:/i

export function withoutTokenHeader(existing: string | undefined): string | undefined {
  const lines = (existing ?? '').split(/\r?\n/).filter(l => l.trim() !== '' && !TOKEN_LINE.test(l))
  return lines.length > 0 ? lines.join('\n') : undefined
}

export function withTokenHeader(existing: string | undefined, token: string): string {
  return [withoutTokenHeader(existing), `x-router-token: ${token}`].filter(Boolean).join('\n')
}

async function readSettings($: EngineInterface, file: string): Promise<Record<string, unknown> | null | 'invalid'> {
  const text = await readText($, file)
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : 'invalid'
  } catch {
    return 'invalid'
  }
}

export async function runSetup($: EngineInterface, m: Monitor): Promise<string> {
  const paths = await getPaths($)
  const loaded = await loadConfig($, paths)
  if (loaded.errors.length > 0) return `${paths.config} is invalid: ${formatErrors(loaded.errors)}. Fix it, then run /router setup again.`
  const port = loaded.config.port
  const url = routerUrl(port)

  const base = await findBaseUrl($)
  if (base.value === url)
    return [`Already set up: ANTHROPIC_BASE_URL → ${url} (in ${describeSource(base.source)}).`, `Upstream: ${loaded.config.upstream ?? 'not set'}.`, 'Run /router doctor to check everything.'].join('\n')
  if ((ABOVE_USER as readonly string[]).includes(base.source))
    return [
      `ANTHROPIC_BASE_URL is set in ${describeSource(base.source)}, which outranks ~/.claude/settings.json. Change it there by hand:`,
      `  "ANTHROPIC_BASE_URL": "${url}"`,
      `and put its old value in ${paths.config} as the router's upstream:`,
      `  "upstream": "${base.value}"`,
      'Then restart Claude Code and run /router doctor.',
    ].join('\n')

  const settings = await readSettings($, paths.userSettings)
  if (settings === 'invalid') return `${paths.userSettings} is not a JSON object; fix it, then run /router setup again.`

  const upstream = (base.value ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  const saved = await updateConfig($, paths, raw => { raw.version = 1; raw.upstream = upstream })
  if (!saved.ok) return `Could not save the upstream: ${saved.message}`
  const lines = [`✓ upstream = ${upstream} (from ${describeSource(base.source)})`]

  const tokenOut = await runTool($, ['ensure-token', paths.token])
  if (tokenOut.ok !== true || typeof tokenOut.token !== 'string') return [...lines, `✗ could not create the token: ${tokenOut.error ?? 'unknown error'}`].join('\n')
  if (typeof tokenOut.warning === 'string') lines.push(`⚠ ${tokenOut.warning}`)

  const userEnv = envOf(settings)
  if ((await readText($, paths.backup)) === null) {
    const backup: Backup = {
      version: 1,
      baseUrl: base.value ?? null,
      source: base.source,
      customHeaders: userEnv.ANTHROPIC_CUSTOM_HEADERS ?? null,
      at: new Date(await $.clock.now()).toISOString(),
    }
    await writeFile($, paths.backup, `${JSON.stringify(backup, null, 2)}\n`)
    lines.push(`✓ original values backed up to ${paths.backup}`)
  }

  const currentHeaders = userEnv.ANTHROPIC_CUSTOM_HEADERS ?? (await $.env.get('ANTHROPIC_CUSTOM_HEADERS'))
  const env = { ...userEnv, ANTHROPIC_BASE_URL: url, ANTHROPIC_CUSTOM_HEADERS: withTokenHeader(currentHeaders, tokenOut.token) }
  await writeFile($, paths.userSettings, `${JSON.stringify({ ...(settings ?? {}), env }, null, 2)}\n`)
  lines.push(`✓ ${paths.userSettings}: env.ANTHROPIC_BASE_URL = ${url}; x-router-token added to env.ANTHROPIC_CUSTOM_HEADERS`)

  const ensured = await ensureRouter($, port)
  if (ensured.ok) { m.status = ensured.status; m.isDown = false }
  lines.push(ensured.ok ? `✓ router running (pid ${ensured.status.pid})` : `✗ router did not start: ${ensured.reason} — /router doctor`)

  lines.push(
    '',
    `Undo by hand: in ${paths.userSettings}, ${base.source === 'user' ? `set env.ANTHROPIC_BASE_URL back to ${base.value}` : 'remove env.ANTHROPIC_BASE_URL'} and remove the x-router-token line from env.ANTHROPIC_CUSTOM_HEADERS. Or run /router uninstall.`,
    'Restart Claude Code to activate. Then run /router doctor to check upstream auth.',
  )
  return lines.join('\n')
}

export async function runUninstall($: EngineInterface): Promise<string> {
  const paths = await getPaths($)
  const text = await readText($, paths.backup)
  if (text === null) return 'Nothing to undo: no setup backup found (/router setup was not run, or was undone).'
  const backup = JSON.parse(text) as Backup
  const settings = await readSettings($, paths.userSettings)
  if (settings === 'invalid') return `${paths.userSettings} is not a JSON object; fix it, then run /router uninstall again.`

  const env: Record<string, string> = { ...envOf(settings) }
  const restoredUrl = backup.source === 'user' && backup.baseUrl ? backup.baseUrl : null
  if (restoredUrl) env.ANTHROPIC_BASE_URL = restoredUrl
  else delete env.ANTHROPIC_BASE_URL
  if (backup.customHeaders) env.ANTHROPIC_CUSTOM_HEADERS = backup.customHeaders
  else delete env.ANTHROPIC_CUSTOM_HEADERS
  const next: Record<string, unknown> = { ...(settings ?? {}), env }
  if (Object.keys(env).length === 0) delete next.env

  await writeFile($, paths.userSettings, `${JSON.stringify(next, null, 2)}\n`)
  await deleteFile($, paths.backup)
  return [
    `Restored ${paths.userSettings}: ANTHROPIC_BASE_URL is ${restoredUrl ?? 'no longer set there'}, and the x-router-token header is gone.`,
    'Restart Claude Code. The router keeps serving other sessions and exits after 30 idle minutes.',
  ].join('\n')
}
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass (except the `/router claude` line from Task 23).

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): /router setup and uninstall with backup and header merge"
```

### Task 28: `/router doctor` (spec §7.9)

**Files:**
- Create: `model-router/hooks/doctor.ts`
- Test: `model-router/tests/doctor.test.ts`

**Interfaces:**
- Consumes: `probeRouter`, `getKeys`, `getLimits`, `routerUrl` (Task 20); `findBaseUrl`, `describeSource` (Task 27); `runTool` (`probe`, `env-check`) (Tasks 17–18); `$.model.complete`.
- Produces: `Item = { mark: '✓'|'⚠'|'✗', label, fix? }`; `formatReport(items): string`; `runDoctor($, m, { isOffline }): Promise<string>`. Every non-✓ item has a `fix` line unless nothing can be done (breaker, all-overridden).

- [ ] **Step 1: Write the failing tests**

`model-router/tests/doctor.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { VERSION } from '../router/version.mjs'
import { runDoctor } from '../hooks/doctor'
import { newMonitor } from '../hooks/monitor'
import type { World } from './world'
import { asPlugin, CONFIG, CONFIG_JSON, down, TOKEN_FILE, USER_SETTINGS, world } from './world'

const ROUTER = 'http://127.0.0.1:4141'
const WIRED = { ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' }

function healthy(on: Parameters<typeof world>[0], patch: { env?: Record<string, string>; config?: unknown } = {}): World {
  const w = world(on, { env: { ...WIRED, ...patch.env }, config: patch.config ?? CONFIG_JSON })
  w.files.set(TOKEN_FILE, 'tok-1')
  w.settings.user = { env: { ANTHROPIC_BASE_URL: ROUTER } }
  w.files.set(USER_SETTINGS, JSON.stringify(w.settings.user))
  return w
}
const doctor = ($: Parameters<typeof asPlugin>[0], isOffline = false) => runDoctor(asPlugin($), newMonitor(), { isOffline })

test('a healthy setup is all ticks', async ($, on) => {
  healthy(on)
  expect(await doctor($)).toBe([
    'model-router doctor',
    `✓ config ${CONFIG} is valid`,
    `✓ router running: v${VERSION}, pid 42, port 4141`,
    '✓ base URL → router (~/.claude/settings.json)',
    '✓ x-router-token header present',
    '✓ upstream answers with auth (sonnet)',
    '✓ upstream TLS certificate trusted',
    '✓ [DS] key DS_KEY set',
    '✓ [DS] ds-chat answers',
    '✓ [OR] key OR_KEY set',
    '✓ [OR] anthropic/claude-x answers',
    '✓ learned limits: none yet',
    '✓ policy: none registered',
    '',
    'Optional: model-limits (per-model context/output policies)',
  ].join('\n'))
})

test('not wired yet: base URL and token lines fail with fixes', async ($, on) => {
  const w = world(on, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  w.settings.user = { env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } }
  const report = await doctor($, true)
  expect(report).toContain('✗ base URL is https://gw.corp (~/.claude/settings.json), not the router\n    fix: /router setup')
  expect(report).toContain('✗ no router token yet\n    fix: /router setup')
})

test('a project-level base URL is reported as a bypass', async ($, on) => {
  const w = healthy(on)
  w.settings.project = { env: { ANTHROPIC_BASE_URL: 'https://elsewhere' } }
  expect(await doctor($, true)).toContain("✗ the project's .claude/settings.json sets ANTHROPIC_BASE_URL=https://elsewhere, so this project bypasses the router\n    fix: change it there to http://127.0.0.1:4141, or remove it")
})

test('a key changed since the router started asks for a restart', async ($, on) => {
  const w = healthy(on)
  w.http.set('GET /_router/keys', () => ({ status: 200, json: { keys: { DS_KEY: 'fp-old', OR_KEY: 'fp-or' } } }))
  expect(await doctor($, true)).toContain("⚠ [DS] DS_KEY differs from the router's (set or changed after it started)\n    fix: /router restart")
})

test('a rejected field names the strip fix; --offline skips provider calls', async ($, on) => {
  const w = healthy(on)
  w.tool = (sub, args, stdin) => (sub === 'probe' && JSON.parse(stdin!).mode === 'provider' ? { ok: false, kind: 'http', status: 400, text: "unknown field 'thinking'" } : undefined)
  expect(await doctor($)).toContain(`✗ [DS] ds-chat rejected: 400 unknown field 'thinking'\n    fix: add the rejected field to "strip" for DS in ${CONFIG}`)
  const before = w.runs.length
  await doctor($, true)
  expect(w.runs.slice(before).some(r => r.stdin?.includes('"provider"'))).toBe(false)
})

test('upstream auth failures and an untrusted certificate are explained', async ($, on) => {
  const w = healthy(on)
  w.complete = () => ({ isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  w.tool = (sub, args, stdin) => (sub === 'probe' && JSON.parse(stdin!).mode === 'tls' ? { ok: false, kind: 'tls', text: 'tls: SELF_SIGNED_CERT_IN_CHAIN' } : undefined)
  const report = await doctor($, true)
  expect(report).toContain('✗ upstream refused the sonnet request: HTTP 401 (authentication_failed)\n    fix: check apiKeyHelper and the gateway credentials')
  expect(report).toContain('✗ upstream certificate not trusted (tls: SELF_SIGNED_CERT_IN_CHAIN)\n    fix: export the internal CA')
})

test('all families overridden: upstream auth cannot be tested', async ($, on) => {
  healthy(on, { config: { ...CONFIG_JSON, overrides: { haiku: 'DS/ds-chat', sonnet: 'DS/ds-chat', opus: 'DS/ds-chat', fable: 'DS/ds-chat' } } })
  expect(await doctor($, true)).toContain("⚠ can't test upstream auth while all families are overridden")
})

test('a literal key is warned about; a down router fails with a fix', async ($, on) => {
  const w = healthy(on, { config: { ...CONFIG_JSON, providers: [{ name: 'L', baseUrl: 'https://l.example', apiKey: 'sk-x', models: [{ id: 'm' }] }], overrides: {} } })
  down(w)
  const report = await doctor($, true)
  expect(report).toContain(`⚠ [L] literal apiKey in ${CONFIG}\n    fix: move it to an environment variable and use "apiKeyEnv"`)
  expect(report).toMatch(/✗ router not running \(.*\)\n {4}fix: \/router restart/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, `hooks/doctor` not found.

- [ ] **Step 3: Implement `model-router/hooks/doctor.ts`**

```ts
import type { EngineInterface } from 'claude-code'
import { FAMILIES, formatErrors } from '../router/lib/schema.mjs'
import { VERSION } from '../router/version.mjs'
import { getKeys, getLimits, probeRouter, routerUrl } from './client'
import { display, loadConfig } from './config'
import { readText, runTool } from './host'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { describeSource, findBaseUrl } from './setup'

export type Mark = '✓' | '⚠' | '✗'
export type Item = { mark: Mark; label: string; fix?: string }

const ok = (label: string): Item => ({ mark: '✓', label })
const warn = (label: string, fix?: string): Item => ({ mark: '⚠', label, ...(fix ? { fix } : {}) })
const bad = (label: string, fix?: string): Item => ({ mark: '✗', label, ...(fix ? { fix } : {}) })

const CA_FIX = 'export the internal CA as a PEM file, set NODE_EXTRA_CA_CERTS to its path in ~/.claude/settings.json "env", restart Claude Code, then /router restart'

export function formatReport(items: readonly Item[]): string {
  return [
    'model-router doctor',
    ...items.flatMap(i => [`${i.mark} ${i.label}`, ...(i.fix ? [`    fix: ${i.fix}`] : [])]),
    '',
    'Optional: model-limits (per-model context/output policies)',
  ].join('\n')
}

export async function runDoctor($: EngineInterface, m: Monitor, { isOffline }: { isOffline: boolean }): Promise<string> {
  const items: Item[] = []
  const paths = await getPaths($)
  const loaded = await loadConfig($, paths)
  const config = loaded.config
  if (loaded.errors.length > 0) items.push(bad(`config ${paths.config} is invalid: ${formatErrors(loaded.errors)}`, 'fix the file; the router keeps using the last valid version meanwhile'))
  else if (loaded.raw === null) items.push(warn(`no config at ${paths.config} yet`, '/router setup, then /router add'))
  else items.push(ok(`config ${paths.config} is valid`))

  // Router: running, version, port ownership.
  const port = config.port
  const url = routerUrl(port)
  const probe = await probeRouter($, port)
  if (probe.kind === 'ours') {
    m.status = probe.status
    items.push(probe.status.version === VERSION
      ? ok(`router running: v${VERSION}, pid ${probe.status.pid}, port ${port}`)
      : warn(`router runs v${probe.status.version} (pid ${probe.status.pid}); this plugin is v${VERSION}`, '/router restart'))
  } else if (probe.kind === 'foreign') items.push(bad(`port ${port} answers, but not as model-router`, `set "port" in ${paths.config} to a free port, then /router setup`))
  else items.push(bad(`router not running (${probe.reason})`, '/router restart'))

  // Wiring: where ANTHROPIC_BASE_URL comes from, and what this session uses.
  const base = await findBaseUrl($)
  const live = await $.env.get('ANTHROPIC_BASE_URL')
  if (base.value === url && live === url) items.push(ok(`base URL → router (${describeSource(base.source)})`))
  else if (base.value === url) items.push(warn(`base URL → router in ${describeSource(base.source)}, but this session still uses ${live ?? 'the default'}`, 'restart Claude Code'))
  else if (base.source === 'project' || base.source === 'local') items.push(bad(`${describeSource(base.source)} sets ANTHROPIC_BASE_URL=${base.value}, so this project bypasses the router`, `change it there to ${url}, or remove it`))
  else items.push(bad(`base URL is ${base.value ?? 'not set'} (${describeSource(base.source)}), not the router`, base.source === 'policy' || base.source === 'flag' ? `change ANTHROPIC_BASE_URL in ${describeSource(base.source)} to ${url}` : '/router setup'))

  // The local token header.
  const token = (await readText($, paths.token))?.trim() ?? ''
  const headers = (await $.env.get('ANTHROPIC_CUSTOM_HEADERS')) ?? ''
  if (!token) items.push(bad('no router token yet', '/router setup'))
  else if (headers.split(/\r?\n/).some(l => l.trim() === `x-router-token: ${token}`)) items.push(ok('x-router-token header present'))
  else items.push(bad('this session does not send the x-router-token header (routed requests get 401)', '/router setup, then restart Claude Code'))

  // Upstream, with auth, through the normal path.
  const family = FAMILIES.find(f => !config.overrides[f])
  if (!family) items.push(warn("can't test upstream auth while all families are overridden"))
  else {
    const r = await $.model.complete({ model: family, prompt: 'Reply with OK.', maxTokens: 1, timeoutMs: 30_000 })
    if (r.isAnswered) items.push(ok(`upstream answers with auth (${family})`))
    else if (r.reason === 'api-error') items.push(bad(`upstream refused the ${family} request: HTTP ${r.status ?? 'no response'} (${r.error})`, r.status === 401 || r.status === 403 ? 'check apiKeyHelper and the gateway credentials' : 'see ~/.claude/model-router/router.log, then /router doctor again'))
    else items.push(bad(`upstream ${family} request: ${r.reason}`, 'see ~/.claude/model-router/router.log, then /router doctor again'))
  }

  // Upstream TLS trust, as Node (the router) sees it.
  if (config.upstream?.startsWith('https:')) {
    const t = await runTool($, ['probe'], { stdin: JSON.stringify({ mode: 'tls', url: config.upstream }) })
    if (t.ok === true) items.push(ok('upstream TLS certificate trusted'))
    else if (t.kind === 'tls') items.push(bad(`upstream certificate not trusted (${String(t.text)})`, CA_FIX))
    else items.push(warn(`upstream not reachable from Node (${String(t.text ?? t.error)})`, 'check the gateway URL in model-router.json'))
  }

  // Providers: key, key drift, breaker, a test request.
  const keys = token && probe.kind === 'ours' ? await getKeys($, port, token) : null
  const envNames = config.providers.flatMap(p => (p.apiKeyEnv ? [p.apiKeyEnv] : []))
  const here = envNames.length > 0 ? ((await runTool($, ['env-check', ...envNames])).keys as Record<string, string | null> | undefined) ?? {} : {}
  for (const p of config.providers) {
    const tag = `[${p.name}]`
    let hasKey = true
    if (p.apiKey !== undefined) items.push(warn(`${tag} literal apiKey in ${paths.config}`, 'move it to an environment variable and use "apiKeyEnv"'))
    else if (p.apiKeyEnv) {
      const mine = here[p.apiKeyEnv] ?? null
      const routers = keys?.[p.apiKeyEnv] ?? null
      if (!mine && !routers) { hasKey = false; items.push(bad(`${tag} ${p.apiKeyEnv} is not set`, `set ${p.apiKeyEnv} (for example in ~/.claude/settings.json "env"), restart Claude Code, then /router restart`)) }
      else if (keys && mine !== routers) items.push(warn(`${tag} ${p.apiKeyEnv} differs from the router's (set or changed after it started)`, '/router restart'))
      else items.push(ok(`${tag} key ${p.apiKeyEnv} set`))
    }
    const st = probe.kind === 'ours' ? probe.status.providers.find(x => x.name === p.name) : undefined
    if (st?.breaker === 'open') items.push(warn(`${tag} paused by the circuit breaker; it resumes by itself within 5 minutes`))
    if (isOffline || !hasKey) continue
    const model = p.models[0]!.id
    const r = await runTool($, ['probe'], { stdin: JSON.stringify({ mode: 'provider', provider: { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, apiKey: p.apiKey, strip: p.strip }, model }), timeoutMs: 90_000 })
    const learned = typeof r.learnedMaxTokens === 'number' ? ` (max output ${r.learnedMaxTokens} learned)` : ''
    if (r.ok === true) items.push(ok(`${tag} ${model} answers${learned}`))
    else if (r.kind === 'tls') items.push(bad(`${tag} certificate not trusted (${String(r.text)})`, CA_FIX))
    else if (r.kind === 'http' && r.status === 400) items.push(bad(`${tag} ${model} rejected: 400 ${String(r.text)}${learned}`, `add the rejected field to "strip" for ${p.name} in ${paths.config}`))
    else if (r.kind !== 'no-key') items.push(bad(`${tag} ${model} failed: ${String(r.status ?? r.kind)} ${String(r.text ?? r.error)}`, `check the baseUrl of ${p.name} in ${paths.config}`))
  }

  // Learned limits and any registered policy, read-only.
  const limits = probe.kind === 'ours' ? await getLimits($, port) : null
  if (limits) {
    const entries = Object.entries(limits.learned)
    items.push(ok(entries.length > 0 ? `learned limits: ${entries.map(([ref, v]) => `${display(ref)} max output ${v.maxOutputTokens}`).join(', ')}` : 'learned limits: none yet'))
    items.push(ok(limits.policy ? `policy registered: ${JSON.stringify(limits.policy)}` : 'policy: none registered'))
  }
  return formatReport(items)
}
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: all pass (except the `/router claude` line from Task 23).

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): /router doctor checklist"
```

### Task 29: `/router` — parsing and every subcommand (spec §7.6, D14)

**Files:**
- Create: `model-router/hooks/commands.ts`
- Modify: `model-router/hooks/register.tsx` (the `/router` hook)
- Test: `model-router/tests/router-command.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 18–28.
- Produces:
  - `RouterCommand` union (`picker | pick | claude | default | override | add | remove | setup | uninstall | doctor | forget | restart | usage`)
  - `parseRouterArgs(args): RouterCommand` — a subcommand word always wins over a model of the same name
  - `runRouterCommand($, m, cmd): Promise<CommandRunResult>`
  - `/router restart` (an addition the spec implies: doctor's "offer a restart" for a changed key and the version-mismatch fix) runs `launch.mjs start --force`

- [ ] **Step 1: Write the failing tests**

`model-router/tests/router-command.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'
import { parseRouterArgs } from '../hooks/commands'
import { PICKER_PANE } from '../hooks/picker'
import { ADD_PANE } from '../hooks/add'
import { getPick } from '../hooks/pick'
import { asPlugin, CONFIG, readJson, run, start, TOKEN_FILE, world } from './world'

describe('parseRouterArgs', () => {
  test('subcommands and their forms', () => {
    expect(parseRouterArgs('')).toEqual({ kind: 'picker' })
    expect(parseRouterArgs('  ')).toEqual({ kind: 'picker' })
    expect(parseRouterArgs('DS/ds-chat')).toEqual({ kind: 'pick', name: 'DS/ds-chat' })
    expect(parseRouterArgs('claude')).toEqual({ kind: 'claude' })
    expect(parseRouterArgs('default clear')).toEqual({ kind: 'default', name: null })
    expect(parseRouterArgs('default DS/ds-chat')).toEqual({ kind: 'default', name: 'DS/ds-chat' })
    expect(parseRouterArgs('override haiku clear')).toEqual({ kind: 'override', family: 'haiku', name: null })
    expect(parseRouterArgs('override sonnet OR/anthropic/claude-x')).toEqual({ kind: 'override', family: 'sonnet', name: 'OR/anthropic/claude-x' })
    expect(parseRouterArgs('remove DS')).toEqual({ kind: 'remove', target: 'DS' })
    expect(parseRouterArgs('doctor --offline')).toEqual({ kind: 'doctor', isOffline: true })
    expect(parseRouterArgs('forget all')).toEqual({ kind: 'forget', target: 'all' })
    expect(parseRouterArgs('restart')).toEqual({ kind: 'restart' })
  })

  test('a subcommand name beats a model of the same name', () => {
    expect(parseRouterArgs('doctor')).toEqual({ kind: 'doctor', isOffline: false })
    expect(parseRouterArgs('setup')).toEqual({ kind: 'setup' })
  })

  test('wrong forms answer with usage', () => {
    expect(parseRouterArgs('override gpt x')).toEqual({ kind: 'usage', text: 'Usage: /router override <haiku|sonnet|opus|fable> <model|clear>' })
    expect(parseRouterArgs('default')).toEqual({ kind: 'usage', text: 'Usage: /router default <model|clear>' })
    expect(parseRouterArgs('claude now')).toEqual({ kind: 'usage', text: 'Usage: /router claude' })
    expect(parseRouterArgs('a b')).toEqual({ kind: 'usage', text: 'Usage: /router <model>' })
  })
})

test('/router opens the picker in router mode; /router add opens the wizard', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router')
  await run($, 'router', 'add')
  expect(w.opened).toEqual([PICKER_PANE, ADD_PANE])
})

test('/router <name> and /router claude set and clear the pick', async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'router', 'ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner')
  expect(await getPick(asPlugin($))).toBe('DS/ds-reasoner')
  expect((await run($, 'router', 'claude')).text).toBe("Main model: Claude (this session's model)")
  expect(await getPick(asPlugin($))).toBe(null)
  expect((await run($, 'router', 'nope')).text).toBe('Unknown model "nope". Models: DS/ds-chat, DS/ds-reasoner, OR/anthropic/claude-x, OR/ds-chat')
})

test('/router default and override write the config', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'router', 'default DS/ds-chat')).text).toBe('Default main model for new sessions: [DS] ds-chat')
  expect(readJson(w, CONFIG).defaultMainModel).toBe('DS/ds-chat')
  expect((await run($, 'router', 'default clear')).text).toBe('Default main model cleared: new sessions start on Claude.')
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
  expect((await run($, 'router', 'override opus OR/anthropic/claude-x')).text).toBe('opus → [OR] anthropic/claude-x (all sessions, from the next request)')
  expect((await run($, 'router', 'override haiku clear')).text).toBe('haiku → Claude (override cleared)')
  expect(readJson(w, CONFIG).overrides).toEqual({ opus: 'OR/anthropic/claude-x' })
})

test('/router remove drops a model or a provider and clears what pointed at it', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'default DS/ds-chat')
  expect((await run($, 'router', 'remove DS/ds-chat')).text).toBe([
    'Removed [DS] ds-chat.',
    '⚠ haiku override cleared (it pointed at [DS] ds-chat)',
    '⚠ default main model cleared (it was [DS] ds-chat)',
  ].join('\n'))
  expect(readJson(w, CONFIG).providers[0].models).toEqual([{ id: 'ds-reasoner' }])
  expect((await run($, 'router', 'remove OR')).text).toBe('Removed [OR] anthropic/claude-x, [OR] ds-chat.')
  expect(readJson(w, CONFIG).providers.map((p: { name: string }) => p.name)).toEqual(['DS'])
  expect((await run($, 'router', 'remove Nobody')).text).toBe('Nothing named "Nobody". Models: DS/ds-reasoner')
})

test('/router forget sends the token; /router restart forces a new router', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'router', 'forget all')).text).toBe('No router token yet: run /router setup first.')
  w.files.set(TOKEN_FILE, 'tok-1\n')
  expect((await run($, 'router', 'forget all')).text).toBe('Forgot 1 learned limit.')
  expect(w.fetches.at(-1)!.headers['x-router-token']).toBe('tok-1')
  expect((await run($, 'router', 'restart')).text).toBe('model-router restarted (pid 42). Learned limits start empty.')
  expect(w.runs.at(-1)!.argv.slice(2)).toEqual(['start', '--force'])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test model-router`
Expected: FAIL, `hooks/commands` not found.

- [ ] **Step 3: Implement `model-router/hooks/commands.ts`**

```ts
import type { CommandRunResult, EngineInterface } from 'claude-code'
import { allRefs, FAMILIES, parseRef } from '../router/lib/schema.mjs'
import type { Family } from '../router/lib/schema.mjs'
import { openWizard } from './add'
import { postForget } from './client'
import { ambiguousText, display, findModel, loadConfig, modelList, updateConfig } from './config'
import type { Match } from './config'
import { runDoctor } from './doctor'
import { readText } from './host'
import { ensureRouter } from './lifecycle'
import { refresh } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { clearPick, setPick } from './pick'
import { openPicker } from './picker'
import { runSetup, runUninstall } from './setup'

export type RouterCommand =
  | { kind: 'picker' }
  | { kind: 'pick'; name: string }
  | { kind: 'claude' }
  | { kind: 'default'; name: string | null }
  | { kind: 'override'; family: Family; name: string | null }
  | { kind: 'add' }
  | { kind: 'remove'; target: string }
  | { kind: 'setup' }
  | { kind: 'uninstall' }
  | { kind: 'doctor'; isOffline: boolean }
  | { kind: 'forget'; target: string }
  | { kind: 'restart' }
  | { kind: 'usage'; text: string }

const usage = (form: string): RouterCommand => ({ kind: 'usage', text: `Usage: ${form}` })

export function parseRouterArgs(args: string): RouterCommand {
  const [head, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (head === undefined) return { kind: 'picker' }
  const bare = (cmd: RouterCommand, form: string) => (rest.length === 0 ? cmd : usage(form))
  switch (head) {
    case 'claude': return bare({ kind: 'claude' }, '/router claude')
    case 'add': return bare({ kind: 'add' }, '/router add')
    case 'setup': return bare({ kind: 'setup' }, '/router setup')
    case 'uninstall': return bare({ kind: 'uninstall' }, '/router uninstall')
    case 'restart': return bare({ kind: 'restart' }, '/router restart')
    case 'doctor':
      if (rest.length === 0) return { kind: 'doctor', isOffline: false }
      return rest.length === 1 && rest[0] === '--offline' ? { kind: 'doctor', isOffline: true } : usage('/router doctor [--offline]')
    case 'default':
      return rest.length === 1 ? { kind: 'default', name: rest[0] === 'clear' ? null : rest[0]! } : usage('/router default <model|clear>')
    case 'override': {
      const [family, name] = rest
      if (rest.length !== 2 || !FAMILIES.includes(family as Family)) return usage('/router override <haiku|sonnet|opus|fable> <model|clear>')
      return { kind: 'override', family: family as Family, name: name === 'clear' ? null : name! }
    }
    case 'remove': return rest.length === 1 ? { kind: 'remove', target: rest[0]! } : usage('/router remove <provider|provider/model>')
    case 'forget': return rest.length === 1 ? { kind: 'forget', target: rest[0]! } : usage('/router forget <provider/model|all>')
    default: return rest.length === 0 ? { kind: 'pick', name: head } : usage('/router <model>')
  }
}

function notOne(name: string, match: Match, list: string): string {
  return match.kind === 'ambiguous' ? ambiguousText(name, match.refs) : `Unknown model "${name}". Models: ${list}`
}

export async function runRouterCommand($: EngineInterface, m: Monitor, cmd: RouterCommand): Promise<CommandRunResult> {
  const paths = await getPaths($)
  const { config } = await loadConfig($, paths)
  switch (cmd.kind) {
    case 'usage': return { text: cmd.text }
    case 'picker': return openPicker($, m, 'router')
    case 'add': return openWizard($)
    case 'setup': return { text: await runSetup($, m) }
    case 'uninstall': return { text: await runUninstall($) }
    case 'doctor': return { text: await runDoctor($, m, { isOffline: cmd.isOffline }) }
    case 'claude':
      await clearPick($)
      await refresh($, m)
      return { text: "Main model: Claude (this session's model)" }
    case 'pick': {
      const match = findModel(config, cmd.name)
      if (match.kind !== 'one') return { text: notOne(cmd.name, match, modelList(config)) }
      await setPick($, match.ref)
      await refresh($, m)
      return { text: `Main model: ${display(match.ref)}` }
    }
    case 'default': {
      let ref: string | null = null
      if (cmd.name !== null) {
        const match = findModel(config, cmd.name)
        if (match.kind !== 'one') return { text: notOne(cmd.name, match, modelList(config)) }
        ref = match.ref
      }
      const r = await updateConfig($, paths, raw => { if (ref === null) delete raw.defaultMainModel; else raw.defaultMainModel = ref })
      if (!r.ok) return { text: r.message }
      return { text: ref === null ? 'Default main model cleared: new sessions start on Claude.' : `Default main model for new sessions: ${display(ref)}` }
    }
    case 'override': {
      let ref: string | null = null
      if (cmd.name !== null) {
        const match = findModel(config, cmd.name)
        if (match.kind !== 'one') return { text: notOne(cmd.name, match, modelList(config)) }
        ref = match.ref
      }
      const r = await updateConfig($, paths, raw => {
        const overrides = { ...(raw.overrides ?? {}) }
        if (ref === null) delete overrides[cmd.family]
        else overrides[cmd.family] = ref
        raw.overrides = overrides
      })
      if (!r.ok) return { text: r.message }
      await refresh($, m)
      return { text: ref === null ? `${cmd.family} → Claude (override cleared)` : `${cmd.family} → ${display(ref)} (all sessions, from the next request)` }
    }
    case 'remove': {
      const isModel = cmd.target.includes('/')
      const removed = allRefs(config).filter(r => (isModel ? r === cmd.target : parseRef(r)?.provider === cmd.target))
      if (removed.length === 0) return { text: `Nothing named "${cmd.target}". Models: ${modelList(config)}` }
      const notes: string[] = []
      const r = await updateConfig($, paths, raw => {
        const target = parseRef(cmd.target)
        raw.providers = (raw.providers ?? []).flatMap(p => {
          if (!isModel) return p.name === cmd.target ? [] : [p]
          if (p.name !== target?.provider) return [p]
          const models = p.models.filter(x => x.id !== target.model)
          return models.length === 0 ? [] : [{ ...p, models }]
        })
        const overrides = { ...(raw.overrides ?? {}) }
        for (const [family, ref] of Object.entries(overrides)) {
          if (removed.includes(ref)) { delete overrides[family]; notes.push(`${family} override cleared (it pointed at ${display(ref)})`) }
        }
        raw.overrides = overrides
        if (raw.defaultMainModel && removed.includes(raw.defaultMainModel)) {
          notes.push(`default main model cleared (it was ${display(raw.defaultMainModel)})`)
          delete raw.defaultMainModel
        }
      })
      if (!r.ok) return { text: r.message }
      await refresh($, m)
      return { text: [`Removed ${removed.map(display).join(', ')}.`, ...notes.map(n => `⚠ ${n}`)].join('\n') }
    }
    case 'forget': {
      const token = (await readText($, paths.token))?.trim()
      if (!token) return { text: 'No router token yet: run /router setup first.' }
      const n = await postForget($, config.port, token, cmd.target)
      return { text: n === null ? 'The router did not answer: /router doctor' : `Forgot ${n} learned limit${n === 1 ? '' : 's'}.` }
    }
    case 'restart': {
      const r = await ensureRouter($, config.port, { force: true })
      if (r.ok) { m.status = r.status; m.lastSeq = r.status.eventsSeq; m.isDown = false }
      await refresh($, m)
      return { text: r.ok ? `model-router restarted (pid ${r.status.pid}). Learned limits start empty.` : `Restart failed: ${r.reason}` }
    }
  }
}
```

In `register.tsx`, import `parseRouterArgs` and `runRouterCommand` from `./commands` and add:

```tsx
  on('command.run', { command: 'router' }, async ($, e) => runRouterCommand($, m, parseRouterArgs(e.args)))
```

- [ ] **Step 4: Run the checks**

Run the three Phase 2 checks. Expected: **every** test passes now, including Task 23's defaultMainModel test. `claude plugin validate` lists the `/router` hook as "answers its own command".

- [ ] **Step 5: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/hooks model-router/tests
git commit -m "feat(mod): /router subcommands"
```

---

## Phase 3 — End to end, packaging, release

### Task 30: Headless end-to-end (`claude -p` → real router → fakes)

**Files:**
- Modify: `model-router/router/test/fakes.mjs` (add `sseToolUse`)
- Create: `model-router/e2e/run.mjs`

**Interfaces:**
- Consumes: fakes (Task 12), `launch.mjs start` (Task 17), `postShutdown` (Task 15), the whole mod (Tasks 18–29).
- Produces: `node model-router/e2e/run.mjs` → one `PASS`/`FAIL` line per scenario, exit 1 on any failure. `CLAUDE_BIN` overrides the `claude` executable.

- [ ] **Step 1: Add a tool-use reply to the fakes**

Append to `model-router/router/test/fakes.mjs`:

```js
// An SSE reply that calls one tool (e.g. the Agent tool) and stops for its result.
export function sseToolUse(res, model, name, input) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_tool', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_e2e', name, input: {} } })
  ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } })
  ev('message_stop', {})
  res.end()
}
```

- [ ] **Step 2: Write `model-router/e2e/run.mjs`**

```js
#!/usr/bin/env node
// Headless end to end: claude -p with this plugin → the real router → a fake
// upstream (standing for the gateway) and a fake provider.
// Usage: node model-router/e2e/run.mjs   (CLAUDE_BIN overrides the claude executable)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closedPort, defaultHandler, jsonReply, sseToolUse, startFake } from '../router/test/fakes.mjs'
import { postShutdown } from '../router/lib/client.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LAUNCH = path.join(ROOT, 'router', 'launch.mjs')
const TOKEN = 'e2e-token'

function exec(command, args, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', err => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }))
    child.on('exit', code => resolve({ code, stdout, stderr }))
  })
}

const check = (isTrue, message) => { if (!isTrue) throw new Error(message) }
const messages = fake => fake.requests
  .filter(r => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'))
  .map(r => ({ ...r, json: JSON.parse(r.body) }))
const readEvents = home => {
  try { return fs.readFileSync(path.join(home, 'model-router', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) }
  catch { return [] }
}

async function scenario(name, { config = {}, upstreamHandler, providerHandler, prompt, verify }) {
  const upstream = await startFake(upstreamHandler ? { handler: upstreamHandler } : {})
  const provider = await startFake(providerHandler ? { handler: providerHandler } : {})
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-e2e-'))
  const port = await closedPort()
  fs.mkdirSync(path.join(home, 'model-router'), { recursive: true })
  fs.writeFileSync(path.join(home, 'model-router', 'token'), TOKEN)
  fs.writeFileSync(path.join(home, 'model-router.json'), JSON.stringify({
    version: 1,
    port,
    upstream: upstream.url,
    providers: [{ name: 'P', baseUrl: provider.url, apiKeyEnv: 'E2E_KEY', models: [{ id: 'fake-model' }] }],
    ...config,
  }, null, 2))
  const env = {
    ...process.env,
    MODEL_ROUTER_HOME: home,
    E2E_KEY: 'sk-e2e',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'dummy',
    ANTHROPIC_CUSTOM_HEADERS: `x-router-token: ${TOKEN}`,
  }
  delete env.ANTHROPIC_AUTH_TOKEN
  try {
    // Started first, so the engine's HEAD /api/hello (sent before session.start) finds it.
    const started = await exec(process.execPath, [LAUNCH, 'start'], env)
    check(started.code === 0, `router did not start: ${started.stdout}${started.stderr}`)
    const run = await exec(process.env.CLAUDE_BIN ?? 'claude', ['-p', prompt, '--plugin-dir', ROOT], env, home)
    check(run.code === 0, `claude -p exited ${run.code}: ${run.stderr.slice(0, 400)}`)
    verify({ run, upstream, provider, events: readEvents(home) })
    console.log(`PASS ${name}`)
    return true
  } catch (err) {
    console.log(`FAIL ${name}: ${err.message}`)
    return false
  } finally {
    await postShutdown(port, TOKEN)
    await upstream.close()
    await provider.close()
  }
}

const results = []

results.push(await scenario('routed main model', {
  config: { defaultMainModel: 'P/fake-model' },
  prompt: 'Say hi.',
  verify: ({ run, provider }) => {
    const sent = messages(provider)
    check(sent.some(r => r.json.model === 'fake-model'), `the provider saw no fake-model request (${sent.length} requests)`)
    check(sent.every(r => r.headers['x-api-key'] === 'sk-e2e' && !r.headers.authorization), 'the provider got gateway auth, or not its own key')
    check(run.stdout.includes('from fake-model'), `the answer did not come from the provider: ${run.stdout.slice(0, 200)}`)
  },
}))

results.push(await scenario('haiku subagent via override', {
  config: { overrides: { haiku: 'P/fake-model' } },
  prompt: 'E2E_AGENT: run exactly one subagent.',
  upstreamHandler: (req, res, body) => {
    const json = body ? JSON.parse(body) : {}
    const text = JSON.stringify(json.messages ?? [])
    const hasAgent = (json.tools ?? []).some(t => t.name === 'Agent')
    if (json.stream && hasAgent && text.includes('E2E_AGENT') && !text.includes('tool_result'))
      return sseToolUse(res, json.model, 'Agent', { description: 'e2e sub', prompt: 'Say sub-hi.', subagent_type: 'general-purpose', model: 'haiku' })
    return defaultHandler(req, res, body)
  },
  verify: ({ upstream, provider }) => {
    check(messages(upstream).some(r => JSON.stringify(r.json.messages).includes('E2E_AGENT')), 'the main loop did not stay on the upstream')
    check(messages(provider).some(r => JSON.stringify(r.json.messages).includes('Say sub-hi')), 'the haiku subagent did not reach the provider')
  },
}))

results.push(await scenario('provider failure falls back to Claude', {
  config: { defaultMainModel: 'P/fake-model' },
  providerHandler: (req, res) => jsonReply(res, 500, { error: { message: 'e2e boom' } }),
  prompt: 'Say hi.',
  verify: ({ run, events }) => {
    check(/from claude-/.test(run.stdout), `the fallback answer did not come from upstream: ${run.stdout.slice(0, 200)}`)
    check(events.some(e => e.kind === 'fallback' && e.status === 500 && e.text === 'e2e boom'), 'no fallback event with status 500')
  },
}))

process.exitCode = results.every(Boolean) ? 0 : 1
```

- [ ] **Step 3: Run it**

```bash
cd /c/dev/llm/mods && node model-router/e2e/run.mjs
```

Expected:

```
PASS routed main model
PASS haiku subagent via override
PASS provider failure falls back to Claude
```

If `claude` is not found by `spawn` on Windows, run with `CLAUDE_BIN="$(cygpath -w "$(which claude)")"`. A `FAIL` is a real bug: debug with `superpowers:systematic-debugging` (start from the scenario's `events.jsonl`, `router.log` and `router.out` in the temp home), fix, re-run.

- [ ] **Step 4: Commit**

```bash
cd /c/dev/llm/mods
git add model-router/e2e model-router/router/test/fakes.mjs
git commit -m "test: headless end-to-end scenarios through the real router"
```

### Task 31: Packaging, READMEs, release checklist (spec §8, §10.5, §12)

**Files:**
- Create: `.claude-plugin/marketplace.json` (repo root)
- Delete: `rtl-mode/.claude-plugin/marketplace.json`
- Create: `README.md` (repo root)
- Create: `model-router/README.md`
- Create: `model-router/docs/release-checklist.md`

**Interfaces:**
- Consumes: everything.
- Produces: marketplace `llm-mods` listing `rtl-mode` and `model-router`; install line `/plugin install model-router@llm-mods`. **`llm-mods` is a working name, not final.** It is written in exactly two kinds of places: the `name` field of `.claude-plugin/marketplace.json`, and the `@llm-mods` install lines in the READMEs. No code, test or plugin manifest names it (plugins never refer to their marketplace), so a rename is the one-step recipe in the release checklist.

- [ ] **Step 1: Write the root marketplace and remove rtl-mode's**

`.claude-plugin/marketplace.json`:

```json
{
  "name": "llm-mods",
  "owner": { "name": "David Yermiyahu" },
  "description": "Claude Code mods: Hebrew RTL display and a router for models from other providers",
  "plugins": [
    {
      "name": "rtl-mode",
      "source": "./rtl-mode",
      "description": "Right-to-left display for Hebrew lines in the transcript, toggled by /rtl or a band button"
    },
    {
      "name": "model-router",
      "source": "./model-router",
      "description": "Use models from other Anthropic-compatible providers: pick them in /model, override haiku/sonnet/opus/fable, with fallback to Claude"
    }
  ]
}
```

```bash
cd /c/dev/llm/mods
git rm rtl-mode/.claude-plugin/marketplace.json
claude plugin validate rtl-mode
claude plugin validate model-router
```

Expected: both validate with no errors.

- [ ] **Step 2: Write `model-router/README.md`**

````markdown
# model-router

Use models from other **Anthropic-compatible** providers in Claude Code, next to Claude:

- **Pick** one as this session's main model, from `/model` or `/router` (shown as `[DeepSeek] deepseek-chat`).
- **Override** a Claude family (`haiku`, `sonnet`, `opus`, `fable`) so all its requests, including background calls (titles, summaries, compaction) and subagents, go to a model you added.
- If a provider fails before it answers, the request **falls back** to the Claude model it replaced, and a toast says so.

It works by putting a small local router (Node, no dependencies, `127.0.0.1` only) in front of your usual endpoint. Requests that are not routed pass through to it byte for byte.

## Install

```
/plugin marketplace add C:\dev\llm\mods
/plugin install model-router@llm-mods
```

Then, once:

```
/router setup
```

and restart Claude Code. `/router doctor` checks everything after the restart.

Requirements: Node 24 on `PATH`. Providers must speak the Anthropic Messages API (OpenAI-format endpoints are not supported).

## Add a provider

`/router add` asks for a name, the base URL, the API key (the **name of an environment variable** holding it is preferred) and the model IDs, then makes a test call. Or edit `~/.claude/model-router.json`:

```jsonc
{
  "version": 1,
  "port": 4141,
  "upstream": "https://llm-gw.corp.example",
  "providers": [
    {
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "strip": ["anthropic-beta", "thinking", "context_management", "output_config"],
      "models": [{ "id": "deepseek-chat" }]
    }
  ],
  "overrides": { "haiku": "DeepSeek/deepseek-chat" },
  "defaultMainModel": "DeepSeek/deepseek-chat"
}
```

`strip` lists headers and body fields the provider rejects (the default is shown). `/router doctor` names the field a provider rejects.

The router reads the key variable from the environment it was started in. Put keys in `~/.claude/settings.json` `"env"` (or your OS environment), restart Claude Code, then `/router restart`.

## Commands

| Command | What it does |
|---|---|
| `/model` | Claude models and `[Provider] model` entries in one list (turn off with the `takeOverModelCommand` option) |
| `/router` | The same list plus: set default, override a family, add a provider, doctor |
| `/router <model>` / `/router claude` | Set / clear this session's main model |
| `/router default <model\|clear>` | Main model for new sessions |
| `/router override <family> <model\|clear>` | Send a Claude family to a model, in every session |
| `/router add` / `/router remove <provider\|provider/model>` | Manage providers |
| `/router setup` / `/router uninstall` | Wire Claude Code to the router, or undo it |
| `/router doctor [--offline]` | Check everything, with a fix for each problem |
| `/router forget <provider/model\|all>` | Forget learned output limits |
| `/router restart` | Restart the router (picks up new keys) |

## How it behaves

- **Output limits.** Claude Code asks for more output tokens than many providers allow. When a provider says so, the router learns the limit, retries once, and remembers it until the router restarts (`[DeepSeek] max output 8192 learned`).
- **Failures.** A provider that fails before its first byte (connection, timeout, 429, 5xx, a rejected field) falls back to Claude. Three failures in a row pause it for 5 minutes (`[DeepSeek] ⚠  paused`). A failure mid-answer is shown as an error, not retried.
- **Several sessions** share one router. It starts with the first session and exits after 30 idle minutes.
- **Context windows** of routed models are unknown to Claude Code, so its context % and auto-compact use defaults. The separate `model-limits` plugin (planned) will handle that.
- Claude Code logs `[claude-code:unrecognized_model]` for routed models; that is expected.

## Security

- The router listens on `127.0.0.1` only.
- Provider keys are used only for requests that carry the local token `/router setup` adds to `ANTHROPIC_CUSTOM_HEADERS` (so other local programs cannot spend your provider credit).
- Your gateway credentials are never sent to a provider: routed requests lose `authorization`, `x-api-key`, the session id and `metadata` before the provider's own key is set.
- Logs (`~/.claude/model-router/`) never hold prompts, answers or keys.
- If your network inspects TLS, provider traffic is visible to it like any other HTTPS traffic. The router trusts the Windows certificate store (`--use-system-ca`) and `NODE_EXTRA_CA_CERTS`.

## Uninstall

`/router uninstall` restores `~/.claude/settings.json` from the backup setup made, then restart Claude Code. By hand: set `env.ANTHROPIC_BASE_URL` back (or remove it) and remove the `x-router-token` line from `env.ANTHROPIC_CUSTOM_HEADERS`.

## Development

```
node --test "model-router/router/test/*.test.mjs"   # router
claude plugin test model-router                      # mod
node model-router/e2e/run.mjs                        # headless end to end
```
````

- [ ] **Step 3: Write the root `README.md`**

````markdown
# llm-mods

Claude Code mods. Add the marketplace once:

```
/plugin marketplace add C:\dev\llm\mods
```

## Which do I need?

| You want to… | Install |
|---|---|
| Read Hebrew lines right to left in the transcript | `/plugin install rtl-mode@llm-mods` |
| Use models from other Anthropic-compatible providers (DeepSeek, Kimi, GLM, OpenRouter…), alone or in place of haiku/sonnet/opus/fable | `/plugin install model-router@llm-mods` |
| Cap output or context per model, for Claude and routed models | `model-limits` (planned; works best with model-router) |

The plugins do not depend on each other. See each folder's README.
````

- [ ] **Step 4: Write `model-router/docs/release-checklist.md`**

```markdown
# model-router release checklist (manual)

Spec §10.5. Run on Windows with the real corporate gateway and one real provider.

- [ ] `/router setup` with `apiKeyHelper` auth and the internal CA; restart; `/router doctor` is all ✓ (or ⚠ with a reason).
- [ ] Interactive session with `overrides.haiku` set: the title request and a `/compact` show as routed in `~/.claude/model-router/router.log`.
- [ ] `/model` shows the unified picker; "Claude Code's picker…" opens the stock picker.
- [ ] Picking a Claude model in the stock picker clears a routed pick (toast, status line).
- [ ] `[claude-code:unrecognized_model]`: note where it shows in the interactive UI.
- [ ] A session longer than the `apiKeyHelper` token TTL keeps working (pass-through and fallback use the fresh token).
- [ ] Two parallel sessions: a fallback toast shows only in the session that made the request; killing the router respawns it within 10 s with "model-router restarted"; `/router uninstall` in one session leaves the other working.
- [ ] Capture the real provider's `max_tokens` error text and add it to `router/test/fixtures/limit-errors.json`; run the router tests.
- [ ] If Claude Code was updated: refresh `PROBE_BETA` / `PROBE_CONTEXT_MANAGEMENT` in `router/lib/probe-request.mjs` with the capture of Task 1.
- [ ] Bump `version` in `.claude-plugin/plugin.json` **and** `router/version.mjs` together.
- [ ] Marketplace name final? `llm-mods` is a working name. To rename it to `<new>`: set `name` in the repo root's `.claude-plugin/marketplace.json`, then replace every `@llm-mods` and `` `llm-mods` `` in `README.md`, `rtl-mode/README.md` (if any) and `model-router/README.md` (`grep -rn "llm-mods" --include=*.md --include=*.json .` must show only the new name afterwards). On a machine that already installed from it: `/plugin marketplace remove llm-mods`, `/plugin marketplace add <repo folder>`, then `/plugin install model-router@<new>` (and `rtl-mode@<new>`). Do this before anyone else installs it.
```

- [ ] **Step 5: Check the name is only where the rename recipe expects, then commit**

```bash
cd /c/dev/llm/mods
grep -rn "llm-mods" --exclude-dir=.git --exclude-dir=docs .
```

Expected: only `.claude-plugin/marketplace.json` and the README install lines. Then:

```bash
cd /c/dev/llm/mods
git add .claude-plugin README.md model-router/README.md model-router/docs
git commit -m "docs: root marketplace, READMEs and the release checklist"
```

### Task 32: Final verification

**Files:** none new.

- [ ] **Step 1: Run every automated check from a clean state**

```bash
cd /c/dev/llm/mods
git status --short                                  # expect: nothing
(cd model-router && node --test "router/test/*.test.mjs")
claude plugin validate model-router
claude plugin validate rtl-mode
(cd model-router && npx -y -p typescript@5.6.3 tsc -p .)
claude plugin test model-router
claude plugin test rtl-mode
node model-router/e2e/run.mjs
```

Expected: every command succeeds; the router suite, both plugin test runs and all three e2e scenarios pass. Paste the summary lines (test counts, PASS lines) into the hand-off message.

- [ ] **Step 2: Check the spec one more time**

Walk spec §6–§9 and §12 against the code with `grep`, one line each: `/_router/status` fields, `/_router/limits`, `/_router/forget`, `/_router/shutdown?drain=1`, `/_router/policy` 501, `HEAD /api/hello`, the five event kinds the mod toasts, the status-line strings, the `/model` matrix, every `/router` subcommand, setup's six steps, doctor's checklist items. Anything missing is a bug: add a test, fix it, re-run Step 1.

- [ ] **Step 3: Hand off**

Use `superpowers:finishing-a-development-branch`. Do not push or merge without the human's word. Mention in the hand-off: the release checklist (`model-router/docs/release-checklist.md`) still needs a run with the real gateway and provider.





