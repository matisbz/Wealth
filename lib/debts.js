import { createHash } from 'node:crypto'

import { importOutflows } from './outflows.js'
import { Problem } from './banking.js'

export const firstWithdrawal = '2026-11-01'

export function repaymentMonth(date) {
  const [year, month] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7)
}

export function importWithdrawals(debts, account, source) {
  const rows = (account.transactions || []).filter(t => t.amount < 0 && Number.isFinite(t.amount) &&
    /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.date >= firstWithdrawal && /^[A-Z]{3}$/.test(t.currency))
  importOutflows(debts, rows, source, { paidAt: null })
}

export function publicDebt({ id, date, title, amount, currency, paidAt }) {
  return { id, date, title, amount, currency, paidAt, due: repaymentMonth(date) }
}

function repaymentGroups(store, now) {
  const currentMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now).slice(0, 7)
  const groups = new Map()
  function groupFor(month, currency) {
    const key = month + '/' + currency
    if (!groups.has(key)) {
      const digits = new Intl.NumberFormat('es', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
      groups.set(key, { key, month, currency, scale: 10 ** digits, balance: 0, carried: 0, paid: 0, payments: [], items: [] })
    }
    return groups.get(key)
  }
  for (const debt of store.debts || []) {
    const original = repaymentMonth(debt.date)
    const origin = groupFor(original, debt.currency)
    const amount = Math.round(debt.amount * origin.scale)
    if (debt.paidAt && debt.repaidMinor == null) {
      origin.paid += amount
      continue
    }
    const remaining = amount - (debt.repaidMinor || 0)
    if (remaining <= 0) continue
    const due = debt.nextDue || original
    const group = groupFor(due < currentMonth ? currentMonth : due, debt.currency)
    group.items.push({ id: debt.id, remaining })
    group.balance += remaining
    if (original < group.month) group.carried += remaining
  }
  for (const payment of store.debtPayments || []) {
    const group = groupFor(payment.month, payment.currency)
    group.paid += payment.paid
    group.payments.push({ at: payment.at, paid: payment.paid, deferred: payment.deferred })
  }
  for (const group of groups.values()) {
    group.version = createHash('sha256').update(JSON.stringify([group.key, group.items])).digest('hex')
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export function repaymentMonths(store, now = new Date()) {
  return repaymentGroups(store, now).map(({ items, ...summary }) => summary)
}

function partialAmount(value, scale) {
  const digits = Math.log10(scale)
  const text = typeof value === 'string' ? value.trim().replace(',', '.') : ''
  if (!/^\d+(?:\.\d+)?$/.test(text)) return NaN
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > digits) return NaN
  return Number(whole + fraction.padEnd(digits, '0'))
}

export function settleRepayment(store, input, now = new Date()) {
  const { month, currency, version, mode, amount } = input || {}
  if (mode !== 'total' && mode !== 'partial') throw new Problem(400, 'Elige un pago total o parcial.')
  const group = repaymentGroups(store, now).find(g => g.month === month && g.currency === currency)
  if (!group) throw new Problem(409, 'El total de este mes ha cambiado. Revisa el saldo actualizado.')
  const partial = mode === 'partial'
  const requested = partial ? partialAmount(amount, group.scale) : group.balance
  const previous = store.debtPayments?.find(p => p.version === version && p.month === month && p.currency === currency)
  if (previous && previous.mode === mode && (!partial || previous.paid === requested)) return false
  if (!group.balance || group.version !== version)
    throw new Problem(409, 'El total de este mes ha cambiado. Revisa el saldo actualizado.')
  if (!Number.isSafeInteger(requested) || requested <= 0 || (partial && requested >= group.balance))
    throw new Problem(400, 'Introduce un importe mayor que cero e inferior al total, con los decimales de la divisa.')

  const remainingById = new Map(group.items.map(item => [item.id, item.remaining]))
  const debts = store.debts.filter(d => remainingById.has(d.id)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const next = repaymentMonth(month)
  let available = requested
  for (const debt of debts) {
    const remaining = remainingById.get(debt.id)
    const applied = Math.min(remaining, available)
    debt.repaidMinor = (debt.repaidMinor || 0) + applied
    if (applied < remaining) {
      debt.nextDue = next
      debt.paidAt = null
    } else {
      debt.paidAt = now.toISOString()
    }
    available -= applied
  }
  store.debtPayments ??= []
  store.debtPayments.push({ month, currency, version, mode, at: now.toISOString(), paid: requested, deferred: group.balance - requested })
  return true
}
