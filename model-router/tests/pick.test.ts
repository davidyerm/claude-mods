import { expect, test } from 'claude-code/testing'
import { isRoutable, providerState, wireModel } from '../hooks/pick'
import { routerStatus } from './world'

// setPick/clearPick are $.state shells: that the pick routes and is cleared when
// the session model changes is tested through hooks in Task 23.

test('the wire model carries the pick and the Claude fallback id', () => {
  expect(wireModel('DS/ds-chat', 'claude-opus-5-5')).toBe('router:DS/ds-chat#claude-opus-5-5')
  expect(wireModel('OR/anthropic/claude-x', 'claude-sonnet-5-5')).toBe('router:OR/anthropic/claude-x#claude-sonnet-5-5')
})

test('provider state comes from the last router status', () => {
  const s = routerStatus({ providers: [
    { name: 'DS', available: true, breaker: 'open' },
    { name: 'OR', available: false, reason: 'env OR_KEY not set', breaker: 'closed' },
  ] })
  expect(providerState(s, 'DS/ds-chat')).toBe('paused')
  expect(providerState(s, 'OR/ds-chat')).toBe('unavailable')
  expect(providerState(s, 'XX/y')).toBe('unknown')
  expect(providerState(null, 'DS/ds-chat')).toBe('unknown')
  expect(isRoutable(routerStatus(), 'DS/ds-chat')).toBe(true)
  expect(isRoutable(null, 'DS/ds-chat')).toBe(false)
})

test('a provider the last status does not list yet is routable once a status is known (final fix I5)', () => {
  expect(isRoutable(routerStatus({ providers: [] }), 'New/m1')).toBe(true)
  expect(isRoutable(null, 'New/m1')).toBe(false)
})
