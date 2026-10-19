#!/usr/bin/env node
// What the mod runs through $.process.run. Every subcommand prints one JSON line.
//   node launch.mjs [start] [--force]       start the router detached (--force: replace a running one); wait until it answers
//   node launch.mjs probe < request.json    one test request ({ mode: 'tls' | 'provider', ... })
//   node launch.mjs env-check NAME...       { keys: { NAME: fingerprint | null } } from this env
//   node launch.mjs write PATH [--private]  write stdin to PATH atomically
//   node launch.mjs delete PATH             delete PATH (missing is fine)
//   node launch.mjs ensure-token PATH       create the token file if needed; print { token }
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION, isReusable } from './version.mjs'
import { DEFAULT_STRIP } from './lib/schema.mjs'
import { routerHome, routerPaths, readConfigFile, startPortOf } from './lib/config.mjs'
import { getStatus, postShutdown, waitFor } from './lib/client.mjs'
import { send, readText, errorMessage, describeFailure, scrubKey } from './lib/forward.mjs'
import { rewriteRouted } from './lib/rewrite.mjs'
import { parseMaxTokensLimit } from './lib/learned.mjs'
import { fingerprint } from './lib/fingerprint.mjs'
import { PROBE_HEADERS, probeRequest } from './lib/probe-request.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROUTER = fileURLToPath(new URL('./router.mjs', import.meta.url))

// Trust the Windows certificate store, where an internal CA usually lives (V4).
const nodeFlags = () => (process.platform === 'win32' ? ['--use-system-ca'] : [])

const readToken = file => { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } }
const tail = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-5).join(' | ') } catch { return '' } }

async function start({ force = false } = {}) {
  const paths = routerPaths(routerHome())
  const cfg = readConfigFile(paths.config)
  const port = startPortOf(cfg)
  const before = await getStatus(port)
  if (before.kind === 'ours' && isReusable(before.status.version, VERSION, force)) return { ok: true, started: false, pid: before.status.pid, version: before.status.version }
  if (before.kind === 'foreign') return { ok: false, error: `port ${port} is used by another program; set "port" in ${paths.config}` }
  if (before.kind === 'ours') {
    const token = readToken(paths.token)
    if (!token || !(await postShutdown(port, token)))
      return { ok: false, error: `router ${before.status.version} (pid ${before.status.pid}) is running and could not be asked to stop` }
    const gone = await waitFor(async () => (await getStatus(port)).kind === 'down', 30_000, 250).catch(() => false)
    if (!gone) return { ok: false, error: `router ${before.status.version} did not stop within 30 s` }
  }
  fs.mkdirSync(paths.stateDir, { recursive: true })
  const fd = fs.openSync(paths.out, 'w')
  // Files, not pipes: a child holding the launcher's pipes would keep $.process.run waiting.
  const child = spawn(process.execPath, [...nodeFlags(), ROUTER], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
  child.unref()
  fs.closeSync(fd)
  const up = await waitFor(async () => { const s = await getStatus(port); return s.kind === 'ours' ? s : null }, 5000, 100).catch(() => null)
  if (up) return { ok: true, started: true, pid: up.status.pid, version: up.status.version }
  return { ok: false, error: tail(paths.out) || 'the router did not answer within 5 s' }
}

async function probe(input) {
  if (input.mode === 'tls') {
    const r = await send({ url: input.url, method: 'HEAD', headers: {}, firstByteTimeoutMs: 15_000 })
    if (!r.ok) return { ok: false, kind: r.kind, text: describeFailure(r) }
    r.res.resume()
    return { ok: true, status: r.res.statusCode }
  }
  const p = input.provider
  const key = p.apiKey ?? process.env[p.apiKeyEnv]
  if (!key) return { ok: false, kind: 'no-key', text: `env ${p.apiKeyEnv} not set` }
  const url = `${p.baseUrl.replace(/\/+$/, '')}/v1/messages`
  const once = async learned => {
    const sent = rewriteRouted({ headers: PROBE_HEADERS, body: JSON.stringify(probeRequest(input.model)), providerModel: input.model, apiKey: key, strip: p.strip ?? [...DEFAULT_STRIP], customNames: [], limits: { learned } })
    const r = await send({ url, headers: sent.headers, body: sent.body, firstByteTimeoutMs: 60_000 })
    if (!r.ok) return { sent, failure: { kind: r.kind, text: scrubKey(describeFailure(r), key) } }
    const raw = await readText(r.res)
    return r.res.statusCode >= 400 ? { sent, failure: { kind: 'http', status: r.res.statusCode, raw, text: errorMessage(scrubKey(raw, key)) } } : { sent, status: r.res.statusCode }
  }
  let learnedMaxTokens
  let result = await once(undefined)
  if (result.failure?.status === 400) {
    const limit = parseMaxTokensLimit(400, result.failure.raw, result.sent.maxTokens)
    if (limit !== null) { learnedMaxTokens = limit; result = await once(limit) }
  }
  const learned = learnedMaxTokens === undefined ? {} : { learnedMaxTokens }
  if (result.failure) return { ok: false, kind: result.failure.kind, ...(result.failure.status ? { status: result.failure.status } : {}), text: result.failure.text, ...learned }
  return { ok: true, status: result.status, ...learned }
}

function restrict(file) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return undefined }
  try { execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' }); return undefined }
  catch { return `could not restrict ${file} to the current user` }
}

function writeAtomic(file, text, isPrivate) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, isPrivate ? { mode: 0o600 } : undefined)
  const warning = isPrivate ? restrict(tmp) : undefined
  fs.renameSync(tmp, file)
  return warning
}

function ensureToken(file) {
  const existing = readToken(file)
  if (existing) return { ok: true, token: existing, created: false }
  const token = crypto.randomBytes(32).toString('hex')
  const warning = writeAtomic(file, token, true)
  return { ok: true, token, created: true, ...(warning ? { warning } : {}) }
}

async function run(command, args) {
  switch (command) {
    case 'start': return start({ force: args.includes('--force') })
    case 'probe': return probe(JSON.parse(fs.readFileSync(0, 'utf8')))
    case 'env-check': return { ok: true, keys: Object.fromEntries(args.map(n => [n, process.env[n] ? fingerprint(process.env[n]) : null])) }
    case 'write': {
      const warning = writeAtomic(args[0], fs.readFileSync(0, 'utf8'), args.includes('--private'))
      return { ok: true, ...(warning ? { warning } : {}) }
    }
    case 'delete': fs.rmSync(args[0], { force: true }); return { ok: true }
    case 'ensure-token': return ensureToken(args[0])
    default: return { ok: false, error: `unknown command "${command}"` }
  }
}

const [command = 'start', ...args] = process.argv.slice(2)
const missing = nodeFlags().filter(f => !process.execArgv.includes(f))
if (command === 'probe' && missing.length > 0) {
  const r = spawnSync(process.execPath, [...nodeFlags(), SELF, command, ...args], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
const out = await run(command, args).catch(err => ({ ok: false, error: err.message }))
process.stdout.write(`${JSON.stringify(out)}\n`)
process.exitCode = out.ok === false ? 1 : 0
