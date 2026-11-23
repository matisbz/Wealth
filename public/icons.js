const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wallet:
    '<path d="M20 7H5a2 2 0 0 1 0-4h12v4M3 5v13a2 2 0 0 0 2 2h15V7"/><path d="M20 11h-5v5h5"/>',
  moves: '<path d="M3 7h17m-5-5 5 5-5 5M21 17H4m5 5-5-5 5-5"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 1 1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" transform="translate(1 1)"/>',
  shield:
    '<path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trend: '<path d="m3 17 6-6 4 4 8-9m-6 0h6v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  hidden:
    '<path d="m3 3 18 18M9 5.4c7-2 13 6.6 13 6.6s-1.2 2.3-3.4 4.2M6.5 6.6A20 20 0 0 0 2 12s3.5 7 10 7c1.6 0 3-.4 4.4-1.1"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v5m10-5v5M3 11h18"/>',
  ring: '<path d="M20 14a8 8 0 1 1-10-10v10z"/><path d="M13 3v8h8a8 8 0 0 0-8-8Z"/>',
  briefcase:
    '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12q9 5 18 0"/>',
  music:
    '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
  receive: '<path d="m18 5-11 11M7 8v8h8"/>',
  basket: '<path d="M3 10h18l-2 10H5zm4 0 4-7m6 7-4-7"/>',
  percent:
    '<path d="M5 19 19 5"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  coffee:
    '<path d="M3 8h14v7a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Zm14 1h2a2.5 2.5 0 0 1 0 5h-2M2 22h18"/>',
  train:
    '<rect x="5" y="2" width="14" height="16" rx="3"/><path d="M5 10h14M8 18l-3 4m11-4 3 4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh:
    '<path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6m-5 5a8 8 0 0 0 14 4l3-3m0 6v-6h-6"/>',
  person:
    '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  bank: '<path d="m2 8 10-6 10 6Zm2 13h16M6 10v8m6-8v8m6-8v8"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  menu: '<path d="M3 5h18M3 12h18M3 19h18"/>',
}
export const icon = (name, size = 20) =>
  '<svg width="' +
  size +
  '" height="' +
  size +
  '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  (paths[name] || paths.moves) +
  '</svg>'
