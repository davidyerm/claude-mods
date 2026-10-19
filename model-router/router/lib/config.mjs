import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateConfig, formatErrors, jsonErrorText, checkBaseUrl, DEFAULT_PORT } from './schema.mjs'

export function routerHome(env = process.env) {
  return env.MODEL_ROUTER_HOME || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function routerPaths(home) {
  const stateDir = path.join(home, 'model-router')
  return {
    config: path.join(home, 'model-router.json'),
    stateDir,
    token: path.join(stateDir, 'token'),
    backup: path.join(stateDir, 'setup-backup.json'),
    events: path.join(stateDir, 'events.jsonl'),
    log: path.join(stateDir, 'router.log'),
    out: path.join(stateDir, 'router.out'),
  }
}

export function readConfigFile(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true, errors: [{ path: '', message: `${file} not found` }] }
    return { ok: false, errors: [{ path: '', message: `cannot read ${file}: ${err.code ?? err.message}` }] }
  }
  let raw
  try { raw = JSON.parse(text) } catch (err) { return { ok: false, errors: [{ path: '', message: jsonErrorText(err.message) }] } }
  const result = validateConfig(raw)
  return result.ok ? result : { ...result, raw }
}

// The config to start on when the first read is invalid but its upstream is usable:
// traffic still passes through, and nothing routes until a valid save.
const rawPortOf = raw => (Number.isInteger(raw?.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : null)

export function safeConfigOf(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.upstream !== 'string' || checkBaseUrl(raw.upstream) !== null) return null
  const port = rawPortOf(raw) ?? DEFAULT_PORT
  return { version: 1, port, upstream: raw.upstream.replace(/\/+$/, ''), providers: [], overrides: {} }
}

// The port to listen on for a readConfigFile result: an invalid file's own valid port
// counts too (the mod's portOf matches this).
export function startPortOf(read) {
  return read.ok ? read.config.port : rawPortOf(read.raw) ?? DEFAULT_PORT
}

// Watches the config's folder (an atomic save is a rename, which a file watch misses)
// and keeps the last valid config when a save is invalid.
export function createConfigStore({ file, onEvent = () => {}, debounceMs = 300 }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const first = readConfigFile(file)
  let current = first.ok ? first.config : safeConfigOf(first.raw)
  let isOk = first.ok
  if (!first.ok) onEvent({ kind: 'config-error', text: formatErrors(first.errors) })

  let timer
  const reload = () => {
    const next = readConfigFile(file)
    if (next.ok) { current = next.config; isOk = true; onEvent({ kind: 'config-reloaded' }) }
    else onEvent({ kind: 'config-error', text: formatErrors(next.errors) })
  }
  const watcher = fs.watch(path.dirname(file), (_type, name) => {
    if (name !== null && name !== path.basename(file)) return
    clearTimeout(timer)
    timer = setTimeout(reload, debounceMs)
  })
  watcher.on('error', err => onEvent({ kind: 'config-error', text: `config watch failed: ${err.code ?? 'error'}` }))
  return {
    current: () => current,
    startPort: () => startPortOf(first),
    // false while running on the safe config of an invalid first read (or on none)
    isOk: () => isOk,
    reload,
    close: () => { clearTimeout(timer); watcher.close() },
  }
}
