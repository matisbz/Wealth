import { createHash, randomUUID } from 'node:crypto'
import { parseUnits } from '../public/funds.js'
import { Problem } from './banking.js'

const origin = 'https://api.myinvestor.es'
const loginPath = '/login/api/v2/auth/token'
const accountsPath = '/cperf-server/api/v2'
const isinPattern = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/
const buyTypes = new Set(['INVESTMENT_FUNDS_SUBSCRIPTION', 'INVESTMENT_FUNDS_SUBSCRIPTION_SF'])
const incomplete = () => new Problem(502, 'MyInvestor ha devuelto datos incompletos. Se conservan tus datos guardados.')

function list(value) {
  if (!Array.isArray(value)) throw incomplete()
  return value
}

function identifier(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[\w-]{1,160}$/.test(String(value))) throw incomplete()
  return String(value)
}

function quantity(value) {
  if (value == null || String(value).trim() === '') throw incomplete()
  const n = typeof value === 'number' && Number.isFinite(value)
    ? parseUnits(value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 }))
    : parseUnits(String(value))
  if (!Number.isFinite(n)) throw incomplete()
  return n
}

function calendarDay(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(date)
}

// Only the short-lived login challenge and the normalized preview survive a request.
export function myInvestorClient(transport) {
  const pending = new Map()
  function remember(owner, value, minutes) {
    const id = randomUUID()
    const timer = setTimeout(() => pending.delete(owner), minutes * 60000)
    timer.unref()
    forget(owner)
    pending.set(owner, { ...value, id, timer })
    return id
  }
  function forget(owner) {
    clearTimeout(pending.get(owner)?.timer)
    pending.delete(owner)
  }
  function pendingFor(owner, id, kind) {
    const entry = pending.get(owner)
    if (!entry || entry.id !== id || entry.kind !== kind)
      throw new Problem(409, 'La consulta ha caducado o se ha abierto otra. Vuelve a consultar MyInvestor.')
    return entry
  }
  async function preview(owner, input, baseline) {
    const { user, password, code, challengeId } = input || {}
    if (typeof user !== 'string' || !user.trim() || user.length > 120 ||
        typeof password !== 'string' || !password || password.length > 256)
      throw new Problem(400, 'Introduce tu documento y tu contraseña de MyInvestor.')
    const customerId = user.trim()
    const challenge = challengeId ? pendingFor(owner, challengeId, 'login') : null
    if (challenge && (!/^\d{6}$/.test(code) || customerId !== challenge.customerId))
      throw new Problem(400, 'Comprueba el documento y los seis dígitos del SMS.')
    if (!challenge) forget(owner)
    const headers = { Accept: 'application/json', 'x-device-id': challenge?.device || randomUUID() }
    async function call(path, method = 'GET', body) {
      let response
      try {
        response = await transport(origin + path, { method, headers: { ...headers,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(20000) })
      } catch {
        throw new Problem(502, 'No se ha podido contactar con MyInvestor. Inténtalo más tarde.')
      }
      if (response.status === 429) throw new Problem(429, 'MyInvestor pide esperar antes de otra consulta.')
      if (response.status === 403) throw new Problem(403, 'MyInvestor ha bloqueado esta consulta o requiere una comprobación en su web. Wealth conserva tus datos guardados.')
      if (!response.ok) {
        if (path === loginPath && [400, 401].includes(response.status))
          throw new Problem(401, challenge ? 'MyInvestor ha rechazado el código o el acceso.' : 'MyInvestor ha rechazado el acceso. Comprueba tus datos.')
        throw new Problem(502, 'MyInvestor no ha completado la consulta. Se conservan tus datos guardados.')
      }
      const value = await response.json().catch(() => null)
      if (value?.payload?.data == null) throw incomplete()
      return { status: response.status, data: value.payload.data }
    }
    const credentials = { customerId, password }
    if (challenge?.otpId) Object.assign(credentials, { otpId: challenge.otpId, signatureRequestId: challenge.requestId, code })
    if (challenge?.signatureId) {
      const checked = await call('/signature/api/v3/public/signature/' + challenge.requestId + '/validate/' + challenge.signatureId, 'POST', { code })
      if (checked.data.status !== 'COMPLETE') throw new Problem(401, 'El banco no ha validado el SMS de inicio de sesión.')
    }
    const login = await call(loginPath, 'POST', credentials)
    if (login.status === 202) {
      if (challenge) throw new Problem(409, 'MyInvestor todavía requiere verificación. Inicia una nueva consulta.')
      const requestId = identifier(login.data.signatureRequestId)
      const state = { kind: 'login', customerId, requestId, device: headers['x-device-id'] }
      if (login.data.otpId) state.otpId = identifier(login.data.otpId)
      else if (list(login.data.pendingSignatureMethods || []).flat().includes('OTP_SMS')) {
        const sms = await call('/signature/api/v3/public/signature/' + requestId + '?method=OTP_SMS', 'POST')
        state.signatureId = identifier(sms.data.signatureId)
      } else throw new Problem(409, 'El banco requiere un método de verificación que Wealth no admite.')
      return { challengeId: remember(owner, state, 5) }
    }
    if (typeof login.data.accessToken !== 'string' || !login.data.accessToken) throw incomplete()
    forget(owner)
    headers.Authorization = 'Bearer ' + login.data.accessToken
    const read = async path => (await call(accountsPath + path)).data
    const snapshot = await readSnapshot(read)
    return { snapshot, previewId: remember(owner, { kind: 'preview', snapshot, baseline }, 10) }
  }
  return { preview, forget, confirmed: (owner, id) => pendingFor(owner, id, 'preview') }
}

// Only value a position when the bank identifies its NAV currency as EUR.
function positionQuote(position) {
  if (position.liquidationValueCurrency !== 'EUR') return null
  const raw = position.originCurrencyLiquidationValue ?? position.liquidationValue
  if (!/^\d+(?:\.\d+)?$/.test(String(raw))) return null
  const nav = Number(raw)
  if (!Number.isFinite(nav) || nav <= 0) return null
  const day = String(position.liquidationValueDate ?? '').slice(0, 10)
  const time = Date.parse(day)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === day ? day : null
  return { nav, date }
}

async function readSnapshot(read) {
  const readAt = new Date()
  const from = calendarDay(new Date(+readAt - 89 * 86400000)).replaceAll('-', '')
  const to = calendarDay(readAt).replaceAll('-', '')
  const cash = [], orders = new Map()
  const units = {}
  const names = {}
  const quotes = {}
  const cashIds = new Set()
  for (const a of list(await read('/cash-accounts/self'))) {
    if (!['CASH_ACCOUNT', 'CASH_PORTFOLIO'].includes(a.accountType)) continue
    if (a.status == null && typeof a.active !== 'boolean') throw incomplete()
    if (a.status !== 'ACTIVE' && a.active !== true) continue
    if (!list(a.holders).length || !a.holders.some(h => h.me === true)) continue
    const id = identifier(a.accountId && a.accountId !== 'null' ? a.accountId : a.accountUuid)
    const amount = Number(a.enabledBalance)
    if (!/^-?\d+(\.\d+)?$/.test(String(a.enabledBalance)) || !Number.isFinite(amount) ||
        !/^[A-Z]{3}$/.test(a.currency) || cashIds.has(id)) throw incomplete()
    cashIds.add(id)
    cash.push({ key: createHash('sha256').update(id).digest('hex'), amount, currency: a.currency })
  }
  if (!cash.length) throw new Problem(409, 'MyInvestor no ha devuelto cuentas activas a tu nombre.')
  const securities = list(await read('/securities-accounts/self-basic'))
  const seen = new Set()
  for (const account of securities) {
    if (!cashIds.has(String(account.cashAccountId))) continue
    const id = identifier(account.accountId)
    if (seen.has(id)) continue
    seen.add(id)
    const base = '/securities-accounts/' + id
    const investments = (await read(base)).securitiesAccountInvestments
    if (!investments || typeof investments !== 'object' || Array.isArray(investments)) throw incomplete()
    for (const category of ['FUND', 'INDEXED_FUND']) {
      if (!investments[category]) continue
      for (const f of list(investments[category].investmentList)) {
        if (typeof f.isin !== 'string' || !isinPattern.test(f.isin)) throw incomplete()
        units[f.isin] = quantity(((units[f.isin] ?? 0) + quantity(f.shares)).toFixed(12))
        const name = f.name || f.investmentName
        if (typeof name === 'string' && name.trim()) names[f.isin] = name.trim()
        const quote = positionQuote(f)
        const previous = quotes[f.isin]
        if (quote && (!previous || (quote.date || '') > (previous.date || ''))) quotes[f.isin] = quote
      }
    }
    const recent = list(await read(base + '/orders?dateFrom=' + from + '&dateTo=' + to + '&status=COMPLETE'))
    for (const order of recent) {
      if (!isinPattern.test(order.isin) || !buyTypes.has(order.operationType) || (order.status || order.orderStatus) !== 'COMPLETE') continue
      const ref = identifier(order.reference)
      const key = createHash('sha256').update(JSON.stringify([id, ref])).digest('hex')
      if (orders.has(key)) continue
      const detail = await read(base + '/orders/' + ref)
      const fills = list(detail.relatedOperations || []).filter(Boolean)
      const shares = fills.reduce((sum, op) => sum + quantity(op.executedShares ?? 0), 0) || quantity(detail.executedShares)
      const date = String(detail.executionDate || fills.find(op => op.executionDate)?.executionDate || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !shares) throw incomplete()
      orders.set(key, { key, isin: order.isin, shares: quantity(shares.toFixed(12)), date })
    }
  }
  if (!seen.size) throw new Problem(409, 'MyInvestor no ha devuelto una cuenta de valores vinculada. Se conservan tus datos guardados.')
  return { units, names, quotes, cash, orders: [...orders.values()], readAt: readAt.toISOString() }
}
