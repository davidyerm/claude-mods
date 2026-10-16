import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, On } from 'claude-code'
import { allRefs, FAMILIES } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { PickerEntry, PickerState } from '../types'
import type { RouterStatus } from './client'
import { display, loadConfig, updateConfig } from './config'
import { refresh, reprobe } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { clearPick, getPick, NOT_ACTIVE_TEXT, providerState, setPick } from './pick'

export const PICKER_PANE = 'model-router-picker'
// read/update on this atom stay in this file (the engine allows them only beside the atom).
export const pickerAtom = atom({ plugin: 'model-router', key: 'picker' } as const, null as PickerState)

type EntriesInput = { mode: 'model' | 'router'; config: Config; status: RouterStatus | null; sessionModel: string; pick: string | null; isWired?: boolean }

export function pickerEntries({ mode, config, status, sessionModel, pick, isWired = true }: EntriesInput): PickerEntry[] {
  const entries: PickerEntry[] = [{ value: `claude:${sessionModel}`, label: `Claude · ${sessionModel}${pick === null ? ' (current)' : ''}` }]
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable'] as const) {
    const ref = config.overrides[alias]
    entries.push({ value: `claude:${alias}`, label: `Claude · ${alias}${ref ? ` → ${display(ref)}` : ''}` })
  }
  for (const ref of allRefs(config)) {
    const state = providerState(status, ref)
    const reason = status?.providers.find(p => ref.startsWith(`${p.name}/`))?.reason ?? 'not available'
    const current = ref === pick ? ' (current)' : ''
    if (!isWired) entries.push({ value: `routed:${ref}`, label: `${display(ref)}${current}`, disabledReason: NOT_ACTIVE_TEXT })
    else if (state === 'unavailable') entries.push({ value: `routed:${ref}`, label: `${display(ref)}${current} — unavailable: ${reason}`, disabledReason: `${display(ref)} is unavailable: ${reason}` })
    else entries.push({ value: `routed:${ref}`, label: `${display(ref)}${current}${state === 'paused' ? ' — ⚠  paused' : ''}` })
  }
  entries.push({ value: 'builtin', label: "Claude Code's picker…" })
  if (mode === 'router') entries.push(
    { value: 'action:default', label: 'Set the current pick as default for new sessions' },
    { value: 'action:override', label: 'Override a Claude family…' },
    { value: 'action:add', label: 'Add a provider…' },
    { value: 'action:doctor', label: 'Doctor' },
  )
  return entries
}

export const familyEntries = (config: Config): PickerEntry[] =>
  FAMILIES.map(f => ({ value: `family:${f}`, label: `${f} (now ${config.overrides[f] ? display(config.overrides[f]!) : 'Claude'})` }))

export const targetEntries = (config: Config): PickerEntry[] => [
  { value: 'target:clear', label: 'Claude (clear the override)' },
  ...allRefs(config).map(ref => ({ value: `target:${ref}`, label: display(ref) })),
]

// Pure: the pane's heading and footer for a picker state.
export function paneHeading(state: NonNullable<PickerState>): string {
  if (state.view.kind === 'family') return 'Override which Claude family?'
  if (state.view.kind === 'target') return `Send ${state.view.family} requests to:`
  return state.mode === 'model' ? 'Main model for this session' : 'model-router'
}

export function paneFooter(state: NonNullable<PickerState>): string | null {
  return state.mode === 'model' && state.view.kind === 'main' ? 'manage: /router' : null
}

export async function openPicker($: EngineInterface, m: Monitor, mode: 'model' | 'router'): Promise<CommandRunResult> {
  const { config } = await loadConfig($, await getPaths($))
  const entries = pickerEntries({ mode, config, status: m.status, sessionModel: await $.session.model(), pick: await getPick($), isWired: m.isWired })
  await update($, pickerAtom, () => ({ mode, view: { kind: 'main' }, entries }))
  await $.ui.open({ id: PICKER_PANE, title: mode === 'model' ? 'Model' : 'model-router', focus: true, closeOnEscape: true })
  return {}
}

async function closePicker($: EngineInterface): Promise<void> {
  await update($, pickerAtom, () => null)
  await $.ui.close({ id: PICKER_PANE })
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
      await closePicker($)
      await refresh($, m)
      if (rest !== (await $.session.model())) await runCommand($, 'model', rest)
      return
    }
    case 'routed': {
      await setPick($, rest)
      await closePicker($)
      await reprobe($, m)
      await refresh($, m)
      await $.ui.toast(`Main model: ${display(rest)}`)
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
        await update($, pickerAtom, (s): PickerState => s && { ...s, view: { kind: 'family' }, entries: familyEntries(config) })
        return
      }
      await closePicker($)
      await runCommand($, 'router', rest === 'add' ? 'add' : 'doctor')
      return
    }
    case 'family': {
      const { config } = await loadConfig($, paths)
      await update($, pickerAtom, (s): PickerState => s && { ...s, view: { kind: 'target', family: rest }, entries: targetEntries(config) })
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
    // Mobile draws no Select yet (types: Elements.mobile).
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Use /router Provider/model on this surface.</Text>
    }
    const state = await read($, pickerAtom)
    const { Box, Text, Select } = $.ui.resolve(e)
    if (!state) return <Text dimColor>Nothing to pick. Run /model or /router.</Text>
    const footer = paneFooter(state)
    return (
      <Box flexDirection="column">
        <Text>{paneHeading(state)}</Text>
        <Select key="picker" autoFocus options={state.entries.map(({ value, label }) => ({ value, label }))} onSelect={value => void choose($, m, value)} />
        {footer ? <Text dimColor>{footer}</Text> : null}
      </Box>
    )
  })
}
