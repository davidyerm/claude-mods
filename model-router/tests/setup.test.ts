import { expect, test } from 'claude-code/testing'
import {
  backupOf, classifySettings, describeSource, mergeSettings, parseBackup, pickBaseUrl, planSetup, restoreSettings, withoutTokenHeader, withTokenHeader,
} from '../hooks/setup'
import type { Backup } from '../hooks/setup'
import type { World, WorldOptions } from './world'
import { BACKUP, CONFIG, readJson, run, start, TOKEN_FILE, USER_SETTINGS, world } from './world'

const ROUTER = 'http://127.0.0.1:4141'

// Setup runs in a session that is not wired yet: no ANTHROPIC_BASE_URL in the OS env unless a test sets one.
const unwired = (on: Parameters<typeof world>[0], opts: WorldOptions = {}) => world(on, { ...opts, env: { ANTHROPIC_BASE_URL: undefined, ...opts.env } })

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
  expect(plan()).toMatchObject({ kind: 'proceed', upstream: 'https://gw.corp', isUpstreamSaved: true, rewiredFrom: null })
  expect(plan({ base: { value: undefined, source: 'none' } })).toMatchObject({ kind: 'proceed', upstream: 'https://api.anthropic.com' })
  expect(plan({ base: { value: 'https://gw.os', source: 'os' }, settings: null })).toMatchObject({ kind: 'proceed', upstream: 'https://gw.os' })
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
    .toEqual({ version: 1, baseUrl: 'https://gw.corp/', source: 'user', customHeaders: 'X-Corp: a\r\nX-Team: b', writtenHeaders: 'X-Corp: a\nX-Team: b', at: 'T' })
  expect(backupOf({ value: undefined, source: 'none' }, null, 'T')).toEqual({ version: 1, baseUrl: null, source: 'none', customHeaders: null, writtenHeaders: null, at: 'T' })
  expect(backupOf({ value: undefined, source: 'none' }, null, 'T', 'X-Os: 1\r\nx-router-token: z').writtenHeaders).toBe('X-Os: 1')
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
  const w = unwired(on, { config: null })
  userSettings(w, { theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'https://gw.corp/' } })
  await start($)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(readJson(w, CONFIG)).toEqual({ version: 1, providers: [], overrides: {}, upstream: 'https://gw.corp' })
  expect(w.files.get(TOKEN_FILE)).toBe('tok-1')
  const s = readJson(w, USER_SETTINGS)
  expect(s.theme).toBe('dark')
  expect(s.env).toEqual({ FOO: '1', ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' })
  expect(readJson(w, BACKUP)).toEqual({ version: 1, baseUrl: 'https://gw.corp/', source: 'user', customHeaders: null, writtenHeaders: null, at: '1970-01-01T00:00:00.000Z' })
  expect(text).toContain('Restart Claude Code to activate.')
  expect(text).toContain('set env.ANTHROPIC_BASE_URL back to https://gw.corp/')
  expect(w.runs.some(r => r.argv[2] === 'ensure-token')).toBe(true)
})

test('existing custom headers are merged and backed up', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp', ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\r\nX-Team: b' } })
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, USER_SETTINGS).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Corp: a\nX-Team: b\nx-router-token: tok-1')
  expect(readJson(w, BACKUP).customHeaders).toBe('X-Corp: a\r\nX-Team: b')
})

test('setup twice: the second run reports and changes nothing', async ($, on) => {
  const w = unwired(on, { config: null })
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
  const w = unwired(on, { config: null, env: { ANTHROPIC_BASE_URL: 'https://gw.os' } })
  userSettings(w, null)
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, USER_SETTINGS)).toEqual({ env: { ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: tok-1' } })
  expect(readJson(w, BACKUP).source).toBe('os')
  expect(readJson(w, CONFIG).upstream).toBe('https://gw.os')
})

test('nothing set anywhere: the upstream is Anthropic', async ($, on) => {
  const w = unwired(on, { config: null })
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, CONFIG).upstream).toBe('https://api.anthropic.com')
})

test('a project setting outranks user settings: setup explains and writes nothing', async ($, on) => {
  const w = unwired(on, { config: null })
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
  const w = unwired(on, { config: null })
  w.files.set(USER_SETTINGS, '[1]')
  await start($)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text).toContain('is not a JSON object; fix it, then run /router setup again.')
  expect(w.files.get(USER_SETTINGS)).toBe('[1]')
  expect(w.files.has(CONFIG)).toBe(false)
})

test('uninstall restores the original values and removes the backup', async ($, on) => {
  const w = unwired(on, { config: null })
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
  const w = unwired(on, { config: null, env: { ANTHROPIC_BASE_URL: 'https://gw.os' } })
  userSettings(w, null)
  await start($)
  await run($, 'router', 'setup')
  await run($, 'router', 'uninstall')
  expect(readJson(w, USER_SETTINGS)).toEqual({})
})

// ---- fix round 1 ----

const snapshot = (w: World) => JSON.stringify([...w.files.entries()])

test('classifySettings: an unreadable file is never a missing one', () => {
  expect(classifySettings(null, false, {})).toBe(null)
  expect(classifySettings(null, true, {})).toBe('unreadable')
  expect(classifySettings(null, false, { theme: 'dark' })).toBe('unreadable')
  expect(classifySettings('{"a":1}', true, {})).toEqual({ a: 1 })
  expect(classifySettings('[1]', true, {})).toBe('invalid')
  expect(classifySettings('{', true, {})).toBe('invalid')
})

test('planSetup: unreadable settings stop setup with the exact text', () => {
  expect(plan({ settings: 'unreadable', settingsPath: 'S' })).toEqual({
    kind: 'stop',
    text: 'Could not read S; nothing was changed. Check that no other plugin blocks reading it, then run /router setup again.',
  })
})

test('planSetup: a loopback base is a router, never an upstream', () => {
  for (const old of ['http://127.0.0.1:4000', 'http://localhost:4141/', 'http://[::1]:4141']) {
    expect(plan({ base: { value: old, source: 'user' }, upstreamNow: 'https://gw.corp' }))
      .toEqual({ kind: 'proceed', upstream: 'https://gw.corp', isUpstreamSaved: false, isBackupWritten: false, rewiredFrom: old })
  }
  // The same URL with a trailing slash is already set up; localhost:4141 is spelled differently, so it is rewired (above).
  const same = plan({ base: { value: 'http://127.0.0.1:4141/', source: 'user' }, upstreamNow: 'https://gw.corp' })
  expect(same.kind === 'stop' && same.text.startsWith(`Already set up: ANTHROPIC_BASE_URL → ${ROUTER}`)).toBe(true)
  expect(plan({ base: { value: 'http://127.0.0.1:4000', source: 'user' }, upstreamNow: undefined, configPath: 'C' })).toEqual({
    kind: 'stop',
    text: 'ANTHROPIC_BASE_URL already points at a local router (http://127.0.0.1:4000) and no upstream is saved; set "upstream" in C by hand, then run /router setup again.',
  })
  // https on loopback and plain remote http are upstreams.
  expect(plan({ base: { value: 'https://localhost:9', source: 'user' } })).toMatchObject({ kind: 'proceed', isUpstreamSaved: true })
  expect(plan({ base: { value: 'http://gw.corp', source: 'user' } })).toMatchObject({ kind: 'proceed', isUpstreamSaved: true })
})

test('planSetup: a stale backup is overwritten when the base is not a router', () => {
  expect(plan()).toMatchObject({ kind: 'proceed', isBackupWritten: true })
  expect(plan({ base: { value: undefined, source: 'none' } })).toMatchObject({ isBackupWritten: true })
})

test('restoreSettings keeps headers the user added since, and restores an empty original', () => {
  const backup: Backup = { version: 1, baseUrl: null, source: 'none', customHeaders: 'X-Corp: a', at: 'T' }
  const changed = restoreSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\nX-New: n\nx-router-token: t' } }, backup)
  expect(JSON.parse(changed.text).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Corp: a\nX-New: n')
  const added = restoreSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-New: n\nx-router-token: t' } }, { ...backup, customHeaders: null })
  expect(JSON.parse(added.text).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-New: n')
  const empty = restoreSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: t' } }, { ...backup, customHeaders: '' })
  expect(JSON.parse(empty.text).env.ANTHROPIC_CUSTOM_HEADERS).toBe('')
  const none = restoreSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: 'x-router-token: t' } }, { ...backup, customHeaders: null })
  expect(JSON.parse(none.text)).toEqual({})
})

test('parseBackup accepts only the backup shape', () => {
  const ok = { version: 1, baseUrl: null, source: 'user', customHeaders: '', at: 'T' }
  expect(parseBackup(JSON.stringify(ok))).toEqual(ok)
  expect(parseBackup('null')).toBe(null)
  expect(parseBackup('[]')).toBe(null)
  expect(parseBackup('{')).toBe(null)
  expect(parseBackup(JSON.stringify({ ...ok, source: 'nowhere' }))).toBe(null)
  expect(parseBackup(JSON.stringify({ ...ok, baseUrl: 5 }))).toBe(null)
  expect(parseBackup(JSON.stringify({ ...ok, customHeaders: {} }))).toBe(null)
})

test('setup leaves an unreadable settings.json and every other file alone', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { theme: 'dark', env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  w.unreadable.add(USER_SETTINGS)
  await start($)
  const before = snapshot(w)
  const text = (await run($, 'router', 'setup')).text
  expect(text).toBe(`Could not read ${USER_SETTINGS}; nothing was changed. Check that no other plugin blocks reading it, then run /router setup again.`)
  expect(snapshot(w)).toBe(before)
})

test('uninstall leaves an unreadable settings.json and the backup alone', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { theme: 'dark', env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  await start($)
  await run($, 'router', 'setup')
  w.unreadable.add(USER_SETTINGS)
  const before = snapshot(w)
  const text = (await run($, 'router', 'uninstall')).text
  expect(text).toBe(`Could not read ${USER_SETTINGS}; nothing was changed. Check that no other plugin blocks reading it, then run /router uninstall again.`)
  expect(snapshot(w)).toBe(before)
})

test('a router on another port is rewired, keeping the upstream and the backup', async ($, on) => {
  const w = unwired(on, { config: { version: 1, providers: [], overrides: {}, upstream: 'https://gw.corp' } })
  userSettings(w, { theme: 'dark', env: { ANTHROPIC_BASE_URL: 'http://localhost:4000/', ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\nx-router-token: old' } })
  w.files.set(BACKUP, 'KEEP')
  await start($)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text).toContain(`✓ rewired ANTHROPIC_BASE_URL from http://localhost:4000/ to ${ROUTER}; upstream unchanged (https://gw.corp)`)
  expect(readJson(w, CONFIG).upstream).toBe('https://gw.corp')
  expect(w.files.get(BACKUP)).toBe('KEEP')
  expect(readJson(w, USER_SETTINGS)).toEqual({ theme: 'dark', env: { ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\nx-router-token: tok-1' } })
})

test('a local router with no saved upstream stops and writes nothing', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' } })
  await start($)
  const before = snapshot(w)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text).toContain('already points at a local router (http://127.0.0.1:4000) and no upstream is saved')
  expect(snapshot(w)).toBe(before)
})

test('a stale backup (setup undone by hand) is replaced with the current values', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { env: { ANTHROPIC_BASE_URL: 'https://gw.new' } })
  w.files.set(BACKUP, JSON.stringify({ version: 1, baseUrl: 'https://gw.old', source: 'user', customHeaders: null, at: 'old' }))
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, BACKUP)).toMatchObject({ baseUrl: 'https://gw.new', source: 'user' })
})

test('a failed settings write reports what was done and what was not', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { theme: 'dark', env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  w.tool = (sub, args) => (sub === 'write' && args[0] === USER_SETTINGS ? { ok: false, error: 'EACCES' } : undefined)
  await start($)
  const before = w.files.get(USER_SETTINGS)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text).toContain('✓ upstream = https://gw.corp')
  expect(text).toContain('✓ original values backed up')
  expect(text).toContain(`✗ could not write ${USER_SETTINGS}: EACCES — ${USER_SETTINGS} is unchanged; run /router setup again`)
  expect(w.files.get(USER_SETTINGS)).toBe(before)
})

test('a symlinked settings.json is written where it lands', async ($, on) => {
  const w = unwired(on, { config: null })
  const real = 'C:/dotfiles/settings.json'
  userSettings(w, { theme: 'dark' })
  w.realPaths.set(USER_SETTINGS, real)
  await start($)
  await run($, 'router', 'setup')
  expect(JSON.parse(w.files.get(real)!).theme).toBe('dark')
  expect(w.files.get(USER_SETTINGS)).toBe(JSON.stringify({ theme: 'dark' }, null, 2))
})

test('uninstall with a malformed backup changes nothing', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { theme: 'dark' })
  w.files.set(BACKUP, JSON.stringify({ version: 1, baseUrl: 5, source: 'user' }))
  await start($)
  const before = snapshot(w)
  const text = (await run($, 'router', 'uninstall')).text
  expect(text).toBe(`The setup backup at ${BACKUP} is not valid; nothing was changed. Restore ANTHROPIC_BASE_URL by hand.`)
  expect(snapshot(w)).toBe(before)
})

test('restoreSettings removes headers setup copied from the OS env, keeps ones added since', () => {
  const backup: Backup = { version: 1, baseUrl: null, source: 'none', customHeaders: null, writtenHeaders: 'X-Corp: a', at: 'T' }
  expect(JSON.parse(restoreSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\nx-router-token: t' } }, backup).text)).toEqual({})
  expect(JSON.parse(restoreSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\nX-New: n\nx-router-token: t' } }, backup).text).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Corp: a\nX-New: n')
  // An older backup without writtenHeaders compares against customHeaders.
  const old: Backup = { version: 1, baseUrl: null, source: 'none', customHeaders: 'X-Corp: a', at: 'T' }
  expect(JSON.parse(restoreSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a\nx-router-token: t' } }, old).text).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Corp: a')
  expect(parseBackup(JSON.stringify({ ...old, writtenHeaders: 5 }))).toBe(null)
  expect(parseBackup(JSON.stringify(old))).toEqual(old)
})

test('headers that came from the OS env are not left behind in settings.json by uninstall', async ($, on) => {
  const w = unwired(on, { config: null, env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Corp: a' } })
  userSettings(w, null)
  await start($)
  await run($, 'router', 'setup')
  expect(readJson(w, USER_SETTINGS).env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Corp: a\nx-router-token: tok-1')
  await run($, 'router', 'uninstall')
  expect('ANTHROPIC_CUSTOM_HEADERS' in (readJson(w, USER_SETTINGS).env ?? {})).toBe(false)
})

test('a settings.json that exists but cannot be resolved is not written', async ($, on) => {
  const w = unwired(on, { config: null })
  userSettings(w, { theme: 'dark', env: { ANTHROPIC_BASE_URL: 'https://gw.corp' } })
  w.unstatable.add(USER_SETTINGS)
  await start($)
  const before = w.files.get(USER_SETTINGS)
  const text = (await run($, 'router', 'setup')).text ?? ''
  expect(text).toContain(`✗ could not resolve ${USER_SETTINGS} — settings.json unchanged; run /router setup again`)
  expect(w.files.get(USER_SETTINGS)).toBe(before)
})
