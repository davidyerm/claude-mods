import { expect, test } from 'claude-code/testing'
import {
  backupOf, describeSource, mergeSettings, pickBaseUrl, planSetup, restoreSettings, withoutTokenHeader, withTokenHeader,
} from '../hooks/setup'
import type { Backup } from '../hooks/setup'
import type { World } from './world'
import { BACKUP, CONFIG, readJson, run, start, TOKEN_FILE, USER_SETTINGS, world } from './world'

const ROUTER = 'http://127.0.0.1:4141'

function userSettings(w: World, value: Record<string, unknown> | null) {
  if (value === null) { w.files.delete(USER_SETTINGS); delete w.settings.user; return }
  w.files.set(USER_SETTINGS, JSON.stringify(value, null, 2))
  w.settings.user = value
}
const reloadSettings = (w: World) => { w.settings.user = readJson(w, USER_SETTINGS) }

// ---- pure ----

test('token header merge keeps other headers, takes CRLF, and never doubles the token', () => {
  expect(withTokenHeader(undefined, 't')).toBe('x-router-token: t')
  expect(withTokenHeader('X-Corp: a\r\nX-Team: b', 't')).toBe('X-Corp: a\nX-Team: b\nx-router-token: t')
  expect(withTokenHeader('X-Corp: a\nX-Router-Token: old', 'new')).toBe('X-Corp: a\nx-router-token: new')
  expect(withTokenHeader('x-router-token: t', 't')).toBe('x-router-token: t')
  expect(withoutTokenHeader('x-router-token: t')).toBe(undefined)
  expect(withoutTokenHeader('X-Corp: a\r\nx-router-token: t\r\n')).toBe('X-Corp: a')
})

test('describeSource names every source', () => {
  expect(describeSource('project')).toBe("the project's .claude/settings.json")
  expect(describeSource('user')).toBe('~/.claude/settings.json')
  expect(describeSource('os')).toBe('the OS environment')
})

test('pickBaseUrl: policy > flag > local > project > user > OS env', () => {
  const at = (source: string, value: string) => ({ [source]: { env: { ANTHROPIC_BASE_URL: value } } })
  expect(pickBaseUrl({ ...at('user', 'u'), ...at('project', 'p') }, 'os')).toEqual({ value: 'p', source: 'project' })
  expect(pickBaseUrl({ ...at('project', 'p'), ...at('local', 'l') }, undefined)).toEqual({ value: 'l', source: 'local' })
  expect(pickBaseUrl({ ...at('local', 'l'), ...at('flag', 'f') }, undefined)).toEqual({ value: 'f', source: 'flag' })
  expect(pickBaseUrl({ ...at('flag', 'f'), ...at('policy', 'x') }, undefined)).toEqual({ value: 'x', source: 'policy' })
  expect(pickBaseUrl({ ...at('user', 'u') }, 'os')).toEqual({ value: 'u', source: 'user' })
  expect(pickBaseUrl({}, 'os')).toEqual({ value: 'os', source: 'os' })
  expect(pickBaseUrl({}, undefined)).toEqual({ value: undefined, source: 'none' })
})

const plan = (over: Partial<Parameters<typeof planSetup>[0]> = {}) =>
  planSetup({ base: { value: 'https://gw.corp/', source: 'user' }, url: ROUTER, upstreamNow: undefined, settings: {}, loadedErrors: null, configPath: 'C', settingsPath: 'S', ...over })

test('planSetup: proceeds with a trimmed upstream; Anthropic when nothing is set', () => {
  expect(plan()).toEqual({ kind: 'proceed', upstream: 'https://gw.corp' })
  expect(plan({ base: { value: undefined, source: 'none' } })).toEqual({ kind: 'proceed', upstream: 'https://api.anthropic.com' })
  expect(plan({ base: { value: 'https://gw.os', source: 'os' }, settings: null })).toEqual({ kind: 'proceed', upstream: 'https://gw.os' })
})

test('planSetup: stops for a project setting, an already-wired URL, a bad config or a bad settings file', () => {
  const project = plan({ base: { value: 'https://gw.project', source: 'project' } })
  expect(project.kind).toBe('stop')
  if (project.kind === 'stop') {
    expect(project.text).toContain("the project's .claude/settings.json, which outranks ~/.claude/settings.json")
    expect(project.text).toContain(`"ANTHROPIC_BASE_URL": "${ROUTER}"`)
    expect(project.text).toContain('"upstream": "https://gw.project"')
  }
  const done = plan({ base: { value: ROUTER, source: 'user' }, upstreamNow: 'https://gw.corp' })
  expect(done.kind === 'stop' && done.text.startsWith(`Already set up: ANTHROPIC_BASE_URL → ${ROUTER}`)).toBe(true)
  expect(plan({ loadedErrors: 'bad' })).toEqual({ kind: 'stop', text: 'C is invalid: bad. Fix it, then run /router setup again.' })
  expect(plan({ settings: 'invalid' })).toEqual({ kind: 'stop', text: 'S is not a JSON object; fix it, then run /router setup again.' })
})

test('mergeSettings keeps other keys and env vars, merges CRLF headers, creates a missing file', () => {
  const merged = JSON.parse(mergeSettings({ theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp/', ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\r\nX-Team: b' } }, ROUTER, 'tok-1', undefined))
  expect(merged).toEqual({ theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\nX-Team: b\nx-router-token: tok-1' } })
  expect(JSON.parse(mergeSettings(null, ROUTER, 'tok-1', undefined))).toEqual({ env: { ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' } })
  expect(JSON.parse(mergeSettings({}, ROUTER, 'tok-1', 'X-Os: 1')).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Os: 1\nx-router-token: tok-1')
  const twice = mergeSettings(JSON.parse(mergeSettings({ a: 1 }, ROUTER, 'tok-1', undefined)), ROUTER, 'tok-1', undefined)
  expect(JSON.parse(twice).env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-router-token: tok-1')
})

test('backupOf records the original gateway and headers', () => {
  expect(backupOf({ value: 'https://gw.corp/', source: 'user' }, { env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\r\nX-Team: b' } }, 'T'))
    .toEqual({ version: 1, baseUrl: 'https://gw.corp/', source: 'user', customHeaders: 'X-Corp: a\r\nX-Team: b', at: 'T' })
  expect(backupOf({ value: undefined, source: 'none' }, null, 'T')).toEqual({ version: 1, baseUrl: null, source: 'none', customHeaders: null, at: 'T' })
})

test('restoreSettings puts the originals back exactly', () => {
  const original = { theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp/', ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\r\nX-Team: b' } }
  const backup = backupOf({ value: 'https://gw.corp/', source: 'user' }, original, 'T')
  const wired = JSON.parse(mergeSettings(original, ROUTER, 'tok-1', undefined))
  const restored = restoreSettings(wired, backup)
  expect(JSON.parse(restored.text)).toEqual(original)
  expect(restored.restoredUrl).toBe('https://gw.corp/')
  const os: Backup = { version: 1, baseUrl: 'https://gw.os', source: 'os', customHeaders: null, at: 'T' }
  expect(JSON.parse(restoreSettings(JSON.parse(mergeSettings(null, ROUTER, 't', undefined)), os).text)).toEqual({})
})

// ---- through /router setup and /router uninstall ----

test('setup from user settings: saves upstream, token, backup, rewires settings and keeps everything else', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp/' } })
  await start($)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(readJson(w, CONFIG)).toEqual({ version: 1, providers: [], overrides: {}, upstream: 'https://gw.corp' })
  expect(w.files.get(TOKEN_FILE)).toBe('tok-1')
  const s = readJson(w, USER_SETTINGS)
  expect(s.theme).toBe('dark')
  expect(s.env).toEqual({ FOO: '1', ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' })
  expect(readJson(w, BACKUP)).toEqual({ version: 1, baseUrl: 'https://gw.corp/', source: 'user', customHeaders: null, at: '1970-01-01T00:00:00.000Z' })
  expect(text).toContain('Restart Claude Code to activate.')
  expect(text).toContain('set env.ANTHROPIC_BASE_URL back to https://gw.corp/')
  expect(w.runs.some(r => r.argv[2] === 'ensure-token')).toBe(true)
})

test('existing custom headers are merged and backed up', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp', ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\r\nX-Team: b' } })
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, USER_SETTINGS).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Corp: a\nX-Team: b\nx-router-token: tok-1')
  expect(readJson(w, BACKUP).customHeaders).toBe('X-Corp: a\r\nX-Team: b')
})

test('setup twice: the second run reports and changes nothing', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  await start($)
  await run($, 'router', 'setup')
  reloadSettings(w)
  const before = w.files.get(USER_SETTINGS)
  const backup = w.files.get(BACKUP)
  const runs = w.runs.length
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text.startsWith(`Already set up: ANTHROPIC_BASE_URL → ${ROUTER}`)).toBe(true)
  expect(w.files.get(USER_SETTINGS)).toBe(before)
  expect(w.files.get(BACKUP)).toBe(backup)
  expect(w.runs.length).toBe(runs)
})

test('no settings file and the gateway in the OS env: the file is created, source os', async ($, on) => {
  const w = world(on, { config: null, env: { ANTHROPIC_BASE_URL: 'https://gw.os' } })
  userSettings(w, null)
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, USER_SETTINGS)).toEqual({ env: { ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' } })
  expect(readJson(w, BACKUP).source).toBe('os')
  expect(readJson(w, CONFIG).upstream).toBe('https://gw.os')
})

test('nothing set anywhere: the upstream is Anthropic', async ($, on) => {
  const w = world(on, { config: null })
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, CONFIG).upstream).toBe('https://api.anthropic.com')
})

test('a project setting outranks user settings: setup explains and writes nothing', async ($, on) => {
  const w = world(on, { config: null })
  w.settings.project = { env: { ANTHROPIC_BASE_URL: 'https://gw.project' } }
  await start($)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text).toContain("the project's .claude/settings.json, which outranks ~/.claude/settings.json")
  expect(text).toContain(`"ANTHROPIC_BASE_URL": "${ROUTER}"`)
  expect(w.files.has(USER_SETTINGS)).toBe(false)
  expect(w.files.has(CONFIG)).toBe(false)
  expect(w.files.has(BACKUP)).toBe(false)
})

test('a settings file that is not a JSON object is left alone', async ($, on) => {
  const w = world(on, { config: null })
  w.files.set(USER_SETTINGS, '[1]')
  await start($)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text).toContain('is not a JSON object; fix it, then run /router setup again.')
  expect(w.files.get(USER_SETTINGS)).toBe('[1]')
  expect(w.files.has(CONFIG)).toBe(false)
})

test('uninstall restores the original values and removes the backup', async ($, on) => {
  const w = world(on, { config: null })
  userSettings(w, { theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  await start($)
  await run($, 'router', 'setup')
  const text = (await run($, 'router', 'uninstall')).text ?? ''
  expect(readJson(w, USER_SETTINGS)).toEqual({ theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  expect(w.files.has(BACKUP)).toBe(false)
  expect(text).toContain('The router keeps serving other sessions')
  expect((await run($, 'router', 'uninstall')).text).toBe('Nothing to undo: no setup backup found (/router setup was not run, or was undone).')
})

test('uninstall after an OS-env setup removes the settings env it added', async ($, on) => {
  const w = world(on, { config: null, env: { ANTHROPIC_BASE_URL: 'https://gw.os' } })
  userSettings(w, null)
  await start($)
  await run($, 'router', 'setup')
  await run($, 'router', 'uninstall')
  expect(readJson(w, USER_SETTINGS)).toEqual({})
})
