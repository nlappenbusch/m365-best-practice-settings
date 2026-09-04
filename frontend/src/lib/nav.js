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
// `icon` ist ein Name aus lib/Icon.svelte (Strichicons, kein Emoji): einheitliche
// Strichstaerke, faerbt sich mit currentColor und braucht keine externe Schrift.
//
// `desc` erscheint als Tooltip in der Leiste und als Untertitel in der Kopfzeile.

export const NAV_GROUPS = [
  {
    id: 'setup',
    label: 'Einrichtung',
    items: [
      { id: 'tenants', icon: 'building', label: 'Tenants',
        desc: 'Kunden-Tenants onboarden, Status prüfen, geführter Einrichtungs-Assistent' },
      { id: 'bestandsaufnahme', icon: 'users', label: 'Bestandsaufnahme', isNew: true,
        desc: 'Erster IST-Überblick nach dem Onboarding: Benutzer, Lizenzen, Postfächer/Shared Mailboxes, Intune- und Entra-ID-Geräte' },
      { id: 'config', icon: 'sliders', label: 'Vorlage',
        desc: 'Baseline: Domains, Admin-/MSP-Adressen, Policy-Werte — Grundlage für alle Werkzeuge' },
      { id: 'naming', icon: 'tag', label: 'Namenskonvention', isNew: true,
        desc: 'Wie die angelegten Objekte heissen — global mit Tenant-Override' }
    ]
  },
  {
    id: 'identity',
    label: 'Identität & Zugriff',
    items: [
      { id: 'ca', icon: 'lock', label: 'Conditional Access',
        desc: 'CA-Tier wählen, im Report-only-Pilot starten, Policies ausrollen und aufräumen' },
      { id: 'adminroles', icon: 'userCog', label: 'Administrative Rollen', isNew: true,
        desc: 'Wer hat erhöhte Rechte — Globale Administratoren mit ihren Gruppen und weiteren Rollen' },
      { id: 'haertung', icon: 'settings', label: 'Tenant-Härtung', isNew: true,
        desc: 'Standardberechtigungen, Gastzugriff, Geräte-Beitritt und Registrierung — die Grundeinstellungen vor dem Regelbetrieb' }
    ]
  },
  {
    id: 'mail',
    label: 'Mail-Security',
    items: [
      { id: 'mailsec', icon: 'shieldCheck', label: 'Ausrollen',
        desc: 'BP_-Policies live deployen: Quarantäne, Anti-Phishing, Anti-Spam, Anti-Malware' },
      { id: 'audit', icon: 'search', label: 'Audit',
        desc: 'Soll/Ist-Vergleich der Policies und SPF/DKIM/DMARC der Domains' }
    ]
  },
  {
    id: 'intune',
    label: 'Intune',
    items: [
      { id: 'intune', icon: 'wrench', label: 'Policies',
        desc: 'OIB-Baseline-Policies zuweisen — inklusive Hinweis auf Break-Risiken' },
      { id: 'mappings', icon: 'map', label: 'Mappings',
        desc: 'Laufwerk- und Druckermappings als Intune-Profil erzeugen und zuweisen' },
      { id: 'browserext', icon: 'puzzle', label: 'Browser-Erweiterungen', isNew: true,
        desc: 'Erweiterungen in Edge, Chrome und Firefox erzwingen — auf die Gerätegruppen' },
      { id: 'remediations', icon: 'refresh', label: 'Remediations', isNew: true,
        desc: 'Erkennen und Beheben: wiederkehrende Reparatur statt Einmal-Skript' },
      { id: 'downloads', icon: 'package', label: 'Apps & Agents',
        desc: 'Bitdefender, N-sight RMM und FortiClient als Win32-App ausrollen' }
    ]
  },
  {
    id: 'rollout',
    label: 'Geräte-Rollout',
    items: [
      { id: 'grouptags', icon: 'tag', label: 'GroupTags',
        desc: 'Dynamische Gerätegruppen anlegen und Autopilot-Geräten GroupTags zuordnen' },
      { id: 'autopilot', icon: 'rocket', label: 'Autopilot',
        desc: 'Staging-Paket bauen, Autopilot-Profile und registrierte Geräte verwalten' },
      { id: 'migration', icon: 'shuffle', label: 'Tenant-Migration', isNew: true,
        desc: 'Geräte in einen anderen Tenant umziehen — Paket konfigurieren und als Intune-App ausrollen' }
    ]
  },
  {
    id: 'ops',
    label: 'Betrieb',
    items: [
      { id: 'reports', icon: 'chart', label: 'Reports', isNew: true,
        desc: 'Statusbericht pro Kunde erzeugen und Übersicht über alle Tenants' },
      { id: 'maester', icon: 'shieldCheck', label: 'Security-Audit', isNew: true,
        desc: 'Maester-Testsuite (CISA, CIS, EIDSCA) rein lesend gegen den Tenant — mit interaktivem HTML-Report' },
      { id: 'lizenzen', icon: 'coins', label: 'Lizenzen',
        desc: 'Lizenzbestand, ungenutzte Seats und Lizenzen an inaktiven Konten' },
      { id: 'tickets', icon: 'ticket', label: 'Tickets', gated: 'ticketsAllowed',
        desc: 'SDP-Ticket-Copilot: offene Tickets, Runbooks, Worklogs' },
      { id: 'diagnose', icon: 'stethoscope', label: 'Diagnose',
        desc: 'Server-Log der laufenden Instanz und Erreichbarkeitstest der Microsoft-Endpunkte' },
      // gated wie Tickets: der Bereich zeigt Zertifikats-Privatschlüssel ALLER
      // Kundentenants. Durchgesetzt wird das serverseitig (403 auf /api/admin/secrets),
      // hier nur die Sichtbarkeit.
      { id: 'secrets', icon: 'key', label: 'Geheimnisse', gated: 'ticketsAllowed',
        desc: 'Welche Schlüssel und Zugangsdaten dieses Werkzeug hält — Zustand, Gültigkeit, gezieltes Einblenden' }
    ]
  },
  {
    id: 'reference',
    label: 'Referenz',
    items: [
      { id: 'wissen', icon: 'book', label: 'Wissen',
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
