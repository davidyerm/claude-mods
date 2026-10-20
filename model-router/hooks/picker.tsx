import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, On } from 'claude-code'
import { allRefs, FAMILIES, parseRef } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { PickerEntry, PickerState } from '../types'
import type { RouterStatus } from './client'
import { clearDefaultMainModel, display, loadConfig, pickedText, saveDefaultMainModel, updateConfig } from './config'
import { refresh, reprobe } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { clearPick, getPick, NOT_ACTIVE_TEXT, expectOwnModelChange, providerState, setPick } from './pick'

export const PICKER_PANE = 'model-router-picker'
// The debug-log line a refused scroll leaves: this, the row's key, the reason.
export const SCROLL_LOG = 'model-router: picker scroll to '
// read/update on this atom stay in this file (the engine allows them only beside the atom).
export const pickerAtom = atom({ plugin: 'model-router', key: 'picker' } as const, null as PickerState)

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

// Pure: the body rows the pane's content takes when drawn whole, which is what the
// pane asks for as it opens (`rows`): heading, subtitle lines, a blank line above
// and below the rows, the rows (a separator counted), a notice line, footer.
export function contentRows(state: NonNullable<PickerState>, columns = 80): number {
  const subtitle = paneSubtitle(state)
  const subtitleLines = subtitle ? Math.ceil(subtitle.length / Math.max(20, columns)) : 0
  return 1 + subtitleLines + 1 + pickerRows(state).length + (state.notice ? 1 : 0) + 1 + 1
}

export type FocusPlan =
  | { kind: 'pass' }
  | { kind: 'land'; cursor: string }
  | { kind: 'refocus'; cursor: string }

// Pure: what a move of the pane's focus ring does to the cursor. `values` are the
// entries in order, every one drawn. Onto a row: the cursor follows. Off the rows at
// either end (onto the engine's own stops): it wraps to the other end. A refocus
// keeps the ring where it is and moves it with $.ui.focus: the engine refuses a
// rewrite that names an element where the move named none.
export function planFocus({ values, cursor, element, isPerson }: { values: readonly string[]; cursor: string | undefined; element: string | undefined; isPerson: boolean }): FocusPlan {
  if (element !== undefined && values.includes(element)) return { kind: 'land', cursor: element }
  const go = (target: string | undefined): FocusPlan => (target === undefined ? { kind: 'pass' } : { kind: 'refocus', cursor: target })
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
  const state: NonNullable<PickerState> = { mode, view: { kind: 'main' }, entries, current, cursor: current ?? entries[0]?.value }
  await update($, pickerAtom, (): PickerState => state)
  // A dialog the person answers and leaves: it takes the keys, the arrows walk its
  // rows (it opens as tall as its content), toasts wait until it closes.
  await $.ui.open({ id: PICKER_PANE, title: mode === 'model' ? 'Select model' : 'model-router', focus: true, closeOnEscape: true, holdToasts: true, rows: contentRows(state) })
  if (state.cursor !== undefined) await scrollTo($, state.cursor)
  return {}
}

async function closePicker($: EngineInterface): Promise<void> {
  await update($, pickerAtom, () => null)
  await $.ui.close({ id: PICKER_PANE })
}

async function setCursor($: EngineInterface, cursor: string): Promise<void> {
  await update($, pickerAtom, (s): PickerState => s && { ...s, cursor })
}

// Bring a row into view in the pane: the pane draws every row and the engine
// scrolls its body. A refusal (the pane not drawn yet, a newer move) changes
// nothing else: it goes to the debug log only.
async function scrollTo($: EngineInterface, key: string): Promise<void> {
  let reason: string | undefined
  try {
    reason = (await $.ui.scroll({ in: PICKER_PANE, to: { key }, block: 'nearest' })).deny
  } catch (err) {
    reason = String(err)
  }
  if (reason !== undefined) $.ui.log(`${SCROLL_LOG}${key}: ${reason}`, { to: 'debug' })
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
  if (entry?.disabledReason) {
    // The toast waits behind the dialog (holdToasts): the pane says it now too.
    const notice = entry.disabledReason
    await update($, pickerAtom, (s): PickerState => s && { ...s, notice })
    await $.ui.toast(notice)
    return
  }
  const cut = value.indexOf(':')
  const kind = cut === -1 ? value : value.slice(0, cut)
  const rest = cut === -1 ? '' : value.slice(cut + 1)
  const paths = await getPaths($)

  switch (kind) {
    case 'claude': {
      await clearPick($)
      // /model mode: the Claude pick is the default again (router mode is session-only).
      if (state.mode === 'model') await clearDefaultMainModel($, paths)
      await closePicker($)
      await refresh($, m)
      if (rest !== (await $.session.model())) {
        // The mod makes this change itself: the tick must not read it as a built-in pick.
        await expectOwnModelChange($)
        await runCommand($, 'model', rest)
      }
      return
    }
    case 'routed': {
      await setPick($, rest)
      // /model mode: also the default for new sessions; router mode: this session only.
      const text = state.mode === 'model' ? pickedText(rest, (await saveDefaultMainModel($, paths, rest)).error) : `Main model: ${display(rest)}`
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
        await update($, pickerAtom, (s): PickerState => s && { ...s, view: { kind: 'family' }, entries, current: undefined, cursor: entries[0]?.value, notice: undefined })
        return
      }
      await closePicker($)
      await runCommand($, 'router', rest === 'add' ? 'add' : 'doctor')
      return
    }
    case 'family': {
      const { config } = await loadConfig($, paths)
      const entries = targetEntries(config)
      await update($, pickerAtom, (s): PickerState => s && { ...s, view: { kind: 'target', family: rest }, entries, current: undefined, cursor: entries[0]?.value, notice: undefined })
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
  on('ui.render', { component: 'Pane', requestId: PICKER_PANE }, async ($, e) => {
    // Mobile draws no Select or Input yet (types: Elements.mobile): a text fallback.
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Use /router Provider/model on this surface.</Text>
    }
    const state = await read($, pickerAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!state) return <Text dimColor>Nothing to pick. Run /model or /router.</Text>
    const props = e.props as { bodyColumns?: number }
    const columns = Math.max(20, props.bodyColumns ?? 80)
    // Every row is drawn: the engine scrolls a body taller than the pane, and the
    // focus ring can step onto any row.
    const rows = pickerRows(state)
    const cursor = cursorOf(state)
    const subtitle = paneSubtitle(state)
    // Descriptions line up after the longest label that has one (the actions have none).
    const width = Math.max(0, ...rows.map(r => (r.kind === 'entry' && r.description ? r.label.length : 0)))
    return (
      <Box flexDirection="column">
        <Text bold>{paneHeading(state)}</Text>
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        <Text> </Text>
        {rows.map((row, i) => row.kind === 'separator'
          ? <Text key={`sep${i}`} dimColor>{`  ${'─'.repeat(Math.max(4, Math.min(width + 4, columns - 4)))}`}</Text>
          : (
            <Box key={`row:${row.value}`} flexDirection="row">
              <Text>{row.value === cursor ? '❯ ' : '  '}</Text>
              {row.number > 9 ? <Text dimColor>{`${row.number}: `}</Text> : null}
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
        {state.notice ? <Text dimColor wrap="truncate">{`  ${state.notice}`}</Text> : null}
        <Text> </Text>
        <Text dimColor>{paneFooter(state)}</Text>
      </Box>
    )
  })

  // The arrows move the pane's focus ring over the row Buttons; the arrow mark
  // follows it, and the row it lands on is scrolled into view.
  on('ui.focus', { requestId: PICKER_PANE }, async ($, e, next) => {
    const state = await read($, pickerAtom)
    if (!state) return next(e)
    const plan = planFocus({ values: state.entries.map(x => x.value), cursor: cursorOf(state), element: e.element, isPerson: e.origin.kind === 'person' })
    if (plan.kind === 'pass') return next(e)
    // The cursor follows the ring only where the ring went.
    if (plan.kind === 'land') {
      const r = await next(e)
      if (r.deny !== undefined) return r
      // A move of our own (the wrap) set the cursor already; a late one must not undo a newer move.
      if (e.origin.kind === 'person') await setCursor($, plan.cursor)
      await scrollTo($, plan.cursor)
      return r
    }
    // The wrap: the mark moves to the other end and into view, and the ring is
    // asked to follow (its landing scrolls again). Neither ask is awaited: the
    // engine settles one move at a time and this one is still in flight.
    await setCursor($, plan.cursor)
    void scrollTo($, plan.cursor)
    void $.ui.focus({ requestId: PICKER_PANE, key: plan.cursor }).catch(() => {})
    return {}
  }).catch(($, e, next) => next(e))
}
