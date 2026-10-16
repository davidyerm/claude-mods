// Stand-ins for everything beneath the plugin: the kit has no engine below the
// plugin's hooks, so these hooks answer its files, env, network, processes and UI.
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, SettingsSource } from 'claude-code'
import { VERSION } from '../router/version.mjs'
import type { RouterEvent, RouterStatus } from '../hooks/client'

export const HOME = 'C:/Users/test'
export const CLAUDE_DIR = `${HOME}/.claude`
export const CONFIG = `${CLAUDE_DIR}/model-router.json`
export const STATE_DIR = `${CLAUDE_DIR}/model-router`
export const TOKEN_FILE = `${STATE_DIR}/token`
export const BACKUP = `${STATE_DIR}/setup-backup.json`
export const USER_SETTINGS = `${CLAUDE_DIR}/settings.json`

export const CONFIG_JSON = {
  version: 1,
  upstream: 'https://gw.example',
  providers: [
    { name: 'DS', baseUrl: 'https://ds.example/anthropic', apiKeyEnv: 'DS_KEY', models: [{ id: 'ds-chat' }, { id: 'ds-reasoner' }] },
    { name: 'OR', baseUrl: 'https://or.example/api', apiKeyEnv: 'OR_KEY', models: [{ id: 'anthropic/claude-x' }, { id: 'ds-chat' }] },
  ],
  overrides: { haiku: 'DS/ds-chat' },
}

export const PANE_PROPS = {
  title: 'test',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

export function routerStatus(patch: Partial<RouterStatus> = {}): RouterStatus {
  return {
    name: 'model-router',
    version: VERSION,
    pid: 42,
    uptimeMs: 1,
    upstream: 'https://gw.example',
    configOk: true,
    providers: [
      { name: 'DS', available: true, breaker: 'closed' },
      { name: 'OR', available: true, breaker: 'closed' },
    ],
    models: [{ ref: 'DS/ds-chat' }, { ref: 'DS/ds-reasoner' }, { ref: 'OR/anthropic/claude-x' }, { ref: 'OR/ds-chat' }],
    policyApi: 1,
    eventsSeq: 0,
    ...patch,
  }
}

type Reply = { status: number; json: unknown }
type Route = (url: URL, body: string | undefined, headers: Record<string, string>) => Reply

export type World = {
  clock: MockClock
  files: Map<string, string>
  unreadable: Set<string>
  unstatable: Set<string>
  realPaths: Map<string, string>
  settings: Partial<Record<SettingsSource, Record<string, unknown>>>
  http: Map<string, Route>
  fetches: { method: string; url: string; headers: Record<string, string> }[]
  runs: { argv: readonly string[]; stdin?: string }[]
  tool: (sub: string, args: readonly string[], stdin: string | undefined) => Record<string, unknown> | undefined
  events: RouterEvent[]
  toasts: string[]
  statusLines: (string | undefined)[]
  logs: string[]
  opened: string[]
  closed: string[]
  registered: string[]
  commands: { command: string; args: string; origin: string }[]
  stepModels: string[]
  completes: ModelCompleteInput[]
  complete: (input: ModelCompleteInput) => ModelCompleteResult
  sessionId: string
  model: string
  failSessionModel: boolean
  rawRun: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } | null
}

export type WorldOptions = { env?: Record<string, string>; files?: Record<string, string>; config?: unknown; isRouterUp?: boolean }

export function up(w: World, status: RouterStatus = routerStatus()): void {
  w.http.set('GET /_router/status', () => ({ status: 200, json: status }))
  w.http.set('GET /_router/events', url => {
    const after = Number(url.searchParams.get('after') ?? 0)
    return { status: 200, json: { events: w.events.filter(e => e.seq > after), lastSeq: w.events.at(-1)?.seq ?? status.eventsSeq } }
  })
  w.http.set('GET /_router/limits', () => ({ status: 200, json: { learned: {}, policy: null } }))
  w.http.set('GET /_router/keys', () => ({ status: 200, json: { keys: { DS_KEY: 'fp-ds', OR_KEY: 'fp-or' } } }))
  w.http.set('POST /_router/forget', () => ({ status: 200, json: { forgotten: 1 } }))
  w.http.set('POST /_router/shutdown', () => { down(w); return { status: 202, json: { stopping: true } } })
}

export function down(w: World): void {
  w.http.clear()
}

export function world(on: On, { env = {}, files = {}, config = CONFIG_JSON, isRouterUp = true }: WorldOptions = {}): World {
  const w: World = {
    clock: mock.clock(on),
    files: new Map(Object.entries(files)),
    unreadable: new Set(),
    unstatable: new Set(),
    realPaths: new Map(),
    settings: {},
    http: new Map(),
    fetches: [],
    runs: [],
    tool: () => undefined,
    events: [],
    toasts: [],
    statusLines: [],
    logs: [],
    opened: [],
    closed: [],
    registered: [],
    commands: [],
    stepModels: [],
    completes: [],
    complete: () => ({ isAnswered: true, text: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    sessionId: 'sess-1',
    model: 'claude-opus-5-5',
    failSessionModel: false,
    rawRun: null,
  }
  if (config !== null) w.files.set(CONFIG, JSON.stringify(config))
  if (isRouterUp) up(w)
  mock.env(on, { USERPROFILE: HOME, ...env })

  // The engine hands fs hooks native paths (backslashes on Windows); w.files keys use /.
  on('fs.read', ($, e) => (w.unreadable.has(slash(e.path)) ? { deny: `EACCES: ${e.path}` } : w.files.has(slash(e.path)) ? { value: w.files.get(slash(e.path))! } : { deny: `ENOENT: ${e.path}` }))
  on('fs.exists', ($, e) => ({ value: w.files.has(slash(e.path)) }))
  on('fs.stat', ($, e) => (w.unstatable.has(slash(e.path)) ? { deny: `EIO: ${e.path}` } : w.files.has(slash(e.path)) ? { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: w.realPaths.has(slash(e.path)), ...(e.resolve ? { realPath: w.realPaths.get(slash(e.path)) ?? slash(e.path) } : {}) } } : { deny: `ENOENT: ${e.path}` }))
  on('settings.read', ($, e) => ({ value: (e.source ? w.settings[e.source] : Object.assign({}, ...Object.values(w.settings))) ?? {} }))
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const headers = e.init?.headers ?? {}
    w.fetches.push({ method, url: e.url, headers })
    const route = w.http.get(`${method} ${url.pathname}`)
    if (!route) return { deny: 'connect ECONNREFUSED' }
    const reply = route(url, e.init?.body, headers)
    return { value: { status: reply.status, ok: reply.status < 400, headers: {}, text: JSON.stringify(reply.json) } }
  })
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin
    w.runs.push({ argv: e.argv, ...(stdin !== undefined ? { stdin } : {}) })
    if (w.rawRun) return { value: w.rawRun }
    const [, script = '', sub = '', ...args] = e.argv
    if (!script.endsWith('/router/launch.mjs')) return { deny: `unexpected command ${e.argv.join(' ')}` }
    const out = w.tool(sub, args, stdin) ?? builtinTool(w, sub, args, stdin)
    return { value: { exitCode: out.ok === false ? 1 : 0, stdout: `${JSON.stringify(out)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { w.statusLines.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.open', ($, e) => { w.opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { w.closed.push(e.id); return { value: undefined } })
  on('command.register', ($, e) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('session.id', () => ({ value: w.sessionId }))
  on('session.model', () => (w.failSessionModel ? { deny: 'session.model failed' } : { value: w.model }))
  on('model.complete', ($, e) => { w.completes.push(e); return { value: w.complete(e) } })
  on('command.run', ($, e) => {
    w.commands.push({ command: e.command, args: e.args, origin: e.origin.kind })
    return { text: `built-in /${e.command} ${e.args}`.trim() }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* ($, e) {
    w.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

const slash = (path: string) => path.replace(/\\/g, '/')

function builtinTool(w: World, sub: string, args: readonly string[], stdin: string | undefined): Record<string, unknown> {
  switch (sub) {
    case 'write': w.files.set(args[0]!, stdin ?? ''); return { ok: true }
    case 'delete': w.files.delete(args[0]!); return { ok: true }
    case 'ensure-token': {
      const existing = w.files.get(args[0]!)
      if (existing) return { ok: true, token: existing.trim(), created: false }
      w.files.set(args[0]!, 'tok-1')
      return { ok: true, token: 'tok-1', created: true }
    }
    case 'env-check': return { ok: true, keys: Object.fromEntries(args.map(n => [n, `fp-${n === 'DS_KEY' ? 'ds' : n === 'OR_KEY' ? 'or' : 'x'}`])) }
    case 'start':
      if (w.http.has('GET /_router/status')) return { ok: true, started: false, pid: 42, version: VERSION }
      up(w); return { ok: true, started: true, pid: 42, version: VERSION }
    case 'probe': return { ok: true, status: 200 }
    default: return { ok: false, error: `no stub for ${sub}` }
  }
}

export const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

export const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })

export const readJson = (w: World, path: string): any => JSON.parse(w.files.get(path) ?? 'null')

// One main-loop (or, with agentId, subagent) model request. The stream is read to
// its end: the kit runs the chain only as the stream is read, so `.result` alone
// settles without reaching the hooks beneath.
export async function step($: Engine, patch: { model?: string; agentId?: string } = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...patch })
  for await (const _ of stream) { /* drain */ }
  return stream.result
}
