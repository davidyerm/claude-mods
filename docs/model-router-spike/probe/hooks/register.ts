// THROWAWAY probe for V1, V3, V5, V6 (and V2 in an interactive session).
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'mr-probe: builtin | launch | settings' })
    $.ui.log(`mr-probe: V2 session id = ${await $.session.id()}`)
    let seen = await $.session.model()
    $.ui.log(`mr-probe: V5 session model at start = ${seen}`)
    $.clock.every(1000, async () => {
      const now = await $.session.model()
      if (now !== seen) { $.ui.log(`mr-probe: V5 session.model changed ${seen} -> ${now}`); seen = now }
    })
    return next(e)
  })

  // V1: can a command.run hook answer the built-in /model, and does next(e) still open the picker?
  on('command.run', { command: 'model' }, async ($, e, next) => {
    $.ui.log(`mr-probe: V1/V5 /model args=${JSON.stringify(e.args)} origin=${JSON.stringify(e.origin)}`)
    if (e.args.trim() === 'probe-answer') return { text: 'V1: answered by mr-probe' }
    const before = await $.session.model()
    const result = await next(e)
    $.ui.log(`mr-probe: V5 after next(e): model ${before} -> ${await $.session.model()}, result=${JSON.stringify(result)}`)
    return result
  })

  on('command.run', { command: 'probe' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'builtin') {
      // V1 second half: does $.command.run reach the built-in picker (skipping this plugin's own hook)?
      await $.command.run({ command: 'model' })
      return { text: 'V1: asked $.command.run({ command: "model" })' }
    }
    if (arg === 'launch') {
      // V3: a detached child started through a short-lived launcher.
      const started = await $.clock.now()
      const r = await $.process.run(['node', `${$.plugin.root}/detached.mjs`], { timeoutMs: 20_000 })
      return { text: `V3: launcher exit ${r.exitCode} after ${(await $.clock.now()) - started} ms: ${r.stdout.trim()} ${r.stderr.trim()}` }
    }
    if (arg === 'settings') {
      // V6: may the mod rewrite ~/.claude/settings.json? Rewrites identical text.
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
      const file = `${home}/.claude/settings.json`
      const text = await $.fs.read(file)
      try { await $.fs.write(file, text); return { text: `V6: $.fs.write OK on ${file}` } }
      catch (err) { return { text: `V6: $.fs.write refused: ${String(err)}` } }
    }
    return { text: 'usage: /probe builtin | launch | settings' }
  })
}
