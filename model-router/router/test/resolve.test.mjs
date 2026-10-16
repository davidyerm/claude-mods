import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTarget, familyOf, DEFAULT_FALLBACK } from '../lib/resolve.mjs'
import { validateConfig } from '../lib/schema.mjs'

const { config } = validateConfig({
  upstream: 'https://gw.example',
  providers: [
    { name: 'DeepSeek', baseUrl: 'https://ds.example', apiKeyEnv: 'K', models: [{ id: 'deepseek-chat' }] },
    { name: 'OpenRouter', baseUrl: 'https://or.example', apiKeyEnv: 'K', models: [{ id: 'anthropic/claude-x' }] },
  ],
  overrides: { haiku: 'DeepSeek/deepseek-chat' },
})
const up = () => ({ ok: true })
const down = () => ({ ok: false, reason: 'env K not set' })

test('a router: id routes to its model and keeps the fallback id', () => {
  const t = resolveTarget('router:DeepSeek/deepseek-chat#claude-opus-5-5', config, up)
  assert.equal(t.kind, 'routed')
  assert.equal(t.provider.name, 'DeepSeek')
  assert.equal(t.providerModel, 'deepseek-chat')
  assert.equal(t.ref, 'DeepSeek/deepseek-chat')
  assert.equal(t.fallbackModel, 'claude-opus-5-5')
})

test('a router: id without # falls back to sonnet', () => {
  assert.equal(resolveTarget('router:DeepSeek/deepseek-chat', config, up).fallbackModel, DEFAULT_FALLBACK)
  assert.equal(resolveTarget('router:DeepSeek/deepseek-chat#', config, up).fallbackModel, DEFAULT_FALLBACK)
})

test('a model id with a slash resolves on the first slash', () => {
  const t = resolveTarget('router:OpenRouter/anthropic/claude-x#claude-opus-5-5', config, up)
  assert.equal(t.kind, 'routed')
  assert.equal(t.providerModel, 'anthropic/claude-x')
})

test('unknown or unavailable router: ids fall back with a reason', () => {
  const unknown = resolveTarget('router:Nobody/x#claude-opus-5-5', config, up)
  assert.deepEqual([unknown.kind, unknown.fallbackModel], ['fallback', 'claude-opus-5-5'])
  assert.match(unknown.reason, /unknown model/)
  const off = resolveTarget('router:DeepSeek/deepseek-chat#claude-opus-5-5', config, down)
  assert.deepEqual([off.kind, off.provider, off.reason], ['fallback', 'DeepSeek', 'env K not set'])
})

test('a family override routes a Claude id, with that id as fallback', () => {
  const t = resolveTarget('claude-haiku-5-5', config, up)
  assert.deepEqual([t.kind, t.ref, t.fallbackModel], ['routed', 'DeepSeek/deepseek-chat', 'claude-haiku-5-5'])
  assert.equal(resolveTarget('Claude-3-5-HAIKU-latest', config, up).kind, 'routed')
})

test('no override, or an unavailable target, passes through', () => {
  assert.equal(resolveTarget('claude-opus-5-5', config, up).kind, 'pass')
  assert.equal(resolveTarget('claude-haiku-5-5', config, down).kind, 'pass')
  assert.equal(resolveTarget(undefined, config, up).kind, 'pass')
})

test('familyOf finds the family inside an id', () => {
  assert.equal(familyOf('claude-sonnet-5-5'), 'sonnet')
  assert.equal(familyOf('gpt-4'), undefined)
})
