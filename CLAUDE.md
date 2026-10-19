# llm-mods

Claude Code mods: `rtl-mode/` and `model-router/`, listed in the root `.claude-plugin/marketplace.json`.

- If asked to continue the model-router verification or field checks, read `docs/model-router-field-checks.md` first and follow it.
- Load the `plugin-authoring` skill before changing any mod code under `*/hooks/`.
- Router tests: `cd model-router && node --test "router/test/*.test.mjs"`. Mod tests: `claude plugin test model-router`.
