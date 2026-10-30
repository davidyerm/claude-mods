import { FAMILIES, parseRef } from './schema.mjs'

export const ROUTED_PREFIX = 'router:'
export const FALLBACK_SEP = '#'
export const DEFAULT_FALLBACK = 'claude-sonnet-5-5'

export function familyOf(model) {
  const lower = model.toLowerCase()
  return FAMILIES.find(f => lower.includes(f))
}

function lookup(config, refText) {
  const parsed = parseRef(refText)
  if (!parsed) return null
  const provider = config.providers.find(p => p.name === parsed.provider)
  if (!provider || !provider.models.some(m => m.id === parsed.model)) return null
  return { provider, providerModel: parsed.model }
}

export function resolveTarget(model, config, availability) {
  if (typeof model !== 'string') return { kind: 'pass' }

  if (model.startsWith(ROUTED_PREFIX)) {
    const rest = model.slice(ROUTED_PREFIX.length)
    const cut = rest.indexOf(FALLBACK_SEP)
    const ref = cut === -1 ? rest : rest.slice(0, cut)
    const fallbackModel = cut === -1 || cut === rest.length - 1 ? DEFAULT_FALLBACK : rest.slice(cut + 1)
    const target = lookup(config, ref)
    if (!target) return { kind: 'fallback', fallbackModel, ref, provider: parseRef(ref)?.provider, reason: `unknown model "${ref}"` }
    const avail = availability(target.provider.name)
    if (!avail.ok) return { kind: 'fallback', fallbackModel, ref, provider: target.provider.name, reason: avail.reason }
    return { kind: 'routed', ...target, ref, fallbackModel }
  }

  const family = familyOf(model)
  const ref = family && config.overrides[family]
  if (!ref) return { kind: 'pass' }
  const target = lookup(config, ref)
  if (!target || !availability(target.provider.name).ok) return { kind: 'pass' }
  return { kind: 'routed', ...target, ref, fallbackModel: model }
}
