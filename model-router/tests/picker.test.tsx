import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import { familyEntries, paneFooter, paneHeading, PICKER_PANE, pickerEntries } from '../hooks/picker'
import { CONFIG, CONFIG_JSON, PANE_PROPS, readJson, routerStatus, run, start, step, up, world } from './world'
import type { WorldOptions } from './world'
import type { On } from 'claude-code'
import type { RouterStatus } from '../hooks/client'

const config = (validateConfig(CONFIG_JSON) as { ok: true; config: Config }).config
const labels = (mode: 'model' | 'router', status = routerStatus(), pick: string | null = null) =>
  pickerEntries({ mode, config, status, sessionModel: 'claude-opus-5-5', pick }).map(e => e.label)

const OR_DOWN = routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'closed' }, { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' }] })

// ── pure: the entries ──────────────────────────────────────────────────────

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
  expect(all).toContain('[DS] ds-chat (current) \u2014 ⚠  paused')
  expect(all).toContain('[OR] ds-chat \u2014 unavailable: env OR_KEY not set')
})

test('an unwired session: every routed entry carries the not-active reason', () => {
  const entries = pickerEntries({ mode: 'model', config, status: routerStatus(), sessionModel: 'claude-opus-5-5', pick: null, isWired: false })
  const routed = entries.filter(e => e.value.startsWith('routed:'))
  expect(routed.length).toBe(4)
  expect(routed.map(e => e.label)).toEqual(['[DS] ds-chat \u2014 not active (/router setup)', '[DS] ds-reasoner \u2014 not active (/router setup)', '[OR] anthropic/claude-x \u2014 not active (/router setup)', '[OR] ds-chat \u2014 not active (/router setup)'])
  for (const e of routed) expect(e.disabledReason).toBe('model-router is not active in this session (ANTHROPIC_BASE_URL is not the router). Run /router setup, then restart Claude Code.')
  expect(entries.filter(e => !e.value.startsWith('routed:')).every(e => e.disabledReason === undefined)).toBe(true)
})

// The model-mode footer: /model (Task 25) opens the pane in model mode; its render test lands there.
test('model mode main view has the "manage: /router" footer; router mode and the sub-views do not', () => {
  const entries = pickerEntries({ mode: 'model', config, status: routerStatus(), sessionModel: 'claude-opus-5-5', pick: null })
  expect(paneFooter({ mode: 'model', view: { kind: 'main' }, entries })).toBe('manage: /router')
  expect(paneHeading({ mode: 'model', view: { kind: 'main' }, entries })).toBe('Main model for this session')
  expect(paneFooter({ mode: 'router', view: { kind: 'main' }, entries })).toBe(null)
  expect(paneFooter({ mode: 'model', view: { kind: 'family' }, entries: familyEntries(config) })).toBe(null)
})

// ── through the hooks: bare /router opens the pane in router mode ──────────

async function opened($: Engine, on: On, opts: WorldOptions & { status?: RouterStatus } = {}) {
  const w = world(on, opts)
  if (opts.status) up(w, opts.status)
  await start($)
  expect((await run($, 'router')).text).toBe(undefined)
  return w
}

const draw = ($: Engine, surface: RenderSurface = 'terminal') =>
  $.ui.render({ surface, component: 'Pane', requestId: PICKER_PANE, props: { ...PANE_PROPS } })

async function pick($: Engine, value: string) {
  await draw($)
  await $.ui.select({ plugin: 'model-router', key: 'picker', value, surface: 'terminal' })
}

test('bare /router opens the picker pane', async ($, on) => {
  const w = await opened($, on)
  expect(w.opened).toEqual([PICKER_PANE])
})

test('picking a routed model sets the pick and closes the pane', async ($, on) => {
  const w = await opened($, on)
  const toastsBefore = w.toasts.length
  await pick($, 'routed:OR/anthropic/claude-x')
  expect(w.closed).toEqual([PICKER_PANE])
  expect(w.toasts.slice(toastsBefore)).toEqual(['Main model: [OR] anthropic/claude-x'])
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:OR/anthropic/claude-x#claude-opus-5-5')
})

test('picking a Claude alias clears the pick and runs the built-in /model with it', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  await run($, 'router')
  await pick($, 'claude:sonnet')
  expect(w.commands).toEqual([{ command: 'model', args: 'sonnet', origin: 'plugin' }])
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
})

test("Claude Code's picker entry runs the built-in /model bare", async ($, on) => {
  const w = await opened($, on)
  await pick($, 'builtin')
  expect(w.commands).toEqual([{ command: 'model', args: '', origin: 'plugin' }])
  expect(w.closed).toEqual([PICKER_PANE])
})

test('an unavailable entry explains itself and keeps the pane open', async ($, on) => {
  const w = await opened($, on, { status: OR_DOWN })
  const toastsBefore = w.toasts.length
  await pick($, 'routed:OR/ds-chat')
  expect(w.toasts.slice(toastsBefore)).toEqual(['[OR] ds-chat is unavailable: env OR_KEY not set'])
  expect(w.closed).toEqual([])
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
})

test('override flow: family, then target, writes the config', async ($, on) => {
  const w = await opened($, on)
  await pick($, 'action:override')
  const family = JSON.stringify(await draw($))
  expect(family).toContain('Override which Claude family?')
  expect(family).toContain('sonnet (now Claude)')
  expect(family).toContain('haiku (now [DS] ds-chat)')
  await pick($, 'family:sonnet')
  expect(JSON.stringify(await draw($))).toContain('Send sonnet requests to:')
  await pick($, 'target:OR/anthropic/claude-x')
  expect(readJson(w, CONFIG).overrides).toEqual({ haiku: 'DS/ds-chat', sonnet: 'OR/anthropic/claude-x' })
  expect(w.toasts.at(-1)).toBe('sonnet → [OR] anthropic/claude-x (all sessions, from the next request)')
  expect(w.closed).toEqual([PICKER_PANE])
})

test('the pane draws a Select on every surface that has one', async ($, on) => {
  await opened($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const text = JSON.stringify(await draw($, surface))
    expect(text).toContain('[DS] ds-chat')
    expect(text).toContain('Set the current pick as default for new sessions')
    expect(text).not.toContain('manage: /router')
  }
})

test('a surface without a Select names the /router command instead', async ($, on) => {
  await opened($, on)
  expect(JSON.stringify(await draw($, 'mobile'))).toContain('Use /router Provider/model on this surface.')
})

test('the heading is the Select label, the value is the current entry, and no "none" shows', async ($, on) => {
  await opened($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const text = JSON.stringify(await draw($, surface))
    expect(text).toContain('"label":"model-router"')
    expect(text).toContain('"value":"claude:claude-opus-5-5"')
    expect(text).not.toContain('none')
  }
})

test('with a pick the Select value is the routed entry', async ($, on) => {
  world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  await run($, 'router')
  const text = JSON.stringify(await draw($))
  expect(text).toContain('"value":"routed:DS/ds-chat"')
  expect(text).toContain('"label":"model-router"')
})

test('the footer is drawn only when the pane has room for it', async ($, on) => {
  world(on)
  await start($)
  await run($, 'model')
  const tall = JSON.stringify(await draw($))
  expect(tall).toContain('manage: /router')
  const short = JSON.stringify(await $.ui.render({ surface: 'terminal', component: 'Pane', requestId: PICKER_PANE, props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 6 } } }))
  expect(short).not.toContain('manage: /router')
  expect(short).toContain('Main model for this session')
})

test('a pick no longer in the config leaves the Select value undefined', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-reasoner' } })
  await start($)
  const gone = { ...CONFIG_JSON, providers: [{ ...CONFIG_JSON.providers[0]!, models: [{ id: 'ds-chat' }] }, CONFIG_JSON.providers[1]!] }
  w.files.set(CONFIG, JSON.stringify(gone))
  await run($, 'router')
  const text = JSON.stringify(await draw($))
  expect(text).not.toContain('"value":"routed:DS/ds-reasoner"')
  expect(text).toContain('"label":"model-router","autoFocus":true')
})

test('a session model that is an alias is listed once', () => {
  const values = pickerEntries({ mode: 'model', config, status: routerStatus(), sessionModel: 'opus', pick: null }).map(e => e.value)
  expect(values.filter(v => v === 'claude:opus')).toEqual(['claude:opus'])
})

test('a session model that is an alias keeps its override arrow on the session row', () => {
  const withOpus = { ...config, overrides: { ...config.overrides, opus: 'DS/ds-chat' } }
  const entries = pickerEntries({ mode: 'model', config: withOpus, status: routerStatus(), sessionModel: 'opus', pick: null })
  expect(entries[0]).toEqual({ value: 'claude:opus', label: 'Claude · opus (current) → [DS] ds-chat' })
  expect(entries.filter(e => e.value === 'claude:opus').length).toBe(1)
})
