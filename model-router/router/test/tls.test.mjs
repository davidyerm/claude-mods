import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeHome, spawnCli, request, waitFor } from './helpers.mjs'
import { startFake, closedPort } from './fakes.mjs'
import { getStatus } from '../lib/client.mjs'

const dir = new URL('./fixtures/tls/', import.meta.url)
const tls = { key: fs.readFileSync(new URL('server.key', dir)), cert: fs.readFileSync(new URL('server.pem', dir)) }
const CA = fileURLToPath(new URL('ca.pem', dir))

async function run(env) {
  const upstream = await startFake({ tls })
  const port = await closedPort()
  const cli = spawnCli(makeHome({ config: { port, upstream: upstream.url } }), env)
  try {
    await waitFor(async () => (await getStatus(port)).kind === 'ours', 5000)
    return await request(`http://127.0.0.1:${port}`, { body: { model: 'claude-opus-5-5' } })
  } finally { cli.child.kill(); await cli.exited; await upstream.close() }
}

test('an HTTPS upstream signed by a CA in NODE_EXTRA_CA_CERTS is trusted', async () => {
  const r = await run({ NODE_EXTRA_CA_CERTS: CA })
  assert.equal(r.status, 200)
})

test('an untrusted upstream certificate is a 502 that says tls', async () => {
  const r = await run({})
  assert.equal(r.status, 502)
  assert.match(JSON.parse(r.text).error.message, /\(tls: [A-Z_]+\)/)
})
