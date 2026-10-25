# model-router: field checks on the real environment

> **For Claude:** the human opened this session on the machine that uses the corporate gateway, to finish what the dev machine couldn't check. Read this whole file first. Then walk the human through it **one part at a time**:
> - Do the agent steps yourself.
> - Give the human the human steps as short numbered lists, and wait for their results before moving on.
> - Record every result in `docs/model-router-verification.md`.
> - For any FAIL, apply the change from the decision table (Part D).
> - Commit to the PR branch, and say which part comes next.
>
> Load the `plugin-authoring` skill before changing any mod code.

## Where things stand (2026-10-25)

- Branch `model-router`, PR https://github.com/davidyerm/claude-mods/pull/1. The PR is not merged.
- The plugin is fully built and passes on the dev machine:
  - router 112 tests, mod 231, rtl-mode 12
  - `tsc` clean
  - headless e2e 3/3
  - `claude plugin validate` passes
- **Done on the dev machine** (Claude Code 2.1.301–2.1.310; evidence in `docs/model-router-verification.md`):
  - V7: `#` survives in the model string.
  - V2: the session-id header matches `$.session.id()`, both headless and interactive.
  - V1 and V1b: the `/model` takeover answers, `next(e)` opens the built-in picker, and the picker's "Claude Code's picker…" row opens it too.
  - V3: the detached launcher survives hot reload and `/exit`.
  - V5: a built-in pick is visible through `$.session.model()`.
  - V6: settings writes need no prompt.
  - Part C (probe session) and Part C2 (picker look and keys), plus these real-terminal checks:
    - the band above the prompt next to rtl-mode;
    - routed picks saving the default for new sessions;
    - the breaker pausing a failing provider.
- **Open, on the real environment only:**
  - Part B (V4, gateway certificate trust).
  - Part E (release checklist with the real gateway and one real provider), including V2 for background calls: no title request reached the fake API, so check `router.log` there.
  - The final marketplace name.
  - Merging the PR.
- **If the real environment runs a different Claude Code version** than 2.1.310, re-run Part C2 there. The picker's keys depend on engine behaviour. Part C does not need re-running.
- Background:
  - spec: `docs/superpowers/specs/2026-10-16-model-router-design.md`
  - plan: `docs/superpowers/plans/2026-10-16-model-router.md` (Tasks 2–4 are what this file finishes)

## Part A: get the branch (human)

1. Clone the repo, or `git fetch` in an existing clone, then run `git checkout model-router && git pull`.
2. Check the tools: `node --version` should be 24.x; `claude --version` and `git --version` should work.
3. Open Claude Code in the repo folder and say: "continue the model-router field checks".

**Claude, agent step:** confirm that `git log --oneline -1` matches `origin/model-router`. Then run the router suite to check the environment:

```bash
cd model-router && node --test "router/test/*.test.mjs"
```

## Part B: V4, whether Node trusts the gateway certificate

**Agent steps:**

1. Find the gateway URL:

   ```bash
   node -e "const s=require(require('os').homedir()+'/.claude/settings.json');console.log((s.env&&s.env.ANTHROPIC_BASE_URL)||process.env.ANTHROPIC_BASE_URL||'')"
   ```

   If it prints nothing, ask the human for the gateway's https URL.
2. Run the check without and with the flag. Only a HEAD request is sent, with no credentials, so nothing secret is printed:

   ```bash
   env -u NODE_EXTRA_CA_CERTS node docs/model-router-spike/tls-check.mjs "$GW"
   env -u NODE_EXTRA_CA_CERTS node --use-system-ca docs/model-router-spike/tls-check.mjs "$GW"
   ```

3. Read the result:
   - **PASS:** the second line is `"ok":true`. The first may fail, for example with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
   - **PASS (not needed):** both lines are `ok:true`.
   - **FAIL:** the second line is `ok:false`.
4. Record the V4 row: the result, both output lines, and the decision. Use Part D for a FAIL.

## Part C: probe session for V1, V2 interactive, V3, V5, V6 (human, about 10 minutes)

> **Status: DONE on the dev machine (2026-10-17). All PASS; see the verification doc.** No need to re-run it on the real environment. The steps stay here for reference.

This runs against a **local fake API with a dummy key**. It touches no real account and doesn't need the gateway, so it can run on any machine. It just wasn't done on the dev machine.

**Claude: give the human these steps exactly, then wait for their paste.**

1. Window 1 (Git Bash): `cd <repo> && node docs/model-router-spike/capture-server.mjs`
2. Window 2: `cd <repo> && ANTHROPIC_BASE_URL=http://127.0.0.1:4199 ANTHROPIC_API_KEY=dummy claude --plugin-dir docs/model-router-spike/probe`
3. Type `hello` and wait for "spike-ok".
4. Type `/model probe-answer`. You should see "V1: answered by mr-probe".
5. Type `/model`. The **built-in** picker should open. Pick a **different** model, for example Sonnet.
6. Type `/probe builtin`. Does the built-in picker open? Do new `mr-probe: … /model args` lines appear? They should not.
7. Type `/probe settings`. Note the V6 line, and whether a permission prompt appeared. (It rewrites `~/.claude/settings.json` with identical text. Back the file up first if you like.)
8. Type `/probe launch`. Note the V3 line: the exit code and the milliseconds. Over 15000 ms means it hung.
9. Window 3: `curl -s http://127.0.0.1:4198/`. You should get "alive pid=…".
10. Add one blank line to `docs/model-router-spike/probe/hooks/register.ts` and save it. The mod hot-reloads. Run the curl again.
11. Type `/exit` in window 2, then run the curl again.
12. `curl -s http://127.0.0.1:4198/quit`, then press Ctrl+C in window 1.
13. Paste back every `mr-probe:` line from the transcript, plus your notes from steps 5–8 and the curl results.

**Agent steps after the paste:**

1. Check V2 interactive from the capture:

   ```bash
   grep -E '"path":"/v1/messages"' docs/model-router-spike/capture.jsonl | grep -o '"session":"[^"]*"' | sort | uniq -c
   ```

   **PASS** if every `/v1/messages` request, including the title request (it has no tools), carries the session id the probe logged.
2. Apply the pass criteria:
   - **V1 PASS:** step 4 printed the probe's answer **and** step 5 opened the built-in picker. Also note whether step 6 re-entered the probe's hook. The mod already guards against that by origin.
   - **V3 PASS:** step 8 exited 0 in under 5 s, and steps 9, 10 and 11 all answered `alive`.
   - **V5:** record which line showed the built-in pick: `after next(e)`, the 1 s `session.model changed` line, or neither. The mod's 2 s tick needs the `session.model` change to be visible.
   - **V6 PASS:** `$.fs.write OK` with no prompt. The product writes settings through `node router/launch.mjs write`, so a V6 FAIL matters only if running `node` through `$.process.run` itself prompted.
3. Record each row in `docs/model-router-verification.md`. Keep `capture.jsonl` and `stderr.txt` out of git; they are already in `docs/model-router-spike/.gitignore`.

## Part C2: the picker's look and keys (human, about 5 minutes)

> **Status: DONE on the dev machine (2026-10-20 to 2026-10-25, Claude Code 2.1.310). All PASS.**
> - ↑/↓ walk every row and wrap, and quick presses keep up.
> - Enter picks the ❯ row after a wrap or a scroll.
> - A digit picks a row even when it is scrolled out of view.
> - The band shows next to rtl-mode's toggle, and the yellow line appears only for problems. (Since then, on 2026-10-25, the band was removed: the mod shows nothing above the prompt, and a healthy session has an empty status line. Step 1 below checks this; it has not been re-run.)
> - In a very short window the title and the hint line scroll away with the rows.
>
> Re-run only if the real environment has a different Claude Code version.

The picker was rebuilt on 2026-10-17 to imitate the built-in `/model` picker. The tests check the tree it draws, not what a real terminal shows, so a person checks the keys. It needs a session with the mod loaded and at least one provider in `~/.claude/model-router.json`. The router does not need a real key.

The picker opens as a **dialog** (`focus`, `closeOnEscape`, `holdToasts`, and `rows` set to its content height). So it should open as tall as its content, ↑/↓ should walk the rows rather than scroll the pane, and any toast raised while it is open (for example a disabled row's reason) should appear only after it closes. A disabled row's reason also shows as a dim line in the pane.

**Claude: give the human these steps, then wait for their notes.**

1. Before opening the picker, look above the prompt (changed 2026-10-25). With a healthy router, model-router shows **nothing** there, and the status line has **no** yellow `⚠ model-router: …` entry. That status line appears only for a problem:
   - DOWN;
   - not active while something is routed;
   - a paused or unavailable provider, listing only that pick or override.

   With rtl-mode loaded, its `RTL ON`/`RTL OFF` toggle still shows above the prompt. Then, in a **tall** terminal (40+ rows), type `/model`. Check:
   - the title "Select model", the dim subtitle, numbered rows, and the footer `Enter to confirm · Esc to exit · manage: /router`;
   - `✔` and `❯` on the current model.
2. Press ↓ a few times. `❯` should follow the highlighted row. At the last row ↓ should wrap to the first; at the first row ↑ should wrap to the last. After a wrap and after a scroll, press Enter: the row chosen must be the one marked ❯. (Then undo the pick: `/router claude`, or `/model sonnet` and the step 5 check if it was a `/model` routed pick.)
3. Press Esc. The pane closes and nothing changes.
4. Type `/model` again and press a digit, e.g. `2`. That row should be chosen at once.
5. Type `/model`, move to a routed row and press Enter. The toast should say `(also the default for new sessions)`, and `~/.claude/model-router.json` now holds `"defaultMainModel"`. Then type `/model sonnet` to undo it. A toast should say `Default for new sessions: back to Claude (removed [P] m)`.
   - Check: `defaultMainModel` is gone from `~/.claude/model-router.json`. If it was set before this check, put it back with `/router default <model>`.
6. With a disabled row (for example a provider whose key is unset, so it is "unavailable"), check that it is dim, keeps its reason, and that choosing it only toasts the reason.
7. Shrink the terminal to about 12 rows and type `/router` (changed 2026-10-20: the picker draws every row and the pane scrolls; there are no `↑ more` / `↓ more` rows). Press ↓ repeatedly: `❯` should move one row at a time through **all** rows down to `Doctor`, the pane scrolling so the `❯` row stays in view, without getting stuck. At the last row ↓ should wrap to the first row, and the pane should scroll back to the top. ↑ from the first row should wrap to the last. After a wrap and after a scroll, press Enter: the row chosen must be the one marked ❯. Then scroll back to the top and press a digit for a row that is scrolled out of view (for example `8`): note whether that row is chosen. The engine documents that digits arm only the Buttons inside the visible window, so it may do nothing; record which.
8. Note anything that differs: the engine draws `1:` (not `1.`) before each row; rows past 9 show a dim `10: ` and have no digit key.

Record the result as row "C2 picker" in `docs/model-router-verification.md`. If the arrows only scroll the pane and don't move between rows, note it: the fallback is digit keys plus Tab, and the fix is to draw the rows in a `Client` surface module.

## Part D: decision table (Claude applies this for any FAIL)

The plan's Task 4 table, adjusted to the code as built. V1, V2, V3, V5, V6 and V7 have passed, so only the V4 row can still apply. The other rows apply only if a re-run on a different Claude Code version fails.

| Failed | Change |
|---|---|
| V1 | `hooks/register.tsx`: bare `/model` always goes to `next(e)` (drop the picker takeover). Keep the `/model <routed name>` catch. Remove `userConfig.takeOverModelCommand` from `.claude-plugin/plugin.json` and its tests. |
| V2 | `hooks/status.ts` `isForSession` returns `true` for every event. `toastFor` prefixes session-scoped events with `(other session?) ` when `ev.session !== sessionId`. |
| V3 | `router/launch.mjs` `start()`: on win32, launch through `cmd.exe /c start "" /b <node> <flags> router.mjs` instead of `spawn(..., { detached: true })`. Re-run Part C steps 8–11 against it. |
| V4 | `router/launch.mjs` `nodeFlags()` returns `[]`. The doctor fix text already says to set `NODE_EXTRA_CA_CERTS`. Make the README's Security section say the CA must be exported to a PEM file. |
| V5 | `hooks/register.tsx`: for bare `/model` with the toggle off, clear the pick before `next(e)`, as already done for `/model <name>`. |
| V6 | Only if `$.process.run` prompted: setup prints the exact JSON to paste instead of writing it. |

After any change, run all the checks:

```bash
cd model-router && node --test "router/test/*.test.mjs" && cd ..
claude plugin validate model-router
(cd model-router && npx -y -p typescript@5.6.3 tsc -p .)
claude plugin test model-router
node model-router/e2e/run.mjs
```

For `tsc`, copy this build's API types to `model-router/.claude-plugin/types/claude-code/index.d.ts` first. The `plugin-authoring` skill header names the file. Commit and push to `model-router` so PR #1 updates.

## Part E: release checklist on the real environment (human + Claude)

Work through `model-router/docs/release-checklist.md`. This needs a real provider key, e.g. DeepSeek.

1. **Human:** install from the repo folder:
   - `/plugin marketplace add <repo folder>`
   - `/plugin install model-router@llm-mods`
2. **Human:** put the provider key in `~/.claude/settings.json` `"env"` (e.g. `"DEEPSEEK_API_KEY": "…"`), then run `/router setup` and restart Claude Code.
3. **Human:** run `/router doctor`. **Claude** reads the report and fixes or explains each ✗/⚠.
4. **Human:** run `/router add` (or edit `~/.claude/model-router.json`), then `/model <Provider/model>`, and send a prompt.
5. Then the checklist items:
   - overrides reach background calls (title, `/compact`), which shows in `~/.claude/model-router/router.log`
   - the token TTL with `apiKeyHelper`
   - two parallel sessions
   - uninstall with `defaultMainModel` set
   - settings env (keys and `ANTHROPIC_CUSTOM_HEADERS`) reaching the detached router
   - **Claude:** capture the real provider's `max_tokens` error text into `model-router/router/test/fixtures/limit-errors.json`, then re-run the router tests
6. Decide the final marketplace name. `llm-mods` is a working name; the rename recipe is in the checklist.

## Part F: finish

Once every V row is PASS, or FAIL with its change applied and tested, and the checklist is done:

- update the PR description's "Not done yet" section;
- merge PR #1 (the human's call);
- delete the git-ignored `.superpowers/sdd/2026-10-16-model-router/` folder if it exists. It only exists on the dev machine.

## Known follow-ups (not blocking)

These were left open from the reviews:

- `/router doctor` probes port 4141 while the config file is invalid.
- Doctor suggests `/router restart` even when the running router is newer than the plugin. A restart would downgrade it.
- The e2e script runs with the real `~/.claude` and environment (not isolated), and doesn't clean up its temp folders.
- The `/router add` key field is not masked (an engine limitation), and the draft stays in state after Esc.
- `parseMaxTokensLimit` takes the largest number below the requested value, which is a heuristic. `/router forget` undoes a wrong guess.
- The picker:
  - In a very short window, its title and hint line scroll away with the rows.
  - Its dialog height (`rows`) assumes an 80-column subtitle.
  - A burst of arrow presses that the engine merges into one move of 2+ rows scrolls the pane instead of walking. This was not seen in practice.
- Breaker state, the 5-minute pause, lives in router memory, so a router restart (for example after its 30-minute idle exit) clears it. This is as designed.
- Claude Code retries a failed request by itself, so one prompt can count as three provider failures and pause the provider at once.
