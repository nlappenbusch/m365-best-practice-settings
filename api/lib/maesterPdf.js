"use strict";
/**
 * Kundenfaehiger PDF-Report fuer ein Maester-Security-Audit — serverseitig mit
 * pdfkit erzeugt (kein Browser-Druckdialog). Deutsch, Schweizer Schreibweise.
 *
 * Der Report ist bewusst kundentauglich gehalten: Kennzahlen, Findings mit
 * verstaendlicher Erklaerung und Umsetzungsschritten (aus explain.json, falls
 * vorhanden — sonst englischer Testtitel), uebersprungene Tests mit Grund,
 * Methodik. Interna (Job-Ids, Rohdaten, igeeks-interne Bewertungen) bleiben
 * draussen.
 */
const PDFDocument = require("pdfkit");

const COL = {
  text: "#1a2433",
  muted: "#5a6a7d",
  line: "#d7dee8",
  accent: "#0f6cbd",
  crit: "#b3261e",
  high: "#c2410c",
  medium: "#b45309",
  low: "#4d7c0f",
  ok: "#15803d"
};

const SEV_LABEL = { critical: "Kritisch", high: "Hoch", medium: "Mittel", low: "Niedrig", info: "Info" };
const SEV_COLOR = { critical: COL.crit, high: COL.high, medium: COL.medium, low: COL.low, info: COL.muted };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}

/**
 * @param {object} data { tenantName, organization, generatedAt, suites, counts, score,
 *                        maesterVersion, findings: [{id,title,severity,block,helpUrl,
 *                        titel?,bedeutung?,umsetzung?,aufwand?}], skipped: [{title,block,reason}] }
 * @returns {Promise<Buffer>}
 */
function buildPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 64, bottom: 72, left: 60, right: 60 }, bufferPages: true });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    const h2 = (t) => {
      ensureSpace(doc, 60);
      doc.moveDown(1.2);
      doc.font("Helvetica-Bold").fontSize(14).fillColor(COL.accent).text(t);
      doc.moveTo(left, doc.y + 2).lineTo(left + W, doc.y + 2).lineWidth(0.7).strokeColor(COL.line).stroke();
      doc.moveDown(0.6);
    };
    const body = (t, opts) => doc.font("Helvetica").fontSize(10).fillColor(COL.text).text(t, opts);
    const small = (t, opts) => doc.font("Helvetica").fontSize(8.5).fillColor(COL.muted).text(t, opts);

    // ---------- Kopf ----------
    doc.font("Helvetica").fontSize(9).fillColor(COL.muted).text("igeeks AG · Microsoft-365-Security", { align: "right" });
    doc.moveDown(1.5);
    doc.font("Helvetica-Bold").fontSize(24).fillColor(COL.text).text("Microsoft 365 Security-Audit");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(13).fillColor(COL.text).text(data.tenantName || "—");
    doc.font("Helvetica").fontSize(10).fillColor(COL.muted)
      .text((data.organization ? data.organization + " · " : "") + "Stand: " + fmtDate(data.generatedAt));
    doc.moveDown(1);

    // ---------- Kennzahlen ----------
    const c = data.counts || {};
    const rated = (c.passed || 0) + (c.failed || 0);
    const scoreColor = data.score == null ? COL.muted : data.score >= 80 ? COL.ok : data.score >= 60 ? COL.medium : COL.crit;
    const boxY = doc.y;
    const boxH = 74;
    doc.roundedRect(left, boxY, W, boxH, 6).lineWidth(0.8).strokeColor(COL.line).stroke();
    const cells = [
      { label: "Security-Score", value: data.score == null ? "—" : data.score + "%", color: scoreColor },
      { label: "Bestanden", value: String(c.passed ?? "—"), color: COL.ok },
      { label: "Handlungsbedarf", value: String(c.failed ?? "—"), color: (c.failed || 0) > 0 ? COL.crit : COL.ok },
      { label: "Nicht bewertbar", value: String((c.skipped || 0) + (c.other || 0)), color: COL.muted }
    ];
    const cw = W / cells.length;
    cells.forEach((cell, i) => {
      doc.font("Helvetica-Bold").fontSize(22).fillColor(cell.color)
        .text(cell.value, left + i * cw, boxY + 14, { width: cw, align: "center" });
      doc.font("Helvetica").fontSize(9).fillColor(COL.muted)
        .text(cell.label, left + i * cw, boxY + 46, { width: cw, align: "center" });
    });
    doc.x = left;
    doc.y = boxY + boxH + 6;
    small(`Der Score setzt bestandene Tests ins Verhältnis zu allen bewerteten (${rated}). ` +
      `Nicht bewertbare Tests (fehlende Lizenz, nicht zutreffende Konfiguration) fliessen nicht ein.`);

    // ---------- Findings ----------
    const findings = [...(data.findings || [])].sort((a, b) =>
      (SEV_ORDER[String(a.severity || "").toLowerCase()] ?? 5) - (SEV_ORDER[String(b.severity || "").toLowerCase()] ?? 5));

    h2("Festgestellter Handlungsbedarf" + (findings.length ? ` (${findings.length})` : ""));
    if (!findings.length) {
      body("Keine Beanstandungen — alle bewerteten Tests wurden bestanden.");
    }
    findings.forEach((f, i) => {
      ensureSpace(doc, 90);
      const sevKey = String(f.severity || "").toLowerCase();
      const sev = SEV_LABEL[sevKey] || (f.severity || "—");
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COL.text)
        .text(`${i + 1}. ${f.titel || f.title || f.id}`, { width: W });
      const tags = [`Schweregrad: ${sev}`];
      if (f.aufwand) tags.push(`Aufwand: ${f.aufwand}`);
      if (f.block) tags.push(String(f.block).slice(0, 60));
      doc.font("Helvetica").fontSize(8.5).fillColor(SEV_COLOR[sevKey] || COL.muted).text(tags.join("  ·  "));
      doc.moveDown(0.2);
      if (f.bedeutung) {
        body(f.bedeutung, { width: W });
        doc.moveDown(0.2);
      } else if (f.titel === undefined && f.title) {
        small("(Detailbeschreibung siehe Referenz unten — deutsche Erläuterung für diesen Punkt nicht erzeugt.)");
      }
      if (Array.isArray(f.umsetzung) && f.umsetzung.length) {
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COL.text).text("Empfohlene Umsetzung:");
        f.umsetzung.forEach((s, k) => {
          ensureSpace(doc, 26);
          doc.font("Helvetica").fontSize(9.5).fillColor(COL.text)
            .text(`${k + 1}. ${s}`, left + 12, doc.y, { width: W - 12 });
        });
        doc.x = left;
      }
      if (f.helpUrl) small("Referenz: " + f.helpUrl);
      doc.moveDown(0.3);
      doc.moveTo(left, doc.y).lineTo(left + W, doc.y).lineWidth(0.4).strokeColor(COL.line).stroke();
    });

    // ---------- Nicht bewertbare Tests ----------
    const skipped = data.skipped || [];
    if (skipped.length) {
      h2(`Nicht bewertbare Tests (${skipped.length})`);
      body("Diese Tests konnten im Tenant nicht bewertet werden — üblicherweise, weil das geprüfte Produkt " +
        "nicht lizenziert ist oder die Konfiguration nicht zutrifft. Sie sind keine Mängel.");
      doc.moveDown(0.4);
      skipped.slice(0, 40).forEach(s => {
        ensureSpace(doc, 24);
        doc.font("Helvetica").fontSize(9).fillColor(COL.text).text("•  " + (s.title || s.id), { width: W });
        if (s.reason) doc.font("Helvetica").fontSize(8.5).fillColor(COL.muted).text("    " + String(s.reason).slice(0, 200), { width: W });
      });
      if (skipped.length > 40) small(`… und ${skipped.length - 40} weitere.`);
    }

    // ---------- Methodik ----------
    h2("Methodik");
    const suitesTxt = (data.suites && data.suites.length)
      ? data.suites.join(", ")
      : "alle Suiten (CISA SCuBA, CIS Microsoft 365, EIDSCA, ORCA, Maester Community)";
    body(
      "Die Prüfung erfolgte automatisiert mit dem Open-Source-Framework Maester (maester.dev)" +
      (data.maesterVersion ? `, Version ${data.maesterVersion}` : "") + ". " +
      `Ausgeführte Testsuiten: ${suitesTxt}. ` +
      "Alle Zugriffe erfolgten ausschliesslich lesend über eine dedizierte, zertifikatsbasierte Anwendung — " +
      "am Tenant wurde nichts verändert. Die Tests basieren auf öffentlichen Sicherheitsbaselines " +
      "(u.a. CISA SCuBA, CIS Benchmark, Entra ID Security Config Analyzer) und werden laufend aktualisiert; " +
      "eine Wiederholungsprüfung nach Umsetzung der Massnahmen wird empfohlen."
    );

    // ---------- Fusszeile mit Seitenzahlen ----------
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      // Unterer Rand temporaer auf 0 — sonst legt pdfkit beim Schreiben in die
      // Fusszeilen-Zone eine neue (leere) Seite an.
      const keepBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8).fillColor(COL.muted).text(
        `igeeks AG · Security-Audit ${data.tenantName || ""} · ${fmtDate(data.generatedAt)} · Seite ${p + 1} von ${range.count}`,
        left, doc.page.height - 46, { width: W, align: "center", lineBreak: false }
      );
      doc.page.margins.bottom = keepBottom;
    }
    doc.end();
  });
}

/** Seitenumbruch von Hand, wenn der Block nicht mehr passt — pdfkit bricht sonst mitten im Element. */
function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

module.exports = { buildPdf };
