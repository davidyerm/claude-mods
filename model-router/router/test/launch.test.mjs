import { test } from 'node:test'
import { compareVersions, isReusable } from '../version.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeHome, tempHome } from './helpers.mjs'
import { startFake, jsonReply, closedPort } from './fakes.mjs'
import { getStatus, postShutdown } from '../lib/client.mjs'
import { fingerprint } from '../lib/fingerprint.mjs'
import { PROBE_BETA, PROBE_CONTEXT_MANAGEMENT } from '../lib/probe-request.mjs'

const LAUNCH = fileURLToPath(new URL('../launch.mjs', import.meta.url))

function launch(args, { input, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [LAUNCH, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.on('exit', code => resolve({ code, json: JSON.parse(out.trim().split('\n').at(-1) || 'null') }))
    child.stdin.end(input ?? '')
  })
}

test('the probe request carries the captured shape', () => {
  assert.ok(!PROBE_BETA.includes('PASTE') && PROBE_BETA.includes('claude-code'))
  assert.ok(!JSON.stringify(PROBE_CONTEXT_MANAGEMENT).includes('PASTE'))
})

test('write is atomic, --private works, delete tolerates a missing file', async () => {
  const file = path.join(tempHome(), 'a', 'b.json')
  assert.deepEqual((await launch(['write', file], { input: '{"x":1}' })).json.ok, true)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1}')
  assert.equal((await launch(['write', file, '--private'], { input: 'secret' })).code, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), 'secret')
  assert.ok(!fs.readdirSync(path.dirname(file)).some(n => n.includes('.tmp-')))
  assert.equal((await launch(['delete', file])).json.ok, true)
  assert.equal(fs.existsSync(file), false)
  assert.equal((await launch(['delete', file])).json.ok, true)
})

test('ensure-token creates once and then returns the same token', async () => {
  const file = path.join(tempHome(), 'model-router', 'token')
  const a = (await launch(['ensure-token', file])).json
  const b = (await launch(['ensure-token', file])).json
  assert.match(a.token, /^[0-9a-f]{64}$/)
  assert.deepEqual([a.created, b.created, b.token], [true, false, a.token])
})

test('env-check reports fingerprints, never values', async () => {
  const r = (await launch(['env-check', 'MR_A', 'MR_B'], { env: { MR_A: 'value-a' } })).json
  assert.deepEqual(r.keys, { MR_A: fingerprint('value-a'), MR_B: null })
})

test('probe: a provider with a max_tokens ceiling is learned and retried', async () => {
  const provider = await startFake({ handler: (req, res, body) => {
    const json = JSON.parse(body)
    if (json.max_tokens > 8192) return jsonReply(res, 400, { error: { message: 'max_tokens must be less than or equal to 8192' } })
    return jsonReply(res, 200, { type: 'message', content: [{ type: 'text', text: 'OK' }] })
  } })
  try {
    const r = (await launch(['probe'], { input: JSON.stringify({ mode: 'provider', provider: { baseUrl: provider.url, apiKeyEnv: 'MR_KEY' }, model: 'm' }), env: { MR_KEY: 'sk-probe' } })).json
    assert.deepEqual([r.ok, r.learnedMaxTokens], [true, 8192])
    const seen = provider.requests[0]
    assert.equal(seen.headers['x-api-key'], 'sk-probe')
    assert.equal(JSON.parse(seen.body).thinking, undefined)
    assert.equal(seen.headers['anthropic-beta'], undefined)
  } finally { await provider.close() }
})

test('probe: a rejected field is reported with status and text', async () => {
  const provider = await startFake({ handler: (req, res, body) => JSON.parse(body).thinking
    ? jsonReply(res, 400, { error: { message: "unknown field 'thinking'" } })
    : jsonReply(res, 200, {}) })
  try {
    const r = (await launch(['probe'], { input: JSON.stringify({ mode: 'provider', provider: { baseUrl: provider.url, apiKey: 'k', strip: [] }, model: 'm' }) })).json
    assert.deepEqual([r.ok, r.kind, r.status, r.text], [false, 'http', 400, "unknown field 'thinking'"])
  } finally { await provider.close() }
})

test('probe: a missing key and an unreachable host are reported', async () => {
  const noKey = (await launch(['probe'], { input: JSON.stringify({ mode: 'provider', provider: { baseUrl: 'https://x.example', apiKeyEnv: 'MR_UNSET' }, model: 'm' }) })).json
  assert.deepEqual([noKey.ok, noKey.kind, noKey.text], [false, 'no-key', 'env MR_UNSET not set'])
  const down = (await launch(['probe'], { input: JSON.stringify({ mode: 'tls', url: `http://127.0.0.1:${await closedPort()}` }) })).json
  assert.deepEqual([down.ok, down.kind], [false, 'connect'])
})

test('start launches a detached router, reuses it, and refuses a foreign port', async () => {
  const port = await closedPort()
  const home = makeHome({ config: { port } })
  const env = { MODEL_ROUTER_HOME: home }
  const first = await launch(['start'], { env })
  try {
    assert.deepEqual([first.json.ok, first.json.started], [true, true])
    assert.equal((await getStatus(port)).kind, 'ours')
    const second = await launch(['start'], { env })
    assert.deepEqual([second.json.started, second.json.pid], [false, first.json.pid])
    const forced = await launch(['start', '--force'], { env })
    assert.equal(forced.json.started, true)
    assert.notEqual(forced.json.pid, first.json.pid)
  } finally { await postShutdown(port, 'test-token') }

  const foreign = http.createServer((req, res) => res.end('{}'))
  await new Promise(r => foreign.listen(0, '127.0.0.1', r))
  try {
    const home2 = makeHome({ config: { port: foreign.address().port } })
    const r = await launch(['start'], { env: { MODEL_ROUTER_HOME: home2 } })
    assert.equal(r.code, 1)
    assert.match(r.json.error, /used by another program/)
  } finally { foreign.close() }
})

test('versions compare as semver numbers; start reuses a same or newer router, replaces an older one', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('0.1', '0.1.0'), 0)
  assert.equal(compareVersions(undefined, '0.1.0'), -1)
  assert.equal(isReusable('0.2.0', '0.1.0', false), true)
  assert.equal(isReusable('0.1.0', '0.1.0', false), true)
  assert.equal(isReusable('0.0.9', '0.1.0', false), false)
  assert.equal(isReusable('0.2.0', '0.1.0', true), false)
})
