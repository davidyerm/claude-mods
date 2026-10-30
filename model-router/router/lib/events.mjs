import fs from 'node:fs'
import path from 'node:path'

const TEXT_MAX = 200

export function createRotatingFile(file, { maxBytes, keep }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  function rotate() {
    for (let i = keep - 2; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch {}
    }
    try { fs.renameSync(file, `${file}.1`) } catch {}
  }
  return {
    append(text) {
      let size = 0
      try { size = fs.statSync(file).size } catch {}
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) rotate()
      fs.appendFileSync(file, text)
    },
  }
}

export function createEventLog({ file, capacity = 500, now = Date.now } = {}) {
  const ring = []
  let seq = 0
  const out = file ? createRotatingFile(file, { maxBytes: 1_048_576, keep: 3 }) : null
  return {
    emit(fields) {
      const event = { seq: ++seq, t: new Date(now()).toISOString() }
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) event[k] = v
      if (typeof event.text === 'string') event.text = event.text.slice(0, TEXT_MAX)
      ring.push(event)
      if (ring.length > capacity) ring.shift()
      try { out?.append(`${JSON.stringify(event)}\n`) } catch {}
      return event
    },
    after: n => ring.filter(e => e.seq > n),
    lastSeq: () => seq,
  }
}
