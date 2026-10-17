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
// default for new sessions, a Claude pick removes it. Null when saved (or nothing
// to remove), else the reason; it never throws, so a pick never fails on a save.
export async function saveDefaultMainModel($: EngineInterface, paths: Paths, ref: string | null): Promise<string | null> {
  try {
    const { raw } = await loadConfig($, paths)
    if ((raw?.defaultMainModel ?? null) === ref) return null
    const r = await updateConfig($, paths, next => { if (ref === null) delete next.defaultMainModel; else next.defaultMainModel = ref })
    return r.ok ? null : r.message
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// Pure: what a /model pick of a routed model says, given saveDefaultMainModel's answer.
export function pickedText(ref: string, saveError: string | null): string {
  return saveError === null
    ? `Main model: ${display(ref)} (also the default for new sessions)`
    : `Main model: ${display(ref)} (could not save as default: ${saveError})`
}

// Pure: the toast for a default that could not be removed, or null.
export const unsavedClearText = (saveError: string | null): string | null =>
  saveError === null ? null : `Could not remove the default main model: ${saveError}`

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
