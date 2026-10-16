import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBreaker } from '../lib/breaker.mjs'

function setup() {
  let t = 0
  const changes = []
  const b = createBreaker({ now: () => t, onChange: (kind, name) => changes.push(`${kind}:${name}`) })
  return { b, changes, advance: ms => { t += ms } }
}

test('three consecutive failures open the breaker for five minutes', () => {
  const { b, changes, advance } = setup()
  b.failure('P'); b.failure('P')
  assert.equal(b.status('P'), 'closed')
  b.failure('P')
  assert.equal(b.status('P'), 'open')
  assert.equal(b.canRoute('P'), false)
  assert.deepEqual(changes, ['breaker-open:P'])
  advance(299_999)
  assert.equal(b.status('P'), 'open')
  advance(1)
  assert.equal(b.status('P'), 'half-open')
  assert.equal(b.canRoute('P'), true)
})

test('a success resets the count', () => {
  const { b } = setup()
  b.failure('P'); b.failure('P'); b.success('P'); b.failure('P'); b.failure('P')
  assert.equal(b.status('P'), 'closed')
})

test('half-open: success closes, failure re-opens', () => {
  const { b, changes, advance } = setup()
  for (let i = 0; i < 3; i++) b.failure('P')
  advance(300_000)
  b.success('P')
  assert.equal(b.status('P'), 'closed')
  for (let i = 0; i < 3; i++) b.failure('P')
  advance(300_000)
  b.failure('P')
  assert.equal(b.status('P'), 'open')
  assert.deepEqual(changes, ['breaker-open:P', 'breaker-close:P', 'breaker-open:P', 'breaker-open:P'])
})

test('providers are independent', () => {
  const { b } = setup()
  for (let i = 0; i < 3; i++) b.failure('A')
  assert.equal(b.canRoute('B'), true)
})
