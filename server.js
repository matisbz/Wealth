import http from 'node:http'
import https from 'node:https'
import { localTls } from './lib/local-tls.js'
import { randomBytes, createHash, createHmac } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importWithdrawals, publicDebt, repaymentMonths, settleRepayment } from './lib/debts.js'
import { seal, unseal } from './lib/vault.js'
import { myInvestorClient } from './lib/myinvestor.js'
import { portfolioAmount } from './public/funds.js'
import { banks, isLocalMyInvestor } from './public/banks.js'
import { availableBanks, client, Problem, syncBank } from './lib/banking.js'

const root = fileURLToPath(new URL('.', import.meta.url))
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
}
const isId = (value) =>
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
const empty = () => ({ connections: {}, pending: {}, catalog: [] })

async function jsonBody(req) {
  let length = 0
  const parts = []
  for await (const part of req) {
    length += part.length
    if (length > 24000)
      throw new Problem(413, 'El archivo supera el tamaño admitido.')
    parts.push(part)
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString() || '{}')
  } catch {
    throw new Problem(400, 'Revisa los datos del formulario.')
  }
}

export function createServers({
  origin,
  directory = join(root, '.wealth'),
  transport = fetch,
}) {
  const appHost = new URL(origin).host
  const callbackPort = Number(new URL(origin).port || 80) + 1
  const callbackHost = '127.0.0.1:' + callbackPort
  const callback = 'https://' + callbackHost + '/callback'
  const locks = new Map()
  const direct = myInvestorClient(transport)
  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    function json(value, status = 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    function redirect(notice) {
      res.writeHead(303, { Location: origin + '/?notice=' + notice })
      res.end()
    }
    let release
    try {
      const secure = Boolean(req.socket.encrypted)
      if (req.headers.host !== (secure ? callbackHost : appHost))
        throw new Problem(403, 'Utiliza la dirección local de Wealth.')
      const url = new URL(req.url, secure ? callback : origin)
      const isCallback = req.method === 'GET' && url.pathname === '/callback'
      if (secure !== isCallback) throw new Problem(404, 'Ruta no disponible.')
      if (
        req.method === 'GET' &&
        url.pathname !== '/callback' &&
        !url.pathname.startsWith('/api/')
      ) {
        const path = url.pathname === '/' ? '/index.html' : url.pathname
        if (!/^\/(?:assets\/)?[\w.-]+$/.test(path) || !types[extname(path)])
          throw new Problem(404, 'No encontrado.')
        let file
        try {
          file = readFileSync(join(root, 'public', path))
        } catch {
          throw new Problem(404, 'No encontrado.')
        }
        res.writeHead(200, { 'Content-Type': types[extname(path)] })
        return res.end(file)
      }
      if (
        req.method === 'POST' &&
        (req.headers.origin !== origin ||
          req.headers['content-type']?.split(';')[0] !== 'application/json')
      )
        throw new Problem(403, 'Petición de origen desconocido.')
      let owner = /(?:^|;\s*)wealth_owner=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie || '',
      )?.[1]
      if (!owner) {
        if (url.pathname === '/callback') return redirect('state')
        owner = randomBytes(32).toString('hex')
        res.setHeader(
          'Set-Cookie',
          'wealth_owner=' +
            owner +
            '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000',
        )
      }
      const filename = join(
        directory,
        createHash('sha256').update(owner).digest('hex') + '.vault',
      )
      const previous = locks.get(owner)
      const lock = new Promise((resolve) => {
        release = () => {
          resolve()
          if (locks.get(owner) === lock) locks.delete(owner)
        }
      })
      locks.set(owner, lock)
      await previous
      const store = existsSync(filename)
        ? unseal(readFileSync(filename), owner)
        : empty()
      // Older portfolios valued the units with public prices. Keep historical
      // observations, but require a bank snapshot for the current valuation.
      const local = store.connections.myinvestor
      if (local?.portfolio && local.portfolio.quoteSource !== 'myinvestor') {
        local.portfolio = { units: local.portfolio.units, quotes: {} }
        local.accounts[0].amount = portfolioAmount(local.portfolio.units, {})
        local.issue = 'Consulta MyInvestor para obtener sus valores liquidativos.'
      }
      function save() {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        writeFileSync(filename + '.tmp', seal(store, owner), { mode: 0o600 })
        renameSync(filename + '.tmp', filename)
      }
      function api() {
        if (!store.config)
          throw new Problem(409, 'Configura tu aplicación de Enable Banking.')
        return client(store.config.id, store.config.pem, transport)
      }
      const action = req.method + ' ' + url.pathname
      const accountId = (bank, uid) =>
        createHmac('sha256', owner)
          .update(JSON.stringify([bank, uid ?? null]))
          .digest('hex')
      function debtSource(account) {
        return account.debtSource || accountId('trade', account.hash ? [account.hash, account.currency] : account.uid)
      }
      function recordTradeWithdrawals() {
        store.debts ??= []
        for (const account of store.connections.trade.accounts) {
          account.debtSource = debtSource(account)
          importWithdrawals(store.debts, account, account.debtSource)
        }
      }
      if (store.connections.trade && !store.debts) {
        recordTradeWithdrawals()
        save()
      }
      if (action === 'POST /api/debts/settle') {
        if (settleRepayment(store, await jsonBody(req))) save()
        return json({ ok: true })
      }
      if (action === 'POST /api/debts/paid') {
        const { id, paid } = (await jsonBody(req)) || {}
        if (typeof paid !== 'boolean') throw new Problem(400, 'Indica el estado de la deuda.')
        const debt = store.debts?.find(d => d.id === id)
        if (!debt) throw new Problem(404, 'Esta deuda ya no está disponible.')
        if (debt.repaidMinor != null) throw new Problem(409, 'Esta salida forma parte de una reposición mensual. Actualiza Deudas.')
        if (Boolean(debt.paidAt) !== paid) {
          debt.paidAt = paid ? new Date().toISOString() : null
          save()
        }
        return json({ ok: true })
      }
      if (action === 'GET /api/dashboard') {
        return json({
          previousAllocations: (store.investments || []).filter(item => item.units && !item.archived)
            .map(({ date, amount, currency, title, units }) => ({ date, amount, currency, title, units })),
          myInvestorOrders: store.myInvestorOrders || [],
          debts: (store.debts || []).map(publicDebt),
          debtMonths: repaymentMonths(store),
          configured: !!store.config,
          environment: store.config?.environment,
          callback,
          catalog: store.catalog,
          connections: Object.entries(store.connections).map(([bank, c]) => ({
            bank,
            source: c.source,
            portfolio: c.portfolio,
            directReadAt: c.directReadAt,
            expires: c.expires,
            synced: c.synced,
            issue: c.issue,
            accounts: c.accounts.map(({ uid, hash, alias, debtSource, investmentSource, ...display }) => ({
              ...display,
              transactions: display.transactions.map(transaction => {
                const { entryReference, toMyInvestor, reviewDestination, ...row } = transaction
                return row
              }),
              id: accountId(bank, uid),
              title: alias || display.title,
            })),
          })),
        })
      }
      function saveMyInvestor(snapshot) {
        const { units, names, quotes, readAt, cash } = snapshot
        const previous = store.connections.myinvestor
        const priorFunds = previous?.accounts[0]
        const day = readAt.slice(0, 10)
        const amount = portfolioAmount(units, quotes)
        const accounts = [{
          title: 'Cartera de fondos', alias: priorFunds?.alias, currency: 'EUR', amount,
          balanceAt: readAt, history: { ...priorFunds?.history, [day]: amount }, transactions: [],
        }, ...cash.map(({ key, currency, amount }) => {
          const prior = previous?.accounts.find(a => a.uid === key)
          return {
            uid: key, title: 'Efectivo disponible', alias: prior?.alias, currency, amount,
            balanceAt: readAt, history: { ...prior?.history, [day]: amount }, transactions: [],
          }
        })]
        store.connections.myinvestor = {
          source: 'myinvestor', directReadAt: readAt, accounts,
          portfolio: { units, names, quotes, quoteSource: 'myinvestor' },
          issue: amount == null ? 'MyInvestor no ha comunicado el valor liquidativo en euros de todos tus fondos.' : undefined,
        }
        const orders = new Map((store.myInvestorOrders || []).map(o => [o.key, o]))
        for (const order of snapshot.orders) orders.set(order.key, order)
        store.myInvestorOrders = [...orders.values()].sort((a, b) => b.date.localeCompare(a.date))
        for (const [state, pending] of Object.entries(store.pending)) {
          if (pending.bank === 'myinvestor') delete store.pending[state]
        }
        save()
      }
      if (['POST /api/myinvestor/consultar', 'POST /api/myinvestor/aplicar'].includes(action)) {
        const connection = store.connections.myinvestor
        if (connection && !isLocalMyInvestor(connection))
          throw new Problem(409, 'Gestiona la conexión bancaria existente antes de importar la cartera.')
        const baseline = JSON.stringify([connection?.portfolio?.units, connection?.directReadAt,
          connection?.portfolio ? null : connection?.accounts[0]?.amount])
        const body = await jsonBody(req)
        if (action.endsWith('/consultar')) return json(await direct.preview(owner, body, baseline))
        const entry = direct.confirmed(owner, body?.previewId)
        if (entry.baseline !== baseline)
          throw new Problem(409, 'La cartera guardada ha cambiado. Vuelve a consultar MyInvestor.')
        saveMyInvestor(entry.snapshot)
        direct.forget(owner)
        return json({ ok: true })
      }
      if (action === 'POST /api/weekly-balances') {
        const { run } = await jsonBody(req)
        if (typeof run !== 'string' || !/^weekly-[A-Za-z0-9]{6}$/.test(run) ||
            !existsSync(join(directory, run, 'pending')))
          throw new Problem(404, 'La solicitud de actualización semanal ya no está activa.')
        const now = new Date()
        const madridDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now)
        const monday = new Date(madridDay + 'T00:00:00Z')
        monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
        const week = monday.toISOString().slice(0, 10)
        let updated = 0, failed = 0, alreadyDone = 0, manual = 0
        for (const [bank, connection] of Object.entries(store.connections)) {
          if (isLocalMyInvestor(connection)) {
            manual++
            continue
          }
          const needsMovements = bank === 'trade' || bank === 'santander'
          const weeklyField = needsMovements ? 'weeklyBalanceAndMovements' : 'weeklyObservation'
          if (connection[weeklyField] === week) {
            alreadyDone++
            continue
          }
          try {
            if (Date.parse(connection.expires) <= now.getTime()) {
              connection.issue = 'Renueva el consentimiento para actualizar los saldos.'
            } else {
              await syncBank(connection, api(), {}, now, bank, { balancesOnly: !needsMovements })
              if (bank === 'trade') recordTradeWithdrawals()
            }
            const current = store.connections[bank]
            if (current.issue) failed++
            else {
              current[weeklyField] = week
              updated++
            }
          } catch (error) {
            connection.issue = error instanceof Problem ? error.message : 'No se ha podido actualizar el saldo.'
            failed++
          }
          save()
        }
        const result = { updated, failed, alreadyDone, manual }
        const receipt = join(directory, run, 'result')
        writeFileSync(receipt + '.tmp', JSON.stringify(result), { mode: 0o600 })
        renameSync(receipt + '.tmp', receipt)
        return json(result)
      }
      if (action === 'POST /api/setup') {
        const { id, pem } = await jsonBody(req)
        if (
          store.config &&
          Object.values(store.connections).some((c) => !isLocalMyInvestor(c))
        )
          throw new Problem(
            409,
            'Desvincula las entidades antes de cambiar de aplicación.',
          )
        if (!isId(id) || typeof pem !== 'string')
          throw new Problem(
            400,
            'Comprueba el identificador de aplicación y el archivo PEM.',
          )
        const candidate = client(id, pem, transport)
        const info = await candidate('/application')
        if (!info.active)
          throw new Problem(
            409,
            'Activa la aplicación vinculando tus cuentas en el panel de Enable Banking.',
          )
        if (!info.redirect_urls?.includes(callback))
          throw new Problem(
            409,
            'Añade la URL de retorno indicada a tu aplicación de Enable Banking.',
          )
        if (!info.services?.includes('AIS'))
          throw new Problem(
            409,
            'Activa el servicio de información de cuentas (AIS).',
          )
        const list = await availableBanks(candidate)
        store.config = { id, pem, environment: info.environment }
        store.catalog = banks
          .filter((b) => list.some((x) => x.name === b.aspsp))
          .map((b) => b.id)
        store.pending = {}
        save()
        return json({ ok: true })
      }
      if (action === 'GET /callback') {
        const state = url.searchParams.get('state')
        const pending =
          Object.hasOwn(store.pending, state) && store.pending[state]
        if (!pending || pending.until < Date.now()) return redirect('state')
        delete store.pending[state]
        save()
        if (!url.searchParams.get('code') || url.searchParams.has('error'))
          return redirect('cancel')
        try {
          const service = api()
          const session = await service('/sessions', {
            method: 'POST',
            body: { code: url.searchParams.get('code') },
          })
          const bank = banks.find((b) => b.id === pending.bank)
          if (
            session.aspsp?.name !== bank.aspsp ||
            session.aspsp.country !== 'ES' ||
            !session.session_id
          )
            return redirect('failed')
          const accounts = session.accounts
            .filter((a) => a.uid)
            .map((a) => {
              const previous = store.connections[bank.id]?.accounts.find(
                (item) =>
                  item.uid === a.uid ||
                  (a.identification_hash &&
                    item.hash === a.identification_hash &&
                    item.currency === a.currency),
              )
              return {
                uid: a.uid,
                title: a.name || a.product || 'Cuenta bancaria',
                alias: previous?.alias,
                debtSource: previous?.debtSource,
                last4: a.account_id?.iban?.slice(-4) || '',
                currency: a.currency || '',
                amount: null,
                hash: a.identification_hash,
                history: previous?.history || {},
                transactions: [],
              }
            })
          if (!accounts.length) {
            await service(
              '/sessions/' + encodeURIComponent(session.session_id),
              { method: 'DELETE' },
            )
            return redirect('empty')
          }
          store.connections[bank.id] = {
            session: session.session_id,
            expires: session.access?.valid_until || pending.expires,
            accounts,
          }
          save()
          return redirect('connected-' + bank.id)
        } catch {
          return redirect('failed')
        }
      }
      if (!['POST /api/accounts/rename', 'POST /api/connect', 'POST /api/disconnect', 'POST /api/sync'].includes(action))
        throw new Problem(404, 'No encontrado.')
      const { bank: selected, id, name } = (await jsonBody(req)) || {}
      const bank = banks.find((b) => b.id === selected)
      if (!bank) throw new Problem(400, 'Selecciona una entidad.')
      const connection = store.connections[bank.id]
      if (action === 'POST /api/accounts/rename') {
        const account = connection?.accounts.find(
          (a) => accountId(bank.id, a.uid) === id,
        )
        if (!account) throw new Problem(404, 'Esta cuenta ya no está disponible.')
        const alias = typeof name === 'string' ? name.trim() : ''
        if (!alias || alias.length > 80)
          throw new Problem(400, 'Introduce un nombre de entre 1 y 80 caracteres.')
        account.alias = alias
        save()
        return json({ ok: true })
      }
      if (
        isLocalMyInvestor(connection) ||
        (bank.id === 'myinvestor' &&
          !connection &&
          action === 'POST /api/connect')
      )
        throw new Problem(
          409,
          'Usa «Consultar MyInvestor» desde la ficha de la entidad.',
        )
      const service = api()
      if (action === 'POST /api/connect') {
        if (connection && Date.parse(connection.expires) > Date.now())
          throw new Problem(409, 'Esta entidad ya está vinculada.')
        const list = await availableBanks(service)
        store.catalog = banks
          .filter((b) => list.some((x) => x.name === b.aspsp))
          .map((b) => b.id)
        save()
        const match = list.find((x) => x.name === bank.aspsp)
        if (!match)
          throw new Problem(
            409,
            'Esta entidad no está disponible para tu aplicación en España.',
          )
        const ttl = Math.min(
          match.maximum_consent_validity || 90 * 86400,
          180 * 86400,
        )
        const expires = new Date(Date.now() + (ttl - 1) * 1000).toISOString()
        const state = randomBytes(32).toString('hex')
        const result = await service('/auth', {
          method: 'POST',
          body: {
            access: {
              balances: true,
              transactions: true,
              valid_until: expires,
            },
            aspsp: { name: match.name, country: match.country },
            state,
            redirect_url: callback,
            psu_type: 'personal',
            language: 'es',
          },
        })
        if (new URL(result.url).protocol !== 'https:')
          throw new Problem(502, 'Enlace de autorización inválido.')
        store.pending = Object.fromEntries(
          Object.entries(store.pending).filter(
            ([, p]) => p.until > Date.now() && p.bank !== bank.id,
          ),
        )
        store.pending[state] = {
          bank: bank.id,
          until: Date.now() + 30 * 60000,
          expires,
        }
        save()
        return json({ url: result.url })
      }
      if (!connection) throw new Problem(404, 'Entidad sin vincular.')
      if (action === 'POST /api/disconnect') {
        try {
          await service('/sessions/' + encodeURIComponent(connection.session), {
            method: 'DELETE',
          })
        } catch (error) {
          if (error.status !== 404 && error.status !== 410) throw error
        }
        delete store.connections[bank.id]
      } else if (action === 'POST /api/sync') {
        if (Date.parse(connection.expires) <= Date.now())
          throw new Problem(409, 'Renueva el consentimiento de esta entidad.')
        await syncBank(
          connection,
          service,
          {
            'Psu-User-Agent': req.headers['user-agent'] || 'Wealth',
            'Psu-Ip-Address': req.socket.remoteAddress,
            'Psu-Accept-Language': 'es',
          },
          new Date(),
          bank.id,
        )
        if (bank.id === 'trade') recordTradeWithdrawals()
      } else throw new Problem(404, 'No encontrado.')
      save()
      json({ ok: true, issue: connection.issue || '' })
    } catch (err) {
      json(
        {
          error:
            err instanceof Problem
              ? err.message
              : 'No se ha podido completar la operación.',
        },
        err instanceof Problem ? err.status : 500,
      )
    } finally {
      release?.()
    }
  }
  return {
    dashboard: http.createServer(handle),
    callbackServer: https.createServer(localTls(directory), handle),
    callbackPort,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317)
  const origin = 'http://127.0.0.1:' + port
  const { dashboard, callbackServer, callbackPort } = createServers({ origin })
  callbackServer.listen(callbackPort, '127.0.0.1')
  dashboard.listen(port, '127.0.0.1', () =>
    console.log('Wealth disponible en ' + origin),
  )
}
