import type { Register } from 'claude-code'
import { parseRouterArgs, runRouterCommand } from './commands'
import { registerWizard } from './add'
import { ambiguousText, display, findModel, loadConfig } from './config'
import { ensureRouter } from './lifecycle'
import { health, newMonitor, refresh, tick } from './monitor'
import { getPaths } from './paths'
import { openPicker, registerPicker } from './picker'
import { clearPick, getPick, isRoutable, isStarted, markStarted, ROUTED_PREFIX, setPick, wireModel } from './pick'

export const register: Register = (on, options) => {
  const m = newMonitor()
  const takeOver = options.takeOverModelCommand !== false
  registerPicker(on, m)
  registerWizard(on, m)

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

  // The built-in /model, taken over (D15). A bug here must never break /model,
  // so the .catch hands the command to the built-in one.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'model-router') return next(e)
    const args = e.args.trim()
    if (args === '') return takeOver ? openPicker($, m, 'model') : next(e)
    const { config } = await loadConfig($, await getPaths($))
    const match = findModel(config, args)
    if (match.kind === 'one') {
      await setPick($, match.ref)
      await refresh($, m)
      return { text: `Main model: ${display(match.ref)}${takeOver ? '' : '\ntip: use /router'}` }
    }
    if (match.kind === 'ambiguous') return { text: ambiguousText(args, match.refs) }
    await clearPick($)
    const result = await next(e)
    // A redraw failure after the built-in ran must not reach the .catch and replay /model.
    await refresh($, m).catch(() => {})
    return result
  }).catch(($, e, next) => next(e))
}
