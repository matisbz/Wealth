export function portfolioFunds({ units, names = {} }) {
  return Object.keys(units).map(isin => ({ isin, name: names[isin] || 'Fondo' }))
}

export function parseUnits(value) {
  if (typeof value !== 'string') return NaN
  const text = value.trim()
  if (!text) return 0
  // A single separator is decimal. Spanish thousands groups require a decimal comma.
  const normalized = /^\d{1,3}(?:\.\d{3})+,\d+$/.test(text) ? text.replaceAll('.', '') : text
  if (!/^\d{1,9}(?:[.,]\d{1,12})?$/.test(normalized)) return NaN
  return Number(normalized.replace(',', '.'))
}

export function fundAmount(units, quote) {
  if (units === 0) return 0
  return Number.isFinite(units) && quote?.nav > 0 ? units * quote.nav : null
}

export function portfolioAmount(units, quotes) {
  let total = 0
  for (const isin of Object.keys(units)) {
    const amount = fundAmount(units[isin], quotes[isin])
    if (amount == null) return null
    total += amount
  }
  return Math.round(total * 100) / 100
}
