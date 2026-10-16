import type { EngineInterface, HttpInit } from 'claude-code'

export type Breaker = 'closed' | 'open' | 'half-open'
export type ProviderStatus = { name: string; available: boolean; reason?: string; breaker: Breaker }
export type RouterStatus = {
  name: 'model-router'
  version: string
  pid: number
  uptimeMs: number
  upstream: string | null
  configOk: boolean
  providers: ProviderStatus[]
  models: { ref: string }[]
  policyApi: number
  eventsSeq: number
}
export type RouterEvent = { seq: number; t: string; kind: string; session?: string; provider?: string; model?: string; status?: number; text?: string }
export type Learned = Record<string, { maxOutputTokens: number; learnedAt: string; source: string }>

export const routerUrl = (port: number) => `http://127.0.0.1:${port}`

export type Reply = { ok: true; status: number; json: unknown } | { ok: false; reason: string }

// One router call, given up after timeoutMs so a hung port cannot hold a hook.
export async function call($: EngineInterface, port: number, path: string, init: HttpInit = {}, timeoutMs = 1000): Promise<Reply> {
  const timeout = $.clock.sleep(timeoutMs).then((): Reply => ({ ok: false, reason: `no answer within ${timeoutMs} ms` }))
  const fetched = $.http.fetch(`${routerUrl(port)}${path}`, init).then(
    (r): Reply => {
      let json: unknown = null
      try { json = JSON.parse(r.text) } catch {}
      return { ok: true, status: r.status, json }
    },
    (err: unknown): Reply => ({ ok: false, reason: String(err) }),
  )
  return Promise.race([fetched, timeout])
}

export type Probe = { kind: 'ours'; status: RouterStatus } | { kind: 'foreign' } | { kind: 'down'; reason: string }

// Pure core of probeRouter.
export function probeOf(reply: Reply): Probe {
  if (!reply.ok) return { kind: 'down', reason: reply.reason }
  const s = reply.json as Partial<RouterStatus> | null
  return s?.name === 'model-router' ? { kind: 'ours', status: s as RouterStatus } : { kind: 'foreign' }
}

export async function probeRouter($: EngineInterface, port: number): Promise<Probe> {
  return probeOf(await call($, port, '/_router/status'))
}

export async function getEvents($: EngineInterface, port: number, after: number): Promise<{ events: RouterEvent[]; lastSeq: number } | null> {
  const r = await call($, port, `/_router/events?after=${after}`)
  return r.ok && r.status === 200 ? (r.json as { events: RouterEvent[]; lastSeq: number }) : null
}

export async function getLimits($: EngineInterface, port: number): Promise<{ learned: Learned; policy: unknown } | null> {
  const r = await call($, port, '/_router/limits')
  return r.ok && r.status === 200 ? (r.json as { learned: Learned; policy: unknown }) : null
}

export async function getKeys($: EngineInterface, port: number, token: string): Promise<Record<string, string | null> | null> {
  const r = await call($, port, '/_router/keys', { headers: { 'x-router-token': token } })
  return r.ok && r.status === 200 ? (r.json as { keys: Record<string, string | null> }).keys : null
}

export async function postForget($: EngineInterface, port: number, token: string, ref: string): Promise<number | null> {
  const r = await call($, port, '/_router/forget', { method: 'POST', headers: { 'x-router-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ ref }) })
  return r.ok && r.status === 200 ? (r.json as { forgotten: number }).forgotten : null
}

export async function postShutdown($: EngineInterface, port: number, token: string): Promise<boolean> {
  const r = await call($, port, '/_router/shutdown?drain=1', { method: 'POST', headers: { 'x-router-token': token } })
  return r.ok && r.status === 202
}
