"use strict";
/**
 * Konfigurationsdokumentation (PDF) zu Apps, Intune-Richtlinien und Conditional
 * Access — erzeugt aus den gespeicherten Erhebungen des Bereichs
 * "Zuweisungen & Audit". Layout aus lib/pdfDesign.js (igeeks-CI).
 *
 * Der Hauptteil BESCHREIBT, was eingerichtet ist — welche App wie installiert
 * und an wen verteilt wird, was jede Richtlinie einstellt und für wen sie gilt.
 * Bewertungen (Abweichungen vom Zuweisungskonzept, Lücken, Auswirkungsprognose)
 * stehen gesammelt im Anhang und lassen sich weglassen (data.appendix === false),
 * wenn die Doku an den Kunden geht. data.skipUnassigned lässt nicht zugewiesene
 * Richtlinien und Apps weg.
 *
 * Abschnitt "sharepoint" (SharePoint und OneDrive) kommt aus dem gleichnamigen
 * Bereich, Kapitel und Anhang liefert lib/sharepointInventoryPdf.js.
 */
const D = require("./pdfDesign");
const SPPDF = require("./sharepointInventoryPdf");
const { pl, cap, fmtDate, fmtDateTime } = D;

const TARGET_LABEL = { allDevices: "Alle Geräte", allUsers: "Alle Benutzer" };
const INSTALL_TONE = { installed: "ok", failed: "crit", uninstallfailed: "crit", pendinginstall: "warn", pending: "warn", notinstalled: "muted" };
const SEV_TONE = { fehler: "crit", warn: "warn", hinweis: "muted" };
const CA_TONE = { enabled: "ok", enabledForReportingButNotEnforced: "warn", disabled: "muted" };
const CA_SHORT = { enabled: "Aktiv", enabledForReportingButNotEnforced: "Nur Bericht", disabled: "Aus" };
const NODE_KIND = { appGroup: "app", container: "app", deviceGroup: "dev", userGroup: "usr", mixed: "bad", empty: "bad", missing: "bad" };

function buildPdf(data) {
  const S = data.sections || {};
  const skip = !!data.skipUnassigned;
  const apps = S.apps ? (skip ? { ...S.apps, apps: S.apps.apps.filter(a => a.assignments.length) } : S.apps) : null;
  const pol = S.policies ? (skip ? { ...S.policies, policies: S.policies.policies.filter(p => p.assignments.some(a => !a.exclude)) } : S.policies) : null;
  const ca = S.ca || null;
  const sp = S.sharepoint || null;
  const withAppendix = data.appendix !== false;

  const parts = [apps && "Apps", pol && (pol.scope === "oib" ? "Intune-Richtlinien (OIB)" : "Intune-Richtlinien"), ca && "Conditional Access", sp && "SharePoint und OneDrive"].filter(Boolean);
  const coverTiles = sp && !apps && !pol && !ca
    ? [{ label: "SharePoint-Sites", value: sp.summary.sites }, { label: "davon mit Teams", value: sp.summary.teams },
      { label: "Speicher gesamt", value: SPPDF.bytes(sp.summary.storageUsed + sp.summary.oneDriveStorage) }, { label: "OneDrive-Konten", value: sp.summary.oneDrives }]
    : [
      apps && { label: "Apps mit Zuweisung", value: apps.summary.assigned },
      pol && { label: pol.scope === "oib" ? "OIB-Richtlinien" : "Intune-Richtlinien", value: pol.summary.policies },
      ca && { label: "CA-Richtlinien aktiv", value: `${ca.summary.enabled}/${ca.summary.policies}` },
      (apps || pol) && { label: "Geräte erreicht", value: Math.max(apps ? apps.summary.devices : 0, pol ? pol.summary.devices : 0) },
      sp && SPPDF.coverTile(sp)
    ].filter(Boolean);

  const b = D.create({
    kicker: "Microsoft 365",
    titleLines: ["Konfigurations-", "dokumentation"],
    subtitle: parts.join("  ·  "),
    tenantName: data.tenantName, organization: data.organization, date: data.generatedAt,
    stamps: [apps && `Apps ${fmtDateTime(apps.generatedAt)}`, pol && `Richtlinien ${fmtDateTime(pol.generatedAt)}`, ca && `Conditional Access ${fmtDateTime(ca.generatedAt)}`, sp && `SharePoint ${fmtDateTime(sp.generatedAt)}`].filter(Boolean),
    coverTiles,
    footerLabel: "Konfigurationsdokumentation",
    coverNote: "Aus dem Tenant ausgelesen (Microsoft Graph, nur lesend) — die Dokumentation zeigt den tatsächlichen Stand, nicht eine Soll-Vorgabe."
  });
  b.cover();
  const targetOf = a => a.group ? a.group.displayName : (TARGET_LABEL[a.targetKind] || a.targetKind);

  // ================= Überblick =================
  b.h1("Überblick");
  const topics = [
    apps && "welche Apps an welche Geräte verteilt werden und über welche Gruppen",
    pol && "was jede Intune-Richtlinie einstellt und für wen sie gilt",
    ca && "welche Conditional-Access-Richtlinien die Anmeldung steuern",
    sp && "welche SharePoint-Sites und OneDrives es gibt, wem sie gehören und wie der Tenant das Teilen regelt"
  ].filter(Boolean);
  b.body("Diese Dokumentation beschreibt die im Tenant eingerichtete Konfiguration: " +
    (topics.length > 2 ? topics.slice(0, -1).join(", ") + ", und " + topics[topics.length - 1]
      : topics.join(" und ")) + ".");
  b.doc.moveDown(0.4);
  b.card([
    apps && ["Apps", `${pl(apps.summary.assigned, "App mit Zuweisung", "Apps mit Zuweisung")} von ${apps.summary.apps} — erreichen ${pl(apps.summary.devices, "Gerät", "Geräte")}`],
    pol && ["Intune-Richtlinien", `${pl(pol.summary.policies, "Richtlinie", "Richtlinien")}${pol.scope === "oib" ? " der OpenIntuneBaseline" : ""}, davon ${pol.summary.assigned} zugewiesen — erreichen ${pl(pol.summary.devices, "Gerät", "Geräte")}`],
    ca && ["Conditional Access", `${pl(ca.summary.policies, "Richtlinie", "Richtlinien")}: ${ca.summary.enabled} aktiv, ${ca.summary.reportOnly} nur Bericht, ${ca.summary.disabled} aus · ${pl(ca.summary.users, "aktives Konto", "aktive Konten")}${ca.summary.securityDefaults === true ? " · Sicherheitsstandards eingeschaltet" : ""}`],
    sp && SPPDF.overviewLine(sp)
  ].filter(Boolean));
  const conv = (apps && apps.convention) || null;
  if (conv) {
    b.h2("Zuweisungskonzept");
    b.body("Geräte kommen über ihren Autopilot-GroupTag in eine dynamische Gerätegruppe. Richtlinien werden der Gerätegruppe zugewiesen. Eine App hängt an genau einer App-Gruppe; welche Geräte sie bekommen, bestimmt die Verschachtelung — die Gerätegruppe ist Mitglied der App-Gruppe.");
    b.doc.moveDown(0.3);
    const muster = t => String(t || "").replace(/\{app\}/gi, "<App>").replace(/\{tag\}/gi, "<GroupTag>");
    b.chain([
      { nodes: [{ label: "App", sub: "Intune", kind: "plain" }] },
      { nodes: [{ label: muster(conv.appGroup), sub: "App-Gruppe (statisch)", kind: "app" }], connector: "zugewiesen" },
      { nodes: [{ label: muster(conv.deviceGroup), sub: "Gerätegruppe (dynamisch)", kind: "dev" }], connector: "enthält" },
      { nodes: [{ label: "Gerät", sub: "mit GroupTag", kind: "plain" }], connector: "Regel" }
    ]);
    b.small(`Patch-My-PC-Apps: ${muster(conv.pmpGroup)}.`);
  }

  // ================= Gruppenstruktur =================
  const allGroups = new Map();
  for (const g of [...((apps && apps.groups) || []), ...((pol && pol.groups) || [])]) if (!allGroups.has(g.id)) allGroups.set(g.id, g);
  if (allGroups.size) {
    const usedBy = new Map();
    const note = (gid, what) => { if (!usedBy.has(gid)) usedBy.set(gid, new Set()); usedBy.get(gid).add(what); };
    if (apps) for (const a of apps.apps) for (const as of a.assignments) if (as.group && !as.exclude) note(as.group.id, a.displayName);
    const groups = [...allGroups.values()];
    const devGroups = groups.filter(g => g.kind === "deviceGroup");
    const appGroups = groups.filter(g => g.kind === "appGroup" || g.kind === "container");
    const userGroups = groups.filter(g => g.kind === "userGroup" || g.kind === "mixed");
    b.h1("Gruppenstruktur");
    b.body("Alle Gruppen, die in den Zuweisungen der dokumentierten Apps und Richtlinien vorkommen, mit ihrer Mitgliedschaftsregel bzw. ihren Mitgliedern.");
    if (devGroups.length) {
      b.h2("Gerätegruppen");
      b.table([{ label: "Gruppe", w: 0.27 }, { label: "GroupTag", w: 0.14 }, { label: "Mitgliedschaft", w: 0.47 }, { label: "Geräte", w: 0.12 }],
        devGroups.map(g => [{ text: g.displayName, bold: true }, (g.tags || []).length ? { text: g.tags.join(", "), pill: "ok" } : "—",
          g.dynamic ? { text: g.rule || "—", mono: true } : `statisch (${g.directDevices} Gerät(e)${g.memberGroups.length ? ", Untergruppen: " + g.memberGroups.join(", ") : ""})`,
          String(g.devices)]), { size: 7.8 });
    }
    if (appGroups.length) {
      b.h2("App-Gruppen");
      b.table([{ label: "App-Gruppe", w: 0.3 }, { label: "Enthält", w: 0.3 }, { label: "Geräte", w: 0.1 }, { label: "Verwendet von", w: 0.3 }],
        appGroups.map(g => [{ text: g.displayName, bold: true },
          [...g.memberGroups, g.directDevices ? `${g.directDevices} Gerät(e) direkt` : null, g.directUsers ? `${g.directUsers} Benutzer direkt` : null].filter(Boolean).join("\n") || "leer",
          String(g.devices), [...(usedBy.get(g.id) || [])].join("\n") || "—"]), { size: 7.8 });
    }
    if (userGroups.length) {
      b.h2("Benutzergruppen in Zuweisungen");
      b.table([{ label: "Gruppe", w: 0.35 }, { label: "Mitgliedschaft", w: 0.45 }, { label: "Benutzer", w: 0.2 }],
        userGroups.map(g => [{ text: g.displayName, bold: true }, g.dynamic ? { text: g.rule || "—", mono: true } : (g.memberGroups.length ? "statisch, Untergruppen: " + g.memberGroups.join(", ") : "statisch"), String(g.users)]), { size: 7.8 });
    }
  }

  if (apps) renderApps();
  if (pol) renderPolicies();
  if (ca) renderCa();
  if (sp) SPPDF.renderChapter(b, sp);
  if (withAppendix) renderDeviations();
  if (withAppendix && ca && ca.forecast && ca.forecast.summary.reportOnly) renderForecast();
  if (withAppendix && sp) SPPDF.renderHints(b, sp);
  renderMethod();
  return b.finish();

  // ---------------------------------------------------------------- Apps
  function renderApps() {
    b.h1("Apps");
    const assigned = apps.apps.filter(a => a.assignments.length);
    b.h2("Übersicht");
    b.table([{ label: "App", w: 0.27 }, { label: "Typ / Quelle", w: 0.2 }, { label: "Version", w: 0.12 }, { label: "Zuweisung", w: 0.31 }, { label: "Geräte", w: 0.1 }],
      assigned.map(a => [
        { text: a.displayName, bold: true }, `${a.type}\n${a.managedByLabel}`, a.version || "—",
        a.assignments.map(x => `${x.exclude ? "Ausschluss" : x.intentLabel}: ${targetOf(x)}`).join("\n"),
        String(a.devices.length) + (a.users.length ? ` / ${a.users.length} Ben.` : "")
      ]), { size: 7.8 });
    const unassigned = apps.apps.filter(a => !a.assignments.length);
    if (unassigned.length) b.small(`Vorhanden, aber keinem Gerät zugewiesen (${unassigned.length}): ` + unassigned.slice(0, 60).map(a => a.displayName).join(", ") + (unassigned.length > 60 ? " …" : ""));

    b.h2("Apps im Detail");
    for (const a of assigned) {
      b.h3(a.displayName, a.managedByLabel, a.managedBy === "pmp" ? "info" : "muted");
      b.small([a.type, a.platform, a.lastModifiedDateTime ? "geändert " + fmtDate(a.lastModifiedDateTime) : null].filter(Boolean).join(" · "));
      b.doc.moveDown(0.3);
      b.card((a.config || []).map(c => [c.label, c.value, { mono: /befehl|Erkennung|Anforderungen|Befehlszeile/i.test(c.label) }]));
      b.h4("Zuweisung");
      for (const as of a.assignments) {
        const steps = [{ nodes: [{ label: as.exclude ? "Ausschluss" : as.intentLabel, kind: as.exclude ? "pill-muted" : "pill-info" }] }];
        if (as.group) {
          steps.push({ nodes: [{ label: as.group.displayName, sub: as.group.kindLabel + (as.group.tags && as.group.tags.length ? " · " + as.group.tags.join(", ") : ""), kind: NODE_KIND[as.group.kind] || "plain" }] });
          const subs = as.group.memberGroups || [];
          if (subs.length) steps.push({ connector: "enthält", nodes: subs.slice(0, 6).map(sg => ({ label: sg.displayName, sub: (sg.kindLabel || "Gruppe") + (sg.tags && sg.tags.length ? " · " + sg.tags.join(", ") : ""), kind: NODE_KIND[sg.kind] || "dev" })) });
        } else {
          steps.push({ nodes: [{ label: targetOf(as), kind: "bad" }] });
        }
        if (as.deviceCount !== null && as.deviceCount !== undefined) steps.push({ nodes: [{ label: pl(as.deviceCount, "Gerät", "Geräte"), kind: as.exclude ? "pill-muted" : "pill-ok" }] });
        b.chain(steps);
        const extras = [as.filter ? `Filter (${as.filter.mode}): ${as.filter.name}${as.filter.rule ? " — " + as.filter.rule : ""}` : null, ...(as.settings || [])].filter(Boolean);
        if (extras.length) b.small(extras.join("  ·  "));
      }
      if (a.devices.length) {
        b.h4(`Geräte (${a.devices.length})`);
        const shown = a.devices.slice(0, 250);
        const hasInstall = shown.some(d => d.installLabel);
        b.table([
          { label: "Gerät", w: 0.2 }, { label: "GroupTag", w: 0.13 }, { label: "Erreicht über", w: hasInstall ? 0.32 : 0.42 },
          { label: "Primärbenutzer", w: hasInstall ? 0.2 : 0.25 }, ...(hasInstall ? [{ label: "Status", w: 0.15 }] : [])
        ], shown.map(d => [
          { text: d.name, bold: true }, d.groupTag || "—", d.via + (d.viaCount > 1 ? ` (+${d.viaCount - 1})` : ""), d.user || "—",
          ...(hasInstall ? [d.installLabel ? { text: d.installLabel, pill: INSTALL_TONE[d.install] || "muted" } : "—"] : [])
        ]), { size: 7.5 });
        if (a.devices.length > shown.length) b.small(`… und ${a.devices.length - shown.length} weitere Geräte (vollständig im CSV-Export).`);
      } else if (a.users.length) {
        b.kv("Benutzer", `${a.users.length}: ` + a.users.slice(0, 40).map(u => u.upn || u.name).join(", ") + (a.users.length > 40 ? " …" : ""));
      }
    }

    if (apps.byDevice && apps.byDevice.length) {
      b.h2("Geräte und ihre Apps");
      b.table([{ label: "Gerät", w: 0.19 }, { label: "GroupTag", w: 0.12 }, { label: "Primärbenutzer", w: 0.21 }, { label: "Apps", w: 0.48 }],
        apps.byDevice.slice(0, 800).map(d => [{ text: d.name, bold: true }, d.groupTag || "—", d.user || "—",
          d.apps.map(x => x.app + (x.install ? ` (${x.install})` : "")).join(", ")]), { size: 7.4 });
      if (apps.byDevice.length > 800) b.small(`… und ${apps.byDevice.length - 800} weitere Geräte (vollständig im CSV-Export).`);
    }
  }

  // ---------------------------------------------------------------- Richtlinien
  function renderPolicies() {
    b.h1(pol.scope === "oib" ? "Intune-Richtlinien (OpenIntuneBaseline)" : "Intune-Richtlinien");
    b.body(pol.scope === "oib"
      ? "Dokumentiert sind die Richtlinien der OpenIntuneBaseline (Name beginnt mit «Win - OIB» bzw. «MacOS - OIB»). Je Richtlinie: Zweck, Zuweisung, betroffene Geräte und sämtliche Einstellungen."
      : "Dokumentiert sind alle Intune-Konfigurations-, Compliance- und Update-Richtlinien. Je Richtlinie: Zweck, Zuweisung, betroffene Geräte und sämtliche Einstellungen.");

    b.h2("Übersicht");
    b.table([{ label: "Richtlinie", w: 0.4 }, { label: "Typ", w: 0.17 }, { label: "Zugewiesen an", w: 0.3 }, { label: "Geräte", w: 0.13 }],
      pol.policies.map(p => [
        { text: p.name, bold: true }, p.type,
        p.assignments.length ? p.assignments.map(a => (a.exclude ? "ohne " : "") + targetOf(a)).join("\n") : { text: "nicht zugewiesen", pill: "warn" },
        String(p.devices.length) + (p.users.length ? ` / ${p.users.length} Ben.` : "")
      ]), { size: 7.6 });

    if (pol.coverage && pol.coverage.length) {
      b.h2("Richtlinien je Gerätegruppe");
      b.small("Welche Richtlinien bei einer Gerätegruppe ankommen — direkt, über eine verschachtelte Gruppe oder über «Alle Geräte»; Ausschlüsse sind abgezogen.");
      for (const c of pol.coverage) {
        const got = pol.policies.filter(p => !c.missing.includes(p.name) && (!p.oibParts || p.oibParts.geltung === "Gerät")).map(p => p.name);
        b.h4(`${c.displayName}${c.tags && c.tags.length ? " · GroupTag " + c.tags.join(", ") : ""} · ${pl(c.devices == null ? 0 : c.devices, "Gerät", "Geräte")}`);
        b.table([{ label: `Wirksam (${got.length})`, w: 0.6 }, { label: `Nicht zugewiesen (${c.missing.length})`, w: 0.4 }],
          [[got.join("\n") || "—", c.missing.join("\n") || "—"]], { size: 7.3 });
      }
    }

    b.h2("Richtlinien im Detail");
    for (const p of pol.policies) {
      const assignedAny = p.assignments.some(a => !a.exclude);
      b.h3(p.name, assignedAny ? p.type : "nicht zugewiesen", assignedAny ? "info" : "warn");
      b.small([p.type, p.platform, p.createdDateTime ? "angelegt " + fmtDate(p.createdDateTime) : null, p.lastModifiedDateTime ? "geändert " + fmtDate(p.lastModifiedDateTime) : null].filter(Boolean).join(" · "));
      b.doc.moveDown(0.3);
      const inc = p.assignments.filter(a => !a.exclude), exc = p.assignments.filter(a => a.exclude);
      b.card([
        p.oibParts && ["Zweck", `${p.oibParts.bereich} — ${p.oibParts.inhalt}`],
        p.oibParts && ["Geltung", `${p.oibParts.geltung}${p.oibParts.version ? " · OpenIntuneBaseline " + p.oibParts.version : ""}`],
        p.description && ["Beschreibung", cap(p.description, 800)],
        ["Zugewiesen an", inc.length ? inc.map(a => (a.group ? `${a.group.displayName} (${a.group.kindLabel})` : targetOf(a))
          + (a.nestedGroups && a.nestedGroups.length ? " › " + a.nestedGroups.map(n => n.displayName).join(", ") : "")
          + (a.filter ? ` — Filter (${a.filter.mode}): ${a.filter.name}` : "")).join("\n") : "nicht zugewiesen", inc.length ? null : { tone: "warn" }],
        exc.length && ["Ausgenommen", exc.map(a => targetOf(a)).join("\n")],
        ["Wirkt auf", `${pl(p.devices.length, "Gerät", "Geräte")}${p.users.length ? ", " + pl(p.users.length, "Benutzer", "Benutzer") : ""}` +
          (p.devices.length ? ": " + p.devices.slice(0, 60).map(d => d.name).join(", ") + (p.devices.length > 60 ? ` … +${p.devices.length - 60}` : "") : "")]
      ].filter(Boolean));
      if (p.settings.length) {
        b.h4(`Einstellungen (${p.settingsTotal})`);
        b.table([{ label: "Einstellung", w: 0.6 }, { label: "Wert", w: 0.4 }],
          p.settings.map(s => [{ text: s.label, bold: !s.depth, indent: Math.min(s.depth || 0, 4) * 9 }, s.value || ""]), { size: 7.3 });
        if (p.settingsTotal > p.settings.length) b.small(`… und ${p.settingsTotal - p.settings.length} weitere Einstellungen.`);
      } else if (p.settingsError) {
        b.small("Einstellungen nicht lesbar: " + cap(p.settingsError, 200));
      }
    }
  }

  // ---------------------------------------------------------------- Conditional Access
  function renderCa() {
    b.h1("Conditional Access");
    b.body("Je Richtlinie: Zustand, was sie verlangt, für wen sie gilt und wer ausgenommen ist — bis auf die einzelnen Konten aufgelöst. «Nur Bericht» (Report-only) wertet Anmeldungen aus, erzwingt aber nichts." +
      (ca.summary.securityDefaults === true ? " Die Sicherheitsstandards (Security Defaults) sind eingeschaltet." : ca.summary.securityDefaults === false ? " Die Sicherheitsstandards (Security Defaults) sind ausgeschaltet." : ""));
    b.tiles([
      { label: "Aktiv", value: ca.summary.enabled, tone: "ok" },
      { label: "Nur Bericht", value: ca.summary.reportOnly, tone: "warn" },
      { label: "Aus", value: ca.summary.disabled },
      { label: "Aktive Konten", value: ca.summary.users },
      { label: "davon Gäste", value: ca.summary.guests }
    ]);

    b.h2("Übersicht");
    b.table([{ label: "Richtlinie", w: 0.37 }, { label: "Zustand", w: 0.14 }, { label: "Wirkung", w: 0.29 }, { label: "Betrifft", w: 0.1 }, { label: "Ausgen.", w: 0.1 }],
      ca.policies.map(p => [{ text: p.name, bold: true }, { text: CA_SHORT[p.state] || p.state, pill: CA_TONE[p.state] || "muted" }, p.effectShort,
        String(p.scope.effective), String(p.scope.excluded)]), { size: 7.8 });

    if (ca.namedLocations && ca.namedLocations.length) {
      b.h2("Benannte Standorte");
      b.table([{ label: "Standort", w: 0.35 }, { label: "Definition", w: 0.65 }], ca.namedLocations.map(l => [{ text: l.name, bold: true }, l.detail || "—"]), { size: 7.8 });
    }

    b.h2("Richtlinien im Detail");
    for (const p of ca.policies) {
      b.h3(p.name, CA_SHORT[p.state] || p.state, CA_TONE[p.state]);
      b.small([p.createdDateTime ? "angelegt " + fmtDate(p.createdDateTime) : null, p.modifiedDateTime ? "geändert " + fmtDate(p.modifiedDateTime) : null].filter(Boolean).join(" · "));
      b.doc.moveDown(0.3);
      b.quote(p.summary, CA_TONE[p.state] === "ok" ? "info" : CA_TONE[p.state] || "info");
      b.card([
        ["Gilt für", p.who.include.join("\n") || "niemanden"],
        p.who.exclude.length && ["Ausgenommen", p.who.exclude.join("\n")],
        ["Cloud-Apps / Aktionen", [...p.apps.include, ...p.apps.actions.map(a => "Aktion: " + a), ...p.apps.authContext.map(a => "Kontext: " + a)].join(", ") + (p.apps.exclude.length ? "\nausser: " + p.apps.exclude.join(", ") : "")],
        p.conditions.length && ["Bedingungen", p.conditions.join("\n")],
        ["Gewähren", p.grant.blocks ? "Zugriff blockieren" : (p.grant.controls.length ? p.grant.controls.join(p.grant.operator === "OR" ? " ODER " : " UND ") : "—"), p.grant.blocks ? { tone: "crit" } : null],
        p.session.length && ["Sitzung", p.session.join("\n")],
        ["Betroffene Konten", `${pl(p.scope.effective, "Konto", "Konten")}${p.scope.guests ? `, davon ${pl(p.scope.guests, "Gast", "Gäste")}` : ""}${p.scope.disabled ? `, ${p.scope.disabled} deaktiviert` : ""}` +
          (p.effectiveUsers.length && p.effectiveUsers.length <= 40 ? ": " + p.effectiveUsers.map(u => u.upn + (u.guest ? " (Gast)" : "") + (u.enabled ? "" : " (deaktiviert)")).join(", ") : "")],
        p.excludedUsers.length && ["Ausgenommene Konten", p.excludedUsers.slice(0, 80).map(u => u.upn + (u.guest ? " (Gast)" : "") + (u.enabled ? "" : " (deaktiviert)")).join("\n") + (p.excludedUsers.length > 80 ? `\n… +${p.excludedUsers.length - 80}` : "")],
        p.signIns && [`Anmeldungen (${ca.signIns ? ca.signIns.days : "?"} Tage)`, signInText(p.signIns.counts)]
      ].filter(Boolean));
    }

    if (ca.matrix && ca.matrix.length) {
      b.h2("Richtlinien je Konto");
      b.small("Für jedes aktive Konto: welche aktiven und welche Report-only-Richtlinien greifen (Ausschlüsse abgezogen; Standort-, Plattform- und Risikobedingungen werden erst bei der Anmeldung ausgewertet).");
      const rows = ca.matrix.slice(0, 600);
      b.table([{ label: "Konto", w: 0.3 }, { label: "Aktiv", w: 0.4 }, { label: "Nur Bericht", w: 0.3 }],
        rows.map(u => [{ text: u.upn + (u.guest ? " (Gast)" : ""), bold: true }, u.active.map(x => x.name).join("\n") || { text: "keine", pill: "crit" }, u.reportOnly.map(x => x.name).join("\n") || "—"]), { size: 7.2 });
      if (ca.matrix.length > rows.length) b.small(`… und ${ca.matrix.length - rows.length} weitere Konten (vollständig im CSV-Export).`);
    }
  }

  function signInText(c) {
    const label = { success: "erfüllt", failure: "nicht erfüllt/blockiert", notApplied: "nicht angewendet", reportOnlySuccess: "Bericht: wäre erfüllt",
      reportOnlyFailure: "Bericht: wäre blockiert", reportOnlyNotApplied: "Bericht: nicht angewendet", reportOnlyInterrupted: "Bericht: hätte unterbrochen", notEnabled: "nicht aktiv" };
    const keys = Object.keys(c || {});
    return keys.length ? keys.map(k => `${label[k] || k}: ${c[k]}`).join(" · ") : "keine im Zeitraum";
  }

  // ---------------------------------------------------------------- Anhang: Abweichungen
  function renderDeviations() {
    const appF = apps ? apps.apps.filter(a => a.findings.some(f => f.severity !== "hinweis" || f.fix)) : [];
    const polF = pol ? pol.policies.filter(p => p.findings.some(f => f.severity !== "hinweis")) : [];
    const caF = ca ? ca.policies.filter(p => p.findings.some(f => f.severity !== "hinweis")) : [];
    const caGaps = ca && (ca.withoutMfa.length || ca.excludedFromAll.length || !ca.summary.legacyBlocked);
    if (!appF.length && !polF.length && !caF.length && !caGaps) return;
    b.h1("Abweichungen vom Zuweisungskonzept", { appendix: true });
    b.body("Punkte, an denen die vorgefundene Konfiguration vom Zuweisungskonzept bzw. von der Grundlinie abweicht. Sie beschreiben den Stand zum Zeitpunkt der Erhebung und sind als Hinweise zu verstehen, nicht als Mängelliste.");
    if (appF.length) {
      b.h2("Apps");
      for (const a of appF) {
        b.h4(a.displayName);
        a.findings.filter(f => f.severity !== "hinweis" || f.fix).forEach(f => b.bullet(f.text, SEV_TONE[f.severity]));
      }
    }
    if (polF.length) {
      b.h2("Intune-Richtlinien");
      for (const p of polF) { b.h4(p.name); p.findings.filter(f => f.severity !== "hinweis").forEach(f => b.bullet(f.text, SEV_TONE[f.severity])); }
    }
    if (caF.length || caGaps) {
      b.h2("Conditional Access");
      if (ca.withoutMfa.length) b.bullet(`${pl(ca.withoutMfa.length, "aktives Konto fällt", "aktive Konten fallen")} unter keine aktive Richtlinie, die für alle Cloud-Apps MFA verlangt: ` +
        ca.withoutMfa.slice(0, 40).map(u => u.upn).join(", ") + (ca.withoutMfa.length > 40 ? " …" : "") + (ca.summary.securityDefaults ? " (Sicherheitsstandards sind eingeschaltet)." : "."), "warn");
      if (ca.excludedFromAll.length) b.bullet(`Von allen aktiven Richtlinien ausgenommen: ${ca.excludedFromAll.slice(0, 40).map(u => u.upn).join(", ")}${ca.excludedFromAll.length > 40 ? " …" : ""}.`, "warn");
      if (!ca.summary.legacyBlocked) b.bullet("Keine aktive Richtlinie blockiert Legacy-Authentifizierung ausdrücklich.", "warn");
      for (const p of caF) { b.h4(p.name); p.findings.filter(f => f.severity !== "hinweis").forEach(f => b.bullet(f.text, SEV_TONE[f.severity])); }
    }
  }

  // ---------------------------------------------------------------- Anhang: Prognose
  function renderForecast() {
    const f = ca.forecast;
    b.h1("Auswirkungsprognose für Report-only-Richtlinien", { appendix: true });
    b.body(`Entra wertet jede Anmeldung auch gegen die Richtlinien im Modus «Nur Bericht» aus, als wären sie scharf. Grundlage: ${f.window.read} interaktive und ${f.window.nonInteractive} nicht-interaktive Anmeldungen der letzten ${f.window.days} Tage.`);
    if (!f.complete) b.note("Unvollständig", "Das Protokoll wurde an der Obergrenze abgeschnitten oder nicht-interaktive Anmeldungen waren nicht lesbar — die Zahlen sind eine Untergrenze.", "warn");
    b.tiles([
      { label: "würden blockiert", value: f.summary.blockedUsers, tone: "crit" },
      { label: "müssten MFA einrichten", value: f.summary.setupUsers, tone: "warn" },
      { label: "zusätzlich gefragt", value: f.summary.promptUsers, tone: "info" },
      { label: "ohne Anmeldung", value: f.summary.noDataUsers, tone: "muted" }
    ]);
    for (const fp of f.policies) {
      b.h3(fp.name, fp.blocked.length ? `${fp.blocked.length} blockiert` : "niemand blockiert", fp.blocked.length ? "crit" : "ok");
      b.small(`Verlangt: ${fp.effect} · ${fp.ok} Konto/Konten erfüllen sie bereits · ${fp.notApplicable} nicht zutreffend`);
      for (const [label, rowsF, tone] of [["Würde blockiert", fp.blocked, "crit"], ["Müsste MFA einrichten", fp.setup, "warn"], ["Würde zusätzlich gefragt", fp.prompt, "info"]]) {
        if (!rowsF.length) continue;
        b.h4(`${label} (${rowsF.length})`);
        b.table([{ label: "Konto", w: 0.3 }, { label: "Anmeldungen", w: 0.13 }, { label: "Gerät / App", w: 0.42 }, { label: "MFA", w: 0.15 }],
          rowsF.slice(0, 150).map(r => [{ text: r.upn + (r.guest ? " (Gast)" : ""), bold: true, tone },
            `${r.bad} von ${r.total}`, r.samples.join("\n") || "—",
            r.mfaRegistered === null ? "—" : r.mfaRegistered ? ((r.methods || []).join(", ") || "registriert") : { text: "keine Methode", pill: "warn" }]), { size: 7.3 });
      }
      if (fp.noData.length) b.small(`Ohne Anmeldung im Zeitraum (${fp.noData.length}): ` + fp.noData.slice(0, 60).map(u => u.upn).join(", ") + (fp.noData.length > 60 ? " …" : ""));
    }
    if (f.disabledNotEvaluated && f.disabledNotEvaluated.length) b.small("Ausgeschaltet und deshalb nicht vorhersagbar: " + f.disabledNotEvaluated.join(", ") + ".");
  }

  // ---------------------------------------------------------------- Anhang: Erhebung
  function renderMethod() {
    b.h1("Erhebung und Grenzen", { appendix: true });
    b.body(`Alle Angaben stammen aus Microsoft Graph (${[(apps || pol) && "Intune", (apps || pol || ca) && "Entra ID", sp && "SharePoint, Microsoft-365-Nutzungsberichte"].filter(Boolean).join(", ")}) und wurden ausschliesslich lesend über eine dedizierte, zertifikatsbasierte Anwendung erhoben.` +
      (apps || pol ? " Gruppen sind rekursiv bis zu den Geräten und Konten aufgelöst; bei jedem Gerät steht der Weg dorthin (zugewiesene Gruppe › verschachtelte Gruppe)." : ""));
    b.doc.moveDown(0.3);
    [
      (apps || pol) && "Die Auflösung zeigt, wen eine Zuweisung erreichen soll. Ob eine Richtlinie auf dem Gerät angewendet wurde, zeigt Intune im Gerätestatus; bei Apps ist der Installationsstatus ausgewiesen, sofern er erhoben wurde.",
      (apps || pol) && "Zuweisungsfilter sind mit Name und Regel aufgeführt, aber nicht gegen die einzelnen Geräte ausgewertet.",
      ca && "Conditional Access: Rollen zählen mit aktiver Zuweisung (PIM-berechtigte Konten erst nach Aktivierung). Gäste werden über den Kontotyp «Guest» bestimmt.",
      apps && "Befehlszeilen sind gekürzt, wo sie Einschreibe-Schlüssel enthalten (z. B. GravityZone-Token).",
      ...(sp ? SPPDF.methodBullets(sp) : [])
    ].filter(Boolean).forEach(l => b.bullet(l));
    const gaps = [...(apps ? apps.gaps || [] : []), ...(pol ? (pol.gaps || []).concat((pol.sourceErrors || []).map(e => `${e.source}: ${e.error}`)) : []), ...(ca ? ca.gaps || [] : []), ...(sp ? sp.gaps || [] : [])];
    if (apps && apps.readable && !apps.readable.managedDevices) gaps.push("Intune-Gerätedetails (Name, Primärbenutzer, Compliance) nicht lesbar: " + (apps.readable.managedDevicesError || "Berechtigung fehlt"));
    if (gaps.length) {
      b.h4("Nicht lesbar bei dieser Erhebung");
      [...new Set(gaps)].slice(0, 30).forEach(g => b.bullet(cap(g, 220), "warn"));
    }
  }
}

module.exports = { buildPdf };
