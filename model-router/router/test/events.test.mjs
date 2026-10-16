import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createEventLog, createRotatingFile } from '../lib/events.mjs'
import { tempHome } from './helpers.mjs'

test('events get increasing seq, drop undefined fields and cut text to 200', () => {
  const log = createEventLog({ now: () => 0 })
  const a = log.emit({ kind: 'fallback', session: 's', provider: 'P', status: undefined, text: 'x'.repeat(500) })
  assert.deepEqual(Object.keys(a).sort(), ['kind', 'provider', 'seq', 'session', 't', 'text'])
  assert.equal(a.seq, 1)
  assert.equal(a.text.length, 200)
  assert.equal(log.emit({ kind: 'learned' }).seq, 2)
  assert.deepEqual(log.after(1).map(e => e.seq), [2])
  assert.equal(log.lastSeq(), 2)
})

test('the ring keeps the last N events', () => {
  const log = createEventLog({ capacity: 3 })
  for (let i = 0; i < 5; i++) log.emit({ kind: 'learned' })
  assert.deepEqual(log.after(0).map(e => e.seq), [3, 4, 5])
})

test('events are appended to the jsonl file', () => {
  const file = path.join(tempHome(), 'events.jsonl')
  const log = createEventLog({ file })
  log.emit({ kind: 'config-reloaded' })
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(JSON.parse(lines[0]).kind, 'config-reloaded')
})

test('rotating files keep at most `keep` files of about maxBytes', () => {
  const file = path.join(tempHome(), 'r.log')
  const out = createRotatingFile(file, { maxBytes: 100, keep: 3 })
  for (let i = 0; i < 10; i++) out.append(`${String(i).repeat(60)}\n`)
  assert.ok(fs.existsSync(file))
  assert.ok(fs.existsSync(`${file}.1`))
  assert.ok(fs.existsSync(`${file}.2`))
  assert.equal(fs.existsSync(`${file}.3`), false)
  assert.ok(fs.statSync(file).size <= 100)
  assert.match(fs.readFileSync(file, 'utf8'), /^9+\n$/)
})
