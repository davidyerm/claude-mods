import { describe, expect, test } from 'claude-code/testing'
import { parseRouterArgs } from '../hooks/commands'
import { CONFIG, CONFIG_JSON, readJson, run, start, step, TOKEN_FILE, world } from './world'

describe('parseRouterArgs', () => {
  test('subcommands and their forms', () => {
    expect(parseRouterArgs('')).toEqual({ kind: 'picker' })
    expect(parseRouterArgs('  ')).toEqual({ kind: 'picker' })
    expect(parseRouterArgs('DS/ds-chat')).toEqual({ kind: 'pick', name: 'DS/ds-chat' })
    expect(parseRouterArgs('claude')).toEqual({ kind: 'claude' })
    expect(parseRouterArgs('default clear')).toEqual({ kind: 'default', name: null })
    expect(parseRouterArgs('default DS/ds-chat')).toEqual({ kind: 'default', name: 'DS/ds-chat' })
    expect(parseRouterArgs('override haiku clear')).toEqual({ kind: 'override', family: 'haiku', name: null })
    expect(parseRouterArgs('override sonnet OR/anthropic/claude-x')).toEqual({ kind: 'override', family: 'sonnet', name: 'OR/anthropic/claude-x' })
    expect(parseRouterArgs('remove DS')).toEqual({ kind: 'remove', target: 'DS' })
    expect(parseRouterArgs('doctor --offline')).toEqual({ kind: 'doctor', isOffline: true })
    expect(parseRouterArgs('forget all')).toEqual({ kind: 'forget', target: 'all' })
    expect(parseRouterArgs('restart')).toEqual({ kind: 'restart' })
  })

  test('a subcommand name beats a model of the same name', () => {
    expect(parseRouterArgs('doctor')).toEqual({ kind: 'doctor', isOffline: false })
    expect(parseRouterArgs('setup')).toEqual({ kind: 'setup' })
  })

  test('wrong forms answer with usage', () => {
    expect(parseRouterArgs('override gpt x')).toEqual({ kind: 'usage', text: 'Usage: /router override <haiku|sonnet|opus|fable> <model|clear>' })
    expect(parseRouterArgs('default')).toEqual({ kind: 'usage', text: 'Usage: /router default <model|clear>' })
    expect(parseRouterArgs('claude now')).toEqual({ kind: 'usage', text: 'Usage: /router claude' })
    expect(parseRouterArgs('a b')).toEqual({ kind: 'usage', text: 'Usage: /router <model>' })
  })
})

test('/router answers usage for a wrong form', async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'router', 'claude now')).text).toBe('Usage: /router claude')
})

test('kinds whose modules land later answer "not available in this build yet"', async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'router', 'add')).text).toBe('/router add is not available in this build yet')
  expect((await run($, 'router', 'setup')).text).toBe('/router setup is not available in this build yet')
  expect((await run($, 'router', 'uninstall')).text).toBe('/router uninstall is not available in this build yet')
  expect((await run($, 'router', 'doctor')).text).toBe('/router doctor is not available in this build yet')
})

test('/router <name> and /router claude set and clear the pick', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'router', 'ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner')
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:DS/ds-reasoner#claude-opus-5-5')
  expect(w.statusLines.at(-1)).toBe('main: [DS] ds-reasoner · haiku→[DS] ds-chat')
  expect((await run($, 'router', 'claude')).text).toBe("Main model: Claude (this session's model)")
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
  expect((await run($, 'router', 'nope')).text).toBe('Unknown model "nope". Models: DS/ds-chat, DS/ds-reasoner, OR/anthropic/claude-x, OR/ds-chat')
})

test('/router <bare id> that two providers share asks for Provider/model', async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'router', 'ds-chat')).text).toBe(['"ds-chat" matches several models:', '  DS/ds-chat', '  OR/ds-chat', 'Name one as Provider/model.'].join('\n'))
})

test('/router <name> with no config file lists no models', async ($, on) => {
  world(on, { config: null })
  await start($)
  expect((await run($, 'router', 'DS/ds-chat')).text).toBe('Unknown model "DS/ds-chat". Models: none yet — add a provider with /router add')
})

test('/router default writes the config through launch.mjs write', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'default DS/ds-chat')
  const write = w.runs.at(-1)!
  expect(write.argv.slice(2)).toEqual(['write', CONFIG])
  expect(JSON.parse(write.stdin!)).toEqual({ ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' })
})

test('/router default and override write the config', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'router', 'default DS/ds-chat')).text).toBe('Default main model for new sessions: [DS] ds-chat')
  expect(readJson(w, CONFIG).defaultMainModel).toBe('DS/ds-chat')
  expect((await run($, 'router', 'default clear')).text).toBe('Default main model cleared: new sessions start on Claude.')
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
  expect((await run($, 'router', 'override opus OR/anthropic/claude-x')).text).toBe('opus → [OR] anthropic/claude-x (all sessions, from the next request)')
  expect((await run($, 'router', 'override haiku clear')).text).toBe('haiku → Claude (override cleared)')
  expect(readJson(w, CONFIG).overrides).toEqual({ opus: 'OR/anthropic/claude-x' })
})

test('/router remove drops a model or a provider and clears what pointed at it', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'default DS/ds-chat')
  expect((await run($, 'router', 'remove DS/ds-chat')).text).toBe([
    'Removed [DS] ds-chat.',
    '⚠ haiku override cleared (it pointed at [DS] ds-chat)',
    '⚠ default main model cleared (it was [DS] ds-chat)',
  ].join('\n'))
  expect(readJson(w, CONFIG).providers[0].models).toEqual([{ id: 'ds-reasoner' }])
  expect((await run($, 'router', 'remove OR')).text).toBe('Removed [OR] anthropic/claude-x, [OR] ds-chat.')
  expect(readJson(w, CONFIG).providers.map((p: { name: string }) => p.name)).toEqual(['DS'])
  expect((await run($, 'router', 'remove Nobody')).text).toBe('Nothing named "Nobody". Models: DS/ds-reasoner')
})

test('/router forget sends the token; /router restart forces a new router', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'router', 'forget all')).text).toBe('No router token yet: run /router setup first.')
  w.files.set(TOKEN_FILE, 'tok-1\n')
  expect((await run($, 'router', 'forget all')).text).toBe('Forgot 1 learned limit.')
  expect(w.fetches.at(-1)!.headers['x-router-token']).toBe('tok-1')
  expect((await run($, 'router', 'restart')).text).toBe('model-router restarted (pid 42). Learned limits start empty.')
  expect(w.runs.at(-1)!.argv.slice(2)).toEqual(['start', '--force'])
})

test('a failed /router restart shows DOWN and stops routing the pick', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  w.tool = sub => (sub === 'start' ? { ok: false, error: 'node not found' } : undefined)
  expect((await run($, 'router', 'restart')).text).toStartWith('Restart failed: ')
  expect(w.statusLines.at(-1)).toBe('model-router DOWN — /router doctor')
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
})
