import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-test-'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

// Polls fn until it returns a truthy value; resolves that value, rejects on timeout.
export async function waitFor(fn, timeoutMs = 3000, everyMs = 20) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > until) throw new Error(`waitFor timed out after ${timeoutMs} ms`)
    await new Promise(r => setTimeout(r, everyMs))
  }
}
