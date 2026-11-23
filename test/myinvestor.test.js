import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { createServers } from '../server.js'
import { myInvestorClient } from '../lib/myinvestor.js'
import { seal, unseal } from '../lib/vault.js'

const isin = 'XZ0000000001'
const creds = { user: 'DOCUMENTO-PRUEBA', password: 'CLAVE-SIMULADA' }
const ok = (data, status = 200) => Response.json({ payload: { data } }, { status })

function bankMock() {
  const state = { block: false, broken: false, sms: false, signed: false, logins: 0, price: { originCurrencyLiquidationValue: "12.3456", liquidationValueCurrency: "EUR", liquidationValueDate: "2026-11-18" } }
  state.transport = async (input, options) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.myinvestor.es')
    assert.equal(options.redirect, 'error')
    const path = url.pathname
    if (path === '/login/api/v2/auth/token') {
      state.logins++
      if (state.block) return new Response(null, { status: 403 })
      const body = JSON.parse(options.body)
      assert.equal(body.password, creds.password)
      if (state.sms && !state.signed)
        return ok({ signatureRequestId: 'login-id', pendingSignatureMethods: [['OTP_SMS']] }, 202)
      return ok({ accessToken: 'SECRETO-SESION', refreshToken: 'SECRETO-RENOVACION' })
    }
    if (path.includes('/public/signature/')) {
      if (path.endsWith('/validate/sms-id')) {
        state.signed = JSON.parse(options.body).code === '123456'
        return ok({ status: state.signed ? 'COMPLETE' : 'PENDING' })
      }
      assert.equal(url.searchParams.get('method'), 'OTP_SMS')
      return ok({ signatureId: 'sms-id' })
    }
    assert.equal(options.method, 'GET')
    assert.equal(options.headers.Authorization, 'Bearer SECRETO-SESION')
    if (path.endsWith('/cash-accounts/self'))
      return ok([{ accountId: 'cash', accountType: 'CASH_ACCOUNT', status: 'ACTIVE', holders: [{ me: true }],
        currency: 'EUR', enabledBalance: 87.65 }])
    if (path.endsWith('/securities-accounts/self-basic')) return ok([{ accountId: 'sec', cashAccountId: 'cash' }])
    if (path.endsWith('/sec')) return ok({ securitiesAccountInvestments: { FUND: { investmentList:
      [{ isin, name: 'Fondo de prueba', shares: state.broken ? null : '3.25', ...state.price }] } } })
    if (path.endsWith('/orders')) {
      const order = { status: 'COMPLETE', operationType: 'INVESTMENT_FUNDS_SUBSCRIPTION', isin, reference: 'orden' }
      return ok([order, order, { ...order, status: 'PENDING', reference: 'pendiente' }])
    }
    if (path.endsWith('/orders/orden')) return ok({ executionDate: '2026-11-02', executedShares: '1.25' })
    throw new Error('Petición inesperada')
  }
  return state
}

test('SMS interactivo y rechazo del banco sin reintento ni fuga de secretos', async () => {
  const fake = bankMock()
  fake.sms = true
  const client = myInvestorClient(fake.transport)
  const { challengeId } = await client.preview('owner', creds, 'snapshot')
  assert.ok(challengeId)
  const answer = { ...creds, challengeId, code: '123456' }
  await assert.rejects(client.preview('otro', answer), { status: 409 })
  await assert.rejects(client.preview('owner', { ...answer, code: '000000' }), { status: 401 })
  const result = await client.preview('owner', answer, 'snapshot')
  assert.doesNotMatch(JSON.stringify(result), /CLAVE-SIMULADA|SECRETO-|DOCUMENTO-PRUEBA/)
  assert.equal(result.snapshot.units[isin], 3.25)
  fake.block = true
  const attempts = fake.logins
  await assert.rejects(client.preview('owner', creds), { status: 403 })
  assert.equal(fake.logins, attempts + 1)
})

test('solo se valora el VL en euros de la posición y se distingue su fecha de la de consulta', async () => {
  const fake = bankMock()
  const client = myInvestorClient(fake.transport)
  const quote = async () => (await client.preview('perfil', creds)).snapshot.quotes[isin]
  assert.deepEqual(await quote(), { nav: 12.3456, date: '2026-11-18' })
  fake.price = { originCurrencyLiquidationValue: '15.5', liquidationValueCurrency: 'EUR' }
  assert.deepEqual(await quote(), { nav: 15.5, date: null })
  for (const price of [{}, { originCurrencyLiquidationValue: 15.5 }, { originCurrencyLiquidationValue: 12, liquidationValueCurrency: 'USD' },
    { originCurrencyLiquidationValue: 0 }, { originCurrencyLiquidationValue: 'inválido' }]) {
    fake.price = price
    assert.equal(await quote(), undefined)
  }
})

test('la consulta directa conserva las compras y los desgloses históricos y aísla perfiles', async t => {
  const directory = mkdtempSync(new URL('./.test-investor-', import.meta.url))
  const fake = bankMock()
  const origin = 'http://127.0.0.1:4317'
  const { dashboard, callbackServer } = createServers({ origin, directory, transport: fake.transport })
  dashboard.listen(0, '127.0.0.1')
  await once(dashboard, 'listening')
  t.after(() => { dashboard.close(); dashboard.closeAllConnections(); callbackServer.close(); rmSync(directory, { recursive: true, force: true }) })
  const owner = 'ab'.repeat(32)
  const cookie = 'wealth_owner=' + owner
  const filename = join(directory, createHash('sha256').update(owner).digest('hex') + '.vault')
  const historical = { date: '2026-10-01', title: 'Transferencia', amount: 100, currency: 'EUR', units: { [isin]: 1.5 } }
  const legacy = [{ ...historical, id: 'uno', revision: 1 }, { id: 'dos', units: null }]
  writeFileSync(filename, seal({ connections: {}, pending: {}, catalog: [], investments: legacy }, owner))
  async function call(path, body, profile = cookie) {
    const response = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: dashboard.address().port, path: '/api/' + path,
        method: body ? 'POST' : 'GET', headers: { Host: new URL(origin).host, Origin: origin, Cookie: profile,
          'Content-Type': 'application/json' } }, resolve)
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
    let result = ''
    for await (const part of response) result += part
    return { status: response.statusCode, value: JSON.parse(result) }
  }
  const preview = () => call('myinvestor/consultar', creds)
  const apply = (previewId, profile) => call('myinvestor/aplicar', { previewId }, profile)
  const first = await preview()
  assert.equal(first.status, 200)
  assert.equal((await call('dashboard')).value.connections.length, 0)
  assert.equal((await apply(first.value.previewId, 'wealth_owner=' + 'cd'.repeat(32))).status, 409)
  const baseline = unseal(readFileSync(filename), owner)
  baseline.connections.myinvestor = { source: 'manual', accounts: [
    { title: 'Saldo manual', currency: 'EUR', amount: 80, history: { '2026-01-10': 80 }, transactions: [] },
  ] }
  writeFileSync(filename, seal(baseline, owner))
  assert.equal((await apply(first.value.previewId)).status, 409)
  for (let i = 0; i < 2; i++) {
    const { value } = await preview()
    assert.equal((await apply(value.previewId)).status, 200)
    assert.equal((await apply(value.previewId)).status, 409)
  }
  const data = (await call('dashboard')).value
  assert.equal(data.connections[0].source, 'myinvestor')
  assert.deepEqual(data.connections[0].portfolio.names, { [isin]: 'Fondo de prueba' })
  assert.equal(data.connections[0].portfolio.quoteSource, 'myinvestor')
  assert.equal(data.connections[0].portfolio.quotes[isin].nav, 12.3456)
  assert.equal(data.connections[0].accounts[0].amount, 40.12)
  assert.equal(data.connections[0].accounts[0].history['2026-01-10'], 80)
  assert.equal(data.connections[0].portfolio.units[isin], 3.25)
  assert.equal(data.connections[0].accounts[1].amount, 87.65)
  assert.equal(data.myInvestorOrders.length, 1)
  assert.equal(data.myInvestorOrders[0].shares, 1.25)
  assert.deepEqual(data.previousAllocations, [historical])
  assert.equal((await call('inversion/compras', { id: 'uno' })).status, 404)
  fake.price = {}
  const missing = await preview()
  assert.equal((await apply(missing.value.previewId)).status, 200)
  const afterMissing = (await call('dashboard')).value.connections[0]
  assert.equal(afterMissing.accounts[0].amount, null)
  assert.equal(afterMissing.accounts[1].amount, 87.65)
  assert.equal(afterMissing.portfolio.units[isin], 3.25)
  assert.deepEqual(afterMissing.portfolio.quotes, {})
  const before = readFileSync(filename)
  assert.deepEqual(unseal(before, owner).investments, legacy)
  assert.doesNotMatch(JSON.stringify(unseal(before, owner)), /CLAVE-SIMULADA|SECRETO-|DOCUMENTO-PRUEBA|123456/)
  fake.broken = true
  assert.equal((await preview()).status, 502)
  assert.deepEqual(readFileSync(filename), before)
})
