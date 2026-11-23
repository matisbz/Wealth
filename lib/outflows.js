import { randomUUID } from 'node:crypto'

// Older vaults and some banks supply no entry reference. Match each occurrence
// once per complete account statement, including identical purchases on one day.
export function importOutflows(records, rows, source, initialFields = {}) {
  const existing = records.filter(d => d.source === source)
  const byReference = new Map(existing.filter(d => d.reference).map(d => [d.reference, d]))
  const signature = d => JSON.stringify([d.date, d.currency, d.amount, d.title])
  const byDetails = new Map()
  for (const record of existing) {
    const key = signature(record)
    if (!byDetails.has(key)) byDetails.set(key, [])
    byDetails.get(key).push(record)
  }
  const matched = new Set()
  rows.sort((a, b) => Number(!!b.entryReference) - Number(!!a.entryReference))
  for (const row of rows) {
    const details = { date: row.date, currency: row.currency, amount: -row.amount, title: row.title }
    const ref = row.entryReference
    let record = ref && byReference.get(ref)
    if (!record) {
      record = byDetails.get(signature(details))?.find(d => !matched.has(d) && (!ref || !d.reference))
    }
    if (!record) {
      record = { id: randomUUID(), source, ...details, ...initialFields }
      records.push(record)
    } else {
      Object.assign(record, details)
    }
    if (ref) {
      record.reference = ref
      byReference.set(ref, record)
    }
    matched.add(record)
  }
}
