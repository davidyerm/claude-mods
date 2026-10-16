// THROWAWAY spike: does turn.step accept a non-Claude model id, and does
// session.start finish before the first model request?
import type { Register } from 'claude-code'

const BASE = 'http://127.0.0.1:4199'
const ROUTED = 'router:Test/fake-model'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.http.fetch(`${BASE}/mark?ev=start-begin`)
    await $.http.fetch(`${BASE}/slow?ms=3000`)
    await $.http.fetch(`${BASE}/mark?ev=start-end`)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    await $.http.fetch(`${BASE}/mark?ev=step-in&d=${encodeURIComponent(JSON.stringify({ model: e.model, agentId: e.agentId, index: e.index }))}`)
    try {
      const r = yield* next({ ...e, model: ROUTED })
      await $.http.fetch(`${BASE}/mark?ev=step-out&d=${encodeURIComponent(JSON.stringify({ answer: r.answer, stop: r.stopReason, usageModel: (r.usage as { model?: string } | null)?.model }))}`)
      return r
    } catch (err) {
      await $.http.fetch(`${BASE}/mark?ev=step-error&d=${encodeURIComponent(String(err))}`)
      throw err
    }
  })
}
