import type { EngineInterface, SettingsSource } from 'claude-code'
import { formatErrors } from '../router/lib/schema.mjs'
import { routerUrl } from './client'
import { loadConfig, updateConfig } from './config'
import { deleteFile, readText, runTool, writeFile } from './host'
import { ensureRouter } from './lifecycle'
import type { Monitor } from './monitor'
import { getPaths } from './paths'

export type BaseUrlSource = SettingsSource | 'os' | 'none'
export type Backup = { version: 1; baseUrl: string | null; source: BaseUrlSource; customHeaders: string | null; at: string }
export type Base = { value: string | undefined; source: BaseUrlSource }
export type Settings = Record<string, unknown>

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

export type SetupPlan =
  | { kind: 'stop'; text: string }
  | { kind: 'proceed'; upstream: string }

// What setup does before it writes anything: stop with an explanation, or go on with this upstream.
export function planSetup(i: {
  base: Base
  url: string
  upstreamNow: string | undefined
  settings: Settings | null | 'invalid'
  loadedErrors: string | null
  configPath: string
  settingsPath: string
}): SetupPlan {
  if (i.loadedErrors) return { kind: 'stop', text: `${i.configPath} is invalid: ${i.loadedErrors}. Fix it, then run /router setup again.` }
  if (i.base.value === i.url)
    return {
      kind: 'stop',
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
  if (i.settings === 'invalid') return { kind: 'stop', text: `${i.settingsPath} is not a JSON object; fix it, then run /router setup again.` }
  return { kind: 'proceed', upstream: (i.base.value ?? 'https://api.anthropic.com').replace(/\/+$/, '') }
}

export function backupOf(base: Base, settings: Settings | null, at: string): Backup {
  return { version: 1, baseUrl: base.value ?? null, source: base.source, customHeaders: envOf(settings).ANTHROPIC_CUSTOM_HEADERS ?? null, at }
}

// The settings file text after setup: every other key and env var kept.
export function mergeSettings(settings: Settings | null, url: string, token: string, osHeaders: string | undefined): string {
  const userEnv = envOf(settings)
  const env = { ...userEnv, ANTHROPIC_BASE_URL: url, ANTHROPIC_CUSTOM_HEADERS: withTokenHeader(userEnv.ANTHROPIC_CUSTOM_HEADERS ?? osHeaders, token) }
  return `${JSON.stringify({ ...(settings ?? {}), env }, null, 2)}\n`
}

// The settings file text after uninstall, and the URL it restored (null: none left there).
export function restoreSettings(settings: Settings | null, backup: Backup): { text: string; restoredUrl: string | null } {
  const env: Record<string, string> = { ...envOf(settings) }
  const restoredUrl = backup.source === 'user' && backup.baseUrl ? backup.baseUrl : null
  if (restoredUrl) env.ANTHROPIC_BASE_URL = restoredUrl
  else delete env.ANTHROPIC_BASE_URL
  if (backup.customHeaders) env.ANTHROPIC_CUSTOM_HEADERS = backup.customHeaders
  else delete env.ANTHROPIC_CUSTOM_HEADERS
  const next: Settings = { ...(settings ?? {}), env }
  if (Object.keys(env).length === 0) delete next.env
  return { text: `${JSON.stringify(next, null, 2)}\n`, restoredUrl }
}

function parseSettings(text: string | null): Settings | null | 'invalid' {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : 'invalid'
  } catch {
    return 'invalid'
  }
}

// ---- thin shell ------------------------------------------------------------

export async function findBaseUrl($: EngineInterface): Promise<Base> {
  const bySource: Partial<Record<SettingsSource, unknown>> = {}
  for (const source of [...ABOVE_USER, 'user'] as const) bySource[source] = await $.settings.read({ source })
  return pickBaseUrl(bySource, await $.env.get('ANTHROPIC_BASE_URL'))
}

export async function runSetup($: EngineInterface, m: Monitor): Promise<string> {
  const paths = await getPaths($)
  const loaded = await loadConfig($, paths)
  const port = loaded.config.port
  const url = routerUrl(port)
  const base = await findBaseUrl($)
  const settings = parseSettings(await readText($, paths.userSettings))

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
  const safe = settings === 'invalid' ? null : settings

  const saved = await updateConfig($, paths, raw => { raw.version = 1; raw.upstream = plan.upstream })
  if (!saved.ok) return `Could not save the upstream: ${saved.message}`
  const lines = [`✓ upstream = ${plan.upstream} (from ${describeSource(base.source)})`]

  const tokenOut = await runTool($, ['ensure-token', paths.token])
  if (tokenOut.ok !== true || typeof tokenOut.token !== 'string') return [...lines, `✗ could not create the token: ${tokenOut.error ?? 'unknown error'}`].join('\n')
  if (typeof tokenOut.warning === 'string') lines.push(`⚠ ${tokenOut.warning}`)

  if ((await readText($, paths.backup)) === null) {
    const backup = backupOf(base, safe, new Date(await $.clock.now()).toISOString())
    await writeFile($, paths.backup, `${JSON.stringify(backup, null, 2)}\n`)
    lines.push(`✓ original values backed up to ${paths.backup}`)
  }

  await writeFile($, paths.userSettings, mergeSettings(safe, url, tokenOut.token, await $.env.get('ANTHROPIC_CUSTOM_HEADERS')))
  lines.push(`✓ ${paths.userSettings}: env.ANTHROPIC_BASE_URL = ${url}; x-router-token added to env.ANTHROPIC_CUSTOM_HEADERS`)

  const ensured = await ensureRouter($, port)
  if (ensured.ok) { m.status = ensured.status; m.isDown = false }
  lines.push(ensured.ok ? `✓ router running (pid ${ensured.status.pid})` : `✗ router did not start: ${ensured.reason} — /router doctor`)

  lines.push(
    '',
    `Undo by hand: in ${paths.userSettings}, ${base.source === 'user' ? `set env.ANTHROPIC_BASE_URL back to ${base.value}` : 'remove env.ANTHROPIC_BASE_URL'} and remove the x-router-token line from env.ANTHROPIC_CUSTOM_HEADERS. Or run /router uninstall.`,
    'Restart Claude Code to activate. Then run /router doctor to check upstream auth.',
  )
  return lines.join('\n')
}

export async function runUninstall($: EngineInterface): Promise<string> {
  const paths = await getPaths($)
  const text = await readText($, paths.backup)
  if (text === null) return 'Nothing to undo: no setup backup found (/router setup was not run, or was undone).'
  let backup: Backup
  try { backup = JSON.parse(text) as Backup } catch { return `${paths.backup} is not valid JSON; restore the settings by hand, then delete it.` }
  const settings = parseSettings(await readText($, paths.userSettings))
  if (settings === 'invalid') return `${paths.userSettings} is not a JSON object; fix it, then run /router uninstall again.`

  const restored = restoreSettings(settings, backup)
  await writeFile($, paths.userSettings, restored.text)
  await deleteFile($, paths.backup)
  return [
    `Restored ${paths.userSettings}: ANTHROPIC_BASE_URL is ${restored.restoredUrl ?? 'no longer set there'}, and the x-router-token header is gone.`,
    'Restart Claude Code. The router keeps serving other sessions and exits after 30 idle minutes.',
  ].join('\n')
}
