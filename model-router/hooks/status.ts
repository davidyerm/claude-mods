import { FAMILIES, parseRef } from '../router/lib/schema.mjs'
import type { Config } from '../router/lib/schema.mjs'
import type { RouterEvent, RouterStatus } from './client'
import { display } from './config'
import { providerState } from './pick'

export const DOWN_LINE = 'model-router DOWN — /router doctor'
export const NOT_ACTIVE_LINE = 'router: not active — /router setup, then restart Claude Code'

export function label(ref: string, status: RouterStatus | null): string {
  const provider = parseRef(ref)?.provider ?? ref
  switch (providerState(status, ref)) {
    case 'paused': return `[${provider}] ⚠  paused`
    case 'unavailable': return `[${provider}] ⚠  unavailable`
    default: return display(ref)
  }
}

type LineInput = { pick: string | null; config: Config; status: RouterStatus | null; isDown: boolean; isWired?: boolean }

// Pure: the status line's text, or undefined when there is no problem (2026-10-25:
// normal info is left to /router and /router doctor). Problems are: something is
// routed but the session is not wired through the router; a wired session whose
// router is DOWN (every request goes through it); a pick or override whose provider
// is paused or unavailable (only those parts are listed). Installed with nothing
// routed is not a problem.
export function problemLine({ pick, config, status, isDown, isWired = true }: LineInput): string | undefined {
  const overrides = FAMILIES.map(f => [f, config.overrides[f]] as const).filter((x): x is readonly [typeof x[0], string] => !!x[1])
  if (!isWired) return pick || config.defaultMainModel || overrides.length > 0 ? NOT_ACTIVE_LINE : undefined
  if (isDown) return DOWN_LINE
  const isBad = (ref: string) => {
    const state = providerState(status, ref)
    return state === 'paused' || state === 'unavailable'
  }
  const parts: string[] = []
  if (pick && isBad(pick)) parts.push(`main: ${label(pick, status)}`)
  for (const [family, ref] of overrides) if (isBad(ref)) parts.push(`${family}→${label(ref, status)}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const isForSession = (ev: RouterEvent, sessionId: string) => ev.session === undefined || ev.session === sessionId

export function toastFor(ev: RouterEvent): string | null {
  const p = `[${ev.provider ?? '?'}]`
  switch (ev.kind) {
    case 'fallback':
      if (ev.status === 400 && ev.text) return `${p} rejected (400: ${ev.text}) — /router doctor`
      if (ev.status !== undefined) return `${p} ${ev.status} → used ${ev.model}`
      return `${p} ${ev.text ?? 'failed'} → used ${ev.model}`
    case 'learned': return `${p} max output ${ev.text} learned`
    case 'breaker-open': return `${p} ⚠  paused for 5 min after 3 failures; requests go to Claude`
    case 'breaker-close': return `${p} resumed`
    case 'config-error': return `model-router.json: ${ev.text}`
    default: return null
  }
}
