import type { EngineInterface, ModelCompleteResult, SettingsSource } from 'claude-code'
import { FAMILIES, formatErrors } from '../router/lib/schema.mjs'
import type { Config, ConfigError, Family } from '../router/lib/schema.mjs'
import { VERSION } from '../router/version.mjs'
import { getKeys, getLimits, probeRouter, routerUrl } from './client'
import type { Learned, Probe } from './client'
import { display, loadConfig } from './config'
import type { RawConfig } from './config'
import { readText, runTool } from './host'
import type { ToolOut } from './host'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { describeSource, findBaseUrl, findHeaderSource, hasTokenHeader } from './setup'
import type { Base } from './setup'

export type Mark = '✓' | '⚠' | '✗'
export type Item = { mark: Mark; label: string; fix?: string }

const ok = (label: string): Item => ({ mark: '✓', label })
const warn = (label: string, fix?: string): Item => ({ mark: '⚠', label, ...(fix ? { fix } : {}) })
const bad = (label: string, fix?: string): Item => ({ mark: '✗', label, ...(fix ? { fix } : {}) })

const CA_FIX = 'export the internal CA as a PEM file, set NODE_EXTRA_CA_CERTS to its path in ~/.claude/settings.json "env", restart Claude Code, then /router restart'
const LOG_FIX = 'see ~/.claude/model-router/router.log, then /router doctor again'

export function formatReport(items: readonly Item[]): string {
  return [
    'model-router doctor',
    ...items.flatMap(i => [`${i.mark} ${i.label}`, ...(i.fix ? [`    fix: ${i.fix}`] : [])]),
    '',
    'Optional: model-limits (per-model context/output policies)',
  ].join('\n')
}

// ---- pure checks: facts in, Items out --------------------------------------

export function configItem(configPath: string, raw: RawConfig | null, errors: readonly ConfigError[]): Item {
  if (errors.length > 0) return bad(`config ${configPath} is invalid: ${formatErrors([...errors])}`, 'fix the file; the router keeps using the last valid version meanwhile')
  if (raw === null) return warn(`no config at ${configPath} yet`, '/router setup, then /router add')
  return ok(`config ${configPath} is valid`)
}

export function routerItem(probe: Probe, port: number, configPath: string): Item {
  if (probe.kind === 'ours')
    return probe.status.version === VERSION
      ? ok(`router running: v${VERSION}, pid ${probe.status.pid}, port ${port}`)
      : warn(`router runs v${probe.status.version} (pid ${probe.status.pid}); this plugin is v${VERSION}`, '/router restart')
  if (probe.kind === 'foreign') return bad(`port ${port} answers, but not as model-router`, `set "port" in ${configPath} to a free port, then /router setup`)
  return bad(`router not running (${probe.reason})`, '/router restart')
}

export function wiringItem(base: Base, live: string | undefined, url: string): Item {
  const where = describeSource(base.source)
  if (base.value === url && live === url) return ok(`base URL → router (${where})`)
  if (base.value === url) return warn(`base URL → router in ${where}, but this session still uses ${live ?? 'the default'}`, 'restart Claude Code')
  if (base.source === 'project' || base.source === 'local')
    return bad(`${where} sets ANTHROPIC_BASE_URL=${base.value}, so this project bypasses the router`, `change it there to ${url}, or remove it`)
  return bad(`base URL is ${base.value ?? 'not set'} (${where}), not the router`, base.source === 'policy' || base.source === 'flag' ? `change ANTHROPIC_BASE_URL in ${where} to ${url}` : '/router setup')
}

// headerSource: a source above the user settings that sets ANTHROPIC_CUSTOM_HEADERS
// (setup cannot fix the header there, so the fix names it).
export function tokenItem(token: string, headers: string, headerSource: SettingsSource | null = null, tokenPath = ''): Item {
  if (!token) return bad('no router token yet', '/router setup')
  if (hasTokenHeader(headers, token)) return ok('x-router-token header present')
  const fix = headerSource
    ? `add \`x-router-token: <the token from ${tokenPath}>\` to ANTHROPIC_CUSTOM_HEADERS in ${describeSource(headerSource)}, then restart Claude Code`
    : '/router setup, then restart Claude Code'
  return bad('this session does not send the x-router-token header (routed requests get 401)', fix)
}

// The first family no override takes away from Claude, or null when all are overridden.
export const authFamily = (overrides: Config['overrides']): Family | null => FAMILIES.find(f => !overrides[f]) ?? null

export function authItem(family: Family | null, r: ModelCompleteResult | null): Item {
  if (family === null || r === null) return warn("can't test upstream auth while all families are overridden")
  if (r.isAnswered) return ok(`upstream answers with auth (${family})`)
  if (r.reason === 'api-error')
    return bad(`upstream refused the ${family} request: HTTP ${r.status ?? 'no response'} (${r.error})`, r.status === 401 || r.status === 403 ? 'check apiKeyHelper and the gateway credentials' : LOG_FIX)
  return bad(`upstream ${family} request: ${r.reason}`, LOG_FIX)
}

export function tlsItem(t: ToolOut): Item {
  if (t.ok === true) return ok('upstream TLS certificate trusted')
  if (t.kind === 'tls') return bad(`upstream certificate not trusted (${String(t.text)})`, CA_FIX)
  return warn(`upstream not reachable from Node (${String(t.text ?? t.error)})`, 'check the gateway URL in model-router.json')
}

export type KeyFacts = { name: string; envName: string; mine: string | null; routers: string | null; isRouterKnown: boolean }

// hasKey: false when neither this session nor the router has the key (no test request then).
export function keyItem(f: KeyFacts): { item: Item; hasKey: boolean } {
  const tag = `[${f.name}]`
  if (!f.mine && !f.routers)
    return { hasKey: false, item: bad(`${tag} ${f.envName} is not set`, `set ${f.envName} (for example in ~/.claude/settings.json "env"), restart Claude Code, then /router restart`) }
  if (f.isRouterKnown && f.mine !== f.routers)
    return { hasKey: true, item: warn(`${tag} ${f.envName} differs from the router's (set or changed after it started)`, '/router restart') }
  return { hasKey: true, item: ok(`${tag} key ${f.envName} set`) }
}

export const literalKeyItem = (name: string, configPath: string): Item =>
  warn(`[${name}] literal apiKey in ${configPath}`, 'move it to an environment variable and use "apiKeyEnv"')

export const breakerItem = (name: string): Item => warn(`[${name}] paused by the circuit breaker; it resumes by itself within 5 minutes`)

// null for a missing key: keyItem already said so.
export function providerProbeItem(name: string, model: string, configPath: string, r: ToolOut): Item | null {
  const tag = `[${name}]`
  const learned = typeof r.learnedMaxTokens === 'number' ? ` (max output ${r.learnedMaxTokens} learned)` : ''
  if (r.ok === true) return ok(`${tag} ${model} answers${learned}`)
  if (r.kind === 'no-key') return null
  if (r.kind === 'tls') return bad(`${tag} certificate not trusted (${String(r.text)})`, CA_FIX)
  if (r.kind === 'http' && r.status === 400) return bad(`${tag} ${model} rejected: 400 ${String(r.text)}${learned}`, `add the rejected field to "strip" for ${name} in ${configPath}`)
  return bad(`${tag} ${model} failed: ${String(r.status ?? r.kind)} ${String(r.text ?? r.error)}`, `check the baseUrl of ${name} in ${configPath}`)
}

export function limitsItems(limits: { learned: Learned; policy: unknown }): Item[] {
  const entries = Object.entries(limits.learned)
  const learned = entries.map(([ref, v]) => `${display(ref)} max output ${v.maxOutputTokens}`).join(', ')
  return [
    ok(entries.length > 0 ? `learned limits: ${learned}` : 'learned limits: none yet'),
    ok(limits.policy ? `policy registered: ${JSON.stringify(limits.policy)}` : 'policy: none registered'),
  ]
}

// ---- thin shell -------------------------------------------------------------

export async function runDoctor($: EngineInterface, m: Monitor, { isOffline }: { isOffline: boolean }): Promise<string> {
  const items: Item[] = []
  const paths = await getPaths($)
  const loaded = await loadConfig($, paths)
  const config = loaded.config
  items.push(configItem(paths.config, loaded.raw, loaded.errors))

  const port = config.port
  const url = routerUrl(port)
  const probe = await probeRouter($, port)
  if (probe.kind === 'ours') m.status = probe.status
  items.push(routerItem(probe, port, paths.config))

  items.push(wiringItem(await findBaseUrl($), await $.env.get('ANTHROPIC_BASE_URL'), url))

  const token = (await readText($, paths.token))?.trim() ?? ''
  items.push(tokenItem(token, (await $.env.get('ANTHROPIC_CUSTOM_HEADERS')) ?? '', await findHeaderSource($), paths.token))

  const family = authFamily(config.overrides)
  const completed = family === null ? null : await $.model.complete({ model: family, prompt: 'Reply with OK.', maxTokens: 1, timeoutMs: 30_000 })
  items.push(authItem(family, completed))

  if (config.upstream?.startsWith('https:'))
    items.push(tlsItem(await runTool($, ['probe'], { stdin: JSON.stringify({ mode: 'tls', url: config.upstream }) })))

  const keys = token && probe.kind === 'ours' ? await getKeys($, port, token) : null
  const envNames = config.providers.flatMap(p => (p.apiKeyEnv ? [p.apiKeyEnv] : []))
  const here = envNames.length > 0 ? (((await runTool($, ['env-check', ...envNames])).keys as Record<string, string | null> | undefined) ?? {}) : {}
  for (const p of config.providers) {
    let hasKey = true
    if (p.apiKey !== undefined) items.push(literalKeyItem(p.name, paths.config))
    else if (p.apiKeyEnv) {
      const k = keyItem({ name: p.name, envName: p.apiKeyEnv, mine: here[p.apiKeyEnv] ?? null, routers: keys?.[p.apiKeyEnv] ?? null, isRouterKnown: keys !== null })
      hasKey = k.hasKey
      items.push(k.item)
    }
    const st = probe.kind === 'ours' ? probe.status.providers.find(x => x.name === p.name) : undefined
    if (st?.breaker === 'open') items.push(breakerItem(p.name))
    if (isOffline || !hasKey) continue
    const model = p.models[0]!.id
    const r = await runTool($, ['probe'], {
      stdin: JSON.stringify({ mode: 'provider', provider: { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, apiKey: p.apiKey, strip: p.strip }, model }),
      timeoutMs: 150_000,
    })
    const item = providerProbeItem(p.name, model, paths.config, r)
    if (item) items.push(item)
  }

  const limits = probe.kind === 'ours' ? await getLimits($, port) : null
  if (limits) items.push(...limitsItems(limits))
  return formatReport(items)
}
