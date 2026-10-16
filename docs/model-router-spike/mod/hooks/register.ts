// THROWAWAY spike: V7 (does '#' survive in the model string?) and V2
// (does x-claude-code-session-id equal $.session.id()?).
import type { Register } from 'claude-code'

const BASE = 'http://127.0.0.1:4199'
const ROUTED = 'router:Test/fake-model#claude-opus-5-5'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    await $.http.fetch(`${BASE}/mark?ev=session-id&d=${encodeURIComponent(id)}`)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    await $.http.fetch(`${BASE}/mark?ev=step-in&d=${encodeURIComponent(JSON.stringify({ model: e.model, agentId: e.agentId }))}`)
    return yield* next({ ...e, model: ROUTED })
  })
}
