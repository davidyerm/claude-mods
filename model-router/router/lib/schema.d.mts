export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type ModelEntry = { id: string }
export type Provider = { name: string; baseUrl: string; apiKeyEnv?: string; apiKey?: string; strip: string[]; models: ModelEntry[] }
export type Config = { version: 1; port: number; upstream?: string; providers: Provider[]; overrides: Partial<Record<Family, string>>; defaultMainModel?: string }
export type ConfigError = { path: string; message: string }
export type ValidateResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] }

export declare const FAMILIES: readonly Family[]
export declare const DEFAULT_STRIP: readonly string[]
export declare const DEFAULT_PORT: number
export declare function parseRef(ref: string): { provider: string; model: string } | null
export declare function isLoopbackHost(hostname: string): boolean
export declare function checkBaseUrl(value: unknown): string | null
export declare function allRefs(config: Config): string[]
export declare function jsonErrorText(message: string): string
export declare function formatErrors(errors: readonly ConfigError[]): string
export declare function validateConfig(raw: unknown): ValidateResult
