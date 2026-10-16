import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { makeHome, startRouter, request, spawnCli, waitFor } from './helpers.mjs'
import { startFake, jsonReply, sseReply, closedPort } from './fakes.mjs'
import { getStatus } from '../lib/client.mjs'

const TOKEN = { 'x-router-token': 'test-token' }

async function routedSetup(providerHandler) {
  const upstream = await startFake()
  const provider = await startFake(providerHandler ? { handler: providerHandler } : {})
  const home = makeHome({ config: { upstream: upstream.url, providers: [{ name: 'DS', baseUrl: provider.url, apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }] }] } })
  const r = await startRouter(home, { env: { DS_KEY: 'k' } })
  return { upstream, provider, ...r, cleanup: async () => { await r.close(); await upstream.close(); await provider.close() } }
}
const countBody = { model: 'router:DS/ds-chat#claude-opus-5-5', messages: [{ role: 'user', content: 'hello there' }] }

test('count_tokens is forwarded to a provider that supports it', async () => {
  const s = await routedSetup()
  try {
    const r = await request(s.url, { path: '/v1/messages/count_tokens', headers: TOKEN, body: countBody })
    assert.deepEqual(JSON.parse(r.text), { input_tokens: 7 })
  } finally { await s.cleanup() }
})

test('count_tokens is estimated locally on a provider 404, without counting a failure', async () => {
  const s = await routedSetup((req, res) => jsonReply(res, 404, { error: { message: 'not found' } }))
  try {
    for (let i = 0; i < 3; i++) {
      const r = await request(s.url, { path: '/v1/messages/count_tokens', headers: TOKEN, body: countBody })
      assert.deepEqual(JSON.parse(r.text), { input_tokens: Math.ceil(JSON.stringify(countBody).length / 4) })
    }
    assert.equal(s.router.breaker.status('DS'), 'closed')
    assert.equal(s.upstream.requests.length, 0)
  } finally { await s.cleanup() }
})

test('shutdown with drain lets an in-flight stream finish, then stops', async () => {
  const s = await routedSetup((req, res, body) => sseReply(res, JSON.parse(body).model, { gapMs: 400, events: 2 }))
  try {
    const streaming = request(s.url, { headers: TOKEN, body: { ...countBody, stream: true } })
    await waitFor(() => s.provider.requests.length === 1)
    const stop = await request(s.url, { path: '/_router/shutdown?drain=1', headers: TOKEN })
    assert.equal(stop.status, 202)
    const done = await streaming
    assert.match(done.text, /part1/)
    await waitFor(async () => (await getStatus(s.port)).kind === 'down')
  } finally { await s.upstream.close(); await s.provider.close() }
})

test('idle routers stop by themselves', async () => {
  const home = makeHome({ config: {} })
  const s = await startRouter(home, { idleMs: 200 })
  let stopped = false
  s.router.onStopped(() => { stopped = true })
  await waitFor(() => stopped, 3000)
})

test('the CLI prints its listen line and serves status', async () => {
  const port = await closedPort()
  const cli = spawnCli(makeHome({ config: { port } }))
  try {
    await waitFor(() => cli.output().includes('listening on 127.0.0.1:'), 5000)
    assert.equal((await getStatus(port)).kind, 'ours')
  } finally { cli.child.kill(); await cli.exited }
})

test('two CLIs racing for one port: one serves, the other exits 0', async () => {
  const port = await closedPort()
  const home = makeHome({ config: { port } })
  const a = spawnCli(home)
  const b = spawnCli(home)
  try {
    const first = await Promise.race([a.exited.then(code => ({ who: 'a', code })), b.exited.then(code => ({ who: 'b', code }))])
    assert.equal(first.code, 0)
    assert.equal((await getStatus(port)).kind, 'ours')
  } finally { a.child.kill(); b.child.kill(); await Promise.all([a.exited, b.exited]) }
})

test('a port held by another program: the CLI exits 2 with a hint', async () => {
  const foreign = http.createServer((req, res) => res.end('{"hello":"world"}'))
  await new Promise(r => foreign.listen(0, '127.0.0.1', r))
  const port = foreign.address().port
  try {
    const cli = spawnCli(makeHome({ config: { port } }))
    assert.equal(await cli.exited, 2)
    assert.match(cli.output(), /port \d+ is used by another program/)
  } finally { foreign.close() }
})

test('the CLI exits 0 when idle', async () => {
  const port = await closedPort()
  const cli = spawnCli(makeHome({ config: { port } }), { MODEL_ROUTER_IDLE_MS: '300' })
  assert.equal(await cli.exited, 0)
})
