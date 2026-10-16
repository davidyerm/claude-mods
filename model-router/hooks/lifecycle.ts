import type { EngineInterface } from 'claude-code'
import { isReusable, VERSION } from '../router/version.mjs'
import { probeRouter } from './client'
import type { Probe, RouterStatus } from './client'
import { runTool } from './host'
import type { ToolOut } from './host'

export type Ensure = { ok: true; status: RouterStatus; started: boolean } | { ok: false; reason: string }
export type EnsureStep =
  | { action: 'reuse'; status: RouterStatus }
  | { action: 'foreign'; reason: string }
  | { action: 'launch'; args: string[] }

// Pure: what to do about the router given its first probe.
export function decideEnsure(before: Probe, port: number, version: string, force: boolean): EnsureStep {
  if (before.kind === 'ours' && isReusable(before.status.version, version, force)) return { action: 'reuse', status: before.status }
  if (before.kind === 'foreign') return { action: 'foreign', reason: `port ${port} is used by another program; set "port" in model-router.json` }
  return { action: 'launch', args: force ? ['start', '--force'] : ['start'] }
}

// Pure: the launcher's answer plus the probe after it.
export function finishEnsure(out: ToolOut, after: Probe): Ensure {
  if (out.ok !== true) return { ok: false, reason: String(out.error ?? 'the router did not start') }
  if (after.kind === 'ours') return { ok: true, status: after.status, started: true }
  return { ok: false, reason: after.kind === 'down' ? after.reason : 'the port answered, but not as model-router' }
}

// Status, then (when needed) the launcher, which spawns detached, drains an older
// version (a same or newer one is reused) and does all the waiting: a hook's own budget is 10 s and sleeps count.
export async function ensureRouter($: EngineInterface, port: number, { force = false }: { force?: boolean } = {}): Promise<Ensure> {
  const step = decideEnsure(await probeRouter($, port), port, VERSION, force)
  if (step.action === 'reuse') return { ok: true, status: step.status, started: false }
  if (step.action === 'foreign') return { ok: false, reason: step.reason }
  const out = await runTool($, step.args, { timeoutMs: 60_000 })
  if (out.ok !== true) return finishEnsure(out, { kind: 'down', reason: '' })
  return finishEnsure(out, await probeRouter($, port))
}
