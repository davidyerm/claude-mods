import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const rtl = ($: Engine, args: string) =>
  $.command.run({
    command: 'rtl',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const BAND = {
  plugin: 'rtl-mode',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

test('/rtl on, off and bare toggle the mode', async ($, on) => {
  mock.store(on)
  expect((await rtl($, 'on')).text).toBe('RTL mode ON')
  expect((await rtl($, 'off')).text).toBe('RTL mode OFF')
  expect((await rtl($, '')).text).toBe('RTL mode ON')
  expect((await rtl($, 'sideways')).text).toBe(
    'Usage: /rtl [on|off]',
  )
})

test('the band shows the mode and a press toggles it', async ($, on) => {
  mock.store(on)
  // The engine's own band beneath the plugins: the toggle is drawn above it.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(JSON.stringify(await ui.drawn()).split('"type":"engine"').length - 1).toBe(1)
    const before = (await ui.find({ key: 'rtl-toggle' }))?.text ?? ''
    await ui.press({ key: 'rtl-toggle' })
    const after = (await ui.find({ key: 'rtl-toggle' }))?.text ?? ''
    expect([before, after].sort()).toEqual(['RTL OFF', 'RTL ON'])
    await ui.unmount()
  }
})

test('messages are rewritten for display only while the mode is on', async ($, on) => {
  mock.store(on)
  let drawn = ''
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    drawn = e.props.text
    return { type: 'engine', ref: 0 }
  })
  const draw = () =>
    $.ui.render({
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'm1',
      props: { text: '## כותרת', isFirstOfReply: true },
    })

  await rtl($, 'off')
  await draw()
  expect(drawn).toBe('## כותרת')

  await rtl($, 'on')
  await draw()
  expect(drawn).toBe('## ‏‫כותרת')
})

test('the system prompt gains the guidance only while the mode is on', async ($, on) => {
  mock.store(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))

  await rtl($, 'off')
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])

  await rtl($, 'on')
  const sections = (await $.prompt.compose(COMPOSE)).sections
  expect(sections.map(s => s.id)).toEqual(['intro', 'rtl-mode:guidance'])
  expect(sections[1]?.text).toContain('backticks')
})
