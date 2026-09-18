"use strict";
/**
 * Kapitel "SharePoint und OneDrive" der Konfigurationsdokumentation
 * (lib/assignAuditPdf.js ruft es auf, Layout aus lib/pdfDesign.js).
 *
 * Beschreibend: welche Sites es gibt, welcher Art, wem sie gehören, wer Mitglied
 * ist, wie viel Speicher sie belegen, wie der Tenant das Teilen regelt. Bewertungen
 * (Gäste in öffentlichen Gruppen, Gruppen ohne Besitzer, «Jeder»-Links …) stehen in
 * einem eigenen Anhang und entfallen mit dem Anhang-Schalter.
 */
const D = require("./pdfDesign");
const INV = require("./sharepointInventory");
const { pl, cap, fmtDate, ACCENT } = D;

const SEV_TONE = { warn: "warn", hinweis: "muted" };
// Zusammensetzung nach Art: bewusst Blau-/Grautöne statt Ampel — beschreibend.
const KIND_COLOR = { teams: "#005f80", group: ACCENT, communication: "#4fb3d9", teamSite: "#8fcde6", classic: "#9aa4ad", channel: "#6b7fa6", other: "#b0bac2", unknown: "#cfd8df", system: "#e2e7eb" };
// Kurzbezeichnung der Art für schmale Tabellenspalten.
function kindCell(s) {
  if (s.orphanGroup) return "Gruppe nicht auffindbar";
  if (s.kind === "unknown") return s.isRoot ? "Stammsite, Art offen" : "Art offen (nicht über Graph)";
  return { teams: "Team-Site mit Teams", group: "Team-Site mit Gruppe", communication: "Kommunikation", teamSite: "Team-Site ohne Gruppe", classic: "Klassische Site", channel: "Teams-Kanal", other: "Andere Vorlage", system: "System" }[s.kind] || s.kindLabel;
}

function bytes(b) {
  if (b === null || b === undefined) return "—";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = Number(b), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString("de-CH", { maximumFractionDigits: v < 100 && i > 0 ? 1 : 0 })} ${u[i]}`;
}
function day(s) { return s ? fmtDate(s.length === 10 ? s + "T12:00:00Z" : s) : "—"; }
function names(list, max) {
  const l = (list || []).map(p => p.name + (p.guest ? " (Gast)" : ""));
  return l.length ? l.slice(0, max).join(", ") + (l.length > max ? ` … +${l.length - max}` : "") : "—";
}

/** Kachel für das Deckblatt der Gesamt-Doku. */
function coverTile(sp) { return { label: "SharePoint-Sites", value: sp.summary.sites }; }
/** Zeile für die Überblick-Karte der Gesamt-Doku. */
function overviewLine(sp) {
  const S = sp.summary;
  return ["SharePoint und OneDrive", `${pl(S.sites, "Site", "Sites")}, davon ${S.teams} mit Teams · ${pl(S.oneDrives, "OneDrive-Konto", "OneDrive-Konten")} · Speicher ${bytes(S.storageUsed + S.oneDriveStorage)}` +
    (S.sharingLabel ? ` · externe Freigabe: ${S.sharingLabel}` : "")];
}

// ------------------------------------------------------------------ Grafiken
/** Gestapelter Balken: Sites nach Art, mit Legende. */
function compositionBar(b, sp) {
  const doc = b.doc, W = b.W, L = b.L;
  const entries = Object.keys(INV.KIND).map(k => ({ k, n: sp.summary.byKind[k] || 0 })).filter(e => e.n);
  const total = entries.reduce((a, e) => a + e.n, 0);
  if (!total) return;
  b.ensure(58);
  const y = doc.y + 4, h = 12;
  let x = L;
  doc.roundedRect(L, y, W, h, 3).fill("#eef1f3");
  entries.forEach((e, i) => {
    const w = W * e.n / total;
    doc.rect(x, y, w, h).fill(KIND_COLOR[e.k] || "#c4ced6");
    if (i > 0) doc.moveTo(x, y).lineTo(x, y + h).lineWidth(1).strokeColor("#ffffff").stroke();
    x += w;
  });
  // Legende
  let lx = L, ly = y + h + 7;
  doc.font("Helvetica").fontSize(7.4);
  for (const e of entries) {
    const label = D.san(`${INV.KIND[e.k].short} ${e.n}`);
    const w = doc.widthOfString(label) + 18;
    if (lx + w > L + W) { lx = L; ly += 12; }
    doc.rect(lx, ly + 1.5, 7, 7).fill(KIND_COLOR[e.k] || "#c4ced6");
    doc.fillColor("#2f3437").text(label, lx + 10, ly, { lineBreak: false });
    lx += w + 6;
  }
  doc.y = ly + 16; doc.x = L;
}

/** Skala der vier Freigabestufen, die gültige hervorgehoben. */
function sharingScale(b, sharing) {
  const doc = b.doc, W = b.W, L = b.L;
  b.ensure(62);
  const y = doc.y + 4, gap = 4, n = INV.SHARING_ORDER.length, w = (W - gap * (n - 1)) / n, h = 30;
  INV.SHARING_ORDER.forEach((k, i) => {
    const x = L + i * (w + gap);
    const on = sharing && sharing.key === k;
    doc.roundedRect(x, y, w, h, 4).fill(on ? ACCENT : "#eef1f3");
    doc.font("Helvetica-Bold").fontSize(7.8).fillColor(on ? "#ffffff" : "#6b7680")
      .text(D.san(INV.SHARING[k].label), x + 7, y + 6, { width: w - 14, lineGap: 0.5 });
  });
  doc.font("Helvetica").fontSize(7).fillColor("#9aa4ad").text("geschlossener", L, y + h + 3, { lineBreak: false });
  doc.text("offener", L + W - 40, y + h + 3, { width: 40, align: "right", lineBreak: false });
  doc.y = y + h + 16; doc.x = L;
}

// ------------------------------------------------------------------ Kapitel
function renderChapter(b, sp) {
  const S = sp.summary;
  const R = sp.reports || {};
  b.h1("SharePoint und OneDrive");
  b.body("Alle SharePoint-Sites des Tenants mit Art, Adresse und Speicher, bei Sites mit Microsoft-365-Gruppe mit Besitzern, Mitgliedern und Gästen; dazu die OneDrive-Konten und die tenantweiten Freigabe-Einstellungen." +
    (R.siteRows || R.oneDriveRows ? ` Nutzungsdaten aus dem Microsoft-365-Nutzungsbericht (${sp.periodDays} Tage${R.refreshDate ? `, Stand ${day(R.refreshDate)}` : ""}).` : ""));
  b.tiles([
    { label: "Sites", value: S.sites },
    { label: "davon mit Teams", value: S.teams },
    { label: "Speicher SharePoint", value: bytes(S.storageUsed) },
    { label: "OneDrive-Konten", value: S.oneDrives }
  ]);
  compositionBar(b, sp);
  if (R.concealed) {
    b.note("Nutzungsberichte anonymisiert",
      "In diesem Tenant ersetzen die Microsoft-365-Nutzungsberichte Namen und Adressen durch Kennungen (Einstellung «Display concealed user, group, and site names in all reports» unter Einstellungen › Organisationseinstellungen › Berichte). " +
      `Berichtszeilen zu Sites wurden über die Site-Id zugeordnet (${R.siteRowsJoined} von ${sp.sites.length} Sites). Für OneDrive ist die letzte Aktivität je Konto deshalb nicht zuordenbar; Speicher und Kontingent je OneDrive stammen direkt aus dem jeweiligen Laufwerk.`, "info");
  }

  // ---------------------------------------------------------------- Freigabe
  b.h2("Tenantweite Freigabe-Einstellungen");
  if (!sp.settings) {
    b.small("Die tenantweiten SharePoint-Einstellungen waren bei der Erhebung nicht lesbar (siehe Anhang «Erhebung und Grenzen»).");
  } else {
    b.body(`Externe Freigabe für SharePoint: ${sp.settings.sharing.label}. ${sp.settings.sharing.description}`);
    sharingScale(b, sp.settings.sharing);
    for (const g of sp.settings.groups) {
      b.h4(g.title);
      b.card(g.items.map(i => [i.label, i.detail && i.label !== "Freigabestufe SharePoint" ? `${i.value}\n${i.detail}` : i.value]));
    }
  }
  b.h4("Nicht über Graph verfügbar");
  b.small("Diese Einstellungen stellt Microsoft Graph nicht bereit; sie sind in dieser Dokumentation nicht erhoben und im SharePoint Admin Center bzw. per SharePoint Online PowerShell nachzusehen.");
  b.doc.moveDown(0.3);
  b.table([{ label: "Einstellung", w: 0.3 }, { label: "Worum es geht", w: 0.7 }],
    (sp.notViaGraph || INV.NOT_VIA_GRAPH).map(n => [{ text: n.topic, bold: true }, n.detail]), { size: 7.6 });

  // ---------------------------------------------------------------- Sites
  const content = sp.sites.filter(s => s.kind !== "system");
  const system = sp.sites.filter(s => s.kind === "system");
  b.h2("Sites im Überblick");
  b.small("Freigabestufe je Site: nicht über Graph verfügbar — eine Site kann die tenantweite Stufe nur einschränken, nicht erweitern." +
    (S.byKind.unknown ? ` Bei ${pl(S.byKind.unknown, "Site", "Sites")} ohne Gruppe ist die Art nicht über Graph verfügbar (keine Vorlage im Nutzungsbericht).` : ""));
  b.doc.moveDown(0.2);
  b.table([
    { label: "Site", w: 0.19 }, { label: "Adresse", w: 0.2 }, { label: "Art", w: 0.16 }, { label: "Besitzer", w: 0.19 },
    { label: "Mitgl.", w: 0.07 }, { label: "Gäste", w: 0.07 }, { label: "Speicher", w: 0.12 }
  ], content.map(s => [
    { text: s.name, bold: true }, { text: s.path, mono: true }, kindCell(s),
    s.group ? { text: s.group.ownerCount === 0 ? "keine" : names(s.group.owners, 3) } : s.reportOwner ? `${s.reportOwner.name || s.reportOwner.upn} (Nutzungsbericht)` : { text: "nicht über Graph verfügbar", tone: "muted" },
    s.group && s.group.memberCount !== null ? String(s.group.memberCount) : "—",
    s.group && s.group.guestCount !== null ? String(s.group.guestCount) : "—",
    bytes(s.storageUsed) + (s.storageAllocated ? `\nvon ${bytes(s.storageAllocated)}` : "")
  ]), { size: 7.3 });
  const auto = sp.settings && sp.settings.raw && sp.settings.raw.isSitesStorageLimitAutomatic === true;
  b.small([system.length ? `System-Sites (${system.length}): ` + system.map(s => `${s.name} (${s.path === "/" ? s.host : s.path})`).join(", ") + "." : null,
    auto ? "Speicherverwaltung automatisch: «von …» ist die Obergrenze je Site, belegt wird der gemeinsame Tenant-Speicher." : null].filter(Boolean).join(" "));

  const grouped = content.filter(s => s.group);
  if (grouped.length) {
    b.h2("Sites mit Microsoft-365-Gruppe");
    b.small("Besitzer und Mitglieder der Site sind die der Gruppe. Gäste sind Konten vom Typ «Gast».");
    for (const s of grouped) {
      const g = s.group;
      b.h3(s.name, g.teams ? "mit Teams" : "M365-Gruppe", "info");
      b.small([s.url, g.visibilityLabel, s.created ? "erstellt " + fmtDate(s.created) : null, s.modified ? "geändert " + fmtDate(s.modified) : null].filter(Boolean).join(" · "));
      b.doc.moveDown(0.25);
      b.card([
        ["Gruppe", `${g.displayName}${g.mail ? " · " + g.mail : ""}`],
        g.description && ["Beschreibung", cap(g.description, 400)],
        ["Besitzer" + (g.ownerCount !== null ? ` (${g.ownerCount})` : ""), g.ownerCount === 0 ? "keine" : names(g.owners, 40)],
        ["Mitglieder" + (g.memberCount !== null ? ` (${g.memberCount})` : ""), g.memberCount === 0 ? "keine" : names(g.members.filter(m => !m.guest), 80) + (g.membersTruncated ? " (vollständig im CSV-Export)" : "")],
        g.guestCount ? [`davon Gäste (${g.guestCount})`, g.guests.slice(0, 60).map(x => x.upn && x.upn !== x.name ? `${x.name} (${x.upn})` : x.name).join(", ") + (g.guestCount > 60 ? ` … +${g.guestCount - 60}` : "")] : null,
        ["Speicher", s.storageUsed === null ? "—" : `${bytes(s.storageUsed)}${s.storageAllocated ? " von " + bytes(s.storageAllocated) : ""}`],
        s.lastActivity || s.fileCount !== null ? ["Nutzung", [s.lastActivity ? "letzte Aktivität " + day(s.lastActivity) : null, s.fileCount !== null ? pl(s.fileCount, "Datei", "Dateien") : null].filter(Boolean).join(" · ")] : null,
        ["Freigabestufe der Site", "nicht über Graph verfügbar"],
        g.error && ["Nicht lesbar", g.error, { tone: "warn" }]
      ].filter(Boolean));
    }
  }

  const other = content.filter(s => !s.group);
  if (other.length) {
    b.h2("Sites ohne Microsoft-365-Gruppe");
    b.small("Besitzer und Mitglieder dieser Sites (Websitesammlungsadministratoren, SharePoint-Gruppen) sind nicht über Graph verfügbar. Der primäre Besitzer stammt, wo vorhanden, aus dem Nutzungsbericht.");
    b.doc.moveDown(0.2);
    b.table([{ label: "Site", w: 0.24 }, { label: "Art / Vorlage", w: 0.23 }, { label: "Primärer Besitzer", w: 0.19 }, { label: "Erstellt", w: 0.115 }, { label: "Geändert", w: 0.115 }, { label: "Aktivität", w: 0.11 }],
      other.map(s => [{ text: s.name + "\n" + s.path, bold: true }, kindCell(s) + (s.template ? `\nVorlage ${s.template}` : ""),
        s.reportOwner ? (s.reportOwner.name || s.reportOwner.upn) : { text: "nicht über Graph verfügbar", tone: "muted" },
        s.created ? fmtDate(s.created) : "—", s.modified ? fmtDate(s.modified) : "—", day(s.lastActivity)]), { size: 7.3 });
  }

  // ---------------------------------------------------------------- OneDrive
  const od = sp.oneDrive;
  b.h2("OneDrive");
  const quota = sp.settings && sp.settings.raw ? sp.settings.raw.personalSiteDefaultStorageLimitInMB : null;
  b.body(`${pl(S.oneDrives, "OneDrive-Konto", "OneDrive-Konten")}, zusammen ${bytes(S.oneDriveStorage)} belegt` +
    (quota ? `; Standardkontingent ${bytes(quota * 1024 * 1024)}` : "") +
    (S.oneDriveActive !== null && S.oneDriveActive !== undefined ? `. Im Nutzungsbericht ${S.oneDriveActive} von ${od.report.rows} Konten mit Aktivität in den letzten ${sp.periodDays} Tagen.` : "."));
  if (R.concealed) b.small("Letzte Aktivität je Konto: nicht zuordenbar, weil die Nutzungsberichte anonymisiert sind (siehe oben).");
  if (od.accounts.length) {
    const rows = od.accounts.slice(0, 400);
    b.table([{ label: "Konto", w: 0.22 }, { label: "Anmeldename", w: 0.3 }, { label: "Belegt", w: 0.11 }, { label: "Kontingent", w: 0.11 }, { label: "Aktivität", w: 0.13 }, { label: "Status", w: 0.13 }],
      rows.map(a => [{ text: a.name, bold: true }, a.upn || "—", bytes(a.storageUsed), bytes(a.storageAllocated),
        a.lastActivity ? day(a.lastActivity) : R.concealed ? { text: "anonymisiert", tone: "muted" } : "—",
        a.enabled === false ? { text: "deaktiviert", pill: "muted" } : a.enabled ? "aktiv" : "—"]), { size: 7.3 });
    if (od.accounts.length > rows.length) b.small(`… und ${od.accounts.length - rows.length} weitere OneDrives (vollständig im CSV-Export).`);
  }
}

/** Anhang mit den bewertenden Hinweisen (entfällt ohne Anhang). */
function renderHints(b, sp) {
  const hints = sp.hints || [];
  if (!hints.length) return;
  b.h1("Hinweise zu SharePoint und OneDrive", { appendix: true });
  b.body("Punkte, die bei der Durchsicht der Erhebung auffallen. Sie beschreiben den Stand zum Zeitpunkt der Erhebung und sind als Hinweise zu verstehen, nicht als Mängelliste.");
  b.doc.moveDown(0.3);
  for (const h of hints) b.bullet(h.text, SEV_TONE[h.severity]);
}

/** Beiträge zum Anhang "Erhebung und Grenzen". */
function methodBullets(sp) {
  const R = sp.reports || {};
  const out = [
    `SharePoint: Sites aus ${sp.sitesSource === "search" ? "der Suche (/sites?search=*, ohne OneDrives)" : "/sites/getAllSites"}; gruppenverbundene Sites über die zugehörige Microsoft-365-Gruppe zugeordnet (nicht über den Namen), deren Besitzer, Mitglieder und Sichtbarkeit aus Entra ID. Die Art von Sites ohne Gruppe stammt aus der Vorlage im Nutzungsbericht.`,
    `Speicher und letzte Aktivität aus dem Nutzungsbericht (${sp.periodDays} Tage); für Sites, die der Bericht noch nicht kennt, der Speicher der Standard-Dokumentbibliothek. Der Bericht läuft Microsoft-seitig einige Tage hinterher.`
  ];
  if (R.concealed) out.push(`Nutzungsberichte anonymisiert${R.concealedSetting === true ? " (laut Berichtseinstellung)" : R.concealedDetected ? " (an den Daten erkannt)" : ""}: ${R.siteRowsJoined} von ${sp.sites.length} Sites über die Site-Id zugeordnet; OneDrive-Aktivität je Konto nicht zuordenbar.`);
  return out;
}

module.exports = { renderChapter, renderHints, methodBullets, coverTile, overviewLine, bytes };
