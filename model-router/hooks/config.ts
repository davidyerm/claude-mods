import type { EngineInterface } from 'claude-code'
import { allRefs, formatErrors, jsonErrorText, parseRef, validateConfig } from '../router/lib/schema.mjs'
import type { Config, ConfigError } from '../router/lib/schema.mjs'
import { readText, writeFile } from './host'
import type { Paths } from './paths'

export type RawProvider = { name: string; baseUrl: string; apiKeyEnv?: string; apiKey?: string; strip?: string[]; models: { id: string }[] }
export type RawConfig = {
  [key: string]: unknown
  version?: number
  port?: number
  upstream?: string
  providers?: RawProvider[]
  overrides?: Record<string, string>
  defaultMainModel?: string
}
export type Loaded = { raw: RawConfig | null; config: Config; errors: ConfigError[] }
export type Updated = { ok: true; text: string; config: Config } | { ok: false; message: string }

const EMPTY = (validateConfig({}) as { ok: true; config: Config }).config

// Pure core of loadConfig: the file's text (null when the file is missing).
export function parseConfigText(text: string | null): Loaded {
  if (text === null) return { raw: null, config: EMPTY, errors: [] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (err) {
    return { raw: null, config: EMPTY, errors: [{ path: '', message: jsonErrorText(err instanceof Error ? err.message : '') }] }
  }
  const result = validateConfig(raw)
  return result.ok
    ? { raw: raw as RawConfig, config: result.config, errors: [] }
    : { raw: raw as RawConfig, config: EMPTY, errors: result.errors }
}

// Pure: the router's port. An invalid file still names its port when it holds a valid
// integer one; the router starts on it then too (in its degraded, pass-through mode).
export function portOf(loaded: Loaded): number {
  const port = loaded.raw?.port
  if (loaded.errors.length > 0 && Number.isInteger(port) && port! >= 1 && port! <= 65535) return port!
  return loaded.config.port
}

export async function loadConfig($: EngineInterface, paths: Paths): Promise<Loaded> {
  return parseConfigText(await readText($, paths.config))
}

// Pure core of updateConfig: mutates a copy, validates, and returns the text to write.
export function applyUpdate(raw: RawConfig | null, errorsBeforeUpdate: ConfigError[], mutate: (raw: RawConfig) => void, configPath: string): Updated {
  if (raw === null && errorsBeforeUpdate.length > 0) return { ok: false, message: `${configPath}: ${formatErrors(errorsBeforeUpdate)}` }
  const copy: RawConfig = raw ? JSON.parse(JSON.stringify(raw)) : { version: 1, providers: [], overrides: {} }
  mutate(copy)
  const result = validateConfig(copy)
  if (!result.ok) return { ok: false, message: formatErrors(result.errors) }
  return { ok: true, text: `${JSON.stringify(copy, null, 2)}\n`, config: result.config }
}

export async function updateConfig($: EngineInterface, paths: Paths, mutate: (raw: RawConfig) => void): Promise<{ ok: true; config: Config } | { ok: false; message: string }> {
  const loaded = await loadConfig($, paths)
  const out = applyUpdate(loaded.raw, loaded.errors, mutate, paths.config)
  if (!out.ok) return out
  await writeFile($, paths.config, out.text)
  return { ok: true, config: out.config }
}

// /model picks persist like the built-in's (2026-10-17): a routed pick becomes the
// default for new sessions, a Claude pick removes it. `error` is null when saved (or
// nothing changed); `removed` names the default a removal took away. It never throws,
// so a pick never fails on a save.
export type SaveDefault = { error: string | null; removed: string | null }

export async function saveDefaultMainModel($: EngineInterface, paths: Paths, ref: string | null): Promise<SaveDefault> {
  try {
    const { raw } = await loadConfig($, paths)
    const before = raw?.defaultMainModel ?? null
    if (before === ref) return { error: null, removed: null }
    const r = await updateConfig($, paths, next => { if (ref === null) delete next.defaultMainModel; else next.defaultMainModel = ref })
    if (!r.ok) return { error: r.message, removed: null }
    return { error: null, removed: ref === null ? before : null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), removed: null }
  }
}

// A Claude pick through /model: remove the default for new sessions and say so.
export async function clearDefaultMainModel($: EngineInterface, paths: Paths): Promise<void> {
  const text = clearedText(await saveDefaultMainModel($, paths, null))
  if (text !== null) await $.ui.toast(text)
}

// Pure: what a /model pick of a routed model says, given the save's error.
export function pickedText(ref: string, saveError: string | null): string {
  return saveError === null
    ? `Main model: ${display(ref)} (also the default for new sessions)`
    : `Main model: ${display(ref)} (could not save as default: ${saveError})`
}

// Pure: the toast after a removal of the default: what it removed, why it failed, or nothing.
export function clearedText(r: SaveDefault): string | null {
  if (r.error !== null) return `Could not remove the default main model: ${r.error}`
  return r.removed === null ? null : `Default for new sessions: back to Claude (removed ${display(r.removed)})`
}

export function display(ref: string): string {
  const r = parseRef(ref)
  return r ? `[${r.provider}] ${r.model}` : ref
}

export type Match = { kind: 'one'; ref: string } | { kind: 'ambiguous'; refs: string[] } | { kind: 'none' }

export function findModel(config: Config, name: string): Match {
  const wanted = name.trim()
  const refs = allRefs(config)
  const exact = refs.find(r => r === wanted) ?? refs.find(r => r.toLowerCase() === wanted.toLowerCase())
  if (exact) return { kind: 'one', ref: exact }
  const bare = refs.filter(r => parseRef(r)?.model === wanted)
  if (bare.length === 1) return { kind: 'one', ref: bare[0]! }
  if (bare.length > 1) return { kind: 'ambiguous', refs: bare }
  return { kind: 'none' }
}

export function ambiguousText(name: string, refs: readonly string[]): string {
  return [`"${name}" matches several models:`, ...refs.map(r => `  ${r}`), 'Name one as Provider/model.'].join('\n')
}

export function modelList(config: Config): string {
  const refs = allRefs(config)
  return refs.length > 0 ? refs.join(', ') : 'none yet — add a provider with /router add'
}
