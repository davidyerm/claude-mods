import { expect, test } from 'claude-code/testing'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import { ambiguousText, applyUpdate, display, findModel, modelList, parseConfigText, portOf } from '../hooks/config'
import type { RawConfig } from '../hooks/config'
import { CONFIG_JSON } from './world'

const config = (validateConfig(CONFIG_JSON) as { ok: true; config: Config }).config
const CONFIG_PATH = 'C:/Users/test/.claude/model-router.json'

test('a missing file is the empty config, not an error', () => {
  const loaded = parseConfigText(null)
  expect(loaded.raw).toBe(null)
  expect(loaded.errors).toEqual([])
  expect(loaded.config.providers).toEqual([])
})

test('invalid JSON and invalid content are reported with paths', () => {
  expect(parseConfigText('{ nope').errors[0]!.message).toMatch(/invalid JSON/)
  expect(parseConfigText(JSON.stringify({ overrides: { gpt: 'x/y' } })).errors.map(e => e.path)).toEqual(['overrides.gpt'])
})

test('invalid JSON never echoes file content', () => {
  const message = parseConfigText('{"apiKey": sk-secret-123456}').errors[0]!.message
  expect(message).toMatch(/invalid JSON/)
  expect(message).not.toContain('sk-secret')
})

test('applyUpdate writes a validated copy and refuses an invalid result', () => {
  const raw = JSON.parse(JSON.stringify(CONFIG_JSON)) as RawConfig
  const ok = applyUpdate(raw, [], r => { r.defaultMainModel = 'DS/ds-chat' }, CONFIG_PATH)
  expect(ok.ok).toBe(true)
  if (!ok.ok) return
  expect(JSON.parse(ok.text).defaultMainModel).toBe('DS/ds-chat')
  expect(ok.text.endsWith('}\n')).toBe(true)
  expect(ok.text).toContain('\n  "version": 1')
  expect(raw.defaultMainModel).toBeUndefined()
  const bad = applyUpdate(raw, [], r => { r.defaultMainModel = 'Nope/x' }, CONFIG_PATH)
  expect(bad).toEqual({ ok: false, message: 'defaultMainModel: references unknown model "Nope/x"' })
})

test('applyUpdate starts from an empty config when the file is missing, and refuses a broken file', () => {
  const fresh = applyUpdate(null, [], r => { r.upstream = 'https://gw.example' }, CONFIG_PATH)
  expect(fresh.ok).toBe(true)
  const broken = applyUpdate(null, [{ path: '', message: 'invalid JSON' }], () => {}, CONFIG_PATH)
  expect(broken).toEqual({ ok: false, message: `${CONFIG_PATH}: invalid JSON` })
})

test('display shows [Provider] model and keeps slashes in the model', () => {
  expect(display('DS/ds-chat')).toBe('[DS] ds-chat')
  expect(display('OR/anthropic/claude-x')).toBe('[OR] anthropic/claude-x')
})

test('findModel: exact, case-insensitive, unique bare id, ambiguous, none', () => {
  expect(findModel(config, 'OR/anthropic/claude-x')).toEqual({ kind: 'one', ref: 'OR/anthropic/claude-x' })
  expect(findModel(config, 'ds/DS-CHAT')).toEqual({ kind: 'one', ref: 'DS/ds-chat' })
  expect(findModel(config, 'ds-reasoner')).toEqual({ kind: 'one', ref: 'DS/ds-reasoner' })
  expect(findModel(config, 'anthropic/claude-x')).toEqual({ kind: 'one', ref: 'OR/anthropic/claude-x' })
  expect(findModel(config, 'ds-chat')).toEqual({ kind: 'ambiguous', refs: ['DS/ds-chat', 'OR/ds-chat'] })
  expect(findModel(config, 'opus')).toEqual({ kind: 'none' })
})

test('ambiguousText lists the candidates and the fix', () => {
  expect(ambiguousText('ds-chat', ['DS/ds-chat', 'OR/ds-chat'])).toBe(
    '"ds-chat" matches several models:\n  DS/ds-chat\n  OR/ds-chat\nName one as Provider/model.')
})

test('modelList joins refs or points at /router add', () => {
  expect(modelList(config)).toBe('DS/ds-chat, DS/ds-reasoner, OR/anthropic/claude-x, OR/ds-chat')
  expect(modelList(parseConfigText(null).config)).toBe('none yet — add a provider with /router add')
})

test('portOf: an invalid config with a valid integer port keeps that port; else the config port (final fix I4)', () => {
  const bad = { port: 5000, upstream: 'https://gw', providers: [{ name: 'DS', baseUrl: 'ftp://x', apiKeyEnv: 'K', models: [{ id: 'm' }] }] }
  expect(portOf(parseConfigText(JSON.stringify(bad)))).toBe(5000)
  expect(portOf(parseConfigText(JSON.stringify({ ...bad, port: 'x' })))).toBe(4141)
  expect(portOf(parseConfigText(JSON.stringify({ ...bad, port: 70000 })))).toBe(4141)
  expect(portOf(parseConfigText('{ nope'))).toBe(4141)
  expect(portOf(parseConfigText(JSON.stringify({ port: 4242 })))).toBe(4242)
  expect(portOf(parseConfigText(null))).toBe(4141)
})
