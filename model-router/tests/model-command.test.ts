import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { PICKER_PANE } from '../hooks/picker'
import { ambiguousText } from '../hooks/config'
import { CONFIG, CONFIG_JSON, PANE_PROPS, readJson, run, start, step, world } from './world'

const OFF = { options: { takeOverModelCommand: false } }
const fromPlugin = ($: Engine, args: string) =>
  $.command.run({ command: 'model', args, origin: { kind: 'plugin', name: 'model-router' }, presentation: { isFullscreen: false, columns: 120 } })

test('on: bare /model opens the unified picker, not the built-in one', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'model')
  expect(w.opened).toEqual([PICKER_PANE])
  expect(w.commands).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as RenderSurface[]) {
  test(`on: the /model pane draws in model mode on ${surface}`, async ($, on) => {
    world(on)
    await start($)
    await run($, 'model')
    const tree = JSON.stringify(await $.ui.render({ surface, component: 'Pane', requestId: PICKER_PANE, props: { ...PANE_PROPS } }))
    expect(tree).toContain('[DS] ds-chat')
    expect(tree).toContain('manage: /router')
    expect(tree).not.toContain('Override a Claude family…')
  })
}

test('on: /model <routed name> sets the pick', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'model', 'DS/ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner (also the default for new sessions)')
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:DS/ds-reasoner#claude-opus-5-5')
})

test('on: an ambiguous bare id lists the candidates', async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'model', 'ds-chat')).text).toBe(ambiguousText('ds-chat', ['DS/ds-chat', 'OR/ds-chat']))
})

test('on: anything else clears the pick and reaches the built-in /model', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  expect((await run($, 'model', 'sonnet')).text).toBe('built-in /model sonnet')
  expect(w.commands).toEqual([{ command: 'model', args: 'sonnet', origin: 'composer' }])
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
})

test('runs that model-router makes itself go straight to the built-in /model', async ($, on) => {
  const w = world(on)
  await start($)
  await fromPlugin($, '')
  expect(w.commands).toEqual([{ command: 'model', args: '', origin: 'plugin' }])
  expect(w.opened).toEqual([])
})

test('off: bare /model is the stock one', OFF, async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'model')
  expect(w.commands).toEqual([{ command: 'model', args: '', origin: 'composer' }])
  expect(w.opened).toEqual([])
})

test('off: /model <routed name> still switches, with a tip', OFF, async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'model', 'DS/ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner (also the default for new sessions)\ntip: use /router')
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:DS/ds-reasoner#claude-opus-5-5')
})

test('off: an ambiguous bare id lists the candidates', OFF, async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'model', 'ds-chat')).text).toBe(ambiguousText('ds-chat', ['DS/ds-chat', 'OR/ds-chat']))
})

test('off: anything else clears the pick and reaches the built-in /model', OFF, async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  expect((await run($, 'model', 'sonnet')).text).toBe('built-in /model sonnet')
  expect(w.commands).toEqual([{ command: 'model', args: 'sonnet', origin: 'composer' }])
  await step($)
  expect(w.stepModels.at(-1)).toBe('claude-opus-5-5')
})

test('a plugin-origin run with args goes to the built-in unchanged and leaves the pick', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'router', 'DS/ds-chat')
  expect((await fromPlugin($, 'sonnet')).text).toBe('built-in /model sonnet')
  expect(w.commands).toEqual([{ command: 'model', args: 'sonnet', origin: 'plugin' }])
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:DS/ds-chat#claude-opus-5-5')
})

test('a failing hook falls back to the built-in /model', async ($, on) => {
  const w = world(on)
  await start($)
  w.failSessionModel = true
  await run($, 'model', 'DS/ds-reasoner')
  expect(w.commands).toEqual([{ command: 'model', args: 'DS/ds-reasoner', origin: 'composer' }])
})

// -- picks made through /model persist as the default (picker-v2 brief, part B) --

const WITH_DEFAULT = { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } }
const drawPane = ($: Engine) => $.ui.render({ surface: 'terminal', component: 'Pane', requestId: PICKER_PANE, props: { ...PANE_PROPS } })
async function press($: Engine, value: string) {
  await drawPane($)
  await $.ui.press({ plugin: 'model-router', key: value, surface: 'terminal' })
}

test('/model DS/ds-chat writes defaultMainModel', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'model', 'DS/ds-chat')).text).toBe('Main model: [DS] ds-chat (also the default for new sessions)')
  expect(readJson(w, CONFIG).defaultMainModel).toBe('DS/ds-chat')
})

test('choosing a routed entry in the /model picker writes defaultMainModel', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'model')
  await press($, 'routed:OR/anthropic/claude-x')
  expect(readJson(w, CONFIG).defaultMainModel).toBe('OR/anthropic/claude-x')
  expect(w.toasts.at(-1)).toBe('Main model: [OR] anthropic/claude-x (also the default for new sessions)')
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:OR/anthropic/claude-x#claude-opus-5-5')
})

test('choosing a Claude alias in the /model picker removes defaultMainModel', async ($, on) => {
  const w = world(on, WITH_DEFAULT)
  await start($)
  await run($, 'model')
  await press($, 'claude:sonnet')
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
  expect(w.commands).toEqual([{ command: 'model', args: 'sonnet', origin: 'plugin' }])
})

test('/model with anything else removes defaultMainModel and reaches the built-in', async ($, on) => {
  const w = world(on, WITH_DEFAULT)
  await start($)
  expect((await run($, 'model', 'sonnet')).text).toBe('built-in /model sonnet')
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
})

test('a Claude model picked in the built-in picker (the 2 s tick) removes defaultMainModel', async ($, on) => {
  const w = world(on, WITH_DEFAULT)
  await start($)
  w.model = 'claude-sonnet-5-5'
  await w.clock.advance(2000)
  expect(w.toasts).toContain('Main model back to Claude (claude-sonnet-5-5 picked in /model)')
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
})

test('/router DS/ds-chat and the /router picker stay session-only', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await run($, 'router', 'DS/ds-chat')).text).toBe('Main model: [DS] ds-chat')
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
  await run($, 'router')
  await press($, 'routed:OR/ds-chat')
  expect(w.toasts.at(-1)).toBe('Main model: [OR] ds-chat')
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
})

test('a Claude pick in the /router picker leaves defaultMainModel alone', async ($, on) => {
  const w = world(on, WITH_DEFAULT)
  await start($)
  await run($, 'router')
  await press($, 'claude:sonnet')
  expect(readJson(w, CONFIG).defaultMainModel).toBe('DS/ds-chat')
})

test('when the default cannot be saved the pick stays and the reason is shown', async ($, on) => {
  const w = world(on)
  await start($)
  w.tool = sub => (sub === 'write' ? { ok: false, error: 'disk full' } : undefined)
  expect((await run($, 'model', 'DS/ds-chat')).text).toBe(`Main model: [DS] ds-chat (could not save as default: could not write ${CONFIG}: disk full)`)
  expect(readJson(w, CONFIG).defaultMainModel).toBe(undefined)
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:DS/ds-chat#claude-opus-5-5')
  await run($, 'model')
  await press($, 'routed:OR/ds-chat')
  expect(w.toasts.at(-1)).toBe(`Main model: [OR] ds-chat (could not save as default: could not write ${CONFIG}: disk full)`)
  await step($)
  expect(w.stepModels.at(-1)).toBe('router:OR/ds-chat#claude-opus-5-5')
})
