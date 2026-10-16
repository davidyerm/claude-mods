import { test } from 'node:test'
import assert from 'node:assert/strict'
import { send, readText, errorMessage, describeFailure } from '../lib/forward.mjs'
import { startFake, closedPort, jsonReply } from './fakes.mjs'

test('send resolves at the response with status and body readable', async () => {
  const fake = await startFake()
  try {
    const body = JSON.stringify({ model: 'm' })
    const r = await send({ url: `${fake.url}/v1/messages`, headers: { 'content-type': 'application/json' }, body })
    assert.equal(r.ok, true)
    assert.equal(r.res.statusCode, 200)
    assert.match(await readText(r.res), /ok from m/)
    assert.equal(fake.requests[0].headers['content-length'], String(Buffer.byteLength(body)))
  } finally { await fake.close() }
})

test('a refused connection is a connect failure', async () => {
  const r = await send({ url: `http://127.0.0.1:${await closedPort()}/x`, headers: {}, body: '' })
  assert.deepEqual([r.ok, r.kind], [false, 'connect'])
  assert.match(describeFailure(r), /^connect: ECONNREFUSED/)
})

test('no first byte within the limit is a timeout', async () => {
  const fake = await startFake({ handler: () => {} }) // never answers
  try {
    const r = await send({ url: `${fake.url}/x`, headers: {}, body: '{}', firstByteTimeoutMs: 100 })
    assert.deepEqual([r.ok, r.kind], [false, 'timeout'])
  } finally { await fake.close() }
})

test('an aborted signal is an aborted failure', async () => {
  const fake = await startFake({ handler: () => {} })
  try {
    const ac = new AbortController()
    const p = send({ url: `${fake.url}/x`, headers: {}, body: '{}', signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    assert.equal((await p).kind, 'aborted')
  } finally { await fake.close() }
})

test('readText stops at the limit', async () => {
  const fake = await startFake({ handler: (req, res) => jsonReply(res, 502, 'x'.repeat(100_000)) })
  try {
    const r = await send({ url: `${fake.url}/x`, headers: {}, body: '{}' })
    assert.equal((await readText(r.res, 1000)).length, 1000)
  } finally { await fake.close() }
})

test('errorMessage reads Anthropic JSON and tames HTML', () => {
  assert.equal(errorMessage('{"type":"error","error":{"type":"invalid_request_error","message":"unknown field \'thinking\'"}}'), "unknown field 'thinking'")
  assert.equal(errorMessage('{"message":"flat"}'), 'flat')
  assert.equal(errorMessage(`<html><body><h1>502   Bad Gateway</h1>${'<p>x</p>'.repeat(200)}</body></html>`).slice(0, 15), '502 Bad Gateway')
  assert.ok(errorMessage('<p>x</p>'.repeat(500)).length <= 200)
})

test('send never rejects on a bad URL', async () => {
  const r = await send({ url: 'not a url', headers: {}, body: '{}' })
  assert.deepEqual([r.ok, r.kind], [false, 'connect'])
})

test('send never rejects on an invalid header value', async () => {
  const fake = await startFake()
  try {
    const r = await send({ url: `${fake.url}/x`, headers: { 'x-api-key': 'sk\n' }, body: '{}' })
    assert.deepEqual([r.ok, r.kind], [false, 'connect'])
  } finally { await fake.close() }
})
