export const banks = [
  {
    id: 'myinvestor',
    name: 'MyInvestor',
    aspsp: 'MyInvestor Banco',
    color: '#ffe338',
  },
  {
    id: 'trade',
    name: 'Trade Republic',
    aspsp: 'Trade Republic',
    color: '#c59a36',
  },
  {
    id: 'santander',
    name: 'Santander',
    aspsp: 'Banco Santander',
    color: '#f1e8ae',
  },
  { id: 'revolut', name: 'Revolut', aspsp: 'Revolut', color: '#95978a' },
]

// Older profiles used the same local source for imported and manually entered balances.
export function isLocalMyInvestor(connection) {
  return connection?.source === 'myinvestor' || connection?.source === 'manual'
}
