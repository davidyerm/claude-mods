import type { CommandRunResult, EngineInterface } from 'claude-code'
import { allRefs, FAMILIES, parseRef } from '../router/lib/schema.mjs'
import type { Family } from '../router/lib/schema.mjs'
import { openWizard } from './add'
import { postForget } from './client'
import { ambiguousText, display, findModel, loadConfig, modelList, updateConfig } from './config'
import type { Match } from './config'
import { readText } from './host'
import { ensureRouter } from './lifecycle'
import { refresh } from './monitor'
import type { Monitor } from './monitor'
import { getPaths } from './paths'
import { clearPick, setPick } from './pick'
import { openPicker } from './picker'

export type RouterCommand =
  | { kind: 'picker' }
  | { kind: 'pick'; name: string }
  | { kind: 'claude' }
  | { kind: 'default'; name: string | null }
  | { kind: 'override'; family: Family; name: string | null }
  | { kind: 'add' }
  | { kind: 'remove'; target: string }
  | { kind: 'setup' }
  | { kind: 'uninstall' }
  | { kind: 'doctor'; isOffline: boolean }
  | { kind: 'forget'; target: string }
  | { kind: 'restart' }
  | { kind: 'usage'; text: string }

const usage = (form: string): RouterCommand => ({ kind: 'usage', text: `Usage: ${form}` })

export function parseRouterArgs(args: string): RouterCommand {
  const [head, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (head === undefined) return { kind: 'picker' }
  const bare = (cmd: RouterCommand, form: string) => (rest.length === 0 ? cmd : usage(form))
  switch (head) {
    case 'claude': return bare({ kind: 'claude' }, '/router claude')
    case 'add': return bare({ kind: 'add' }, '/router add')
    case 'setup': return bare({ kind: 'setup' }, '/router setup')
    case 'uninstall': return bare({ kind: 'uninstall' }, '/router uninstall')
    case 'restart': return bare({ kind: 'restart' }, '/router restart')
    case 'doctor':
      if (rest.length === 0) return { kind: 'doctor', isOffline: false }
      return rest.length === 1 && rest[0] === '--offline' ? { kind: 'doctor', isOffline: true } : usage('/router doctor [--offline]')
    case 'default':
      return rest.length === 1 ? { kind: 'default', name: rest[0] === 'clear' ? null : rest[0]! } : usage('/router default <model|clear>')
    case 'override': {
      const [family, name] = rest
      if (rest.length !== 2 || !FAMILIES.includes(family as Family)) return usage('/router override <haiku|sonnet|opus|fable> <model|clear>')
      return { kind: 'override', family: family as Family, name: name === 'clear' ? null : name! }
    }
    case 'remove': return rest.length === 1 ? { kind: 'remove', target: rest[0]! } : usage('/router remove <provider|provider/model>')
    case 'forget': return rest.length === 1 ? { kind: 'forget', target: rest[0]! } : usage('/router forget <provider/model|all>')
    default: return rest.length === 0 ? { kind: 'pick', name: head } : usage('/router <model>')
  }
}

function notOne(name: string, match: Match, list: string): string {
  return match.kind === 'ambiguous' ? ambiguousText(name, match.refs) : `Unknown model "${name}". Models: ${list}`
}

// Kinds whose modules land in later tasks (setup/uninstall 27, doctor 28).
const notYet = (kind: string): CommandRunResult => ({ text: `/router ${kind} is not available in this build yet` })

export async function runRouterCommand($: EngineInterface, m: Monitor, cmd: RouterCommand): Promise<CommandRunResult> {
  const paths = await getPaths($)
  const { config } = await loadConfig($, paths)
  switch (cmd.kind) {
    case 'usage': return { text: cmd.text }
    case 'picker': return openPicker($, m, 'router')
    case 'add': return openWizard($)
    case 'setup':
    case 'uninstall':
    case 'doctor':
      return notYet(cmd.kind)
    case 'claude':
      await clearPick($)
      await refresh($, m)
      return { text: "Main model: Claude (this session's model)" }
    case 'pick': {
      const match = findModel(config, cmd.name)
      if (match.kind !== 'one') return { text: notOne(cmd.name, match, modelList(config)) }
      await setPick($, match.ref)
      await refresh($, m)
      return { text: `Main model: ${display(match.ref)}` }
    }
    case 'default': {
      let ref: string | null = null
      if (cmd.name !== null) {
        const match = findModel(config, cmd.name)
        if (match.kind !== 'one') return { text: notOne(cmd.name, match, modelList(config)) }
        ref = match.ref
      }
      const r = await updateConfig($, paths, raw => { if (ref === null) delete raw.defaultMainModel; else raw.defaultMainModel = ref })
      if (!r.ok) return { text: r.message }
      return { text: ref === null ? 'Default main model cleared: new sessions start on Claude.' : `Default main model for new sessions: ${display(ref)}` }
    }
    case 'override': {
      let ref: string | null = null
      if (cmd.name !== null) {
        const match = findModel(config, cmd.name)
        if (match.kind !== 'one') return { text: notOne(cmd.name, match, modelList(config)) }
        ref = match.ref
      }
      const r = await updateConfig($, paths, raw => {
        const overrides = { ...(raw.overrides ?? {}) }
        if (ref === null) delete overrides[cmd.family]
        else overrides[cmd.family] = ref
        raw.overrides = overrides
      })
      if (!r.ok) return { text: r.message }
      await refresh($, m)
      return { text: ref === null ? `${cmd.family} → Claude (override cleared)` : `${cmd.family} → ${display(ref)} (all sessions, from the next request)` }
    }
    case 'remove': {
      const isModel = cmd.target.includes('/')
      const removed = allRefs(config).filter(r => (isModel ? r === cmd.target : parseRef(r)?.provider === cmd.target))
      if (removed.length === 0) return { text: `Nothing named "${cmd.target}". Models: ${modelList(config)}` }
      const notes: string[] = []
      const r = await updateConfig($, paths, raw => {
        const target = parseRef(cmd.target)
        raw.providers = (raw.providers ?? []).flatMap(p => {
          if (!isModel) return p.name === cmd.target ? [] : [p]
          if (p.name !== target?.provider) return [p]
          const models = p.models.filter(x => x.id !== target.model)
          return models.length === 0 ? [] : [{ ...p, models }]
        })
        const overrides = { ...(raw.overrides ?? {}) }
        for (const [family, ref] of Object.entries(overrides)) {
          if (removed.includes(ref)) { delete overrides[family]; notes.push(`${family} override cleared (it pointed at ${display(ref)})`) }
        }
        raw.overrides = overrides
        if (raw.defaultMainModel && removed.includes(raw.defaultMainModel)) {
          notes.push(`default main model cleared (it was ${display(raw.defaultMainModel)})`)
          delete raw.defaultMainModel
        }
      })
      if (!r.ok) return { text: r.message }
      await refresh($, m)
      return { text: [`Removed ${removed.map(display).join(', ')}.`, ...notes.map(n => `⚠ ${n}`)].join('\n') }
    }
    case 'forget': {
      const token = (await readText($, paths.token))?.trim()
      if (!token) return { text: 'No router token yet: run /router setup first.' }
      const n = await postForget($, config.port, token, cmd.target)
      return { text: n === null ? 'The router did not answer: /router doctor' : `Forgot ${n} learned limit${n === 1 ? '' : 's'}.` }
    }
    case 'restart': {
      const r = await ensureRouter($, config.port, { force: true })
      if (r.ok) { m.status = r.status; m.lastSeq = r.status.eventsSeq; m.isDown = false }
      else { m.isDown = true; m.status = null }
      await refresh($, m)
      return { text: r.ok ? `model-router restarted (pid ${r.status.pid}). Learned limits start empty.` : `Restart failed: ${r.reason}` }
    }
  }
}
