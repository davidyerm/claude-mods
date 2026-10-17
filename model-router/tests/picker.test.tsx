import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { PickerState } from '../types'
import { cursorOf, familyEntries, familyOf, MORE_DOWN, MORE_UP, paneFooter, paneHeading, paneLayout, paneSubtitle, PICKER_PANE, pickerEntries, pickerRows, planFocus } from '../hooks/picker'
import { CONFIG, CONFIG_JSON, PANE_PROPS, readJson, routerStatus, run, start, step, up, world } from './world'
import type { WorldOptions } from './world'
import type { On } from 'claude-code'
import type { RouterStatus } from '../hooks/client'

// Non-ASCII characters are spelled as escapes here (implementer rules).
const ARROW = '→'
const CURSOR = '❯'
const CHECK = '✔'
const DOT = '·'
const ELLIPSIS = '…'

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

// -- pure: rows, cursor, window, focus --------------------------------------

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

test('layout: a tall pane shows every row and the subtitle', () => {
  expect(paneLayout({ rowCount: 9, cursorRow: 0, bodyRows: 20, subtitleLines: 2 })).toEqual({ showSubtitle: true, start: 0, end: 9, hasAbove: false, hasBelow: false })
  expect(paneLayout({ rowCount: 40, cursorRow: 0, subtitleLines: 2 })).toEqual({ showSubtitle: true, start: 0, end: 40, hasAbove: false, hasBelow: false })
})

test('layout: a short pane drops the subtitle first, then windows the rows around the cursor; heading and footer always fit', () => {
  // 9 rows + 2 subtitle lines + 4 = 15 > 12: the subtitle goes, and 10 rows of room hold all 9
  expect(paneLayout({ rowCount: 9, cursorRow: 0, bodyRows: 12, subtitleLines: 2 })).toEqual({ showSubtitle: false, start: 0, end: 9, hasAbove: false, hasBelow: false })
  for (const bodyRows of [3, 4, 6, 8, 10, 12, 15]) {
    for (let cursorRow = 0; cursorRow < 15; cursorRow++) {
      const l = paneLayout({ rowCount: 15, cursorRow, bodyRows, subtitleLines: 2 })
      expect(l.showSubtitle).toBe(false)
      const used = 2 + (l.end - l.start) + (l.hasAbove || l.hasBelow ? 2 : 0)
      expect(used <= Math.max(bodyRows, 2 + 1 + 2)).toBe(true)
      expect(cursorRow >= l.start && cursorRow < l.end).toBe(true)
      expect(l.hasAbove).toBe(l.start > 0)
      expect(l.hasBelow).toBe(l.end < 15)
    }
  }
  // the cursor keeps a row on each side while it is away from the ends
  expect(paneLayout({ rowCount: 15, cursorRow: 7, bodyRows: 7, subtitleLines: 2 })).toEqual({ showSubtitle: false, start: 6, end: 9, hasAbove: true, hasBelow: true })
})

const VALUES = ['a', 'b', 'c', 'd', 'e']

test('focus: landing on a row moves the cursor there', () => {
  expect(planFocus({ values: VALUES, drawn: VALUES, cursor: 'a', element: 'b', isPerson: true })).toEqual({ kind: 'land', cursor: 'b' })
})

test('focus: leaving the rows at either end wraps to the other end', () => {
  expect(planFocus({ values: VALUES, drawn: VALUES, cursor: 'e', element: undefined, isPerson: true })).toEqual({ kind: 'redirect', cursor: 'a' })
  expect(planFocus({ values: VALUES, drawn: VALUES, cursor: 'a', element: undefined, isPerson: true })).toEqual({ kind: 'redirect', cursor: 'e' })
  // windowed: the other end is not drawn yet
  expect(planFocus({ values: VALUES, drawn: ['c', 'd', 'e'], cursor: 'e', element: undefined, isPerson: true })).toEqual({ kind: 'refocus', cursor: 'a' })
})

test('focus: the scroll hints step the cursor past the window', () => {
  expect(planFocus({ values: VALUES, drawn: ['b', 'c', 'd'], cursor: 'd', element: MORE_DOWN, isPerson: true })).toEqual({ kind: 'refocus', cursor: 'e' })
  expect(planFocus({ values: VALUES, drawn: ['b', 'c', 'd'], cursor: 'b', element: MORE_UP, isPerson: true })).toEqual({ kind: 'refocus', cursor: 'a' })
})

test('focus: a move in the middle, or one a plugin makes, passes', () => {
  expect(planFocus({ values: VALUES, drawn: VALUES, cursor: 'c', element: undefined, isPerson: true })).toEqual({ kind: 'pass' })
  expect(planFocus({ values: VALUES, drawn: VALUES, cursor: 'e', element: undefined, isPerson: false })).toEqual({ kind: 'pass' })
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
    expect(text).toContain('──')
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

test('the arrows: the focus ring moving onto a row moves the cursor mark there', async ($, on) => {
  await opened($, on)
  await draw($)
  await focus($, 'claude:sonnet')
  const tree = await draw($)
  expect(rowOf(tree, 'claude:sonnet')).toContain(CURSOR)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).not.toContain(CURSOR)
  expect(rowOf(tree, 'claude:claude-opus-5-5')).toContain(CHECK)
})

test('the arrows wrap: off the last row onto the first, off the first onto the last', async ($, on) => {
  world(on)
  await start($)
  await run($, 'model')
  await draw($)
  await focus($, 'builtin')
  await focus($, undefined)
  expect(rowOf(await draw($), 'claude:claude-opus-5-5')).toContain(CURSOR)
  await focus($, undefined)
  expect(rowOf(await draw($), 'builtin')).toContain(CURSOR)
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

test('a short pane keeps the heading and the footer and windows the rows around the cursor', async ($, on) => {
  await opened($, on)
  const short = JSON.stringify(await draw($, 'terminal', 8))
  expect(short).toContain('"model-router"')
  expect(short).toContain(`Enter to confirm ${DOT} Esc to exit`)
  expect(short).toContain('↓ more')
  expect(short).not.toContain('Doctor')
  expect(short).not.toContain('Applies to this session only')
  // stepping onto the hint scrolls: the next row is drawn and carries the cursor
  await focus($, MORE_DOWN)
  const after = await draw($, 'terminal', 8)
  expect(JSON.stringify(after)).toContain('↑ more')
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
