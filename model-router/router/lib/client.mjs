// The Node-side client of a router on 127.0.0.1: used by router.mjs and launch.mjs.
import http from 'node:http'

export function requestJson(port, path, { method = 'GET', headers = {}, body, timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', c => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ ok: true, status: res.statusCode, json })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', error => resolve({ ok: false, error }))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export async function getStatus(port) {
  const r = await requestJson(port, '/_router/status')
  if (!r.ok) return { kind: 'down', reason: r.error.code ?? r.error.message }
  return r.json?.name === 'model-router' ? { kind: 'ours', status: r.json } : { kind: 'foreign' }
}

export async function postShutdown(port, token) {
  const r = await requestJson(port, '/_router/shutdown?drain=1', { method: 'POST', headers: { 'x-router-token': token } })
  return r.ok && r.status === 202
}

export async function waitFor(fn, timeoutMs = 3000, everyMs = 20) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > until) throw new Error(`waitFor timed out after ${timeoutMs} ms`)
    await new Promise(r => setTimeout(r, everyMs))
  }
}
