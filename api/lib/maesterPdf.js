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

// Maesters Markdown-Texte fuer den Druck in lesbaren Klartext wandeln.
function mdToPlain(s, cap) {
  const out = String(s == null ? "" : s)
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|[\s:|-]+\|\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cap ? out.slice(0, cap) : out;
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
          .text(`${i + 1}.  ${f.titel || f.title || f.id}`, left + 6, doc.y, { width: W - 12, lineGap: 1 });
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
        .text(f.titel || f.title || f.id, left + 30, y, { width: W - 30, lineGap: 1 });
      const tags = [`Schweregrad: ${SEV_LABEL[k] || f.severity || "ohne Angabe"}`];
      if (f.aufwand) tags.push(`Aufwand: ${f.aufwand}`);
      if (f.block) tags.push(String(f.block).slice(0, 70));
      doc.font("Helvetica").fontSize(8.5).fillColor(SEV_COLOR[k] || COL.muted).text(tags.join("    ·    "), left + 30, doc.y + 1, { width: W - 30 });
      doc.moveDown(0.35);
      doc.x = left;

      const indent = { width: W - 30 };
      const at = (fn) => { const keepX = doc.x; doc.x = left + 30; fn(); doc.x = keepX; };
      if (f.bedeutung) {
        at(() => body(f.bedeutung, indent));
      } else if (f.description) {
        at(() => doc.font("Helvetica").fontSize(9.5).fillColor(COL.text).text(mdToPlain(f.description, 900), { ...indent, lineGap: 1.5 }));
      }
      if (!f.bedeutung && f.result) {
        doc.moveDown(0.25);
        at(() => {
          doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COL.text).text("Befund im Tenant:", indent);
          doc.font("Helvetica").fontSize(9.5).fillColor(COL.text).text(mdToPlain(f.result, 700), { ...indent, lineGap: 1.5 });
        });
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
      const daLine = (name, st, extra) => {
        const s = STAT[st.status] || STAT.warn;
        ensureSpace(20);
        const y = doc.y;
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COL.text).text(name, left + 10, y, { width: 52, lineBreak: false });
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(s.color).text(s.label, left + 66, y, { width: 58, lineBreak: false });
        const detail = (st.issues && st.issues[0]) || extra || "";
        doc.font("Helvetica").fontSize(9).fillColor(COL.muted).text(detail, left + 130, y, { width: W - 130, lineGap: 1 });
        if (doc.y < y + 13) doc.y = y + 13;
        doc.x = left;
      };
      for (const d of da) {
        ensureSpace(76);
        doc.moveDown(0.7);
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COL.text).text(d.domain, left);
        doc.moveDown(0.2);
        daLine("SPF", d.spf || { status: "warn" }, d.spf && d.spf.record ? "Record vorhanden." : "");
        daLine("DKIM", d.dkim || { status: "warn" }, d.dkim && d.dkim.status === "ok" ? "Aktiviert und DNS-Records veröffentlicht." : "");
        daLine("DMARC", d.dmarc || { status: "warn" }, d.dmarc && d.dmarc.policy ? "Policy: " + d.dmarc.policy : "");
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
          doc.font("Helvetica").fontSize(9).fillColor(COL.muted).text("–  " + (s.title || s.id), left + 6, doc.y, { width: W - 12, lineGap: 1 });
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
    doc.moveDown(0.5);
    small("Hinweis: Automatisierte Prüfungen ersetzen keine individuelle Risikobeurteilung. Die empfohlenen " +
      "Massnahmen sollten vor der Umsetzung auf betriebliche Auswirkungen geprüft werden (Pilotgruppe/Report-only zuerst).");

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
