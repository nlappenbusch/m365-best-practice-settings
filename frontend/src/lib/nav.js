// Navigationsstruktur der linken Seitenleiste.
//
// Die Reihenfolge folgt dem Weg, den ein Admin bei einem neuen Kunden ohnehin
// geht: Tenant anbinden und Baseline festlegen -> Identität absichern ->
// Mail-Security ausrollen -> Intune einrichten (Policies, Mappings, Apps) ->
// Geräte in Betrieb nehmen (GroupTags, Autopilot, ggf. Migration) -> laufender
// Betrieb (Lizenzen, Reports, Tickets, Diagnose).
//
// Innerhalb der Gruppen gilt dasselbe: was Voraussetzung für den nächsten
// Schritt ist, steht darüber. GroupTags vor Autopilot, weil ein Autopilot-Gerät
// ohne passende Gruppe nichts zugewiesen bekommt.
//
// Die `id` eines Eintrags ist NICHT frei änderbar: sie steht in Sprunglinks
// (goToTab) und im gemerkten letzten Bereich (localStorage). Beschriftungen
// dürfen sich ändern, Ids nicht.
//
// `desc` erscheint als Tooltip in der Leiste und als Untertitel in der Kopfzeile.

export const NAV_GROUPS = [
  {
    id: 'setup',
    label: 'Einrichtung',
    items: [
      { id: 'tenants', icon: '🏢', label: 'Tenants',
        desc: 'Kunden-Tenants onboarden, Status prüfen, geführter Einrichtungs-Assistent' },
      { id: 'config', icon: '⚙️', label: 'Vorlage',
        desc: 'Baseline: Domains, Admin-/MSP-Adressen, Policy-Werte — Grundlage für alle Werkzeuge' }
    ]
  },
  {
    id: 'identity',
    label: 'Identität & Zugriff',
    items: [
      { id: 'ca', icon: '🔐', label: 'Conditional Access',
        desc: 'CA-Tier wählen, im Report-only-Pilot starten, Policies ausrollen und aufräumen' },
      { id: 'adminroles', icon: '👤', label: 'Administrative Rollen', isNew: true,
        desc: 'Wer hat erhöhte Rechte — Globale Administratoren mit ihren Gruppen und weiteren Rollen' }
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
    id: 'intune',
    label: 'Intune',
    items: [
      { id: 'intune', icon: '🛠', label: 'Policies',
        desc: 'OIB-Baseline-Policies zuweisen — inklusive Hinweis auf Break-Risiken' },
      { id: 'mappings', icon: '🗺️', label: 'Mappings',
        desc: 'Laufwerk- und Druckermappings als Intune-Profil erzeugen und zuweisen' },
      { id: 'downloads', icon: '📦', label: 'Apps & Agents',
        desc: 'Bitdefender, N-sight RMM und FortiClient als Win32-App ausrollen' }
    ]
  },
  {
    id: 'rollout',
    label: 'Geräte-Rollout',
    items: [
      { id: 'grouptags', icon: '🏷', label: 'GroupTags',
        desc: 'Dynamische Gerätegruppen anlegen und Autopilot-Geräten GroupTags zuordnen' },
      { id: 'autopilot', icon: '🚀', label: 'Autopilot',
        desc: 'Staging-Paket bauen, Autopilot-Profile und registrierte Geräte verwalten' },
      { id: 'migration', icon: '🔀', label: 'Tenant-Migration', isNew: true,
        desc: 'Geräte in einen anderen Tenant umziehen — Paket konfigurieren und als Intune-App ausrollen' }
    ]
  },
  {
    id: 'ops',
    label: 'Betrieb',
    items: [
      { id: 'reports', icon: '📊', label: 'Reports', isNew: true,
        desc: 'Statusbericht pro Kunde erzeugen und Übersicht über alle Tenants' },
      { id: 'lizenzen', icon: '💰', label: 'Lizenzen',
        desc: 'Lizenzbestand, ungenutzte Seats und Lizenzen an inaktiven Konten' },
      { id: 'tickets', icon: '🎫', label: 'Tickets', gated: 'ticketsAllowed',
        desc: 'SDP-Ticket-Copilot: offene Tickets, Runbooks, Worklogs' },
      { id: 'diagnose', icon: '🩺', label: 'Diagnose',
        desc: 'Server-Log der laufenden Instanz und Erreichbarkeitstest der Microsoft-Endpunkte' }
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
