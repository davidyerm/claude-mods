// Fake Anthropic-style servers for integration tests and e2e.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

export function jsonReply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(typeof value === 'string' ? value : JSON.stringify(value))
}

// An SSE reply of `events` text deltas, `gapMs` apart.
export async function sseReply(res, model, { gapMs = 0, events = 2 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  for (let i = 0; i < events; i++) {
    if (i > 0 && gapMs > 0) await new Promise(r => setTimeout(r, gapMs))
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `part${i} from ${model}` } })
  }
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
  ev('message_stop', {})
  res.end()
}

export const defaultHandler = (req, res, body) => {
  const json = body ? JSON.parse(body) : {}
  if (req.url.includes('count_tokens')) return jsonReply(res, 200, { input_tokens: 7 })
  if (json.stream) return sseReply(res, json.model)
  return jsonReply(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'text', text: `ok from ${json.model}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
}

export async function startFake({ tls, handler = defaultHandler } = {}) {
  const requests = []
  let current = handler
  const onRequest = (req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      Promise.resolve().then(() => current(req, res, body)).catch(() => res.destroy())
    })
  }
  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: fn => { current = fn },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

export async function closedPort() {
  const s = net.createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise(r => s.close(r))
  return port
}
