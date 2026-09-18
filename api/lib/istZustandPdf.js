"use strict";
/**
 * PDF «Microsoft 365 — Konfiguration und Ist-Zustand» aus der gespeicherten Erhebung
 * (lib/istZustand.js), dem Register «Entscheide und Kommentare» und den Kopfdaten
 * des Exports. Aufbau und Stil nach der SGVP-Vorlage (18.09.2026):
 *
 *   1 Zweck und Grundlage · 2 Überblick · 3 Konten, Rollen, Lizenzen, Gäste ·
 *   4 Anmeldung und bedingter Zugriff · 5 Geräte und Intune · 6 E-Mail ·
 *   7 Anwendungen und Freigaben · 8 SharePoint, OneDrive und Teams ·
 *   9 Abweichungen und Hinweise (Hauptteil, Anhang oder weggelassen) ·
 *   10 Änderungen (wenn ein Zeitraum erhoben wurde) · 11 Freigabe
 *
 * Beschreibend: Ist-Zustand, keine Chronik, kein Audit. Bewertungen stehen nur in
 * Kapitel 9. Was nicht erhoben werden konnte, steht in Kapitel 1 — nie als
 * "nicht vorhanden" im Text.
 */
const LAYOUT = require("./istPdfLayout");
const MODEL = require("./istZustandModel");
const { fmtDay, fmtTime } = MODEL;

const IGEEKS_FOOT = "igeeks AG · Räffelstrasse 24 · 8045 Zürich · support@igeeks.ch · +41 58 058 00 00";

// ------------------------------------------------------------------ Formate
function bytes(b) {
  if (b === null || b === undefined) return "—";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = Number(b), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString("de-CH", { maximumFractionDigits: v < 100 && i > 1 ? 1 : 0 })} ${u[i]}`;
}
const numCH = n => Number(n || 0).toLocaleString("de-CH");
const M = t => ({ t, f: "m" });
const SUB = t => (t ? { sub: t } : null);
const clean = arr => arr.filter(x => x !== null && x !== undefined && x !== "");
function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
function cap(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function joinDe(list) { const a = list.filter(Boolean); return a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " und " + a[a.length - 1]; }

// ------------------------------------------------------------------ Intune: Art und Zuweisung
const FAMILY = {
  endpointSecurityAntivirus: "Endpoint Security: Antivirus", endpointSecurityAttackSurfaceReduction: "Endpoint Security: Angriffsflächenreduzierung",
  endpointSecurityDiskEncryption: "Endpoint Security: Datenträgerverschlüsselung", endpointSecurityFirewall: "Endpoint Security: Firewall",
  endpointSecurityEndpointDetectionAndResponse: "Endpoint Security: EDR", endpointSecurityAccountProtection: "Endpoint Security: Kontoschutz",
  endpointSecurityApplicationControl: "Endpoint Security: Anwendungssteuerung", endpointSecurityEndpointPrivilegeManagement: "Endpoint Privilege Management",
  baseline: "Sicherheitsbaseline", deviceConfigurationScripts: "Skript", windowsOsRecoveryPolicies: "Wiederherstellung"
};
const ODATA_ART = [
  [/windowsUpdateForBusinessConfiguration/i, "Update-Ring"], [/CustomConfiguration/i, "Benutzerdefiniert (OMA-URI)"],
  [/windows10EndpointProtectionConfiguration/i, "Endpoint Protection"], [/windowsHealthMonitoringConfiguration/i, "Integritätsüberwachung"],
  [/GeneralConfiguration|GeneralDeviceConfiguration/i, "Geräteeinschränkungen"], [/IdentityProtection/i, "Identitätsschutz"],
  [/Wifi/i, "WLAN"], [/Vpn/i, "VPN"], [/Scep|Pkcs|TrustedRootCertificate|Certificate/i, "Zertifikat"],
  [/DeliveryOptimization/i, "Übermittlungsoptimierung"], [/editionUpgrade/i, "Editionsupgrade"], [/Kiosk/i, "Kiosk"],
  [/macOSDeviceFeatures/i, "Gerätefunktionen"], [/macOSExtensions/i, "Erweiterungen"], [/EndpointProtection/i, "Endpoint Protection"], [/DomainJoin/i, "Domänenbeitritt"]
];
function artOf(p) {
  if (p.source === "configurationPolicies") return FAMILY[p.templateFamily] || (p.templateFamily && p.templateFamily !== "none" ? p.templateFamily : "Settings Catalog");
  if (p.source === "deviceCompliancePolicies") return "Konformität";
  if (p.source === "deviceConfigurations") { const m = ODATA_ART.find(([re]) => re.test(p.odataType || "")); return m ? m[1] : "Gerätekonfiguration"; }
  return p.type || "—";
}
function assignText(asg) {
  const inc = asg.filter(a => !a.exclude), exc = asg.filter(a => a.exclude);
  if (!inc.length) return "nicht zugewiesen";
  const name = a => a.group ? a.group.name : a.kind === "allDevices" ? "Alle Geräte" : a.kind === "allUsers" ? "Alle Benutzer" : a.kind;
  const f = a => a.filter ? ` (Filter «${a.filter.name || a.filter}»${a.filter.mode ? ", " + a.filter.mode : ""})` : "";
  return inc.map(a => name(a) + f(a)).join(", ") + (exc.length ? "; ohne " + exc.map(name).join(", ") : "");
}
const unassigned = p => !p.assignments.some(a => !a.exclude);

// ------------------------------------------------------------------ Hauptfunktion
/**
 * data: { ds, register, settings, hash, createdBy }
 * settings: Kopfdaten und Optionen (siehe server.js ISTEXPORT_DEFAULTS)
 */
async function buildPdf(data) {
  const ds = data.ds;
  const S = ds.sections || {};
  const O = data.settings || {};
  const Lk = MODEL.createLookup(data.register || []);
  const I = S.identity || null, CA = S.ca || null, D = S.devices || null, IN = S.intune || null, ML = S.mail || null, A = S.apps || null, SP = S.sharepoint || null;
  const org = (I && I.org) || { displayName: ds.tenant.name, domains: [] };
  const kunde = O.kunde || org.displayName || ds.tenant.name;
  const fassung = O.fassung || "1.0";
  const fassungTxt = `Fassung ${fassung}${O.entwurf ? " (Entwurf)" : ""}`;
  const otherPlatforms = IN ? IN.policies.filter(p => /iOS|Android/i.test(p.platform)) : [];
  const groupChanges = MODEL.changeGroups(ds, data.register, { actor: O.aendAkteur || "", includeServiceChanges: !!O.aendAlle });
  const nb = MODEL.numbering({ kapitel9: O.kapitel9 || "haupt", changes: !!groupChanges, hasOtherPlatforms: otherPlatforms.length > 0 });
  const N = nb.n;
  const ref = k => `Kapitel ${N[k] || "?"}`;
  const chapterText = key => MODEL.commentText(Lk.chapter(key));

  const b = LAYOUT.create({ title: `Ist-Zustand Microsoft 365 ${kunde}` });
  const { p, note, h2, h3, table, kv, kpis, ul } = b;
  const intro = key => { const t = chapterText(key); if (t) p(t); };

  // ================================================================ Kopf
  const gen = ds.generatedAt, fin = ds.finishedAt || ds.generatedAt;
  b.header({ kicker: "Ist-Zustand", stamp: `${fassungTxt} · Stand ${fmtDay(gen)}, ${fmtTime(gen)}`, title: "Microsoft 365 — Konfiguration und Ist-Zustand", sub: [kunde, O.untertitel].filter(Boolean).join(" · ") });
  const initial = (org.domains || []).find(d => d.isInitial);
  const app = ds.tenant.readOnly ? "«M365-Security-Policy-Manager (nur lesen)» mit ausschliesslich lesenden Berechtigungen und der Rolle Globaler Leser" : "«M365-Security-Policy-Manager»";
  kv([
    ["Dokument", O.dokument || "Dokumentation des konfigurierten Zustands von Microsoft 365, Intune und Exchange Online"],
    ["Fassung", `${fassung}${O.entwurf ? " (Entwurf)" : ""} vom ${fmtDay(data.now || new Date().toISOString())}${O.ersetzt ? ", ersetzt " + O.ersetzt : ""}`],
    ["Mandant", { runs: [{ t: `${kunde} · ${initial ? initial.name : ds.tenant.organization} · Tenant-ID ` }, { t: ds.tenant.tenantId, f: "m" }] }],
    ["Auslesung", `${fmtDay(gen)}, ${fmtTime(gen)}–${fmtTime(fin)} Uhr. Lesend über Microsoft Graph (Anwendungsberechtigungen), Exchange Online und Security & Compliance PowerShell sowie öffentliches DNS; App-Registrierung ${app}.` +
      (ds.params && ds.params.changes ? ` Änderungen ${ds.params.changes.from === ds.params.changes.to ? "vom " + fmtDay(ds.params.changes.from) : `vom ${fmtDay(ds.params.changes.from)} bis ${fmtDay(ds.params.changes.to)}`} aus den Protokollen von Entra ID und Intune.` : "")],
    ["Erstellt von", O.erstelltVon || "igeeks AG"],
    O.empfaenger ? [O.empfaengerLabel || "Empfänger", [O.empfaenger, O.empfaengerFunktion, kunde].filter(Boolean).join(", ")] : null,
    O.verwendung ? ["Verwendung", O.verwendung] : null
  ]);

  // ================================================================ 1 Zweck
  h2(N.zweck, "Zweck und Grundlage");
  p(`Dieses Dokument beschreibt, was im Mandanten der ${kunde} zum Zeitpunkt der Auslesung konfiguriert ist und wie es wirkt. Grundlage ist ausschliesslich die Auslesung vom ${fmtDay(gen)}; Aussagen aus Korrespondenz oder Erinnerung sind nicht enthalten. Es beschreibt den Ist-Zustand, keine Chronik und kein Audit` +
    (nb.k9 === "haupt" ? `; Feststellungen, die vom beabsichtigten oder vom Microsoft-Standard abweichen, stehen gesammelt in Kapitel ${N.abw}.` : nb.k9 === "anhang" ? "; Feststellungen, die vom beabsichtigten oder vom Microsoft-Standard abweichen, stehen im Anhang A." : "."));
  intro("zweck");
  p("Die vollständigen Daten liegen als Anlagen bei. Jede Tabelle dieses Dokuments ist aus ihnen erzeugt.");
  const anlagen = [["A", { runs: [{ t: `Rohdaten dieser Auslesung vom ${fmtDay(gen)} (JSON, Export aus dem Werkzeug), Prüfsumme SHA-256 ` }, { t: data.hash || "—", f: "m" }] }]];
  for (const line of String(O.anlagen || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    const m = line.match(/^([A-Z0-9]{1,3})\s*[|:;–-]\s*(.+)$/);
    anlagen.push(m ? [m[1], m[2]] : [String.fromCharCode(65 + anlagen.length), line]);
  }
  table([{ label: "Anlage", w: 0.1 }, { label: "Inhalt", w: 0.9 }], anlagen);
  const notSubject = String(O.nichtGegenstand || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const notGraph = SP && SP.notViaGraph ? SP.notViaGraph.map(x => x.topic) : [];
  if (notSubject.length || notGraph.length) {
    b.h3(null, "Nicht Gegenstand der Auslesung");
    ul(clean([...notSubject, notGraph.length ? `SharePoint-Einstellungen, die Microsoft Graph nicht bereitstellt: ${joinDe(notGraph)} (SharePoint Admin Center bzw. SharePoint Online PowerShell).` : null]));
  }
  if ((ds.gaps || []).length) {
    b.h3(null, "Nicht vollständig erhoben");
    note("Diese Teile waren bei der Auslesung nicht lesbar. Die betroffenen Angaben fehlen im Dokument; sie sind nicht als «nicht vorhanden» zu lesen.");
    ul(ds.gaps.slice(0, 30).map(g => cap(g, 300)), { size: 8 });
    if (ds.gaps.length > 30) note(`… und ${ds.gaps.length - 30} weitere (vollständig in Anlage A).`);
  }

  // ================================================================ 2 Überblick
  h2(N.ueberblick, "Überblick");
  const members = I ? I.users.filter(u => u.type === "Member") : [];
  const guests = I ? I.users.filter(u => u.type === "Guest") : [];
  const ga = I ? MODEL.globalAdmins(I) : [];
  const caGroups = new Map(((CA && CA.groups) || []).map(g => [g.id, g]));
  const caPol = CA ? MODEL.sortCa(CA.policies) : [];
  const eff = caPol.map(x => MODEL.caEffect(x, caGroups));
  const effCount = k => eff.filter(e => e.kind === k).length;
  const mailEff = ML && ML.exo ? MODEL.mailEffective(ML.exo) : null;
  const winCfg = IN ? IN.policies.filter(x => x.platform === "Windows" && x.source !== "deviceCompliancePolicies") : [];
  const macCfg = IN ? IN.policies.filter(x => x.platform === "macOS" && x.source !== "deviceCompliancePolicies") : [];
  const intuneIds = new Set(((D && D.intune) || []).map(d => norm(d.entraId)).filter(Boolean));
  const entraOnly = D && D.entra ? D.entra.filter(d => !intuneIds.has(norm(d.deviceId)) && !/ios|android/i.test(d.os || "")) : null;
  const primary = ML && ML.dns ? ML.dns.find(x => !/onmicrosoft\.com$/i.test(x.domain)) : null;
  const overview = [
    I ? ["Konten", `${members.length} interne Konten, davon ${members.filter(u => u.licenses.length).length} lizenziert; ${guests.length} Gäste. ${ga.length} ${ga.length === 1 ? "Konto" : "Konten"} mit der Rolle Globaler Administrator (${ref("konten")})`] : null,
    CA ? ["Bedingter Zugriff", `${caPol.length} Richtlinien: ${effCount("wirksam")} wirksam, ${effCount("bericht")} im Modus «Nur Bericht», ${effCount("keine") + effCount("aus")} ohne Wirkung${effCount("aus") ? ` (davon ${effCount("aus")} ausgeschaltet)` : ""} (${ref("anm.ca")})`] : null,
    D ? ["Geräte", `${D.intune.length} Geräte in Intune (${countBy(D.intune, "os")}), ${D.intune.filter(d => d.compliance === "compliant").length} konform` + (entraOnly ? `; ${entraOnly.length ? entraOnly.length + " weitere Einträge nur in Entra ID" : "in Entra ID keine weiteren Einträge"}` : "") + ` (${ref("ger.geraete")})`] : null,
    IN ? ["Geräterichtlinien", `Windows: ${winCfg.filter(x => !unassigned(x)).length} zugewiesen, ${winCfg.filter(unassigned).length} nicht zugewiesen; macOS: ${macCfg.filter(x => !unassigned(x)).length} zugewiesen, ${macCfg.filter(unassigned).length} nicht zugewiesen; ${IN.policies.filter(x => x.source === "deviceCompliancePolicies").length} Konformitätsrichtlinien` + (IN.policies.filter(x => /OIB/.test(x.name)).length > IN.policies.length / 2 ? ". Grundlage ist überwiegend die OpenIntuneBaseline" : "")] : null,
    SP ? ["SharePoint", `${SP.summary.sites} Sites (${SP.summary.groupSites} zu Microsoft 365-Gruppen, davon ${SP.summary.teams} mit Teams), ${bytes(SP.summary.storageUsed)} belegt; ${SP.summary.oneDrives} OneDrive-Konten.` + (SP.summary.sharingLabel ? ` Externe Freigabe: ${SP.summary.sharingLabel}` : "") + ` (${ref("sp")})`] : null,
    ML ? ["E-Mail", mailOverview(primary, mailEff) + ` (${ref("mail")})`] : null,
    A ? ["Anwendungen", `${A.thirdParty.length} Unternehmensanwendungen von Drittanbietern; ${MODEL.grantRows(A).filter(g => g.orgWide && g.write).length} organisationsweite Freigaben mit Schreibrechten (${ref("apps")})`] : null
  ].filter(Boolean);
  table([{ label: "Bereich", w: 0.2 }, { label: "Ist-Zustand", w: 0.8 }], overview);

  // ================================================================ 3 Konten
  h2(N.konten, "Konten, Rollen, Lizenzen und Gäste");
  intro("konten");
  if (!I) p("Konten und Rollen waren bei der Auslesung nicht lesbar (Kapitel 1).");
  else {
    const mbx = new Map((((ML && ML.exo) || {}).mailboxes || []).map(m => [norm(m.upn), m]));
    const MBX = { SharedMailbox: "freigegebenes Postfach", RoomMailbox: "Raumpostfach", EquipmentMailbox: "Gerätepostfach" };
    h3(N["konten.intern"], "Interne Konten");
    intro("konten.intern");
    table([{ label: "Konto", w: 0.37 }, { label: "Zustand", w: 0.12 }, { label: "Lizenzen", w: 0.28 }, { label: "angelegt", w: 0.1 }, { label: "letzte Anmeldung", w: 0.13 }],
      members.map(u => {
        const r = Lk.account(u.upn);
        const m = mbx.get(norm(u.upn));
        return [
          [M(u.upn), SUB(r ? `${r.kindLabel}: ${r.purpose}${r.validUntil ? " (bis " + fmtDay(r.validUntil) + ")" : ""}` : null)].filter(Boolean),
          [{ t: u.enabled ? "aktiv" : "deaktiviert" }, SUB(m && MBX[m.type] ? MBX[m.type] : null)].filter(Boolean),
          u.licenses.map(x => skuName(I, x)).join(", ") || "—",
          fmtDay(u.created),
          u.signInKnown ? (u.lastSuccess || u.lastSignIn ? fmtDay(u.lastSuccess || u.lastSignIn) : "nie") : "—"
        ];
      }), { size: 7.8 });
    const shared = members.filter(u => { const m = mbx.get(norm(u.upn)); return m && m.type === "SharedMailbox"; });
    const notes = [];
    if (!I.signInAvailable) notes.push("Letzte Anmeldung: nicht lesbar (Entra ID P1 und AuditLog.Read.All nötig).");
    if (shared.length) notes.push(`Freigegebene Postfächer: ${shared.map(u => u.upn.split("@")[0] + "@").join(", ")}.`);
    if (notes.length) note(notes.join(" "));

    h3(N["konten.rollen"], "Administrative Rollen");
    intro("konten.rollen");
    const roles = [...I.roles].sort((a, c) => Number(c.templateId === "62e90394-69f5-4237-9190-012177145e10") - Number(a.templateId === "62e90394-69f5-4237-9190-012177145e10") || a.role.localeCompare(c.role) || String(a.principal).localeCompare(String(c.principal)));
    table([{ label: "Rolle", w: 0.3 }, { label: "Konto", w: 0.42 }, { label: "Art", w: 0.13 }, { label: "Zuweisung", w: 0.15 }],
      roles.map(r => {
        const acc = r.principalType === "user" ? Lk.account(r.principal) : null;
        return [r.role,
          [r.principalType === "group" ? { t: `Gruppe ${r.principal}` } : M(r.principal), SUB(r.principalType === "group" ? `Mitglieder: ${(r.members || []).join(", ") || "keine"}` : acc ? `${acc.kindLabel}: ${acc.purpose}` : null)].filter(Boolean),
          { user: "Benutzer", sp: "Dienst (App)", group: "Gruppe" }[r.principalType] || r.principalType, r.how];
      }), { size: 7.8 });

    h3(N["konten.gaeste"], "Gäste");
    intro("konten.gaeste");
    if (guests.length) {
      table([{ label: "Gast", w: 0.5 }, { label: "eingeladen", w: 0.15 }, { label: "Einladung", w: 0.15 }, { label: "letzte Anmeldung", w: 0.2 }],
        guests.map(u => [M(u.mail || u.upn), fmtDay(u.created), u.externalState === "PendingAcceptance" ? "ausstehend" : u.externalState === "Accepted" ? "angenommen" : "—",
          u.signInKnown ? (u.lastSuccess || u.lastSignIn ? fmtDay(u.lastSuccess || u.lastSignIn) : "nie") : "—"]), { size: 7.8 });
    } else p("Keine Gastkonten.");
    if (I.authz) p(`Gäste einladen dürfen ${INVITE[I.authz.allowInvitesFrom] || I.authz.allowInvitesFrom || "—"}. Gäste haben ${GUEST_ROLE[I.authz.guestUserRoleId] || "eine eigene Gastrolle"}.`);

    h3(N["konten.lizenzen"], "Lizenzen");
    const skus = I.skus.filter(s => s.consumed || (s.enabled && s.enabled < 1000)).sort((a, c) => c.consumed - a.consumed || a.name.localeCompare(c.name));
    table([{ label: "Produkt", w: 0.44 }, { label: "Kennung", w: 0.32 }, { label: "verfügbar", w: 0.12 }, { label: "zugewiesen", w: 0.12 }],
      skus.map(s => [s.name, M(s.part), s.enabled >= 10000 ? "unbegrenzt" : numCH(s.enabled), numCH(s.consumed)]));
  }

  // ================================================================ 4 Anmeldung
  h2(N.anm, "Anmeldung und bedingter Zugriff");
  intro("anm");
  h3(N["anm.methoden"], "Anmeldemethoden");
  intro("anm.methoden");
  if (I && I.authMethods) {
    const ms = I.authMethods.migrationState;
    p({ runs: clean([{ t: "Richtlinie für Anmeldemethoden, Migrationsstand " }, { t: ms || "—", f: "m" },
      { t: ms === "migrationComplete" ? ": Es gilt nur diese Richtlinie. " : ": Solange die Migration nicht abgeschlossen ist, gelten zusätzlich die älteren MFA- und SSPR-Einstellungen. " },
      { t: I.securityDefaults === true ? "Sicherheitsstandards (Security Defaults) sind eingeschaltet." : I.securityDefaults === false ? `Sicherheitsstandards (Security Defaults) sind ausgeschaltet${MODEL.mfaForAll(CA ? CA.policies : []).length ? "; die MFA-Pflicht wird über bedingten Zugriff durchgesetzt" : ""}.` : "" }]) });
    table([{ label: "Methode", w: 0.5 }, { label: "Zustand", w: 0.5 }], I.authMethods.methods.map(m => [m.label, { pill: m.state === "enabled" ? "aktiviert" : "deaktiviert", tone: m.state === "enabled" ? "ok" : "na" }]));
    if (I.authMethods.campaign && I.authMethods.campaign.state) note(`Registrierungskampagne für Microsoft Authenticator: ${I.authMethods.campaign.state === "enabled" ? "ein" : I.authMethods.campaign.state === "disabled" ? "aus" : "von Microsoft verwaltet"}.`);
  } else p("Die Richtlinie für Anmeldemethoden war nicht lesbar (Kapitel 1).");
  if (I && I.deviceRegistration) {
    const dr = I.deviceRegistration;
    p(`Geräteregistrierung: Entra-Join ${dr.join === "alle" ? "für alle Benutzer erlaubt" : dr.join === "ausgewählte" ? "für ausgewählte Benutzer erlaubt" : dr.join === "niemand" ? "für niemanden erlaubt" : "—"}, MFA beim Beitritt ${dr.mfa === "required" ? "verlangt" : dr.mfa === "notRequired" ? "nicht verlangt" : "—"}${dr.quota ? `, bis ${dr.quota} Geräte je Benutzer` : ""}.`);
  }

  h3(N["anm.ca"], "Richtlinien für bedingten Zugriff");
  if (!CA) p("Die Richtlinien für bedingten Zugriff waren nicht lesbar (Kapitel 1).");
  else {
    p("Die Spalte «Wirkung» beschreibt, ob eine Richtlinie auf Anmeldungen angewendet wird; darunter steht, was sie verlangt. Der Kommentar unter dem Namen hält fest, weshalb sie so gesetzt ist.");
    intro("anm.ca");
    table([{ label: "Richtlinie", w: 0.34 }, { label: "gilt für", w: 0.21 }, { label: "ausgenommen", w: 0.27 }, { label: "Wirkung", w: 0.18 }],
      caPol.map((x, i) => {
        const e = eff[i];
        const cmt = MODEL.commentText(Lk.of("ca", x.id, x.name));
        return [
          [{ t: x.name }, SUB(cmt)].filter(Boolean),
          cap(simplifyWho(x.who.include).join("; ") || "—", 400),
          cap(simplifyWho(x.who.exclude, true).join("; ") || "—", 500),
          [{ pill: e.label, tone: e.tone }, SUB(x.grant.blocks ? "blockiert" : x.effectShort && x.effectShort !== "—" ? x.effectShort : null)].filter(Boolean)
        ];
      }), { size: 7.4 });
    if (CA.summary && CA.summary.securityDefaults === null) note("Sicherheitsstandards: nicht lesbar.");

    h3(N["anm.gruppen"], "Geltungs- und Ausnahmegruppen");
    intro("anm.gruppen");
    if (CA.groups.length) {
      table([{ label: "Gruppe", w: 0.36 }, { label: "Mitglieder", w: 0.64 }], CA.groups.map(g => {
        const cmt = MODEL.commentText(Lk.of("gruppe", g.id, g.name));
        const mem = g.missing ? "Gruppe gelöscht" : clean([g.users.length ? g.users.join(", ") : null, g.deviceCount ? `${g.deviceCount} Geräte` : null]).join("; ") || "keine";
        return [[M(g.name), SUB(clean([g.includedBy ? `eingeschlossen in ${g.includedBy}` : null, g.excludedBy ? `ausgenommen in ${g.excludedBy}` : null]).join(", ") + (g.includedBy || g.excludedBy ? " Richtlinie(n)" : "")), SUB(cmt)].filter(Boolean),
          [{ t: cap(mem, 900) }, SUB(g.dynamic ? "dynamisch: " + cap(g.rule, 200) : null)].filter(Boolean)];
      }), { size: 7.8 });
    } else p("Die Richtlinien verweisen auf keine Gruppen.");
    const direct = [];
    const upnById = new Map(((I && I.users) || []).map(u => [u.id, u.upn]));
    for (const x of MODEL.mfaForAll(CA.policies)) {
      const ids = (x.raw.excludeUsers || []).filter(id => /^[0-9a-f-]{36}$/i.test(id));
      if (ids.length) direct.push(`Die Richtlinie «${x.name}» nimmt zusätzlich ${joinDe(ids.map(id => upnById.get(id) || id))} ausdrücklich aus.`);
    }
    if (direct.length) p(direct.join(" "));
  }

  // ================================================================ 5 Geräte
  h2(N.ger, "Geräte und Intune");
  intro("ger");
  h3(N["ger.geraete"], "Geräte in Intune");
  intro("ger.geraete");
  if (D && D.intune.length) {
    const apSerial = new Set((D.autopilot || []).map(a => norm(a.serial)));
    table([{ label: "Gerät", w: 0.1 }, { label: "System", w: 0.095 }, { label: "Modell", w: 0.11 }, { label: "Seriennr.", w: 0.1 }, { label: "Hauptbenutzer", w: 0.12 }, { label: "Entra", w: 0.07 },
      { label: "registriert", w: 0.085 }, { label: "letzter Sync", w: 0.085 }, { label: "Konformität", w: 0.1 }, { label: "verschl.", w: 0.065 }, { label: "Autopilot", w: 0.07 }],
    D.intune.map(d => {
      const cmt = MODEL.commentText(Lk.of("geraet", d.id, d.name));
      return [[M(d.name), SUB(cmt)].filter(Boolean), osText(d), modelText(d), M(d.serial || "—"), M(d.user ? d.user.split("@")[0] : "—"), joinLabel(d),
        fmtDay(d.enrolled), fmtDay(d.lastSync), { pill: MODEL.complianceLabel(d.compliance), tone: d.compliance === "compliant" ? "ok" : d.compliance === "inGracePeriod" ? "nt" : "open" },
        d.encrypted === null ? "—" : d.encrypted ? "ja" : "nein", d.autopilot === true || apSerial.has(norm(d.serial)) ? "ja" : "nein"];
    }), { size: 6.7, pad: 2.6 });
    if (entraOnly) {
      if (!entraOnly.length) p(`Entra ID enthält keine weiteren Windows- oder macOS-Geräte ausser diesen ${D.intune.length}.`);
      else {
        const dates = entraOnly.map(x => x.lastSignIn).filter(Boolean).sort();
        p(`Nur in Entra ID, ohne Intune-Verwaltung: ${entraOnly.length} Einträge${dates.length ? `, letzte Aktivität zwischen ${fmtDay(dates[0]).slice(6)} und ${fmtDay(dates[dates.length - 1])}` : ""}.`);
      }
    }
  } else p(D ? "In Intune sind keine Geräte verwaltet." : "Die Geräte waren nicht lesbar (Kapitel 1).");

  h3(N["ger.gruppen"], "Gerätegruppen und Autopilot");
  intro("ger.gruppen");
  if (D && (D.groups || []).length) {
    table([{ label: "Gruppe", w: 0.32 }, { label: "Mitgliedschaft", w: 0.46 }, { label: "Mitglieder", w: 0.22 }], D.groups.map(g => {
      const cmt = MODEL.commentText(Lk.of("gruppe", g.id, g.name));
      return [[M(g.name), SUB(cmt)].filter(Boolean),
        g.dynamic ? [{ t: "dynamisch" }, { t: cap(g.rule || "", 220), f: "m", s: 7 }] : [{ t: "statisch" + (g.nested.length ? ", enthält " + g.nested.join(", ") : "") }],
        clean([`${g.devices} Geräte`, g.users ? `${g.users} Benutzer` : null]).join(", ")];
    }), { size: 7.8 });
  } else if (D) p("Keine Gerätegruppen mit Intune-Zuweisungen.");
  if (D && D.profiles && D.profiles.length) {
    for (const pr of D.profiles) {
      p({ runs: clean([{ t: "Autopilot-Profil " }, M(pr.name), { t: pr.targets.length ? ", zugewiesen an " : ", nicht zugewiesen" },
        ...pr.targets.flatMap((t, i) => [i ? { t: ", " } : null, M(t.name + (t.exclude ? " (ausgeschlossen)" : ""))]).filter(Boolean),
        { t: `: ${pr.join}, Benutzer ${pr.userType === "administrator" ? "mit" : "ohne"} Administratorrechte${pr.deviceNameTemplate ? ", Gerätename nach Vorlage " : "."}` },
        pr.deviceNameTemplate ? M(pr.deviceNameTemplate) : null, pr.deviceNameTemplate ? { t: "." } : null]) });
    }
  }
  if (D && D.autopilot && D.autopilot.length) {
    const tags = {};
    for (const a of D.autopilot) tags[a.groupTag || "ohne Gruppentag"] = (tags[a.groupTag || "ohne Gruppentag"] || 0) + 1;
    p(`${D.autopilot.length} ${D.autopilot.length === 1 ? "Gerät ist" : "Geräte sind"} in Autopilot registriert (${Object.entries(tags).map(([k, v]) => `${k}: ${v}`).join(", ")}).`);
  }

  const polTable = (list, size) => {
    if (!list.length) { p("Keine."); return; }
    const sorted = [...list].sort((a, c) => Number(unassigned(a)) - Number(unassigned(c)) || a.name.localeCompare(c.name));
    table([{ label: "Richtlinie", w: 0.56 }, { label: "Art", w: 0.2 }, { label: "Zuweisung", w: 0.24 }], sorted.map(x => {
      const cmt = MODEL.commentText(Lk.of("intune", x.id, x.name));
      return [[{ t: x.name }, SUB(cmt)].filter(Boolean), artOf(x), assignText(x.assignments)];
    }), { size: size || 7.6 });
  };
  h3(N["ger.konform"], "Konformitätsrichtlinien");
  intro("ger.konform");
  if (IN) polTable(IN.policies.filter(x => x.source === "deviceCompliancePolicies"), 8); else p("Nicht lesbar (Kapitel 1).");
  h3(N["ger.win"], "Konfiguration Windows");
  intro("ger.win");
  if (IN) polTable(winCfg); else p("Nicht lesbar (Kapitel 1).");
  h3(N["ger.mac"], "Konfiguration macOS");
  intro("ger.mac");
  if (IN) polTable(macCfg); else p("Nicht lesbar (Kapitel 1).");
  h3(N["ger.apps"], "Zugewiesene Anwendungen");
  intro("ger.apps");
  if (IN && IN.apps.length) {
    const INT = { required: "erforderlich", available: "verfügbar", uninstall: "deinstallieren", availableWithoutEnrollment: "verfügbar ohne Registrierung" };
    table([{ label: "Anwendung", w: 0.42 }, { label: "Zuweisung", w: 0.58 }], IN.apps.map(a => {
      const cmt = MODEL.commentText(Lk.of("app", a.id, a.name));
      return [[{ t: a.name }, SUB(clean([a.type, cmt]).join(" · "))].filter(Boolean), a.targets.map(t => `${t.exclude ? "ausgeschlossen" : (INT[t.intent] || t.intent)}: ${t.target}`).join("; ")];
    }), { size: 7.8 });
  } else p(IN ? "Keine zugewiesenen Anwendungen." : "Nicht lesbar (Kapitel 1).");
  if (otherPlatforms.length) {
    h3(N["ger.weitere"], "Weitere Plattformen");
    intro("ger.weitere");
    polTable(otherPlatforms.filter(x => x.source !== "deviceCompliancePolicies"));
  }

  // ================================================================ 6 E-Mail
  h2(N.mail, "E-Mail");
  intro("mail");
  h3(N["mail.dns"], "Absenderauthentisierung (öffentliches DNS)");
  intro("mail.dns");
  const dnsList = ML && ML.dns ? ML.dns.filter(x => !/\.onmicrosoft\.com$/i.test(x.domain)) : [];
  if (!dnsList.length) p(ML && ML.exo ? "Keine eigenen E-Mail-Domains." : "Die E-Mail-Domains waren nicht lesbar (Kapitel 1).");
  for (const x of dnsList) {
    if (dnsList.length > 1) b.h3(null, x.domain);
    kv([
      ["SPF", x.spf && x.spf.record ? [M(x.spf.record), SUB(spfText(x.spf))] : "kein SPF-Eintrag"],
      ["DKIM", dkimText(x.dkim)],
      ["DMARC", x.dmarc && x.dmarc.record ? [M(x.dmarc.record), SUB(dmarcText(x.dmarc))] : "kein DMARC-Eintrag"],
      ["MX", x.mx && x.mx.length ? M(x.mx.join(", ")) : "kein MX-Eintrag"]
    ], { w: 0.14 });
  }
  if (ML && ML.dns && ML.dns.some(x => /\.onmicrosoft\.com$/i.test(x.domain))) note("Die Domain onmicrosoft.com verwaltet Microsoft; SPF und DKIM sind dort von Microsoft gesetzt.");

  h3(N["mail.schutz"], "Welche Schutzrichtlinie wirkt");
  intro("mail.schutz");
  if (!mailEff) p("Die Schutzrichtlinien von Exchange Online waren nicht lesbar (Kapitel 1).");
  else {
    const ps = mailEff.presets.filter(x => x.area === "EOP");
    const presetTxt = ps.length ? ps.map(x => `«${presetName(x.name)}» ${norm(x.state) === "enabled" ? "eingeschaltet" + (x.domains.length ? " für " + x.domains.join(", ") : x.users.length || x.groups.length ? " für einzelne Empfänger" : "") : "ausgeschaltet"}`).join("; ") : "nicht eingerichtet";
    p(`Microsoft wendet je Empfänger und Schutzart genau eine Richtlinie an, in dieser Reihenfolge: Voreinstellung «Streng», Voreinstellung «Standard», eigene Richtlinien nach Priorität, zuletzt die Standardrichtlinie (Default). Die Voreinstellungen von Microsoft (Preset Security Policies): ${presetTxt}.`);
    const rows = [];
    for (const k of mailEff.kinds) {
      const groups = new Map();
      for (const d of k.perDomain) { const key = (d.policy || "") + "|" + d.via; if (!groups.has(key)) groups.set(key, { d, domains: [] }); groups.get(key).domains.push(d.domain); }
      for (const { d, domains } of groups.values()) {
        const cmt = MODEL.commentText(Lk.of("mail", d.policy, d.policy));
        rows.push([k.label, domains.length === mailEff.domains.length && mailEff.domains.length > 1 ? "alle Domains" : domains.join(", "),
          [d.policy ? M(d.policy) : { t: "keine" }, SUB(clean([d.partial.length ? "vorher für einzelne Empfänger: " + d.partial.map(x => x.policy).join(", ") : null, cmt]).join(" · "))].filter(Boolean), d.via]);
      }
    }
    table([{ label: "Schutz", w: 0.16 }, { label: "Domain", w: 0.2 }, { label: "wirksame Richtlinie", w: 0.32 }, { label: "über", w: 0.32 }], rows, { size: 7.6 });
    if (mailEff.shadowed.length) note(`Ohne Wirkung wegen Vorrang: ${mailEff.shadowed.map(s => `${s.policy} (${s.kind}, ${s.by})`).join("; ")}.`);
    // Verdikte der wirksamen Anti-Spam-Richtlinie
    const spam = mailEff.kinds.find(k => k.key === "spam");
    const main = spam && (spam.perDomain.find(x => primary && norm(x.domain) === norm(primary.domain)) || spam.perDomain[0]);
    const sp = main && (ML.exo.spamPolicies || []).find(x => norm(x.name) === norm(main.policy));
    const mw = mailEff.kinds.find(k => k.key === "malware");
    const mwMain = mw && (mw.perDomain.find(x => primary && norm(x.domain) === norm(primary.domain)) || mw.perDomain[0]);
    const mp = mwMain && (ML.exo.malwarePolicies || []).find(x => norm(x.name) === norm(mwMain.policy));
    if (sp) {
      p({ runs: [{ t: "Einstellungen der wirksamen Anti-Spam-Richtlinie " }, M(sp.name), { t: mp ? " und der Anti-Malware-Richtlinie " : ":" }, mp ? M(mp.name) : null, mp ? { t: ":" } : null].filter(Boolean) });
      const q = ML.exo.quarantine || [];
      table([{ label: "Verdikt", w: 0.26 }, { label: "Aktion", w: 0.22 }, { label: "Freigabe aus der Quarantäne", w: 0.52 }], clean([
        ["Spam", MODEL.actionText(sp.spam), MODEL.tagText(sp.spamTag, q)],
        ["Spam, hohe Konfidenz", MODEL.actionText(sp.hcSpam), MODEL.tagText(sp.hcSpamTag, q)],
        ["Phishing", MODEL.actionText(sp.phish), MODEL.tagText(sp.phishTag, q)],
        ["Phishing, hohe Konfidenz", MODEL.actionText(sp.hcPhish), MODEL.tagText(sp.hcPhishTag, q)],
        ["Massenmail", `${MODEL.actionText(sp.bulk)} ab BCL ${sp.bcl}`, sp.bulk === "Quarantine" ? MODEL.tagText(sp.bulkTag, q) : "—"],
        mp ? ["Schadsoftware", "Quarantäne", MODEL.tagText(mp.tag, q) + (mp.internal && mp.internalTo ? ` · Meldung an ${mp.internalTo}` : "")] : null
      ]), { size: 7.6 });
      const qp = q.filter(x => !/^Default|^AdminOnly/i.test(x.name));
      const gq = (ML.exo.quarantineGlobal || [])[0];
      if (qp.length || sp.retention) note(clean([qp.length ? "Quarantäne-Richtlinien: " + qp.map(x => `${x.name} (${MODEL.tagText(x.name, q).split(": ").slice(1).join(": ")})`).join("; ") + "." : null,
        sp.retention ? `Aufbewahrung in der Quarantäne ${sp.retention} Tage.` : null, gq && gq.frequencyDays ? `Benachrichtigung der Empfänger alle ${gq.frequencyDays} Tag(e).` : null]).join(" "));
    }
    const mailCmts = Lk.all.filter(e => e.objectType === "mail" && !(mailEff.kinds.some(k => k.perDomain.some(d => norm(d.policy) === norm(e.objectId || e.objectName)))));
    if (mailCmts.length) note(mailCmts.map(e => `«${e.objectName}»: ${e.text}`).join(" "));
  }

  h3(N["mail.weitere"], "Weitere Einstellungen");
  intro("mail.weitere");
  if (ML && ML.exo) table([{ label: "Bereich", w: 0.2 }, { label: "Einstellung", w: 0.8 }], mailSettings(ML.exo, mailEff), { size: 8 });
  else p("Nicht lesbar (Kapitel 1).");

  h3(N["mail.warnungen"], "Warnungsrichtlinien");
  intro("mail.warnungen");
  if (ML && ML.alerts) {
    const active = ML.alerts.filter(a => !a.disabled);
    const own = active.filter(a => !a.system);
    const sysTo = [...new Set(active.filter(a => a.system).flatMap(a => a.notifyTo))];
    p(`Von ${active.length} aktiven Warnungsrichtlinien ${own.length === 1 ? "ist eine" : `sind ${own.length}`} selbst erstellt. Die übrigen sind Microsoft-Standardrichtlinien` +
      (sysTo.length ? `; sie melden an ${sysTo.map(x => x === "TenantAdmins" ? "«TenantAdmins», also an die Postfächer aller Globalen Administratoren" : x).join(", ")}.` : "."));
    if (own.length) table([{ label: "Richtlinie", w: 0.36 }, { label: "Kategorie", w: 0.18 }, { label: "Schweregrad", w: 0.12 }, { label: "Meldung an", w: 0.34 }],
      own.map(a => [a.name, a.category || "—", a.severity || "—", a.notify ? (a.notifyTo.join(", ") || "—") : "keine Meldung"]), { size: 7.8 });
    if (ML.dlp && ML.dlp.length) note(`DLP-Regeln: ${ML.dlp.filter(x => !x.disabled).length} aktiv (${[...new Set(ML.dlp.map(x => x.policy))].join(", ")}).`);
  } else p("Die Warnungsrichtlinien waren nicht lesbar (Kapitel 1).");

  // ================================================================ 7 Anwendungen
  h2(N.apps, "Anwendungen und Freigaben");
  intro("apps");
  h3(N["apps.einst"], "Einstellungen");
  intro("apps.einst");
  if (I && I.authz) {
    const pg = I.authz.permissionGrantPoliciesAssigned || [];
    const consent = pg.some(x => /legacy/i.test(x)) ? "ja, allen Apps" : pg.some(x => /microsoft-user-default-low|recommended/i.test(x)) ? "ja, für Apps von verifizierten Herausgebern mit geringen Berechtigungen (Microsoft-Empfehlung)" : pg.some(x => /ManagePermissionGrantsForSelf/i.test(x)) ? "ja, nach eigener Richtlinie (" + pg.join(", ") + ")" : "nein";
    kv([
      ["Benutzer dürfen Apps zustimmen", consent],
      ["Workflow für Administratorzustimmung", I.adminConsent ? (I.adminConsent.enabled ? `ein (${I.adminConsent.reviewers} Prüfer)` : "aus") : "nicht lesbar"],
      ["Benutzer dürfen Apps registrieren", I.authz.allowedToCreateApps ? "ja" : "nein"],
      ["Benutzer dürfen Mandanten erstellen", I.authz.allowedToCreateTenants === undefined ? "—" : I.authz.allowedToCreateTenants ? "ja" : "nein"],
      ["Self-Service-Anmeldung für Testversionen per E-Mail", I.authz.allowedToSignUpEmailBasedSubscriptions ? "ja" : "nein"],
      ["Beitritt per E-Mail-Bestätigung", I.authz.allowEmailVerifiedUsersToJoinOrganization ? "ja" : "nein"]
    ], { w: 0.45 });
  } else p("Nicht lesbar (Kapitel 1).");
  h3(N["apps.freigaben"], "Freigaben mit weitreichenden Berechtigungen");
  intro("apps.freigaben");
  if (A) {
    const g = MODEL.grantRows(A);
    if (g.length) table([{ label: "Anwendung", w: 0.19 }, { label: "Ressource", w: 0.13 }, { label: "freigegeben für", w: 0.2 }, { label: "Berechtigungen", w: 0.48 }], g.map(r => {
      const cmt = MODEL.commentText(Lk.of("anwendung", r.clientSpId, r.client));
      return [[{ t: r.client }, SUB(cmt)].filter(Boolean), r.resource, r.kind === "Anwendung" ? [{ t: "die App selbst" }, SUB("Anwendungsberechtigung")] : r.orgWide ? r.who : [{ t: "Benutzer" }, M(String(r.who).replace(/^Benutzer /, ""))], { t: cap(r.scopes.join(" "), 1100), f: "m", s: 7 }];
    }), { size: 7.4 });
    else p("Keine Freigaben mit Schreibrechten oder organisationsweitem Lesezugriff an Drittanbieter-Apps.");
    note("Aufgeführt sind delegierte Freigaben mit Schreib- oder tenantweiten Leserechten und Anwendungsberechtigungen von Drittanbieter-Apps. Freigaben an Microsoft-Dienste sind nicht aufgeführt, ausgenommen Verwaltungswerkzeuge wie «Microsoft Graph Command Line Tools».");
  } else p("Nicht lesbar (Kapitel 1).");
  h3(N["apps.reg"], "App-Registrierungen mit Anmeldedaten");
  intro("apps.reg");
  if (A) {
    const regs = A.registrations.filter(r => r.secrets.length || r.certs.length);
    const endTxt = arr => arr.length ? arr.map(c => fmtDay(c.end) + (c.end && new Date(c.end) < new Date() ? " (abgelaufen)" : "")).join(", ") : "—";
    if (regs.length) table([{ label: "Registrierung", w: 0.4 }, { label: "angelegt", w: 0.14 }, { label: "Geheimnis gültig bis", w: 0.23 }, { label: "Zertifikat gültig bis", w: 0.23 }], regs.map(r => {
      const cmt = MODEL.commentText(Lk.of("anwendung", r.id, r.name));
      return [[{ t: r.name }, SUB(cmt)].filter(Boolean), fmtDay(r.created), endTxt(r.secrets), endTxt(r.certs)];
    }), { size: 7.8 });
    else p("Keine App-Registrierungen mit Geheimnis oder Zertifikat.");
  } else p("Nicht lesbar (Kapitel 1).");
  h3(N["apps.dritt"], "Unternehmensanwendungen von Drittanbietern");
  intro("apps.dritt");
  if (A && A.thirdParty.length) {
    table([{ label: "Anwendung", w: 0.42 }, { label: "Herausgeber", w: 0.3 }, { label: "hinzugefügt", w: 0.14 }, { label: "Zustand", w: 0.14 }], A.thirdParty.map(a => {
      const cmt = MODEL.commentText(Lk.of("anwendung", a.id, a.name));
      return [[{ t: a.name }, SUB(cmt)].filter(Boolean), a.own ? "eigene Registrierung" : (a.verified ? a.verified + " (verifiziert)" : a.publisher || "—"), fmtDay(a.created), a.enabled ? "aktiv" : "deaktiviert"];
    }), { size: 7.6 });
  } else p(A ? "Keine." : "Nicht lesbar (Kapitel 1).");

  // ================================================================ 8 SharePoint
  h2(N.sp, "SharePoint, OneDrive und Teams");
  intro("sp");
  if (!SP) p("SharePoint und OneDrive waren nicht lesbar (Kapitel 1).");
  else renderSharePoint(b, SP, I, N, Lk);

  // ================================================================ 9 Abweichungen
  const skip = new Set(Array.isArray(O.skipHints) ? O.skipHints : []);
  const hintList = MODEL.hints(ds, data.register, { kapitel9: nb.k9, changes: !!groupChanges }).filter(h => !skip.has(h.id));
  const renderHints = () => {
    p("Feststellungen aus der Auslesung, bei denen der konfigurierte Zustand vom beabsichtigten oder vom Microsoft-Standard abweicht, dazu bewusste Entscheide aus dem Register. Sie beschreiben den Zustand, nicht die Massnahme.");
    intro("abw");
    if (!hintList.length) { p("Keine."); return; }
    table([{ label: "Nr.", w: 0.06 }, { label: "Feststellung", w: 0.8 }, { label: "Kapitel", w: 0.14 }],
      hintList.map((h, i) => [String(i + 1), cap(h.text, 1500), h.refText || nb.ref(h.ref) || "—"]), { size: 8 });
  };
  if (nb.k9 === "haupt") { h2(N.abw, "Abweichungen und Hinweise"); renderHints(); }

  // ================================================================ 10 Änderungen
  if (groupChanges) {
    const C = S.changes;
    h2(N.aend, `Änderungen vom ${fmtDay(C.days.from)}${C.days.to !== C.days.from ? " bis " + fmtDay(C.days.to) : ""}`);
    p(`Grundlage sind die Protokolle von Entra ID und Intune für diesen Zeitraum (Anlage A). Ausgeblendet sind Anmeldungen und automatische Änderungen durch Microsoft-Dienste${O.aendAkteur ? `; aufgeführt sind nur Änderungen von Konten oder Apps mit «${O.aendAkteur}» im Namen` : ""}. «vorher» und «nachher» geben die geänderten Eigenschaften wieder, die Begründung stammt aus dem Register des Werkzeugs.`);
    intro("aend");
    if (C.retention && C.retention.entraAlreadyGone) note("Entra ID hält Protokolleinträge 30 Tage; ältere Änderungen in Entra ID sind nicht mehr enthalten.");
    if (!groupChanges.length) p("Im gewählten Zeitraum sind keine Änderungen protokolliert.");
    groupChanges.forEach((g, i) => {
      h3(`${N.aend}.${i + 1}`, `${g.title}, ${fmtTime(g.first)}${fmtTime(g.last) !== fmtTime(g.first) ? "–" + fmtTime(g.last) : ""}`);
      p(`Ausgeführt von ${g.actors.map(a => a.actor + (g.actors.length > 1 ? ` (${a.n})` : "")).join(", ")}; ${g.rows.length} ${g.rows.length === 1 ? "Änderung" : "Änderungen"}.`);
      if (g.intro) p(g.intro);
      table([{ label: "Objekt", w: 0.28 }, { label: "vorher", w: 0.2 }, { label: "nachher", w: 0.2 }, { label: "Begründung", w: 0.32 }], g.rows.map(r => [
        [{ t: cap(r.objekt, 200) }, SUB(`${fmtTime(r.at)} · ${r.activity}`)], cap(r.vorher, 300), cap(r.nachher, 300), r.begruendung ? cap(r.begruendung, 700) : { t: "—", c: "#8a97a2" }
      ]), { size: 7.2 });
    });
  }

  // ================================================================ 11 Freigabe
  h2(N.freigabe, "Freigabe");
  intro("freigabe");
  const creator = String(O.erstelltVon || "igeeks AG").split(",")[0];
  b.sign([["Erstellt, igeeks AG", creator, "", ""], [`Zur Kenntnis, ${kunde}`, [O.empfaenger, O.empfaengerFunktion].filter(Boolean).join(", "), "", ""]]);
  b.foot(IGEEKS_FOOT);

  // Anhang ohne erzwungenen Seitenumbruch (Vorgabe: keine Umbrüche zwischen Abschnitten).
  if (nb.k9 === "anhang") { h2("Anhang A", "Abweichungen und Hinweise"); renderHints(); }

  return b.finish(`igeeks AG · Microsoft 365 Ist-Zustand ${kunde} · ${fassungTxt}`);
}

// ------------------------------------------------------------------ SharePoint
const KIND_PILL = { teams: ["Team", "ok"], group: ["Gruppe", "na"], communication: ["Kommunikation", "na"], teamSite: ["Team-Site", "na"], classic: ["Klassisch", "na"], channel: ["Kanal", "na"], other: ["Andere", "na"], unknown: ["Art offen", "na"], system: ["System", "na"] };
const SHARE_TONE = { ok: "ok", info: "ok", warn: "nt", crit: "open", muted: "na" };
function renderSharePoint(b, SP, I, N, Lk) {
  const { p, note, h3, table, kv, kpis } = b;
  const R = SP.reports || {};
  const S = SP.summary;
  const intro = key => { const t = MODEL.commentText(Lk.chapter(key)); if (t) p(t); };
  p(`Ausgelesen am ${fmtDay(SP.generatedAt)} über Microsoft Graph (SharePoint-Einstellungen, Sites, Microsoft 365-Gruppen) und den Microsoft-365-Nutzungsbericht (${SP.periodDays} Tage${R.refreshDate ? ", Stand " + fmtDay(R.refreshDate) : ""}). Speicher laut Nutzungsbericht, für Sites ohne Berichtszeile aus der Standardbibliothek; «geändert» umfasst auch automatische Änderungen durch Microsoft-Dienste.` +
    (R.concealed ? ` Die Nutzungsberichte des Mandanten sind anonymisiert. ${R.joinNote || ""}` : ""));
  const guests = I ? I.users.filter(u => u.type === "Guest") : [];
  const gSites = SP.sites.filter(s => s.group);
  const inGroups = new Set(gSites.flatMap(s => (s.group.guests || []).map(g => norm(g.upn || g.name))));
  kpis([
    { value: S.sites, label: "Sites", detail: `${S.groupSites} zu Microsoft 365-Gruppen, davon ${S.teams} mit Teams${S.systemSites ? `; dazu ${S.systemSites} System-Sites` : ""}` },
    { value: bytes(S.storageUsed), label: "belegt in Sites", detail: S.storageUnknown ? `${S.storageUnknown} Sites ohne Angabe` : "laut Nutzungsbericht und Standardbibliotheken" },
    { value: S.oneDrives, label: "OneDrive-Konten", detail: `${bytes(S.oneDriveStorage)} belegt` },
    { value: I ? guests.length : S.guests, label: "externe Personen", detail: I ? `Gastkonten in Entra ID${inGroups.size ? `, davon ${inGroups.size} Gast in einer Gruppe` : ""}` : "Gäste in Gruppen" }
  ]);

  h3(N["sp.freigabe"], "Freigabe-Einstellungen des Mandanten");
  intro("sp.freigabe");
  if (SP.settings) {
    const rows = [];
    const sh = SP.settings.sharing;
    rows.push(["Externe Freigabe SharePoint", [{ pill: sh.label, tone: SHARE_TONE[sh.tone] || "na" }, SUB(sh.key !== "externalUserAndGuestSharing" ? "Links für «Jeder» (anonym) sind damit nicht möglich." : sh.description)].filter(Boolean)]);
    for (const g of SP.settings.groups) for (const it of g.items) if (it.label !== "Freigabestufe SharePoint") rows.push([it.label, it.value]);
    kv(rows, { w: 0.32 });
    note(`Nicht über Microsoft Graph lesbar und hier nicht enthalten: ${joinDe((SP.notViaGraph || []).map(x => x.topic))}. Die Freigabestufe einer Site kann die des Mandanten nur einschränken, nicht erweitern.`);
  } else p("Die tenantweiten SharePoint-Einstellungen waren nicht lesbar (Kapitel 1).");

  h3(N["sp.sites"], "Sites");
  intro("sp.sites");
  const ord = { teams: 0, group: 0, communication: 1, teamSite: 1, classic: 1, channel: 1, other: 1, unknown: 1, system: 2 };
  const sites = [...SP.sites].sort((a, c) => (ord[a.kind] - ord[c.kind]) || ((c.storageUsed || 0) - (a.storageUsed || 0)));
  const max = Math.max(1, ...sites.map(s => s.storageUsed || 0));
  table([{ label: "Site", w: 0.23 }, { label: "Art", w: 0.1 }, { label: "Besitzer", w: 0.2 }, { label: "Mitglieder", w: 0.1 }, { label: "externe Freigabe", w: 0.12 }, { label: "Speicher", w: 0.14 }, { label: "geändert", w: 0.11 }],
    sites.map(s => {
      const g = s.group;
      const kp = KIND_PILL[s.kind] || ["—", "na"];
      const cmt = MODEL.commentText(Lk.of("site", s.id, s.name).concat(g ? Lk.of("gruppe", g.id, g.displayName) : []));
      const owners = g ? (g.ownerCount === 0 ? [{ t: "kein Besitzer", f: "b" }] : [{ t: g.owners.map(o => personName(o)).join(", ") }]) : s.reportOwner ? [{ t: s.reportOwner.name || s.reportOwner.upn }, SUB("laut Nutzungsbericht")] : [{ t: "—" }];
      return [
        [{ t: s.name, f: "b" }, { t: s.path === "/" ? (s.host || "/") : s.path, f: "m", s: 6.8, c: "#5a6b78" }, SUB(cmt)].filter(Boolean),
        [{ pill: s.orphanGroup ? "Gruppe fehlt" : kp[0], tone: kp[1] }, SUB(g ? g.visibilityLabel.toLowerCase() : null)].filter(Boolean),
        owners,
        g && g.memberCount !== null ? `${g.memberCount}${g.guestCount ? `, davon ${g.guestCount} ${g.guestCount === 1 ? "Gast" : "Gäste"}` : ""}` : "—",
        s.reportSharing ? { pill: s.reportSharing.label, tone: SHARE_TONE[s.reportSharing.tone] || "na" } : "—",
        { bar: { v: s.storageUsed || 0, max, label: bytes(s.storageUsed) } },
        fmtDay(s.modified)
      ];
    }), { size: 7.3 });
  note("«Team»: Microsoft 365-Gruppe mit Teams. «Gruppe»: Microsoft 365-Gruppe ohne Teams. «System»: von Microsoft angelegte Sites (Suchcenter, OneDrive-Stamm, Portale). Besitzer und Mitglieder stammen aus der Microsoft 365-Gruppe; für Sites ohne Gruppe liefert Microsoft Graph sie nicht. Der Speicherbalken ist relativ zur grössten Site." +
    (SP.sites.some(s => s.reportSharing) ? " Externe Freigabe je Site laut Nutzungsbericht." : " Externe Freigabe je Site: nicht über Microsoft Graph lesbar."));

  h3(N["sp.gruppen"], "Microsoft 365-Gruppen: Besitzer und Mitglieder");
  intro("sp.gruppen");
  if (gSites.length) {
    table([{ label: "Gruppe", w: 0.2 }, { label: "Sichtbarkeit", w: 0.11 }, { label: "angelegt", w: 0.1 }, { label: "Besitzer", w: 0.24 }, { label: "Mitglieder", w: 0.35 }],
      [...gSites].sort((a, c) => a.group.displayName.localeCompare(c.group.displayName)).map(s => {
        const g = s.group;
        const cmt = MODEL.commentText(Lk.of("gruppe", g.id, g.displayName));
        return [[{ t: g.displayName, f: "b" }, SUB(cmt)].filter(Boolean), [{ t: g.visibilityLabel.toLowerCase() }, SUB(g.teams ? "mit Teams" : null)].filter(Boolean), fmtDay(g.created),
          g.ownerCount === 0 ? { t: "kein Besitzer", f: "b" } : g.owners.map(personName).join(", "),
          cap(g.members.map(personName).join(", ") + (g.membersTruncated ? ` … (${g.memberCount} insgesamt)` : ""), 900) || "—"];
      }), { size: 7.3 });
    note("«öffentlich»: Jede Person der Organisation kann der Gruppe beitreten und ihre Dateien lesen.");
  } else p("Keine Microsoft 365-Gruppen mit Site.");

  h3(N["sp.onedrive"], "OneDrive");
  intro("sp.onedrive");
  const od = SP.oneDrive.accounts;
  if (od.length) {
    const omax = Math.max(1, ...od.map(a => a.storageUsed || 0));
    table([{ label: "Konto", w: 0.34 }, { label: "Speicher", w: 0.34 }, { label: "geändert", w: 0.16 }, { label: "angelegt", w: 0.16 }],
      od.map(a => [[M(a.upn ? a.upn.split("@")[0] + "@" : a.name), SUB(a.enabled === false ? "Konto deaktiviert" : null)].filter(Boolean), { bar: { v: a.storageUsed || 0, max: omax, label: bytes(a.storageUsed) } }, fmtDay(a.modified), fmtDay(a.created)]), { size: 7.3 });
  } else p("Keine OneDrive-Konten.");

  h3(N["sp.extern"], "Externe Personen");
  intro("sp.extern");
  if (I) {
    if (guests.length) {
      const memberOf = new Map();
      for (const s of gSites) for (const m of s.group.members || []) if (m.guest) { const k = norm(m.id); if (!memberOf.has(k)) memberOf.set(k, []); memberOf.get(k).push(s.group.displayName); }
      p("Gastkonten in Entra ID, neueste zuerst, mit ihren Microsoft 365-Gruppen:");
      table([{ label: "Name", w: 0.26 }, { label: "Adresse", w: 0.36 }, { label: "eingeladen", w: 0.13 }, { label: "Gruppen", w: 0.25 }],
        [...guests].sort((a, c) => String(c.created).localeCompare(String(a.created))).map(u => [u.name || "—", M(u.mail || u.upn), fmtDay(u.created), (memberOf.get(norm(u.id)) || []).join(", ") || "—"]), { size: 7.3 });
    } else p("Keine Gastkonten in Entra ID.");
    const raw = SP.settings && SP.settings.raw;
    note("Personen, die über SharePoint-Freigaben ohne Gastkonto in Entra ID eingeladen wurden (SharePoint-eigene Gastkonten), liefert Microsoft Graph nicht; sie stehen im SharePoint Admin Center." + (raw && raw.sharingCapability === "externalUserAndGuestSharing" ? " «Jeder»-Links sind erlaubt; wer einen solchen Link nutzt, erscheint nirgends als Person." : ""));
  } else p("Nicht lesbar (Kapitel 1).");
}

// ------------------------------------------------------------------ Hilfen
const INVITE = {
  none: "nur Administratoren über die Verwaltung (Einladungen sonst gesperrt)", adminsAndGuestInviters: "Administratoren und Inhaber der Rolle «Gasteinladender»",
  adminsGuestInvitersAndAllMembers: "Administratoren, Gasteinladende und alle Mitglieder", everyone: "alle Benutzer, auch Gäste"
};
const GUEST_ROLE = {
  "10dae51f-b6af-4016-8d66-8c2a99b929b3": "eingeschränkten Zugriff (Eigenschaften und Mitgliedschaften von Verzeichnisobjekten)",
  "2af84b1e-32c8-42b7-82bc-daa82404023b": "den am stärksten eingeschränkten Zugriff (nur eigene Verzeichnisobjekte)",
  "a0b1b346-4d3e-4e8b-98f8-753987be4970": "denselben Zugriff wie Mitglieder"
};
function skuName(I, part) { const s = (I.skus || []).find(x => x.part === part); return s ? s.name : part; }
function countBy(list, key) { const m = {}; for (const x of list) m[x[key] || "unbekannt"] = (m[x[key] || "unbekannt"] || 0) + 1; return Object.entries(m).map(([k, v]) => `${v} ${k}`).join(", "); }
function osText(d) {
  const v = String(d.osVersion || "");
  if (/windows/i.test(d.os || "")) return "Win " + v.replace(/^10\.0\./, "");
  if (/mac/i.test(d.os || "")) return "macOS " + v.split(" ")[0];
  return `${d.os || ""} ${v}`.trim() || "—";
}
function modelText(d) { return String(d.model || "—").replace(/^Apple /, "").replace(/^(LENOVO|HP) /i, ""); }
function joinLabel(d) {
  return { azureADJoined: "joined", azureADRegistered: "registriert", hybridAzureADJoined: "hybrid", unknown: "—" }[d.joinType] || (d.enrollmentType ? d.enrollmentType : "—");
}
function personName(o) { return (o.name || o.upn || "") + (o.guest ? " (Gast)" : ""); }
/** Wer-Angaben der CA-Auswertung kürzen: Konten nur als Anmeldename, Gastarten zusammenfassen. */
function simplifyWho(list, dropGroupPrefix) {
  return (list || []).map(x => {
    let s = String(x).replace(/^.+ \(([^()\s]+@[^()\s]+)\)$/, "$1");
    s = s.replace(/^Gäste\/externe Benutzer \(([^)]*)\)$/, (m, types) => (types.split(",").length >= 5 ? "Gäste und externe Benutzer" : `Gäste (${types.replace(/,\s*/g, ", ")})`));
    if (dropGroupPrefix) s = s.replace(/^Gruppe /, "");
    return s;
  });
}
function presetName(n) { return /strict/i.test(n) ? "Streng" : /standard/i.test(n) ? "Standard" : n; }
function spfText(s) {
  const m = String(s.record || "").match(/([~?+-])all\b/i);
  const all = m ? { "~": "~all (Soft Fail: nicht gelistete Absender werden markiert)", "-": "-all (Hard Fail: nicht gelistete Absender werden abgewiesen)", "?": "?all (neutral)", "+": "+all (jeder Absender erlaubt)" }[m[1]] : "ohne all-Mechanismus";
  return `${all}; ${s.lookups} von 10 DNS-Abfragen${s.lookupLimitExceeded ? " — Limit überschritten" : ""}`;
}
function dmarcText(d) {
  const pol = { none: "Beobachtungsmodus", quarantine: "Quarantäne", reject: "Abweisen" }[d.policy] || "ohne gültige Richtlinie";
  const rua = (String(d.record).match(/rua=([^;]+)/i) || [])[1];
  return `${pol}${d.pct && d.pct < 100 ? `, für ${d.pct} %` : ""}; ${rua ? "Berichte an " + rua.trim() : "keine Berichtsadresse"}`;
}
function dkimText(k) {
  if (!k) return "—";
  if (!k.enabledInM365) return "Signierung nicht aktiv";
  return k.cnamesPublished ? "Signierung aktiv, CNAME-Einträge selector1 und selector2 gesetzt" : "Signierung in Exchange Online aktiv, CNAME-Einträge im DNS nicht gefunden";
}
function mailOverview(primary, eff) {
  const bits = [];
  if (primary) {
    bits.push(primary.dkim && primary.dkim.enabledInM365 ? "DKIM aktiv" : "DKIM nicht aktiv");
    const m = primary.spf && primary.spf.record ? (String(primary.spf.record).match(/[~?+-]all\b/i) || ["ohne all"])[0] : null;
    bits.push(m ? `SPF mit ${m}` : "kein SPF");
    bits.push(primary.dmarc && primary.dmarc.policy ? `DMARC p=${primary.dmarc.policy}` : "kein DMARC");
  }
  if (eff) {
    const spam = eff.kinds.find(k => k.key === "spam");
    const via = spam ? [...new Set(spam.perDomain.map(d => d.preset ? `Microsoft-Voreinstellung «${d.preset}»` : d.isDefault ? "Standardrichtlinie" : d.policy))] : [];
    if (via.length) bits.push(`Anti-Spam wirkt über ${via.join(", ")}`);
    const sl = eff.kinds.find(k => k.key === "safeLinks");
    if (sl && sl.perDomain.some(d => d.policy)) bits.push("Safe Links " + (sl.perDomain.every(d => d.builtIn) ? "über den integrierten Schutz" : "aktiv"));
  }
  return bits.join("; ");
}
function mailSettings(x, eff) {
  const rows = [];
  const first = k => (x[k] || [])[0] || null;
  const sl = eff && eff.kinds.find(k => k.key === "safeLinks");
  const slPol = sl ? [...new Set(sl.perDomain.map(d => d.policy).filter(Boolean))] : [];
  const slObj = slPol.map(n => (x.safeLinks || []).find(p => norm(p.name) === norm(n))).filter(Boolean);
  if (slPol.length) rows.push(["Safe Links", slObj.length ? slObj.map(p => `${p.name}: ${clean([p.email ? "E-Mail" : null, p.teams ? "Teams" : null, p.office ? "Office-Apps" : null]).join(", ")}; URL-Umschreibung ${p.rewrite ? "ein" : "aus"}, Klickverfolgung ${p.track ? "ein" : "aus"}`).join(" · ") : slPol.join(", ") + " (integrierter Schutz von Microsoft)"]);
  else rows.push(["Safe Links", "keine Richtlinie (Defender for Office 365 nicht lizenziert oder nicht eingerichtet)"]);
  const sa = eff && eff.kinds.find(k => k.key === "safeAttach");
  const saPol = sa ? [...new Set(sa.perDomain.map(d => d.policy).filter(Boolean))] : [];
  const saObj = saPol.map(n => (x.safeAttach || []).find(p => norm(p.name) === norm(n))).filter(Boolean);
  const atp = first("atpO365");
  if (saPol.length) rows.push(["Safe Attachments", (saObj.length ? saObj.map(p => `${p.name}: Aktion «${MODEL.actionText(p.action)}», Quarantäne ${p.tag || "—"}`).join(" · ") : saPol.join(", ") + " (integrierter Schutz)") + (atp ? `. Schutz für SharePoint, OneDrive und Teams ${atp.spoTeamsOdb ? "ein" : "aus"}, Safe Documents ${atp.safeDocs ? "ein" : "aus"}` : "")]);
  else rows.push(["Safe Attachments", "keine Richtlinie"]);
  const ob = (x.outbound || []).find(o => o.isDefault) || first("outbound");
  if (ob) rows.push(["Ausgehend", `Höchstens ${numCH(ob.extHour)} externe und ${numCH(ob.intHour)} interne Empfänger pro Stunde, ${numCH(ob.day)} pro Tag (0 = Microsoft-Standard); bei Überschreitung ${{ BlockUser: "wird das Konto gesperrt", BlockUserForToday: "wird das Konto bis zum nächsten Tag gesperrt", Alert: "nur eine Warnung" }[ob.action] || ob.action}.` +
    (ob.notify && ob.notifyTo.length ? ` Meldung an ${ob.notifyTo.join(", ")}.` : "") + (ob.bcc && ob.bccTo.length ? ` Verdächtige Nachrichten in Blindkopie an ${ob.bccTo.join(", ")}.` : "")]);
  const fwdRule = (x.transportRules || []).filter(r => /forward|weiterleit/i.test(r.name));
  const rd = (x.remoteDomains || []).find(r => r.domain === "*" || /default/i.test(r.name));
  const fwdMbx = (x.mailboxes || []).filter(m => m.fwdSmtp || m.fwd);
  if (ob || rd) rows.push(["Weiterleitung", clean([ob ? `Automatische Weiterleitung nach extern: ${{ Off: "aus", On: "erlaubt", Automatic: "Microsoft-Standard (aus)" }[ob.autoForward] || ob.autoForward} (ausgehende Spamrichtlinie)` : null,
    rd ? `Remote-Domain «Default»: Weiterleitung ${rd.autoForward ? "erlaubt" : "gesperrt"}` : null, fwdRule.length ? `Transportregel ${fwdRule.map(r => `${r.name} (${r.state === "Enabled" ? r.mode : "aus"})`).join(", ")}` : null,
    fwdMbx.length ? `${fwdMbx.length} ${fwdMbx.length === 1 ? "Postfach leitet" : "Postfächer leiten"} weiter: ${fwdMbx.map(m => `${m.smtp} an ${String(m.fwdSmtp || m.fwd).replace(/^smtp:/i, "")}`).join(", ")}` : "keine Weiterleitung auf Postfächern"]).join(". ")]);
  const oc = first("orgConfig");
  if (oc) rows.push(["Direct Send", oc.rejectDirectSend ? "wird abgewiesen" : "erlaubt (Microsoft-Standard)"]);
  const tc = first("transportConfig");
  const smtpOn = (x.cas || []).filter(c => c.smtpAuth === false).map(c => c.smtp);
  if (tc) rows.push(["SMTP AUTH", `auf Organisationsebene ${tc.smtpAuthDisabled ? "aus" : "ein"}; einzeln freigegeben: ${smtpOn.join(", ") || "keines"}`]);
  if ((x.cas || []).length) {
    const n = x.cas.length, c = k => x.cas.filter(m => m[k]).length;
    rows.push(["POP, IMAP, ActiveSync", `von ${n} Postfächern: POP ${c("pop")}, IMAP ${c("imap")}, ActiveSync ${c("eas")} eingeschaltet`]);
  }
  const et = first("externalTag");
  if (et) rows.push(["Externe Absender", et.enabled ? "werden in Outlook gekennzeichnet" : "werden nicht gekennzeichnet"]);
  const sub = first("submission");
  if (sub) rows.push(["Gemeldete Nachrichten", clean([sub.toMicrosoft ? "gehen an Microsoft" : "gehen nicht an Microsoft", sub.custom ? `und an ${[...new Set([...(sub.junkTo || []), ...(sub.phishTo || [])])].join(", ") || "ein eigenes Postfach"}` : null]).join(" ")]);
  const ad = first("adminAudit");
  const mbAudit = (x.mailboxes || []).filter(m => /UserMailbox|SharedMailbox/.test(m.type));
  if (ad || oc) rows.push(["Protokollierung", clean([ad ? `Einheitliches Überwachungsprotokoll ${ad.unified ? "ein" : "aus"}` : null, oc ? `Postfach-Überwachung ${oc.auditDisabled ? "organisationsweit aus" : "ein"}${mbAudit.length ? ` (${mbAudit.filter(m => m.audit).length} von ${mbAudit.length} Benutzer- und freigegebenen Postfächern)` : ""}` : null]).join("; ")]);
  const tr = (x.transportRules || []);
  if (tr.length) rows.push(["Transportregeln", tr.map(r => `${r.name} (${r.state === "Enabled" ? ({ Enforce: "aktiv", Audit: "nur protokollieren", AuditAndNotify: "protokollieren mit Hinweis" }[r.mode] || r.mode) : "aus"})`).join(", ")]);
  const con = [...(x.inbound || []).map(c => `eingehend ${c.name}${c.enabled ? "" : " (aus)"}`), ...(x.outboundConnectors || []).map(c => `ausgehend ${c.name}${c.enabled ? "" : " (aus)"}`)];
  rows.push(["Connectoren", con.join(", ") || "keine"]);
  return rows;
}

module.exports = { buildPdf, artOf, assignText, bytes };
