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
