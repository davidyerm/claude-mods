// THROWAWAY: V3 launcher. Spawns a detached child that serves :4198 until /quit.
import { spawn } from 'node:child_process'
import http from 'node:http'

if (process.argv[2] === 'child') {
  const server = http.createServer((req, res) => {
    res.end(`alive pid=${process.pid}\n`)
    if (req.url === '/quit') server.close(() => process.exit(0))
  })
  server.listen(4198, '127.0.0.1')
} else {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'child'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  console.log(`spawned pid=${child.pid}`)
}
