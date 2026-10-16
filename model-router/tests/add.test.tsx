import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { ADD_PANE, probeSummary, providerOf } from '../hooks/add'
import { CONFIG, PANE_PROPS, readJson, run, start, world } from './world'

const draw = ($: Engine, surface: RenderSurface = 'terminal') =>
  $.ui.render({ surface, component: 'Pane', requestId: ADD_PANE, props: { ...PANE_PROPS } })
const enter = async ($: Engine, key: string, text: string) => { await draw($); await $.ui.input({ plugin: 'model-router', key, text }) }
// Whether the redrawn pane holds this text (JSON-escaped the way the tree stringifies it).
const shows = async ($: Engine, text: string) => JSON.stringify(await draw($)).includes(JSON.stringify(text).slice(1, -1))
const open = async ($: Engine) => { await start($); await run($, 'router', 'add') }

test('the wizard walks name, URL, key, models, test call, and saves', async ($, on) => {
  const w = world(on)
  await open($)
  expect(w.opened).toEqual([ADD_PANE])
  await enter($, 'add-name', 'Kimi')
  await enter($, 'add-baseUrl', 'https://api.moonshot.ai/anthropic/')
  await enter($, 'add-key', 'KIMI_API_KEY')
  w.tool = sub => (sub === 'probe' ? { ok: true, status: 200, learnedMaxTokens: 8192 } : undefined)
  await enter($, 'add-models', 'kimi-k2, kimi-k2-turbo')
  expect(JSON.parse(w.runs.at(-1)!.stdin!)).toEqual({
    mode: 'provider',
    provider: { name: 'Kimi', baseUrl: 'https://api.moonshot.ai/anthropic', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'kimi-k2' }, { id: 'kimi-k2-turbo' }] },
    model: 'kimi-k2',
  })
  expect(await shows($, '✓ kimi-k2 answered (max output 8192 learned).')).toBe(true)
  await $.ui.select({ plugin: 'model-router', key: 'add-finish', value: 'save' })
  expect(readJson(w, CONFIG).providers.at(-1)).toEqual({ name: 'Kimi', baseUrl: 'https://api.moonshot.ai/anthropic', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'kimi-k2' }, { id: 'kimi-k2-turbo' }] })
  expect(w.closed).toEqual([ADD_PANE])
  expect(w.toasts.at(-1)).toBe('Added [Kimi] with 2 models. Pick one: /model Kimi/kimi-k2')
})

test('bad input stays on its step with a message', async ($, on) => {
  world(on)
  await open($)
  await enter($, 'add-name', 'Deep Seek')
  expect(await shows($, 'Use letters, digits, ".", "_" or "-".')).toBe(true)
  await enter($, 'add-name', 'DS')
  expect(await shows($, '"DS" exists already. Remove it first: /router remove DS')).toBe(true)
  await enter($, 'add-name', 'New')
  await enter($, 'add-baseUrl', 'http://api.example')
  expect(await shows($, 'The URL must be https (or http on 127.0.0.1/localhost).')).toBe(true)
  // Still on the URL step: its Input is the one drawn.
  expect(JSON.stringify(await draw($))).toContain('add-baseUrl')
})

test('a literal key is allowed with a warning and saved as apiKey, never in argv', async ($, on) => {
  const w = world(on)
  await open($)
  await enter($, 'add-name', 'Lit')
  await enter($, 'add-baseUrl', 'https://lit.example')
  await enter($, 'add-key', 'sk-literal-123')
  expect(await shows($, 'Warning: a literal key is saved in model-router.json. An environment variable is safer.')).toBe(true)
  await enter($, 'add-models', 'm1')
  const probe = w.runs.at(-1)!
  expect(probe.argv.join(' ')).not.toContain('sk-literal-123')
  expect(JSON.parse(probe.stdin!).provider.apiKey).toBe('sk-literal-123')
  await draw($)
  await $.ui.select({ plugin: 'model-router', key: 'add-finish', value: 'save' })
  expect(readJson(w, CONFIG).providers.at(-1)).toEqual({ name: 'Lit', baseUrl: 'https://lit.example', apiKey: 'sk-literal-123', models: [{ id: 'm1' }] })
})

test('cancel writes nothing', async ($, on) => {
  const w = world(on)
  await start($)
  const before = w.files.get(CONFIG)
  await run($, 'router', 'add')
  await enter($, 'add-name', 'Gone')
  await enter($, 'add-baseUrl', 'https://gone.example')
  await enter($, 'add-key', 'GONE_KEY')
  w.tool = sub => (sub === 'probe' ? { ok: false, kind: 'no-key', text: 'env GONE_KEY not set' } : undefined)
  await enter($, 'add-models', 'g1')
  expect(JSON.stringify(await draw($))).toContain('Save anyway')
  await $.ui.select({ plugin: 'model-router', key: 'add-finish', value: 'cancel' })
  expect(w.files.get(CONFIG)).toBe(before)
  expect(w.closed).toEqual([ADD_PANE])
})

test('the test call is one launch.mjs probe', async ($, on) => {
  const w = world(on)
  await open($)
  await enter($, 'add-name', 'T')
  await enter($, 'add-baseUrl', 'https://t.example')
  await enter($, 'add-key', 'T_KEY')
  await enter($, 'add-models', 't1')
  expect(w.runs.at(-1)!.argv.slice(2)).toEqual(['probe'])
})

test('a surface without Input names the file instead', async ($, on) => {
  world(on)
  await open($)
  expect(JSON.stringify(await draw($, 'mobile'))).toContain('Edit model-router.json')
})

test('providerOf: upper-case names are env vars, anything else a literal key', () => {
  expect(providerOf({ name: 'A', baseUrl: 'https://a.example', key: 'A_KEY', models: 'm1,m2' })).toEqual({ name: 'A', baseUrl: 'https://a.example', apiKeyEnv: 'A_KEY', models: [{ id: 'm1' }, { id: 'm2' }] })
  expect(providerOf({ name: 'A', baseUrl: 'https://a.example', key: 'sk-abc', models: 'm1' }).apiKey).toBe('sk-abc')
  expect(providerOf({ name: 'A', baseUrl: 'https://a.example', key: 'abc', models: 'm1' }).apiKeyEnv).toBeUndefined()
})

test('probe results read as advice', () => {
  expect(probeSummary({ ok: false, kind: 'http', status: 400, text: "unknown field 'thinking'" }, 'm')).toBe(`✗ rejected (400: unknown field 'thinking'). After saving, add the rejected field to "strip" for this provider.`)
  expect(probeSummary({ ok: false, kind: 'tls', text: 'tls: SELF_SIGNED_CERT_IN_CHAIN' }, 'm')).toBe('✗ certificate not trusted (tls: SELF_SIGNED_CERT_IN_CHAIN). See /router doctor.')
  expect(probeSummary({ ok: false, kind: 'connect', text: 'connect: ENOTFOUND' }, 'm')).toBe('✗ connect: ENOTFOUND')
})

test('duplicate model IDs are dropped, first-seen order kept', async ($, on) => {
  const w = world(on)
  await open($)
  await enter($, 'add-name', 'Dup')
  await enter($, 'add-baseUrl', 'https://dup.example')
  await enter($, 'add-key', 'DUP_KEY')
  await enter($, 'add-models', 'm1, m1 m2')
  await draw($)
  await $.ui.select({ plugin: 'model-router', key: 'add-finish', value: 'save' })
  expect(readJson(w, CONFIG).providers.at(-1).models).toEqual([{ id: 'm1' }, { id: 'm2' }])
})
