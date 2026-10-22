export const STATUS = { fulfilled: 'Erfüllt', open: 'Offen', unknown: 'Zu prüfen', na: 'Nicht anwendbar' }
export const LEVEL = { critical: 'Kritisch', high: 'Hoch', medium: 'Mittel', low: 'Niedrig' }
export const url = (id, part) => `/api/tenants/${encodeURIComponent(id)}/cockpit/${part}`
export function csv(name, columns, rows) {
  const cell = v => '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"'
  const data = '\ufeff' + [columns, ...rows].map(r => r.map(cell).join(';')).join('\r\n')
  const link = document.createElement('a'), href = URL.createObjectURL(new Blob([data], { type: 'text/csv;charset=utf-8' }))
  link.href = href; link.download = name + '.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000)
}
