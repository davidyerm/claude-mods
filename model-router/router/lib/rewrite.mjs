import { appliedLimit } from './learned.mjs'

export const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer'])
const ROUTER_TOKEN = 'x-router-token'
const IDENTITY = ['authorization', 'x-api-key', 'x-claude-code-session-id', ROUTER_TOKEN]

export function customHeaderNames(envValue) {
  if (!envValue) return []
  return envValue.split(/\r?\n/).flatMap(line => {
    const colon = line.indexOf(':')
    const name = colon === -1 ? '' : line.slice(0, colon).trim().toLowerCase()
    return name ? [name] : []
  })
}

export function passThroughHeaders(inbound) {
  const out = {}
  for (const [name, value] of Object.entries(inbound))
    if (value !== undefined && !HOP_BY_HOP.has(name) && name !== ROUTER_TOKEN) out[name] = value
  return out
}

function deleteDeep(value, key) {
  if (Array.isArray(value)) for (const item of value) deleteDeep(item, key)
  else if (value !== null && typeof value === 'object') {
    delete value[key]
    for (const item of Object.values(value)) deleteDeep(item, key)
  }
}

export function rewriteRouted({ headers, body, providerModel, apiKey, strip, customNames, limits }) {
  // accept-encoding goes so a provider's error body stays readable for learning and events.
  const drop = new Set([...HOP_BY_HOP, ...IDENTITY, ...customNames, 'accept-encoding', ...strip.map(s => s.toLowerCase())])
  const out = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !drop.has(name)) out[name] = value
  out['x-api-key'] = apiKey
  out['content-type'] = 'application/json'

  const json = JSON.parse(body)
  delete json.metadata
  json.model = providerModel
  for (const field of strip) {
    if (field === 'cache_control') deleteDeep(json, 'cache_control')
    else delete json[field]
  }
  if (typeof json.max_tokens === 'number') json.max_tokens = appliedLimit(json.max_tokens, limits)
  return { headers: out, body: JSON.stringify(json), maxTokens: json.max_tokens }
}

export function withModel(body, model) {
  const json = JSON.parse(body)
  if (json.model === model) return body
  json.model = model
  return JSON.stringify(json)
}
