import type { Config, Family, Provider } from './schema.mjs'

export type Availability = { ok: true } | { ok: false; reason: string }
export type Target =
  | { kind: 'pass' }
  | { kind: 'fallback'; fallbackModel: string; ref: string; provider: string | undefined; reason: string }
  | { kind: 'routed'; provider: Provider; providerModel: string; ref: string; fallbackModel: string }

export declare const ROUTED_PREFIX: 'router:'
export declare const FALLBACK_SEP: '#'
export declare const DEFAULT_FALLBACK: string
export declare function familyOf(model: string): Family | undefined
export declare function resolveTarget(model: unknown, config: Config, availability: (provider: string) => Availability): Target
