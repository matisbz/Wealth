import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// The browser holds the random 256-bit key in an HttpOnly cookie.
// The local file contains only its digest in the filename and authenticated ciphertext.
export function seal(value, owner) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(owner, 'hex'), iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

export function unseal(data, owner) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(owner, 'hex'),
    data.subarray(0, 12),
  )
  decipher.setAuthTag(data.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString('utf8'),
  )
}
