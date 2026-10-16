import { expect, test } from 'claude-code/testing'
import { probeOf } from '../hooks/client'
import { decideEnsure, finishEnsure } from '../hooks/lifecycle'
import { VERSION } from '../router/version.mjs'
import { routerStatus } from './world'

test('probeOf tells ours, foreign and down apart', () => {
  expect(probeOf({ ok: true, status: 200, json: routerStatus() }).kind).toBe('ours')
  expect(probeOf({ ok: true, status: 200, json: { hello: 'world' } }).kind).toBe('foreign')
  expect(probeOf({ ok: true, status: 200, json: null }).kind).toBe('foreign')
  const gone = probeOf({ ok: false, reason: 'Error: connect ECONNREFUSED' })
  expect(gone.kind).toBe('down')
  expect(gone.kind === 'down' && gone.reason.includes('ECONNREFUSED')).toBe(true)
})

test('a running router of this version is reused without launching', () => {
  const status = routerStatus()
  expect(decideEnsure({ kind: 'ours', status }, 4141, VERSION, false)).toEqual({ action: 'reuse', status })
})

test('a down router is launched through start', () => {
  expect(decideEnsure({ kind: 'down', reason: 'x' }, 4141, VERSION, false)).toEqual({ action: 'launch', args: ['start'] })
})

test('another version is handed to the launcher (which drains and replaces it)', () => {
  const old = routerStatus({ version: '0.0.9' })
  expect(decideEnsure({ kind: 'ours', status: old }, 4141, VERSION, false)).toEqual({ action: 'launch', args: ['start'] })
  const fresh = routerStatus()
  expect(finishEnsure({ ok: true, started: true }, { kind: 'ours', status: fresh })).toEqual({ ok: true, status: fresh, started: true })
})

test('a foreign port is reported without launching; a failed launch reports the launcher error', () => {
  expect(decideEnsure({ kind: 'foreign' }, 4141, VERSION, false)).toEqual({ action: 'foreign', reason: 'port 4141 is used by another program; set "port" in model-router.json' })
  expect(finishEnsure({ ok: false, error: 'EACCES' }, { kind: 'down', reason: '' })).toEqual({ ok: false, reason: 'EACCES' })
  expect(finishEnsure({ ok: true }, { kind: 'down', reason: 'ECONNREFUSED' })).toEqual({ ok: false, reason: 'ECONNREFUSED' })
  expect(finishEnsure({ ok: true }, { kind: 'foreign' })).toEqual({ ok: false, reason: 'the port answered, but not as model-router' })
})

test('force asks the launcher to replace the running router', () => {
  const status = routerStatus()
  expect(decideEnsure({ kind: 'ours', status }, 4141, VERSION, true)).toEqual({ action: 'launch', args: ['start', '--force'] })
})
