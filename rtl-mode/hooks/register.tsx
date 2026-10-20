import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { GUIDANCE, rtlText } from './rtl'

const STORE_KEY = 'isOn'
const ON_COLOR = '#17DD95'
const SECTION_ID = 'rtl-mode:guidance'

const isOn = atom({ plugin: 'rtl-mode', key: 'isOn' } as const, false)

// Writes the mode to the session's state (redrawing its readers) and to the
// store, so the next session starts the same way.
async function setMode($: EngineInterface, to: boolean | 'toggle'): Promise<boolean> {
  let value = false
  await update($, isOn, was => {
    value = to === 'toggle' ? !was : to
    return value
  })
  await $.store.set(STORE_KEY, value)
  return value
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get(STORE_KEY)) === true
    await update($, isOn, () => stored)
    await $.command.register({
      name: 'rtl',
      description: 'Toggle right-to-left display of Hebrew lines',
      argumentHint: '[on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'rtl' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Usage: /rtl [on|off]' }
    }
    const value = await setMode($, arg === '' ? 'toggle' : arg === 'on')
    return { text: `RTL mode ${value ? 'ON' : 'OFF'}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // The band is one instance for every plugin: the toggle goes above what the
    // hooks beneath drew (another mod's band, the engine's own), never in its place.
    const below = await next(e)
    const value = await read($, isOn)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Button key="rtl-toggle" plain onPress={() => setMode($, 'toggle')}>
            RTL{' '}
            {value ? <Text color={ON_COLOR}>ON</Text> : <Text dimColor>OFF</Text>}
          </Button>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const text = rtlText(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const text = rtlText(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isOn))) return composed
    return {
      sections: [
        ...composed.sections.filter(s => s.id !== SECTION_ID),
        { id: SECTION_ID, text: GUIDANCE, scope: 'session' as const },
      ],
    }
  })
}
