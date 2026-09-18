"use strict";
/**
 * PDFs zu den Nachweisen (Bereich "Nachweise") — ein Baustein je Art, Layout aus
 * lib/pdfDesign.js. Jeder Nachweis nennt am Ende, wann, von wem und mit welchen
 * Parametern er erhoben wurde, und was dabei nicht lesbar war.
 */
const D = require("./pdfDesign");
const { pl, cap, fmtDate, fmtDateTime } = D;

const TITLES = {
  changelog: { lines: ["Änderungs-", "protokoll"], label: "Änderungsprotokoll" },
  ual: { lines: ["Audit-Log-", "Auszug"], label: "Audit-Log-Auszug" },
  accounts: { lines: ["Privilegierte Konten", "und Ausnahmen"], label: "Privilegierte Konten" },
  dossier: { lines: ["Konto-", "Steckbrief"], label: "Konto-Steckbrief" },
  recipients: { lines: ["Benachrichtigungs-", "empfänger"], label: "Benachrichtigungsempfänger" },
  app: { lines: ["Enterprise-App-", "Nachweis"], label: "Enterprise-App-Nachweis" },
  health: { lines: ["Service-", "Status"], label: "Service-Status" }
};

function build(entry, tenant) {
  const t = TITLES[entry.kind] || { lines: ["Nachweis"], label: "Nachweis" };
  const d = entry.data || {};
  const b = D.create({
    kicker: "Microsoft 365 · Nachweis",
    titleLines: t.lines,
    subtitle: entry.title,
    tenantName: tenant.name, organization: tenant.organization, date: entry.createdAt,
    stamps: [`${fmtDateTime(entry.createdAt)}${entry.createdBy ? " durch " + entry.createdBy : ""}`],
    coverTiles: tiles(entry.kind, d),
    footerLabel: "Nachweis · " + t.label,
    coverNote: "Aus dem Tenant ausgelesen (Microsoft Graph bzw. Exchange Online, nur lesend) und im Werkzeug archiviert."
  });
  b.cover();
  const fn = { changelog, ual, accounts, dossier, recipients, app, health }[entry.kind];
  if (fn) fn(b, d, entry);
  method(b, entry, d);
  return b.finish();
}

function tiles(kind, d) {
  const s = d.summary || {};
  switch (kind) {
    case "changelog": return [{ label: "Intune-Ereignisse", value: s.intune || 0 }, { label: "Entra-Ereignisse", value: s.entra || 0 }, { label: "Anmeldungen", value: s.signIns == null ? "—" : s.signIns }];
    case "ual": return [{ label: "Einträge", value: s.records || 0 }, { label: "ändernd", value: s.changing || 0, tone: "warn" }, { label: "löschend", value: s.deleting || 0, tone: "crit" }, { label: "Konten", value: s.users || 0 }];
    case "accounts": return [{ label: "Konten mit Rollen", value: (d.privileged && d.privileged.summary.accounts) || 0 }, { label: "Globale Admins", value: (d.privileged && d.privileged.summary.globalAdmins) || 0 }, { label: "Register-Einträge", value: (d.register && d.register.summary.entries) || 0 }, { label: "kritisch", value: (d.register && d.register.summary.critical) || 0, tone: "crit" }];
    case "dossier": return [{ label: "Rollen", value: s.roles || 0 }, { label: "Gruppen", value: s.groups || 0 }, { label: "Anmeldemethoden", value: s.methods || 0 }];
    case "recipients": return [{ label: "Meldungswege", value: s.entries || 0 }, { label: "Adressen", value: s.addresses || 0 }, { label: "Treffer Beobachtung", value: s.watchHits || 0, tone: "warn" }];
    case "app": return [{ label: "delegierte Rechte", value: s.delegatedScopes || 0 }, { label: "davon heikel", value: s.riskyScopes || 0, tone: "warn" }, { label: "Anwendungsrechte", value: s.applicationPermissions || 0 }, { label: "aktive Konten", value: s.activeUsers || 0 }];
    case "health": return [{ label: "offen", value: s.open || 0, tone: "warn" }, { label: "behoben", value: s.resolved || 0 }, { label: "Dienste beeinträchtigt", value: s.degraded || 0, tone: "crit" }];
    default: return [];
  }
}

// ---------------------------------------------------------------- Änderungsprotokoll
function changelog(b, d) {
  b.h1("Zeitraum und Umfang");
  b.card([
    ["Zeitraum", `${fmtDateTime(d.from)} bis ${fmtDateTime(d.to)} (Schweizer Zeit)`],
    ["Quellen", (d.params.sources || ["intune", "entra"]).map(s => ({ intune: "Intune-Audit", entra: "Entra-Audit", signins: "Anmeldeprotokoll" }[s] || s)).join(", ")],
    d.params.actor && ["Filter Akteur", d.params.actor],
    d.params.text && ["Filter Text", d.params.text],
    d.params.user && ["Filter Konto", d.params.user],
    ["Ereignisse", `${d.summary.events} (Intune ${d.summary.intune}, Entra ${d.summary.entra})${d.summary.signIns != null ? ` · ${d.summary.signIns} Anmeldungen` : ""}`]
  ].filter(Boolean));
  if (d.retention) {
    b.note("Aufbewahrung bei Microsoft", `Entra-Einträge dieses Zeitraums löscht Microsoft um den ${fmtDate(d.retention.entraDeletedAround)}${d.retention.entraAlreadyGone ? " — ältere sind bereits weg" : ""}; das Unified Audit Log hält sie bis etwa ${fmtDate(d.retention.ualDeletedAround)}. Dieser Nachweis ist die Sicherung.`, d.retention.entraAlreadyGone ? "warn" : "info");
  }
  if (d.summary.byActor && d.summary.byActor.length) {
    b.h2("Wer hat etwas verändert");
    b.table([{ label: "Akteur", w: 0.7 }, { label: "Ereignisse", w: 0.3 }], d.summary.byActor.map(x => [{ text: x.key, bold: true }, String(x.n)]), { size: 7.8 });
  }
  if (d.events && d.events.length) {
    b.h2("Ereignisse");
    b.table([{ label: "Zeit", w: 0.14 }, { label: "Quelle", w: 0.08 }, { label: "Akteur", w: 0.2 }, { label: "Vorgang", w: 0.22 }, { label: "Objekt und Änderung", w: 0.36 }],
      d.events.slice(0, 1500).map(e => [fmtDateTime(e.at), e.source, e.actor + (e.actorType ? `\n(${e.actorType})` : ""),
        e.activity + (e.result && !/^success/i.test(e.result) ? `\n${e.result}` : ""),
        e.targets.map(t => t.name + (t.type ? ` [${t.type}]` : "") + t.changes.slice(0, 6).map(c => `\n  ${c.name}: ${cap(c.old, 60) || "—"} › ${cap(c.new, 60) || "—"}`).join("")).join("\n") || "—"]), { size: 6.9 });
    if (d.events.length > 1500) b.small(`… und ${d.events.length - 1500} weitere (vollständig im CSV-Export).`);
  } else b.body("Im Zeitraum keine passenden Ereignisse.");
  if (d.signIns && d.signIns.length) {
    b.h2("Anmeldungen");
    b.table([{ label: "Zeit", w: 0.14 }, { label: "Konto", w: 0.22 }, { label: "App", w: 0.18 }, { label: "Gerät / Ort", w: 0.24 }, { label: "Ergebnis", w: 0.22 }],
      d.signIns.slice(0, 1500).map(s => [fmtDateTime(s.at), s.user, s.app + (s.nonInteractive ? "\n(nicht interaktiv)" : ""), [s.device, s.location, s.ip].filter(Boolean).join("\n"),
        s.result + (s.ca ? `\nCA: ${s.ca}` : "")]), { size: 6.9 });
    if (d.signIns.length > 1500) b.small(`… und ${d.signIns.length - 1500} weitere (vollständig im CSV-Export).`);
  }
}

// ---------------------------------------------------------------- Unified Audit Log
function ual(b, d, entry) {
  b.h1("Suche");
  b.card([
    ["Zeitraum", `${fmtDateTime(d.query.from)} bis ${fmtDateTime(d.query.to)} (Schweizer Zeit)`],
    d.query.keyword && ["Stichwort", d.query.keyword],
    d.query.operations && d.query.operations.length && ["Vorgänge", d.query.operations.join(", ")],
    d.query.users && d.query.users.length && ["Konten", d.query.users.join(", ")],
    d.appId && ["Nur Einträge der App", d.appId + (d.otherAppRecords ? ` (${d.otherAppRecords} Treffer anderer Apps ausgeblendet)` : "")],
    ["Einträge", `${d.summary.records}${d.capped ? " (gekappt)" : ""} · ${d.summary.changing} ändernd · ${d.summary.deleting} löschend`, d.summary.deleting ? { tone: "crit" } : null]
  ].filter(Boolean));
  if (d.appId) {
    const bad = (d.summary.deleting || 0) + (d.summary.moving || 0);
    b.note(bad ? "Löschende oder verschiebende Vorgänge gefunden" : "Keine löschenden oder verschiebenden Vorgänge",
      bad
        ? `Die App hat im Zeitraum ${pl(d.summary.deleting || 0, "löschenden", "löschende")} und ${pl(d.summary.moving || 0, "verschiebenden Vorgang", "verschiebende Vorgänge")} ausgeführt — Einzelheiten unten.`
        : "Im Unified Audit Log steht für diese App im Zeitraum kein löschender und kein verschiebender Vorgang. Das belegt, soweit Microsoft es protokolliert, dass die App nichts gelöscht oder verschoben hat.",
      bad ? "crit" : "ok");
  }
  b.h2("Vorgänge");
  b.table([{ label: "Vorgang", w: 0.36 }, { label: "Anzahl", w: 0.1 }, { label: "Art", w: 0.14 }, { label: "Konten", w: 0.4 }],
    d.operations.map(o => [{ text: o.operation, bold: true }, String(o.n), o.deleting ? { text: "löschend", pill: "crit" } : o.moving ? { text: "verschiebend", pill: "crit" } : o.changing ? { text: "ändernd", pill: "warn" } : { text: "lesend", pill: "muted" }, o.users.slice(0, 8).join(", ") + (o.users.length > 8 ? " …" : "")]), { size: 7.6 });
  b.h2("Einträge");
  b.table([{ label: "Zeit", w: 0.15 }, { label: "Vorgang", w: 0.2 }, { label: "Konto", w: 0.22 }, { label: "Objekt", w: 0.3 }, { label: "Dienst", w: 0.13 }],
    d.records.slice(0, 1500).map(r => [fmtDateTime(r.at), { text: r.operation, tone: r.deleting || r.moving ? "crit" : r.changing ? "warn" : null }, r.user, r.target || "—", r.service]), { size: 6.9 });
  if (d.records.length > 1500) b.small(`… und ${d.records.length - 1500} weitere (vollständig im CSV-Export).`);
}

// ---------------------------------------------------------------- Konten
function accounts(b, d) {
  const p = d.privileged;
  if (p) {
    b.h1("Privilegierte Konten");
    b.tiles([
      { label: "Konten mit Rolle", value: p.summary.accounts },
      { label: "privilegiert", value: p.summary.privileged, tone: "warn" },
      { label: "Globale Admins", value: p.summary.globalAdmins, tone: p.summary.globalAdmins > 4 ? "crit" : "info" },
      { label: "privilegiert ohne MFA", value: p.summary.withoutMfa, tone: "crit" },
      { label: "neu (30 Tage)", value: p.summary.createdLast30, tone: "info" }
    ]);
    b.table([{ label: "Konto", w: 0.27 }, { label: "Rollen", w: 0.33 }, { label: "Angelegt", w: 0.1 }, { label: "Letzte Anmeldung", w: 0.12 }, { label: "MFA", w: 0.18 }],
      p.accounts.map(a => [
        { text: `${a.name}\n${a.upn}${a.enabled === false ? "\n(deaktiviert)" : ""}`, bold: true },
        a.roles.map(r => `${r.name} — ${r.how}${r.scope ? " (Bereich)" : ""}${r.end ? ", bis " + fmtDate(r.end) : ""}`).join("\n"),
        fmtDate(a.created), a.signInKnown ? fmtDate(a.lastSignIn) : "—",
        a.mfaRegistered === null ? "—" : a.mfaRegistered ? (a.methods || []).join(", ") || "registriert" : { text: "keine Methode", pill: "crit" }
      ]), { size: 7.2 });
    if (p.apps && p.apps.length) {
      b.h2("Anwendungen mit Admin-Rollen");
      b.table([{ label: "Anwendung", w: 0.4 }, { label: "Rollen", w: 0.6 }], p.apps.map(a => [{ text: a.name, bold: true }, a.roles.map(r => `${r.name} — ${r.how}`).join("\n")]), { size: 7.6 });
    }
  }
  const r = d.register;
  if (r) {
    b.h1("Ausnahme-Register");
    b.body("Zweck, Verantwortung und Ablaufdatum von Sonderkonten (Test-, Admin-, Dienst- und Notfallkonten) stehen nicht in Entra ID. Das Register hält sie fest und wird hier gegen den Tenant geprüft.");
    if (r.entries.length) {
      b.table([{ label: "Konto", w: 0.25 }, { label: "Art / Zweck", w: 0.32 }, { label: "Verantwortlich", w: 0.13 }, { label: "Gültig bis", w: 0.1 }, { label: "Stand im Tenant", w: 0.2 }],
        r.entries.map(e => [{ text: e.upn, bold: true }, `${e.kindLabel}: ${e.purpose}${e.ticket ? `\nTicket ${e.ticket}` : ""}`, e.owner || "—", e.validUntil ? fmtDate(e.validUntil + "T12:00:00Z") : "—",
          { text: e.state, pill: e.tone }]), { size: 7.3 });
    } else b.small("Noch keine Einträge.");
    if (r.suggestions && r.suggestions.length) {
      b.h2("Sonderkonten ohne Registereintrag");
      b.table([{ label: "Konto", w: 0.4 }, { label: "Grund", w: 0.45 }, { label: "Angelegt", w: 0.15 }],
        r.suggestions.slice(0, 200).map(s => [{ text: s.upn + (s.enabled ? "" : " (deaktiviert)"), bold: true }, s.reasons.join("; "), fmtDate(s.created)]), { size: 7.3 });
    }
  }
}

// ---------------------------------------------------------------- Konto-Steckbrief
function dossier(b, d) {
  const u = d.user;
  b.h1(u.name || u.upn);
  b.card([
    ["UPN", u.upn],
    ["Status", u.enabled ? "aktiv" : "deaktiviert", u.enabled ? null : { tone: "warn" }],
    ["Kontotyp", [u.userType, u.synced ? "aus dem AD synchronisiert" : "nur in Entra ID", u.creationType].filter(Boolean).join(" · ")],
    ["Angelegt", u.created ? `${fmtDateTime(u.created)} (vor ${u.createdAgeDays} Tagen)` : "—"],
    ["Angelegt von", d.createdBy || d.createdByNote],
    ["Letzte Anmeldung", u.signInKnown ? fmtDateTime(u.lastSignIn) : "nicht lesbar (Entra ID P1 nötig)"],
    ["Kennwort geändert", u.lastPasswordChange ? fmtDateTime(u.lastPasswordChange) : null],
    ["Organisation", [u.jobTitle, u.department, u.company, u.employeeType].filter(Boolean).join(" · ") || null]
  ]);
  const reg = d.register;
  b.h2("Zweck und Ablauf (Ausnahme-Register)");
  if (reg) {
    b.card([["Art", reg.kindLabel], ["Zweck", reg.purpose], ["Verantwortlich", reg.owner || "—"], ["Ticket", reg.ticket || null],
      ["Gültig", `${reg.validFrom ? "ab " + fmtDate(reg.validFrom + "T12:00:00Z") + " " : ""}${reg.validUntil ? "bis " + fmtDate(reg.validUntil + "T12:00:00Z") : "ohne Ablaufdatum"}`, reg.validUntil ? null : { tone: "warn" }],
      ["Notizen", reg.notes || null], ["Erfasst", `${fmtDateTime(reg.createdAt)}${reg.createdBy ? " durch " + reg.createdBy : ""}`]]);
  } else {
    b.note("Nicht im Register", "Für dieses Konto sind Zweck, Verantwortung und Ablaufdatum nicht erfasst — Entra ID speichert diese Angaben nicht.", "warn");
  }
  b.h2("Rollen");
  if (d.roles.length) b.table([{ label: "Rolle", w: 0.45 }, { label: "Wie", w: 0.4 }, { label: "", w: 0.15 }], d.roles.map(r => [{ text: r.name, bold: true }, r.how + (r.end ? `, bis ${fmtDate(r.end)}` : ""), r.privileged ? { text: "privilegiert", pill: "warn" } : ""]), { size: 7.8 });
  else b.small("Keine Verzeichnisrolle.");
  b.h2("Anmeldemethoden und Lizenzen");
  b.card([["Methoden", d.methods.map(m => m.type + (m.detail ? ` (${m.detail})` : "")).join("\n") || "keine"], ["Lizenzen", d.licenses.join(", ") || "keine"],
    d.owned.length && ["Besitzer von", d.owned.map(o => `${o.name} [${o.type}]`).join("\n")]].filter(Boolean));
  b.h2(`Gruppen (${d.groups.length})`);
  if (d.groups.length) b.table([{ label: "Gruppe", w: 0.7 }, { label: "Art", w: 0.3 }], d.groups.map(g => [g.name, [g.dynamic ? "dynamisch" : "statisch", g.m365 ? "Microsoft 365" : g.security ? "Sicherheit" : ""].filter(Boolean).join(", ")]), { size: 7.6 });
  if (d.signIns.length) {
    b.h2("Letzte Anmeldungen");
    b.table([{ label: "Zeit", w: 0.16 }, { label: "App", w: 0.24 }, { label: "Gerät / Ort", w: 0.36 }, { label: "Ergebnis", w: 0.24 }],
      d.signIns.map(s => [fmtDateTime(s.at), s.app, [s.device, s.location, s.ip].filter(Boolean).join("\n"), s.result + (s.ca ? `\nCA: ${s.ca}` : "")]), { size: 7.1 });
  }
  if (d.auditAbout.length || d.auditBy.length) {
    b.h2("Entra-Protokoll (30 Tage)");
    const rows = [...d.auditAbout.map(a => ({ ...a, dir: "am Konto" })), ...d.auditBy.map(a => ({ ...a, dir: "durch das Konto" }))].sort((a, b2) => String(b2.at).localeCompare(String(a.at)));
    b.table([{ label: "Zeit", w: 0.16 }, { label: "Vorgang", w: 0.3 }, { label: "Richtung", w: 0.14 }, { label: "Von / Ziel", w: 0.4 }],
      rows.slice(0, 300).map(a => [fmtDateTime(a.at), a.activity, a.dir, a.dir === "am Konto" ? a.by : a.target || "—"]), { size: 7.1 });
  }
}

// ---------------------------------------------------------------- Empfänger
function recipients(b, d) {
  if (d.watch && d.watch.length) {
    b.h1("Beobachtete Adressen");
    for (const w of d.watch) {
      b.h3(w.watch, w.hits.length ? `${w.hits.length} Treffer` : "nicht eingetragen", w.hits.length ? "warn" : "ok");
      if (w.hits.length) b.table([{ label: "Adresse", w: 0.3 }, { label: "Bereich", w: 0.25 }, { label: "Meldung", w: 0.45 }],
        w.hits.flatMap(h => h.entries.map(e => [{ text: h.address, bold: true }, e.area, `${e.object}: ${e.trigger}${e.enabled ? "" : " (aus)"}`])), { size: 7.4 });
    }
  }
  b.h1("Empfänger je Adresse");
  b.table([{ label: "Adresse", w: 0.3 }, { label: "Meldungen", w: 0.7 }],
    d.addresses.map(a => [{ text: a.address, bold: true }, a.entries.map(e => `${e.area} › ${e.object}: ${e.trigger}${e.enabled ? "" : " (aus)"}`).join("\n")]), { size: 7.3 });
  b.h1("Meldungswege");
  b.table([{ label: "Bereich", w: 0.2 }, { label: "Objekt", w: 0.25 }, { label: "Meldung", w: 0.25 }, { label: "Empfänger", w: 0.2 }, { label: "", w: 0.1 }],
    d.entries.map(e => [e.area, { text: e.object, bold: true }, e.trigger, e.recipients.join("\n"), e.enabled ? { text: "aktiv", pill: "ok" } : { text: "aus", pill: "muted" }]), { size: 7.2 });
  b.h2("Nicht per Schnittstelle lesbar — von Hand prüfen");
  d.manual.forEach(m => b.bullet(`${m.area}: ${m.what}`));
}

// ---------------------------------------------------------------- Enterprise-App
function app(b, d) {
  const a = d.app;
  b.h1(a.name);
  b.card([
    ["App-Id", a.appId, { mono: true }],
    ["Herausgeber", [a.publisher, a.verified ? `verifiziert: ${a.verified}` : "nicht verifiziert"].filter(Boolean).join(" · "), a.verified ? null : { tone: "warn" }],
    ["Im Tenant seit", fmtDateTime(a.created)],
    ["Zustand", `${a.enabled ? "aktiv" : "deaktiviert"} · Zuweisung ${a.assignmentRequired ? "erforderlich (nur zugewiesene Konten)" : "nicht erforderlich (alle Konten dürfen)"}`, a.assignmentRequired ? null : { tone: "warn" }],
    a.owners.length && ["Besitzer", a.owners.join(", ")],
    a.homepage && ["Startseite", a.homepage]
  ].filter(Boolean));
  b.h2("Delegierte Rechte (im Namen der Benutzer)");
  if (d.delegated.length) b.table([{ label: "Ressource", w: 0.2 }, { label: "Rechte", w: 0.5 }, { label: "Zustimmung", w: 0.3 }],
    d.delegated.map(g => [g.resource, g.scopes.map(s => g.risky.includes(s) ? s + " (!)" : s).join(", "), `${g.consent}: ${g.who}`]), { size: 7.4 });
  else b.small("Keine delegierten Rechte.");
  b.small("(!) = Recht, das schreiben, senden, löschen oder breit lesen kann.");
  b.h2("Anwendungsrechte (ohne Benutzer)");
  if (d.application.length) b.table([{ label: "Ressource", w: 0.3 }, { label: "Recht", w: 0.45 }, { label: "Erteilt", w: 0.25 }],
    d.application.map(x => [x.resource, { text: x.permission, tone: x.risky ? "crit" : null, bold: x.risky }, fmtDateTime(x.granted)]), { size: 7.6 });
  else b.small("Keine Anwendungsrechte — die App handelt nur im Namen angemeldeter Benutzer.");
  b.h2("Zugewiesene Konten und Gruppen");
  if (d.assigned.length) b.table([{ label: "Name", w: 0.5 }, { label: "Art", w: 0.2 }, { label: "Seit", w: 0.3 }], d.assigned.map(x => [x.name, x.type, fmtDateTime(x.since)]), { size: 7.6 });
  else b.small(a.assignmentRequired ? "Niemand zugewiesen." : "Keine Zuweisung — bei «Zuweisung nicht erforderlich» dürfen alle Konten die App nutzen.");
  b.h2(`Nutzung (Anmeldungen, ${d.signIns.days} Tage)`);
  if (d.signIns.users.length) b.table([{ label: "Konto", w: 0.34 }, { label: "Interaktiv", w: 0.12 }, { label: "Nicht interaktiv", w: 0.14 }, { label: "Fehlgeschlagen", w: 0.13 }, { label: "Zuletzt", w: 0.27 }],
    d.signIns.users.map(u => [{ text: u.user, bold: true }, String(u.interactive), String(u.nonInteractive), String(u.failed), fmtDateTime(u.last)]), { size: 7.6 });
  else b.small(d.signIns.error ? "Anmeldeprotokoll nicht lesbar." : "Keine Anmeldung im Zeitraum.");
  if (d.audit.length) {
    b.h2("Entra-Protokoll zur App (30 Tage)");
    b.table([{ label: "Zeit", w: 0.18 }, { label: "Vorgang", w: 0.42 }, { label: "Durch", w: 0.4 }], d.audit.map(x => [fmtDateTime(x.at), x.activity, x.by]), { size: 7.4 });
  }
  b.note("Was dieser Nachweis nicht zeigt", d.auditNote + " " + d.vendorNote, "info");
}

// ---------------------------------------------------------------- Service-Status
function health(b, d) {
  if (d.overview.length) {
    b.h1("Dienste");
    b.table([{ label: "Dienst", w: 0.6 }, { label: "Zustand", w: 0.4 }], d.overview.map(o => [o.service, o.status === "serviceOperational" ? { text: "in Betrieb", pill: "ok" } : { text: o.status, pill: "warn" }]), { size: 7.6 });
  }
  b.h1(`Störungen und Hinweise (${d.days} Tage)`);
  if (!d.issues.length) b.body("Keine Einträge im Zeitraum.");
  for (const i of d.issues) {
    b.h3(`${i.id} · ${i.title}`, i.resolved ? "behoben" : "offen", i.resolved ? "ok" : "warn");
    b.card([["Dienst", `${i.service}${i.feature ? " › " + i.feature : ""} · ${i.classification}`], ["Beginn", fmtDateTime(i.start)], ["Ende", i.end ? fmtDateTime(i.end) : "—"],
      ["Status", i.status], i.impact && ["Auswirkung", i.impact], i.latest && ["Letzte Meldung", cap(i.latest, 1200)]].filter(Boolean));
  }
  b.small(d.note);
}

// ---------------------------------------------------------------- Erhebung
function method(b, entry, d) {
  b.h1("Erhebung", { appendix: true });
  b.card([
    ["Erhoben", `${fmtDateTime(entry.createdAt)}${entry.createdBy ? " durch " + entry.createdBy : ""}`],
    ["Nachweis-Id", entry.id, { mono: true }],
    ["Parameter", Object.entries(entry.params || {}).filter(([k, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n") || "—"],
    ["Quelle", "Microsoft Graph (und Exchange Online, wo angegeben) über eine zertifikatsbasierte Anwendung — ausschliesslich lesend."]
  ]);
  const gaps = d.gaps || [];
  if (gaps.length) {
    b.h4("Nicht lesbar bei dieser Erhebung");
    [...new Set(gaps)].slice(0, 30).forEach(g => b.bullet(cap(g, 240), "warn"));
  }
}

module.exports = { build, TITLES };
