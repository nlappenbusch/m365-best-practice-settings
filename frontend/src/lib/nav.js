// Product-centric navigation.
//
// The old tool grew around technical modules. The new shell starts with the
// questions an MSP/operator has: What needs attention? What changed? What is
// risky? What is automated? The existing specialist tools stay available below.
//
// IDs are deliberately preserved for existing deep links/localStorage.

export const NAV_GROUPS = [
  {
    id: 'control',
    label: 'Control Center',
    items: [
      { id: 'overview', icon: 'chart', label: 'Overview',
        desc: 'Tenant-Lage in einer Sicht: Security, Changes, Evidence, Service Health und laufende Jobs' },
      { id: 'changes', icon: 'refresh', label: 'Changes', isNew: true,
        desc: 'Entra- und Intune-Änderungen priorisieren: Akteur, Objekt, Before/After und Risiko' },
      { id: 'risks', icon: 'shieldCheck', label: 'Risks', isNew: true,
        desc: 'Gemeinsame Arbeitsliste aus Security-Findings und auffälligen Tenant-Änderungen' },
      { id: 'automations', icon: 'wrench', label: 'Automations', isNew: true,
        desc: 'Lokale Jobs und optionale Semaphore-Ausführung für PowerShell, Terraform und OpenTofu' }
    ]
  },
  {
    id: 'assurance',
    label: 'Assurance',
    items: [
      { id: 'nachweise', icon: 'search', label: 'Evidence',
        desc: 'Änderungsprotokoll, Unified Audit Log, Konten, Apps, Empfänger und Service-Status archivieren' },
      { id: 'maester', icon: 'shieldCheck', label: 'Security Audit',
        desc: 'Maester mit CISA SCuBA, CIS, EIDSCA und ORCA — Score, Verlauf und Reports' },
      { id: 'istzustand', icon: 'book', label: 'Ist-Zustand',
        desc: 'Kundenfähige Konfigurationsdokumentation mit Entscheiden, Änderungen und Abweichungen' },
      { id: 'reports', icon: 'chart', label: 'Reports',
        desc: 'Statusberichte pro Kunde und Übersicht über alle Tenants' }
    ]
  },
  {
    id: 'tenant',
    label: 'Tenant',
    items: [
      { id: 'tenants', icon: 'building', label: 'Tenants',
        desc: 'Kunden-Tenants onboarden, Berechtigungen prüfen und Verbindungen verwalten' },
      { id: 'bestandsaufnahme', icon: 'users', label: 'Bestandsaufnahme',
        desc: 'Benutzer, Lizenzen, Postfächer, Intune- und Entra-Geräte als erster IST-Überblick' },
      { id: 'sharepoint', icon: 'folder', label: 'SharePoint & OneDrive',
        desc: 'Sites, Besitzer, Gäste, Speicher, OneDrives und tenantweite Freigabeeinstellungen' },
      { id: 'lizenzen', icon: 'coins', label: 'Lizenzen',
        desc: 'Lizenzbestand, ungenutzte Seats und Lizenzen an inaktiven Konten' }
    ]
  },
  {
    id: 'identity',
    label: 'Identity & Access',
    items: [
      { id: 'ca', icon: 'lock', label: 'Conditional Access',
        desc: 'CA-Baseline, Pilot/Ringe, Deployment und bestehende Richtlinien verwalten' },
      { id: 'adminroles', icon: 'userCog', label: 'Administrative Rollen',
        desc: 'Privilegierte Rollen, direkte und gruppenbasierte Zuweisungen sichtbar machen' },
      { id: 'haertung', icon: 'settings', label: 'Tenant-Härtung',
        desc: 'Standardberechtigungen, Gäste, Gerätebeitritt und Registrierungsregeln absichern' }
    ]
  },
  {
    id: 'mail',
    label: 'Mail Security',
    items: [
      { id: 'mailsec', icon: 'shieldCheck', label: 'Policies',
        desc: 'Quarantäne, Anti-Phishing, Anti-Spam und Anti-Malware idempotent ausrollen' },
      { id: 'audit', icon: 'search', label: 'Mail Audit',
        desc: 'Soll/Ist-Vergleich der Policies sowie SPF, DKIM und DMARC' }
    ]
  },
  {
    id: 'endpoint',
    label: 'Endpoint',
    items: [
      { id: 'intune', icon: 'wrench', label: 'Intune Policies',
        desc: 'OpenIntuneBaseline, Zuweisungen, Backup, Drift und Restore' },
      { id: 'zuweisungen', icon: 'check', label: 'Zuweisungen',
        desc: 'Apps, Richtlinien und Conditional Access bis auf Gerät oder Konto auflösen' },
      { id: 'mappings', icon: 'map', label: 'Mappings',
        desc: 'Laufwerk- und Druckermappings als Intune-Konfiguration erzeugen' },
      { id: 'browserext', icon: 'puzzle', label: 'Browser Extensions',
        desc: 'Erweiterungen in Edge, Chrome und Firefox verwalten' },
      { id: 'remediations', icon: 'refresh', label: 'Remediations',
        desc: 'Wiederkehrende Erkennung und Reparatur statt Einmal-Skripte' },
      { id: 'downloads', icon: 'package', label: 'Apps & Agents',
        desc: 'Bitdefender, N-sight, FortiClient und weitere Win32-Apps bereitstellen' }
    ]
  },
  {
    id: 'rollout',
    label: 'Device Lifecycle',
    items: [
      { id: 'grouptags', icon: 'tag', label: 'GroupTags',
        desc: 'Dynamische Gerätegruppen und Autopilot-GroupTags verwalten' },
      { id: 'autopilot', icon: 'rocket', label: 'Autopilot',
        desc: 'Staging-Paket, Profile und registrierte Geräte verwalten' },
      { id: 'migration', icon: 'shuffle', label: 'Tenant-Migration',
        desc: 'Geräte kontrolliert in einen anderen Tenant verschieben' }
    ]
  },
  {
    id: 'standards',
    label: 'Standards',
    items: [
      { id: 'config', icon: 'sliders', label: 'Baseline-Vorlage',
        desc: 'Domains, Adressen und Policy-Werte als Sollzustand definieren' },
      { id: 'naming', icon: 'tag', label: 'Namenskonvention',
        desc: 'Objektnamen global definieren und pro Tenant überschreiben' },
      { id: 'wissen', icon: 'book', label: 'Wissen',
        desc: 'Best-Practice-Doku, Begründungen und Sprunglinks in die Werkzeuge' }
    ]
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      { id: 'tickets', icon: 'ticket', label: 'Tickets', gated: 'ticketsAllowed',
        desc: 'ServiceDesk-Plus-Ticket-Copilot, Runbooks und Worklogs' },
      { id: 'diagnose', icon: 'stethoscope', label: 'Diagnose',
        desc: 'Server-Log und Erreichbarkeit der angebundenen Dienste' },
      { id: 'secrets', icon: 'key', label: 'Geheimnisse', gated: 'ticketsAllowed',
        desc: 'Zertifikate und Zugangsdaten der Plattform kontrolliert prüfen' }
    ]
  }
]

export const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items.map(i => ({ ...i, group: g.label })))

export function navItem(id) {
  return NAV_ITEMS.find(i => i.id === id) || null
}

export function isVisible(item, session) {
  return !item.gated || !!session?.[item.gated]
}
