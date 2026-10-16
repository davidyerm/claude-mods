#!/usr/bin/env node
// Headless end to end: claude -p with this plugin → the real router → a fake
// upstream (standing for the gateway) and a fake provider.
// Usage: node model-router/e2e/run.mjs   (CLAUDE_BIN overrides the claude executable)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closedPort, defaultHandler, jsonReply, sseToolUse, startFake } from '../router/test/fakes.mjs'
import { postShutdown } from '../router/lib/client.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LAUNCH = path.join(ROOT, 'router', 'launch.mjs')
const TOKEN = 'e2e-token'

function exec(command, args, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', err => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }))
    child.on('exit', code => resolve({ code, stdout, stderr }))
  })
}

const check = (isTrue, message) => { if (!isTrue) throw new Error(message) }
const messages = fake => fake.requests
  .filter(r => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'))
  .map(r => ({ ...r, json: JSON.parse(r.body) }))
const readEvents = home => {
  try { return fs.readFileSync(path.join(home, 'model-router', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) }
  catch { return [] }
}

async function scenario(name, { config = {}, upstreamHandler, providerHandler, prompt, verify }) {
  const upstream = await startFake(upstreamHandler ? { handler: upstreamHandler } : {})
  const provider = await startFake(providerHandler ? { handler: providerHandler } : {})
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-e2e-'))
  const port = await closedPort()
  fs.mkdirSync(path.join(home, 'model-router'), { recursive: true })
  fs.writeFileSync(path.join(home, 'model-router', 'token'), TOKEN)
  fs.writeFileSync(path.join(home, 'model-router.json'), JSON.stringify({
    version: 1,
    port,
    upstream: upstream.url,
    providers: [{ name: 'P', baseUrl: provider.url, apiKeyEnv: 'E2E_KEY', models: [{ id: 'fake-model' }] }],
    ...config,
  }, null, 2))
  const env = {
    ...process.env,
    MODEL_ROUTER_HOME: home,
    E2E_KEY: 'sk-e2e',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'dummy',
    ANTHROPIC_CUSTOM_HEADERS: `x-router-token: ${TOKEN}`,
  }
  delete env.ANTHROPIC_AUTH_TOKEN
  try {
    // Started first, so the engine's HEAD /api/hello (sent before session.start) finds it.
    const started = await exec(process.execPath, [LAUNCH, 'start'], env)
    check(started.code === 0, `router did not start: ${started.stdout}${started.stderr}`)
    const run = await exec(process.env.CLAUDE_BIN ?? 'claude', ['-p', prompt, '--plugin-dir', ROOT], env, home)
    check(run.code === 0, `claude -p exited ${run.code}: ${run.stderr.slice(0, 400)}`)
    verify({ run, upstream, provider, events: readEvents(home) })
    console.log(`PASS ${name}`)
    return true
  } catch (err) {
    console.log(`FAIL ${name}: ${err.message}`)
    return false
  } finally {
    await postShutdown(port, TOKEN)
    await upstream.close()
    await provider.close()
  }
}

const results = []

results.push(await scenario('routed main model', {
  config: { defaultMainModel: 'P/fake-model' },
  prompt: 'Say hi.',
  verify: ({ run, provider }) => {
    const sent = messages(provider)
    check(sent.some(r => r.json.model === 'fake-model'), `the provider saw no fake-model request (${sent.length} requests)`)
    check(sent.every(r => r.headers['x-api-key'] === 'sk-e2e' && !r.headers.authorization), 'the provider got gateway auth, or not its own key')
    check(run.stdout.includes('from fake-model'), `the answer did not come from the provider: ${run.stdout.slice(0, 200)}`)
  },
}))

results.push(await scenario('haiku subagent via override', {
  config: { overrides: { haiku: 'P/fake-model' } },
  prompt: 'E2E_AGENT: run exactly one subagent.',
  upstreamHandler: (req, res, body) => {
    const json = body ? JSON.parse(body) : {}
    const text = JSON.stringify(json.messages ?? [])
    const hasAgent = (json.tools ?? []).some(t => t.name === 'Agent')
    if (json.stream && hasAgent && text.includes('E2E_AGENT') && !text.includes('tool_result'))
      return sseToolUse(res, json.model, 'Agent', { description: 'e2e sub', prompt: 'Say sub-hi.', subagent_type: 'general-purpose', model: 'haiku' })
    return defaultHandler(req, res, body)
  },
  verify: ({ upstream, provider }) => {
    check(messages(upstream).some(r => JSON.stringify(r.json.messages).includes('E2E_AGENT')), 'the main loop did not stay on the upstream')
    check(messages(provider).some(r => JSON.stringify(r.json.messages).includes('Say sub-hi')), 'the haiku subagent did not reach the provider')
  },
}))

results.push(await scenario('provider failure falls back to Claude', {
  config: { defaultMainModel: 'P/fake-model' },
  providerHandler: (req, res) => jsonReply(res, 500, { error: { message: 'e2e boom' } }),
  prompt: 'Say hi.',
  verify: ({ run, events }) => {
    check(/from claude-/.test(run.stdout), `the fallback answer did not come from upstream: ${run.stdout.slice(0, 200)}`)
    check(events.some(e => e.kind === 'fallback' && e.status === 500 && e.text === 'e2e boom'), 'no fallback event with status 500')
  },
}))

process.exitCode = results.every(Boolean) ? 0 : 1
