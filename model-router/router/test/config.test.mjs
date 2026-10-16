import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { routerHome, routerPaths, readConfigFile, createConfigStore } from '../lib/config.mjs'
import { tempHome, writeJson, waitFor } from './helpers.mjs'

test('routerHome prefers MODEL_ROUTER_HOME, then CLAUDE_CONFIG_DIR', () => {
  assert.equal(routerHome({ MODEL_ROUTER_HOME: 'A', CLAUDE_CONFIG_DIR: 'B' }), 'A')
  assert.equal(routerHome({ CLAUDE_CONFIG_DIR: 'B' }), 'B')
  assert.match(routerHome({}), /\.claude$/)
})

test('routerPaths lays out the files of spec 5.1', () => {
  const p = routerPaths('H')
  assert.equal(p.config, path.join('H', 'model-router.json'))
  assert.equal(p.token, path.join('H', 'model-router', 'token'))
  assert.equal(p.events, path.join('H', 'model-router', 'events.jsonl'))
  assert.equal(p.log, path.join('H', 'model-router', 'router.log'))
})

test('readConfigFile reports missing files and bad JSON', () => {
  const home = tempHome()
  const file = path.join(home, 'model-router.json')
  assert.equal(readConfigFile(file).missing, true)
  writeJson(file, '{ nope')
  const r = readConfigFile(file)
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /invalid JSON/)
})

test('readConfigFile never echoes file content in its errors', () => {
  const home = tempHome()
  const file = path.join(home, 'model-router.json')
  writeJson(file, '{"apiKey": sk-secret-123456}')
  const r = readConfigFile(file)
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /invalid JSON/)
  assert.doesNotMatch(r.errors[0].message, /sk-secret/)
})

test('the store keeps the last valid config and reports errors and reloads', async () => {
  const home = tempHome()
  const file = path.join(home, 'model-router.json')
  writeJson(file, { port: 5000 })
  const events = []
  const store = createConfigStore({ file, onEvent: e => events.push(e), debounceMs: 30 })
  try {
    assert.equal(store.current().port, 5000)
    writeJson(file, '{ "port": ')               // an editor's half-written save
    await waitFor(() => events.some(e => e.kind === 'config-error'))
    assert.equal(store.current().port, 5000)
    writeJson(file, { port: 5001 })
    await waitFor(() => events.some(e => e.kind === 'config-reloaded'))
    assert.equal(store.current().port, 5001)
  } finally { store.close() }
})

test('a store over a missing file starts empty and reports it', () => {
  const home = tempHome()
  const events = []
  const store = createConfigStore({ file: path.join(home, 'model-router.json'), onEvent: e => events.push(e) })
  try {
    assert.equal(store.current(), null)
    assert.equal(events[0].kind, 'config-error')
  } finally { store.close() }
})
