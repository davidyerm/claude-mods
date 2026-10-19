// THROWAWAY spike: fake Anthropic endpoint that logs every request.
import http from 'node:http'
import fs from 'node:fs'

const PORT = 4199
const LOG = new URL('./capture.jsonl', import.meta.url)
const t0 = Date.now()
const log = o => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now() - t0, ...o }) + '\n')

const sse = (res, model) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_spike', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `spike-ok from ${model}` } })
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
  ev('message_stop', {})
  res.end()
}

const sseTool = (res, model) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type, data) => res.write(`event: ${type}
data: ${JSON.stringify({ type, ...data })}

`)
  ev('message_start', { message: { id: 'msg_spike2', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_spike1', name: 'Agent', input: {} } })
  ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'spike sub', prompt: 'say sub-hi', subagent_type: 'general-purpose', model: 'haiku' }) } })
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } })
  ev('message_stop', {})
  res.end()
}

http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/mark') { log({ mark: url.searchParams.get('ev'), data: url.searchParams.get('d') }); return res.end('ok') }
    if (url.pathname === '/slow') { await new Promise(r => setTimeout(r, Number(url.searchParams.get('ms') ?? 3000))); return res.end('ok') }
    let json = {}
    try { json = JSON.parse(body) } catch {}
    const h = { ...req.headers }
    for (const k of ['authorization', 'x-api-key']) if (h[k]) h[k] = '<redacted>'
    log({ method: req.method, path: url.pathname, model: json.model, stream: json.stream, maxTokens: json.max_tokens,
          systemHead: JSON.stringify(json.system ?? '').slice(0, 160), nMessages: json.messages?.length, nTools: json.tools?.length,
          beta: h['anthropic-beta'],
          session: h['x-claude-code-session-id'], contextManagement: json.context_management, rawModel: json.model, bodyKeys: Object.keys(json), thinking: json.thinking, outputConfig: json.output_config, lastUser: JSON.stringify(json.messages?.at(-1)?.content ?? '').slice(-200) })
    if (url.pathname.endsWith('/count_tokens')) return res.end(JSON.stringify({ input_tokens: 10 }))
    if (!url.pathname.endsWith('/messages')) { res.writeHead(404); return res.end('{}') }
    const txt = JSON.stringify(json.messages ?? [])
    if (json.stream && txt.includes('SPIKE_AGENT') && !txt.includes('tool_result') && (json.tools ?? []).some(t => t.name === 'Agent')) return sseTool(res, json.model)
    if (json.stream) return sse(res, json.model)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_spike', type: 'message', role: 'assistant', model: json.model,
      content: [{ type: 'text', text: `spike-ok from ${json.model}` }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4 } }))
  })
}).listen(PORT, '127.0.0.1', () => log({ mark: 'server-up' }))
