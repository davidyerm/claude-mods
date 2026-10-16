import { expect, test } from 'claude-code/testing'
import { pathsFrom } from '../hooks/paths'
import { parseToolOut } from '../hooks/host'
import { HOME } from './world'

test('paths follow USERPROFILE', () => {
  const p = pathsFrom({ USERPROFILE: HOME })
  expect(p.config).toBe(`${HOME}/.claude/model-router.json`)
  expect(p.token).toBe(`${HOME}/.claude/model-router/token`)
  expect(p.userSettings).toBe(`${HOME}/.claude/settings.json`)
})

test('CLAUDE_CONFIG_DIR moves everything, MODEL_ROUTER_HOME moves only the router files', () => {
  const p = pathsFrom({ USERPROFILE: HOME, CLAUDE_CONFIG_DIR: 'D:/cc', MODEL_ROUTER_HOME: 'D:/mr' })
  expect(p.userSettings).toBe('D:/cc/settings.json')
  expect(p.config).toBe('D:/mr/model-router.json')
  expect(p.backup).toBe('D:/mr/model-router/setup-backup.json')
})

test('HOME is used when USERPROFILE is unset or empty', () => {
  expect(pathsFrom({ HOME: '/home/u' }).config).toBe('/home/u/.claude/model-router.json')
  expect(pathsFrom({ USERPROFILE: '', HOME: '/home/u', CLAUDE_CONFIG_DIR: '', MODEL_ROUTER_HOME: '' }).token).toBe('/home/u/.claude/model-router/token')
})

test('parseToolOut parses the last JSON line', () => {
  const out = parseToolOut({ exitCode: 0, stdout: 'starting\n{"ok":true,"pid":42}\n', stderr: '' })
  expect(out).toEqual({ ok: true, pid: 42 })
})

test('parseToolOut reports unparseable output as an error', () => {
  expect(parseToolOut({ exitCode: 3, stdout: 'not json', stderr: 'boom' })).toEqual({ ok: false, error: 'boom' })
})
