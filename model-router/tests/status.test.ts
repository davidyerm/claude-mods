import { expect, test } from 'claude-code/testing'
import { validateConfig } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import { DOWN_LINE, isForSession, label, statusLine, toastFor } from '../hooks/status'
import { checkPick, healthOutcome, needsRespawn, toastsFor } from '../hooks/monitor'
import { CONFIG_JSON, routerStatus } from './world'

// tick/health/refresh are $ shells over the pure functions tested here; their
// hook-driven tests (start($) plus w.clock.advance) land in Task 23.

const config = (validateConfig(CONFIG_JSON) as { ok: true; config: Config }).config
const noOverrides = { ...config, overrides: {} }
const ev = (patch: object) => ({ seq: 1, t: 't', kind: 'fallback', ...patch })

test('status line: pick and overrides, exact text', () => {
  expect(statusLine({ pick: 'DS/ds-chat', config, status: routerStatus(), isDown: false }))
    .toBe('main: [DS] ds-chat · haiku→[DS] ds-chat')
})

test('status line: nothing routed', () => {
  expect(statusLine({ pick: null, config: noOverrides, status: routerStatus(), isDown: false })).toBe('router: /router to pick')
  expect(statusLine({ pick: null, config, status: routerStatus(), isDown: false })).toBe('router: /router to pick · haiku→[DS] ds-chat')
})

test('status line: a paused provider has two spaces after the warning sign', () => {
  const paused = routerStatus({ providers: [{ name: 'DS', available: true, breaker: 'open' }] })
  expect(statusLine({ pick: 'DS/ds-chat', config, status: paused, isDown: false })).toBe('main: [DS] ⚠  paused · haiku→[DS] ⚠  paused')
  expect(label('DS/ds-chat', paused)).toBe('[DS] ⚠  paused')
})

test('status line: an unavailable provider and a down router', () => {
  const missing = routerStatus({ providers: [{ name: 'DS', available: false, reason: 'env DS_KEY not set', breaker: 'closed' }] })
  expect(statusLine({ pick: null, config, status: missing, isDown: false })).toBe('router: /router to pick · haiku→[DS] ⚠  unavailable')
  expect(statusLine({ pick: 'DS/ds-chat', config, status: null, isDown: true })).toBe(DOWN_LINE)
  expect(DOWN_LINE).toBe('model-router DOWN — /router doctor')
})

test('toasts follow spec 7.7', () => {
  expect(toastFor(ev({ provider: 'DeepSeek', status: 429, model: 'claude-haiku-5-5', text: 'slow down' }))).toBe('[DeepSeek] 429 → used claude-haiku-5-5')
  expect(toastFor(ev({ provider: 'Kimi', status: 400, model: 'claude-opus-5-5', text: "unknown field 'thinking'" }))).toBe("[Kimi] rejected (400: unknown field 'thinking') — /router doctor")
  expect(toastFor(ev({ provider: 'DS', model: 'claude-opus-5-5', text: 'connect: ECONNREFUSED' }))).toBe('[DS] connect: ECONNREFUSED → used claude-opus-5-5')
  expect(toastFor(ev({ kind: 'learned', provider: 'DeepSeek', model: 'deepseek-chat', text: '8192' }))).toBe('[DeepSeek] max output 8192 learned')
  expect(toastFor(ev({ kind: 'breaker-open', provider: 'DS' }))).toBe('[DS] ⚠  paused for 5 min after 3 failures; requests go to Claude')
  expect(toastFor(ev({ kind: 'breaker-close', provider: 'DS' }))).toBe('[DS] resumed')
  expect(toastFor(ev({ kind: 'config-error', text: 'providers[0].baseUrl: must be a URL' }))).toBe('model-router.json: providers[0].baseUrl: must be a URL')
  for (const kind of ['provider-error', 'upstream-error', 'config-reloaded']) expect(toastFor(ev({ kind }))).toBe(null)
})

test('only this session and global events toast', () => {
  expect(isForSession(ev({ session: 's1' }), 's1')).toBe(true)
  expect(isForSession(ev({ session: 's2' }), 's1')).toBe(false)
  expect(isForSession(ev({ kind: 'breaker-open' }), 's1')).toBe(true)
})

test('new events for this session toast once; the cursor moves past all of them', () => {
  const events = [
    { seq: 1, t: 't', kind: 'learned', session: 's1', provider: 'DS', model: 'ds-chat', text: '8192' },
    { seq: 2, t: 't', kind: 'learned', session: 's2', provider: 'DS', model: 'ds-chat', text: '4096' },
  ]
  const first = toastsFor(events, 2, 0, 's1')
  expect(first).toEqual({ toasts: ['[DS] max output 8192 learned'], lastSeq: 2 })
  expect(toastsFor([], 2, first.lastSeq, 's1')).toEqual({ toasts: [], lastSeq: 2 })
})

test('a restarted router (lower seq) resets the cursor without replaying', () => {
  const events = [{ seq: 1, t: 't', kind: 'breaker-open', provider: 'DS' }]
  expect(toastsFor(events, 1, 50, 's1')).toEqual({ toasts: [], lastSeq: 1 })
})

test('a pick removed from config is cleared with a toast', () => {
  const refs = ['DS/ds-chat']
  expect(checkPick({ pick: 'DS/ds-reasoner', refs, seen: 'claude-opus-5-5', model: 'claude-opus-5-5' }))
    .toEqual({ clear: true, toast: '[DS] ds-reasoner was removed — main model back to Claude' })
})

test('a Claude model picked in the built-in picker clears the pick', () => {
  expect(checkPick({ pick: 'DS/ds-chat', refs: ['DS/ds-chat'], seen: 'claude-opus-5-5', model: 'claude-sonnet-5-5' }))
    .toEqual({ clear: true, toast: 'Main model back to Claude (claude-sonnet-5-5 picked in /model)' })
})

test('a valid pick, an unchanged model or no pick is kept', () => {
  expect(checkPick({ pick: 'DS/ds-chat', refs: ['DS/ds-chat'], seen: 'claude-opus-5-5', model: 'claude-opus-5-5' })).toBe('keep')
  expect(checkPick({ pick: 'DS/ds-chat', refs: ['DS/ds-chat'], seen: null, model: 'claude-sonnet-5-5' })).toBe('keep')
  expect(checkPick({ pick: null, refs: [], seen: null, model: 'x' })).toBe('keep')
})

test('health: a live router is kept; a dead one is respawned and says so; a failed respawn is DOWN', () => {
  const status = routerStatus({ eventsSeq: 7 })
  expect(needsRespawn({ kind: 'ours', status })).toBe(false)
  expect(needsRespawn({ kind: 'down', reason: 'x' })).toBe(true)
  expect(needsRespawn({ kind: 'foreign' })).toBe(true)
  expect(healthOutcome({ kind: 'ours', status }, null)).toEqual({ status, isDown: false })
  expect(healthOutcome({ kind: 'down', reason: 'x' }, { ok: true, status, started: true }))
    .toEqual({ status, isDown: false, lastSeq: 7, toast: 'model-router restarted' })
  expect(healthOutcome({ kind: 'down', reason: 'x' }, { ok: false, reason: 'boom' })).toEqual({ status: null, isDown: true })
})
