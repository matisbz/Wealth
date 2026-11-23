import { portfolioFunds, fundAmount } from './funds.js'
import { banks, isLocalMyInvestor } from './banks.js'
import { demoConnections } from './demo.js'
import { icon } from './icons.js'

const $ = (selector) => document.querySelector(selector)
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  )
const nav = {
  resumen: { label: 'Resumen', title: 'Resumen financiero' },
  cuentas: { label: 'Mis cuentas' },
  reparto: { label: 'Reparto de cuentas', disabled: true },
  deudas: { label: 'Deudas' },
  inversion: { label: 'Inversión' },
  movimientos: { label: 'Movimientos' },
  conexiones: { label: 'Conexiones' },
}
const bankOf = (id) => banks.find((b) => b.id === id)
const example = demoConnections().filter((c) => c.bank !== 'myinvestor')
const dialog = $('#dialog')
let dashboard,
  period = 30,
  hidden = localStorage.getItem('wealth-privacy') === '1',
  currency = 'EUR',
  search = '',
  filter = '',
  ledgerPage = 0
let view,
  selectedBank = '',
  toastTimer,
  busy = false
const moneyFormats = new Map()
function fmt(value, unit = currency) {
  if (hidden) return '••••'
  if (value == null) return 'Saldo no disponible'
  unit ||= 'EUR'
  if (!moneyFormats.has(unit)) {
    moneyFormats.set(unit, new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: unit,
      useGrouping: 'always',
    }))
  }
  return moneyFormats.get(unit).format(value)
}
const num = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let counterFrame, activeCounterTiming

function formatCounter(value, unit) {
  if (hidden && unit !== 'count') return '••••'
  if (unit === 'units') return unitsFormat.format(value)
  if (unit === '%') return num(value) + ' %'
  if (unit === 'count') return String(Math.round(value))
  return fmt(value, unit)
}

function counter(value, unit = currency) {
  const text = esc(formatCounter(value, unit))
  if (hidden || !Number.isFinite(value) || value === 0) return text
  return '<span data-count-to="' + value + '" data-unit="' + esc(unit) + '">' + text + '</span>'
}

function animateCounters(timing = { delay: 0 }) {
  if (hidden || reducedMotion.matches) return
  cancelAnimationFrame(counterFrame)
  const counters = Array.from(document.querySelectorAll('#main [data-count-to]'), node => {
    const value = Number(node.dataset.countTo)
    const unit = node.dataset.unit
    const finalText = formatCounter(value, unit)
    const accessible = document.createElement('span')
    accessible.className = 'sr'
    accessible.textContent = finalText
    const visible = document.createElement('span')
    visible.setAttribute('aria-hidden', 'true')
    visible.textContent = formatCounter(0, unit)
    node.replaceChildren(accessible, visible)
    return { node, visible, value, unit, finalText }
  })
  if (!counters.length) return

  activeCounterTiming = timing
  function tick(now) {
    timing.start ??= now + timing.delay
    const elapsed = Math.max(0, now - timing.start)
    const progress = reducedMotion.matches ? 1 : Math.min(1, elapsed / 1200)
    const fraction = 1 - (1 - progress) ** 2
    for (const { node, visible, value, unit, finalText } of counters) {
      if (progress === 1) node.textContent = finalText
      else visible.textContent = formatCounter(fraction === 0 ? 0 : value * fraction, unit)
    }
    if (progress < 1) counterFrame = requestAnimationFrame(tick)
    else activeCounterTiming = undefined
  }
  if (timing.start === undefined) counterFrame = requestAnimationFrame(tick)
  else tick(performance.now())
}
const fmtDate = (s, options = { day: 'numeric', month: 'short' }) =>
  new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(
    'es-ES',
    options,
  )
const demo = () => !dashboard.configured && dashboard.connections.length === 0
const data = () => (demo() ? example : dashboard.connections)
const bankLogo = (id, size = '') =>
  '<img class="logo ' + size + '" src="/assets/' + id + '.png" alt="">'
const button = (action, text, symbol, cls = '') =>
  '<button class="btn ' +
  cls +
  '" data-action="' +
  action +
  '">' +
  (symbol ? icon(symbol, 17) : '') +
  text +
  '</button>'
function message(text) {
  clearTimeout(toastTimer)
  $('#toast').textContent = text
  $('#toast').classList.add('show')
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 6500)
}
async function request(path, body) {
  const r = await fetch(
    '/api/' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  const value = await r.json()
  if (!r.ok) throw Object.assign(new Error(value.error), { status: r.status })
  return value
}
async function load() {
  dashboard = await request('dashboard')
  render({ counterTiming: activeCounterTiming })
}
const accounts = () =>
  data().flatMap((c) =>
    c.accounts.map((a) => ({
      ...a,
      title: (demo() && localStorage.getItem('wealth-name-' + a.id)) || a.title,
      bank: c.bank,
      carryForward: isLocalMyInvestor(c),
    })),
  )
function getCurrencyOptions() {
  return [
    ...new Set(
      accounts()
        .map((a) => a.currency)
        .filter(Boolean),
    ),
  ]
}
function getTotals() {
  return banks.map((b) => {
    const ac = accounts().filter(
      (a) => a.bank === b.id && a.currency === currency && a.amount != null,
    )
    return {
      ...b,
      amount: ac.reduce((s, a) => s + a.amount, 0),
      count: ac.length,
    }
  })
}
function currencySelect() {
  const options = getCurrencyOptions()
  return options.length > 1
    ? '<select aria-label="Divisa del saldo total" id="currency">' +
        options
          .map(
            (c) =>
              '<option ' +
              (c === currency ? 'selected' : '') +
              '>' +
              esc(c) +
              '</option>',
          )
          .join('') +
        '</select>'
    : ''
}
function render({ entering = !view, counterTiming } = {}) {
  const firstRender = !view
  cancelAnimationFrame(counterFrame)
  activeCounterTiming = undefined
  const hash = location.hash.slice(1)
  view = Object.hasOwn(nav, hash) ? hash : 'resumen'
  if (nav[view].disabled) {
    view = 'resumen'
    history.replaceState(null, '', '#resumen')
  }
  if (!getCurrencyOptions().includes(currency))
    currency = getCurrencyOptions()[0] || 'EUR'
  const pageName = nav[view].title || nav[view].label
  document.title = 'Wealth · ' + pageName
  $('#nav').innerHTML = Object.entries(nav)
    .map(
      ([id, {label, disabled}]) => disabled
        ? `<span aria-disabled="true">${label}</span>`
        : `<a href="#${id}" ${view === id ? 'aria-current="page"' : ''}>${label}</a>`,
    )
    .join('')
  $('#nav').classList.remove('open')
  const privacyLabel = hidden ? 'Mostrar importes' : 'Ocultar importes'
  const sandboxBadge = dashboard.configured && dashboard.environment === 'SANDBOX'
    ? `<span class="mode">${icon('shield', 14)}Sandbox</span>`
    : ''
  $('#top').innerHTML = `${sandboxBadge}
    <button class="eye" data-action="privacy" aria-label="${privacyLabel}" aria-pressed="${hidden}">
      ${icon(hidden ? 'hidden' : 'eye', 18)}<span>${privacyLabel}</span>
    </button>
    <button class="menu" data-action="menu" aria-label="Menú de navegación" aria-controls="nav" aria-expanded="false">
      ${icon('menu', 20)}
    </button>`
  $('#main').innerHTML = pageContent(pageName)
  if (entering || counterTiming) {
    animateCounters(counterTiming ?? { delay: firstRender ? 200 : 0 })
  }
}

function pageContent(pageName) {
  if (view === 'inversion') return investmentsPage()
  if (view === 'deudas') return debtsPage()
  const lead =
    view === 'resumen'
      ? new Intl.DateTimeFormat('es-ES', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }).format(new Date())
      : {
          cuentas: 'Saldos y detalles de tus cuentas bancarias.',
          movimientos: 'Actividad de los últimos 90 días.',
          conexiones: 'Gestiona el acceso de lectura a tus entidades.',
        }[view]
  const title =
    '<div class="page-title"><div><h1>' +
    pageName +
    '</h1><p class="page-sub">' +
    esc(lead) +
    '</p></div>' +
    (view === 'cuentas' || view === 'conexiones' ? button('connect', 'Conectar banco', 'plus', 'primary') : '') +
    '</div>'
  let body = ''
  if (view === 'resumen')
    body = summary() + '<div class="overview-lists"><section>' +
      sectionTitle('Mis cuentas', 'cuentas', 'Ver cuentas') + bankList() +
      '</section><section>' + sectionTitle('Últimos movimientos', 'movimientos', 'Ver todos') +
      ledger(true) + '</section></div>'
  if (view === 'cuentas') body = accountsPage()
  if (view === 'movimientos') body = ledger(false)
  if (view === 'conexiones') body = connectionsPanel()
  const issues =
    !demo() && view === 'resumen'
      ? data()
          .filter((c) => c.issue || expired(c))
          .map(
            (c) =>
              '<p class="warning">' +
              esc(bankOf(c.bank).name) +
              ' · ' +
              esc(
                expired(c)
                  ? 'El consentimiento ha caducado. Renuévalo en Conexiones.'
                  : c.issue,
              ) +
              '</p>',
          )
          .join('')
      : ''
  return title + issues + body
}
const expired = (c) => c?.expires && Date.parse(c.expires) <= Date.now()
function sectionTitle(title, href, label) {
  return (
    '<div class="section-title"><h2>' +
    title +
    '</h2><a class="more" href="#' +
    href +
    '">' +
    label +
    icon('next', 14) +
    '</a></div>'
  )
}
function series() {
  const ac = accounts().filter((a) => a.currency === currency)
  if (!ac.length) return []
  const cutoff = new Date(Date.now() - (period - 1) * 86400000)
    .toISOString()
    .slice(0, 10)
  const automatic = ac.filter((a) => !a.carryForward)
  const manual = ac.filter(a => a.carryForward).map(a => ({
    entries: Object.entries(a.history).sort(([left], [right]) => left.localeCompare(right)),
    index: 0, amount: undefined,
  }))
  const dates = automatic.length ? Object.keys(automatic[0].history).sort()
    : [...new Set(manual.flatMap(a => a.entries.map(([day]) => day)))].sort()
  const points = []
  for (const day of dates) {
    for (const account of manual) {
      while (account.entries[account.index]?.[0] <= day)
        account.amount = account.entries[account.index++][1]
    }
    if (day < cutoff || manual.some(a => a.amount === null) ||
        (manual.length && manual.every(a => a.amount === undefined)) ||
        !automatic.every(a => Number.isFinite(a.history[day]))) continue
    const carried = manual.reduce((sum, a) => sum + (a.amount ?? 0), 0)
    points.push([day, automatic.reduce((sum, a) => sum + a.history[day], carried)])
  }
  return points
}
function balanceTotal() {
  const balances = accounts().filter(a => a.currency === currency)
  const known = balances.filter(a => a.amount != null)
  const total = known.reduce((sum, a) => sum + a.amount, 0)
  return `<div class="balance-label"><h2>Saldo total</h2>${currencySelect()}</div>
    <div class="balance-amount">${known.length ? counter(total) : '—'}</div>
    ${known.length < balances.length ? '<small>Saldo parcial</small>' : ''}`
}

function summary() {
  const points = series()
  const delta = points.length >= 2 && points[0][1] !== 0
    ? (points.at(-1)[1] - points[0][1]) * 100 / Math.abs(points[0][1])
    : null
  const change = !hidden && delta != null
    ? `<p class="delta"><strong>${delta >= 0 ? '+' : ''}${counter(delta, '%')}</strong> en los últimos ${period} días</p>`
    : ''
  const periods = [[7, '7D'], [30, '1M'], [90, '3M']].map(([days, label]) =>
    `<button data-period="${days}" aria-label="${days} días" aria-pressed="${days === period}">${label}</button>`
  ).join('')
  return `<section class="balance"><div>${balanceTotal()}${change}</div>
    <div><div class="chart-head"><h2>Evolución del saldo</h2>
      <div class="period" role="group" aria-label="Periodo del saldo">${periods}</div>
    </div>${chart(points)}</div></section>`
}
function chart(points) {
  if (hidden || points.length < 2)
    return (
      '<div class="chart-empty">' +
      (hidden
        ? 'Importes ocultos'
        : points.length
          ? 'La evolución aparecerá tras la próxima actualización en otro día.'
          : 'La evolución aparecerá al sincronizar tus cuentas.') +
      '</div>'
    )
  const amounts = points.map((p) => p[1]),
    min = Math.min(...amounts),
    max = Math.max(...amounts)
  const span = max - min || Math.max(10, Math.abs(max) * 0.01),
    low = min - span * 0.13,
    high = max + span * 0.13
  const firstDay = Date.parse(points[0][0]),
    elapsed = Date.parse(points.at(-1)[0]) - firstDay
  const x = (i) => 8 + ((Date.parse(points[i][0]) - firstDay) / elapsed) * 590,
    y = (n) => 10 + ((high - n) / (high - low)) * 114
  const coords = amounts.map((n, i) => [x(i), y(n)])
  // Cubic interpolation with horizontal tangents keeps local extrema within their observed range.
  const line = coords.reduce((path, [px, py], i) => {
    if (!i) return 'M' + px + ' ' + py
    const [lx, ly] = coords[i - 1],
      mid = (lx + px) / 2
    return (
      path + ' C' + mid + ' ' + ly + ' ' + mid + ' ' + py + ' ' + px + ' ' + py
    )
  }, '')
  const tick = (n) =>
    new Intl.NumberFormat('es-ES', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n)
  const last = coords.at(-1)
  return (
    '<div class="chart" role="img" aria-label="Evolución del saldo. ' +
    esc(fmtDate(points[0][0])) +
    ' ' +
    esc(fmt(amounts[0])) +
    '. ' +
    esc(fmtDate(points.at(-1)[0])) +
    ' ' +
    esc(fmt(amounts.at(-1))) +
    '"><div class="plot"><div class="y-axis">' +
    [high, (high + low) / 2, low]
      .map((n) => '<span>' + esc(tick(n)) + '</span>')
      .join('') +
    '</div><svg viewBox="0 0 610 137" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="wash" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".13"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".03"/></linearGradient></defs>' +
    [10, 67, 124]
      .map(
        (h) =>
          '<path d="M0 ' +
          h +
          'H610" stroke="var(--edge)" stroke-dasharray="3 5" stroke-opacity=".7"/>',
      )
      .join('') +
    '<g class="balance-series"><path d="' +
    line +
    ' V133 H8 Z" fill="url(#wash)"/><path d="' +
    line +
    '" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>' +
    '<path d="M' + last[0] + ' ' + last[1] + 'h0" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke"/></g></svg></div><div class="x-axis">' +
    [0, 0.5, 1]
      .map(
        (f) =>
          '<span>' +
          fmtDate(new Date(firstDay + f * elapsed).toISOString().slice(0, 10)) +
          '</span>',
      )
      .join('') +
    '</div></div>'
  )
}
function bankList() {
  const totals = getTotals()
  const positive = totals.reduce((sum, b) => sum + Math.max(0, b.amount), 0)
  const all = accounts()
  const rows = totals.map(b => {
    const ac = all.filter(a => a.bank === b.id)
    const manual = b.id === 'myinvestor'
    const label = ac.length > 1 ? ac.length + ' cuentas' : ac[0]?.title
    const detail = label || (manual ? 'Cartera de fondos' : 'Pendiente de conexión')
    const share = b.count && positive ? Math.max(0, b.amount) / positive * 100 : null
    const fraction = hidden || share == null ? '—'
      : `${counter(share, '%')}<span class="track"><i style="width:${share}%"></i></span>`
    let amount = manual ? 'Consultar fondos' : 'Vincular cuenta'
    if (b.count) amount = counter(b.amount)
    else if (ac.length === 1 && ac[0].amount != null) amount = counter(ac[0].amount, ac[0].currency)
    else if (ac.length) amount = 'Ver saldos'
    return `<button class="bank-line" data-bank="${b.id}">
      <span class="entity">${bankLogo(b.id)}<span><b>${b.name}</b><small>${esc(detail)}</small></span></span>
      <span class="share">${fraction}</span><span class="bank-amount">${amount}</span>${icon('next', 13)}</button>`
  }).join('')
  return `<div class="bank-head"><span>Entidad</span><span>Reparto</span><span>Saldo</span></div>${rows}`
}

function accountsPage() {
  const all = accounts()
  const rows = banks.map(b => {
    const ac = all.filter(a => a.bank === b.id)
    if (!ac.length) {
      const manual = b.id === 'myinvestor'
      return `<div class="detail-row"><span>${bankLogo(b.id)}<span><b>${b.name}</b>
        <small>${manual ? 'Cartera de fondos' : 'Pendiente de conexión'}</small></span></span>
        <button class="text-button" data-bank="${b.id}">${manual ? 'Consultar fondos' : 'Vincular cuenta'}</button></div>`
    }
    return ac.map(a => accountRow(a, true)).join('')
  }).join('')
  const entities = new Set(all.map(a => a.bank)).size
  return `<section class="accounts-total"><div>${balanceTotal()}</div>
    <p class="muted">${counter(all.length, 'count')} ${all.length === 1 ? 'cuenta' : 'cuentas'} en ${counter(entities, 'count')} ${entities === 1 ? 'entidad' : 'entidades'}</p>
    </section><div class="account-labels"><span>Entidad y cuenta</span><span>Saldo</span></div>${rows}`
}
function renameButton(a) {
  return '<button type="button" class="btn rename" data-rename="' +
    esc(a.id) + '" aria-label="Renombrar ' + esc(a.title) +
    '">Renombrar</button>'
}
function accountRow(a, onPage = false) {
  const bank = bankOf(a.bank).name
  const detail = (onPage ? a.title : bank) + (a.last4 ? ' · •• ' + a.last4 : '')
  const entity = bankLogo(a.bank) + '<span><b>' + esc(onPage ? bank : a.title) +
    '</b><small>' + esc(detail) + '</small></span>'
  const name = onPage ? `<button class="entity" data-bank="${esc(a.bank)}">${entity}</button>` : `<span class="entity">${entity}</span>`
  return `<div class="detail-row">${name}<div class="account-actions"><strong>${onPage ? counter(a.amount, a.currency) : esc(fmt(a.amount, a.currency))}</strong>
    ${renameButton(a)}</div></div>`
}
function renameForm(id, fromDetail) {
  const account = accounts().find((a) => a.id === id)
  if (!account) return
  modal(
    'Renombrar cuenta',
    '<form id="rename-account"><label>Nombre de la cuenta<input name="accountName" required maxlength="80" aria-describedby="modal-error" value="' +
      esc(account.title) + '"></label><button class="btn primary" type="submit">Guardar nombre</button></form>',
  )
  const form = $('#rename-account')
  form.elements.accountName.focus()
  form.elements.accountName.select()
  form.onsubmit = (event) => {
    event.preventDefault()
    locked(async () => {
      const name = form.elements.accountName.value.trim()
      if (!name) throw new Error('Introduce un nombre para la cuenta.')
      if (demo()) {
        localStorage.setItem('wealth-name-' + id, name)
        render()
      } else {
        await request('accounts/rename', { bank: account.bank, id, name })
        await load()
      }
      if (fromDetail) accountDetail(account.bank)
      else dialog.close()
      const scope = fromDetail ? dialog : document
      scope.querySelector('[data-rename="' + CSS.escape(id) + '"]')?.focus()
      message('Nombre de la cuenta guardado.')
    })
  }
}
function ledger(compact) {
  const toolbar = compact
    ? ''
    : '<div class="filters"><label>' +
      icon('search', 17) +
      '<span class="sr">Buscar movimiento</span><input id="search" type="search" placeholder="Buscar movimiento" value="' +
      esc(search) +
      '"></label><select id="bank-filter" aria-label="Filtrar por entidad"><option value="">Todas las entidades</option>' +
      banks
        .map(
          (b) =>
            '<option value="' +
            b.id +
            '" ' +
            (filter === b.id ? 'selected' : '') +
            '>' +
            b.name +
            '</option>',
        )
        .join('') +
      '</select></div>'
  return (
    '<div class="ledger' + (compact ? ' compact' : '') + '">' +
    toolbar +
    '<div id="tx-list">' +
    ledgerRows(compact) +
    '</div></div>'
  )
}
function ledgerRows(compact) {
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
  const all = accounts()
    .flatMap((a) => a.transactions.map((t) => ({ ...t, bank: a.bank })))
    .filter((t) => t.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
  const list = compact
    ? all
    : all.filter(
        (t) =>
          (!filter || filter === t.bank) &&
          t.title
            .toLocaleLowerCase('es')
            .includes(search.toLocaleLowerCase('es')),
      )
  const count = compact ? 4 : 15,
    offset = compact ? 0 : ledgerPage * count
  return (
    '<table><thead><tr><th>Concepto</th><th>Entidad</th><th>Fecha</th><th>Importe</th></tr></thead><tbody>' +
    list
      .slice(offset, offset + count)
      .map(
        (t) =>
          '<tr><td><div class="tx-name"><span class="tx-icon ' +
          (t.amount > 0 ? 'credit' : '') +
          '">' +
          icon(t.icon || (t.amount > 0 ? 'receive' : 'moves'), 18) +
          '</span><span><b>' +
          esc(t.title) +
          '</b><small>' +
          (compact ? esc(fmtDate(t.date)) + ' · ' + bankOf(t.bank).name :
            esc(t.category || (t.amount >= 0 ? 'Ingreso' : 'Cargo')) +
            '<span class="mobile-bank"> · ' + bankOf(t.bank).name + ' · ' + esc(fmtDate(t.date)) + '</span>') +
          '</small></span></div></td><td>' +
          bankOf(t.bank).name +
          '</td><td>' +
          esc(fmtDate(t.date)) +
          '</td><td class="' +
          (t.amount > 0 ? 'positive' : '') +
          '">' +
          (!hidden && t.amount > 0 ? '+' : '') +
          counter(t.amount, t.currency) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table>' +
    (!list.length
      ? '<p class="empty">Sin movimientos para esta selección.</p>'
      : '') +
    (!compact && list.length > count
      ? '<div class="pager"><button data-page="-1" ' +
        (!offset ? 'disabled' : '') +
        '>Anterior</button><span>' +
        String(ledgerPage + 1) +
        ' de ' +
        Math.ceil(list.length / count) +
        '</span><button data-page="1" ' +
        (offset + count >= list.length ? 'disabled' : '') +
        '>Siguiente</button></div>'
      : '')
  )
}
function investmentsPage() {
  const connection = myInvestor()
  const header = '<div class="page-title"><div><h1>Inversión</h1><p class="page-sub">Cartera de fondos de MyInvestor</p></div>' +
    bankLogo('myinvestor') + '</div>'
  const manage = '<button class="btn" data-manage="myinvestor">Ver MyInvestor</button>'
  if (!connection?.portfolio)
    return header + '<p class="empty">Consulta MyInvestor y guarda tus posiciones para ver el reparto de tus fondos.</p>' + manage

  const { units, quotes } = connection.portfolio
  const positions = portfolioFunds(connection.portfolio).map(({ name, isin }) => ({
    name, isin, shares: units[isin], quote: quotes[isin], amount: fundAmount(units[isin], quotes[isin]),
  }))
  const complete = positions.every(p => Number.isFinite(p.amount))
  const total = complete ? positions.reduce((sum, p) => sum + p.amount, 0) : null
  const pending = 'Pendiente de cotización'
  const summary = '<section class="accounts-total"><div><h2>Valor total de los fondos</h2>' +
    (complete ? '<p class="balance-amount">' + counter(total, 'EUR') + '</p>' : '<p>' + pending + '</p>') +
    (connection.directReadAt ? '<small>Posiciones del ' + esc(fmtDate(connection.directReadAt, { dateStyle: 'long' })) + '</small>' : '') +
    '</div>' + manage + '</section>'
  const rows = positions.map(({ name, isin, shares, quote, amount }) => {
    const weight = total > 0 ? 100 * amount / total : null
    const bar = !hidden && weight != null ? '<span class="track" aria-hidden="true"><i style="width:' + weight + '%"></i></span>' : ''
    const priceDate = quote ? '<small>' + esc(bankPriceLabel(quote)) + '</small>' : ''
    return '<li><div class="fund-identity"><h3>' + esc(name) + '</h3><small>' + esc(isin) + '</small></div>' +
      '<dl class="fund-metrics"><div><dt>Participaciones</dt><dd>' + counter(shares, 'units') + '</dd></div>' +
      '<div><dt>Valor estimado</dt><dd>' + (amount == null ? pending : counter(amount, 'EUR')) + priceDate + '</dd></div>' +
      '<div><dt>Peso</dt><dd>' + (weight == null ? '—' : counter(weight, '%')) + bar + '</dd></div></dl></li>'
  }).join('')
  return header + summary + '<section><h2>Distribución por fondo</h2><ul class="fund-distribution">' + rows + '</ul></section>'
}

function monthName(month, withYear = false) {
  return new Intl.DateTimeFormat('es-ES', {
    month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(new Date(month + '-01T12:00:00Z'))
}

let selectedRepayment = ''
function nextRepaymentMonth(month) {
  const [year, number] = month.split('-').map(Number)
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7)
}

function debtsPage() {
  const groups = dashboard.debtMonths || []
  const connection = dashboard.connections.find(c => c.bank === 'trade')
  const issue = expired(connection) ? 'Renueva el consentimiento de Trade Republic en Conexiones.' : connection?.issue
  let html = '<div class="page-title"><div><h1>Deudas</h1><p class="page-sub">Colchón de emergencia de Trade Republic</p></div>' +
    bankLogo('trade') + '</div>' + (issue ? '<p class="warning">' + esc(issue) + '</p>' : '')
  if (!groups.length) {
    return html + '<p class="empty">' + (connection
      ? 'Sin salidas registradas desde el 1 de noviembre de 2026.'
      : 'Vincula Trade Republic en <a href="#conexiones">Conexiones</a> para registrar las salidas del colchón.') + '</p>'
  }
  const group = groups.find(g => g.key === selectedRepayment) || groups.find(g => g.balance > 0) || groups.at(-1)
  selectedRepayment = group.key
  const money = minor => counter(minor / group.scale, group.currency)
  const options = groups.map(g => '<option value="' + esc(g.key) + '"' + (g.key === group.key ? ' selected' : '') + '>' +
    esc(monthName(g.month, true) + ' · ' + g.currency) + '</option>').join('')
  const disabled = group.balance > 0 ? '' : ' disabled'
  html += '<section class="repayment"><label>Mes de reposición <select id="repayment-month">' +
    options + '</select></label><div class="debt-totals"><div><h2>Pendiente de reponer</h2><p class="debt-amount">' +
    money(group.balance) + '</p></div><div><h2>Pagado en esta reposición</h2><p class="debt-amount">' +
    money(group.paid) + '</p></div>' +
    '<div class="modal-actions"><button class="btn primary" data-settle="total"' + disabled + '>Pago total</button>' +
    '<button class="btn" data-settle="partial"' + disabled + '>Pago parcial</button></div></div>' +
    (group.carried ? '<p class="muted">El pendiente incluye ' + money(group.carried) + ' de meses anteriores.</p>' : '') + '</section>'
  if (group.payments.length) {
    html += '<section class="debt-group"><h2>Pagos registrados</h2><ul class="debt-list">' +
      [...group.payments].reverse().map(p => '<li><div><b>' + (p.deferred ? 'Pago parcial' : 'Pago total') + '</b><small>' +
        esc(fmtDate(p.at, { dateStyle: 'long' })) + '</small>' + (p.deferred ? '<small>' + money(p.deferred) +
        ' trasladados a ' + monthName(nextRepaymentMonth(group.month), true) + '</small>' : '') +
        '</div><span class="debt-value">' + money(p.paid) + '</span></li>').join('') + '</ul></section>'
  }
  const rows = dashboard.debts.filter(d => d.due === group.month && d.currency === group.currency)
    .sort((a, b) => b.date.localeCompare(a.date))
  if (rows.length) {
    html += '<section class="debt-group"><h2>Salidas que vencen en ' + monthName(group.month) +
      '</h2><ul class="debt-list">' + rows.map(d =>
        '<li><span class="debt-description"><b>' + esc(d.title) + '</b><small>' +
        esc(fmtDate(d.date, { dateStyle: 'long' })) + '</small></span><span class="debt-value">' +
        counter(d.amount, d.currency) + '</span></li>').join('') + '</ul></section>'
  }
  return html
}

function recordRepayment(group, mode, amount) {
  locked(async () => {
    try {
      await request('debts/settle', { month: group.month, currency: group.currency, version: group.version, mode, amount })
    } catch (error) {
      if (error.status === 409) {
        if (dialog.open) dialog.close()
        await load()
      }
      throw error
    }
    if (dialog.open) dialog.close()
    await load()
    $('#repayment-month')?.focus()
    message(mode === 'total' ? 'Pago total registrado.' : 'Pago parcial registrado. El resto pasa a ' +
      monthName(nextRepaymentMonth(group.month)) + '.')
  })
}

function chooseRepayment(mode) {
  if (busy) return
  const group = dashboard.debtMonths.find(g => g.key === selectedRepayment)
  if (!group?.balance) return
  if (mode === 'total') return recordRepayment(group, mode)
  modal('Pago parcial de ' + monthName(group.month), '<p>Pendiente de reponer: ' +
    esc(fmt(group.balance / group.scale, group.currency)) + '. El resto pasará a ' +
    monthName(nextRepaymentMonth(group.month), true) + '.</p><form id="partial-repayment"><label>Importe pagado (' +
    esc(group.currency) + ')<input name="amount" type="text" inputmode="decimal" required autocomplete="off" ' +
    'aria-describedby="modal-error"></label><button class="btn primary" type="submit">Registrar pago parcial</button></form>')
  const form = $('#partial-repayment')
  form.elements.amount.focus()
  form.onsubmit = e => {
    e.preventDefault()
    recordRepayment(group, mode, form.elements.amount.value)
  }
}

function connectionsPanel() {
  const settings =
    dashboard.configured &&
    !dashboard.connections.some((c) => !isLocalMyInvestor(c))
      ? button('setup', 'Cambiar aplicación', 'link')
      : ''
  const rows = banks.map(b => {
    const c = dashboard.connections.find(c => c.bank === b.id)
    const manual = b.id === 'myinvestor' && (!c || isLocalMyInvestor(c))
    const stale = expired(c)
    const status = c?.directReadAt ? 'Consulta puntual' : manual ? (c ? 'Datos anteriores' : 'Disponible') : stale ? 'Consentimiento caducado' : c ? 'Activa' : 'Sin vincular'
    const detail = manual ? (c?.portfolio ? 'Cartera de fondos' : c ? 'Último saldo guardado' : 'Consulta directa de MyInvestor')
      : c?.expires ? (stale ? 'Caducó el ' : 'Hasta el ') + fmtDate(c.expires, { dateStyle: 'medium' }) : ''
    const last = c?.directReadAt || (manual ? c?.accounts[0]?.balanceAt : c?.synced)
    const action = stale ? 'Renovar acceso' : manual || c ? 'Gestionar' : 'Conectar'
    const entity = bankLogo(b.id) + '<b>' + b.name + '</b>'
    return `<tr><td>${stale ? `<button class="entity" data-manage="${b.id}" aria-label="Gestionar ${b.name}">${entity}</button>` : `<span class="entity">${entity}</span>`}</td>
      <td><b class="${stale ? 'attention' : ''}">${status}</b><small>${esc(detail)}</small></td>
      <td><span class="mobile-label">Última actualización · </span>${last ? esc(fmtDate(last, {dateStyle:'medium'})) : '—'}</td>
      <td><button class="text-button" ${stale ? 'data-renew' : 'data-manage'}="${b.id}">${action}</button></td></tr>`
  }).join('')
  const active = dashboard.connections.filter(c => !isLocalMyInvestor(c) && !expired(c)).length
  const status = active === 1 ? 'conexión bancaria activa' : 'conexiones bancarias activas'
  return `<p class="connection-count">${counter(active, 'count')} ${status}</p>` + settings + `<table class="connections"><thead><tr><th>Entidad</th><th>Estado</th><th>Última actualización</th>
    <th><span class="sr">Acción</span></th></tr></thead><tbody>${rows}</tbody></table>`
}
function modal(title, body) {
  $('#modal').innerHTML =
    '<div class="modal-head"><h2 id="dialog-title">' +
    esc(title) +
    '</h2><button class="eye" data-action="close" aria-label="Cerrar">' +
    icon('close', 19) +
    '</button></div>' +
    body +
    '<p id="modal-error" role="alert"></p>'
  if (!dialog.open) dialog.showModal()
  else dialog.querySelector('[data-action="close"]').focus()
}
function chooseBank() {
  modal(
    'Conectar banco',
    '<p>Elige la entidad que quieres conectar con acceso de lectura.</p><div class="bank-list">' +
      banks
        .map(
          (b) =>
            '<button data-manage="' +
            b.id +
            '">' +
            bankLogo(b.id) +
            '<b>' +
            b.name +
            '</b>' +
            icon('next', 16) +
            '</button>',
        )
        .join('') +
      '</div>',
  )
}
function setup() {
  modal(
    'Configurar Enable Banking',
    '<ol class="steps"><li>Registra tu aplicación con el servicio de información de cuentas (AIS). <a href="https://enablebanking.com/cp/applications" target="_blank" rel="noreferrer">Abrir Enable Banking</a></li><li>Copia esta dirección HTTPS en «Allowed redirect URLs».<code>' +
      esc(dashboard.callback) +
      '</code></li><li>Para usar tus cuentas reales, elige producción y vincula cada cuenta en el panel del proveedor.</li></ol><form id="setup"><label>Clave privada de la aplicación (.pem)<input name="pem" type="file" accept=".pem" required></label><label>Application ID<input name="applicationId" autocomplete="off" spellcheck="false" placeholder="Identificador de tu aplicación" required></label><p class="muted">Wealth guarda la clave en este Mac para firmar las consultas a Enable Banking.</p><button class="btn primary" type="submit">Verificar aplicación</button></form>',
  )
}
const myInvestor = () => dashboard.connections.find(c => c.bank === 'myinvestor')
const unitsFormat = new Intl.NumberFormat('es-ES', { useGrouping: false, maximumFractionDigits: 12 })
const navFormat = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 8 })

function bankPriceLabel(quote) {
  if (!quote) return 'VL pendiente de MyInvestor'
  return 'VL ' + navFormat.format(quote.nav) + ' · MyInvestor' +
    (quote.date ? ' · ' + fmtDate(quote.date, { dateStyle: 'medium' }) : '')
}

function savedPositions(connection) {
  const { units, quotes } = connection.portfolio
  const rows = portfolioFunds(connection.portfolio).map(({ isin, name }) => {
    const quote = quotes[isin]
    const amount = fundAmount(units[isin], quote)
    return '<div class="fund-row"><h3>' + esc(name) + '</h3><small>' + esc(isin) + '</small><p class="fund-position"><span>' +
      unitsFormat.format(units[isin]) + ' participaciones</span><strong>' + (amount == null ? 'Pendiente' : esc(fmt(amount, 'EUR'))) +
      '</strong></p><small>' + esc(bankPriceLabel(quote)) + '</small></div>'
  }).join('')
  const [fundAccount, ...cash] = connection.accounts
  return rows + '<div class="fund-total"><b>Total de los fondos</b><strong>' +
    (fundAccount.amount == null ? 'Pendiente' : esc(fmt(fundAccount.amount, 'EUR'))) + '</strong></div>' +
    cash.map(a => '<p class="fund-position"><span>' + esc(a.title) + '</span><strong>' + esc(fmt(a.amount, a.currency)) + '</strong></p>').join('')
}

function showMyInvestor() {
  const connection = myInvestor()
  if (hidden) {
    modal('MyInvestor', '<p>Los importes y las participaciones están ocultos.</p>' +
      button('show-funds', 'Mostrar datos', 'eye', 'primary'))
    return
  }
  const lastRead = connection?.directReadAt ? '<p>Última consulta al banco el ' +
    esc(fmtDate(connection.directReadAt, { dateStyle: 'long' })) + '.</p>' : ''
  let saved = ''
  if (connection?.portfolio) saved = '<div id="fund-positions">' + savedPositions(connection) + '</div>'
  else if (connection?.accounts.length) saved = '<p>Saldo anterior guardado · <strong>' +
    esc(fmt(connection.accounts[0].amount, connection.accounts[0].currency)) + '</strong></p>'
  modal('MyInvestor', lastRead + '<div class="modal-actions">' +
    button('direct-investor', 'Consultar MyInvestor', 'refresh', 'primary') + '</div>' + saved)
}

function directForm() {
  modal('Consultar MyInvestor',
    '<p>Wealth usará tus claves una vez para consultar el efectivo, tus fondos y sus compras recientes en MyInvestor. Revisa el resultado antes de guardarlo.</p>' +
    '<form id="investor-login" autocomplete="off"><label>Documento de identidad<input name="user" maxlength="120" required spellcheck="false" autocapitalize="off"></label>' +
    '<label>Contraseña de MyInvestor<input name="password" type="password" maxlength="256" required autocomplete="off"></label>' +
    '<div id="investor-otp"></div><button class="btn primary" type="submit">Consultar al banco</button></form>')
  const form = $('#investor-login')
  form.elements.user.focus()
  let challengeId
  form.onsubmit = event => {
    event.preventDefault()
    locked(async () => {
      $('#modal-error').textContent = ''
      const result = await request('myinvestor/consultar', { ...Object.fromEntries(new FormData(form)), challengeId })
      if (result.challengeId) {
        challengeId = result.challengeId
        form.elements.user.readOnly = true
        form.elements.password.readOnly = true
        $('#investor-otp').innerHTML = '<label>Código SMS de inicio de sesión<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>'
        form.querySelector('button').textContent = 'Verificar y consultar'
        form.elements.code.focus()
        return
      }
      form.reset()
      directReview(result)
    })
  }
}

function directReview({ snapshot, previewId }) {
  const previous = myInvestor()?.portfolio?.units
  const positions = portfolioFunds(snapshot).map(({ isin, name }) => '<div class="fund-row"><h3>' + esc(name) + '</h3><small>' + esc(isin) +
    '</small><p>Guardadas: ' + (previous?.[isin] != null ? unitsFormat.format(previous[isin]) : '—') +
    ' · MyInvestor: <strong>' + unitsFormat.format(snapshot.units[isin]) + ' part.</strong></p><small>' +
    esc(bankPriceLabel(snapshot.quotes[isin])) + '</small></div>').join('')
  const cash = snapshot.cash.map(a => '<p>Efectivo disponible · <strong>' + esc(fmt(a.amount, a.currency)) + '</strong></p>').join('')
  const manual = myInvestor() && !previous ? '<p>La cartera y el efectivo sustituirán el saldo anterior guardado.</p>' : ''
  modal('Revisar consulta de MyInvestor', positions + cash + manual + '<p>Compras ejecutadas en los últimos 90 días: ' +
    snapshot.orders.length + '.</p><div class="modal-actions">' + button('close', 'Cancelar') +
    '<button type="button" class="btn primary" id="apply-myinvestor">Guardar consulta</button></div>')
  $('#apply-myinvestor').onclick = () => locked(async () => {
    await request('myinvestor/aplicar', { previewId })
    await load()
    dialog.close()
    message('Cartera y efectivo actualizados. Puedes ver el reparto de tus fondos en Inversión.')
  })
}

function manage(id) {
  selectedBank = id
  const b = bankOf(id),
    c = dashboard.connections.find((c) => c.bank === id)
  if (id === 'myinvestor' && (!c || isLocalMyInvestor(c)))
    return showMyInvestor()
  if (!c) {
    const unavailable = dashboard.configured && !dashboard.catalog.includes(id)
    modal(
      b.name,
      '<div class="modal-bank">' +
        bankLogo(id) +
        '<span>Cuenta personal · España</span></div><p>' +
        (!dashboard.configured
          ? 'Configura tu aplicación de Enable Banking para vincular esta entidad.'
          : unavailable
            ? 'Esta entidad no figuraba en el catálogo de tu aplicación en la última consulta. Puedes volver a comprobarlo.'
            : 'Te redirigiremos a Enable Banking para que autorices la consulta de saldos y movimientos.') +
        '</p>' +
        button(
          dashboard.configured ? 'authorize' : 'setup',
          dashboard.configured
            ? unavailable
              ? 'Comprobar disponibilidad'
              : 'Autorizar en el banco'
            : 'Configurar Enable Banking',
          'link',
          'primary',
        ),
    )
  } else {
    modal(
      b.name,
      '<p>' +
        (expired(c)
          ? 'El consentimiento ha caducado.'
          : 'Consentimiento válido hasta el ' +
            fmtDate(c.expires, { dateStyle: 'long' }) +
            '.') +
        '</p>' +
        accounts().filter((a) => a.bank === id).map(accountRow).join('') +
        (c.issue ? '<p class="warning">' + esc(c.issue) + '</p>' : '') +
        '<div class="modal-actions">' +
        button(
          expired(c) ? 'authorize' : 'sync',
          expired(c) ? 'Renovar acceso' : 'Actualizar datos',
          expired(c) ? 'link' : 'refresh',
          'primary',
        ) +
        button('confirm-disconnect', 'Desvincular') +
        '</div>',
    )
  }
}
function accountDetail(id) {
  if (id === 'myinvestor' || !demo()) return manage(id)
  const a = accounts().find((a) => a.bank === id)
  selectedBank = id
  modal(
    bankOf(id).name,
    '<p>Cuenta de ejemplo</p>' + accountRow(a) + '<div class="modal-actions">' +
      button('setup', 'Conectar mi cuenta', 'link', 'primary') +
      '</div>',
  )
}
async function locked(fn) {
  if (busy) return
  busy = true
  dialog.setAttribute('aria-busy', 'true')
  const buttons = [...dialog.querySelectorAll('button')]
  buttons.forEach((b) => (b.disabled = true))
  try {
    await fn()
  } catch (e) {
    if (dialog.open) $('#modal-error').textContent = e.message
    else message(e.message)
  } finally {
    busy = false
    dialog.removeAttribute('aria-busy')
    buttons.forEach((b) => (b.disabled = false))
  }
}
const actions = {
  menu() {
    const open = $('#nav').classList.toggle('open')
    $('[data-action="menu"]').setAttribute('aria-expanded', String(open))
    if (open) $('#nav a[aria-current]')?.focus()
  },
  connect: chooseBank,
  'direct-investor': directForm,
  'show-funds'() {
    hidden = false
    localStorage.setItem('wealth-privacy', '0')
    render()
    showMyInvestor()
  },
  close: () => dialog.close(),
  setup,
  privacy() {
    hidden = !hidden
    localStorage.setItem('wealth-privacy', hidden ? '1' : '0')
    render()
    $('[data-action="privacy"]').focus()
  },
  authorize: () =>
    locked(async () => {
      const result = await request('connect', { bank: selectedBank })
      location.assign(result.url)
    }),
  sync: () =>
    locked(async () => {
      const r = await request('sync', { bank: selectedBank })
      await load()
      manage(selectedBank)
      message(r.issue || 'Datos actualizados.')
    }),
  'confirm-disconnect'() {
    modal(
      'Desvincular ' + bankOf(selectedBank).name,
      '<p>Se revocará la sesión de lectura y se borrarán de Wealth las cuentas y los movimientos de esta entidad.</p><div class="modal-actions">' +
        button('disconnect', 'Desvincular entidad', null, 'primary') +
        button('back', 'Volver') +
        '</div>',
    )
  },
  back: () => manage(selectedBank),
  disconnect: () =>
    locked(async () => {
      await request('disconnect', { bank: selectedBank })
      dialog.close()
      await load()
      message('Entidad desvinculada.')
    }),
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.skip')) {
    e.preventDefault()
    $('#main').focus()
    return
  }
  if ($('#nav').classList.contains('open') && !e.target.closest('[data-action="menu"]')) {
    $('#nav').classList.remove('open')
    $('[data-action="menu"]').setAttribute('aria-expanded', 'false')
    if (e.target.closest('#nav a[aria-current]')) $('#main').focus()
  }
  const link = e.target.closest('a[href^="#"]')
  if (dashboard && link && link.hash === location.hash && link.hash === '#' + view &&
      !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    animateCounters()
    return
  }
  const t = e.target.closest('button')
  if (!t || t.disabled || (busy && dialog.contains(t))) return
  const d = t.dataset
  if (d.settle) chooseRepayment(d.settle)
  else if (d.action) actions[d.action]?.()
  else if (d.rename) renameForm(d.rename, dialog.contains(t))
  else if (d.renew) {
    selectedBank = d.renew
    actions.authorize()
  } else if (d.manage) manage(d.manage)
  else if (d.bank) accountDetail(d.bank)
  else if (d.period) {
    if (Number(d.period) === period) return
    period = Number(d.period)
    render()
    document.querySelector('.balance-series')?.classList.add('draw')
    document.querySelector('[data-period="' + period + '"]').focus()
  } else if (d.page) {
    ledgerPage += Number(d.page)
    $('#tx-list').innerHTML = ledgerRows(false)
  }
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#nav').classList.contains('open')) {
    $('#nav').classList.remove('open')
    const toggle = $('[data-action="menu"]')
    toggle.setAttribute('aria-expanded', 'false')
    toggle.focus()
  }
})
document.addEventListener('change', (e) => {
  if (e.target.id === 'currency') {
    currency = e.target.value
    render()
    $('#currency')?.focus()
  }
  if (e.target.id === 'repayment-month') {
    selectedRepayment = e.target.value
    render()
    $('#repayment-month')?.focus()
  }
  if (e.target.id === 'bank-filter') {
    filter = e.target.value
    ledgerPage = 0
    $('#tx-list').innerHTML = ledgerRows(false)
  }
  if (e.target.name === 'pem') {
    const id = e.target.files[0]?.name.match(/^([\da-f-]{36})\.pem$/i)?.[1]
    if (id && !$('#setup').elements.applicationId.value)
      $('#setup').elements.applicationId.value = id
  }
})
document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    search = e.target.value
    ledgerPage = 0
    $('#tx-list').innerHTML = ledgerRows(false)
  }
})
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'setup') return
  e.preventDefault()
  const f = e.target
  locked(async () => {
    if (f.elements.pem.files[0].size > 16000)
      throw new Error('Selecciona un archivo PEM válido.')
    await request('setup', {
      id: f.elements.applicationId.value.trim(),
      pem: await f.elements.pem.files[0].text(),
    })
    await load()
    selectedBank ? manage(selectedBank) : chooseBank()
  })
})
dialog.addEventListener('click', (e) => {
  if (e.target === dialog && !busy) dialog.close()
})
dialog.addEventListener('close', () => {
  $('#investor-login')?.reset()
})
dialog.addEventListener('cancel', (e) => {
  if (busy) e.preventDefault()
})
window.addEventListener('hashchange', () => {
  if (dashboard) {
    render({ entering: true })
    window.scrollTo(0, 0)
    $('#main').focus({ preventScroll: true })
  }
})
async function init() {
  await load()
  const weeklyRun = new URLSearchParams(location.search).get('actualizacion')
  if (weeklyRun) {
    history.replaceState(null, '', location.pathname)
    const result = await request('weekly-balances', { run: weeklyRun })
    await load()
    if (result.failed) message('Actualización semanal incompleta. Consulta los avisos en el resumen.')
    else if (result.updated || result.alreadyDone) message('Saldos semanales guardados.')
    else message('Este perfil no tiene bancos vinculados ni fondos que actualizar.')
  }
  const notice = new URLSearchParams(location.search).get('notice')
  if (!notice) return
  history.replaceState(null, '', location.pathname + location.hash)
  if (notice.startsWith('connected-') && bankOf(notice.slice(10))) {
    const bank = notice.slice(10)
    message('Cuenta vinculada. Consultando saldos y movimientos…')
    const result = await request('sync', { bank })
    await load()
    message(result.issue || 'Cuenta sincronizada.')
  } else {
    const notes = {
      state: 'El enlace de retorno ha caducado o se abrió en otro navegador.',
      empty:
        'El banco no ha devuelto cuentas. Comprueba que cada cuenta esté vinculada a la aplicación en Enable Banking.',
      cancel: 'La autorización se ha cancelado.',
      failed:
        'No se pudo confirmar la autorización. Inicia de nuevo la conexión.',
    }
    modal(
      'Conexión bancaria',
      '<p>' +
        esc(notes[notice] || 'Consulta el estado de tus conexiones.') +
        '</p>' +
        button('connect', 'Ver entidades', 'link'),
    )
  }
}
init().catch((e) => {
  if (dashboard) message(e.message)
  else
    $('#main').textContent =
      'No se ha podido cargar Wealth. Recarga la página para volver a intentarlo.'
})
