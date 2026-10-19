// Config validation and model references. Pure ESM with no node: imports,
// because the mod's hooks module imports this file too.

export const FAMILIES = Object.freeze(['haiku', 'sonnet', 'opus', 'fable'])
export const DEFAULT_STRIP = Object.freeze(['anthropic-beta', 'thinking', 'context_management', 'output_config'])
export const DEFAULT_PORT = 4141

const NAME = /^[A-Za-z0-9._-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const trimSlash = url => url.replace(/\/+$/, '')

export function parseRef(ref) {
  if (typeof ref !== 'string') return null
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return null
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
}

export function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

export function checkBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { return 'must be a URL' }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null
  return 'must be https (or http on 127.0.0.1/localhost)'
}

export function allRefs(config) {
  return config.providers.flatMap(p => p.models.map(m => `${p.name}/${m.id}`))
}

// JSON.parse's message quotes a snippet of the input, which may hold a key.
// Report only the location, never the message text.
export function jsonErrorText(message) {
  const pos = /position (\d+)/.exec(message)
  if (pos) return `invalid JSON at position ${pos[1]}`
  const lc = /line (\d+) column (\d+)/.exec(message)
  if (lc) return `invalid JSON at line ${lc[1]} column ${lc[2]}`
  return 'invalid JSON'
}

export function formatErrors(errors) {
  return errors.map(e => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')
}

function validateProvider(p, at, seen, errors) {
  if (!isObject(p)) { errors.push({ path: at, message: 'must be an object' }); return null }
  if (typeof p.name !== 'string' || !NAME.test(p.name)) errors.push({ path: `${at}.name`, message: 'must match [A-Za-z0-9._-]+' })
  else if (seen.has(p.name)) errors.push({ path: `${at}.name`, message: `duplicate provider "${p.name}"` })
  else seen.add(p.name)

  if (typeof p.baseUrl !== 'string') errors.push({ path: `${at}.baseUrl`, message: 'is required' })
  else { const bad = checkBaseUrl(p.baseUrl); if (bad) errors.push({ path: `${at}.baseUrl`, message: bad }) }

  const hasEnv = p.apiKeyEnv !== undefined
  const hasKey = p.apiKey !== undefined
  if (hasEnv === hasKey) errors.push({ path: at, message: 'needs exactly one of apiKeyEnv / apiKey' })
  if (hasEnv && (typeof p.apiKeyEnv !== 'string' || !ENV_NAME.test(p.apiKeyEnv))) errors.push({ path: `${at}.apiKeyEnv`, message: 'must be an environment variable name' })
  if (hasKey && (typeof p.apiKey !== 'string' || p.apiKey === '')) errors.push({ path: `${at}.apiKey`, message: 'must be a non-empty string' })

  const strip = p.strip ?? DEFAULT_STRIP
  if (!Array.isArray(strip) || !strip.every(s => typeof s === 'string')) errors.push({ path: `${at}.strip`, message: 'must be a list of strings' })

  const models = []
  if (!Array.isArray(p.models) || p.models.length === 0) errors.push({ path: `${at}.models`, message: 'must be a non-empty list' })
  else {
    const ids = new Set()
    p.models.forEach((m, j) => {
      if (!isObject(m) || typeof m.id !== 'string' || m.id === '') errors.push({ path: `${at}.models[${j}].id`, message: 'must be a non-empty string' })
      else if (ids.has(m.id)) errors.push({ path: `${at}.models[${j}].id`, message: `duplicate model "${m.id}"` })
      else { ids.add(m.id); models.push({ id: m.id }) }
    })
  }
  return {
    name: p.name,
    baseUrl: typeof p.baseUrl === 'string' ? trimSlash(p.baseUrl) : p.baseUrl,
    ...(hasEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
    ...(hasKey ? { apiKey: p.apiKey } : {}),
    strip: Array.isArray(strip) ? [...strip] : [...DEFAULT_STRIP],
    models,
  }
}

export function validateConfig(raw) {
  if (!isObject(raw)) return { ok: false, errors: [{ path: '', message: 'must be a JSON object' }] }
  const errors = []
  if (raw.version !== undefined && raw.version !== 1) errors.push({ path: 'version', message: 'must be 1' })
  const port = raw.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push({ path: 'port', message: 'must be an integer 1-65535' })
  if (raw.upstream !== undefined) {
    if (typeof raw.upstream !== 'string') errors.push({ path: 'upstream', message: 'must be a URL' })
    else { const bad = checkBaseUrl(raw.upstream); if (bad) errors.push({ path: 'upstream', message: bad }) }
  }

  const providers = []
  const rawProviders = raw.providers ?? []
  if (!Array.isArray(rawProviders)) errors.push({ path: 'providers', message: 'must be a list' })
  else {
    const seen = new Set()
    rawProviders.forEach((p, i) => { const v = validateProvider(p, `providers[${i}]`, seen, errors); if (v) providers.push(v) })
  }
  const refs = new Set(providers.flatMap(p => p.models.map(m => `${p.name}/${m.id}`)))

  const overrides = {}
  const rawOverrides = raw.overrides ?? {}
  if (!isObject(rawOverrides)) errors.push({ path: 'overrides', message: 'must be an object' })
  else for (const [family, ref] of Object.entries(rawOverrides)) {
    if (!FAMILIES.includes(family)) errors.push({ path: `overrides.${family}`, message: 'family must be one of haiku|sonnet|opus|fable' })
    else if (typeof ref !== 'string' || !refs.has(ref)) errors.push({ path: `overrides.${family}`, message: `references unknown model "${ref}"` })
    else overrides[family] = ref
  }

  if (raw.defaultMainModel !== undefined && (typeof raw.defaultMainModel !== 'string' || !refs.has(raw.defaultMainModel)))
    errors.push({ path: 'defaultMainModel', message: `references unknown model "${raw.defaultMainModel}"` })

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    config: {
      version: 1,
      port,
      ...(raw.upstream !== undefined ? { upstream: trimSlash(raw.upstream) } : {}),
      providers,
      overrides,
      ...(raw.defaultMainModel !== undefined ? { defaultMainModel: raw.defaultMainModel } : {}),
    },
  }
}
