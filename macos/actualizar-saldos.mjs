import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const directory = fileURLToPath(new URL('../.wealth/', import.meta.url))
const launcher = fileURLToPath(new URL('./abrir-wealth.zsh', import.meta.url))
mkdirSync(directory, { recursive: true, mode: 0o700 })
const job = mkdtempSync(join(directory, 'weekly-'))
try {
  writeFileSync(join(job, 'pending'), '', { mode: 0o600 })
  const opened = spawnSync('/bin/zsh', [launcher, '--semanal', basename(job)], { stdio: 'inherit' })
  if (opened.status !== 0) throw new Error('No se ha podido abrir Wealth.')
  const receipt = join(job, 'result')
  const deadline = Date.now() + 10 * 60000
  while (!existsSync(receipt) && Date.now() < deadline) await setTimeout(1000)
  if (!existsSync(receipt)) throw new Error('El navegador no ha confirmado la actualización.')
  const { updated, alreadyDone, failed, manual } = JSON.parse(readFileSync(receipt, 'utf8'))
  console.log('Entidades actualizadas: %d. Ya registradas esta semana: %d. Con incidencias: %d. Entidades con consulta puntual: %d.', updated, alreadyDone, failed, manual)
  if (failed || !(updated + alreadyDone + manual)) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  rmSync(job, { recursive: true, force: true })
}
