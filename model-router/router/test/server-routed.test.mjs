import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHome, startRouter, request, waitFor } from './helpers.mjs'
import { startFake, jsonReply, sseReply, closedPort } from './fakes.mjs'

const TOKEN = { 'x-router-token': 'test-token' }
const INBOUND = { authorization: 'Bearer gw', 'x-claude-code-session-id': 's1', 'x-corp': 'c', ...TOKEN }
const MAIN = 'router:DS/ds-chat#claude-opus-5-5'
const bodyFor = (model, extra = {}) => ({ model, max_tokens: 32000, stream: true, thinking: { type: 'adaptive' }, metadata: { user_id: 'u' }, messages: [{ role: 'user', content: 'hi' }], ...extra })

async function setup({ providerHandler, env = { DS_KEY: 'sk-ds', ANTHROPIC_CUSTOM_HEADERS: 'x-corp: c\nx-router-token: test-token' }, routerOptions = {}, providerUrl } = {}) {
  const upstream = await startFake()
  const provider = await startFake(providerHandler ? { handler: providerHandler } : {})
  const home = makeHome({ config: {
    upstream: upstream.url,
    providers: [{ name: 'DS', baseUrl: providerUrl ?? provider.url, apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }] }],
    overrides: { haiku: 'DS/ds-chat' },
  } })
  const r = await startRouter(home, { env, ...routerOptions })
  const events = async () => JSON.parse((await request(r.url, { method: 'GET', path: '/_router/events?after=0' })).text).events
  return { upstream, provider, home, events, ...r, cleanup: async () => { await r.close(); await upstream.close(); await provider.close() } }
}

test('a routed main pick reaches the provider rewritten (D9, D10), query dropped', async () => {
  const s = await setup()
  try {
    const r = await request(s.url, { path: '/v1/messages?beta=true', headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(r.status, 200)
    assert.match(r.text, /from ds-chat/)
    const seen = s.provider.requests[0]
    assert.equal(seen.url, '/v1/messages')
    assert.equal(seen.headers['x-api-key'], 'sk-ds')
    for (const gone of ['authorization', 'x-claude-code-session-id', 'x-router-token', 'x-corp']) assert.equal(seen.headers[gone], undefined, gone)
    const json = JSON.parse(seen.body)
    assert.equal(json.model, 'ds-chat')
    assert.equal(json.metadata, undefined)
    assert.equal(json.thinking, undefined)
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('an inbound header that is not in ANTHROPIC_CUSTOM_HEADERS never reaches the provider', async () => {
  const s = await setup()
  try {
    const r = await request(s.url, { headers: { ...INBOUND, 'x-corp-auth': 'secret', 'x-stainless-os': 'Windows' }, body: bodyFor(MAIN) })
    assert.equal(r.status, 200)
    const seen = s.provider.requests[0].headers
    assert.equal(seen['x-corp-auth'], undefined)
    assert.equal(seen['x-stainless-os'], 'Windows')
  } finally { await s.cleanup() }
})

test('a routed request without the local token is refused with 401', async () => {
  const s = await setup()
  try {
    const r = await request(s.url, { headers: { authorization: 'Bearer gw' }, body: bodyFor(MAIN) })
    assert.equal(r.status, 401)
    assert.match(r.text, /router setup/)
    assert.equal(s.provider.requests.length, 0)
  } finally { await s.cleanup() }
})

test('a family override routes a Claude haiku request', async () => {
  const s = await setup()
  try {
    await request(s.url, { headers: INBOUND, body: bodyFor('claude-haiku-5-5') })
    assert.equal(JSON.parse(s.provider.requests[0].body).model, 'ds-chat')
  } finally { await s.cleanup() }
})

test('SSE is streamed through unbuffered', async () => {
  const s = await setup({ providerHandler: (req, res, body) => sseReply(res, JSON.parse(body).model, { gapMs: 600, events: 2 }) })
  try {
    const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.ok(r.firstChunkMs < 400, `first chunk after ${r.firstChunkMs} ms`)
    assert.ok(r.totalMs >= 600, `total ${r.totalMs} ms`)
    assert.match(r.text, /part1/)
  } finally { await s.cleanup() }
})

const failures = [
  ['500', { handler: (req, res) => jsonReply(res, 500, { error: { message: 'boom' } }) }, 500, 'boom'],
  ['429', { handler: (req, res) => jsonReply(res, 429, { error: { message: 'slow down' } }) }, 429, 'slow down'],
  ['400 field', { handler: (req, res) => jsonReply(res, 400, { error: { message: "unknown field 'thinking'" } }) }, 400, "unknown field 'thinking'"],
  ['refused', { closed: true }, undefined, 'connect: ECONNREFUSED'],
  ['first-byte timeout', { handler: () => {}, routerOptions: { firstByteTimeoutMs: 200 } }, undefined, 'timeout: ETIMEDOUT_FIRST_BYTE'],
]
for (const [name, how, status, text] of failures) {
  test(`fallback on ${name}: upstream gets the Claude id and the original inbound auth`, async () => {
    const s = await setup({
      providerHandler: how.handler,
      routerOptions: how.routerOptions,
      providerUrl: how.closed ? `http://127.0.0.1:${await closedPort()}` : undefined,
    })
    try {
      const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
      assert.equal(r.status, 200)
      const up = s.upstream.requests[0]
      assert.equal(JSON.parse(up.body).model, 'claude-opus-5-5')
      assert.equal(up.headers.authorization, 'Bearer gw')
      assert.equal(up.headers['x-claude-code-session-id'], 's1')
      const evs = await s.events()
      const fb = evs.find(e => e.kind === 'fallback')
      assert.deepEqual([fb.provider, fb.model, fb.status, fb.session], ['DS', 'claude-opus-5-5', status, 's1'])
      assert.equal(fb.text, text)
      assert.ok(evs.some(e => e.kind === 'provider-error'))
    } finally { await s.cleanup() }
  })
}

test('an HTML error page still falls back with a short readable event text', async () => {
  const s = await setup({ providerHandler: (req, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end(`<html><body><h1>Bad Gateway</h1>${'<p>filler</p>'.repeat(2000)}</body></html>`) } })
  try {
    assert.equal((await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })).status, 200)
    const fb = (await s.events()).find(e => e.kind === 'fallback')
    assert.ok(fb.text.length <= 200)
    assert.ok(!fb.text.includes('<'))
    assert.match(fb.text, /^Bad Gateway/)
  } finally { await s.cleanup() }
})

test('after the first byte, a provider failure passes through (no fallback)', async () => {
  const s = await setup({ providerHandler: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ping\ndata: {}\n\n'); setTimeout(() => res.destroy(), 50) } })
  try {
    const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(r.status, 200)
    assert.match(r.text, /ping/)
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('a max_tokens 400 is learned, retried once on the provider, shown in limits, and gone after a restart', async () => {
  const s = await setup({ providerHandler: (req, res, body) => {
    const json = JSON.parse(body)
    if (json.max_tokens > 8192) return jsonReply(res, 400, { error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } })
    return sseReply(res, json.model)
  } })
  try {
    assert.equal((await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })).status, 200)
    assert.deepEqual(s.provider.requests.map(r => JSON.parse(r.body).max_tokens), [32000, 8192])
    assert.equal(s.upstream.requests.length, 0)
    const learned = (await s.events()).find(e => e.kind === 'learned')
    assert.deepEqual([learned.provider, learned.model, learned.text], ['DS', 'ds-chat', '8192'])
    const limits = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/limits' })).text)
    assert.equal(limits.learned['DS/ds-chat'].maxOutputTokens, 8192)
    await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(s.provider.requests.length, 3)
    assert.equal(JSON.parse(s.provider.requests[2].body).max_tokens, 8192)

    await s.close()
    const again = await startRouter(s.home, { env: { DS_KEY: 'sk-ds' } })
    try {
      assert.deepEqual(JSON.parse((await request(again.url, { method: 'GET', path: '/_router/limits' })).text).learned, {})
    } finally { await again.close() }
  } finally { await s.upstream.close(); await s.provider.close() }
})

test('three failures open the breaker; then requests go straight to Claude', async () => {
  const s = await setup({ providerHandler: (req, res) => jsonReply(res, 500, { error: { message: 'down' } }) })
  try {
    for (let i = 0; i < 3; i++) await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(s.provider.requests.length, 3)
    await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(s.provider.requests.length, 3)
    assert.equal(s.upstream.requests.length, 4)
    const evs = await s.events()
    assert.ok(evs.some(e => e.kind === 'breaker-open' && e.provider === 'DS'))
    assert.match(evs.at(-1).text, /paused/)
    const status = JSON.parse((await request(s.url, { method: 'GET', path: '/_router/status' })).text)
    assert.equal(status.providers[0].breaker, 'open')
  } finally { await s.cleanup() }
})

test('a missing key: a router: id falls back with the reason; an override passes through untouched', async () => {
  const s = await setup({ env: {} })
  try {
    await request(s.url, { headers: INBOUND, body: bodyFor(MAIN) })
    assert.equal(JSON.parse(s.upstream.requests[0].body).model, 'claude-opus-5-5')
    assert.equal((await s.events()).find(e => e.kind === 'fallback').text, 'env DS_KEY not set')
    const raw = JSON.stringify(bodyFor('claude-haiku-5-5'))
    await request(s.url, { headers: INBOUND, body: raw })
    assert.equal(s.upstream.requests[1].body, raw)
    assert.equal(s.provider.requests.length, 0)
  } finally { await s.cleanup() }
})

test('a client that hangs up mid-stream aborts the provider request and the router keeps serving', async () => {
  let providerClosedAt
  const s = await setup({ providerHandler: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: ping\ndata: {}\n\n')
    res.on('close', () => { providerClosedAt = Date.now() })
    setTimeout(() => res.end(), 5000)
  } })
  try {
    const r = await request(s.url, { headers: INBOUND, body: bodyFor(MAIN), abortAfterFirstChunk: true })
    assert.equal(r.isAborted, true)
    const hungUpAt = Date.now()
    await waitFor(() => providerClosedAt !== undefined, 2000)
    assert.ok(providerClosedAt - hungUpAt < 1000)
    assert.equal((await request(s.url, { method: 'GET', path: '/_router/status' })).status, 200)
  } finally { await s.cleanup() }
})
