import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateConfig, formatErrors } from './schema.mjs'

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

// Node's JSON.parse messages quote a snippet of the input, which may hold a key.
// Report only the location, never the message text.
function jsonErrorText(message) {
  const pos = /position (\d+)/.exec(message)
  if (pos) return `invalid JSON at position ${pos[1]}`
  const lc = /line (\d+) column (\d+)/.exec(message)
  if (lc) return `invalid JSON at line ${lc[1]} column ${lc[2]}`
  return 'invalid JSON'
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
  return validateConfig(raw)
}

// Watches the config's folder (an atomic save is a rename, which a file watch misses)
// and keeps the last valid config when a save is invalid.
export function createConfigStore({ file, onEvent = () => {}, debounceMs = 300 }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const first = readConfigFile(file)
  let current = first.ok ? first.config : null
  if (!first.ok) onEvent({ kind: 'config-error', text: formatErrors(first.errors) })

  let timer
  const reload = () => {
    const next = readConfigFile(file)
    if (next.ok) { current = next.config; onEvent({ kind: 'config-reloaded' }) }
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
    reload,
    close: () => { clearTimeout(timer); watcher.close() },
  }
}
