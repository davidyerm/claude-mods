import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHome, startRouter, request } from './helpers.mjs'
import { startFake, jsonReply, closedPort } from './fakes.mjs'
import { VERSION } from '../version.mjs'

async function setup({ upstreamHandler, env = {}, config = {} } = {}) {
  const upstream = await startFake(upstreamHandler ? { handler: upstreamHandler } : {})
  const home = makeHome({ config: {
    upstream: upstream.url,
    providers: [{ name: 'DS', baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }] }],
    ...config,
  } })
  const r = await startRouter(home, { env })
  return { upstream, ...r, cleanup: async () => { await r.close(); await upstream.close() } }
}

test('HEAD /api/hello is answered locally', async () => {
  const s = await setup()
  try {
    const r = await request(s.url, { method: 'HEAD', path: '/api/hello' })
    assert.equal(r.status, 200)
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('status identifies the router and reports providers', async () => {
  const s = await setup({ env: {} })
  try {
    const status = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/status' })).text)
    assert.equal(status.name, 'model-router')
    assert.equal(status.version, VERSION)
    assert.equal(status.policyApi, 1)
    assert.equal(status.upstream, s.upstream.url)
    assert.deepEqual(status.providers, [{ name: 'DS', available: false, reason: 'env DS_KEY not set', breaker: 'closed' }])
    assert.deepEqual(status.models, [{ ref: 'DS/ds-chat' }])
    assert.equal(typeof status.eventsSeq, 'number')
  } finally { await s.cleanup() }
})

test('limits are empty and policy is reserved (501)', async () => {
  const s = await setup()
  try {
    assert.deepEqual(JSON.parse((await request(s.url, { method: 'GET', path: '/_router/limits' })).text), { learned: {}, policy: null })
    assert.equal((await request(s.url, { path: '/_router/policy', body: {} })).status, 501)
  } finally { await s.cleanup() }
})

test('token-protected control endpoints refuse without the token', async () => {
  const s = await setup()
  try {
    assert.equal((await request(s.url, { method: 'GET', path: '/_router/keys' })).status, 401)
    assert.equal((await request(s.url, { path: '/_router/forget', body: { ref: 'all' } })).status, 401)
    assert.equal((await request(s.url, { path: '/_router/shutdown' })).status, 401)
    const ok = await request(s.url, { path: '/_router/forget', headers: { 'x-router-token': 'test-token' }, body: { ref: 'all' } })
    assert.deepEqual([ok.status, JSON.parse(ok.text)], [200, { forgotten: 0 }])
  } finally { await s.cleanup() }
})

test('keys reports fingerprints of the router env, never values', async () => {
  const s = await setup({ env: { DS_KEY: 'sk-secret' } })
  try {
    const r = await request(s.url, { method: 'GET', path: '/_router/keys', headers: { 'x-router-token': 'test-token' } })
    const { keys } = JSON.parse(r.text)
    assert.match(keys.DS_KEY, /^[0-9a-f]{12}$/)
    assert.ok(!r.text.includes('sk-secret'))
  } finally { await s.cleanup() }
})

test('pass-through is byte-for-byte, keeps the query and auth, drops only the router token', async () => {
  const s = await setup()
  try {
    const body = '{"model":"claude-opus-5-5",   "messages":[],"stream":false}'
    const r = await request(s.url, {
      path: '/v1/messages?beta=true',
      headers: { authorization: 'Bearer gw', 'x-router-token': 'test-token', 'x-claude-code-session-id': 's1', 'anthropic-beta': 'b1' },
      body,
    })
    assert.equal(r.status, 200)
    const seen = s.upstream.requests[0]
    assert.equal(seen.url, '/v1/messages?beta=true')
    assert.equal(seen.body, body)
    assert.equal(seen.headers.authorization, 'Bearer gw')
    assert.equal(seen.headers['x-claude-code-session-id'], 's1')
    assert.equal(seen.headers['anthropic-beta'], 'b1')
    assert.equal(seen.headers['x-router-token'], undefined)
    assert.match(r.text, /ok from claude-opus-5-5/)
  } finally { await s.cleanup() }
})

test('other paths pass through too', async () => {
  const s = await setup({ upstreamHandler: (req, res) => jsonReply(res, 200, { path: req.url }) })
  try {
    const r = await request(s.url, { method: 'GET', path: '/v1/models' })
    assert.deepEqual(JSON.parse(r.text), { path: '/v1/models' })
  } finally { await s.cleanup() }
})

test('an upstream error passes unchanged and is observed as an event', async () => {
  const s = await setup({ upstreamHandler: (req, res) => jsonReply(res, 413, { type: 'error', error: { type: 'request_too_large', message: 'too big' } }) })
  try {
    const r = await request(s.url, { headers: { 'x-claude-code-session-id': 's1' }, body: { model: 'claude-opus-5-5' } })
    assert.equal(r.status, 413)
    assert.match(r.text, /too big/)
    const { events } = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/events?after=0' })).text)
    const e = events.find(x => x.kind === 'upstream-error')
    assert.deepEqual([e.status, e.text, e.session], [413, 'too big', 's1'])
  } finally { await s.cleanup() }
})

test('an unreachable upstream is a 502 with an explanation and an event', async () => {
  const s = await setup({ config: { upstream: `http://127.0.0.1:${await closedPort()}` } })
  try {
    const r = await request(s.url, { body: { model: 'claude-opus-5-5' } })
    assert.equal(r.status, 502)
    assert.match(JSON.parse(r.text).error.message, /model-router: upstream .* failed \(connect: ECONNREFUSED\)/)
  } finally { await s.cleanup() }
})

test('with no config the router answers 503 and still serves status', async () => {
  const home = makeHome({})
  const s = await startRouter(home)
  try {
    const r = await request(s.url, { body: { model: 'claude-opus-5-5' } })
    assert.equal(r.status, 503)
    assert.match(r.text, /model-router\.json/)
    assert.equal(JSON.parse((await request(s.url, { method: 'GET', path: '/_router/status' })).text).configOk, false)
  } finally { await s.close() }
})

test('an invalid config with a valid upstream still passes traffic through, with configOk false and a config-error', async () => {
  const s = await setup({ config: { providers: [{ name: 'DS', baseUrl: 'ftp://nope', apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }] }] } })
  try {
    const r = await request(s.url, { body: { model: 'claude-opus-5-5', max_tokens: 1, messages: [] } })
    assert.equal(r.status, 200)
    assert.equal(s.upstream.requests.length, 1)
    const status = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/status' })).text)
    assert.equal(status.configOk, false)
    assert.equal(status.upstream, s.upstream.url)
    const { events } = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/events?after=0' })).text)
    assert.ok(events.some(e => e.kind === 'config-error'))
  } finally { await s.cleanup() }
})
