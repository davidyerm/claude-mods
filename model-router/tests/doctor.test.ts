import { expect, test } from 'claude-code/testing'
import { VERSION } from '../router/version.mjs'
import { authFamily, breakerItem, configItem, authItem, formatReport, keyItem, limitsItems, providerProbeItem, routerItem, tlsItem, tokenItem, wiringItem } from '../hooks/doctor'
import type { World } from './world'
import { CONFIG, CONFIG_JSON, down, routerStatus, run, start, TOKEN_FILE, USER_SETTINGS, world } from './world'

const ROUTER = 'http://127.0.0.1:4141'
const WIRED = { ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' }

function healthy(on: Parameters<typeof world>[0], patch: { env?: Record<string, string>; config?: unknown } = {}): World {
  const w = world(on, { env: { ...WIRED, ...patch.env }, config: patch.config ?? CONFIG_JSON })
  w.files.set(TOKEN_FILE, 'tok-1')
  w.settings.user = { env: { ANTHROPIC_BASE_URL: ROUTER } }
  w.files.set(USER_SETTINGS, JSON.stringify(w.settings.user))
  return w
}
async function doctor($: Parameters<typeof start>[0], isOffline = false): Promise<string> {
  return (await run($, 'router', isOffline ? 'doctor --offline' : 'doctor')).text ?? ''
}

// ---- pure ----

test('formatReport prints marks, indented fixes, and the optional line', () => {
  expect(formatReport([{ mark: '✓', label: 'a' }, { mark: '✗', label: 'b', fix: 'do c' }])).toBe(
    ['model-router doctor', '✓ a', '✗ b', '    fix: do c', '', 'Optional: model-limits (per-model context/output policies)'].join('\n'),
  )
})

test('routerItem: running, other version, foreign port, down', () => {
  expect(routerItem({ kind: 'ours', status: routerStatus() }, 4141, 'c')).toEqual({ mark: '✓', label: `router running: v${VERSION}, pid 42, port 4141` })
  expect(routerItem({ kind: 'ours', status: routerStatus({ version: '0.0.0' }) }, 4141, 'c')).toMatchObject({ mark: '⚠', fix: '/router restart' })
  expect(routerItem({ kind: 'foreign' }, 4141, 'c.json')).toEqual({ mark: '✗', label: 'port 4141 answers, but not as model-router', fix: 'set "port" in c.json to a free port, then /router setup' })
  expect(routerItem({ kind: 'down', reason: 'x' }, 4141, 'c')).toEqual({ mark: '✗', label: 'router not running (x)', fix: '/router restart' })
})

test('wiringItem: router, stale session, bypass, policy, none', () => {
  const at = (value: string | undefined, source: 'user' | 'project' | 'policy' | 'none') => ({ value, source })
  expect(wiringItem(at(ROUTER, 'user'), ROUTER, ROUTER).mark).toBe('✓')
  expect(wiringItem(at(ROUTER, 'user'), undefined, ROUTER)).toMatchObject({ mark: '⚠', fix: 'restart Claude Code' })
  expect(wiringItem(at('https://x', 'project'), ROUTER, ROUTER).fix).toBe(`change it there to ${ROUTER}, or remove it`)
  expect(wiringItem(at('https://x', 'policy'), 'https://x', ROUTER).fix).toBe(`change ANTHROPIC_BASE_URL in managed policy settings to ${ROUTER}`)
  expect(wiringItem(at(undefined, 'none'), undefined, ROUTER)).toMatchObject({ mark: '✗', fix: '/router setup' })
})

test('tokenItem: missing, absent from headers, present among others', () => {
  expect(tokenItem('', '').fix).toBe('/router setup')
  expect(tokenItem('t', 'X-Corp: a').mark).toBe('✗')
  expect(tokenItem('t', 'X-Corp: a\r\nx-router-token: t').mark).toBe('✓')
})

test('authFamily and authItem', () => {
  expect(authFamily({ haiku: 'a/b' })).toBe('sonnet')
  expect(authFamily({ haiku: 'a/b', sonnet: 'a/b', opus: 'a/b', fable: 'a/b' })).toBeNull()
  expect(authItem(null, null).mark).toBe('⚠')
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  expect(authItem('sonnet', { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage })).toMatchObject({ mark: '✗', label: 'upstream refused the sonnet request: HTTP no response (unknown)' })
  expect(authItem('sonnet', { isAnswered: false, reason: 'aborted', usage } as never).label).toBe('upstream sonnet request: aborted')
})

test('tlsItem: trusted, untrusted, unreachable', () => {
  expect(tlsItem({ ok: true }).mark).toBe('✓')
  expect(tlsItem({ ok: false, kind: 'tls', text: 'bad' }).mark).toBe('✗')
  expect(tlsItem({ ok: false, kind: 'connect', text: 'refused' })).toMatchObject({ mark: '⚠', label: 'upstream not reachable from Node (refused)' })
})

test('keyItem: unset, differs, same, router unreachable', () => {
  const f = { name: 'DS', envName: 'DS_KEY', mine: 'a', routers: 'a', isRouterKnown: true }
  expect(keyItem(f)).toEqual({ hasKey: true, item: { mark: '✓', label: '[DS] key DS_KEY set' } })
  expect(keyItem({ ...f, routers: 'b' }).item.mark).toBe('⚠')
  expect(keyItem({ ...f, mine: null, routers: null })).toMatchObject({ hasKey: false, item: { mark: '✗' } })
  expect(keyItem({ ...f, routers: null, isRouterKnown: false }).item.mark).toBe('✓')
})

test('providerProbeItem: learned limit, no-key skipped, http failure', () => {
  expect(providerProbeItem('DS', 'm', 'c', { ok: true, learnedMaxTokens: 8192 })?.label).toBe('[DS] m answers (max output 8192 learned)')
  expect(providerProbeItem('DS', 'm', 'c', { ok: false, kind: 'no-key' })).toBeNull()
  expect(providerProbeItem('DS', 'm', 'c', { ok: false, kind: 'http', status: 500, text: 'boom' })?.label).toBe('[DS] m failed: 500 boom')
})

test('limitsItems lists learned limits and a registered policy', () => {
  const learned = { 'DS/ds-chat': { maxOutputTokens: 8192, learnedAt: 't', source: 's' } }
  expect(limitsItems({ learned, policy: { a: 1 } }).map(i => i.label)).toEqual(['learned limits: [DS] ds-chat max output 8192', 'policy registered: {"a":1}'])
})

// ---- through /router doctor ----

test('a healthy setup is all ticks', async ($, on) => {
  healthy(on)
  await start($)
  expect(await doctor($)).toBe([
    'model-router doctor',
    `✓ config ${CONFIG} is valid`,
    `✓ router running: v${VERSION}, pid 42, port 4141`,
    '✓ base URL → router (~/.claude/settings.json)',
    '✓ x-router-token header present',
    '✓ upstream answers with auth (sonnet)',
    '✓ upstream TLS certificate trusted',
    '✓ [DS] key DS_KEY set',
    '✓ [DS] ds-chat answers',
    '✓ [OR] key OR_KEY set',
    '✓ [OR] anthropic/claude-x answers',
    '✓ learned limits: none yet',
    '✓ policy: none registered',
    '',
    'Optional: model-limits (per-model context/output policies)',
  ].join('\n'))
})

test('the report never holds a key or token value', async ($, on) => {
  const w = healthy(on)
  w.tool = (sub, args) => (sub === 'env-check' ? { ok: true, keys: Object.fromEntries(args.map(n => [n, `fp-${n}`])) } : undefined)
  w.http.set('GET /_router/keys', () => ({ status: 200, json: { keys: { DS_KEY: 'fp-DS_KEY', OR_KEY: 'fp-OR_KEY' } } }))
  await start($)
  const report = await doctor($)
  expect(report).not.toContain('tok-1')
  expect(report).not.toContain('sk-')
  expect(report).not.toContain('fp-')
})

test('not wired yet: base URL and token lines fail with fixes', async ($, on) => {
  const w = world(on, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  w.settings.user = { env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } }
  await start($)
  const report = await doctor($, true)
  expect(report).toContain('✗ base URL is https://gw.corp (~/.claude/settings.json), not the router\n    fix: /router setup')
  expect(report).toContain('✗ no router token yet\n    fix: /router setup')
})

test('a project-level base URL is reported as a bypass', async ($, on) => {
  const w = healthy(on)
  w.settings.project = { env: { ANTHROPIC_BASE_URL: 'https://elsewhere' } }
  await start($)
  expect(await doctor($, true)).toContain("✗ the project's .claude/settings.json sets ANTHROPIC_BASE_URL=https://elsewhere, so this project bypasses the router\n    fix: change it there to http://127.0.0.1:4141, or remove it")
})

test('a key changed since the router started asks for a restart', async ($, on) => {
  const w = healthy(on)
  w.http.set('GET /_router/keys', () => ({ status: 200, json: { keys: { DS_KEY: 'fp-old', OR_KEY: 'fp-or' } } }))
  await start($)
  expect(await doctor($, true)).toContain("⚠ [DS] DS_KEY differs from the router's (set or changed after it started)\n    fix: /router restart")
})

test('a key set nowhere is an error and skips its test request', async ($, on) => {
  const w = healthy(on)
  w.http.set('GET /_router/keys', () => ({ status: 200, json: { keys: { DS_KEY: null, OR_KEY: 'fp-or' } } }))
  w.tool = sub => (sub === 'env-check' ? { ok: true, keys: { DS_KEY: null, OR_KEY: 'fp-or' } } : undefined)
  await start($)
  const report = await doctor($)
  expect(report).toContain('✗ [DS] DS_KEY is not set\n    fix: set DS_KEY')
  expect(report).not.toContain('[DS] ds-chat answers')
  expect(report).toContain('✓ [OR] anthropic/claude-x answers')
})

test('a rejected field names the strip fix; --offline skips provider calls', async ($, on) => {
  const w = healthy(on)
  w.tool = (sub, args, stdin) => (sub === 'probe' && JSON.parse(stdin!).mode === 'provider' ? { ok: false, kind: 'http', status: 400, text: "unknown field 'thinking'" } : undefined)
  await start($)
  expect(await doctor($)).toContain(`✗ [DS] ds-chat rejected: 400 unknown field 'thinking'\n    fix: add the rejected field to "strip" for DS in ${CONFIG}`)
  const before = w.runs.length
  await doctor($, true)
  expect(w.runs.slice(before).some(r => r.stdin?.includes('"provider"'))).toBe(false)
})

test('upstream auth failures and an untrusted certificate are explained', async ($, on) => {
  const w = healthy(on)
  w.complete = () => ({ isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  w.tool = (sub, args, stdin) => (sub === 'probe' && JSON.parse(stdin!).mode === 'tls' ? { ok: false, kind: 'tls', text: 'tls: SELF_SIGNED_CERT_IN_CHAIN' } : undefined)
  await start($)
  const report = await doctor($, true)
  expect(report).toContain('✗ upstream refused the sonnet request: HTTP 401 (authentication_failed)\n    fix: check apiKeyHelper and the gateway credentials')
  expect(report).toContain('✗ upstream certificate not trusted (tls: SELF_SIGNED_CERT_IN_CHAIN)\n    fix: export the internal CA')
})

test('all families overridden: upstream auth cannot be tested', async ($, on) => {
  healthy(on, { config: { ...CONFIG_JSON, overrides: { haiku: 'DS/ds-chat', sonnet: 'DS/ds-chat', opus: 'DS/ds-chat', fable: 'DS/ds-chat' } } })
  await start($)
  expect(await doctor($, true)).toContain("⚠ can't test upstream auth while all families are overridden")
})

test('a literal key is warned about; a down router fails with a fix', async ($, on) => {
  const w = healthy(on, { config: { ...CONFIG_JSON, providers: [{ name: 'L', baseUrl: 'https://l.example', apiKey: 'sk-x', models: [{ id: 'm' }] }], overrides: {} } })
  await start($)
  down(w)
  const report = await doctor($, true)
  expect(report).toContain(`⚠ [L] literal apiKey in ${CONFIG}\n    fix: move it to an environment variable and use "apiKeyEnv"`)
  expect(report).toMatch(/✗ router not running \(.*\)\n {4}fix: \/router restart/)
  expect(report).not.toContain('sk-x')
})

test('configItem: invalid and missing config', () => {
  expect(configItem('c.json', null, [{ path: 'port', message: 'bad' }])).toMatchObject({ mark: '✗', fix: 'fix the file; the router keeps using the last valid version meanwhile' })
  expect(configItem('c.json', null, [])).toEqual({ mark: '⚠', label: 'no config at c.json yet', fix: '/router setup, then /router add' })
})

test('breakerItem has no fix line', () => {
  expect(breakerItem('DS')).toEqual({ mark: '⚠', label: '[DS] paused by the circuit breaker; it resumes by itself within 5 minutes' })
})

test('providerProbeItem: untrusted certificate', () => {
  expect(providerProbeItem('DS', 'm', 'c', { ok: false, kind: 'tls', text: 'bad' })).toMatchObject({ mark: '✗', label: '[DS] certificate not trusted (bad)' })
})

test('an open breaker is reported through the hook', async ($, on) => {
  const w = healthy(on)
  w.http.set('GET /_router/status', () => ({ status: 200, json: routerStatus({ providers: [{ name: 'DS', available: false, breaker: 'open' }, { name: 'OR', available: true, breaker: 'closed' }] }) }))
  await start($)
  expect(await doctor($, true)).toContain('⚠ [DS] paused by the circuit breaker; it resumes by itself within 5 minutes')
})

test('an aborted upstream check is explained with a fix', async ($, on) => {
  const w = healthy(on)
  w.complete = () => ({ isAnswered: false, reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })
  await start($)
  expect(await doctor($, true)).toContain('✗ upstream sonnet request: aborted\n    fix: see ~/.claude/model-router/router.log, then /router doctor again')
  expect(w.completes.at(-1)?.timeoutMs).toBe(30_000)
})

test('a project source with headers: the token fix names the project file, never the token (final fix I2)', async ($, on) => {
  const w = healthy(on, { env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Project: p' } })
  w.settings.project = { env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Project: p' } }
  await start($)
  const report = await doctor($, true)
  expect(report).toContain(`✗ this session does not send the x-router-token header (routed requests get 401)
    fix: add \`x-router-token: <the token from ${TOKEN_FILE}>\` to ANTHROPIC_CUSTOM_HEADERS in the project's .claude/settings.json, then restart Claude Code`)
  expect(report).not.toContain('tok-1')
})
