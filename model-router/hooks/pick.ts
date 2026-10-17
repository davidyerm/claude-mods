import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { parseRef } from '../router/lib/schema.mjs'
import type { Pick } from '../types'
import type { RouterStatus } from './client'
import { FALLBACK_SEP, ROUTED_PREFIX } from '../router/lib/resolve.mjs'

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

// The session model the tick saw last, kept with or without a pick: a change the
// mod did not make itself is a built-in /model choice.
export const watchedModelAtom = atom({ plugin: 'model-router', key: 'watchedModel' } as const, null as string | null)

export async function getWatchedModel($: EngineInterface): Promise<string | null> {
  return read($, watchedModelAtom)
}

export async function setWatchedModel($: EngineInterface, model: string): Promise<void> {
  await update($, watchedModelAtom, () => model)
}

// A one-shot guard set just before the mod runs /model itself: the first model
// change the tick sees before the deadline is the mod's own, not a built-in pick.
export const OWN_CHANGE_MS = 5_000
export const ownChangeAtom = atom({ plugin: 'model-router', key: 'ownChangeUntil' } as const, null as number | null)

export async function expectOwnModelChange($: EngineInterface): Promise<void> {
  const until = (await $.clock.now()) + OWN_CHANGE_MS
  await update($, ownChangeAtom, () => until)
}

// True when the guard was active (and is now spent); an expired guard is dropped.
export async function takeOwnModelChange($: EngineInterface): Promise<boolean> {
  const until = await read($, ownChangeAtom)
  if (until === null) return false
  await update($, ownChangeAtom, () => null)
  return isGuardActive(until, await $.clock.now())
}

// Pure: is a guard set until `until` still active at `now`?
export const isGuardActive = (until: number | null, now: number): boolean => until !== null && now <= until

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
  await update($, watchedModelAtom, () => model)
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

// A provider the last status does not list yet (just added) is routable once the router
// answered: the router falls back with a toast if it cannot serve it.
export function isRoutable(status: RouterStatus | null, ref: string): boolean {
  const state = providerState(status, ref)
  return state === 'ok' || (state === 'unknown' && status !== null)
}
