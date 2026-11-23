import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function localTls(directory) {
  const target = join(directory, 'tls')
  if (!existsSync(target)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stage = mkdtempSync(join(directory, '.tls-'))
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
        '-subj', '/CN=Wealth local',
        '-addext', 'subjectAltName=IP:127.0.0.1',
        '-addext', 'basicConstraints=critical,CA:FALSE',
        '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
        '-addext', 'extendedKeyUsage=serverAuth',
        '-keyout', join(stage, 'key.pem'), '-out', join(stage, 'cert.crt'),
      ], { stdio: 'ignore' })
      chmodSync(join(stage, 'key.pem'), 0o600)
      try { renameSync(stage, target) }
      catch (error) { if (!existsSync(target)) throw error }
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }
  return { key: readFileSync(join(target, 'key.pem')), cert: readFileSync(join(target, 'cert.crt')), minVersion: 'TLSv1.2' }
}
