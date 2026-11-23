import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { request } from 'node:http'
import { once } from 'node:events'
import { createServers } from '../server.js'
import { importWithdrawals, publicDebt, repaymentMonths, settleRepayment } from '../lib/debts.js'
import { seal } from '../lib/vault.js'

const charge = { date: '2026-11-01', amount: -35.49, currency: 'EUR', title: 'Compra' }
test('concilia cargos idénticos por cuenta y conserva su estado cuando llegan referencias', () => {
  const debts = []
  const ingest = (transactions, source = 'cuenta1') => importWithdrawals(debts, { transactions }, source)
  ingest([charge, charge, { ...charge, amount: 6 }, { ...charge, date: '2026-10-31' }])
  assert.equal(debts.length, 2)
  debts[0].paidAt = '2026-12-01'
  const identified = ['ref2', 'ref1', 'ref2'].map(entryReference => ({ ...charge, entryReference }))
  ingest(identified)
  ingest(identified.toReversed())
  ingest([charge, charge])
  assert.equal(debts.length, 2)
  assert.equal(debts[0].paidAt, '2026-12-01')
  ingest(identified, 'cuenta2')
  assert.equal(debts.length, 4)
  ingest([{ ...charge, entryReference: 'ref3', date: '2026-12-31' }])
  assert.equal(publicDebt(debts.at(-1)).due, '2027-01')
})

test('un pago parcial traslada el resto una sola vez y el total liquida el nuevo agregado', () => {
  const now = new Date('2026-12-01T12:00:00Z')
  const store = { debts: [] }
  const add = (amount, date, currency = 'EUR') => store.debts.push({
    id: String(store.debts.length), amount, date, currency, paidAt: null,
  })
  add(80, '2026-11-02')
  add(20.55, '2026-11-12')
  add(7, '2026-11-15')
  store.debts.at(-1).paidAt = '2026-12-01'
  add(10, '2026-12-02')
  add(32, '2026-11-15', 'USD')
  const get = (key, at = now) => repaymentMonths(store, at).find(g => g.key === key)
  const dec = get('2026-12/EUR')
  assert.equal(dec.balance, 10055)
  assert.equal(dec.paid, 700)
  const partial = { ...dec, mode: 'partial', amount: '30,20' }
  for (const amount of ['', '0', '-1', '100.55', '101', '3.005', '1e2']) {
    assert.throws(() => settleRepayment(store, { ...partial, amount }, now), { status: 400 })
  }
  assert.equal(settleRepayment(store, partial, now), true)
  assert.equal(settleRepayment(store, partial, now), false)
  assert.throws(() => settleRepayment(store, { ...partial, mode: 'total' }, now), { status: 409 })
  assert.equal(get('2026-12/EUR').balance, 0)
  assert.equal(get('2026-12/EUR').paid, 3720)
  assert.equal(get('2026-12/EUR').payments[0].deferred, 7035)
  assert.equal(get('2026-12/USD').balance, 3200)
  const jan = get('2027-01/EUR')
  assert.equal(jan.carried, 7035)
  assert.equal(jan.balance, 8035)
  assert.equal(settleRepayment(store, { ...jan, mode: 'total' }, now), true)
  assert.equal(get('2027-01/EUR').balance, 0)
  assert.equal(get('2027-01/EUR').paid, 8035)
  add(4, '2026-11-25')
  assert.equal(get('2026-12/EUR').balance, 400)
  assert.equal(get('2027-02/EUR', new Date('2027-02-01T09:00:00Z')).carried, 400)
})

test('importa el perfil anterior y actualiza Deudas desde el banco y la tarea semanal', async t => {
  const directory = mkdtempSync(new URL('./.test-debts-', import.meta.url))
  const owner = randomBytes(32).toString('hex')
  const file = join(directory, createHash('sha256').update(owner).digest('hex') + '.vault')
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const account = { uid: 'cuenta', hash: 'estable', currency: 'EUR', history: {}, transactions: [charge] }
  const connection = { expires: '2099-01-01', accounts: [account] }
  writeFileSync(file, seal({ connections: { trade: connection }, catalog: [], pending: {},
    config: { id: 'prueba', pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) } }, owner))
  let statement = [charge], fail = false, reads = 0
  const transport = async (url, options) => {
    if (options.method === 'DELETE') return Response.json({})
    if (new URL(url).pathname.endsWith('/balances'))
      return Response.json({ balances: [{ balance_type: 'CLBD', balance_amount: { amount: '500', currency: 'EUR' } }] })
    reads++
    if (fail) return new Response('', { status: 503 })
    return Response.json({ transactions: statement.map((row, i) => ({
      status: 'BOOK', entry_reference: 'ref-' + row.date + i, booking_date: row.date,
      credit_debit_indicator: row.amount < 0 ? 'DBIT' : 'CRDT', creditor: { name: row.title },
      transaction_amount: { amount: String(Math.abs(row.amount)), currency: row.currency },
    })) })
  }
  const origin = 'http://127.0.0.1:4317'
  const { dashboard } = createServers({ directory, origin, transport })
  dashboard.listen(0, '127.0.0.1')
  await once(dashboard, 'listening')
  t.after(() => { dashboard.close(); dashboard.closeAllConnections(); rmSync(directory, { recursive: true, force: true }) })
  const url = 'http://127.0.0.1:' + dashboard.address().port + '/api/'
  const call = (path, body, key = owner) => new Promise((resolve, reject) => {
    const req = request(url + path, {
      method: body ? 'POST' : 'GET',
      headers: { host: new URL(origin).host, origin, cookie: 'wealth_owner=' + key, 'content-type': 'application/json' },
    }, async res => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }))
    })
    req.on('error', reject)
    req.end(body && JSON.stringify(body))
  })
  const list = async () => (await (await call('dashboard')).json()).debts
  const run = async () => {
    const dir = mkdtempSync(join(directory, 'weekly-'))
    writeFileSync(join(dir, 'pending'), '')
    return (await call('weekly-balances', { run: basename(dir) })).json()
  }
  const [old] = await list()
  assert.equal(old.due, '2026-12')
  const mark = { id: old.id, paid: true }
  assert.equal((await call('debts/paid', mark, randomBytes(32).toString('hex'))).status, 404)
  assert.equal((await call('debts/paid', mark)).status, 200)
  const [paid] = await list()
  assert.ok(paid.paidAt)
  await call('debts/paid', mark)
  await call('sync', { bank: 'trade' })
  assert.deepEqual(await list(), [paid])
  statement = [{ ...charge, date: '2026-12-30' }, { ...charge, amount: 55 }]
  fail = true
  assert.equal((await run()).failed, 1)
  assert.deepEqual(await list(), [paid])
  fail = false
  assert.equal((await run()).updated, 1)
  const updated = await list()
  assert.equal(updated.length, 2)
  assert.equal(updated[1].due, '2027-01')
  assert.equal((await run()).alreadyDone, 1)
  assert.equal(reads, 3)
  await call('disconnect', { bank: 'trade' })
  assert.deepEqual(await list(), updated)
  await call('debts/paid', { ...mark, paid: false })
  assert.equal((await list())[0].paidAt, null)
})
