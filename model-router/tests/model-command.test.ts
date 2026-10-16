import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { PICKER_PANE } from '../hooks/picker'
import { ambiguousText } from '../hooks/config'
import { PANE_PROPS, run, start, step, world } from './world'

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
  expect((await run($, 'model', 'DS/ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner')
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
  expect((await run($, 'model', 'DS/ds-reasoner')).text).toBe('Main model: [DS] ds-reasoner\ntip: use /router')
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
