import { createHash, createPrivateKey, sign } from 'node:crypto'

export class Problem extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function client(kid, pem, transport = fetch) {
  let key
  try {
    key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'rsa') throw new Error()
  } catch {
    throw new Problem(
      400,
      'Selecciona la clave privada RSA en formato PEM de tu aplicación.',
    )
  }
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const encode = (obj) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url')
    const head = encode({ typ: 'JWT', alg: 'RS256', kid })
    const claims = encode({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: now,
      exp: now + 300,
    })
    const token = head + '.' + claims
    const signature = sign('RSA-SHA256', Buffer.from(token), key).toString(
      'base64url',
    )
    let res
    try {
      res = await transport('https://api.enablebanking.com' + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(25000),
        headers: {
          ...headers,
          Authorization: 'Bearer ' + token + '.' + signature,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new Problem(
        503,
        'Enable Banking no ha respondido. Vuelve a intentarlo.',
      )
    }
    if (!res.ok) {
      const messages = {
        401: 'Comprueba el Application ID y la clave privada.',
        403: 'Revisa el consentimiento y las cuentas vinculadas en Enable Banking.',
        429: 'El banco ha limitado temporalmente las consultas. Inténtalo más tarde.',
      }
      throw new Problem(
        res.status,
        messages[res.status] ||
          'Enable Banking no ha podido completar la consulta (' +
            res.status +
            ').',
      )
    }
    const payload = await res.text()
    return payload ? JSON.parse(payload) : {}
  }
}

export async function availableBanks(api) {
  const { aspsps } = await api(
    '/aspsps?country=ES&psu_type=personal&service=AIS',
  )
  return aspsps.filter(
    (b) => b.country === 'ES' && b.psu_types?.includes('personal'),
  )
}

function selectBalance(rows, accountCurrency, bank) {
  if (!Array.isArray(rows))
    return {
      issue: 'Enable Banking ha devuelto una respuesta de saldos incompleta.',
    }
  if (rows.length === 0)
    return { issue: 'Enable Banking ha devuelto la lista de saldos vacía.' }

  const amounts = rows.filter((row) => {
    const value = row?.balance_amount
    return (
      /^[A-Z]{3}$/.test(value?.currency) &&
      value.currency !== 'XXX' &&
      /^[+-]?\d+(?:\.\d+)?$/.test(value.amount) &&
      Number.isFinite(Number(value.amount))
    )
  })
  if (!amounts.length)
    return {
      issue:
        'El banco ha enviado registros de saldo sin un importe y una divisa válidos.',
    }
  const currencies = [
    ...new Set(amounts.map((row) => row.balance_amount.currency)),
  ]
  const currency =
    accountCurrency && accountCurrency !== 'XXX'
      ? accountCurrency
      : currencies.length === 1
        ? currencies[0]
        : null
  if (!currency)
    return {
      issue:
        'El banco ha enviado varias divisas sin indicar cuál corresponde a la cuenta.',
    }
  const candidates = amounts.filter(
    (row) => row.balance_amount.currency === currency,
  )
  if (!candidates.length)
    return {
      issue:
        'El banco solo ha devuelto saldos en ' +
        currencies.join(', ') +
        ' para la cuenta en ' +
        currency +
        '.',
    }

  for (const type of [
    'CLBD',
    'ITBD',
    'CLAV',
    'ITAV',
    'XPCD',
    'VALU',
    'PRCD',
    'OPBD',
    'OPAV',
  ]) {
    const found = candidates.find((row) => row.balance_type === type)
    if (found) return { balance: found.balance_amount }
  }
  if (
    bank === 'trade' &&
    candidates.every((row) => row.balance_type === 'OTHR')
  ) {
    if (candidates.length === 1)
      return { balance: candidates[0].balance_amount }
    const labels = [
      ...new Set(candidates.map((row) => row.name).filter(Boolean)),
    ]
    return {
      issue:
        'Trade Republic ha comunicado varios saldos sin clasificar' +
        (labels.length ? ' (' + labels.join(', ') + ')' : '') +
        '. Wealth necesita identificar el saldo de efectivo.',
    }
  }
  const types = [
    ...new Set(
      candidates
        .map((row) => row.balance_type)
        .filter((type) => /^[A-Z]{4}$/.test(type)),
    ),
  ]
  return {
    issue:
      'El banco ha enviado un tipo de saldo que Wealth no puede incluir en el total' +
      (types.length ? ' (' + types.join(', ') + ').' : '.'),
  }
}

export function chooseBalance(rows, currency, bank) {
  return selectBalance(rows, currency, bank).balance ?? null
}

export async function readTransactions(api, uid, headers, from, bank) {
  const rows = []
  const seen = new Set()
  let cursor
  do {
    const query = new URLSearchParams({
      date_from: from,
      transaction_status: 'BOOK',
    })
    if (cursor) query.set('continuation_key', cursor)
    const page = await api(
      '/accounts/' + encodeURIComponent(uid) + '/transactions?' + query,
      { headers },
    )
    for (const tx of page.transactions) {
      const credit = tx.credit_debit_indicator === 'CRDT'
      const amount = tx.transaction_amount
      if (
        (tx.status && tx.status !== 'BOOK') ||
        !amount ||
        !['CRDT', 'DBIT'].includes(tx.credit_debit_indicator) ||
        !/^-?\d+(\.\d+)?$/.test(amount.amount)
      )
        continue
      const date = tx.booking_date || tx.value_date || tx.transaction_date
      if (!date) continue
      rows.push({
        ...(bank === 'trade' && tx.entry_reference
          ? { entryReference: createHash('sha256').update(String(tx.entry_reference)).digest('hex') }
          : {}),
        date,
        amount: Math.abs(Number(amount.amount)) * (credit ? 1 : -1),
        currency: amount.currency,
        title:
          (credit ? tx.debtor?.name : tx.creditor?.name) ||
          tx.remittance_information?.join(' ') ||
          tx.bank_transaction_code?.description ||
          'Movimiento bancario',
      })
    }
    cursor = page.continuation_key
    if (cursor && seen.has(cursor))
      throw new Problem(
        502,
        'El banco ha devuelto una página repetida de movimientos.',
      )
    seen.add(cursor)
  } while (cursor)
  return rows
}

async function updateBalance(account, api, headers, now, bank) {
  let result
  try {
    const response = await api('/accounts/' + encodeURIComponent(account.uid) + '/balances', { headers })
    result = selectBalance(response?.balances, account.currency, bank)
  } catch (error) {
    result = { issue: 'Saldo pendiente. ' + error.message }
  }
  if (result.balance) {
    account.amount = Number(result.balance.amount)
    account.currency = result.balance.currency
    account.balanceAt = now.toISOString()
    account.history[account.balanceAt.slice(0, 10)] = account.amount
    return ''
  }
  const previous = account.amount != null && account.balanceAt
    ? ' Se muestra el último saldo obtenido el ' + new Date(account.balanceAt).toLocaleDateString('es-ES') + '.'
    : ''
  return result.issue + previous
}

export async function syncBank(
  connection,
  api,
  headers,
  now = new Date(),
  bank,
  { balancesOnly = false } = {},
) {
  const from = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)
  const issues = []
  for (const account of connection.accounts) {
    const [balanceIssue, transactionIssue] = await Promise.all([
      updateBalance(account, api, headers, now, bank),
      balancesOnly ? undefined : readTransactions(api, account.uid, headers, from, bank).then(
        (rows) => { account.transactions = rows },
        (error) => 'Movimientos pendientes. ' + error.message,
      ),
    ])
    if (balanceIssue) issues.push(balanceIssue)
    if (transactionIssue) issues.push(transactionIssue)
  }
  connection.issue = [...new Set(issues)].join(' ')
  connection.synced = now.toISOString()
}
