// Navigationsstruktur der linken Seitenleiste.
//
// Die Reihenfolge folgt bewusst dem Ablauf, den der Einrichtungs-Assistent in
// TenantsOverview ohnehin vorgibt: erst den Tenant waehlen/onboarden, dann die
// Vorlage festlegen (alle weiteren Werkzeuge lesen dagegen), danach Mail-Security
// ausrollen und pruefen, Identitaet absichern, Geraete ausrollen — Betrieb und
// Referenz zum Schluss. Wer die Liste von oben nach unten abarbeitet, macht die
// Dinge automatisch in der richtigen Reihenfolge.
//
// `desc` erscheint als Tooltip in der Leiste und als Untertitel in der Kopfzeile.

export const NAV_GROUPS = [
  {
    id: 'start',
    label: 'Start',
    items: [
      { id: 'tenants', icon: '🏢', label: 'Tenants',
        desc: 'Kunden-Tenants onboarden, Status prüfen, geführter Einrichtungs-Assistent' },
      { id: 'config', icon: '⚙️', label: 'Vorlage',
        desc: 'Baseline: Domains, Admin-/MSP-Adressen, Policy-Werte — Grundlage für alle Werkzeuge' }
    ]
  },
  {
    id: 'mail',
    label: 'Mail-Security',
    items: [
      { id: 'mailsec', icon: '🛡', label: 'Ausrollen',
        desc: 'BP_-Policies live deployen: Quarantäne, Anti-Phishing, Anti-Spam, Anti-Malware' },
      { id: 'audit', icon: '🔎', label: 'Audit',
        desc: 'Soll/Ist-Vergleich der Policies und SPF/DKIM/DMARC der Domains' }
    ]
  },
  {
    id: 'identity',
    label: 'Identität',
    items: [
      { id: 'ca', icon: '🔐', label: 'Conditional Access',
        desc: 'CA-Tier wählen, im Report-only-Pilot starten, Policies ausrollen und aufräumen' }
    ]
  },
  {
    id: 'devices',
    label: 'Geräte',
    items: [
      { id: 'intune', icon: '💻', label: 'Intune',
        desc: 'OIB-Baseline-Policies zuweisen — inklusive Hinweis auf Break-Risiken' },
      { id: 'autopilot', icon: '🚀', label: 'Autopilot',
        desc: 'Staging-Paket bauen, Autopilot-Profile und registrierte Geräte verwalten' },
      { id: 'mappings', icon: '🗺️', label: 'Mappings', isNew: true,
        desc: 'Laufwerk- und Druckermappings als Intune-Profil erzeugen und zuweisen' },
      { id: 'downloads', icon: '📦', label: 'Agents',
        desc: 'Installer für Bitdefender, N-sight RMM und FortiClient' }
    ]
  },
  {
    id: 'ops',
    label: 'Betrieb',
    items: [
      { id: 'lizenzen', icon: '💰', label: 'Lizenzen',
        desc: 'Lizenzbestand, ungenutzte Seats und Lizenzen an inaktiven Konten' },
      { id: 'tickets', icon: '🎫', label: 'Tickets', isNew: true, gated: 'ticketsAllowed',
        desc: 'SDP-Ticket-Copilot: offene Tickets, Runbooks, Worklogs' }
    ]
  },
  {
    id: 'reference',
    label: 'Referenz',
    items: [
      { id: 'wissen', icon: '📖', label: 'Wissen',
        desc: 'Best-Practice-Doku, Begründungen und Sprunglinks in die passenden Werkzeuge' }
    ]
  }
]

export const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items.map(i => ({ ...i, group: g.label })))

export function navItem(id) {
  return NAV_ITEMS.find(i => i.id === id) || null
}

// Nur Sichtbarkeit in der Navigation — die eigentliche Durchsetzung passiert
// serverseitig (403 auf /api/sdp, /api/runbooks).
export function isVisible(item, session) {
  return !item.gated || !!session?.[item.gated]
}
