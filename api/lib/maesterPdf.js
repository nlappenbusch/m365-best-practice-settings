"use strict";
/**
 * Kundenfaehiger PDF-Report fuer ein Maester-Security-Audit — serverseitig mit
 * pdfkit erzeugt. Deutsch, Schweizer Schreibweise, igeeks-CI.
 *
 * Gestaltungsregeln (Nils, 26.08.2026 — verbindlich):
 *  - igeeks-Petrol #0081ad als Akzent (von igeeks.ch verifiziert), NICHT das
 *    Frontend-Blau des Tools.
 *  - KEINE Seitenumbrueche zwischen Abschnitten — der Inhalt fliesst durch,
 *    umgebrochen wird nur, wenn die Seite voll ist. (Deckblatt bleibt eigen.)
 *  - Keine Deko-Striche vor Ueberschriften; Struktur ueber fette, NUMMERIERTE
 *    Ueberschriften (1, 2, … / Findings 2.1, 2.2 …) und ruhige Abstaende.
 *
 * Findings nutzen die deutsche KI-Erklaerung (explain.json), wenn vorhanden —
 * sonst englische Testbeschreibung + Befund aus results.json (Markdown wird
 * fuer den Druck in Klartext gewandelt).
 */
const PDFDocument = require("pdfkit");

const ACCENT = "#0081ad"; // igeeks-Petrol
const COL = {
  text: "#373737",
  muted: "#707070",
  line: "#dfe4e8",
  crit: "#b3261e",
  high: "#c2410c",
  medium: "#b45309",
  low: "#4d7c0f",
  info: "#707070",
  ok: "#2e7d32"
};

const SEV_LABEL = { critical: "Kritisch", high: "Hoch", medium: "Mittel", low: "Niedrig", info: "Info" };
const SEV_COLOR = { critical: COL.crit, high: COL.high, medium: COL.medium, low: COL.low, info: COL.info };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const sevKey = (s) => String(s || "").toLowerCase();
const sevRank = (s) => SEV_ORDER[sevKey(s)] ?? 5;

// Skip-Gruende -> deutsche Gruppenueberschriften fuer den Kundenreport.
function skipReasonLabel(reason) {
  const r = String(reason || "").trim();
  const map = {
    NotLicensedEntraIDP2: "Lizenz erforderlich: Microsoft Entra ID P2",
    NotLicensedEntraIDP2OrGovernance: "Lizenz erforderlich: Entra ID P2 oder ID Governance",
    NotLicensedEntraIDGovernance: "Lizenz erforderlich: Microsoft Entra ID Governance",
    NotLicensedCustomerLockbox: "Lizenz erforderlich: Customer Lockbox (Microsoft 365 E5)",
    NotConnectedSecurityCompliance: "Security-&-Compliance-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedExchange: "Exchange-Online-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedTeams: "Teams-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedSharePoint: "SharePoint-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedAzure: "Kein Azure-Log-Export eingerichtet (Sentinel/SIEM) — Prüfung nicht anwendbar",
    NotConnectedGitHub: "Nicht zutreffend (GitHub-spezifische Tests)",
    NotDotGovDomain: "Nicht zutreffend (nur für US-Behörden relevant)",
    Custom: "Manuelle Prüfung erforderlich (nicht automatisiert bewertbar)"
  };
  if (map[r]) return map[r];
  if (/^NotLicensed/i.test(r)) return "Lizenz erforderlich: " + r.replace(/^NotLicensed/i, "");
  if (/^NotConnected/i.test(r)) return "Verbindung nicht verfügbar: " + r.replace(/^NotConnected/i, "");
  return r || "Ohne Grundangabe";
}

// Die Standard-PDF-Fonts (WinAnsi) koennen keine Emoji — Maesters Ergebnis-
// tabellen sind aber voll davon (✅/❌/⏭️). Ohne Mapping wird daraus
// Zeichensalat wie "Ø=ÝÄ". Also: bekannte Symbole in Woerter uebersetzen,
// alles andere ausserhalb von Latin-1 (+ ein paar WinAnsi-Sonderzeichen)
// verwerfen.
const EMOJI_MAP = [
  // Maester schreibt Status als "❌ Fail"/"✅ Pass" — Emoji ersatzlos streichen,
  // das Wort daneben traegt die Information (sonst steht "Fail Fail" im PDF).
  [/(✅|✔️|✔|❌|✖️|✖|❎|⏭️|⏭|⏩)\s*(?=[A-Za-z])/g, ""],
  [/✅|✔️|✔|🟢/g, "OK"],
  [/❌|✖️|✖|❎|🔴/g, "Fail"],
  [/⏭️|⏭|⏩/g, "Skip"],
  [/(⚠️|⚠)\s*(?=[A-Za-z])/g, ""],
  [/⚠️|⚠|🟡|🟠/g, "Achtung:"],
  [/(ℹ️|ℹ)\s*(?=[A-Za-z])/g, ""],
  [/ℹ️|ℹ/g, "Info:"],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ""]
];
function sanitizePdf(s) {
  let out = String(s == null ? "" : s);
  for (const [re, rep] of EMOJI_MAP) out = out.replace(re, rep);
  // WinAnsi-vertraeglich halten: Latin-1 plus die gaengigen Satzzeichen.
  return out.replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF€–—‘’‚“”„…·]/g, "").replace(/[ \t]+/g, " ");
}

// Maester-Markdown strukturiert ins PDF rendern: Ueberschriften fett,
// |Tabellen| als lesbare Zeilen, [Links](url) als klickbare Links in Akzent-
// farbe, Codefences als eingerueckter Text. Kein addPage zwischen Bloecken.
function renderMdBlock(ctx, md) {
  const { doc, x, width, ensureSpace } = ctx;
  const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

  const inlinePlain = (s) => sanitizePdf(
    // Markdown-Links auf den Linktext reduzieren (wichtig fuer Tabellenzellen —
    // dort stand sonst rohes [Sms](https://…)), Bold-/Code-Marker entfernen,
    // auch einzeln uebrig gebliebene **.
    String(s)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*\*/g, "")
      .replace(/`([^`]+)`/g, "$1")
  );

  // Eine Zeile mit moeglichen Links ausgeben. pdfkit setzt Link-Annotationen
  // bei zusammengesetzten continued-Textlaeufen daneben (Farbe sichtbar, aber
  // nicht klickbar — real passiert). Deshalb: besteht die Zeile im Kern aus
  // EINEM Link, wird sie als einzelner text()-Aufruf mit link-Option gesetzt
  // (zuverlaessig klickbar, auch ueber Zeilenumbrueche). Links mitten im Satz
  // bleiben farbig im Text, die klickbare URL folgt als eigene Zeile darunter.
  const writeLine = (line, opts) => {
    ensureSpace(16);
    const o = { size: 9.5, color: COL.text, prefix: "", bold: false, ...(opts || {}) };
    const links = [];
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(line)) !== null) links.push({ text: m[1], url: m[2] });

    doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size);

    // Zeile = genau ein Link (plus hoechstens Satzzeichen drumherum)?
    const stripped = line.replace(LINK_RE, "").replace(/[\s*.,;:()–-]+/g, "");
    if (links.length === 1 && stripped === "") {
      // EIN text()-Aufruf inkl. Prefix — kein continued, sonst sitzt die
      // Link-Annotation daneben und die Positionsrechnung kippt (verursachte
      // real unklickbare Links und einen Umbruch mitten im Finding).
      doc.fillColor(ACCENT).text(o.prefix + inlinePlain(links[0].text), x, doc.y, {
        width, underline: true, link: links[0].url, lineGap: 1.5
      });
      doc.x = x;
      return;
    }

    // Gemischte Zeile: Linktexte farbig im Fliesstext, URLs separat klickbar.
    const flat = inlinePlain(line.replace(LINK_RE, "$1"));
    if (flat) {
      doc.fillColor(o.color).text(o.prefix + flat, x, doc.y, { width, lineGap: 1.5, link: null, underline: false });
      doc.x = x;
    }
    for (const l of links) {
      ensureSpace(14);
      const shortUrl = l.url.replace(/^https?:\/\//, "").slice(0, 90);
      doc.font("Helvetica").fontSize(8.5).fillColor(ACCENT).text("↗ " + shortUrl, x + 12, doc.y, {
        width: width - 12, underline: true, link: l.url, lineGap: 1
      });
      doc.x = x;
    }
  };

  const lines = String(md == null ? "" : md).replace(/\r\n/g, "\n").replace(/```[a-zA-Z]*\n?/g, "").split("\n");
  let table = null;
  const flushTable = () => {
    if (!table) return;
    const rows = table
      .filter(r => !/^[\s|:-]+$/.test(r))
      .map(r => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => inlinePlain(c.trim())));
    const head = rows[0] || [];
    for (const row of rows.slice(1)) {
      ensureSpace(16);
      const partsTxt = row.map((c, ci) => (ci && head[ci] && c) ? `${head[ci]}: ${c}` : c).filter(Boolean).join("   ·   ");
      doc.font("Helvetica").fontSize(9).fillColor(COL.text).text("–  " + partsTxt, x + 6, doc.y, { width: width - 6, lineGap: 1 });
    }
    doc.x = x;
    table = null;
  };

  let rendered = 0;
  for (const raw of lines) {
    if (rendered > 60) break; // Ausufernde Befunde kappen — Details stehen im HTML-Report
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) { (table ??= []).push(line); continue; }
    flushTable();
    if (line.trim() === "") { doc.moveDown(0.18); continue; }
    rendered++;
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { doc.moveDown(0.2); writeLine(m[1], { bold: true }); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { writeLine(m[1], { prefix: "–  " }); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { writeLine(m[1], { color: COL.muted }); continue; }
    writeLine(line);
  }
  flushTable();
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}

function buildPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 66, bottom: 74, left: 62, right: 62 }, bufferPages: true });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const pageW = doc.page.width;

    const ensureSpace = (needed) => {
      if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
    };

    // Kapitelzaehler — Nummern werden fortlaufend vergeben, je nachdem welche
    // Abschnitte der Report enthaelt.
    let chapter = 0;
    const h1 = (title) => {
      chapter += 1;
      ensureSpace(120); // Ueberschrift nie verwaist am Seitenende
      if (chapter > 1) doc.moveDown(1.6);
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(16).fillColor(ACCENT).text(String(chapter), left, y, { continued: false, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(16).fillColor(COL.text).text(title, left + 24, y, { width: W - 24 });
      doc.moveTo(left, doc.y + 5).lineTo(left + W, doc.y + 5).lineWidth(0.6).strokeColor(COL.line).stroke();
      doc.y += 14;
      doc.x = left;
      return chapter;
    };
    const h2 = (t) => {
      ensureSpace(52);
      doc.moveDown(0.9);
      doc.font("Helvetica-Bold").fontSize(11.5).fillColor(COL.text).text(t, left);
      doc.moveDown(0.3);
    };
    const body = (t, opts) => doc.font("Helvetica").fontSize(10).fillColor(COL.text).text(t, { width: W, lineGap: 1.5, ...opts });
    const small = (t, opts) => doc.font("Helvetica").fontSize(8.5).fillColor(COL.muted).text(t, { width: W, lineGap: 1, ...opts });

    const c = data.counts || {};
    const rated = (c.passed || 0) + (c.failed || 0);
    const findings = [...(data.findings || [])].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    const skipped = data.skipped || [];

    // ================= Deckblatt =================
    doc.rect(0, 0, pageW, 14).fill(ACCENT);
    doc.font("Helvetica-Bold").fontSize(12).fillColor(ACCENT).text("igeeks AG", left, 60);
    doc.font("Helvetica").fontSize(9.5).fillColor(COL.muted).text("Microsoft-365- und Security-Consulting", left);

    doc.y = 255;
    doc.font("Helvetica-Bold").fontSize(31).fillColor(COL.text).text("Microsoft 365", left);
    doc.font("Helvetica-Bold").fontSize(31).fillColor(ACCENT).text("Security-Audit", left);
    doc.moveDown(1.1);
    doc.font("Helvetica-Bold").fontSize(17).fillColor(COL.text).text(data.tenantName || "—", left);
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10.5).fillColor(COL.muted)
      .text((data.organization ? data.organization + "\n" : "") + "Prüfdatum: " + fmtDate(data.generatedAt), left, doc.y, { lineGap: 2 });

    doc.font("Helvetica").fontSize(9).fillColor(COL.muted)
      .text("Vertraulich — nur für den Empfänger bestimmt.", left, doc.page.height - 118, { lineGap: 2 });
    doc.font("Helvetica").fontSize(9).fillColor(COL.muted)
      .text("Automatisiertes Security-Audit auf Basis öffentlicher Sicherheitsbaselines.", left);

    // ================= Inhalt (durchgehend, KEINE Umbrueche zwischen Abschnitten) =================
    doc.addPage();

    // ---- 1 Management-Zusammenfassung ----
    h1("Management-Zusammenfassung");

    const scoreColor = data.score == null ? COL.muted : data.score >= 80 ? COL.ok : data.score >= 60 ? COL.medium : COL.crit;
    const boxY = doc.y + 2;
    const boxH = 78;
    doc.roundedRect(left, boxY, W, boxH, 5).lineWidth(0.8).strokeColor(COL.line).stroke();
    const cells = [
      { label: "Security-Score", value: data.score == null ? "—" : data.score + "%", color: scoreColor },
      { label: "Bestanden", value: String(c.passed ?? "—"), color: COL.ok },
      { label: "Handlungsbedarf", value: String(c.failed ?? "—"), color: (c.failed || 0) > 0 ? COL.crit : COL.ok },
      { label: "Nicht bewertbar", value: String(c.skipped ?? 0), color: COL.muted }
    ];
    const cw = W / cells.length;
    cells.forEach((cell, i) => {
      if (i) doc.moveTo(left + i * cw, boxY + 14).lineTo(left + i * cw, boxY + boxH - 14).lineWidth(0.5).strokeColor(COL.line).stroke();
      doc.font("Helvetica-Bold").fontSize(21).fillColor(cell.color)
        .text(cell.value, left + i * cw, boxY + 16, { width: cw, align: "center", lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(COL.muted)
        .text(cell.label.toUpperCase(), left + i * cw, boxY + 50, { width: cw, align: "center", lineBreak: false, characterSpacing: 0.4 });
    });
    doc.x = left;
    doc.y = boxY + boxH + 10;
    small(`Der Score setzt bestandene Tests ins Verhältnis zu allen bewerteten (${rated}). ` +
      `Nicht bewertbare Tests (fehlende Lizenz, nicht zutreffende Konfiguration) fliessen nicht ein.`);

    // Schweregrad-Verteilung als Balken
    const bySev = {};
    for (const f of findings) { const k = sevKey(f.severity) || "info"; bySev[k] = (bySev[k] || 0) + 1; }
    const sevKeys = Object.keys(bySev).sort((a, b) => sevRank(a) - sevRank(b));
    if (sevKeys.length) {
      h2("Handlungsbedarf nach Schweregrad");
      const maxCount = Math.max(...sevKeys.map(k => bySev[k]));
      const barMax = W - 175;
      for (const k of sevKeys) {
        ensureSpace(24);
        const y = doc.y;
        doc.font("Helvetica").fontSize(9.5).fillColor(COL.text)
          .text(SEV_LABEL[k] || k || "Ohne Angabe", left, y + 1, { width: 92, lineBreak: false });
        const w = Math.max(8, (bySev[k] / maxCount) * barMax);
        doc.roundedRect(left + 100, y, w, 11, 3).fill(SEV_COLOR[k] || COL.muted);
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COL.text)
          .text(String(bySev[k]), left + 106 + w, y + 1, { lineBreak: false });
        doc.y = y + 19;
        doc.x = left;
      }
    }

    h2("Einordnung");
    const critHigh = findings.filter(f => ["critical", "high"].includes(sevKey(f.severity))).length;
    body(
      `Von ${rated} bewerteten Tests wurden ${c.passed ?? 0} bestanden. ` +
      `${findings.length} Punkte erfordern Handlungsbedarf` +
      (critHigh ? `, davon ${critHigh} mit hoher oder kritischer Einstufung — diese sollten priorisiert angegangen werden.` : ".") +
      (c.skipped ? ` ${c.skipped} Tests waren im Tenant nicht bewertbar (Details am Ende des Berichts).` : "")
    );
    if (findings.length) {
      h2("Empfohlene Prioritäten");
      findings.slice(0, 5).forEach((f, i) => {
        ensureSpace(24);
        doc.font("Helvetica").fontSize(10).fillColor(COL.text)
          .text(`${i + 1}.  ${sanitizePdf(f.titel || f.title || f.id)}`, left + 6, doc.y, { width: W - 12, lineGap: 1 });
        doc.y += 2;
        doc.x = left;
      });
      if (findings.length > 5) small(`… und ${findings.length - 5} weitere Punkte im Detailteil.`);
    }

    // ---- 2 Handlungsbedarf im Detail ----
    const findingsChapter = h1("Handlungsbedarf im Detail" + (findings.length ? ` (${findings.length})` : ""));
    if (!findings.length) body("Keine Beanstandungen — alle bewerteten Tests wurden bestanden.");

    findings.forEach((f, i) => {
      ensureSpace(100);
      const k = sevKey(f.severity);
      if (i) doc.moveDown(0.9);
      const numStr = `${findingsChapter}.${i + 1}`;
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(11).fillColor(ACCENT).text(numStr, left, y, { lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COL.text)
        .text(sanitizePdf(f.titel || f.title || f.id), left + 30, y, { width: W - 30, lineGap: 1 });
      const tags = [`Schweregrad: ${SEV_LABEL[k] || f.severity || "ohne Angabe"}`];
      if (f.aufwand) tags.push(`Aufwand: ${f.aufwand}`);
      if (f.block) tags.push(String(f.block).slice(0, 70));
      doc.font("Helvetica").fontSize(8.5).fillColor(SEV_COLOR[k] || COL.muted).text(tags.join("    ·    "), left + 30, doc.y + 1, { width: W - 30 });
      doc.moveDown(0.35);
      doc.x = left;

      const indent = { width: W - 30 };
      const at = (fn) => { const keepX = doc.x; doc.x = left + 30; fn(); doc.x = keepX; };
      const mdCtx = { doc, x: left + 30, width: W - 30, ensureSpace };
      if (f.bedeutung) {
        at(() => body(sanitizePdf(f.bedeutung), indent));
      } else if (f.description) {
        renderMdBlock(mdCtx, f.description);
        doc.x = left;
      }
      if (!f.bedeutung && f.result) {
        doc.moveDown(0.25);
        at(() => doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COL.text).text("Befund im Tenant:", indent));
        renderMdBlock(mdCtx, f.result);
        doc.x = left;
      }
      if (Array.isArray(f.umsetzung) && f.umsetzung.length) {
        doc.moveDown(0.25);
        at(() => doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COL.text).text("Empfohlene Umsetzung:", indent));
        f.umsetzung.forEach((s, kk) => {
          ensureSpace(24);
          doc.font("Helvetica").fontSize(9.5).fillColor(COL.text)
            .text(`${kk + 1}. ${s}`, left + 42, doc.y, { width: W - 42, lineGap: 1 });
        });
        doc.x = left;
      }
      if (f.helpUrl) {
        doc.moveDown(0.15);
        at(() => small("Referenz: " + f.helpUrl, indent));
      }
    });

    // ---- 3 Domain-Authentifizierung (falls erhoben) ----
    const da = data.domainAuth || null;
    if (da && da.length) {
      h1("Domain-Authentifizierung (SPF · DKIM · DMARC)");
      body("Ergänzend zur Maester-Testsuite wird die E-Mail-Authentifizierung jeder Maildomain direkt geprüft — " +
        "die Konfiguration in Exchange Online und die tatsächlich im öffentlichen DNS veröffentlichten Records " +
        "zusammen. Damit sind auch die Punkte abgedeckt, die Maester nur manuell prüfen kann.");
      const STAT = {
        ok: { label: "OK", color: COL.ok },
        warn: { label: "Warnung", color: COL.medium },
        bad: { label: "Problem", color: COL.crit }
      };
      const stat = (o) => STAT[(o || {}).status] || STAT.warn;

      // Saubere Statustabelle: Domains als Zeilen, ein farbiger Status je
      // Pruefung. Die Begruendungen folgen kompakt darunter — in der Zelle
      // wuerden sie die Tabelle sprengen.
      const cols = [
        { label: "Domain", w: Math.round(W * 0.40) },
        { label: "SPF", w: Math.round(W * 0.20) },
        { label: "DKIM", w: Math.round(W * 0.20) },
        { label: "DMARC", w: Math.round(W * 0.20) }
      ];
      const colX = [left, left + cols[0].w, left + cols[0].w + cols[1].w, left + cols[0].w + cols[1].w + cols[2].w];

      doc.moveDown(0.5);
      ensureSpace(60);
      const headY = doc.y;
      doc.rect(left, headY - 3, W, 18).fill("#f0f4f6");
      cols.forEach((c, i) => {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(COL.muted)
          .text(c.label.toUpperCase(), colX[i] + 6, headY + 1, { width: c.w - 12, lineBreak: false, characterSpacing: 0.3 });
      });
      doc.y = headY + 17;
      for (const d of da) {
        ensureSpace(20);
        const y = doc.y;
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COL.text)
          .text(d.domain, colX[0] + 6, y + 2, { width: cols[0].w - 12, lineBreak: false });
        [d.spf, d.dkim, d.dmarc].forEach((o, i) => {
          const s = stat(o);
          doc.font("Helvetica-Bold").fontSize(9.5).fillColor(s.color)
            .text(s.label, colX[i + 1] + 6, y + 2, { width: cols[i + 1].w - 12, lineBreak: false });
        });
        doc.y = y + 17;
        doc.moveTo(left, doc.y - 1).lineTo(left + W, doc.y - 1).lineWidth(0.4).strokeColor(COL.line).stroke();
      }
      doc.x = left;

      // Begruendungen nur fuer Auffaelliges — OK braucht keine Fussnote.
      const issues = [];
      for (const d of da) {
        for (const [name, o] of [["SPF", d.spf], ["DKIM", d.dkim], ["DMARC", d.dmarc]]) {
          if (o && o.status !== "ok" && o.issues && o.issues.length) {
            issues.push({ domain: d.domain, name, text: o.issues[0] });
          }
        }
      }
      if (issues.length) {
        doc.moveDown(0.5);
        issues.forEach(it => {
          ensureSpace(16);
          doc.font("Helvetica").fontSize(8.5).fillColor(COL.muted)
            .text(`${it.domain} · ${it.name}: ${sanitizePdf(it.text)}`, left + 6, doc.y, { width: W - 12, lineGap: 1 });
          doc.x = left;
        });
      }
    }

    // ---- 4 Nicht bewertbare Tests ----
    if (skipped.length) {
      h1(`Nicht bewertbare Tests (${skipped.length})`);
      body("Diese Tests konnten im Tenant nicht bewertet werden — üblicherweise, weil das geprüfte Produkt " +
        "nicht lizenziert ist, die Prüfung nicht zutrifft oder eine Dienstverbindung beim Lauf nicht zur " +
        "Verfügung stand. Sie sind keine Mängel. Lizenzabhängige Punkte können als Ausbau-Empfehlung " +
        "verstanden werden.");
      const groups = new Map();
      for (const s of skipped) {
        const label = skipReasonLabel(s.reason);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(s);
      }
      for (const [label, items] of groups) {
        h2(`${label} (${items.length})`);
        items.slice(0, 25).forEach(s => {
          ensureSpace(18);
          doc.font("Helvetica").fontSize(9).fillColor(COL.muted).text("–  " + sanitizePdf(s.title || s.id), left + 6, doc.y, { width: W - 12, lineGap: 1 });
          doc.x = left;
        });
        if (items.length > 25) small(`… und ${items.length - 25} weitere.`);
      }
    }

    // ---- 5 Methodik ----
    h1("Methodik");
    const suitesTxt = (data.suites && data.suites.length)
      ? data.suites.join(", ")
      : "alle Suiten (CISA SCuBA, CIS Microsoft 365, EIDSCA, ORCA, Maester Community)";
    body(
      "Die Prüfung erfolgte automatisiert mit dem Open-Source-Framework Maester (maester.dev)" +
      (data.maesterVersion ? `, Version ${data.maesterVersion}` : "") + ". " +
      `Ausgeführte Testsuiten: ${suitesTxt}. ` +
      "Alle Zugriffe erfolgten ausschliesslich lesend über eine dedizierte, zertifikatsbasierte Anwendung — " +
      "am Tenant wurde nichts verändert."
    );
    doc.moveDown(0.5);
    body(
      "Die Tests basieren auf öffentlichen Sicherheitsbaselines, unter anderem CISA SCuBA (Secure Cloud " +
      "Business Applications der US-Cybersicherheitsbehörde), dem CIS Microsoft 365 Foundations Benchmark " +
      "und dem Entra ID Security Config Analyzer (EIDSCA). Die Testsuiten werden laufend aktualisiert; eine " +
      "Wiederholungsprüfung nach Umsetzung der Massnahmen wird empfohlen."
    );
    // ---- 6 Naechste Schritte (CTA + Einordnung) ----
    // CTA-Box im igeeks-Look: heller Petrol-Grund, Akzentbalken links.
    const ctaTitle = "Lassen Sie uns den Report gemeinsam anschauen";
    const ctaText =
      "Wir empfehlen, die Ergebnisse dieses Audits in einem gemeinsamen Termin im Detail zu besprechen: " +
      "die Befunde für Ihre Umgebung einordnen, Prioritäten festlegen und daraus konkrete, aufeinander " +
      "abgestimmte Massnahmen ableiten — inklusive Aufwandsschätzung und Umsetzungsplanung durch igeeks. " +
      "Melden Sie sich dazu einfach bei Ihrem igeeks-Ansprechpartner — wir bereiten den Termin auf Basis " +
      "dieses Reports vor.";
    const pad = 16;
    doc.font("Helvetica-Bold").fontSize(12);
    const titleH = doc.heightOfString(ctaTitle, { width: W - pad * 2 - 6 });
    doc.font("Helvetica").fontSize(10);
    const textH = doc.heightOfString(ctaText, { width: W - pad * 2 - 6, lineGap: 1.5 });
    const ctaBoxH = pad * 2 + titleH + 8 + textH;
    // Ueberschrift und Box zusammenhalten: erst Platz fuer beides sichern,
    // DANN die Kapitelueberschrift setzen — sonst bleibt "6 Naechste Schritte"
    // verwaist am Seitenende stehen.
    ensureSpace(ctaBoxH + 90);
    h1("Nächste Schritte");
    const ctaY = doc.y + 4;
    doc.roundedRect(left, ctaY, W, ctaBoxH, 6).fill("#e9f4f8");
    doc.rect(left, ctaY, 4, ctaBoxH).fill(ACCENT);
    doc.font("Helvetica-Bold").fontSize(12).fillColor(ACCENT)
      .text(ctaTitle, left + pad + 6, ctaY + pad, { width: W - pad * 2 - 6 });
    doc.font("Helvetica").fontSize(10).fillColor(COL.text)
      .text(ctaText, left + pad + 6, ctaY + pad + titleH + 8, { width: W - pad * 2 - 6, lineGap: 1.5 });
    doc.x = left;
    doc.y = ctaY + ctaBoxH + 14;

    h2("Wichtig zur Einordnung der Ergebnisse");
    body(
      "Dieser Report wurde automatisiert nach technisch festgelegten Prüfmechanismen erstellt. In Ihrer " +
      "Umgebung können bewusst gewählte Richtlinien gelten, die von den Standard-Baselines abweichen und " +
      "von der automatischen Prüfung nicht als solche erkannt werden. Der Report zeigt deshalb eine Tendenz " +
      "und potenzielle Verbesserungsmassnahmen auf — ein als «Handlungsbedarf» markierter Punkt ist nicht " +
      "zwingend ein tatsächliches Problem. Die verbindliche Beurteilung erfolgt in der gemeinsamen " +
      "Detailbetrachtung; eingreifende Änderungen setzen wir grundsätzlich erst nach Absprache um " +
      "(Pilotgruppe bzw. Report-only zuerst)."
    );

    // ================= Fusszeilen (ab Seite 2) =================
    const range = doc.bufferedPageRange();
    for (let p = range.start + 1; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      const keepBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(left, doc.page.height - 52).lineTo(left + W, doc.page.height - 52).lineWidth(0.5).strokeColor(COL.line).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(COL.muted).text(
        `igeeks AG · Security-Audit ${data.tenantName || ""} · ${fmtDate(data.generatedAt)}`,
        left, doc.page.height - 44, { width: W - 80, align: "left", lineBreak: false }
      );
      doc.font("Helvetica").fontSize(8).fillColor(COL.muted).text(
        `Seite ${p} von ${range.count - 1}`,
        left + W - 80, doc.page.height - 44, { width: 80, align: "right", lineBreak: false }
      );
      doc.page.margins.bottom = keepBottom;
    }
    doc.end();
  });
}

module.exports = { buildPdf };
