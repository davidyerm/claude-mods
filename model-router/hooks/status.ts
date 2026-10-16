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

export function statusLine({ pick, config, status, isDown, isWired = true }: { pick: string | null; config: Config; status: RouterStatus | null; isDown: boolean; isWired?: boolean }): string {
  if (!isWired) return NOT_ACTIVE_LINE
  if (isDown) return DOWN_LINE
  const parts = [pick ? `main: ${label(pick, status)}` : 'router: /router to pick']
  for (const family of FAMILIES) {
    const ref = config.overrides[family]
    if (ref) parts.push(`${family}→${label(ref, status)}`)
  }
  return parts.join(' · ')
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
