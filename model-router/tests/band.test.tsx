import { expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import { band, start, world } from './world'

// The band above the prompt is one instance for every plugin: each hook draws its
// own part and wraps what the hooks beneath drew, so no band hides another. The
// kit cannot load rtl-mode from here (outside this plugin's folder), so a stand-in
// draws its band the way rtl-mode does.
const OTHER: Plugin = {
  name: 'other-band',
  register: on => {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      if (e.props.hasSurvey) return next(e)
      const below = await next(e)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>OTHER BAND</Text>
          {below}
        </Box>
      )
    })
  },
}

const LINE = 'router: /router to pick \u00b7 haiku\u2192[DS] ds-chat'

test('with another band plugin loaded, both bands show, and the engine node once', { plugins: [OTHER] }, async ($, on) => {
  world(on)
  await start($)
  const text = await band($)
  expect(text).toContain(LINE)
  expect(text).toContain('OTHER BAND')
})

test('with a problem, only the other band shows', { plugins: [OTHER] }, async ($, on) => {
  const w = world(on, { env: { ANTHROPIC_BASE_URL: undefined } })
  await start($)
  expect(await band($)).toBe('OTHER BAND')
  expect(w.statusLines.at(-1)).toBe('router: not active \u2014 /router setup, then restart Claude Code')
})

test('a survey holds the band: neither plugin draws there', { plugins: [OTHER] }, async ($, on) => {
  world(on)
  await start($)
  expect(await band($, { hasSurvey: true })).toBe(null)
})
