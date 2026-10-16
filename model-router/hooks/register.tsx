import type { Register } from 'claude-code'
import { parseRouterArgs, runRouterCommand } from './commands'
import { loadConfig } from './config'
import { ensureRouter } from './lifecycle'
import { health, newMonitor, refresh, tick } from './monitor'
import { getPaths } from './paths'
import { registerPicker } from './picker'
import { getPick, isRoutable, isStarted, markStarted, ROUTED_PREFIX, setPick, wireModel } from './pick'

export const register: Register = on => {
  const m = newMonitor()
  registerPicker(on, m)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Pick, override and manage models from other providers (model-router)',
      argumentHint: '[model|claude|default|override|add|remove|setup|uninstall|doctor|forget|restart]',
    })
    const { config } = await loadConfig($, await getPaths($))
    m.port = config.port
    const ensured = await ensureRouter($, m.port)
    if (ensured.ok) {
      m.status = ensured.status
      m.lastSeq = ensured.status.eventsSeq
      m.isDown = false
    } else {
      m.isDown = true
      m.status = null
      $.ui.log(`model-router: ${ensured.reason}`, { to: 'debug' })
    }
    // $.state outlives a hot reload; the default applies once per session.
    if (!(await isStarted($))) {
      await markStarted($)
      if (config.defaultMainModel) await setPick($, config.defaultMainModel)
    }
    await refresh($, m)
    $.clock.every(2_000, () => void tick($, m))
    $.clock.every(10_000, () => void health($, m))
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => runRouterCommand($, m, parseRouterArgs(e.args)))

  on('turn.step', async function* ($, e, next) {
    const pick = await getPick($)
    if (e.agentId !== undefined || pick === null || e.model.startsWith(ROUTED_PREFIX) || !isRoutable(m.status, pick)) return yield* next(e)
    return yield* next({ ...e, model: wireModel(pick, e.model) })
  })
}
