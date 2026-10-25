import { expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import { band, CONFIG_JSON, start, world } from './world'

// model-router draws nothing above the prompt (2026-10-25), so another plugin's
// band shows as it is. The kit cannot load rtl-mode from here (outside this
// plugin's folder), so a stand-in draws its band the way rtl-mode does.
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

test('with another band plugin loaded, only its band shows', { plugins: [OTHER] }, async ($, on) => {
  world(on, { config: { ...CONFIG_JSON, defaultMainModel: 'DS/ds-chat' } })
  await start($)
  expect(await band($)).toBe('OTHER BAND')
})

test('with a problem, the status line carries it and only the other band shows', { plugins: [OTHER] }, async ($, on) => {
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
