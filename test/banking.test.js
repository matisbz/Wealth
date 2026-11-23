import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { seal, unseal } from '../lib/vault.js'
import { request } from 'node:http'
import { request as tlsRequest } from 'node:https'
import { basename, join } from 'node:path'
import { once } from 'node:events'
import { createServers } from '../server.js'
import { chooseBalance, readTransactions, syncBank } from '../lib/banking.js'
import { banks } from '../public/banks.js'

test('elige un solo saldo contable por cuenta y divisa', () => {
  const rows = [
    { balance_type: 'ITAV', balance_amount: { amount: '30', currency: 'EUR' } },
    {
      balance_type: 'CLBD',
      balance_amount: { amount: '-2.87', currency: 'USD' },
    },
    {
      balance_type: 'CLBD',
      balance_amount: { amount: '25.00', currency: 'EUR' },
    },
  ]
  assert.equal(chooseBalance(rows, 'EUR').amount, '25.00')
  assert.equal(chooseBalance(rows, 'USD').amount, '-2.87')
  assert.equal(chooseBalance(rows, 'GBP'), null)
})

test('Trade Republic puede comunicar su único saldo en euros como OTHR', () => {
  const other = {
    balance_type: 'OTHR',
    balance_amount: { currency: 'EUR', amount: '0.00' },
  }
  const booked = {
    balance_type: 'CLBD',
    balance_amount: { currency: 'EUR', amount: '27.00' },
  }
  assert.deepEqual(chooseBalance([other], 'EUR', 'trade'), other.balance_amount)
  assert.deepEqual(
    chooseBalance([other, booked], 'EUR', 'trade'),
    booked.balance_amount,
  )
  assert.equal(chooseBalance([other, other], 'EUR', 'trade'), null)
  assert.equal(chooseBalance([other], 'USD', 'trade'), null)
  assert.equal(chooseBalance([other], 'EUR', 'santander'), null)
})

test('una respuesta vacía conserva el saldo y la fecha de la última lectura válida', async () => {
  const date = '2026-11-22T12:00:00.000Z'
  const a = {
    uid: 'account',
    amount: 12,
    currency: 'EUR',
    balanceAt: date,
    history: { '2026-11-22': 12 },
  }
  const c = { accounts: [a] }
  await syncBank(
    c,
    async (path) =>
      path.endsWith('/balances') ? { balances: [] } : { transactions: [] },
    {},
    new Date('2026-11-23'),
    'trade',
  )
  assert.equal(a.amount, 12)
  assert.equal(a.balanceAt, date)
  assert.deepEqual(a.history, { '2026-11-22': 12 })
  assert.match(c.issue, /lista de saldos vacía/)
})

test('mantiene los últimos datos válidos si el banco falla', async () => {
  const account = {
    uid: 'uid',
    amount: 33,
    history: {},
    transactions: [{ title: 'Anterior' }],
  }
  const c = { accounts: [account] }
  await syncBank(
    c,
    async () => {
      throw new Error('Incidencia del banco.')
    },
    {},
  )
  assert.equal(account.amount, 33)
  assert.equal(account.transactions[0].title, 'Anterior')
  assert.match(c.issue, /Saldo pendiente/)
  assert.match(c.issue, /Movimientos pendientes/)
})

test('Santander trae el movimiento sin consultar el detalle ni clasificar su destino', async () => {
  const calls = []
  const rows = await readTransactions(async path => {
    calls.push(path)
    return { transactions: [{ transaction_id: 'id', entry_reference: 'ref', booking_date: '2026-11-01',
      credit_debit_indicator: 'DBIT', transaction_amount: { amount: '100', currency: 'EUR' },
      bank_transaction_code: { code: 'ICDT', description: 'Transferencia' } }] }
  }, 'cuenta', {}, '2026-11-01', 'santander')
  assert.deepEqual(calls, ['/accounts/cuenta/transactions?date_from=2026-11-01&transaction_status=BOOK'])
  assert.deepEqual(rows, [{ date: '2026-11-01', amount: -100, currency: 'EUR', title: 'Transferencia' }])
})

test('detecta claves de paginación repetidas', async () => {
  await assert.rejects(
    readTransactions(
      async () => ({ transactions: [], continuation_key: 'same' }),
      'uid',
      {},
      '2026-11-01',
    ),
    /repetida/,
  )
})

test('configuración, autorización, consulta y revocación con proveedor simulado', async (t) => {
  const origin = 'http://127.0.0.1:4317'
  const registeredCallback = 'https://127.0.0.1:4318/callback'
  const directory = mkdtempSync(new URL('./.test-bank-', import.meta.url))
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const id = 'ab95d451-be13-4aa5-8cba-730179827822'
  const list = banks.map((b) => ({
    name: b.aspsp,
    country: 'ES',
    psu_types: ['personal'],
    maximum_consent_validity: 3600,
  }))
  let auth,
    exchanges = 0,
    revoked = false
  const service = async (input, options) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.enablebanking.com')
    const [h, p, s] = options.headers.Authorization.slice(7).split('.')
    assert.equal(
      verify(
        'RSA-SHA256',
        Buffer.from(h + '.' + p),
        pair.publicKey,
        Buffer.from(s, 'base64url'),
      ),
      true,
    )
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).kid, id)
    assert.equal(
      JSON.parse(Buffer.from(p, 'base64url')).aud,
      'api.enablebanking.com',
    )
    let body
    switch (url.pathname) {
      case '/application':
        body = {
          active: true,
          environment: 'PRODUCTION',
          redirect_urls: [registeredCallback],
          services: ['AIS'],
        }
        break
      case '/aspsps':
        assert.equal(url.searchParams.get('service'), 'AIS')
        body = { aspsps: list }
        break
      case '/auth':
        auth = JSON.parse(options.body)
        assert.equal(auth.redirect_url, registeredCallback)
        assert.equal(auth.psu_type, 'personal')
        assert.deepEqual(auth.aspsp, {
          name: 'Banco Santander',
          country: 'ES',
        })
        assert.ok(Date.parse(auth.access.valid_until) - Date.now() <= 3600000)
        body = {
          url: 'https://auth.enablebanking.com/ais/start?sessionid=demo',
        }
        break
      case '/sessions':
        exchanges++
        assert.deepEqual(JSON.parse(options.body), { code: 'once' })
        body = {
          session_id: 'session-secret',
          aspsp: auth.aspsp,
          access: auth.access,
          accounts: [
            {
              uid: 'private-uid',
              name: 'Cuenta',
              currency: 'EUR',
              account_id: { iban: 'ES001122334455' },
            },
            { uid: 'private-uid-2', name: 'Cuenta', currency: 'EUR' },
          ],
        }
        break
      case '/accounts/private-uid-2/balances':
      case '/accounts/private-uid/balances':
        body = {
          balances: [
            {
              balance_type: 'CLBD',
              balance_amount: { amount: '135.29', currency: 'EUR' },
            },
          ],
        }
        break
      case '/accounts/private-uid-2/transactions':
      case '/accounts/private-uid/transactions': {
        const second = url.searchParams.has('continuation_key')
        body = {
          transactions: [
            {
              transaction_amount: { currency: 'EUR', amount: '10.50' },
              bank_transaction_code: { code: 'ICDT' },
              creditor_account: { iban: 'ES0015440000000000000000' },
              entry_reference: second ? 'provider-private-ref' : undefined,
              credit_debit_indicator: second ? 'DBIT' : 'CRDT',
              booking_date: '2026-11-01',
            },
          ],
          continuation_key: second ? null : 'next',
        }
        break
      }
      case '/sessions/session-secret':
        assert.equal(options.method, 'DELETE')
        revoked = true
        body = {}
        break
      default:
        throw Error('Unexpected URL')
    }
    return Response.json(body)
  }
  const { dashboard: server, callbackServer } = createServers({
    origin,
    directory,
    transport: service,
  })
  for (const listener of [server, callbackServer]) {
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
  }
  const tlsBase = 'https://127.0.0.1:' + callbackServer.address().port
  const ca = readFileSync(directory + '/tls/cert.crt')
  t.after(() => {
    server.close()
    server.closeAllConnections()
    callbackServer.close()
    callbackServer.closeAllConnections()
    rmSync(directory, { recursive: true, force: true })
  })
  const base = 'http://127.0.0.1:' + server.address().port
  const call = (
    path,
    { body, cookie, originHeader = origin, secure = false } = {},
  ) =>
    new Promise((resolve, reject) => {
      const req = (secure ? tlsRequest : request)(
        (secure ? tlsBase : base) + path,
        {
          ...(secure ? { ca } : {}),
          method: body ? 'POST' : 'GET',
          headers: {
            Host: new URL(secure ? registeredCallback : origin).host,
            Origin: originHeader,
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          )
        },
      )
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  const initial = await call('/api/dashboard')
  const cookie = initial.headers.get('set-cookie').split(';')[0]
  const initialData = await initial.json()
  assert.equal(initialData.configured, false)
  assert.equal(initialData.callback, registeredCallback)
  assert.equal((await call('/api/dashboard', { secure: true })).status, 404)
  assert.equal((await call('/callback')).status, 404)
  const post = (path, body) => call('/api/' + path, { cookie, body })
  assert.equal(
    (
      await call('/api/setup', {
        cookie,
        body: { id, pem },
        originHeader: 'http://different.local',
      })
    ).status,
    403,
  )
  function seedLegacy(profile, amount, portfolio) {
    const owner = profile.split('=')[1]
    const filename = join(directory, createHash('sha256').update(owner).digest('hex') + '.vault')
    const store = existsSync(filename) ? unseal(readFileSync(filename), owner) : { connections: {}, pending: {}, catalog: [] }
    store.connections.myinvestor = { source: 'manual', portfolio, accounts: [{
      amount, currency: 'EUR', title: portfolio ? 'Cartera de fondos' : 'Saldo manual', transactions: [],
      history: { '2026-01-10': amount },
    }] }
    writeFileSync(filename, seal(store, owner))
  }

  await t.test('los saldos y las participaciones anteriores solo admiten consulta', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 11) })
    const profile = (await call('/api/dashboard')).headers.get('set-cookie').split(';')[0]
    const put = (action, body) => call('/api/myinvestor/' + action, { cookie: profile, body })
    const read = async () => (await (await call('/api/dashboard', { cookie: profile })).json()).connections[0]
    seedLegacy(profile, 1000)
    assert.equal((await put('saldo', { amount: '2' })).status, 404)
    assert.equal((await put('fondos', { units: {} })).status, 404)
    assert.equal((await read()).accounts[0].amount, 1000)
    const units = { XZ0000000001: 4, XZ0000000002: 0 }
    seedLegacy(profile, 1000, { units, quotes: { XZ0000000001: { nav: 81, date: '2026-01-10' } } })
    assert.equal((await put('cotizaciones', {})).status, 404)
    const initial = await read()
    assert.deepEqual(initial.portfolio.units, units)
    assert.deepEqual(initial.portfolio.quotes, {})
    assert.equal(initial.accounts[0].amount, null)
    assert.equal(initial.accounts[0].history['2026-01-10'], 1000)
    assert.match(initial.issue, /Consulta MyInvestor/)
  })
  assert.equal((await post('setup', { id, pem })).status, 200)
  const ownerDigest = createHash('sha256')
    .update(cookie.split('=')[1])
    .digest('hex')
  const file = readFileSync(directory + '/' + ownerDigest + '.vault')
  assert.equal(file.includes('PRIVATE KEY'), false)
  const start = await post('connect', { bank: 'santander' })
  assert.equal(start.status, 200)
  const callback = '/callback?state=' + auth.state + '&code=once'
  assert.equal(
    (await call(callback, { secure: true })).headers.get('location'),
    origin + '/?notice=state',
  )
  assert.equal(
    (await call(callback, { cookie, secure: true })).headers.get('location'),
    origin + '/?notice=connected-santander',
  )
  assert.equal(
    (await call(callback, { cookie, secure: true })).headers.get('location'),
    origin + '/?notice=state',
  )
  assert.equal(exchanges, 1)
  assert.equal((await post('sync', { bank: 'santander' })).status, 200)
  const dashboard = await (await call('/api/dashboard', { cookie })).json()
  assert.equal(dashboard.catalog.length, 4)
  const [account] = dashboard.connections[0].accounts
  assert.equal(account.amount, 135.29)
  assert.equal(account.last4, '4455')
  await t.test('renombra una sola cuenta del banco y conserva su nombre al sincronizar', async () => {
    const second = dashboard.connections[0].accounts[1]
    const edit = { bank: 'santander', id: second.id, name: 'Gastos comunes' }
    assert.notEqual(account.id, second.id)
    assert.equal((await call('/api/accounts/rename', { body: edit })).status, 404)
    assert.equal((await post('accounts/rename', edit)).status, 200)
    assert.equal((await post('sync', { bank: 'santander' })).status, 200)
    const updated = await (await call('/api/dashboard', { cookie })).json()
    assert.deepEqual(updated.connections[0].accounts.map((a) => a.title), [
      'Cuenta', 'Gastos comunes',
    ])
  })
  assert.deepEqual(
    account.transactions.map((t) => t.amount),
    [10.5, -10.5],
  )
  assert.doesNotMatch(
    JSON.stringify(dashboard),
    /private-uid|session-secret|PRIVATE KEY|ES001122|ES001544|provider-private-ref|entryReference|investmentSource/,
  )
  assert.equal(
    (await (await call('/api/dashboard')).json()).connections.length,
    0,
  )
  seedLegacy(cookie, 200.5)
  const combined = await (await call('/api/dashboard', { cookie })).json()
  assert.deepEqual(
    combined.connections.map((c) => [c.bank, c.accounts[0].amount]),
    [
      ['santander', 135.29],
      ['myinvestor', 200.5],
    ],
  )
  await t.test('actualización semanal por perfil, persistencia, reintentos y cambio de semana', async (t) => {
    const monday = Date.UTC(2026, 0, 12, 8)
    t.mock.timers.enable({ apis: ['Date'], now: monday })
    async function run(profile = cookie) {
      const dir = mkdtempSync(join(directory, 'weekly-'))
      writeFileSync(join(dir, 'pending'), '')
      const response = await call('/api/weekly-balances', { cookie: profile, body: { run: basename(dir) } })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result'), 'utf8')), result)
      return result
    }
    assert.equal((await post('weekly-balances', { run: '../tls' })).status, 404)
    assert.equal((await run('')).updated, 0)
    assert.deepEqual(await run(), { updated: 1, failed: 0, alreadyDone: 0, manual: 1 })
    assert.equal((await run()).alreadyDone, 1)
    const latest = await (await call('/api/dashboard', { cookie })).json()
    assert.equal(latest.connections[0].accounts[0].history['2026-01-12'], 135.29)
    assert.deepEqual(latest.connections[0].accounts[0].transactions, account.transactions)
    const units = { XZ0000000001: 2 }
    seedLegacy(cookie, 40, { units, quotes: {} })
    assert.deepEqual(await run(), { updated: 0, failed: 0, alreadyDone: 1, manual: 1 })
    t.mock.timers.tick(7 * 86400000)
    assert.equal((await run()).updated, 1)
    const next = await (await call('/api/dashboard', { cookie })).json()
    assert.equal(next.connections.find(c => c.bank === 'santander').accounts[0].history['2026-01-19'], 135.29)
    assert.equal(next.connections.find(c => c.bank === 'myinvestor').accounts[0].history['2026-01-19'], undefined)
    t.mock.timers.setTime(Date.parse(next.connections[0].expires) + 7 * 86400000)
    assert.equal((await run()).failed, 1)
  })
  const view = await (await call('/api/dashboard', { cookie })).json()
  assert.deepEqual(view.myInvestorOrders, [])
  assert.deepEqual(view.previousAllocations, [])
  assert.equal(view.connections.find(c => c.bank === 'santander').accounts[0].transactions.length, 2)
  assert.equal((await post('disconnect', { bank: 'santander' })).status, 200)
  assert.equal(revoked, true)
  assert.deepEqual(
    (await (await call('/api/dashboard', { cookie })).json()).connections.map(
      (c) => c.bank,
    ),
    ['myinvestor'],
  )
})
