import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRouter } from '../lib/server.mjs'

export { waitFor } from '../lib/client.mjs'

const CLI = fileURLToPath(new URL('../router.mjs', import.meta.url))

export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-test-'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

export function makeHome({ config, token = 'test-token' } = {}) {
  const home = tempHome()
  if (config) writeJson(path.join(home, 'model-router.json'), config)
  if (token !== null) writeJson(path.join(home, 'model-router', 'token'), token)
  return home
}

export async function startRouter(home, options = {}) {
  const router = createRouter({ home, port: 0, env: {}, debounceMs: 30, ...options })
  const { port } = await router.start()
  return { router, port, url: `http://127.0.0.1:${port}`, close: () => router.stop({ drain: false }) }
}

// A raw client that times the first body chunk; with abortAfterFirstChunk it
// hangs up as soon as one arrives (a person pressing Esc).
export function request(url, { method = 'POST', path: p = '/v1/messages', headers = {}, body, abortAfterFirstChunk = false } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    let firstChunkMs, text = ''
    const req = http.request(`${url}${p}`, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } }, res => {
      const done = isAborted => resolve({ status: res.statusCode, headers: res.headers, text, firstChunkMs, totalMs: Date.now() - started, isAborted })
      res.setEncoding('utf8')
      res.on('data', chunk => {
        firstChunkMs ??= Date.now() - started
        text += chunk
        if (abortAfterFirstChunk) { req.destroy(); done(true) }
      })
      res.on('end', () => done(false))
      res.on('error', () => done(true))
      res.on('aborted', () => done(true))
    })
    req.on('error', error => resolve({ status: 0, error, text, isAborted: true }))
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

export function spawnCli(home, env = {}) {
  const base = { ...process.env }
  delete base.NODE_EXTRA_CA_CERTS
  const child = spawn(process.execPath, [CLI], { env: { ...base, MODEL_ROUTER_HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', c => { out += c })
  child.stderr.on('data', c => { out += c })
  const exited = new Promise(r => child.on('exit', code => r(code)))
  return { child, output: () => out, exited }
}
