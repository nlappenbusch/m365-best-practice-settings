/**
 * IST-Bestandsaufnahme: rein lesende Momentaufnahme fuer einen Tenant, gedacht
 * als erster grober Ueberblick bei einem neuen Mandat -- Benutzer, Lizenzen,
 * Postfaecher/Shared Mailboxes, Intune-Geraete und Entra-ID-Geraete in einem Lauf.
 *
 * Users+Lizenzen kommen aus LICENSES.runLicenseReport (bereits vorhanden),
 * Intune-Geraete ueber denselben Graph-Endpoint wie REPORT.sectionDevices.
 * Neu: Entra-ID-Geraete (/devices, Permission Device.Read.All) und
 * Postfaecher (EXO app-only ueber exorunner, Get-EXOMailbox).
 *
 * Anders als der Security-Report (report.js) kappt die Bestandsaufnahme ihre
 * Listen nicht auf 50 Zeilen -- hier IST die vollstaendige Liste der Zweck,
 * nicht nur ein Befund.
 */
const LICENSES = require("./licenses");
const { graphAllPages } = require("./graph");
const EXO = require("./exorunner");

const SECTIONS = [
  { id: "users", label: "Benutzer", desc: "Alle Konten mit Status, Kontotyp und Anlegedatum" },
  { id: "licenses", label: "Lizenzen", desc: "Zugewiesene Lizenzen je SKU, freie Seats" },
  { id: "mailboxes", label: "Postfächer", desc: "Alle Exchange-Online-Postfächer nach Typ" },
  { id: "sharedMailboxes", label: "Shared Mailboxes", desc: "Freigegebene Postfächer im Detail" },
  { id: "intuneDevices", label: "Intune-Geräte", desc: "Verwaltete Geräte, Compliance, Betriebssystem" },
  { id: "entraDevices", label: "Azure-AD-Geräte", desc: "Im Verzeichnis registrierte/verbundene Geräte" }
];

function metric(label, value, state, detail) {
  return { label, value, state: state || "ok", detail: detail || null };
}

// Anders als report.js (LIST_CAP 50, "Befund statt Datenexport"): die
// Bestandsaufnahme SOLL vollstaendig sein. 5000 ist nur ein Sicherheitsnetz
// gegen Ausreisser-Tenants, das in der Praxis nie greift.
const LIST_CAP = 5000;
function list(id, label, columns, rows, state) {
  const capped = rows.slice(0, LIST_CAP);
  return {
    id, label, columns,
    rows: capped.map(r => r.map(c => (c === null || c === undefined || c === "") ? "—" : String(c))),
    more: Math.max(0, rows.length - capped.length),
    state: state || null
  };
}

function fmtDate(s) {
  if (!s) return null;
  const d = String(s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function daysSince(s) {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

// Rohwerte aus Graph/Exchange in die Sprache der Oberflaeche uebersetzen.
// "None", "company", "compliant" sind Feldwerte, keine Antworten fuer einen
// Menschen, der das Dokument liest -- und schon gar nicht fuer einen Kunden.
const ARCHIVE_DE = { Active: "vorhanden", None: "kein Archiv", Disabled: "deaktiviert" };
const OWNER_DE = { company: "Firma", personal: "privat", unknown: "unbekannt" };
const COMPLIANCE_DE = {
  compliant: "konform", noncompliant: "nicht konform", unknown: "unbekannt",
  inGracePeriod: "Schonfrist", conflict: "Konflikt", error: "Fehler", notApplicable: "n/a"
};
const TRUST_DE = {
  AzureAd: "Entra ID – verbunden",
  ServerAd: "Hybrid – verbunden",
  Workplace: "Entra ID – registriert"
};
const de = (map, v) => map[String(v || "")] || (v == null || v === "" ? "—" : String(v));

// Schweizer Zahlenformat: 10'000'000 statt 10000000. Verbrauchskontingente
// (Communications Credits, virale Trials) sind sonst eine Ziffernwueste, in der
// die relevanten kleinen Zahlen untergehen.
function num(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return n;
  return n.toLocaleString("de-CH").replace(/ | /g, "'");
}

// Kontoart -- bewusst nur aus BELASTBAREN Signalen, nicht aus Namensmustern:
//   - department "Microsoft Communication Application Instance" setzt Microsoft
//     selbst bei Telefonie-Ressourcenkonten (Warteschlange, automatische Vermittlung)
//   - Break-Glass erkennt die eigene Namenskonvention des Werkzeugs
//   - Funktionspostfach kommt aus dem Postfachtyp (SharedMailbox), nicht aus dem Namen
// Alles andere bleibt "Benutzerkonto". Lieber grob und richtig als fein und falsch.
function accountKind(u, sharedUpns) {
  const upn = String(u.userPrincipalName || "").toLowerCase();
  if (String(u.department || "") === "Microsoft Communication Application Instance") return "Telefonie-Ressource";
  if (/break-?glass/.test(upn) || /break-?glass/i.test(String(u.displayName || ""))) return "Break-Glass";
  if (sharedUpns.has(upn)) return "Funktionspostfach";
  return "Benutzerkonto";
}

async function sectionUsers(tenant, cert) {
  const users = await graphAllPages(tenant, cert,
    "/users?$select=id,displayName,userPrincipalName,accountEnabled,userType,createdDateTime,department,jobTitle&$top=999",
    { retryTransient: true });
  const members = users.filter(u => u.userType !== "Guest");
  const guests = users.filter(u => u.userType === "Guest");
  const disabled = users.filter(u => u.accountEnabled === false);
  const sorted = [...users].sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));

  return {
    metrics: [
      metric("Konten gesamt", users.length),
      metric("Mitglieder", members.length),
      metric("Gäste", guests.length, guests.length > 0 ? "warn" : "ok"),
      metric("Deaktiviert", disabled.length)
    ],
    lists: [
      list("allUsers", "Alle Benutzerkonten", ["Name", "UPN", "Typ", "Status", "Abteilung", "Angelegt"],
        sorted.map(u => [
          u.displayName, u.userPrincipalName, u.userType === "Guest" ? "Gast" : "Mitglied",
          u.accountEnabled === false ? "deaktiviert" : "aktiv", u.department, fmtDate(u.createdDateTime)
        ]))
    ],
    // Rohliste mitgeben: die Querschnitte am Ende (Konto ohne Geraet, Postfach
    // ohne aktives Konto, deaktiviert mit Lizenz) brauchen sie -- genau die
    // Verknuepfungen sind der Teil, den vier getrennte Listen nicht zeigen.
    data: { total: users.length, guests: guests.length, disabled: disabled.length, users }
  };
}

async function sectionLicenses(tenant, cert) {
  const r = await LICENSES.runLicenseReport(tenant, cert);
  const t = r.totals || {};
  const skus = (r.skus || []).filter(s => s.assigned > 0 || s.purchased > 0);
  const userLic = r.userLicenses || [];
  return {
    metrics: [
      metric("Lizenzierte Benutzer", t.licensedUsers),
      metric("Bezahlte SKUs", t.paidSkus),
      metric("Freie bezahlte Seats", t.freeSeats, t.freeSeats > 5 ? "warn" : "ok")
    ],
    lists: [
      list("skus", "Lizenzbestand", ["Lizenz", "Zugewiesen", "Gekauft", "Frei"],
        skus.map(s => [s.name, s.assigned, s.purchased, s.available])),
      list("userLicenses", "Benutzer → Lizenzen", ["Benutzer", "UPN", "Status", "Lizenzen"],
        userLic.map(u => [u.displayName, u.upn, u.enabled ? "aktiv" : "deaktiviert", (u.licenses || []).join(", ")]))
    ],
    data: r
  };
}

// Postfaecher und Shared Mailboxes teilen sich EINEN EXO-Abruf (Get-EXOMailbox
// ist per REST deutlich schneller als klassisches Get-Mailbox, aber trotzdem
// kein Grund, den Tenant zweimal zu fragen).
async function fetchMailboxes(tenant, cert) {
  const body = [
    "$mbx = @(Get-EXOMailbox -ResultSize Unlimited -Properties ArchiveStatus,WhenMailboxCreated | " +
      "Select-Object DisplayName,PrimarySmtpAddress,RecipientTypeDetails,ArchiveStatus,WhenMailboxCreated)",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; mailboxes = $mbx } | ConvertTo-Json -Compress -Depth 6) + 'ENDJSON')"
  ].join("\r\n");
  const r = await EXO.runExo(
    { appId: tenant.clientId, organization: tenant.organization, certPemPath: cert },
    body, 240000);
  if (!r.ok) throw Object.assign(new Error("EXO-Runner: " + r.error), { hint: "Exchange Online app-only nicht erreichbar." });
  if (!r.data || r.data.ok === false) {
    throw Object.assign(new Error((r.data && r.data.error) || "Postfach-Abfrage fehlgeschlagen"),
      { hint: "Braucht Exchange.ManageAsApp + Exchange-Administrator-Rolle (siehe Tenant-Verbindungstest)." });
  }
  const raw = r.data.mailboxes || [];
  return Array.isArray(raw) ? raw : [raw];
}

function sectionMailboxesFrom(mailboxes) {
  const byType = {};
  for (const m of mailboxes) {
    const t = m.RecipientTypeDetails || "Unbekannt";
    byType[t] = (byType[t] || 0) + 1;
  }
  const sorted = [...mailboxes].sort((a, b) => (a.DisplayName || "").localeCompare(b.DisplayName || ""));
  return {
    metrics: [
      metric("Postfächer gesamt", mailboxes.length),
      ...Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => metric(k, v))
    ],
    lists: [
      list("allMailboxes", "Alle Postfächer", ["Name", "E-Mail", "Typ", "Archiv", "Angelegt"],
        sorted.map(m => [m.DisplayName, m.PrimarySmtpAddress, m.RecipientTypeDetails, de(ARCHIVE_DE, m.ArchiveStatus), fmtDate(m.WhenMailboxCreated)]))
    ],
    data: { byType, mailboxes }
  };
}

function sectionSharedMailboxesFrom(mailboxes) {
  const shared = mailboxes.filter(m => m.RecipientTypeDetails === "SharedMailbox");
  const sorted = [...shared].sort((a, b) => (a.DisplayName || "").localeCompare(b.DisplayName || ""));
  return {
    metrics: [metric("Shared Mailboxes", shared.length)],
    lists: shared.length ? [
      list("sharedList", "Shared Mailboxes", ["Name", "E-Mail", "Archiv", "Angelegt"],
        sorted.map(m => [m.DisplayName, m.PrimarySmtpAddress, de(ARCHIVE_DE, m.ArchiveStatus), fmtDate(m.WhenMailboxCreated)]))
    ] : [],
    data: { total: shared.length }
  };
}

async function sectionIntuneDevices(tenant, cert) {
  // Property heisst im Graph-Schema von managedDevice "managedDeviceOwnerType",
  // nicht "ownerType" -- die falsche Bezeichnung liess $select mit einem
  // OData-Parse-Fehler scheitern und die ganze Sektion ausfallen.
  const devices = await graphAllPages(tenant, cert,
    "/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,osVersion,manufacturer,model,serialNumber,complianceState,lastSyncDateTime,userPrincipalName,managedDeviceOwnerType,enrolledDateTime",
    { retryTransient: true });
  const compliant = devices.filter(d => d.complianceState === "compliant").length;
  const byOs = {};
  for (const d of devices) { const os = d.operatingSystem || "unbekannt"; byOs[os] = (byOs[os] || 0) + 1; }
  const sorted = [...devices].sort((a, b) => (a.deviceName || "").localeCompare(b.deviceName || ""));

  return {
    metrics: [
      metric("Geräte gesamt", devices.length),
      metric("Konform", compliant, devices.length && compliant === 0 ? "crit" : "ok"),
      ...Object.entries(byOs).sort((a, b) => b[1] - a[1]).map(([os, n]) => metric(os, n))
    ],
    lists: [
      list("allIntuneDevices", "Alle Intune-Geräte",
        ["Gerät", "OS", "Version", "Hersteller/Modell", "Nutzer", "Besitz", "Compliance", "Letzter Sync"],
        sorted.map(d => [
          d.deviceName, d.operatingSystem, d.osVersion,
          [d.manufacturer, d.model].filter(Boolean).join(" "),
          d.userPrincipalName, de(OWNER_DE, d.managedDeviceOwnerType), de(COMPLIANCE_DE, d.complianceState),
          d.lastSyncDateTime ? fmtDate(d.lastSyncDateTime) : "nie"
        ]))
    ],
    data: { byOs, devices }
  };
}

async function sectionEntraDevices(tenant, cert) {
  const devices = await graphAllPages(tenant, cert,
    "/devices?$select=id,displayName,operatingSystem,operatingSystemVersion,trustType,accountEnabled,approximateLastSignInDateTime,deviceOwnership,isManaged,isCompliant&$top=999",
    { retryTransient: true });
  const trustDe = (t) => de(TRUST_DE, t);
  const byTrust = {};
  for (const d of devices) { const t = trustDe(d.trustType); byTrust[t] = (byTrust[t] || 0) + 1; }
  const sorted = [...devices].sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));

  return {
    metrics: [
      metric("Geräte im Verzeichnis", devices.length),
      ...Object.entries(byTrust).sort((a, b) => b[1] - a[1]).map(([k, v]) => metric(k, v))
    ],
    lists: [
      list("allEntraDevices", "Alle Entra-ID-Geräte", ["Gerät", "OS", "Version", "Verbindungstyp", "Status", "Letzte Anmeldung"],
        sorted.map(d => [
          d.displayName, d.operatingSystem, d.operatingSystemVersion, trustDe(d.trustType),
          d.accountEnabled === false ? "deaktiviert" : "aktiv",
          d.approximateLastSignInDateTime ? fmtDate(d.approximateLastSignInDateTime) : "nie"
        ]))
    ],
    data: { byTrust, devices }
  };
}

// Ab wann gilt ein Verzeichnis-Geraet als Karteileiche. 180 Tage ohne Anmeldung
// heisst in der Praxis: ausgemustert, verkauft oder neu aufgesetzt -- das Objekt
// steht nur noch im Weg und verfaelscht jede Geraetezahl.
const STALE_DEVICE_DAYS = 180;

// SKU-Bestandteile, die ueberhaupt erst erlauben, den Blueprint umzusetzen:
// ohne Intune keine Geraeteverwaltung, ohne Entra ID P1 kein Conditional Access
// mit Geraetebedingung. Beides steckt in Business Premium, E3 und E5.
const BLUEPRINT_PARTS = ["INTUNE_A", "AAD_PREMIUM"];

function providesBlueprint(parts) {
  const owned = new Set(parts || []);
  return BLUEPRINT_PARTS.some(need =>
    owned.has(need) || [...owned].some(p => (LICENSES.SKU_CONTAINS[p] || []).includes(need)));
}

/**
 * Querschnitte und Beobachtungen. Die vier Sektionen fuer sich sind Inventar --
 * die Aussage entsteht erst aus ihrer Verknuepfung: welches Konto hat eine
 * Lizenz, aber kein Geraet; welches Geraet steht im Verzeichnis, wird aber nicht
 * verwaltet; welches Postfach gehoert zu keinem aktiven Konto mehr.
 *
 * Bewusst OHNE Ampel: eine Bestandsaufnahme bewertet nicht, sie zaehlt und
 * markiert, was eine Entscheidung braucht. "0 kritisch, 18 unauffaellig" waere
 * eine Entwarnung, die niemand geprueft hat.
 */
function buildAnalysis(result) {
  const sec = result.sections || {};
  const dataOf = (id) => (sec[id] && sec[id].ok && sec[id].data) || null;

  const users = (dataOf("users") || {}).users || [];
  const lic = dataOf("licenses") || {};
  const userLic = lic.userLicenses || [];
  const mailboxes = (dataOf("mailboxes") || {}).mailboxes || [];
  const intune = (dataOf("intuneDevices") || {}).devices || [];
  const entra = (dataOf("entraDevices") || {}).devices || [];

  const observations = [];
  const crossChecks = [];
  const add = (title, text, detail) => observations.push({ title, text, detail: detail || null });

  // --- Kontoarten: trennt Menschen von Technik. Ohne das liest sich jede
  //     Benutzerliste als "25 Mitarbeitende", was hier schlicht falsch waere.
  const sharedUpns = new Set(mailboxes
    .filter(m => m.RecipientTypeDetails === "SharedMailbox")
    .map(m => String(m.PrimarySmtpAddress || "").toLowerCase()));
  const byKind = {};
  const kindOf = new Map();
  for (const u of users) {
    const k = accountKind(u, sharedUpns);
    kindOf.set(u.id, k);
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const realUsers = users.filter(u => kindOf.get(u.id) === "Benutzerkonto");
  const activeReal = realUsers.filter(u => u.accountEnabled !== false);

  // --- Blueprint-Faehigkeit: der zentrale Befund fuer jede Security-Offerte.
  if (userLic.length && activeReal.length) {
    const licByUpn = new Map(userLic.map(u => [String(u.upn || "").toLowerCase(), u]));
    const equipped = activeReal.filter(u => {
      const l = licByUpn.get(String(u.userPrincipalName || "").toLowerCase());
      return l && providesBlueprint(l.parts);
    });
    const missing = activeReal.filter(u => !equipped.includes(u));
    if (missing.length) {
      add("Blueprint-Lizenzen fehlen für einen Teil der Belegschaft",
        `${equipped.length} von ${activeReal.length} aktiven Benutzerkonten haben eine Lizenz, die Intune und Entra ID P1 enthält ` +
        `(Business Premium, E3 oder E5). Für die übrigen ${missing.length} sind Geräteverwaltung und Conditional Access mit ` +
        `Gerätebedingung heute nicht lizenziert — der Blueprint lässt sich dort nicht vollständig umsetzen.`,
        missing.map(u => u.displayName || u.userPrincipalName).sort());
      crossChecks.push(list("noBlueprintLicense", "Aktive Konten ohne Intune-/P1-Lizenz", ["Konto", "UPN"],
        missing.map(u => [u.displayName, u.userPrincipalName])));
    }
  }

  // --- Deaktiviert, aber lizenziert.
  const disabledLicensed = userLic.filter(u => !u.enabled);
  if (disabledLicensed.length) {
    add("Deaktivierte Konten tragen noch Lizenzen",
      `${disabledLicensed.length} deaktivierte Konten haben zugewiesene Lizenzen. Bei bezahlten Produkten läuft die Gebühr ` +
      `weiter; ausserdem verfälscht es die Seat-Zählung bei der nächsten Bestellung.`,
      disabledLicensed.map(u => `${u.displayName} — ${(u.licenses || []).join(", ")}`));
    crossChecks.push(list("disabledWithLicense", "Deaktivierte Konten mit Lizenz", ["Konto", "UPN", "Lizenzen"],
      disabledLicensed.map(u => [u.displayName, u.upn, (u.licenses || []).join(", ")])));
  }

  // --- Verzeichnis vs. Verwaltung: die Differenz ist die eigentliche Zahl.
  if (entra.length) {
    const intuneNames = new Set(intune.map(d => String(d.deviceName || "").toLowerCase()));
    const unmanaged = entra.filter(d => !intuneNames.has(String(d.displayName || "").toLowerCase()));
    if (unmanaged.length) {
      add("Nicht alle Geräte im Verzeichnis werden verwaltet",
        `Im Verzeichnis stehen ${entra.length} Geräte, über Intune verwaltet werden ${intune.length}. Die Differenz von ` +
        `${unmanaged.length} sind privat registrierte, ausgemusterte oder doppelt erfasste Geräte — sie erhalten keine ` +
        `Richtlinien und erscheinen in keiner Compliance-Auswertung.`);
      crossChecks.push(list("unmanagedDevices", "Im Verzeichnis, aber nicht in Intune",
        ["Gerät", "OS", "Verbindungstyp", "Letzte Anmeldung"],
        unmanaged
          .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""))
          .map(d => [d.displayName, d.operatingSystem, de(TRUST_DE, d.trustType),
            d.approximateLastSignInDateTime ? fmtDate(d.approximateLastSignInDateTime) : "nie"])));
    }

    // Karteileichen
    const stale = entra.filter(d => {
      const age = daysSince(d.approximateLastSignInDateTime);
      return age === null || age > STALE_DEVICE_DAYS;
    });
    if (stale.length) {
      add("Karteileichen im Geräteverzeichnis",
        `${stale.length} Geräte haben sich seit mehr als ${STALE_DEVICE_DAYS} Tagen nicht mehr angemeldet. Sie gehören ` +
        `geprüft und entfernt, sonst zählt jede künftige Geräteauswertung sie mit.`,
        stale.map(d => `${d.displayName} — zuletzt ${fmtDate(d.approximateLastSignInDateTime) || "nie"}`).sort());
    }

    // Doubletten: gleicher Anzeigename mehrfach im Verzeichnis. Entsteht beim
    // Neuaufsetzen oder Rejoin -- das alte Objekt bleibt stehen.
    const nameCount = {};
    for (const d of entra) {
      const key = String(d.displayName || "").toLowerCase();
      if (!key) continue;
      // Original-Schreibweise behalten -- im Dokument steht der Geraetename so,
      // wie er im Portal auftaucht, nicht kleingeschrieben.
      if (!nameCount[key]) nameCount[key] = { label: d.displayName, count: 0 };
      nameCount[key].count++;
    }
    const dupes = Object.values(nameCount).filter(x => x.count > 1);
    if (dupes.length) {
      add("Doppelte Geräteeinträge",
        `${dupes.length} ${dupes.length === 1 ? "Gerätename kommt" : "Gerätenamen kommen"} im Verzeichnis mehrfach vor. ` +
        `Typisch nach einem Neuaufsetzen oder erneutem Beitritt — der alte Eintrag bleibt bestehen und verdoppelt die Gerätezahl.`,
        dupes.map(x => `${x.label} (${x.count}×)`).sort());
    }
  }

  // --- Postfach ohne aktives Konto. Shared Mailboxes sind ausgenommen: die
  //     haben per Definition kein aktives Anmeldekonto, das ist ihr Zweck.
  if (mailboxes.length && users.length) {
    const activeUpns = new Set(users
      .filter(u => u.accountEnabled !== false)
      .map(u => String(u.userPrincipalName || "").toLowerCase()));
    const orphan = mailboxes.filter(m =>
      m.RecipientTypeDetails === "UserMailbox" &&
      !activeUpns.has(String(m.PrimarySmtpAddress || "").toLowerCase()));
    if (orphan.length) {
      crossChecks.push(list("orphanMailboxes", "Benutzerpostfächer ohne aktives Konto gleicher Adresse",
        ["Postfach", "E-Mail", "Angelegt"],
        orphan.map(m => [m.DisplayName, m.PrimarySmtpAddress, fmtDate(m.WhenMailboxCreated)])));
      add("Postfächer ohne passendes aktives Konto",
        `${orphan.length} ${orphan.length === 1 ? "Benutzerpostfach hat" : "Benutzerpostfächer haben"} kein aktives Konto ` +
        `mit derselben Adresse. Das ist nicht zwingend ein Fehler — die Anmeldeadresse (UPN) kann von der Mailadresse ` +
        `abweichen —, gehört bei einer Übernahme aber geklärt.`);
    }

    const noArchive = mailboxes.filter(m => String(m.ArchiveStatus || "None") !== "Active");
    if (noArchive.length) {
      add("Archivpostfächer weitgehend ungenutzt",
        `${noArchive.length} von ${mailboxes.length} Postfächern haben kein aktives Archiv. Ohne Archiv landet alles im ` +
        `Hauptpostfach und läuft dort gegen das Kontingent; für Aufbewahrungspflichten fehlt die Grundlage.`);
    }
  }

  return {
    observations,
    crossChecks,
    accountKinds: byKind,
    counts: {
      accounts: users.length,
      realUsers: realUsers.length,
      activeRealUsers: activeReal.length,
      licensed: userLic.length,
      mailboxes: mailboxes.length,
      intuneDevices: intune.length,
      entraDevices: entra.length
    }
  };
}

/**
 * Bestandsaufnahme erzeugen. sections: Array gewuenschter Section-Ids (leer = alle).
 * onProgress(label) fuer die Fortschrittsanzeige.
 */
async function runInventory(tenant, cert, sections, onProgress) {
  const wanted = new Set(Array.isArray(sections) && sections.length ? sections : SECTIONS.map(s => s.id));
  const result = {
    tenantId: tenant.id, tenantName: tenant.name, organization: tenant.organization || null,
    generatedAt: new Date().toISOString(), sections: {}
  };

  const run = async (id, label, fn) => {
    if (!wanted.has(id)) return;
    if (onProgress) onProgress(label);
    try {
      const r = await fn();
      result.sections[id] = { ok: true, label, metrics: r.metrics, lists: r.lists || [], data: r.data };
    } catch (e) {
      result.sections[id] = { ok: false, label, error: e.message, hint: e.hint || null, metrics: [] };
    }
  };

  await run("users", "Benutzer", () => sectionUsers(tenant, cert));
  await run("licenses", "Lizenzen", () => sectionLicenses(tenant, cert));

  if (wanted.has("mailboxes") || wanted.has("sharedMailboxes")) {
    if (onProgress) onProgress("Postfächer");
    try {
      const mailboxes = await fetchMailboxes(tenant, cert);
      if (wanted.has("mailboxes")) {
        const r = sectionMailboxesFrom(mailboxes);
        result.sections.mailboxes = { ok: true, label: "Postfächer", metrics: r.metrics, lists: r.lists, data: r.data };
      }
      if (wanted.has("sharedMailboxes")) {
        const r = sectionSharedMailboxesFrom(mailboxes);
        result.sections.sharedMailboxes = { ok: true, label: "Shared Mailboxes", metrics: r.metrics, lists: r.lists, data: r.data };
      }
    } catch (e) {
      const fail = { ok: false, error: e.message, hint: e.hint || null, metrics: [] };
      if (wanted.has("mailboxes")) result.sections.mailboxes = { ...fail, label: "Postfächer" };
      if (wanted.has("sharedMailboxes")) result.sections.sharedMailboxes = { ...fail, label: "Shared Mailboxes" };
    }
  }

  await run("intuneDevices", "Intune-Geräte", () => sectionIntuneDevices(tenant, cert));
  await run("entraDevices", "Azure-AD-Geräte", () => sectionEntraDevices(tenant, cert));

  // Querschnitte und Beobachtungen aus den gesammelten Rohdaten. Ersetzt die
  // frueheren Ampel-Zaehler ("0 kritisch, 18 unauffaellig"): die stammten aus dem
  // Security-Report und lasen sich hier wie eine geprüfte Entwarnung, obwohl
  // niemand etwas bewertet hatte.
  const analysis = buildAnalysis(result);
  result.observations = analysis.observations;
  result.crossChecks = analysis.crossChecks;
  result.accountKinds = analysis.accountKinds;
  result.counts = analysis.counts;
  result.summary = {
    observations: analysis.observations.length,
    failedSections: Object.values(result.sections).filter(s => !s.ok).map(s => s.label)
  };
  return result;
}

module.exports = { runInventory, SECTIONS, buildAnalysis };
