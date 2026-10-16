import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { parseRef } from '../router/lib/schema.mjs'
import type { Pick } from '../types'
import type { RouterStatus } from './client'

// Must match router/lib/resolve.mjs.
export const ROUTED_PREFIX = 'router:'
export const FALLBACK_SEP = '#'

export const pickAtom = atom({ plugin: 'model-router', key: 'pick' } as const, null as Pick)
export const seenModelAtom = atom({ plugin: 'model-router', key: 'seenModel' } as const, null as string | null)
export const startedAtom = atom({ plugin: 'model-router', key: 'isStarted' } as const, false)

export const getPick = ($: EngineInterface) => read($, pickAtom)

export async function setPick($: EngineInterface, ref: string): Promise<void> {
  const model = await $.session.model()
  await update($, pickAtom, () => ref)
  await update($, seenModelAtom, () => model)
}

export async function clearPick($: EngineInterface): Promise<void> {
  await update($, pickAtom, () => null)
  await update($, seenModelAtom, () => null)
}

export const wireModel = (pick: string, claudeModel: string) => `${ROUTED_PREFIX}${pick}${FALLBACK_SEP}${claudeModel}`

export function providerState(status: RouterStatus | null, ref: string): 'ok' | 'paused' | 'unavailable' | 'unknown' {
  const name = parseRef(ref)?.provider
  const p = status?.providers.find(x => x.name === name)
  if (!p) return 'unknown'
  if (p.breaker === 'open') return 'paused'
  if (!p.available) return 'unavailable'
  return 'ok'
}

export const isRoutable = (status: RouterStatus | null, ref: string) => providerState(status, ref) === 'ok'
