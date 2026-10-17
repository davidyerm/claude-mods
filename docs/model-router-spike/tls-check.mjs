// THROWAWAY: V4. Does node:https trust the gateway's certificate?
// Usage: node [--use-system-ca] tls-check.mjs <https-url>
import https from 'node:https'

const url = process.argv[2]
const req = https.request(url, { method: 'HEAD', timeout: 10_000 }, res => {
  console.log(JSON.stringify({ ok: true, status: res.statusCode, flags: process.execArgv }))
  res.resume()
})
req.on('timeout', () => req.destroy(new Error('timeout')))
req.on('error', err => console.log(JSON.stringify({ ok: false, code: err.code ?? err.message, flags: process.execArgv })))
req.end()
