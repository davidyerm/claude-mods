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

`/router add` asks for a name, the base URL, the API key and the model IDs, then makes a test call. The key field accepts either the **name of an environment variable** holding the key (preferred) or the key itself; a literal key is stored in plain text in the config file, and `/router doctor` warns about it. Or edit `~/.claude/model-router.json`:

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

Each provider has exactly one of `apiKeyEnv` (a variable name) or `apiKey` (a literal key). `strip` lists headers and body fields the provider rejects (the default is shown). `/router doctor` names the field a provider rejects.

The router reads the key variable from the environment it was started in. Put keys in `~/.claude/settings.json` `"env"` (or your OS environment), restart Claude Code, then `/router restart`.

## Commands

| Command | What it does |
|---|---|
| `/model` | Claude models and `[Provider] model` entries in one list (turn off with the `takeOverModelCommand` option). A pick of either kind is also the default for new sessions |
| `/model <model>` | Switch to a routed model; it also becomes the default for new sessions |
| `/router` | The same list plus: set default, override a family, add a provider, doctor. Picks here are for this session only |
| `/router <model>` / `/router claude` | Set / clear this session's main model (this session only) |
| `/router default <model\|clear>` | Main model for new sessions |
| `/router override <family> <model\|clear>` | Send a Claude family to a model, in every session |
| `/router add` / `/router remove <provider\|provider/model>` | Manage providers |
| `/router setup` / `/router uninstall` | Wire Claude Code to the router, or undo it |
| `/router doctor [--offline]` | Check everything, with a fix for each problem; `--offline` skips the test requests to providers |
| `/router forget <provider/model\|all>` | Forget learned output limits |
| `/router restart` | Restart the router (picks up new keys) |

## How it behaves

- **Output limits.** Claude Code asks for more output tokens than many providers allow. When a provider says so, the router learns the limit, retries once, and remembers it until the router restarts (`[DeepSeek] max output 8192 learned`).
- **Failures.** A provider that fails before its first byte (connection, timeout, 429, 5xx, a rejected field) falls back to Claude. Three failures in a row pause it for 5 minutes (`[DeepSeek] ⚠  paused`). A failure mid-answer is shown as an error, not retried.
- **Several sessions** share one router. It starts with the first session and exits after 30 idle minutes.
- **Context windows** of routed models are unknown to Claude Code, so its context % and auto-compact use defaults. The separate `model-limits` plugin (planned) will handle that.
- **The picker** looks like Claude Code's own: numbered rows with a dim description, `✔` on the current model and `❯` on the cursor. ↑/↓ move (wrapping at the ends), Enter or a digit 1–9 chooses, Esc closes. Unavailable entries are dim and say why. A short terminal shows a window of rows with `↑ more` / `↓ more`.
- **`/model` picks persist, `/router` picks don't.** A pick through `/model` becomes the default for new sessions, as the built-in picker's does: a routed pick sets `defaultMainModel`, and a Claude pick (in the picker, `/model <name>`, or the built-in picker) removes it. `/router <model>` and the `/router` picker change only the current session; `/router default` sets the default explicitly. If the default can't be saved, the pick still applies and the confirmation says why.
- Claude Code may log `[claude-code:unrecognized_model]` for routed models; that is expected.

## Security

- The router listens on `127.0.0.1` only.
- Provider keys are used only for requests that carry the local token `/router setup` adds to `ANTHROPIC_CUSTOM_HEADERS` (so other local programs cannot spend your provider credit).
- Your gateway credentials are never sent to a provider: routed requests lose `authorization`, `x-api-key`, the session id and `metadata` before the provider's own key is set.
- Logs (`~/.claude/model-router/`) never hold prompts, answers or keys.
- If your network inspects TLS, provider traffic is visible to it like any other HTTPS traffic. On Windows the router trusts the Windows certificate store and `NODE_EXTRA_CA_CERTS`.

## Uninstall

`/router uninstall` restores `~/.claude/settings.json` from the backup setup made, then restart Claude Code. By hand: set `env.ANTHROPIC_BASE_URL` back (or remove it) and remove the `x-router-token` line from `env.ANTHROPIC_CUSTOM_HEADERS`.

## Development

```
node --test "model-router/router/test/*.test.mjs"   # router
claude plugin test model-router                      # mod
node model-router/e2e/run.mjs                        # headless end to end
```
