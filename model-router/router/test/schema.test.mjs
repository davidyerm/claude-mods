import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, parseRef, formatErrors, allRefs, checkBaseUrl, DEFAULT_STRIP } from '../lib/schema.mjs'

const good = () => ({
  version: 1,
  port: 4141,
  upstream: 'https://llm-gw.corp.example/',
  providers: [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic/', apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or', strip: ['thinking'], models: [{ id: 'anthropic/claude-x' }] },
  ],
  overrides: { haiku: 'DeepSeek/deepseek-chat' },
  defaultMainModel: 'OpenRouter/anthropic/claude-x',
})

const errorPaths = raw => {
  const r = validateConfig(raw)
  assert.equal(r.ok, false)
  return r.errors.map(e => e.path)
}

test('a valid config normalizes urls, defaults and strip', () => {
  const r = validateConfig(good())
  assert.equal(r.ok, true)
  assert.equal(r.config.upstream, 'https://llm-gw.corp.example')
  assert.equal(r.config.providers[0].baseUrl, 'https://api.deepseek.com/anthropic')
  assert.deepEqual(r.config.providers[0].strip, DEFAULT_STRIP)
  assert.deepEqual(r.config.providers[1].strip, ['thinking'])
  assert.deepEqual(allRefs(r.config), ['DeepSeek/deepseek-chat', 'OpenRouter/anthropic/claude-x'])
})

test('an empty object is a valid config with defaults', () => {
  const r = validateConfig({})
  assert.equal(r.ok, true)
  assert.equal(r.config.port, 4141)
  assert.deepEqual(r.config.providers, [])
  assert.deepEqual(r.config.overrides, {})
})

test('parseRef splits on the first slash only', () => {
  assert.deepEqual(parseRef('OpenRouter/anthropic/claude-x'), { provider: 'OpenRouter', model: 'anthropic/claude-x' })
  assert.equal(parseRef('noslash'), null)
  assert.equal(parseRef('/model'), null)
  assert.equal(parseRef('Provider/'), null)
})

test('provider names must be unique and well formed', () => {
  const dup = good(); dup.providers[1].name = 'DeepSeek'
  assert.deepEqual(errorPaths(dup).filter(p => p.endsWith('.name')), ['providers[1].name'])
  const bad = good(); bad.providers[0].name = 'Deep Seek'
  assert.ok(errorPaths(bad).includes('providers[0].name'))
})

test('overrides and default must reference existing models and known families', () => {
  const c = good()
  c.overrides = { haiku: 'DeepSeek/nope', gpt: 'DeepSeek/deepseek-chat' }
  c.defaultMainModel = 'Nobody/x'
  assert.deepEqual(errorPaths(c).sort(), ['defaultMainModel', 'overrides.gpt', 'overrides.haiku'])
})

test('exactly one of apiKeyEnv and apiKey', () => {
  const both = good(); both.providers[0].apiKey = 'sk'
  assert.ok(errorPaths(both).includes('providers[0]'))
  const none = good(); delete none.providers[0].apiKeyEnv
  assert.ok(errorPaths(none).includes('providers[0]'))
})

test('baseUrl is https, or http on loopback', () => {
  assert.equal(checkBaseUrl('https://x.example'), null)
  assert.equal(checkBaseUrl('http://127.0.0.1:9000'), null)
  assert.equal(checkBaseUrl('http://localhost:9000'), null)
  assert.match(checkBaseUrl('http://x.example'), /https/)
  assert.match(checkBaseUrl('not a url'), /URL/)
  const c = good(); c.providers[0].baseUrl = 'http://api.example'
  assert.ok(errorPaths(c).includes('providers[0].baseUrl'))
})

test('models must be a non-empty list of unique ids', () => {
  const c = good(); c.providers[0].models = []
  assert.ok(errorPaths(c).includes('providers[0].models'))
  const d = good(); d.providers[0].models = [{ id: 'a' }, { id: 'a' }]
  assert.ok(errorPaths(d).includes('providers[0].models[1].id'))
})

test('formatErrors joins path: message', () => {
  assert.equal(formatErrors([{ path: 'port', message: 'bad' }, { path: '', message: 'whole' }]), 'port: bad; whole')
})
