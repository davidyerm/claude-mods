export const FALLBACK_LIMIT = 8192

const MENTIONS_OUTPUT = /max_tokens|max_output_tokens|max output|maximum output|output tokens|max tokens/i
const MENTIONS_CONTEXT = /context length|context window|prompt is too long|maximum context/i

// The largest number in the message that is below what was asked for (the
// provider's ceiling); when the message names none, the fallback value.
export function parseMaxTokensLimit(status, text, requested) {
  if (status !== 400 || typeof text !== 'string') return null
  if (!MENTIONS_OUTPUT.test(text) || MENTIONS_CONTEXT.test(text)) return null
  const numbers = (text.match(/\d+/g) ?? []).map(Number).filter(n => n >= 256 && n < requested)
  if (numbers.length > 0) return Math.max(...numbers)
  return requested > FALLBACK_LIMIT ? FALLBACK_LIMIT : null
}

export function appliedLimit(requested, { learned, policy } = {}) {
  let limit = requested
  for (const cap of [learned, policy]) if (Number.isFinite(cap) && cap < limit) limit = cap
  return limit
}

export function createLearnedTable({ now = Date.now } = {}) {
  const entries = new Map()
  return {
    get: ref => entries.get(ref)?.maxOutputTokens,
    set(ref, maxOutputTokens, source) {
      entries.set(ref, { maxOutputTokens, learnedAt: new Date(now()).toISOString(), source })
    },
    forget(ref) {
      if (ref === 'all') { const n = entries.size; entries.clear(); return n }
      return entries.delete(ref) ? 1 : 0
    },
    toJSON: () => Object.fromEntries(entries),
  }
}
