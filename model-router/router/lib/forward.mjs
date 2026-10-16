import http from 'node:http'
import https from 'node:https'

export const CONNECT_TIMEOUT_MS = 10_000
export const FIRST_BYTE_TIMEOUT_MS = 120_000

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

function classify(error) {
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return 'aborted'
  if (TLS_CODES.has(error.code)) return 'tls'
  if (error.code === 'ETIMEDOUT_CONNECT' || error.code === 'ETIMEDOUT_FIRST_BYTE') return 'timeout'
  return 'connect'
}

const timeoutError = (message, code) => Object.assign(new Error(message), { code })

// Resolves once response headers arrive (the first byte) or the request fails; never rejects.
export function send({ url, method = 'POST', headers, body, signal, connectTimeoutMs = CONNECT_TIMEOUT_MS, firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS }) {
  return new Promise(resolve => {
    try {
    const target = new URL(url)
    const lib = target.protocol === 'https:' ? https : http
    const outHeaders = { ...headers }
    if (body !== undefined) outHeaders['content-length'] = String(Buffer.byteLength(body))
    let connectTimer, firstByteTimer, settled = false
    const done = result => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(firstByteTimer)
      resolve(result)
    }
    const req = lib.request(target, { method, headers: outHeaders, signal })
    connectTimer = setTimeout(() => req.destroy(timeoutError('connect timeout', 'ETIMEDOUT_CONNECT')), connectTimeoutMs)
    req.on('socket', socket => {
      const connected = () => clearTimeout(connectTimer)
      if (!socket.connecting) connected()
      else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
    })
    req.on('finish', () => {
      if (settled) return
      firstByteTimer = setTimeout(() => req.destroy(timeoutError('first byte timeout', 'ETIMEDOUT_FIRST_BYTE')), firstByteTimeoutMs)
    })
    req.on('response', res => done({ ok: true, res }))
    req.on('error', error => done({ ok: false, kind: classify(error), error }))
    req.end(body)
    } catch (error) {
      resolve({ ok: false, kind: 'connect', error })
    }
  })
}

export function readText(res, limit = 65_536) {
  return new Promise(resolve => {
    let text = ''
    let finished = false
    const finish = () => { if (!finished) { finished = true; resolve(text.slice(0, limit)) } }
    res.setEncoding('utf8')
    res.on('data', chunk => {
      text += chunk
      if (text.length >= limit) { finish(); res.destroy() }
    })
    res.on('end', finish)
    res.on('error', finish)
    res.on('close', finish)
  })
}

export function errorMessage(text) {
  try {
    const json = JSON.parse(text)
    const message = json?.error?.message ?? json?.message
    if (typeof message === 'string') return message.slice(0, 200)
  } catch {}
  return String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function describeFailure(r) {
  return `${r.kind}: ${r.error?.code ?? r.error?.message ?? 'failed'}`
}
