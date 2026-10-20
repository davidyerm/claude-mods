import { expect, test } from 'claude-code/testing'
import { band, BAND_PROPS, CONFIG, CONFIG_JSON, down, routerStatus, run, start, step, up, world } from './world'

// Hook-driven tests of register.tsx: session.start, turn.step and the monitor
// timers. State is observed through effects only (mod-testing-ruling.md).

const PLAIN_LINE = 'router: /router to pick · haiku→[DS] ds-chat'
const DOWN = 'model-router DOWN — /router doctor'

// --- session start (Task 23 brief, Task 20 ensureRouter) ---

test('session start registers /router, finds the router and draws the status line', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered).toContain('router')
  expect(w.runs.length).toBe(0)
  expect(await band($)).toBe(PLAIN_LINE)
  expect(w.statusLines.at(-1)).toBe(undefined)
})

test('session start launches a missing router; a failed launch shows DOWN', async ($, on) => {
  const w = world(on, { isRouterUp: false })
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'node not found' } : undefined)
  await start($)
  expect(w.statusLines.at(-1)).toBe(DOWN)
  expect(await band($)).toBe(null)
})

test('session start: a down router is launched once through start and then used', async ($, on) => {
  const w = world(on, { isRouterUp: false, config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  await start($)
  expect(w.runs.map(r => r.argv.slice(2))).toEqual([['start']])
  expect(await band($)).toBe('main: [DS] ds-chat \u00b7 haiku\u2192[DS] ds-chat')
  expect(w.statusLines.at(-1)).toBe(undefined)
  await step($)
  expect(w.stepModels).toEqual(['router:DS/ds-chat#claude-opus-5-5'])
})

test('session start: a foreign program on the port is not launched over; the reason is logged and the line is DOWN', async ($, on) => {
  const w = world(on, { isRouterUp: false })
  w.http.set('GET /_router/status', () => ({ status: 200, json: { hello: 'world' } }))
  await start($)
  expect(w.runs.length).toBe(0)
  expect(w.logs).toContain('model-router: port 4141 is used by another program; set "port" in model-router.json')
  expect(w.statusLines.at(-1)).toBe(DOWN)
  expect(await band($)).toBe(null)
})

test('session start: another router version is handed to the launcher, and the new status is used', async ($, on) => {
  const w = world(on, { isRouterUp: false })
  // The old router has DS paused; the launcher replaces it with ours (DS closed).
  up(w, routerStatus({ version: '0.0.9', providers: [{ name: 'DS', available: true, breaker: 'open' }] }))
  w.tool = sub => {
    if (sub !== 'start') return undefined
    up(w)
    return { ok: true, started: true, pid: 42 }
  }
  await start($)
  expect(w.runs.map(r => r.argv.slice(2))).toEqual([['start']])
  expect(await band($)).toBe(PLAIN_LINE)
  expect(w.statusLines.at(-1)).toBe(undefined)
})

// --- pick state (Task 21) and turn.step ---

test('defaultMainModel becomes the pick once, not again after a reload', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-reasoner' } })
  await start($)
  await step($)
  expect(w.stepModels).toEqual(['router:DS/ds-reasoner#claude-opus-5-5'])
  await $.command.run({ command: 'router', args: 'claude', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
  await start($)
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
  expect(await band($)).toBe(PLAIN_LINE)
  expect(w.statusLines.at(-1)).toBe(undefined)
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

test('/router claude clears the pick: the next step carries the Claude id', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  await start($)
  await step($)
  await run($, 'router', 'claude')
  await step($)
  expect(w.stepModels).toEqual(['router:DS/ds-chat#claude-opus-5-5', 'claude-opus-5-5'])
})

// --- monitor (Task 22), through the mock clock ---

test('the 2 s tick toasts this session\'s events once, and skips other sessions', async ($, on) => {
  const w = world(on)
  await start($)
  w.events.push(
    { seq: 1, t: 't', kind: 'learned', session: 'sess-1', provider: 'DS', text: '8192' },
    { seq: 2, t: 't', kind: 'learned', session: 's2', provider: 'DS', text: '8192' },
  )
  await w.clock.advance(2000)
  await w.clock.advance(2000)
  expect(w.toasts).toEqual(['[DS] max output 8192 learned'])
})

test('a restarted router (lower event seq) replays no toast and resets the cursor', async ($, on) => {
  const w = world(on, { isRouterUp: false })
  up(w, routerStatus({ eventsSeq: 50 }))
  await start($)
  w.events.push({ seq: 1, t: 't', kind: 'learned', session: 'sess-1', provider: 'DS', text: '8192' })
  await w.clock.advance(2000)
  expect(w.toasts).toEqual([])
  w.events.push({ seq: 2, t: 't', kind: 'breaker-close', session: 'sess-1', provider: 'DS' })
  await w.clock.advance(2000)
  expect(w.toasts).toEqual(['[DS] resumed'])
})

test('a pick removed from the config file is cleared with a toast on the next tick', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-reasoner' } })
  await start($)
  const config = { ...CONFIG_JSON, providers: [{ ...CONFIG_JSON.providers[0]!, models: [{ id: 'ds-chat' }] }, CONFIG_JSON.providers[1]!] }
  w.files.set(CONFIG, JSON.stringify(config))
  await w.clock.advance(2000)
  expect(w.toasts).toContain('[DS] ds-reasoner was removed — main model back to Claude')
  await step($)
  expect(w.stepModels).toEqual(['claude-opus-5-5'])
})

test('a Claude model picked in /model clears the pick on the next tick', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  await start($)
  w.model = 'claude-sonnet-5-5'
  await w.clock.advance(2000)
  expect(w.toasts).toContain('Main model back to Claude (claude-sonnet-5-5 picked in /model)')
  expect(await band($)).toBe(PLAIN_LINE)
  expect(w.statusLines.at(-1)).toBe(undefined)
})

test('the 10 s health timer respawns the router', async ($, on) => {
  const w = world(on)
  await start($)
  down(w)
  await w.clock.advance(10_000)
  expect(w.toasts).toContain('model-router restarted')
  expect(w.runs.map(r => r.argv.slice(2))).toEqual([['start']])
  expect(await band($)).toBe(PLAIN_LINE)
  expect(w.statusLines.at(-1)).toBe(undefined)
})

test('the 10 s health timer shows DOWN when the respawn fails', async ($, on) => {
  const w = world(on)
  await start($)
  down(w)
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'node not found' } : undefined)
  await w.clock.advance(10_000)
  expect(w.toasts).not.toContain('model-router restarted')
  expect(w.statusLines.at(-1)).toBe(DOWN)
  expect(await band($)).toBe(null)
})

test('session start: a failed launch on a reload drops the old status, so the pick is not routed', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  await start($)
  down(w)
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'node not found' } : undefined)
  await start($)
  expect(w.statusLines.at(-1)).toBe(DOWN)
  expect(await band($)).toBe(null)
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
})

// --- a session that is not wired through the router (final fix I1) ---

const NOT_ACTIVE_LINE = 'router: not active — /router setup, then restart Claude Code'
const NOT_ACTIVE = 'model-router is not active in this session (ANTHROPIC_BASE_URL is not the router). Run /router setup, then restart Claude Code.'

for (const [name, value] of [['unset', undefined], ['a gateway', 'https://gw.example']] as const) {
  test(`unwired (${name}): steps are unchanged even with defaultMainModel set, and the status line says not active`, async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_BASE_URL: value }, config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
    await start($)
    await step($)
    expect(w.stepModels).toEqual(['claude-opus-5-5'])
    expect(w.statusLines.at(-1)).toBe(NOT_ACTIVE_LINE)
    expect(await band($)).toBe(null)
  })

  test(`unwired (${name}): /router and /model with a routed name refuse and set no pick`, async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_BASE_URL: value } })
    await start($)
    expect((await run($, 'router', 'DS/ds-chat')).text).toBe(NOT_ACTIVE)
    expect((await run($, 'model', 'DS/ds-chat')).text).toBe(NOT_ACTIVE)
    await step($)
    expect(w.stepModels).toEqual(['claude-opus-5-5'])
    expect(w.statusLines.at(-1)).toBe(NOT_ACTIVE_LINE)
    expect(await band($)).toBe(null)
  })
}

test('unwired: the default is not used up, so a start after setup still applies it once', async ($, on) => {
  const w = world(on, { env: { ANTHROPIC_BASE_URL: 'https://gw.example' }, config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  await start($)
  w.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4141'
  await start($)
  await step($)
  expect(w.stepModels).toEqual(['router:DS/ds-chat#claude-opus-5-5'])
})

for (const value of ['http://127.0.0.1:4141', 'http://localhost:4141/', 'http://127.0.0.1:4141/']) {
  test(`wired (${value}): everything routes as before`, async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_BASE_URL: value }, config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
    await start($)
    expect(await band($)).toBe('main: [DS] ds-chat \u00b7 haiku\u2192[DS] ds-chat')
    expect(w.statusLines.at(-1)).toBe(undefined)
    await step($)
    expect((await run($, 'router', 'DS/ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner')
    await step($)
    expect(w.stepModels).toEqual(['router:DS/ds-chat#claude-opus-5-5', 'router:DS/ds-reasoner#claude-opus-5-5'])
  })
}

test('an invalid config with a valid port: the router is ensured and monitored on that port (final fix I4)', async ($, on) => {
  const w = world(on, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000' }, config: { ...CONFIG_JSON, port: 5000, overrides: { haiku: 'Nope/x' } } })
  await start($)
  await w.clock.advance(10_000)
  const statusUrls = w.fetches.filter(f => f.url.includes('/_router/status')).map(f => f.url)
  expect(statusUrls.length).toBeGreaterThan(1)
  expect(statusUrls.every(u => u.startsWith('http://127.0.0.1:5000/'))).toBe(true)
  expect(await band($)).toBe('router: /router to pick')
  expect(w.statusLines.at(-1)).toBe(undefined)
})

// --- a just-added provider routes at once (final fix I5) ---

test('a pick whose provider is missing from the status still routes once a status is known', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  up(w, routerStatus({ providers: [{ name: 'OR', available: true, breaker: 'closed' }] }))
  await start($)
  await step($)
  expect(w.stepModels).toEqual(['router:DS/ds-chat#claude-opus-5-5'])
})

test('a pick re-probes the router: the new state shows without a clock advance', async ($, on) => {
  const w = world(on)
  await start($)
  up(w, routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'open' }, { name: 'OR', available: true, breaker: 'closed' }] }))
  await run($, 'router', 'DS/ds-chat')
  expect(w.statusLines.at(-1)).toBe('main: [DS] ⚠  paused · haiku→[DS] ⚠  paused')
  expect(await band($)).toBe(null)
  await step($)
  expect(w.stepModels).toEqual(['claude-opus-5-5'])
})

// --- the band above the prompt holds normal info; the status line only problems (2026-10-20) ---

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a healthy pick shows in the band, dim, and the status line is empty`, async ($, on) => {
    const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
    await start($)
    expect(await band($, { surface })).toBe('main: [DS] ds-chat \u00b7 haiku\u2192[DS] ds-chat')
    const tree = await $.ui.render({ surface, component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(JSON.stringify(tree)).toContain('"dimColor":true')
    expect(w.statusLines.at(-1)).toBe(undefined)
  })
}

test('a survey holds the band: the plugin draws nothing there', async ($, on) => {
  world(on)
  await start($)
  expect(await band($)).toBe(PLAIN_LINE)
  expect(await band($, { hasSurvey: true })).toBe(null)
})

test('a paused override provider: the status line carries the line, the band draws nothing', async ($, on) => {
  const w = world(on, { isRouterUp: false })
  up(w, routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'open' }, { name: 'OR', available: true, breaker: 'closed' }] }))
  await start($)
  expect(w.statusLines.at(-1)).toBe('router: /router to pick \u00b7 haiku\u2192[DS] \u26a0  paused')
  expect(await band($)).toBe(null)
})

test('an unavailable pick provider: the status line carries the line, the band draws nothing', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, overrides: {} } })
  up(w, routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'closed' }, { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' }] }))
  await start($)
  await run($, 'router', 'OR/ds-chat')
  expect(w.statusLines.at(-1)).toBe('main: [OR] \u26a0  unavailable')
  expect(await band($)).toBe(null)
})

test('a problem that clears: the status line empties and the band shows the line again', async ($, on) => {
  const w = world(on)
  await start($)
  down(w)
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'node not found' } : undefined)
  await w.clock.advance(10_000)
  expect(w.statusLines.at(-1)).toBe(DOWN)
  expect(await band($)).toBe(null)
  w.tool = () => undefined
  await w.clock.advance(10_000)
  expect(w.statusLines.at(-1)).toBe(undefined)
  expect(await band($)).toBe(PLAIN_LINE)
})
