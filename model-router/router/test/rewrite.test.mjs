import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteRouted, passThroughHeaders, customHeaderNames, withModel } from '../lib/rewrite.mjs'
import { DEFAULT_STRIP } from '../lib/schema.mjs'

const inbound = {
  host: '127.0.0.1:4141',
  connection: 'keep-alive',
  'content-length': '999',
  'accept-encoding': 'gzip, br',
  authorization: 'Bearer gateway-token',
  'x-api-key': 'gateway-key',
  'x-claude-code-session-id': 'sess-1',
  'x-router-token': 'tok',
  'x-corp-trace': 'abc',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,effort-2025-11-24',
  'user-agent': 'claude-cli',
}
const body = JSON.stringify({
  model: 'router:DeepSeek/deepseek-chat#claude-opus-5-5',
  max_tokens: 32000,
  thinking: { type: 'adaptive' },
  context_management: { edits: [] },
  output_config: { effort: 'high' },
  metadata: { user_id: 'u' },
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
})
const base = { headers: inbound, body, providerModel: 'deepseek-chat', apiKey: 'sk-ds', strip: [...DEFAULT_STRIP], customNames: ['x-corp-trace'], limits: {} }

test('D9: inbound auth, identity, token and custom headers never reach a provider', () => {
  const { headers } = rewriteRouted(base)
  for (const gone of ['authorization', 'x-claude-code-session-id', 'x-router-token', 'x-corp-trace', 'host', 'connection', 'content-length', 'accept-encoding'])
    assert.equal(headers[gone], undefined, gone)
  assert.equal(headers['x-api-key'], 'sk-ds')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['user-agent'], 'claude-cli')
})

test('D9/D10: metadata always goes, the strip list goes, cache_control stays, model is swapped', () => {
  const out = JSON.parse(rewriteRouted(base).body)
  assert.equal(out.model, 'deepseek-chat')
  for (const gone of ['metadata', 'thinking', 'context_management', 'output_config']) assert.equal(out[gone], undefined, gone)
  assert.equal(rewriteRouted(base).headers['anthropic-beta'], undefined)
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' })
})

test('cache_control in the strip list is removed everywhere', () => {
  const out = JSON.parse(rewriteRouted({ ...base, strip: ['cache_control'] }).body)
  assert.equal(out.system[0].cache_control, undefined)
  assert.equal(out.messages[0].content[0].cache_control, undefined)
  assert.deepEqual(out.thinking, { type: 'adaptive' })
})

test('D11: max_tokens is clamped by learned and policy and never raised', () => {
  assert.equal(rewriteRouted({ ...base, limits: { learned: 8192 } }).maxTokens, 8192)
  assert.equal(JSON.parse(rewriteRouted({ ...base, limits: { learned: 8192, policy: 4000 } }).body).max_tokens, 4000)
  assert.equal(rewriteRouted({ ...base, limits: { learned: 64000 } }).maxTokens, 32000)
})

test('pass-through keeps every header but hop-by-hop ones and the router token', () => {
  const h = passThroughHeaders(inbound)
  assert.equal(h.authorization, 'Bearer gateway-token')
  assert.equal(h['x-claude-code-session-id'], 'sess-1')
  assert.equal(h['accept-encoding'], 'gzip, br')
  assert.equal(h['x-router-token'], undefined)
  assert.equal(h.host, undefined)
  assert.equal(h['content-length'], undefined)
})

test('customHeaderNames reads LF and CRLF header lists', () => {
  assert.deepEqual(customHeaderNames('X-Corp-Trace: a\r\nx-router-token: t\n\nbroken line'), ['x-corp-trace', 'x-router-token'])
  assert.deepEqual(customHeaderNames(undefined), [])
})

test('withModel swaps the model and leaves identical bodies untouched', () => {
  const raw = '{"model":"claude-haiku-5-5",  "x":1}'
  assert.equal(withModel(raw, 'claude-haiku-5-5'), raw)
  assert.equal(JSON.parse(withModel(body, 'claude-opus-5-5')).model, 'claude-opus-5-5')
})
