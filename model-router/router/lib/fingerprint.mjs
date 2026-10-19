import crypto from 'node:crypto'

// Enough to tell two keys apart, not enough to recover one.
export const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)
