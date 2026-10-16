import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { parseRef } from '../router/lib/schema.mjs'
import type { Pick } from '../types'
import type { RouterStatus } from './client'

// Must match router/lib/resolve.mjs.
export const ROUTED_PREFIX = 'router:'
export const FALLBACK_SEP = '#'

export const NOT_ACTIVE_TEXT = 'model-router is not active in this session (ANTHROPIC_BASE_URL is not the router). Run /router setup, then restart Claude Code.'

export const pickAtom = atom({ plugin: 'model-router', key: 'pick' } as const, null as Pick)
export const seenModelAtom = atom({ plugin: 'model-router', key: 'seenModel' } as const, null as string | null)
export const startedAtom = atom({ plugin: 'model-router', key: 'isStarted' } as const, false)

// A function declaration, not an arrow: the engine follows $ across files only into declarations.
export async function getPick($: EngineInterface): Promise<string | null> {
  return read($, pickAtom)
}

// The engine lets read/update name only an atom declared in the same file, so the
// other modules reach these atoms through these declarations.
export async function getSeenModel($: EngineInterface): Promise<string | null> {
  return read($, seenModelAtom)
}

export async function isStarted($: EngineInterface): Promise<boolean> {
  return read($, startedAtom)
}

export async function markStarted($: EngineInterface): Promise<void> {
  await update($, startedAtom, () => true)
}

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
