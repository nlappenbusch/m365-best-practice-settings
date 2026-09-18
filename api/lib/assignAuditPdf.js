"use strict";
/**
 * Konfigurationsdokumentation (PDF) zu Apps, Intune-Richtlinien und Conditional
 * Access — erzeugt aus den gespeicherten Erhebungen des Bereichs
 * "Zuweisungen & Audit". Serverseitig mit pdfkit, igeeks-CI wie der Maester-Report:
 *  - Petrol #0081ad als Akzent
 *  - KEINE Seitenumbrüche zwischen Abschnitten; umgebrochen wird nur, wenn die
 *    Seite voll ist (Deckblatt bleibt eigen)
 *  - nummerierte, fette Überschriften ohne Deko-Striche davor
 *
 * Der Hauptteil BESCHREIBT, was eingerichtet ist — welche App wie installiert
 * und an wen verteilt wird, was jede Richtlinie einstellt und für wen sie gilt.
 * Bewertungen (Abweichungen vom Zuweisungskonzept, Lücken) stehen gesammelt im
 * Anhang und lassen sich weglassen (data.appendix === false), wenn die Doku an
 * den Kunden geht.
 */
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const LOGO_PATH = path.join(__dirname, "..", "assets", "igeeks-logo.png");
const ACCENT = "#0081ad";
const COL = {
  text: "#373737", muted: "#707070", line: "#dfe4e8", head: "#f0f4f6",
  crit: "#b3261e", warn: "#b45309", ok: "#2e7d32", soft: "#e9f4f8"
};

// WinAnsi-verträglich: Latin-1 plus die cp1252-Sonderzeichen. Alles andere
// würde pdfkit als Müll-Glyphe setzen.
function san(s) {
  return String(s == null ? "" : s)
    .replace(/→|⇒/g, "›").replace(/⊃/g, "›").replace(/✓|✔/g, "ok").replace(/✗|✘|❌/g, "x").replace(/⚠️?/g, "!").replace(/≠/g, "!=")
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, "")
    .replace(/[ \t]+/g, " ");
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return fmtDate(iso) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function pl(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function cap(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
const TARGET_LABEL = { allDevices: "Alle Geräte", allUsers: "Alle Benutzer" };
const INSTALL_COLOR = { installed: COL.ok, failed: COL.crit, uninstallfailed: COL.crit, pendinginstall: COL.warn, pending: COL.warn, notinstalled: COL.muted };
const SEV_COLOR = { fehler: COL.crit, warn: COL.warn, hinweis: COL.muted };

function buildPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 66, bottom: 74, left: 56, right: 56 }, bufferPages: true });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
    const ensureSpace = n => { if (doc.y + n > bottomLimit()) doc.addPage(); };

    // ---------------------------------------------------------------- Bausteine
    let chapter = 0, sub = 0, appendixNo = 0;
    const h1 = (title, appendix) => {
      if (appendix) appendixNo += 1; else chapter += 1;
      sub = 0;
      ensureSpace(120);
      if (chapter + appendixNo > 1) doc.moveDown(1.4);
      const y = doc.y;
      const num = appendix ? String.fromCharCode(64 + appendixNo) : String(chapter);
      doc.font("Helvetica-Bold").fontSize(16).fillColor(ACCENT).text(num, left, y, { lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(16).fillColor(COL.text).text(san((appendix ? "Anhang: " : "") + title), left + 24, y, { width: W - 24 });
      doc.moveTo(left, doc.y + 5).lineTo(left + W, doc.y + 5).lineWidth(0.6).strokeColor(COL.line).stroke();
      doc.y += 14; doc.x = left;
      h1.current = num;
    };
    const h2 = title => {
      ensureSpace(60);
      doc.moveDown(0.8);
      sub += 1;
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(11.5).fillColor(ACCENT).text(`${h1.current}.${sub}`, left, y, { lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(11.5).fillColor(COL.text).text(san(title), left + 34, y, { width: W - 34 });
      doc.moveDown(0.3); doc.x = left;
    };
    const h3 = (title, right, rightColor) => {
      ensureSpace(70);
      doc.moveDown(0.65);
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COL.text).text(san(title), left, y, { width: right ? W - 120 : W });
      if (right) {
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(rightColor || COL.muted).text(san(right).toUpperCase(), left + W - 115, y + 1.5, { width: 115, align: "right", lineBreak: false });
      }
      doc.x = left;
    };
    const h4 = title => {
      ensureSpace(34);
      doc.moveDown(0.35);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COL.muted).text(san(title).toUpperCase(), left, doc.y, { width: W, characterSpacing: 0.3 });
      doc.moveDown(0.15); doc.x = left;
    };
    const body = (t, o) => { doc.font("Helvetica").fontSize(9.8).fillColor(COL.text).text(san(t), left, doc.y, { width: W, lineGap: 1.5, ...(o || {}) }); doc.x = left; };
    const small = (t, o) => { doc.font("Helvetica").fontSize(8.3).fillColor(COL.muted).text(san(t), left, doc.y, { width: W, lineGap: 1, ...(o || {}) }); doc.x = left; };
    const bullet = (t, color) => {
      ensureSpace(14);
      doc.font("Helvetica").fontSize(9).fillColor(color || COL.text).text("–  " + san(t), left + 6, doc.y, { width: W - 6, lineGap: 1 });
      doc.x = left;
    };
    const kv = (label, value, color, mono) => {
      if (value === null || value === undefined || value === "") return;
      const font = mono ? "Courier" : "Helvetica";
      const fs2 = mono ? 8 : 9;
      doc.font(font).fontSize(fs2);
      const hv = doc.heightOfString(san(value), { width: W - 130, lineGap: 1 });
      doc.font("Helvetica-Bold").fontSize(8.3);
      const hl = doc.heightOfString(san(label), { width: 122 });
      const h = Math.max(hv, hl, 11);
      ensureSpace(Math.min(h, 200) + 3);
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(8.3).fillColor(COL.muted).text(san(label), left, y + 0.8, { width: 122 });
      doc.font(font).fontSize(fs2).fillColor(color || COL.text).text(san(value), left + 130, y, { width: W - 130, lineGap: 1 });
      doc.y = Math.max(doc.y, y + h) + 2; doc.x = left;
    };
    /** Tabelle mit mitlaufendem Kopf bei Seitenumbruch. cols: [{label, w}] (w = Anteil). */
    const table = (cols, rows, o) => {
      o = o || {};
      const size = o.size || 8.3;
      const widths = cols.map(c => Math.floor(c.w * W));
      const xs = [];
      let acc = left;
      widths.forEach(w => { xs.push(acc); acc += w; });
      const head = () => {
        const hy = doc.y;
        doc.rect(left, hy - 2, W, 15).fill(COL.head);
        cols.forEach((c, i) => doc.font("Helvetica-Bold").fontSize(7).fillColor(COL.muted)
          .text(san(c.label).toUpperCase(), xs[i] + 4, hy + 2, { width: widths[i] - 8, lineBreak: false, characterSpacing: 0.3 }));
        doc.y = hy + 15;
      };
      ensureSpace(46);
      head();
      for (const row of rows) {
        const cells = row.map(c => (c && typeof c === "object") ? c : { text: c });
        const txt = c => san(cap(c.text == null || c.text === "" ? "—" : c.text, 900));
        const hs = cells.map((c, i) => doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
          .heightOfString(txt(c), { width: widths[i] - 8 - (c.indent || 0), lineGap: 0.5 }));
        const h = Math.max(...hs) + 5;
        if (doc.y + h > bottomLimit()) { doc.addPage(); head(); }
        const ry = doc.y;
        cells.forEach((c, i) => {
          doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(c.color || COL.text)
            .text(txt(c), xs[i] + 4 + (c.indent || 0), ry + 2.5, { width: widths[i] - 8 - (c.indent || 0), lineGap: 0.5 });
        });
        doc.y = ry + h;
        doc.moveTo(left, doc.y).lineTo(left + W, doc.y).lineWidth(0.35).strokeColor(COL.line).stroke();
      }
      doc.x = left;
      doc.moveDown(0.35);
    };
    const targetOf = a => a.group ? a.group.displayName : (TARGET_LABEL[a.targetKind] || a.targetKind);

    const S = data.sections || {};
    const apps = S.apps || null, pol = S.policies || null, ca = S.ca || null;
    const parts = [apps && "Apps", pol && (pol.scope === "oib" ? "Intune-Richtlinien (OIB)" : "Intune-Richtlinien"), ca && "Conditional Access"].filter(Boolean);
    const withAppendix = data.appendix !== false;

    // ================= Deckblatt =================
    doc.rect(0, 0, doc.page.width, 14).fill(ACCENT);
    let logo = false;
    try { if (fs.existsSync(LOGO_PATH)) { doc.image(LOGO_PATH, left, 52, { width: 150 }); logo = true; } } catch (e) { /* Text-Fallback */ }
    if (!logo) {
      doc.font("Helvetica-Bold").fontSize(12).fillColor(ACCENT).text("igeeks AG", left, 60);
      doc.font("Helvetica").fontSize(9.5).fillColor(COL.muted).text("Microsoft-365- und Security-Consulting", left);
    }
    doc.y = 255;
    doc.font("Helvetica-Bold").fontSize(30).fillColor(COL.text).text("Microsoft 365", left);
    doc.font("Helvetica-Bold").fontSize(30).fillColor(ACCENT).text("Konfigurations-", left);
    doc.font("Helvetica-Bold").fontSize(30).fillColor(ACCENT).text("dokumentation", left);
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(11).fillColor(COL.muted).text(san(parts.join(" · ")), left);
    doc.moveDown(1.0);
    doc.font("Helvetica-Bold").fontSize(17).fillColor(COL.text).text(san(data.tenantName || "—"), left);
    doc.moveDown(0.25);
    const stamps = [apps && `Apps ${fmtDateTime(apps.generatedAt)}`, pol && `Richtlinien ${fmtDateTime(pol.generatedAt)}`, ca && `Conditional Access ${fmtDateTime(ca.generatedAt)}`].filter(Boolean);
    doc.font("Helvetica").fontSize(10.5).fillColor(COL.muted)
      .text((data.organization ? data.organization + "\n" : "") + "Stand: " + fmtDate(data.generatedAt) + "\nDatenerhebung: " + stamps.join(" · "), left, doc.y, { lineGap: 2, width: W });
    doc.font("Helvetica").fontSize(9).fillColor(COL.muted).text("Vertraulich — nur für den Empfänger bestimmt.", left, doc.page.height - 118, { lineGap: 2 });
    doc.font("Helvetica").fontSize(9).fillColor(COL.muted).text("Aus dem Tenant ausgelesen (Microsoft Graph, nur lesend) — die Dokumentation zeigt den tatsächlichen Stand, nicht eine Soll-Vorgabe.", left, doc.y, { width: W });

    doc.addPage();

    // ================= Überblick =================
    h1("Überblick");
    body("Diese Dokumentation beschreibt die im Tenant eingerichtete Konfiguration: welche Apps an welche Geräte verteilt werden und über welche Gruppen, was jede Intune-Richtlinie einstellt und für wen sie gilt, und welche Conditional-Access-Richtlinien die Anmeldung steuern.");
    doc.moveDown(0.4);
    if (apps) kv("Apps", `${pl(apps.summary.assigned, "App mit Zuweisung", "Apps mit Zuweisung")} von ${apps.summary.apps}, erreichen ${pl(apps.summary.devices, "Gerät", "Geräte")}`);
    if (pol) kv("Intune-Richtlinien", `${pl(pol.summary.policies, "Richtlinie", "Richtlinien")}${pol.scope === "oib" ? " der OpenIntuneBaseline" : ""}, davon ${pol.summary.assigned} zugewiesen; erreichen ${pl(pol.summary.devices, "Gerät", "Geräte")}`);
    if (ca) kv("Conditional Access", `${pl(ca.summary.policies, "Richtlinie", "Richtlinien")}: ${ca.summary.enabled} aktiv, ${ca.summary.reportOnly} nur Bericht, ${ca.summary.disabled} aus · ${pl(ca.summary.users, "aktives Konto", "aktive Konten")}${ca.summary.securityDefaults === true ? " · Sicherheitsstandards eingeschaltet" : ""}`);
    const conv = (apps && apps.convention) || null;
    if (conv) {
      h2("Zuweisungskonzept");
      body("Geräte kommen über ihren Autopilot-GroupTag in eine dynamische Gerätegruppe. Richtlinien werden der Gerätegruppe zugewiesen. Eine App hängt an genau einer App-Gruppe; welche Geräte sie bekommen, bestimmt die Verschachtelung — die Gerätegruppe ist Mitglied der App-Gruppe:");
      doc.moveDown(0.3);
      body("App  ›  App-Gruppe  ›  Gerätegruppe (GroupTag)  ›  Gerät", { align: "center" });
      doc.moveDown(0.3);
      const muster = t => String(t || "").replace(/\{app\}/gi, "<App>").replace(/\{tag\}/gi, "<GroupTag>");
      kv("Gerätegruppe", muster(conv.deviceGroup));
      kv("App-Gruppe", muster(conv.appGroup) + " (selbst paketiert)");
      kv("App-Gruppe Patch My PC", muster(conv.pmpGroup));
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
      h1("Gruppenstruktur");
      body("Alle Gruppen, die in den Zuweisungen der dokumentierten Apps und Richtlinien vorkommen, mit ihrer Mitgliedschaftsregel bzw. ihren Mitgliedern.");
      if (devGroups.length) {
        h2("Gerätegruppen");
        table([{ label: "Gruppe", w: 0.27 }, { label: "GroupTag", w: 0.14 }, { label: "Mitgliedschaft", w: 0.47 }, { label: "Geräte", w: 0.12 }],
          devGroups.map(g => [{ text: g.displayName, bold: true }, (g.tags || []).join(", ") || "—",
            g.dynamic ? "dynamisch: " + (g.rule || "—") : `statisch (${g.directDevices} Gerät(e)${g.memberGroups.length ? ", Untergruppen: " + g.memberGroups.join(", ") : ""})`,
            String(g.devices)]), { size: 7.8 });
      }
      if (appGroups.length) {
        h2("App-Gruppen");
        table([{ label: "App-Gruppe", w: 0.3 }, { label: "Enthält", w: 0.3 }, { label: "Geräte", w: 0.1 }, { label: "Verwendet von", w: 0.3 }],
          appGroups.map(g => [{ text: g.displayName, bold: true },
            [...g.memberGroups, g.directDevices ? `${g.directDevices} Gerät(e) direkt` : null, g.directUsers ? `${g.directUsers} Benutzer direkt` : null].filter(Boolean).join("\n") || "leer",
            String(g.devices), [...(usedBy.get(g.id) || [])].join("\n") || "—"]), { size: 7.8 });
      }
      if (userGroups.length) {
        h2("Benutzergruppen in Zuweisungen");
        table([{ label: "Gruppe", w: 0.35 }, { label: "Mitgliedschaft", w: 0.45 }, { label: "Benutzer", w: 0.2 }],
          userGroups.map(g => [{ text: g.displayName, bold: true }, g.dynamic ? "dynamisch: " + (g.rule || "—") : (g.memberGroups.length ? "statisch, Untergruppen: " + g.memberGroups.join(", ") : "statisch"), String(g.users)]), { size: 7.8 });
      }
    }

    if (apps) renderApps();
    if (pol) renderPolicies();
    if (ca) renderCa();
    if (withAppendix) renderDeviations();
    renderMethod();

    // ================= Fusszeilen =================
    const range = doc.bufferedPageRange();
    for (let p = range.start + 1; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(left, doc.page.height - 52).lineTo(left + W, doc.page.height - 52).lineWidth(0.5).strokeColor(COL.line).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(COL.muted).text(san(`igeeks AG · Konfigurationsdokumentation ${data.tenantName || ""} · Stand ${fmtDate(data.generatedAt)}`),
        left, doc.page.height - 44, { width: W - 80, lineBreak: false });
      doc.font("Helvetica").fontSize(8).fillColor(COL.muted).text(`Seite ${p} von ${range.count - 1}`,
        left + W - 80, doc.page.height - 44, { width: 80, align: "right", lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();

    // ---------------------------------------------------------------- Apps
    function renderApps() {
      h1("Apps");
      const assigned = apps.apps.filter(a => a.assignments.length);
      h2("Übersicht");
      table([{ label: "App", w: 0.27 }, { label: "Typ / Quelle", w: 0.2 }, { label: "Version", w: 0.1 }, { label: "Zuweisung", w: 0.33 }, { label: "Geräte", w: 0.1 }],
        assigned.map(a => [
          { text: a.displayName, bold: true },
          `${a.type}\n${a.managedByLabel}`,
          a.version || "—",
          a.assignments.map(x => `${x.exclude ? "Ausschluss" : x.intentLabel}: ${targetOf(x)}`).join("\n"),
          String(a.devices.length) + (a.users.length ? ` / ${a.users.length} Ben.` : "")
        ]), { size: 7.8 });
      const unassigned = apps.apps.filter(a => !a.assignments.length);
      if (unassigned.length) small(`Vorhanden, aber keinem Gerät zugewiesen (${unassigned.length}): ` + unassigned.slice(0, 60).map(a => a.displayName).join(", ") + (unassigned.length > 60 ? " …" : ""));

      h2("Apps im Detail");
      for (const a of assigned) {
        h3(a.displayName, a.managedByLabel);
        small([a.type, a.platform, a.lastModifiedDateTime ? "geändert " + fmtDate(a.lastModifiedDateTime) : null].filter(Boolean).join(" · "));
        doc.moveDown(0.2);
        for (const c of a.config || []) {
          kv(c.label, c.value, null, /befehl|Erkennung|Anforderungen|Befehlszeile/i.test(c.label));
        }
        h4("Zuweisung");
        for (const as of a.assignments) {
          const tgt = as.group ? `${as.group.displayName} (${as.group.kindLabel}${as.group.tags && as.group.tags.length ? ", GroupTag " + as.group.tags.join(", ") : ""})` : targetOf(as);
          let line = `${as.exclude ? "Ausschluss" : as.intentLabel}  ›  ${tgt}`;
          const subs = as.group && as.group.memberGroups ? as.group.memberGroups : [];
          if (subs.length) line += "  ›  " + subs.map(sg => sg.displayName + (sg.tags && sg.tags.length ? ` (GroupTag ${sg.tags.join(", ")})` : "")).join(", ");
          if (as.deviceCount !== null && as.deviceCount !== undefined) line += `   [${pl(as.deviceCount, "Gerät", "Geräte")}]`;
          bullet(line, as.exclude ? COL.muted : COL.text);
          const extras = [as.filter ? `Filter (${as.filter.mode}): ${as.filter.name}${as.filter.rule ? " — " + as.filter.rule : ""}` : null, ...(as.settings || [])].filter(Boolean);
          if (extras.length) { doc.font("Helvetica").fontSize(8.3).fillColor(COL.muted).text(san(extras.join(" · ")), left + 18, doc.y, { width: W - 18, lineGap: 1 }); doc.x = left; }
        }
        if (a.devices.length) {
          h4(`Geräte (${a.devices.length})`);
          const shown = a.devices.slice(0, 250);
          const hasInstall = shown.some(d => d.installLabel);
          table([
            { label: "Gerät", w: 0.2 }, { label: "GroupTag", w: 0.12 }, { label: "Erreicht über", w: hasInstall ? 0.34 : 0.43 },
            { label: "Primärbenutzer", w: hasInstall ? 0.2 : 0.25 }, ...(hasInstall ? [{ label: "Status", w: 0.14 }] : [])
          ], shown.map(d => [
            { text: d.name, bold: true }, d.groupTag || "—", d.via + (d.viaCount > 1 ? ` (+${d.viaCount - 1})` : ""), d.user || "—",
            ...(hasInstall ? [{ text: d.installLabel || "—", color: INSTALL_COLOR[d.install] || COL.text }] : [])
          ]), { size: 7.6 });
          if (a.devices.length > shown.length) small(`… und ${a.devices.length - shown.length} weitere Geräte (vollständig im CSV-Export).`);
        } else if (a.users.length) {
          kv("Benutzer", `${a.users.length}: ` + a.users.slice(0, 40).map(u => u.upn || u.name).join(", ") + (a.users.length > 40 ? " …" : ""));
        }
      }

      if (apps.byDevice && apps.byDevice.length) {
        h2("Geräte und ihre Apps");
        table([{ label: "Gerät", w: 0.19 }, { label: "GroupTag", w: 0.12 }, { label: "Primärbenutzer", w: 0.21 }, { label: "Apps", w: 0.48 }],
          apps.byDevice.slice(0, 800).map(d => [{ text: d.name, bold: true }, d.groupTag || "—", d.user || "—",
            d.apps.map(x => x.app + (x.install ? ` (${x.install})` : "")).join(", ")]), { size: 7.5 });
        if (apps.byDevice.length > 800) small(`… und ${apps.byDevice.length - 800} weitere Geräte (vollständig im CSV-Export).`);
      }
    }

    // ---------------------------------------------------------------- Richtlinien
    function renderPolicies() {
      h1(pol.scope === "oib" ? "Intune-Richtlinien (OpenIntuneBaseline)" : "Intune-Richtlinien");
      body(pol.scope === "oib"
        ? "Dokumentiert sind die Richtlinien der OpenIntuneBaseline (Name beginnt mit «Win - OIB» bzw. «MacOS - OIB»). Je Richtlinie: Zweck, Zuweisung, betroffene Geräte und sämtliche Einstellungen."
        : "Dokumentiert sind alle Intune-Konfigurations-, Compliance- und Update-Richtlinien. Je Richtlinie: Zweck, Zuweisung, betroffene Geräte und sämtliche Einstellungen.");

      h2("Übersicht");
      table([{ label: "Richtlinie", w: 0.4 }, { label: "Typ", w: 0.17 }, { label: "Zugewiesen an", w: 0.3 }, { label: "Geräte", w: 0.13 }],
        pol.policies.map(p => [
          { text: p.name, bold: true }, p.type,
          p.assignments.length ? p.assignments.map(a => (a.exclude ? "ohne " : "") + targetOf(a)).join("\n") : "nicht zugewiesen",
          String(p.devices.length) + (p.users.length ? ` / ${p.users.length} Ben.` : "")
        ]), { size: 7.7 });

      if (pol.coverage && pol.coverage.length) {
        h2("Richtlinien je Gerätegruppe");
        small("Welche Richtlinien bei einer Gerätegruppe ankommen — direkt, über eine verschachtelte Gruppe oder über «Alle Geräte»; Ausschlüsse sind abgezogen.");
        for (const c of pol.coverage) {
          const got = pol.policies.filter(p => !c.missing.includes(p.name) && (!p.oibParts || p.oibParts.geltung === "Gerät")).map(p => p.name);
          h4(`${c.displayName}${c.tags && c.tags.length ? " · GroupTag " + c.tags.join(", ") : ""} · ${pl(c.devices == null ? 0 : c.devices, "Gerät", "Geräte")}`);
          table([{ label: `Wirksam (${got.length})`, w: 0.6 }, { label: `Nicht zugewiesen (${c.missing.length})`, w: 0.4 }],
            [[got.join("\n") || "—", c.missing.join("\n") || "—"]], { size: 7.4 });
        }
      }

      h2("Richtlinien im Detail");
      for (const p of pol.policies) {
        h3(p.name, p.type);
        small([p.platform, p.createdDateTime ? "angelegt " + fmtDate(p.createdDateTime) : null, p.lastModifiedDateTime ? "geändert " + fmtDate(p.lastModifiedDateTime) : null].filter(Boolean).join(" · "));
        doc.moveDown(0.2);
        if (p.oibParts) {
          kv("Zweck", `${p.oibParts.bereich} — ${p.oibParts.inhalt}`);
          kv("Geltung", `${p.oibParts.geltung}${p.oibParts.version ? " · OpenIntuneBaseline " + p.oibParts.version : ""}`);
        }
        if (p.description) kv("Beschreibung", cap(p.description, 800));
        const inc = p.assignments.filter(a => !a.exclude), exc = p.assignments.filter(a => a.exclude);
        kv("Zugewiesen an", inc.length ? inc.map(a => (a.group ? `${a.group.displayName} (${a.group.kindLabel})` : targetOf(a))
          + (a.nestedGroups && a.nestedGroups.length ? " › " + a.nestedGroups.map(n => n.displayName).join(", ") : "")
          + (a.filter ? ` — Filter (${a.filter.mode}): ${a.filter.name}` : "")).join("\n") : "nicht zugewiesen");
        if (exc.length) kv("Ausgenommen", exc.map(a => targetOf(a)).join("\n"));
        kv("Wirkt auf", `${pl(p.devices.length, "Gerät", "Geräte")}${p.users.length ? ", " + pl(p.users.length, "Benutzer", "Benutzer") : ""}` +
          (p.devices.length ? ": " + p.devices.slice(0, 60).map(d => d.name).join(", ") + (p.devices.length > 60 ? ` … +${p.devices.length - 60}` : "") : ""));
        if (p.settings.length) {
          h4(`Einstellungen (${p.settingsTotal})`);
          table([{ label: "Einstellung", w: 0.6 }, { label: "Wert", w: 0.4 }],
            p.settings.map(s => [{ text: s.label, bold: !s.depth, indent: Math.min(s.depth || 0, 4) * 9 }, s.value || ""]), { size: 7.3 });
          if (p.settingsTotal > p.settings.length) small(`… und ${p.settingsTotal - p.settings.length} weitere Einstellungen.`);
        } else if (p.settingsError) {
          small("Einstellungen nicht lesbar: " + cap(p.settingsError, 200));
        } else {
          small("Keine Einstellungen ausgelesen.");
        }
      }
    }

    // ---------------------------------------------------------------- Conditional Access
    function renderCa() {
      h1("Conditional Access");
      body("Je Richtlinie: Zustand, was sie verlangt, für wen sie gilt und wer ausgenommen ist — bis auf die einzelnen Konten aufgelöst. «Nur Bericht» (Report-only) wertet Anmeldungen aus, erzwingt aber nichts." +
        (ca.summary.securityDefaults === true ? " Die Sicherheitsstandards (Security Defaults) sind eingeschaltet." : ca.summary.securityDefaults === false ? " Die Sicherheitsstandards (Security Defaults) sind ausgeschaltet." : ""));
      const stColor = s => s === "enabled" ? COL.ok : s === "disabled" ? COL.muted : COL.warn;
      const stShort = s => ({ enabled: "Aktiv", enabledForReportingButNotEnforced: "Nur Bericht", disabled: "Aus" }[s] || s);

      h2("Übersicht");
      table([{ label: "Richtlinie", w: 0.37 }, { label: "Zustand", w: 0.13 }, { label: "Wirkung", w: 0.3 }, { label: "Betrifft", w: 0.1 }, { label: "Ausgen.", w: 0.1 }],
        ca.policies.map(p => [{ text: p.name, bold: true }, { text: stShort(p.state), color: stColor(p.state), bold: true }, p.effectShort,
          String(p.scope.effective), String(p.scope.excluded)]), { size: 7.8 });

      if (ca.namedLocations && ca.namedLocations.length) {
        h2("Benannte Standorte");
        table([{ label: "Standort", w: 0.35 }, { label: "Definition", w: 0.65 }], ca.namedLocations.map(l => [{ text: l.name, bold: true }, l.detail || "—"]), { size: 7.8 });
      }

      h2("Richtlinien im Detail");
      for (const p of ca.policies) {
        h3(p.name, stShort(p.state), stColor(p.state));
        small([p.createdDateTime ? "angelegt " + fmtDate(p.createdDateTime) : null, p.modifiedDateTime ? "geändert " + fmtDate(p.modifiedDateTime) : null].filter(Boolean).join(" · "));
        doc.moveDown(0.3);
        const sh = doc.font("Helvetica").fontSize(9.5).heightOfString(san(p.summary), { width: W - 14, lineGap: 1.5 });
        ensureSpace(sh + 10);
        const y0 = doc.y;
        doc.rect(left, y0, 3, sh + 4).fill(ACCENT);
        doc.font("Helvetica").fontSize(9.5).fillColor(COL.text).text(san(p.summary), left + 10, y0 + 2, { width: W - 14, lineGap: 1.5 });
        doc.x = left; doc.moveDown(0.4);
        kv("Gilt für", p.who.include.join("\n") || "niemanden");
        if (p.who.exclude.length) kv("Ausgenommen", p.who.exclude.join("\n"));
        kv("Cloud-Apps / Aktionen", [...p.apps.include, ...p.apps.actions.map(a => "Aktion: " + a), ...p.apps.authContext.map(a => "Kontext: " + a)].join(", ") + (p.apps.exclude.length ? "\nausser: " + p.apps.exclude.join(", ") : ""));
        if (p.conditions.length) kv("Bedingungen", p.conditions.join("\n"));
        kv("Gewähren", p.grant.blocks ? "Zugriff blockieren" : (p.grant.controls.length ? p.grant.controls.join(p.grant.operator === "OR" ? " ODER " : " UND ") : "—"));
        if (p.session.length) kv("Sitzung", p.session.join("\n"));
        kv("Betroffene Konten", `${pl(p.scope.effective, "Konto", "Konten")}${p.scope.guests ? `, davon ${pl(p.scope.guests, "Gast", "Gäste")}` : ""}${p.scope.disabled ? `, ${p.scope.disabled} deaktiviert` : ""}` +
          (p.effectiveUsers.length && p.effectiveUsers.length <= 40 ? ": " + p.effectiveUsers.map(u => u.upn + (u.guest ? " (Gast)" : "") + (u.enabled ? "" : " (deaktiviert)")).join(", ") : ""));
        if (p.excludedUsers.length) {
          kv("Ausgenommene Konten", p.excludedUsers.slice(0, 80).map(u => u.upn + (u.guest ? " (Gast)" : "") + (u.enabled ? "" : " (deaktiviert)")).join("\n") + (p.excludedUsers.length > 80 ? `\n… +${p.excludedUsers.length - 80}` : ""));
        }
        if (p.signIns) {
          const c = p.signIns.counts || {};
          const label = { success: "erfüllt", failure: "nicht erfüllt/blockiert", notApplied: "nicht angewendet", reportOnlySuccess: "Bericht: wäre erfüllt",
            reportOnlyFailure: "Bericht: wäre blockiert", reportOnlyNotApplied: "Bericht: nicht angewendet", reportOnlyInterrupted: "Bericht: hätte unterbrochen", notEnabled: "nicht aktiv" };
          kv(`Anmeldungen (${ca.signIns ? ca.signIns.days : "?"} Tage)`, Object.keys(c).length ? Object.keys(c).map(k => `${label[k] || k}: ${c[k]}`).join(" · ") : "keine im Zeitraum");
        }
      }

      if (ca.matrix && ca.matrix.length) {
        h2("Richtlinien je Konto");
        small("Für jedes aktive Konto: welche aktiven und welche Report-only-Richtlinien greifen (Ausschlüsse abgezogen; Standort-, Plattform- und Risikobedingungen werden erst bei der Anmeldung ausgewertet).");
        const rows = ca.matrix.slice(0, 600);
        table([{ label: "Konto", w: 0.3 }, { label: "Aktiv", w: 0.4 }, { label: "Nur Bericht", w: 0.3 }],
          rows.map(u => [{ text: u.upn + (u.guest ? " (Gast)" : ""), bold: true }, u.active.map(x => x.name).join("\n") || "—", u.reportOnly.map(x => x.name).join("\n") || "—"]), { size: 7.3 });
        if (ca.matrix.length > rows.length) small(`… und ${ca.matrix.length - rows.length} weitere Konten (vollständig im CSV-Export).`);
      }
    }

    // ---------------------------------------------------------------- Anhang: Abweichungen
    function renderDeviations() {
      const appF = apps ? apps.apps.filter(a => a.findings.some(f => f.severity !== "hinweis" || f.fix)) : [];
      const polF = pol ? pol.policies.filter(p => p.findings.some(f => f.severity !== "hinweis")) : [];
      const caF = ca ? ca.policies.filter(p => p.findings.some(f => f.severity !== "hinweis")) : [];
      const caGaps = ca && (ca.withoutMfa.length || ca.excludedFromAll.length || !ca.summary.legacyBlocked);
      if (!appF.length && !polF.length && !caF.length && !caGaps) return;
      h1("Abweichungen vom Zuweisungskonzept", true);
      body("Punkte, an denen die vorgefundene Konfiguration vom Zuweisungskonzept bzw. von der Grundlinie abweicht. Sie beschreiben den Stand zum Zeitpunkt der Erhebung und sind als Hinweise zu verstehen, nicht als Mängelliste.");
      if (appF.length) {
        h2("Apps");
        for (const a of appF) {
          h4(a.displayName);
          a.findings.filter(f => f.severity !== "hinweis" || f.fix).forEach(f => bullet(f.text, SEV_COLOR[f.severity]));
        }
      }
      if (polF.length) {
        h2("Intune-Richtlinien");
        for (const p of polF) { h4(p.name); p.findings.filter(f => f.severity !== "hinweis").forEach(f => bullet(f.text, SEV_COLOR[f.severity])); }
      }
      if (caF.length || caGaps) {
        h2("Conditional Access");
        if (ca.withoutMfa.length) bullet(`${pl(ca.withoutMfa.length, "aktives Konto fällt", "aktive Konten fallen")} unter keine aktive Richtlinie, die für alle Cloud-Apps MFA verlangt: ` +
          ca.withoutMfa.slice(0, 40).map(u => u.upn).join(", ") + (ca.withoutMfa.length > 40 ? " …" : "") + (ca.summary.securityDefaults ? " (Sicherheitsstandards sind eingeschaltet)." : "."), COL.warn);
        if (ca.excludedFromAll.length) bullet(`Von allen aktiven Richtlinien ausgenommen: ${ca.excludedFromAll.slice(0, 40).map(u => u.upn).join(", ")}${ca.excludedFromAll.length > 40 ? " …" : ""}.`, COL.warn);
        if (!ca.summary.legacyBlocked) bullet("Keine aktive Richtlinie blockiert Legacy-Authentifizierung ausdrücklich.", COL.warn);
        for (const p of caF) { h4(p.name); p.findings.filter(f => f.severity !== "hinweis").forEach(f => bullet(f.text, SEV_COLOR[f.severity])); }
      }
    }

    // ---------------------------------------------------------------- Anhang: Erhebung
    function renderMethod() {
      h1("Erhebung und Grenzen", true);
      body("Alle Angaben stammen aus Microsoft Graph (Intune, Entra ID) und wurden ausschliesslich lesend über eine dedizierte, zertifikatsbasierte Anwendung erhoben. Gruppen sind rekursiv bis zu den Geräten und Konten aufgelöst; bei jedem Gerät steht der Weg dorthin (zugewiesene Gruppe › verschachtelte Gruppe).");
      doc.moveDown(0.3);
      [
        "Die Auflösung zeigt, wen eine Zuweisung erreichen soll. Ob eine Richtlinie auf dem Gerät angewendet wurde, zeigt Intune im Gerätestatus; bei Apps ist der Installationsstatus ausgewiesen, sofern er erhoben wurde.",
        "Zuweisungsfilter sind mit Name und Regel aufgeführt, aber nicht gegen die einzelnen Geräte ausgewertet.",
        "Conditional Access: Rollen zählen mit aktiver Zuweisung (PIM-berechtigte Konten erst nach Aktivierung). Gäste werden über den Kontotyp «Guest» bestimmt.",
        "Befehlszeilen sind gekürzt, wo sie Einschreibe-Schlüssel enthalten (z. B. GravityZone-Token)."
      ].forEach(l => bullet(l));
      const gaps = [...(apps ? apps.gaps || [] : []), ...(pol ? (pol.gaps || []).concat((pol.sourceErrors || []).map(e => `${e.source}: ${e.error}`)) : []), ...(ca ? ca.gaps || [] : [])];
      if (apps && apps.readable && !apps.readable.managedDevices) gaps.push("Intune-Gerätedetails (Name, Primärbenutzer, Compliance) nicht lesbar: " + (apps.readable.managedDevicesError || "Berechtigung fehlt"));
      if (gaps.length) {
        h4("Nicht lesbar bei dieser Erhebung");
        [...new Set(gaps)].slice(0, 30).forEach(g => bullet(cap(g, 220), COL.warn));
      }
    }
  });
}

module.exports = { buildPdf };
