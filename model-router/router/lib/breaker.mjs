export function createBreaker({ now = Date.now, threshold = 3, openMs = 5 * 60_000, onChange = () => {} } = {}) {
  const states = new Map() // name -> { failures, openedAt | null }
  const get = name => states.get(name) ?? { failures: 0, openedAt: null }

  function status(name) {
    const s = get(name)
    if (s.openedAt === null) return 'closed'
    return now() - s.openedAt >= openMs ? 'half-open' : 'open'
  }

  function success(name) {
    const was = status(name)
    states.set(name, { failures: 0, openedAt: null })
    if (was !== 'closed') onChange('breaker-close', name)
  }

  function failure(name) {
    const was = status(name)
    if (was === 'open') return
    if (was === 'half-open') {
      states.set(name, { failures: threshold, openedAt: now() })
      onChange('breaker-open', name)
      return
    }
    const failures = get(name).failures + 1
    if (failures >= threshold) {
      states.set(name, { failures, openedAt: now() })
      onChange('breaker-open', name)
    } else states.set(name, { failures, openedAt: null })
  }

  return { status, canRoute: name => status(name) !== 'open', success, failure }
}
