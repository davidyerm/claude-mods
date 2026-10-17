import type { Register } from 'claude-code'
import { parseRouterArgs, runRouterCommand } from './commands'
import { registerWizard } from './add'
import { ambiguousText, findModel, loadConfig, pickedText, portOf, saveDefaultMainModel, unsavedClearText } from './config'
import { ensureRouter } from './lifecycle'
import { health, newMonitor, refresh, reprobe, tick } from './monitor'
import { getPaths } from './paths'
import { openPicker, registerPicker } from './picker'
import { isWiredTo } from './client'
import { clearPick, getPick, isRoutable, isStarted, markStarted, NOT_ACTIVE_TEXT, setPick, wireModel } from './pick'
import { ROUTED_PREFIX } from '../router/lib/resolve.mjs'

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
    const loaded = await loadConfig($, await getPaths($))
    const { config } = loaded
    m.port = portOf(loaded)
    m.isWired = isWiredTo(await $.env.get('ANTHROPIC_BASE_URL'), m.port)
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
    // $.state outlives a hot reload; the default applies once per session. An
    // unwired session leaves it unused, so the start after setup applies it.
    if (m.isWired && !(await isStarted($))) {
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
    if (!m.isWired || e.agentId !== undefined || pick === null || e.model.startsWith(ROUTED_PREFIX) || !isRoutable(m.status, pick)) return yield* next(e)
    return yield* next({ ...e, model: wireModel(pick, e.model) })
  })

  // The built-in /model, taken over (D15). A bug here must never break /model,
  // so the .catch hands the command to the built-in one.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'model-router') return next(e)
    const args = e.args.trim()
    if (args === '') return takeOver ? openPicker($, m, 'model') : next(e)
    const paths = await getPaths($)
    const { config } = await loadConfig($, paths)
    const match = findModel(config, args)
    if (match.kind === 'one') {
      if (!m.isWired) return { text: NOT_ACTIVE_TEXT }
      await setPick($, match.ref)
      // A /model pick is also the default for new sessions, as the built-in's is.
      const saveError = await saveDefaultMainModel($, paths, match.ref)
      await reprobe($, m)
      await refresh($, m)
      return { text: `${pickedText(match.ref, saveError)}${takeOver ? '' : '\ntip: use /router'}` }
    }
    if (match.kind === 'ambiguous') return { text: ambiguousText(args, match.refs) }
    await clearPick($)
    // A Claude pick: new sessions must not start routed against it.
    const clearError = unsavedClearText(await saveDefaultMainModel($, paths, null))
    if (clearError) await $.ui.toast(clearError)
    const result = await next(e)
    // A redraw failure after the built-in ran must not reach the .catch and replay /model.
    await refresh($, m).catch(() => {})
    return result
  }).catch(($, e, next) => next(e))
}
