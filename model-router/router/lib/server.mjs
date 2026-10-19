import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { VERSION } from '../version.mjs'
import { routerHome, routerPaths, createConfigStore } from './config.mjs'
import { resolveTarget } from './resolve.mjs'
import { passThroughHeaders, rewriteRouted, withModel, customHeaderNames } from './rewrite.mjs'
import { createLearnedTable, parseMaxTokensLimit } from './learned.mjs'
import { createBreaker } from './breaker.mjs'
import { createEventLog, createRotatingFile } from './events.mjs'
import { send, readText, errorMessage, describeFailure, scrubKey, CONNECT_TIMEOUT_MS, FIRST_BYTE_TIMEOUT_MS } from './forward.mjs'
import { buildStatus } from './status.mjs'
import { fingerprint } from './fingerprint.mjs'

const MESSAGES = '/v1/messages'
const COUNT_TOKENS = '/v1/messages/count_tokens'
export const TOKEN_HELP = 'model-router: routed requests need the x-router-token header. Run /router setup, then restart Claude Code.'

const apiError = (type, message) => ({ type: 'error', error: { type, message } })

function sendJson(res, status, value) {
  if (res.headersSent) return res.destroy()
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Aborts when the client hangs up before its response was fully written.
function clientGone(res) {
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableEnded) ac.abort() })
  return ac.signal
}

const RESPONSE_HOP = ['connection', 'keep-alive', 'transfer-encoding']

// Streams a response through as it arrives; `observe` sees each chunk too.
function pipe(from, to, observe) {
  const headers = { ...from.headers }
  for (const h of RESPONSE_HOP) delete headers[h]
  to.writeHead(from.statusCode, headers)
  to.flushHeaders()
  if (observe) from.on('data', observe)
  from.on('error', () => to.destroy())
  to.on('close', () => from.destroy())
  from.pipe(to)
}

export function createRouter(options = {}) {
  const env = options.env ?? process.env
  const paths = routerPaths(options.home ?? routerHome(env))
  const now = options.now ?? Date.now
  const envIdle = Number(env.MODEL_ROUTER_IDLE_MS ?? 30 * 60_000)
  const idleMs = options.idleMs ?? (Number.isFinite(envIdle) && envIdle > 0 ? envIdle : 30 * 60_000)
  const timeouts = {
    connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    firstByteTimeoutMs: options.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS,
  }
  // Pass-through has no first-byte limit: the gateway's own pace is not ours to judge.
  const upstreamTimeouts = { connectTimeoutMs: timeouts.connectTimeoutMs, firstByteTimeoutMs: Infinity }

  fs.mkdirSync(paths.stateDir, { recursive: true })
  const events = createEventLog({ file: paths.events, now })
  const requestLog = createRotatingFile(paths.log, { maxBytes: 5 * 1_048_576, keep: 3 })
  const learned = createLearnedTable({ now })
  const breaker = createBreaker({ now, onChange: (kind, provider) => events.emit({ kind, provider }) })
  const store = createConfigStore({ file: paths.config, onEvent: e => events.emit(e), debounceMs: options.debounceMs ?? 300 })
  const customNames = customHeaderNames(env.ANTHROPIC_CUSTOM_HEADERS)
  const startedAt = now()

  let server
  let idleTimer
  let drainTimer
  let active = 0
  let stopping = null
  let finished = false
  let stopped = () => {}

  function keyFor(provider) {
    if (provider.apiKey !== undefined) return { ok: true, key: provider.apiKey }
    const key = env[provider.apiKeyEnv]
    return key ? { ok: true, key } : { ok: false, reason: `env ${provider.apiKeyEnv} not set` }
  }
  function keyAvailability(name) {
    const provider = store.current()?.providers.find(p => p.name === name)
    if (!provider) return { ok: false, reason: 'unknown provider' }
    const k = keyFor(provider)
    return k.ok ? { ok: true } : k
  }
  function routeAvailability(name) {
    const k = keyAvailability(name)
    if (!k.ok) return k
    return breaker.canRoute(name) ? { ok: true } : { ok: false, reason: 'paused after repeated failures' }
  }
  function tokenOk(req) {
    let expected
    try { expected = fs.readFileSync(paths.token, 'utf8').trim() } catch { return false }
    const got = req.headers['x-router-token']
    if (typeof got !== 'string' || expected === '') return false
    const a = Buffer.from(got.trim())
    const b = Buffer.from(expected)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  function logRequest(fields) {
    try { requestLog.append(`${JSON.stringify({ t: new Date(now()).toISOString(), ...fields })}\n`) } catch {}
  }
  const status = () => buildStatus({
    version: VERSION, pid: process.pid, uptimeMs: now() - startedAt, config: store.current(), configOk: store.isOk(),
    keyAvailability, breaker, eventsSeq: events.lastSeq(),
  })

  function touch() {
    if (stopping) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => void stop({ drain: true }), idleMs)
  }

  async function toUpstream({ req, res, config, body, session, signal = clientGone(res) }) {
    const hasBody = !(body.length === 0 && (req.method === 'GET' || req.method === 'HEAD'))
    const r = await send({ url: config.upstream + req.url, method: req.method, headers: passThroughHeaders(req.headers), body: hasBody ? body : undefined, signal, ...upstreamTimeouts })
    if (!r.ok) {
      if (r.kind === 'aborted') return
      const why = describeFailure(r)
      events.emit({ kind: 'upstream-error', session, text: why })
      return sendJson(res, 502, apiError('api_error', `model-router: upstream ${config.upstream} failed (${why})`))
    }
    if (r.res.statusCode < 400) return pipe(r.res, res)
    let seen = ''
    r.res.on('end', () => events.emit({ kind: 'upstream-error', session, status: r.res.statusCode, text: errorMessage(seen) }))
    pipe(r.res, res, chunk => { if (seen.length < 4096) seen += chunk.toString('utf8') })
  }

  async function toProvider({ req, res, config, url, body, session, target }) {
    const { provider, providerModel, ref } = target
    const isCount = url.pathname === COUNT_TOKENS
    const key = keyFor(provider).key
    const signal = clientGone(res)
    const started = now()
    const text = body.toString('utf8')
    const rewrite = learnedLimit => rewriteRouted({ headers: req.headers, body: text, providerModel, apiKey: key, strip: provider.strip, customNames, limits: { learned: learnedLimit } })
    const attempt = async sent => {
      const r = await send({ url: provider.baseUrl + url.pathname, headers: sent.headers, body: sent.body, signal, ...timeouts })
      if (!r.ok) return { isAborted: r.kind === 'aborted', failure: { text: describeFailure(r) } }
      if (r.res.statusCode >= 400) return { failure: { status: r.res.statusCode, raw: await readText(r.res) } }
      return { res: r.res }
    }

    let sent = rewrite(learned.get(ref))
    let result = await attempt(sent)
    if (result.failure?.status === 400 && !isCount && typeof sent.maxTokens === 'number') {
      const limit = parseMaxTokensLimit(400, result.failure.raw, sent.maxTokens)
      if (limit !== null) {
        learned.set(ref, limit, 'provider-400')
        events.emit({ kind: 'learned', session, provider: provider.name, model: providerModel, text: String(limit) })
        sent = rewrite(limit)
        result = await attempt(sent)
      }
    }
    if (result.isAborted) return
    if (result.res) {
      breaker.success(provider.name)
      logRequest({ session, ref, outcome: 'routed', status: result.res.statusCode, ms: now() - started })
      return pipe(result.res, res)
    }

    const { status: failedStatus } = result.failure
    if (isCount && (failedStatus === 404 || failedStatus === 400)) return sendJson(res, 200, { input_tokens: Math.ceil(body.length / 4) })
    const message = result.failure.raw !== undefined ? errorMessage(scrubKey(result.failure.raw, key)) : scrubKey(result.failure.text, key)
    breaker.failure(provider.name)
    events.emit({ kind: 'provider-error', session, provider: provider.name, model: providerModel, status: failedStatus, text: message })
    events.emit({ kind: 'fallback', session, provider: provider.name, model: target.fallbackModel, status: failedStatus, text: message })
    logRequest({ session, ref, outcome: 'fallback', status: failedStatus, ms: now() - started })
    return toUpstream({ req, res, config, body: Buffer.from(withModel(text, target.fallbackModel)), session, signal })
  }

  async function control(req, res, url) {
    const route = `${req.method} ${url.pathname}`
    switch (route) {
      case 'GET /_router/status': return sendJson(res, 200, status())
      case 'GET /_router/limits': return sendJson(res, 200, { learned: learned.toJSON(), policy: null })
      case 'GET /_router/events': {
        const after = Number(url.searchParams.get('after') ?? 0)
        return sendJson(res, 200, { events: events.after(Number.isFinite(after) ? after : 0), lastSeq: events.lastSeq() })
      }
      case 'POST /_router/policy':
        return sendJson(res, 501, apiError('not_implemented', 'model-router: policyApi 1 is reserved for model-limits and not implemented in this release'))
    }
    if (!tokenOk(req)) return sendJson(res, 401, apiError('authentication_error', TOKEN_HELP))
    switch (route) {
      case 'GET /_router/keys': {
        const names = (store.current()?.providers ?? []).flatMap(p => (p.apiKeyEnv ? [p.apiKeyEnv] : []))
        return sendJson(res, 200, { keys: Object.fromEntries(names.map(n => [n, env[n] ? fingerprint(env[n]) : null])) })
      }
      case 'POST /_router/forget': {
        let ref
        try { ref = JSON.parse((await readBody(req)).toString('utf8')).ref } catch {}
        if (typeof ref !== 'string') return sendJson(res, 400, apiError('invalid_request_error', 'body must be {"ref": "<Provider/model-id>" | "all"}'))
        return sendJson(res, 200, { forgotten: learned.forget(ref) })
      }
      case 'POST /_router/shutdown':
        res.on('finish', () => void stop({ drain: url.searchParams.get('drain') === '1' }))
        return sendJson(res, 202, { stopping: true })
    }
    return sendJson(res, 404, apiError('not_found_error', `model-router: no ${route}`))
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'HEAD' && url.pathname === '/api/hello') { res.writeHead(200); return res.end() }
    if (url.pathname.startsWith('/_router/')) return control(req, res, url)

    const body = await readBody(req)
    const config = store.current()
    if (!config) return sendJson(res, 503, apiError('api_error', `model-router: ${paths.config} is missing or invalid. Run /router doctor.`))
    if (!config.upstream) return sendJson(res, 503, apiError('api_error', 'model-router: no upstream is set. Run /router setup.'))
    const session = typeof req.headers['x-claude-code-session-id'] === 'string' ? req.headers['x-claude-code-session-id'] : undefined

    const isMessages = req.method === 'POST' && (url.pathname === MESSAGES || url.pathname === COUNT_TOKENS)
    if (!isMessages) return toUpstream({ req, res, config, body, session })
    let model
    try { model = JSON.parse(body.toString('utf8')).model } catch { return toUpstream({ req, res, config, body, session }) }

    const target = resolveTarget(model, config, routeAvailability)
    if (target.kind === 'pass') return toUpstream({ req, res, config, body, session })
    if (target.kind === 'fallback') {
      events.emit({ kind: 'fallback', session, provider: target.provider, model: target.fallbackModel, text: target.reason })
      return toUpstream({ req, res, config, body: Buffer.from(withModel(body.toString('utf8'), target.fallbackModel)), session })
    }
    if (!tokenOk(req)) return sendJson(res, 401, apiError('authentication_error', TOKEN_HELP))
    return toProvider({ req, res, config, url, body, session, target })
  }

  async function handle(req, res) {
    active += 1
    res.on('close', () => { active -= 1; if (stopping && active === 0) finish() })
    touch()
    try { await route(req, res) }
    catch (err) { sendJson(res, 500, apiError('api_error', `model-router: ${err.message}`)) }
  }

  function finish() {
    if (finished) return
    finished = true
    clearTimeout(drainTimer)
    server?.closeAllConnections()
    stopping.resolve()
    stopped()
  }

  function stop({ drain = true } = {}) {
    if (!stopping) {
      let resolve
      const promise = new Promise(r => { resolve = r })
      stopping = { promise, resolve }
      clearTimeout(idleTimer)
      store.close()
      if (server) { server.close(); server.closeIdleConnections() }
      if (!server || !drain || active === 0) finish()
      else drainTimer = setTimeout(finish, options.drainMs ?? 120_000)
    }
    return stopping.promise
  }

  function start() {
    const port = options.port ?? store.startPort()
    server = http.createServer({ noDelay: true }, (req, res) => void handle(req, res))
    return new Promise((resolve, reject) => {
      const onListenError = err => { err.port = port; store.close(); reject(err) }
      server.once('error', onListenError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onListenError)
        server.on('error', err => events.emit({ kind: 'upstream-error', text: `router server error: ${err.code ?? err.message}` }))
        touch()
        resolve({ port: server.address().port })
      })
    })
  }

  return { start, stop, onStopped: fn => { stopped = fn }, paths, events, learned, breaker }
}
