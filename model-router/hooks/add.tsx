import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, On } from 'claude-code'
import { checkBaseUrl } from '../router/lib/schema.mjs'
import type { WizardState, WizardStep } from '../types'
import { loadConfig, updateConfig } from './config'
import type { RawProvider } from './config'
import { runTool } from './host'
import type { ToolOut } from './host'
import { refresh } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'

export const ADD_PANE = 'model-router-add'
// read/update on this atom stay in this file (the engine allows them only beside the atom).
export const wizardAtom = atom({ plugin: 'model-router', key: 'wizard' } as const, null as WizardState)

type Draft = NonNullable<WizardState>

const PROMPTS: Record<Exclude<WizardStep, 'test'>, string> = {
  name: 'Provider name (letters, digits, . _ -), e.g. DeepSeek',
  baseUrl: 'Base URL of its Anthropic-compatible API, e.g. https://api.deepseek.com/anthropic',
  key: 'Environment variable that holds the API key (e.g. DEEPSEEK_API_KEY), or the key itself',
  models: 'Model IDs, separated by commas or spaces',
}

const isEnvName = (value: string) => /^[A-Z_][A-Z0-9_]*$/.test(value)
const modelIds = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))]

export function providerOf(d: Pick<Draft, 'name' | 'baseUrl' | 'key' | 'models'>): RawProvider {
  return {
    name: d.name,
    baseUrl: d.baseUrl,
    ...(isEnvName(d.key) ? { apiKeyEnv: d.key } : { apiKey: d.key }),
    models: modelIds(d.models).map(id => ({ id })),
  }
}

export function probeSummary(out: ToolOut, model: string): string {
  const learned = typeof out.learnedMaxTokens === 'number' ? ` (max output ${out.learnedMaxTokens} learned)` : ''
  if (out.ok === true) return `✓ ${model} answered${learned}.`
  const text = String(out.text ?? out.error ?? 'failed')
  switch (out.kind) {
    case 'no-key': return `✗ ${text}. Set it (for example in ~/.claude/settings.json "env"), restart Claude Code, then /router restart.`
    case 'http': return out.status === 400
      ? `✗ rejected (400: ${text}). After saving, add the rejected field to "strip" for this provider.`
      : `✗ HTTP ${String(out.status)}: ${text}`
    case 'tls': return `✗ certificate not trusted (${text}). See /router doctor.`
    default: return `✗ ${text}`
  }
}

export async function openWizard($: EngineInterface): Promise<CommandRunResult> {
  await update($, wizardAtom, () => ({ step: 'name', name: '', baseUrl: '', key: '', models: '', message: '', isProbeOk: false }))
  await $.ui.open({ id: ADD_PANE, title: 'Add provider', focus: true, closeOnEscape: true })
  return {}
}

export async function submitStep($: EngineInterface, value: string): Promise<void> {
  const draft = await read($, wizardAtom)
  if (!draft) return
  const v = value.trim()
  const set = async (patch: Partial<Draft>) => { await update($, wizardAtom, s => (s ? { ...s, ...patch } : s)) }
  switch (draft.step) {
    case 'name': {
      if (!/^[A-Za-z0-9._-]+$/.test(v)) return set({ message: 'Use letters, digits, ".", "_" or "-".' })
      const { config } = await loadConfig($, await getPaths($))
      if (config.providers.some(p => p.name === v)) return set({ message: `"${v}" exists already. Remove it first: /router remove ${v}` })
      return set({ step: 'baseUrl', name: v, message: '' })
    }
    case 'baseUrl': {
      const bad = checkBaseUrl(v)
      return bad ? set({ message: `The URL ${bad}.` }) : set({ step: 'key', baseUrl: v.replace(/\/+$/, ''), message: '' })
    }
    case 'key':
      if (v === '') return set({ message: 'Enter a variable name or a key.' })
      return set({ step: 'models', key: v, message: isEnvName(v) ? '' : 'Warning: a literal key is saved in model-router.json. An environment variable is safer.' })
    case 'models': {
      const ids = modelIds(v)
      if (ids.length === 0) return set({ message: 'Enter at least one model ID.' })
      const next: Draft = { ...draft, models: ids.join(',') }
      await set({ step: 'test', models: next.models, message: `Testing ${ids[0]}…` })
      // The probe reads the provider (a literal key too) from stdin, never from argv.
      const out = await runTool($, ['probe'], { stdin: JSON.stringify({ mode: 'provider', provider: providerOf(next), model: ids[0] }), timeoutMs: 150_000 })
      return set({ message: probeSummary(out, ids[0]!), isProbeOk: out.ok === true })
    }
    case 'test':
      return
  }
}

export async function finishWizard($: EngineInterface, m: Monitor, choice: string): Promise<void> {
  const draft = await read($, wizardAtom)
  if (!draft || draft.step !== 'test') return
  if (choice === 'save') {
    const provider = providerOf(draft)
    const r = await updateConfig($, await getPaths($), raw => { raw.providers = [...(raw.providers ?? []), provider] })
    if (!r.ok) { await update($, wizardAtom, s => (s ? { ...s, message: `Not saved: ${r.message}` } : s)); return }
    const n = provider.models.length
    await $.ui.toast(`Added [${provider.name}] with ${n} model${n === 1 ? '' : 's'}. Pick one: /model ${provider.name}/${provider.models[0]!.id}`)
    await refresh($, m)
  }
  await update($, wizardAtom, () => null)
  await $.ui.close({ id: ADD_PANE })
}

export function registerWizard(on: On, m: Monitor): void {
  on('ui.render', { component: 'Pane', requestId: ADD_PANE }, async ($, e) => {
    // Mobile draws no Input or Select yet (types: Elements.mobile).
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Edit model-router.json to add a provider on this surface.</Text>
    }
    const draft = await read($, wizardAtom)
    const { Box, Text, Input, Select } = $.ui.resolve(e)
    if (!draft) return <Text dimColor>Run /router add to add a provider.</Text>
    const summary = [draft.name, draft.baseUrl, draft.models].filter(Boolean).join(' · ')
    return (
      <Box flexDirection="column">
        {summary ? <Text dimColor>{summary}</Text> : null}
        {draft.step === 'test'
          ? <Select key="add-finish" autoFocus options={[{ value: 'save', label: draft.isProbeOk ? 'Save' : 'Save anyway' }, { value: 'cancel', label: 'Cancel' }]} onSelect={value => void finishWizard($, m, value)} />
          : <Input key={`add-${draft.step}`} autoFocus label={PROMPTS[draft.step]} onSubmit={value => void submitStep($, value)} />}
        {draft.message ? <Text>{draft.message}</Text> : null}
      </Box>
    )
  })
}
