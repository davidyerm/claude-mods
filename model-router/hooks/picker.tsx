import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, On } from 'claude-code'
import { allRefs, FAMILIES, parseRef } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { PickerEntry, PickerState } from '../types'
import type { RouterStatus } from './client'
import { display, loadConfig, pickedText, saveDefaultMainModel, unsavedClearText, updateConfig } from './config'
import { refresh, reprobe } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { clearPick, getPick, NOT_ACTIVE_TEXT, providerState, setPick } from './pick'

export const PICKER_PANE = 'model-router-picker'
// read/update on this atom stay in this file (the engine allows them only beside the atom).
export const pickerAtom = atom({ plugin: 'model-router', key: 'picker' } as const, null as PickerState)

// The keys of the two scroll hints: Buttons, so the focus ring can step onto them.
export const MORE_UP = 'more:up'
export const MORE_DOWN = 'more:down'

type EntriesInput = { mode: 'model' | 'router'; config: Config; status: RouterStatus | null; sessionModel: string; pick: string | null; isWired?: boolean }

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Pure: the Claude family a model id belongs to (`claude-opus-5-5` is opus), or null.
export function familyOf(model: string): string | null {
  const id = model.toLowerCase()
  return ALIASES.find(f => id === f || id.split(/[-.:]/).includes(f)) ?? null
}

export function pickerEntries({ mode, config, status, sessionModel, pick, isWired = true }: EntriesInput): PickerEntry[] {
  const arrow = (alias: string | null) => { const ref = alias ? (config.overrides as Record<string, string | undefined>)[alias] : undefined; return ref ? ` → ${display(ref)}` : '' }
  const family = familyOf(sessionModel)
  const sessionId = ALIASES.includes(sessionModel as typeof ALIASES[number]) ? `claude-${sessionModel}` : sessionModel
  // The session's own model stands for its family: the family's alias is not listed again.
  const entries: PickerEntry[] = [{ value: `claude:${sessionModel}`, label: family ? capital(family) : sessionModel, description: `${sessionId}${arrow(family)}` }]
  for (const alias of ALIASES) {
    if (alias === family) continue
    entries.push({ value: `claude:${alias}`, label: capital(alias), description: `claude-${alias}${arrow(alias)}` })
  }
  for (const ref of allRefs(config)) {
    const state = providerState(status, ref)
    const provider = parseRef(ref)?.provider ?? ref
    const reason = status?.providers.find(p => ref.startsWith(`${p.name}/`))?.reason ?? 'not available'
    const via = `via ${provider}`
    if (!isWired) entries.push({ value: `routed:${ref}`, label: display(ref), description: `${via} · not active (/router setup)`, disabledReason: NOT_ACTIVE_TEXT })
    else if (state === 'unavailable') entries.push({ value: `routed:${ref}`, label: display(ref), description: `${via} · unavailable: ${reason}`, disabledReason: `${display(ref)} is unavailable: ${reason}` })
    else entries.push({ value: `routed:${ref}`, label: display(ref), description: state === 'paused' ? `${via} · paused` : via })
  }
  entries.push({ value: 'builtin', label: "Claude Code's picker…", description: 'the built-in /model picker' })
  if (mode === 'router') entries.push(
    { value: 'action:default', label: 'Set the current pick as default for new sessions', isAction: true },
    { value: 'action:override', label: 'Override a Claude family…', isAction: true },
    { value: 'action:add', label: 'Add a provider…', isAction: true },
    { value: 'action:doctor', label: 'Doctor', isAction: true },
  )
  return entries
}

export const familyEntries = (config: Config): PickerEntry[] =>
  FAMILIES.map(f => ({ value: `family:${f}`, label: f, description: `now ${config.overrides[f] ? display(config.overrides[f]!) : 'Claude'}` }))

export const targetEntries = (config: Config): PickerEntry[] => [
  { value: 'target:clear', label: 'Claude', description: 'clear the override' },
  ...allRefs(config).map(ref => ({ value: `target:${ref}`, label: display(ref), description: `via ${parseRef(ref)?.provider ?? ref}` })),
]

// Pure: the pane's heading, the dim line under it, and its footer for a picker state.
export function paneHeading(state: NonNullable<PickerState>): string {
  if (state.view.kind === 'family') return 'Override which Claude family?'
  if (state.view.kind === 'target') return `Send ${state.view.family} requests to:`
  return state.mode === 'model' ? 'Select model' : 'model-router'
}

export function paneSubtitle(state: NonNullable<PickerState>): string | null {
  if (state.view.kind !== 'main') return null
  return state.mode === 'model'
    ? 'Switch between Claude models and models from other providers. Applies to this session and future sessions.'
    : "Applies to this session only; use 'Set the current pick as default' to keep it."
}

export function paneFooter(state: NonNullable<PickerState>): string {
  return state.mode === 'model' && state.view.kind === 'main' ? 'Enter to confirm · Esc to exit · manage: /router' : 'Enter to confirm · Esc to exit'
}

export type PickerRow =
  | { kind: 'entry'; value: string; number: number; label: string; description: string; isCurrent: boolean; isDisabled: boolean }
  | { kind: 'separator' }

// Pure: the rows drawn, numbered from 1; a separator above the first action row.
export function pickerRows(state: NonNullable<PickerState>): PickerRow[] {
  const rows: PickerRow[] = []
  state.entries.forEach((e, i) => {
    if (e.isAction && !state.entries[i - 1]?.isAction) rows.push({ kind: 'separator' })
    rows.push({ kind: 'entry', value: e.value, number: i + 1, label: e.label, description: e.description ?? '', isCurrent: e.value === state.current, isDisabled: e.disabledReason !== undefined })
  })
  return rows
}

// Pure: the row the arrow is on: the cursor, else the current entry, else the first.
export function cursorOf(state: NonNullable<PickerState>): string | undefined {
  const values = state.entries.map(e => e.value)
  if (state.cursor !== undefined && values.includes(state.cursor)) return state.cursor
  if (state.current !== undefined && values.includes(state.current)) return state.current
  return values[0]
}

export type PaneLayout = { showSubtitle: boolean; start: number; end: number; hasAbove: boolean; hasBelow: boolean }

// Pure: which rows fit the pane. The heading and the footer always show; the
// subtitle and its blank lines go first in a short pane, then the rows are
// windowed around the cursor with a hint row above and below.
export function paneLayout({ rowCount, cursorRow, bodyRows, subtitleLines }: { rowCount: number; cursorRow: number; bodyRows?: number; subtitleLines: number }): PaneLayout {
  const all = (showSubtitle: boolean): PaneLayout => ({ showSubtitle, start: 0, end: rowCount, hasAbove: false, hasBelow: false })
  // heading, subtitle lines, a blank line above and below the rows, footer
  if (bodyRows === undefined || rowCount + subtitleLines + 4 <= bodyRows) return all(true)
  // heading and footer alone
  const room = bodyRows - 2
  if (rowCount <= room) return all(false)
  // two rows for the scroll hints
  const size = Math.max(1, room - 2)
  const cursor = Math.min(Math.max(cursorRow, 0), rowCount - 1)
  const start = Math.min(Math.max(cursor - Math.floor((size - 1) / 2), 0), rowCount - size)
  const end = start + size
  return { showSubtitle: false, start, end, hasAbove: start > 0, hasBelow: end < rowCount }
}

export type FocusPlan =
  | { kind: 'pass' }
  | { kind: 'land'; cursor: string }
  | { kind: 'redirect'; cursor: string }
  | { kind: 'refocus'; cursor: string }

// Pure: what a move of the pane's focus ring does to the cursor. `values` are the
// entries in order, `drawn` those drawn now. Onto a row: the cursor follows. Onto a
// scroll hint: the cursor steps past the window (refocus: drawn after the redraw).
// Off the rows at either end (the engine's own stops): it wraps to the other end.
export function planFocus({ values, drawn, cursor, element, isPerson }: { values: readonly string[]; drawn: readonly string[]; cursor: string | undefined; element: string | undefined; isPerson: boolean }): FocusPlan {
  if (element !== undefined && values.includes(element)) return { kind: 'land', cursor: element }
  const go = (target: string | undefined): FocusPlan => (target === undefined ? { kind: 'pass' } : drawn.includes(target) ? { kind: 'redirect', cursor: target } : { kind: 'refocus', cursor: target })
  if (element === MORE_UP) return go(values[values.indexOf(drawn[0] ?? '') - 1])
  if (element === MORE_DOWN) { const last = values.indexOf(drawn.at(-1) ?? ''); return last === -1 ? { kind: 'pass' } : go(values[last + 1]) }
  if (!isPerson || cursor === undefined || values.length < 2) return { kind: 'pass' }
  const at = values.indexOf(cursor)
  if (at === values.length - 1) return go(values[0])
  if (at === 0) return go(values.at(-1))
  return { kind: 'pass' }
}

export async function openPicker($: EngineInterface, m: Monitor, mode: 'model' | 'router'): Promise<CommandRunResult> {
  const { config } = await loadConfig($, await getPaths($))
  const sessionModel = await $.session.model()
  const pick = await getPick($)
  const entries = pickerEntries({ mode, config, status: m.status, sessionModel, pick, isWired: m.isWired })
  const wanted = pick === null ? `claude:${sessionModel}` : `routed:${pick}`
  const current = entries.some(e => e.value === wanted) ? wanted : undefined
  await update($, pickerAtom, (): PickerState => ({ mode, view: { kind: 'main' }, entries, current, cursor: current ?? entries[0]?.value }))
  await $.ui.open({ id: PICKER_PANE, title: mode === 'model' ? 'Select model' : 'model-router', focus: true, closeOnEscape: true })
  return {}
}

async function closePicker($: EngineInterface): Promise<void> {
  await update($, pickerAtom, () => null)
  await $.ui.close({ id: PICKER_PANE })
}

async function setCursor($: EngineInterface, cursor: string): Promise<void> {
  await update($, pickerAtom, (s): PickerState => s && { ...s, cursor })
}

// The cursor moves past the window: redraw, then put the ring on the new row.
async function stepTo($: EngineInterface, cursor: string): Promise<void> {
  await setCursor($, cursor)
  await $.ui.focus({ requestId: PICKER_PANE, key: cursor }).catch(() => ({}))
}

async function runCommand($: EngineInterface, command: string, args = ''): Promise<void> {
  try {
    await $.command.run({ command, args })
  } catch (err) {
    await $.ui.toast(`/${command} ${args}: ${String(err)}`)
  }
}

export async function choose($: EngineInterface, m: Monitor, value: string): Promise<void> {
  const state = await read($, pickerAtom)
  if (!state) return
  const entry = state.entries.find(e => e.value === value)
  if (entry?.disabledReason) { await $.ui.toast(entry.disabledReason); return }
  const cut = value.indexOf(':')
  const kind = cut === -1 ? value : value.slice(0, cut)
  const rest = cut === -1 ? '' : value.slice(cut + 1)
  const paths = await getPaths($)

  switch (kind) {
    case 'claude': {
      await clearPick($)
      // /model mode: the Claude pick is the default again (router mode is session-only).
      if (state.mode === 'model') {
        const clearError = unsavedClearText(await saveDefaultMainModel($, paths, null))
        if (clearError) await $.ui.toast(clearError)
      }
      await closePicker($)
      await refresh($, m)
      if (rest !== (await $.session.model())) await runCommand($, 'model', rest)
      return
    }
    case 'routed': {
      await setPick($, rest)
      // /model mode: also the default for new sessions; router mode: this session only.
      const text = state.mode === 'model' ? pickedText(rest, await saveDefaultMainModel($, paths, rest)) : `Main model: ${display(rest)}`
      await closePicker($)
      await reprobe($, m)
      await refresh($, m)
      await $.ui.toast(text)
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
        if (pick === null) { await $.ui.toast('Pick a routed model first, then set it as the default'); return }
        const r = await updateConfig($, paths, raw => { raw.defaultMainModel = pick })
        await $.ui.toast(r.ok ? `Default main model for new sessions: ${display(pick)}` : r.message)
        await closePicker($)
        return
      }
      if (rest === 'override') {
        const { config } = await loadConfig($, paths)
        const entries = familyEntries(config)
        await update($, pickerAtom, (s): PickerState => s && { ...s, view: { kind: 'family' }, entries, current: undefined, cursor: entries[0]?.value })
        return
      }
      await closePicker($)
      await runCommand($, 'router', rest === 'add' ? 'add' : 'doctor')
      return
    }
    case 'family': {
      const { config } = await loadConfig($, paths)
      const entries = targetEntries(config)
      await update($, pickerAtom, (s): PickerState => s && { ...s, view: { kind: 'target', family: rest }, entries, current: undefined, cursor: entries[0]?.value })
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
      await $.ui.toast(r.ok ? `${family} → ${rest === 'clear' ? 'Claude' : display(rest)} (all sessions, from the next request)` : r.message)
      await closePicker($)
      await refresh($, m)
      return
    }
  }
}

export function registerPicker(on: On, m: Monitor): void {
  // The entries the last drawing showed, for the focus hook's window arithmetic.
  let drawn: string[] = []

  on('ui.render', { component: 'Pane', requestId: PICKER_PANE }, async ($, e) => {
    // Mobile draws no Select or Input yet (types: Elements.mobile): a text fallback.
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Use /router Provider/model on this surface.</Text>
    }
    const state = await read($, pickerAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!state) return <Text dimColor>Nothing to pick. Run /model or /router.</Text>
    const props = e.props as { scroll?: { bodyRows?: number }; bodyColumns?: number }
    const columns = Math.max(20, props.bodyColumns ?? 80)
    const rows = pickerRows(state)
    const cursor = cursorOf(state)
    const subtitle = paneSubtitle(state)
    const layout = paneLayout({
      rowCount: rows.length,
      cursorRow: rows.findIndex(r => r.kind === 'entry' && r.value === cursor),
      bodyRows: props.scroll?.bodyRows,
      subtitleLines: subtitle ? Math.ceil(subtitle.length / columns) : 0,
    })
    const shown = rows.slice(layout.start, layout.end)
    drawn = shown.flatMap(r => (r.kind === 'entry' ? [r.value] : []))
    // Descriptions line up after the longest label that has one (the actions have none).
    const width = Math.max(0, ...rows.map(r => (r.kind === 'entry' && r.description ? r.label.length : 0)))
    const step = (target: string | undefined) => { if (target !== undefined) void stepTo($, target) }
    const values = state.entries.map(x => x.value)
    return (
      <Box flexDirection="column">
        <Text bold>{paneHeading(state)}</Text>
        {subtitle && layout.showSubtitle ? <Text dimColor>{subtitle}</Text> : null}
        {layout.showSubtitle ? <Text> </Text> : null}
        {layout.hasAbove ? <Button key={MORE_UP} plain dimColor onPress={() => step(values[values.indexOf(drawn[0] ?? '') - 1])}>{'  ↑ more'}</Button> : null}
        {shown.map((row, i) => row.kind === 'separator'
          ? <Text key={`sep${i}`} dimColor>{`  ${'─'.repeat(Math.max(4, Math.min(width + 4, columns - 4)))}`}</Text>
          : (
            <Box key={`row:${row.value}`} flexDirection="row">
              <Text>{row.value === cursor ? '❯ ' : '  '}</Text>
              {row.number > 9 ? <Text dimColor>{`${row.number}:`}</Text> : null}
              <Button
                key={row.value}
                plain
                {...(row.number <= 9 ? { hotkey: String(row.number) } : {})}
                {...(row.value === cursor ? { autoFocus: true as const } : {})}
                dimColor={row.isDisabled}
                onPress={() => void choose($, m, row.value)}
              >
                {row.description ? row.label.padEnd(width + 2) : row.label}
                <Text dimColor>{row.description}</Text>
              </Button>
              {row.isCurrent ? <Text> ✔</Text> : null}
            </Box>
          ))}
        {layout.hasBelow ? <Button key={MORE_DOWN} plain dimColor onPress={() => step(values[values.indexOf(drawn.at(-1) ?? '') + 1])}>{'  ↓ more'}</Button> : null}
        {layout.showSubtitle ? <Text> </Text> : null}
        <Text dimColor>{paneFooter(state)}</Text>
      </Box>
    )
  })

  // The arrows move the pane's focus ring over the row Buttons; the arrow mark follows it.
  on('ui.focus', { requestId: PICKER_PANE }, async ($, e, next) => {
    const state = await read($, pickerAtom)
    if (!state) return next(e)
    const plan = planFocus({ values: state.entries.map(x => x.value), drawn, cursor: cursorOf(state), element: e.element, isPerson: e.origin.kind === 'person' })
    if (plan.kind === 'pass') return next(e)
    if (plan.kind === 'land') { await setCursor($, plan.cursor); return next(e) }
    if (plan.kind === 'redirect') { await setCursor($, plan.cursor); return next({ ...e, element: plan.cursor }) }
    void stepTo($, plan.cursor)
    return {}
  }).catch(($, e, next) => next(e))
}
