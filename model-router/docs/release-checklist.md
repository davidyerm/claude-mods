# model-router release checklist (manual)

Spec §10.5. Run on Windows with the real corporate gateway and one real provider.

- [ ] Run Task 3's probe session (V1, V2 interactive, V3, V5, V6) and V4 against the real gateway if not yet recorded in docs/model-router-verification.md.
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
- [ ] Marketplace name final? `llm-mods` is a working name. To rename it to `<new>`: set `name` in the repo root's `.claude-plugin/marketplace.json`, then replace every occurrence of `llm-mods` (the `@llm-mods` install lines and the `# llm-mods` title of the root README included) in `README.md`, `rtl-mode/README.md` (if any) and `model-router/README.md` (`grep -rn "llm-mods" --include=*.md --include=*.json .` must show only the new name afterwards). On a machine that already installed from it: `/plugin marketplace remove llm-mods`, `/plugin marketplace add <repo folder>`, then `/plugin install model-router@<new>` (and `rtl-mode@<new>`). Do this before anyone else installs it.
- [ ] rtl-mode migration: if rtl-mode was installed from its old own marketplace, run `/plugin marketplace remove rtl-mode`, `/plugin marketplace add <repo folder>`, `/plugin install rtl-mode@llm-mods`.
