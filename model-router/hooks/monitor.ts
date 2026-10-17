import type { EngineInterface } from 'claude-code'
import { allRefs } from '../router/lib/schema.mjs'
import { getEvents, probeRouter } from './client'
import type { Probe, RouterEvent, RouterStatus } from './client'
import { clearDefaultMainModel, display, loadConfig, portOf } from './config'
import { ensureRouter } from './lifecycle'
import type { Ensure } from './lifecycle'
import { getPaths } from './paths'
import { clearPick, getPick, getSeenModel, getWatchedModel, setWatchedModel } from './pick'
import { isForSession, statusLine, toastFor } from './status'

// isWired: this session's ANTHROPIC_BASE_URL is the router (read at session.start).
export type Monitor = { status: RouterStatus | null; lastSeq: number; isDown: boolean; port: number; isWired: boolean }

export const newMonitor = (): Monitor => ({ status: null, lastSeq: 0, isDown: false, port: 4141, isWired: false })

// Pure: the toasts for a batch of events and the cursor after it. A router
// answering with a lower lastSeq than the cursor has restarted: reset, no replay.
export function toastsFor(events: RouterEvent[], routerLastSeq: number, cursor: number, sessionId: string): { toasts: string[]; lastSeq: number } {
  if (routerLastSeq < cursor) return { toasts: [], lastSeq: routerLastSeq }
  const toasts: string[] = []
  let lastSeq = cursor
  for (const ev of events) {
    lastSeq = Math.max(lastSeq, ev.seq)
    const text = isForSession(ev, sessionId) ? toastFor(ev) : null
    if (text) toasts.push(text)
  }
  return { toasts, lastSeq }
}

// isBuiltinPick: a Claude model was picked in the built-in /model, which also
// removes the default for new sessions.
export type PickCheck = 'keep' | { clear: true; toast: string; isBuiltinPick?: true }

// Pure: is the session's pick still valid?
export function checkPick({ pick, refs, seen, model }: { pick: string | null; refs: string[]; seen: string | null; model: string }): PickCheck {
  if (pick === null) return 'keep'
  if (!refs.includes(pick)) return { clear: true, toast: `${display(pick)} was removed — main model back to Claude` }
  if (seen !== null && model !== seen) return { clear: true, toast: `Main model back to Claude (${model} picked in /model)`, isBuiltinPick: true }
  return 'keep'
}

export type HealthOutcome = { status: RouterStatus | null; isDown: boolean; lastSeq?: number; toast?: string }

// Pure: a probe that did not find our router needs a respawn.
export const needsRespawn = (probe: Probe): boolean => probe.kind !== 'ours'

// Pure: the monitor's new health from the probe and, when it was needed, the respawn.
export function healthOutcome(probe: Probe, ensured: Ensure | null): HealthOutcome {
  if (probe.kind === 'ours') return { status: probe.status, isDown: false }
  if (ensured?.ok) return { status: ensured.status, isDown: false, lastSeq: ensured.status.eventsSeq, toast: 'model-router restarted' }
  return { status: null, isDown: true }
}

// After a pick or a save: the router's status now, so a just-added provider or a
// changed state counts without waiting for the 10 s health check.
export async function reprobe($: EngineInterface, m: Monitor): Promise<void> {
  const probe = await probeRouter($, m.port)
  if (probe.kind === 'ours') { m.status = probe.status; m.isDown = false }
}

export async function refresh($: EngineInterface, m: Monitor): Promise<void> {
  const { config } = await loadConfig($, await getPaths($))
  $.ui.status(statusLine({ pick: await getPick($), config, status: m.status, isDown: m.isDown, isWired: m.isWired }))
}

// Every 2 s: this session's events as toasts, and the pick's validity.
export async function tick($: EngineInterface, m: Monitor): Promise<void> {
  const sessionId = await $.session.id()
  const r = await getEvents($, m.port, m.lastSeq)
  if (r) {
    const out = toastsFor(r.events, r.lastSeq, m.lastSeq, sessionId)
    m.lastSeq = out.lastSeq
    for (const text of out.toasts) $.ui.toast(text)
  }
  const paths = await getPaths($)
  const model = await $.session.model()
  const watched = await getWatchedModel($)
  await setWatchedModel($, model)
  // A model change the mod did not make is a built-in /model pick, with or without a
  // routed pick: the latest /model choice wins, so the default for new sessions goes.
  let isBuiltinPick = watched !== null && model !== watched
  const pick = await getPick($)
  if (pick !== null) {
    const { config } = await loadConfig($, paths)
    const check = checkPick({ pick, refs: allRefs(config), seen: await getSeenModel($), model })
    if (check !== 'keep') {
      await clearPick($)
      $.ui.toast(check.toast)
      if (check.isBuiltinPick) isBuiltinPick = true
    }
  }
  if (isBuiltinPick) await clearDefaultMainModel($, paths)
  await refresh($, m)
}

// Every 10 s: the router's health; respawn it when it is gone.
export async function health($: EngineInterface, m: Monitor): Promise<void> {
  m.port = portOf(await loadConfig($, await getPaths($)))
  const probe = await probeRouter($, m.port)
  const out = healthOutcome(probe, needsRespawn(probe) ? await ensureRouter($, m.port) : null)
  m.status = out.status
  m.isDown = out.isDown
  if (out.lastSeq !== undefined) m.lastSeq = out.lastSeq
  if (out.toast) $.ui.toast(out.toast)
  await refresh($, m)
}
