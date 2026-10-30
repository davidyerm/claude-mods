import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseMaxTokensLimit, createLearnedTable, appliedLimit, FALLBACK_LIMIT } from '../lib/learned.mjs'

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/limit-errors.json', import.meta.url), 'utf8'))

for (const f of fixtures.limits) {
  test(`learns ${f.expect} from: ${f.text.slice(0, 60)}`, () => {
    assert.equal(parseMaxTokensLimit(400, f.text, f.requested), f.expect)
  })
}

for (const f of fixtures.notLimits) {
  test(`does not learn from: ${f.text.slice(0, 60)}`, () => {
    assert.equal(parseMaxTokensLimit(400, f.text, f.requested), null)
  })
}

test('only a 400 teaches, and nothing is learned at or below the fallback', () => {
  assert.equal(parseMaxTokensLimit(500, 'max_tokens [1, 8192]', 32000), null)
  assert.equal(parseMaxTokensLimit(400, 'max_tokens too large', 4096), null)
  assert.equal(FALLBACK_LIMIT, 8192)
})

test('appliedLimit is min(requested, learned, policy) and never raises', () => {
  const cases = [
    [32000, {}, 32000],
    [32000, { learned: 8192 }, 8192],
    [32000, { policy: 4000 }, 4000],
    [32000, { learned: 8192, policy: 4000 }, 4000],
    [32000, { learned: 4000, policy: 8192 }, 4000],
    [1000, { learned: 8192, policy: 4000 }, 1000],
    [1000, { learned: undefined, policy: null }, 1000],
  ]
  for (const [requested, limits, expected] of cases) assert.equal(appliedLimit(requested, limits), expected)
})

test('the learned table stores facts and forgets one or all', () => {
  const table = createLearnedTable({ now: () => Date.UTC(2026, 9, 16) })
  table.set('A/x', 8192, 'provider-400')
  table.set('B/y', 4096, 'provider-400')
  assert.equal(table.get('A/x'), 8192)
  assert.deepEqual(table.toJSON()['A/x'], { maxOutputTokens: 8192, learnedAt: '2026-10-16T00:00:00.000Z', source: 'provider-400' })
  assert.equal(table.forget('A/x'), 1)
  assert.equal(table.get('A/x'), undefined)
  assert.equal(table.forget('nope'), 0)
  assert.equal(table.forget('all'), 1)
  assert.deepEqual(table.toJSON(), {})
})
