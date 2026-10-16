#!/usr/bin/env node
// The router process. launch.mjs starts it detached. It exits on shutdown or
// idle, and quietly when another router already owns the port.
import { createRouter } from './lib/server.mjs'
import { getStatus } from './lib/client.mjs'
import { VERSION } from './version.mjs'

const router = createRouter()
router.onStopped(() => process.exit(0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void router.stop({ drain: true }))

try {
  const { port } = await router.start()
  console.log(`model-router ${VERSION} listening on 127.0.0.1:${port} (pid ${process.pid})`)
} catch (err) {
  if (err.code !== 'EADDRINUSE') throw err
  if ((await getStatus(err.port)).kind === 'ours') process.exit(0)
  console.error(`model-router: port ${err.port} is used by another program. Set "port" in ${router.paths.config} to a free port.`)
  process.exit(2)
}
