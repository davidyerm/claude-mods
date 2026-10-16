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

// Pure: an HTTP response as a Reply; a body that is not JSON reads as null.
export function replyOf(response: { status: number; text: string }): Reply {
  let json: unknown = null
  try { json = JSON.parse(response.text) } catch {}
  return { ok: true, status: response.status, json }
}

// One router call, given up after timeoutMs so a hung port cannot hold a hook.
// The timeout sleep is aborted once the fetch settles: a sleep counts as hook time.
export async function call($: EngineInterface, port: number, path: string, init: HttpInit = {}, timeoutMs = 1000): Promise<Reply> {
  const timer = new AbortController()
  const timeout = $.clock.sleep(timeoutMs, { signal: timer.signal }).then(
    (): Reply => ({ ok: false, reason: `no answer within ${timeoutMs} ms` }),
    (): Reply => ({ ok: false, reason: 'timeout cancelled' }),
  )
  const fetched = $.http.fetch(`${routerUrl(port)}${path}`, init).then(
    replyOf,
    (err: unknown): Reply => ({ ok: false, reason: String(err) }),
  ).finally(() => timer.abort())
  return Promise.race([fetched, timeout])
}

// Pure shape guards: the expected body, or null when the reply is odd.
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function eventsOf(reply: Reply): { events: RouterEvent[]; lastSeq: number } | null {
  if (!reply.ok || reply.status !== 200 || !isObj(reply.json)) return null
  const { events, lastSeq } = reply.json
  return Array.isArray(events) && typeof lastSeq === 'number' ? { events: events as RouterEvent[], lastSeq } : null
}

export function limitsOf(reply: Reply): { learned: Learned; policy: unknown } | null {
  if (!reply.ok || reply.status !== 200 || !isObj(reply.json) || !isObj(reply.json.learned)) return null
  return { learned: reply.json.learned as Learned, policy: reply.json.policy }
}

export function keysOf(reply: Reply): Record<string, string | null> | null {
  if (!reply.ok || reply.status !== 200 || !isObj(reply.json) || !isObj(reply.json.keys)) return null
  return reply.json.keys as Record<string, string | null>
}

export function forgottenOf(reply: Reply): number | null {
  if (!reply.ok || reply.status !== 200 || !isObj(reply.json)) return null
  return typeof reply.json.forgotten === 'number' ? reply.json.forgotten : null
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
  return eventsOf(r)
}

export async function getLimits($: EngineInterface, port: number): Promise<{ learned: Learned; policy: unknown } | null> {
  const r = await call($, port, '/_router/limits')
  return limitsOf(r)
}

export async function getKeys($: EngineInterface, port: number, token: string): Promise<Record<string, string | null> | null> {
  const r = await call($, port, '/_router/keys', { headers: { 'x-router-token': token } })
  return keysOf(r)
}

export async function postForget($: EngineInterface, port: number, token: string, ref: string): Promise<number | null> {
  const r = await call($, port, '/_router/forget', { method: 'POST', headers: { 'x-router-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ ref }) })
  return forgottenOf(r)
}

export async function postShutdown($: EngineInterface, port: number, token: string): Promise<boolean> {
  const r = await call($, port, '/_router/shutdown?drain=1', { method: 'POST', headers: { 'x-router-token': token } })
  return r.ok && r.status === 202
}
