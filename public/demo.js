import { banks } from './banks.js'

export function demoConnections() {
  const amounts = [28450, 17820.5, 12350, 4220]
  const labels = [
    'Cuenta de ahorro',
    'Cuenta de efectivo',
    'Cuenta corriente',
    'Cuenta personal',
  ]
  const ends = ['4821', '9034', '1872', '6409']
  const dates = Array.from({ length: 91 }, (_, i) =>
    new Date(Date.now() - (90 - i) * 86400000).toISOString().slice(0, 10),
  )
  const values = [
    0, 0.08, 0.04, 0.18, 0.16, 0.26, 0.23, 0.4, 0.39, 0.51, 0.47, 0.63, 0.58,
    0.68, 0.66, 0.81, 0.74, 0.85, 0.83, 1,
  ]
  const rows = [
    [2, 'Nómina de noviembre', 'Ingreso', 2450, 0, 'briefcase'],
    [3, 'Spotify Premium', 'Suscripción', -10.99, 1, 'music'],
    [0, 'Transferencia recibida', 'Transferencia', 500, 1, 'receive'],
    [2, 'Mercadona', 'Alimentación', -64.28, 2, 'basket'],
    [1, 'Intereses del mes', 'Intereses', 26.41, 3, 'percent'],
    [3, 'Cafetería Central', 'Restauración', -6.4, 4, 'coffee'],
    [2, 'Renfe', 'Transporte', -27.9, 8, 'train'],
    [0, 'Aportación de ahorro', 'Transferencia', 800, 12, 'receive'],
  ]
  return banks.map((b, i) => {
    const history = Object.fromEntries(
      dates.map((d, j) => {
        const t = (j * (values.length - 1)) / 90,
          n = Math.floor(t)
        const v = values[n] + ((values[n + 1] ?? 1) - values[n]) * (t - n)
        return [
          d,
          Math.round(
            (amounts[i] * (0.79 + 0.21 * v) +
              Math.sin(j * 1.7) * Math.sin((Math.PI * j) / 90) * 150) *
              100,
          ) / 100,
        ]
      }),
    )
    return {
      bank: b.id,
      accounts: [
        {
          id: 'demo-' + b.id,
          title: labels[i],
          last4: ends[i],
          currency: 'EUR',
          amount: amounts[i],
          history,
          transactions: rows
            .filter((r) => r[0] === i)
            .map(([, title, category, amount, ago, icon]) => ({
              title: title.startsWith('Nómina')
                ? 'Nómina de ' +
                  new Intl.DateTimeFormat('es', { month: 'long' }).format(
                    new Date(),
                  )
                : title,
              category,
              amount,
              date: dates[90 - ago],
              currency: 'EUR',
              icon,
            })),
        },
      ],
    }
  })
}
