import type { EngineInterface, SettingsSource } from 'claude-code'
import { formatErrors, isLoopbackHost } from '../router/lib/schema.mjs'
import { routerUrl } from './client'
import { loadConfig, updateConfig } from './config'
import { deleteFile, readText, runTool, writeFile } from './host'
import { ensureRouter } from './lifecycle'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import type { Paths } from './paths'

export type BaseUrlSource = SettingsSource | 'os' | 'none'
export type Backup = { version: 1; baseUrl: string | null; source: BaseUrlSource; customHeaders: string | null; writtenHeaders?: string | null; at: string }
export type Base = { value: string | undefined; source: BaseUrlSource }
export type Settings = Record<string, unknown>
export type ReadSettings = Settings | null | 'invalid' | 'unreadable'

const ABOVE_USER = ['policy', 'flag', 'local', 'project'] as const
const SOURCE_NAMES: Record<BaseUrlSource, string> = {
  policy: 'managed policy settings',
  flag: 'the --settings flag',
  local: "the project's .claude/settings.local.json",
  project: "the project's .claude/settings.json",
  user: '~/.claude/settings.json',
  os: 'the OS environment',
  none: 'nowhere (the default)',
}
export const describeSource = (source: BaseUrlSource) => SOURCE_NAMES[source]

const envOf = (settings: unknown): Record<string, string> => ((settings as { env?: Record<string, string> } | null)?.env ?? {})

// ---- pure core -------------------------------------------------------------

// Highest of policy, flag, local, project, then user, then the OS env.
export function pickBaseUrl(bySource: Partial<Record<SettingsSource, unknown>>, osValue: string | undefined): Base {
  for (const source of [...ABOVE_USER, 'user'] as const) {
    const value = envOf(bySource[source]).ANTHROPIC_BASE_URL
    if (value) return { value, source }
  }
  return osValue ? { value: osValue, source: 'os' } : { value: undefined, source: 'none' }
}

const TOKEN_LINE = /^\s*x-router-token\s*:/i

export function withoutTokenHeader(existing: string | undefined): string | undefined {
  const lines = (existing ?? '').split(/\r?\n/).filter(l => l.trim() !== '' && !TOKEN_LINE.test(l))
  return lines.length > 0 ? lines.join('\n') : undefined
}

export function withTokenHeader(existing: string | undefined, token: string): string {
  return [withoutTokenHeader(existing), `x-router-token: ${token}`].filter(Boolean).join('\n')
}

export const hasTokenHeader = (headers: string | undefined, token: string) =>
  (headers ?? '').split(/\r?\n/).some(l => l.trim() === `x-router-token: ${token}`)

// The highest source above the user settings that sets ANTHROPIC_CUSTOM_HEADERS: its
// value replaces the user's, so the token line must be added there by hand.
export function headerSourceOf(bySource: Partial<Record<SettingsSource, unknown>>): SettingsSource | null {
  return ABOVE_USER.find(source => envOf(bySource[source]).ANTHROPIC_CUSTOM_HEADERS !== undefined) ?? null
}

export const headerWarning = (source: SettingsSource, tokenPath: string) =>
  `⚠ ANTHROPIC_CUSTOM_HEADERS is also set in ${describeSource(source)}, which outranks ~/.claude/settings.json; add \`x-router-token: <the token from ${tokenPath}>\` there by hand.`

// Already wired: the settings text with the token line put back, or null when it is there.
export function repairedSettings(settings: Settings | null, token: string, osHeaders: string | undefined): string | null {
  const userEnv = envOf(settings)
  if (hasTokenHeader(userEnv.ANTHROPIC_CUSTOM_HEADERS, token)) return null
  const env = { ...userEnv, ANTHROPIC_CUSTOM_HEADERS: withTokenHeader(userEnv.ANTHROPIC_CUSTOM_HEADERS ?? osHeaders, token) }
  return `${JSON.stringify({ ...(settings ?? {}), env }, null, 2)}\n`
}

// A base URL that already points at a local router (this one, or one on another port).
export function isLoopbackBase(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

export const unreadableText = (path: string, command: 'setup' | 'uninstall') =>
  `Could not read ${path}; nothing was changed. Check that no other plugin blocks reading it, then run /router ${command} again.`

function parseSettings(text: string): Settings | 'invalid' {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : 'invalid'
  } catch {
    return 'invalid'
  }
}

// The settings file as the mod may treat it. A file that exists but could not be read, or
// that the engine shows content for, is never "missing": writing then would wipe every other key.
export function classifySettings(text: string | null, isThere: boolean, userRead: unknown): ReadSettings {
  if (text !== null) return parseSettings(text)
  return isThere || Object.keys((userRead as object | null) ?? {}).length > 0 ? 'unreadable' : null
}

export type SetupPlan =
  | { kind: 'stop'; text: string }
  | { kind: 'wired'; text: string }
  | { kind: 'proceed'; upstream: string; isUpstreamSaved: boolean; isBackupWritten: boolean; rewiredFrom: string | null }

// What setup does before it writes anything: stop with an explanation, or go on.
export function planSetup(i: {
  base: Base
  url: string
  upstreamNow: string | undefined
  settings: ReadSettings
  loadedErrors: string | null
  configPath: string
  settingsPath: string
}): SetupPlan {
  if (i.loadedErrors) return { kind: 'stop', text: `${i.configPath} is invalid: ${i.loadedErrors}. Fix it, then run /router setup again.` }
  if (i.base.value !== undefined && sameUrl(i.base.value, i.url))
    return {
      kind: 'wired',
      text: [`Already set up: ANTHROPIC_BASE_URL → ${i.url} (in ${describeSource(i.base.source)}).`, `Upstream: ${i.upstreamNow ?? 'not set'}.`, 'Run /router doctor to check everything.'].join('\n'),
    }
  if ((ABOVE_USER as readonly string[]).includes(i.base.source))
    return {
      kind: 'stop',
      text: [
        `ANTHROPIC_BASE_URL is set in ${describeSource(i.base.source)}, which outranks ~/.claude/settings.json. Change it there by hand:`,
        `  "ANTHROPIC_BASE_URL": "${i.url}"`,
        `and put its old value in ${i.configPath} as the router's upstream:`,
        `  "upstream": "${i.base.value}"`,
        'Then restart Claude Code and run /router doctor.',
      ].join('\n'),
    }
  if (i.settings === 'unreadable') return { kind: 'stop', text: unreadableText(i.settingsPath, 'setup') }
  if (i.settings === 'invalid') return { kind: 'stop', text: `${i.settingsPath} is not a JSON object; fix it, then run /router setup again.` }
  if (isLoopbackBase(i.base.value)) {
    // A router already (another port, localhost, a trailing slash): never its own upstream.
    if (!i.upstreamNow)
      return { kind: 'stop', text: `ANTHROPIC_BASE_URL already points at a local router (${i.base.value}) and no upstream is saved; set "upstream" in ${i.configPath} by hand, then run /router setup again.` }
    return { kind: 'proceed', upstream: i.upstreamNow, isUpstreamSaved: false, isBackupWritten: false, rewiredFrom: i.base.value! }
  }
  // Any backup that exists is stale here: an earlier setup was undone by hand. Overwrite it.
  return { kind: 'proceed', upstream: (i.base.value ?? 'https://api.anthropic.com').replace(/\/+$/, ''), isUpstreamSaved: true, isBackupWritten: true, rewiredFrom: null }
}

// writtenHeaders: the header text setup puts in settings.json, minus the token line. When the
// headers came from the OS env, it is a copy that uninstall must remove again.
export function backupOf(base: Base, settings: Settings | null, at: string, osHeaders?: string): Backup {
  const customHeaders = envOf(settings).ANTHROPIC_CUSTOM_HEADERS ?? null
  return { version: 1, baseUrl: base.value ?? null, source: base.source, customHeaders, writtenHeaders: withoutTokenHeader(customHeaders ?? osHeaders) ?? null, at }
}

const SOURCES: readonly string[] = ['policy', 'flag', 'local', 'project', 'user', 'os', 'none']
const isStringOrNull = (v: unknown) => v === null || typeof v === 'string'

export function parseBackup(text: string): Backup | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown> | null
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    if (typeof v.source !== 'string' || !SOURCES.includes(v.source)) return null
    if (!isStringOrNull(v.baseUrl) || !isStringOrNull(v.customHeaders)) return null
    if (v.writtenHeaders !== undefined && !isStringOrNull(v.writtenHeaders)) return null
    return v as unknown as Backup
  } catch {
    return null
  }
}

// The settings file text after setup: every other key and env var kept.
export function mergeSettings(settings: Settings | null, url: string, token: string, osHeaders: string | undefined): string {
  const userEnv = envOf(settings)
  const env = { ...userEnv, ANTHROPIC_BASE_URL: url, ANTHROPIC_CUSTOM_HEADERS: withTokenHeader(userEnv.ANTHROPIC_CUSTOM_HEADERS ?? osHeaders, token) }
  return `${JSON.stringify({ ...(settings ?? {}), env }, null, 2)}\n`
}

// The settings file text after uninstall, and the URL it restored (null: none left there).
// The original headers come back only if nothing else changed them; headers added since stay.
export function restoreSettings(settings: Settings | null, backup: Backup): { text: string; restoredUrl: string | null } {
  const env: Record<string, string> = { ...envOf(settings) }
  const restoredUrl = backup.source === 'user' && backup.baseUrl ? backup.baseUrl : null
  if (restoredUrl) env.ANTHROPIC_BASE_URL = restoredUrl
  else delete env.ANTHROPIC_BASE_URL
  const kept = withoutTokenHeader(env.ANTHROPIC_CUSTOM_HEADERS)
  const written = backup.writtenHeaders !== undefined ? backup.writtenHeaders : backup.customHeaders
  const isUnchanged = (kept ?? '') === (withoutTokenHeader(written ?? undefined) ?? '')
  const headers = isUnchanged ? backup.customHeaders : (kept ?? null)
  if (headers !== null) env.ANTHROPIC_CUSTOM_HEADERS = headers
  else delete env.ANTHROPIC_CUSTOM_HEADERS
  const next: Settings = { ...(settings ?? {}), env }
  if (Object.keys(env).length === 0) delete next.env
  return { text: `${JSON.stringify(next, null, 2)}\n`, restoredUrl }
}

// ---- thin shell ------------------------------------------------------------

async function readSources($: EngineInterface): Promise<Partial<Record<SettingsSource, unknown>>> {
  const bySource: Partial<Record<SettingsSource, unknown>> = {}
  for (const source of [...ABOVE_USER, 'user'] as const) bySource[source] = await $.settings.read({ source })
  return bySource
}

export async function findBaseUrl($: EngineInterface): Promise<Base> {
  return pickBaseUrl(await readSources($), await $.env.get('ANTHROPIC_BASE_URL'))
}

export async function findHeaderSource($: EngineInterface): Promise<SettingsSource | null> {
  return headerSourceOf(await readSources($))
}

async function readUserSettings($: EngineInterface, path: string): Promise<ReadSettings> {
  const text = await readText($, path)
  if (text !== null) return classifySettings(text, true, null)
  let isThere = true
  try { isThere = await $.fs.exists(path) } catch { /* unknown: treat as there and change nothing */ }
  return classifySettings(null, isThere, await $.settings.read({ source: 'user' }))
}

// A symlinked settings.json stays a link: write where it lands.
// null when the file is there but cannot be resolved: then nothing is written.
async function writeTarget($: EngineInterface, path: string): Promise<string | null> {
  try { return (await $.fs.stat(path, { resolve: true })).realPath ?? path } catch {
    let isThere = true
    try { isThere = await $.fs.exists(path) } catch { /* unknown: treat as there */ }
    return isThere ? null : path
  }
}

const unresolvedLine = (path: string, command: 'setup' | 'uninstall') => `✗ could not resolve ${path} — settings.json unchanged; run /router ${command} again`

// null when the write went through; else the failure line.
async function tryWrite(path: string, unchanged: string, command: 'setup' | 'uninstall', verb: 'write' | 'delete', act: () => Promise<void>): Promise<string | null> {
  try { await act(); return null } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `✗ ${msg.startsWith(`could not ${verb}`) ? msg : `could not ${verb} ${path}: ${msg}`} — ${unchanged}; run /router ${command} again`
  }
}

export async function runSetup($: EngineInterface, m: Monitor): Promise<string> {
  const paths = await getPaths($)
  const loaded = await loadConfig($, paths)
  const port = loaded.config.port
  const url = routerUrl(port)
  const base = await findBaseUrl($)
  const settings = await readUserSettings($, paths.userSettings)

  const plan = planSetup({
    base,
    url,
    upstreamNow: loaded.config.upstream,
    settings,
    loadedErrors: loaded.errors.length > 0 ? formatErrors(loaded.errors) : null,
    configPath: paths.config,
    settingsPath: paths.userSettings,
  })
  if (plan.kind === 'stop') return plan.text
  const headerSource = await findHeaderSource($)
  const warning = headerSource ? [headerWarning(headerSource, paths.token)] : []
  if (plan.kind === 'wired') return [await repairToken($, paths, settings, plan.text), ...warning].join('\n')
  const safe = settings === 'invalid' || settings === 'unreadable' ? null : settings
  const lines: string[] = []
  const fail = (line: string) => [...lines, line, ...warning].join('\n')

  if (plan.isUpstreamSaved) {
    const err = await tryWrite(paths.config, 'nothing was changed', 'setup', 'write', async () => {
      const saved = await updateConfig($, paths, raw => { raw.version = 1; raw.upstream = plan.upstream })
      if (!saved.ok) throw new Error(`could not write ${paths.config}: ${saved.message}`)
    })
    if (err) return fail(err)
    lines.push(`✓ upstream = ${plan.upstream} (from ${describeSource(base.source)})`)
  } else {
    lines.push(`✓ rewired ANTHROPIC_BASE_URL from ${plan.rewiredFrom} to ${url}; upstream unchanged (${plan.upstream})`)
  }

  const tokenOut = await runTool($, ['ensure-token', paths.token])
  if (tokenOut.ok !== true || typeof tokenOut.token !== 'string') return fail(`✗ could not create the token: ${tokenOut.error ?? 'unknown error'}`)
  if (typeof tokenOut.warning === 'string') lines.push(`⚠ ${tokenOut.warning}`)

  const osHeaders = await $.env.get('ANTHROPIC_CUSTOM_HEADERS')
  if (plan.isBackupWritten) {
    const backup = backupOf(base, safe, new Date(await $.clock.now()).toISOString(), osHeaders)
    const err = await tryWrite(paths.backup, `${paths.userSettings} is unchanged`, 'setup', 'write', () => writeFile($, paths.backup, `${JSON.stringify(backup, null, 2)}\n`))
    if (err) return fail(err)
    lines.push(`✓ original values backed up to ${paths.backup}`)
  }

  const target = await writeTarget($, paths.userSettings)
  if (target === null) return fail(unresolvedLine(paths.userSettings, 'setup'))
  const text = mergeSettings(safe, url, tokenOut.token, osHeaders)
  const err = await tryWrite(target, `${paths.userSettings} is unchanged`, 'setup', 'write', () => writeFile($, target, text))
  if (err) return fail(err)
  lines.push(`✓ ${paths.userSettings}: env.ANTHROPIC_BASE_URL = ${url}; x-router-token added to env.ANTHROPIC_CUSTOM_HEADERS`)

  const ensured = await ensureRouter($, port)
  if (ensured.ok) { m.status = ensured.status; m.isDown = false }
  lines.push(ensured.ok ? `✓ router running (pid ${ensured.status.pid})` : `✗ router did not start: ${ensured.reason} — /router doctor`)

  lines.push(...warning)
  lines.push(
    '',
    `Undo by hand: in ${paths.userSettings}, ${base.source === 'user' && !plan.rewiredFrom ? `set env.ANTHROPIC_BASE_URL back to ${base.value}` : 'remove env.ANTHROPIC_BASE_URL'} and remove the x-router-token line from env.ANTHROPIC_CUSTOM_HEADERS. Or run /router uninstall.`,
    'Restart Claude Code to activate. Then run /router doctor to check upstream auth.',
  )
  return lines.join('\n')
}

// Already wired: put a missing or stale x-router-token line back in the user settings,
// under the same rules as setup (an unreadable or unresolvable file is never written).
async function repairToken($: EngineInterface, paths: Paths, settings: ReadSettings, alreadyText: string): Promise<string> {
  if (settings === 'unreadable') return unreadableText(paths.userSettings, 'setup')
  if (settings === 'invalid') return `${paths.userSettings} is not a JSON object; fix it, then run /router setup again.`
  const tokenOut = await runTool($, ['ensure-token', paths.token])
  if (tokenOut.ok !== true || typeof tokenOut.token !== 'string') return `✗ could not create the token: ${tokenOut.error ?? 'unknown error'}`
  const tokenWarning = typeof tokenOut.warning === 'string' ? [`⚠ ${tokenOut.warning}`] : []
  const text = repairedSettings(settings, tokenOut.token, await $.env.get('ANTHROPIC_CUSTOM_HEADERS'))
  if (text === null) return [alreadyText, ...tokenWarning].join('\n')
  const target = await writeTarget($, paths.userSettings)
  if (target === null) return unresolvedLine(paths.userSettings, 'setup')
  const err = await tryWrite(target, `${paths.userSettings} is unchanged`, 'setup', 'write', () => writeFile($, target, text))
  if (err) return err
  return [...tokenWarning, `✓ x-router-token header repaired in ${paths.userSettings}; restart Claude Code`].join('\n')
}

export async function runUninstall($: EngineInterface): Promise<string> {
  const paths = await getPaths($)
  const text = await readText($, paths.backup)
  if (text === null) return 'Nothing to undo: no setup backup found (/router setup was not run, or was undone).'
  const backup = parseBackup(text)
  if (backup === null) return `The setup backup at ${paths.backup} is not valid; nothing was changed. Restore ANTHROPIC_BASE_URL by hand.`
  const settings = await readUserSettings($, paths.userSettings)
  if (settings === 'unreadable') return unreadableText(paths.userSettings, 'uninstall')
  if (settings === 'invalid') return `${paths.userSettings} is not a JSON object; fix it, then run /router uninstall again.`

  const restored = restoreSettings(settings, backup)
  const target = await writeTarget($, paths.userSettings)
  if (target === null) return unresolvedLine(paths.userSettings, 'uninstall')
  const err = await tryWrite(target, `${paths.userSettings} and the backup are unchanged`, 'uninstall', 'write', () => writeFile($, target, restored.text))
  if (err) return err
  const delErr = await tryWrite(paths.backup, `${paths.userSettings} is restored, the backup is still there`, 'uninstall', 'delete', () => deleteFile($, paths.backup))
  if (delErr) return delErr
  return [
    `Restored ${paths.userSettings}: ANTHROPIC_BASE_URL is ${restored.restoredUrl ?? 'no longer set there'}, and the x-router-token header is gone.`,
    'Restart Claude Code. The router keeps serving other sessions and exits after 30 idle minutes.',
  ].join('\n')
}
