import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { PickerState } from '../types'
import { arrowTarget, contentRows, cursorOf, familyEntries, familyOf, paneFooter, paneHeading, paneSubtitle, PICKER_PANE, pickerEntries, pickerRows, planFocus, SCROLL_LOG } from '../hooks/picker'
import { CONFIG, CONFIG_JSON, PANE_PROPS, readJson, routerStatus, run, start, step, up, world } from './world'
import type { World, WorldOptions } from './world'
import type { On } from 'claude-code'
import type { RouterStatus } from '../hooks/client'

// Non-ASCII characters are spelled as escapes here (implementer rules).
const ARROW = '\u2192'
const CURSOR = '\u276f'
const CHECK = '\u2714'
const DOT = '\u00b7'
const ELLIPSIS = '\u2026'

const config = (validateConfig(CONFIG_JSON) as { ok: true; config: Config }).config
const entriesOf = (mode: 'model' | 'router', status = routerStatus(), pick: string | null = null) =>
  pickerEntries({ mode, config, status, sessionModel: 'claude-opus-5-5', pick })
const rowsOf = (mode: 'model' | 'router', status = routerStatus(), pick: string | null = null) =>
  entriesOf(mode, status, pick).map(e => [e.label, e.description ?? ''])
const stateOf = (mode: 'model' | 'router', patch: Partial<NonNullable<PickerState>> = {}): NonNullable<PickerState> =>
  ({ mode, view: { kind: 'main' }, entries: entriesOf(mode), current: 'claude:claude-opus-5-5', ...patch })

const OR_DOWN = routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'closed' }, { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' }] })

// -- pure: the entries ----------------------------------------------------

test('model mode: one row per Claude family (the session model stands for its own), each provider model, and the built-in picker', () => {
  expect(rowsOf('model')).toEqual([
    ['Opus', 'claude-opus-5-5'],
    ['Sonnet', 'claude-sonnet'],
    ['Haiku', `claude-haiku ${ARROW} [DS] ds-chat`],
    ['Fable', 'claude-fable'],
    ['[DS] ds-chat', 'via DS'],
    ['[DS] ds-reasoner', 'via DS'],
    ['[OR] anthropic/claude-x', 'via OR'],
    ['[OR] ds-chat', 'via OR'],
    [`Claude Code's picker${ELLIPSIS}`, 'the built-in /model picker'],
  ])
})

test('router mode adds the management actions as the last rows; model mode never does', () => {
  const entries = entriesOf('router')
  expect(entries.slice(-4).map(e => e.label)).toEqual([
    'Set the current pick as default for new sessions', `Override a Claude family${ELLIPSIS}`, `Add a provider${ELLIPSIS}`, 'Doctor',
  ])
  expect(entries.slice(-4).every(e => e.isAction === true)).toBe(true)
  expect(entriesOf('model').some(e => e.isAction)).toBe(false)
})

test('a paused and an unavailable provider say so in the description', () => {
  const s = routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'open' }, { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' }] })
  const all = rowsOf('model', s, 'DS/ds-chat')
  expect(all).toContainEqual(['[DS] ds-chat', `via DS ${DOT} paused`])
  expect(all).toContainEqual(['[OR] ds-chat', `via OR ${DOT} unavailable: env OR_KEY not set`])
})

test('an unwired session: every routed entry is disabled with the not-active reason', () => {
  const entries = pickerEntries({ mode: 'model', config, status: routerStatus(), sessionModel: 'claude-opus-5-5', pick: null, isWired: false })
  const routed = entries.filter(e => e.value.startsWith('routed:'))
  expect(routed.length).toBe(4)
  for (const e of routed) expect(e.description!.endsWith(`${DOT} not active (/router setup)`)).toBe(true)
  for (const e of routed) expect(e.disabledReason).toBe('model-router is not active in this session (ANTHROPIC_BASE_URL is not the router). Run /router setup, then restart Claude Code.')
  expect(entries.filter(e => !e.value.startsWith('routed:')).every(e => e.disabledReason === undefined)).toBe(true)
})

test('a session model that is an alias is listed once and keeps its override arrow', () => {
  const withOpus = { ...config, overrides: { ...config.overrides, opus: 'DS/ds-chat' } }
  const entries = pickerEntries({ mode: 'model', config: withOpus, status: routerStatus(), sessionModel: 'opus', pick: null })
  expect(entries[0]).toEqual({ value: 'claude:opus', label: 'Opus', description: `claude-opus ${ARROW} [DS] ds-chat` })
  expect(entries.filter(e => e.value === 'claude:opus').length).toBe(1)
})

test('familyOf reads the family from an id or an alias', () => {
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf('sonnet')).toBe('sonnet')
  expect(familyOf('claude-haiku-4-5-20251001')).toBe('haiku')
  expect(familyOf('gpt-x')).toBe(null)
})

test('headings, subtitles and footers', () => {
  expect(paneHeading(stateOf('model'))).toBe('Select model')
  expect(paneSubtitle(stateOf('model'))).toBe('Switch between Claude models and models from other providers. Applies to this session and future sessions.')
  expect(paneFooter(stateOf('model'))).toBe(`Enter to confirm ${DOT} Esc to exit ${DOT} manage: /router`)
  expect(paneHeading(stateOf('router'))).toBe('model-router')
  expect(paneSubtitle(stateOf('router'))).toBe("Applies to this session only; use 'Set the current pick as default' to keep it.")
  expect(paneFooter(stateOf('router'))).toBe(`Enter to confirm ${DOT} Esc to exit`)
  const family = stateOf('model', { view: { kind: 'family' }, entries: familyEntries(config) })
  expect(paneHeading(family)).toBe('Override which Claude family?')
  expect(paneSubtitle(family)).toBe(null)
  expect(paneFooter(family)).toBe(`Enter to confirm ${DOT} Esc to exit`)
})

// -- pure: rows, cursor, focus --------------------------------------

test('rows are numbered, the current one is checked, disabled ones are marked, actions sit below a separator', () => {
  const rows = pickerRows(stateOf('router', { entries: pickerEntries({ mode: 'router', config, status: OR_DOWN, sessionModel: 'claude-opus-5-5', pick: null }) }))
  const entries = rows.flatMap(r => (r.kind === 'entry' ? [r] : []))
  expect(entries.map(r => r.number)).toEqual(entries.map((_, i) => i + 1))
  expect(entries.filter(r => r.isCurrent).map(r => r.value)).toEqual(['claude:claude-opus-5-5'])
  expect(entries.filter(r => r.isDisabled).map(r => r.value)).toEqual(['routed:OR/anthropic/claude-x', 'routed:OR/ds-chat'])
  const sep = rows.findIndex(r => r.kind === 'separator')
  expect(rows.filter(r => r.kind === 'separator').length).toBe(1)
  expect(rows[sep + 1]).toMatchObject({ kind: 'entry', value: 'action:default' })
  expect(rows[sep - 1]).toMatchObject({ kind: 'entry', value: 'builtin' })
  expect(pickerRows(stateOf('model')).some(r => r.kind === 'separator')).toBe(false)
})

test('the cursor starts on the current entry, else the first; a stale cursor falls back', () => {
  expect(cursorOf(stateOf('model'))).toBe('claude:claude-opus-5-5')
  expect(cursorOf(stateOf('model', { current: undefined }))).toBe('claude:claude-opus-5-5')
  expect(cursorOf(stateOf('model', { current: 'routed:DS/ds-chat' }))).toBe('routed:DS/ds-chat')
  expect(cursorOf(stateOf('model', { cursor: 'claude:fable' }))).toBe('claude:fable')
  expect(cursorOf(stateOf('model', { cursor: 'gone', current: 'routed:DS/ds-chat' }))).toBe('routed:DS/ds-chat')
})

const VALUES = ['a', 'b', 'c', 'd', 'e']

test('focus: landing on a row moves the cursor there', () => {
  expect(planFocus({ values: VALUES, cursor: 'a', element: 'b', isPerson: true })).toEqual({ kind: 'land', cursor: 'b' })
})

test('focus: leaving the rows at either end wraps to the other end', () => {
  expect(planFocus({ values: VALUES, cursor: 'e', element: undefined, isPerson: true })).toEqual({ kind: 'refocus', cursor: 'a' })
  expect(planFocus({ values: VALUES, cursor: 'a', element: undefined, isPerson: true })).toEqual({ kind: 'refocus', cursor: 'e' })
})

test('focus: a move in the middle, or one a plugin makes, passes', () => {
  expect(planFocus({ values: VALUES, cursor: 'c', element: undefined, isPerson: true })).toEqual({ kind: 'pass' })
  expect(planFocus({ values: VALUES, cursor: 'e', element: undefined, isPerson: false })).toEqual({ kind: 'pass' })
})

test('arrows that would scroll the pane walk the rows instead, wrapping at the ends', () => {
  const arrow = (cursor: string | undefined, by: number) => arrowTarget({ values: VALUES, cursor, by, isPerson: true, hasPointer: false })
  expect(arrow('b', 1)).toBe('c')
  expect(arrow('b', -1)).toBe('a')
  expect(arrow('e', 1)).toBe('a')
  expect(arrow('a', -1)).toBe('e')
})

test('the wheel, the page keys, a plugin scroll, or no cursor scroll the pane as usual', () => {
  expect(arrowTarget({ values: VALUES, cursor: 'b', by: 1, isPerson: true, hasPointer: true })).toBe(null)
  expect(arrowTarget({ values: VALUES, cursor: 'b', by: 5, isPerson: true, hasPointer: false })).toBe(null)
  expect(arrowTarget({ values: VALUES, cursor: 'b', by: -5, isPerson: true, hasPointer: false })).toBe(null)
  expect(arrowTarget({ values: VALUES, cursor: 'b', by: 1, isPerson: false, hasPointer: false })).toBe(null)
  expect(arrowTarget({ values: VALUES, cursor: undefined, by: 1, isPerson: true, hasPointer: false })).toBe(null)
  expect(arrowTarget({ values: VALUES, cursor: 'gone', by: 1, isPerson: true, hasPointer: false })).toBe(null)
  expect(arrowTarget({ values: ['a'], cursor: 'a', by: 1, isPerson: true, hasPointer: false })).toBe(null)
})

test('contentRows: heading, subtitle lines, two blank lines, the rows with the separator, a notice, footer', () => {
  const sub = (s: NonNullable<PickerState>) => Math.ceil((paneSubtitle(s) ?? '').length / 80)
  const model = stateOf('model')
  expect(contentRows(model)).toBe(1 + sub(model) + 1 + 9 + 1 + 1)
  const router = stateOf('router')
  expect(contentRows(router)).toBe(1 + sub(router) + 1 + 13 + 1 + 1 + 1)
  expect(contentRows({ ...model, notice: 'why' })).toBe(contentRows(model) + 1)
  expect(contentRows(stateOf('model', { view: { kind: 'family' }, entries: familyEntries(config) }))).toBe(1 + 1 + 4 + 1 + 1)
})

// -- through the hooks ------------------------------------------------------

async function opened($: Engine, on: On, opts: WorldOptions & { status?: RouterStatus } = {}) {
  const w = world(on, opts)
  if (opts.status) up(w, opts.status)
  await start($)
  expect((await run($, 'router')).text).toBe(undefined)
  return w
}

const draw = ($: Engine, surface: RenderSurface = 'terminal', bodyRows = 30) =>
  $.ui.render({ surface, component: 'Pane', requestId: PICKER_PANE, props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows } } })

async function pick($: Engine, value: string) {
  await draw($)
  await $.ui.press({ plugin: 'model-router', key: value, surface: 'terminal' })
}

const focus = ($: Engine, element: string | undefined) =>
  $.ui.focus({ component: 'Pane', requestId: PICKER_PANE, plugin: 'model-router', ...(element !== undefined ? { element } : {}), origin: { kind: 'person' } })

// Where w.logs and w.scrolls stand now, for scrolledTo.
const mark = (w: World) => ({ logs: w.logs.length, scrolls: w.scrolls.length })

// The rows the mod asked $.ui.scroll to bring into view since `from`. Either record
// counts: today's kit routes no plugin's own $.ui.scroll to a hook beneath (it
// rejects "no implementation for ui.scroll"), so each ask is refused and its debug
// log line (SCROLL_LOG, the key, the reason) is how a test sees it. A kit that does
// route it records the ask in w.scrolls instead, its target as `to.key`.
const scrolledTo = (w: World, from: { logs: number; scrolls: number }) => [
  ...w.scrolls.slice(from.scrolls).flatMap(e => { const key = (e.to as { key?: unknown } | undefined)?.key; return typeof key === 'string' ? [key] : [] }),
  ...w.logs.slice(from.logs).flatMap(l => (l.startsWith(SCROLL_LOG) ? [l.slice(SCROLL_LOG.length).split(': ')[0]] : [])),
]

// The drawn row of an entry: the keyed Box holding the cursor mark, the Button and the check.
function rowOf(tree: unknown, value: string): string {
  let found: unknown
  const walk = (node: unknown) => {
    if (found || node === null || typeof node !== 'object') return
    if ((node as { props?: { key?: unknown } }).props?.key === `row:${value}`) { found = node; return }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v)
  }
  walk(tree)
  return found === undefined ? '' : JSON.stringify(found)
}

test('bare /router opens the picker pane', async ($, on) => {
  const w = await opened($, on)
  expect(w.opened).toEqual([PICKER_PANE])
})

test('the picker opens as a dialog: focused, closed by Esc, toasts held, as tall as its content', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'model')
  await run($, 'router')
  const model = { mode: 'model' as const, view: { kind: 'main' as const }, entries: entriesOf('model'), current: 'claude:claude-opus-5-5' }
  const router = { ...model, mode: 'router' as const, entries: entriesOf('router') }
  expect(w.openArgs).toEqual([
    { id: PICKER_PANE, title: 'Select model', focus: true, closeOnEscape: true, holdToasts: true, rows: contentRows(model) },
    { id: PICKER_PANE, title: 'model-router', focus: true, closeOnEscape: true, holdToasts: true, rows: contentRows(router) },
  ])
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

test('an unavailable entry is drawn dim, explains itself and keeps the pane open', async ($, on) => {
  const w = await opened($, on, { status: OR_DOWN })
  expect(rowOf(await draw($), 'routed:OR/ds-chat')).toContain('"dimColor":true')
  expect(rowOf(await draw($), 'routed:DS/ds-chat')).toContain('"dimColor":false')
  const toastsBefore = w.toasts.length
  await pick($, 'routed:OR/ds-chat')
  expect(w.toasts.slice(toastsBefore)).toEqual(['[OR] ds-chat is unavailable: env OR_KEY not set'])
  expect(w.closed).toEqual([])
  // the toast waits behind the dialog: the pane says it too
  expect(JSON.stringify(await draw($))).toContain('[OR] ds-chat is unavailable: env OR_KEY not set')
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
})

test('override flow: family, then target, in the same row style, writes the config', async ($, on) => {
  const w = await opened($, on)
  await pick($, 'action:override')
  const family = await draw($)
  expect(JSON.stringify(family)).toContain('Override which Claude family?')
  expect(rowOf(family, 'family:sonnet')).toContain('now Claude')
  expect(rowOf(family, 'family:haiku')).toContain('now [DS] ds-chat')
  expect(rowOf(family, 'family:haiku')).toContain(CURSOR)
  await pick($, 'family:sonnet')
  const target = await draw($)
  expect(JSON.stringify(target)).toContain('Send sonnet requests to:')
  expect(rowOf(target, 'target:clear')).toContain('clear the override')
  await pick($, 'target:OR/anthropic/claude-x')
  expect(readJson(w, CONFIG).overrides).toEqual({ haiku: 'DS/ds-chat', sonnet: 'OR/anthropic/claude-x' })
  expect(w.toasts.at(-1)).toBe(`sonnet ${ARROW} [OR] anthropic/claude-x (all sessions, from the next request)`)
  expect(w.closed).toEqual([PICKER_PANE])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: numbered rows with digit hotkeys, the cursor mark and the check on the current entry`, async ($, on) => {
    await opened($, on)
    const tree = await draw($, surface)
    const text = JSON.stringify(tree)
    expect(text).toContain('"model-router"')
    expect(text).toContain("Applies to this session only; use 'Set the current pick as default' to keep it.")
    expect(text).toContain(`Enter to confirm ${DOT} Esc to exit`)
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) expect(text).toContain(`"hotkey":"${n}"`)
    expect(text).not.toContain('"hotkey":"10"')
    const current = rowOf(tree, 'claude:claude-opus-5-5')
    expect(current).toContain(CURSOR)
    expect(current).toContain(CHECK)
    expect(current).toContain('"autoFocus":true')
    expect(current).toContain('claude-opus-5-5')
    const other = rowOf(tree, 'routed:DS/ds-chat')
    expect(other).toContain('via DS')
    expect(other).not.toContain(CURSOR)
    expect(other).not.toContain(CHECK)
    expect(rowOf(tree, 'action:doctor')).toContain('Doctor')
    expect(text).toContain('\u2500\u2500')
  })
}

test('a surface without a Select names the /router command instead', async ($, on) => {
  await opened($, on)
  expect(JSON.stringify(await draw($, 'mobile'))).toContain('Use /router Provider/model on this surface.')
})

test('with a pick the cursor and the check start on the routed entry', async ($, on) => {
  world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  await run($, 'router')
  const tree = await draw($)
  expect(rowOf(tree, 'routed:DS/ds-chat')).toContain(CURSOR)
  expect(rowOf(tree, 'routed:DS/ds-chat')).toContain(CHECK)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).not.toContain(CHECK)
})

test('the arrows: the focus ring moving onto a row moves the cursor mark there and scrolls it into view', async ($, on) => {
  const w = await opened($, on)
  await draw($)
  const before = mark(w)
  await focus($, 'claude:sonnet')
  expect(scrolledTo(w, before)).toEqual(['claude:sonnet'])
  const tree = await draw($)
  expect(rowOf(tree, 'claude:sonnet')).toContain(CURSOR)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).not.toContain(CURSOR)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).toContain(CHECK)
})

// The kit has no engine to answer the mod's own $.ui.focus (it throws "no
// implementation for ui.focus"), so the ring's own move onto the other end is
// refused here; a person checks the real move (field checks C2).
test('the arrows wrap: off the last row the hook keeps the ring and asks to scroll to the first row', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'model')
  await draw($)
  await focus($, 'builtin')
  const before = mark(w)
  expect(await focus($, undefined)).toEqual({})
  expect(scrolledTo(w, before)).toEqual(['claude:claude-opus-5-5'])
})

test('the arrows wrap: refused, the mark stays on the last row', async ($, on) => {
  world(on)
  await start($)
  await run($, 'model')
  await draw($)
  await focus($, 'builtin')
  expect(await focus($, undefined)).toEqual({})
  const tree = await draw($)
  expect(rowOf(tree, 'builtin')).toContain(CURSOR)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).not.toContain(CURSOR)
})

test('the /model pane: its title, subtitle and footer', async ($, on) => {
  world(on)
  await start($)
  await run($, 'model')
  const text = JSON.stringify(await draw($))
  expect(text).toContain('Select model')
  expect(text).toContain('Switch between Claude models and models from other providers. Applies to this session and future sessions.')
  expect(text).toContain(`Enter to confirm ${DOT} Esc to exit ${DOT} manage: /router`)
})

test('a short pane draws every row: the engine scrolls the body, the picker draws no window of its own', async ($, on) => {
  await opened($, on)
  const short = await draw($, 'terminal', 8)
  for (const e of entriesOf('router')) expect(rowOf(short, e.value)).toContain(e.label)
  const text = JSON.stringify(short)
  expect(text).toContain('"model-router"')
  expect(text).toContain("Applies to this session only; use 'Set the current pick as default' to keep it.")
  expect(text).toContain(`Enter to confirm ${DOT} Esc to exit`)
  expect(text).not.toContain(' more')
})

test('opening the picker scrolls the cursor row into view', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  const before = mark(w)
  await run($, 'router')
  expect(scrolledTo(w, before)).toEqual(['routed:DS/ds-chat'])
})

test('a pick no longer in the config leaves no entry checked', async ($, on) => {
  const w = world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-reasoner' } })
  await start($)
  const gone = { ...CONFIG_JSON, providers: [{ ...CONFIG_JSON.providers[0]!, models: [{ id: 'ds-chat' }] }, CONFIG_JSON.providers[1]!] }
  w.files.set(CONFIG, JSON.stringify(gone))
  await run($, 'router')
  const tree = await draw($)
  expect(JSON.stringify(tree)).not.toContain(CHECK)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).toContain(CURSOR)
})

test('a refused focus move leaves the cursor mark where it was and scrolls nothing', async ($, on) => {
  const w = await opened($, on)
  await draw($)
  w.focusDeny = 'x'
  const before = mark(w)
  await focus($, 'claude:sonnet')
  expect(scrolledTo(w, before)).toEqual([])
  const tree = await draw($)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).toContain(CURSOR)
  expect(rowOf(tree, 'claude:sonnet')).not.toContain(CURSOR)
})

test('rows from 10 on carry a dim number and a space, and no digit key', async ($, on) => {
  await opened($, on)
  const tree = await draw($)
  expect(rowOf(tree, 'action:default')).toContain('"10: "')
  expect(rowOf(tree, 'action:default')).not.toContain('"hotkey"')
})
