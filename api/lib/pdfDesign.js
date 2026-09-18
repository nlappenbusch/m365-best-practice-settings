"use strict";
/**
 * Gemeinsames Layout für die Dokumentations- und Nachweis-PDFs (pdfkit).
 *
 * igeeks-CI (verbindlich, siehe Maester-Report): Petrol #0081ad als Akzent, KEINE
 * Seitenumbrüche zwischen Abschnitten (nur Deckblatt und Inhaltsverzeichnis sind
 * eigene Seiten), nummerierte fette Überschriften ohne Deko-Striche davor.
 *
 * Bausteine: Deckblatt mit Titelblock und Kennzahlen, Inhaltsverzeichnis mit
 * Seitenzahlen, Kopfzeile mit dem laufenden Kapitel, Tabellen mit Zebrastreifen,
 * farbige Status-Pillen, Kennzahl-Kacheln, Info-Karten und Ketten-Diagramme
 * (z. B. App › App-Gruppe › Gerätegruppe).
 *
 * Verwendung: const b = create(meta); b.cover(); … b.h1()/table()/…; return b.finish();
 */
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const LOGO_PATH = path.join(__dirname, "..", "assets", "igeeks-logo.png");
const ACCENT = "#0081ad";
const C = {
  text: "#2f3437", muted: "#6b7680", faint: "#9aa4ad", line: "#e1e7eb", zebra: "#f6f9fb", head: "#e6f2f7",
  card: "#f4f8fa", accentDark: "#006a8f"
};
const TONES = {
  ok: { fg: "#2e7d32", bg: "#e7f4ea" },
  warn: { fg: "#a35200", bg: "#fdf0df" },
  crit: { fg: "#b3261e", bg: "#fbe8e6" },
  info: { fg: ACCENT, bg: "#e3f1f7" },
  muted: { fg: "#5f6b75", bg: "#eef1f3" }
};
const NODE = {
  app: { border: ACCENT, fill: "#e3f1f7" },
  dev: { border: "#2e7d32", fill: "#e9f5ec" },
  usr: { border: "#7b61ff", fill: "#f0edff" },
  bad: { border: "#b3261e", fill: "#fbe8e6" },
  plain: { border: "#c4ced6", fill: "#ffffff" }
};

// WinAnsi-verträglich: Latin-1 plus die cp1252-Sonderzeichen. Alles andere setzt
// pdfkit als Müll-Glyphe.
function san(s) {
  return String(s == null ? "" : s)
    .replace(/→|⇒/g, "›").replace(/⊃/g, "›").replace(/✓|✔/g, "ok").replace(/✗|✘|❌/g, "x").replace(/⚠️?/g, "!").replace(/≠/g, "!=")
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, "")
    .replace(/[ \t]+/g, " ");
}
function cap(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
// Immer Schweizer Zeit — der Container läuft in UTC, ein Nachweis "am 11.09. um
// 09:13" muss aber die Uhrzeit zeigen, die der Leser kennt.
const TZ = "Europe/Zurich";
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return fmtDate(iso) + " " + d.toLocaleTimeString("de-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}
function pl(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/**
 * meta: { kicker, titleLines[], subtitle, tenantName, organization, date, stamps[],
 *         coverTiles[{label,value,tone}], footerLabel, coverNote }
 */
function create(meta) {
  meta = meta || {};
  const doc = new PDFDocument({ size: "A4", margins: { top: 74, bottom: 72, left: 56, right: 56 }, bufferPages: true });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const L = doc.page.margins.left;
  const pageIndex = () => { const r = doc.bufferedPageRange(); return r.start + r.count - 1; };
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = n => { if (doc.y + n > bottom()) doc.addPage(); };

  const toc = [];            // { level, num, title, page }
  const chapters = [];       // { page, title }
  let chapterNo = 0, subNo = 0, appendixNo = 0, current = "";

  // ---------------------------------------------------------------- Deckblatt
  function cover() {
    const PW = doc.page.width;
    let logo = false;
    try { if (fs.existsSync(LOGO_PATH)) { doc.image(LOGO_PATH, L, 46, { width: 138 }); logo = true; } } catch (e) { /* Text */ }
    if (!logo) doc.font("Helvetica-Bold").fontSize(13).fillColor(ACCENT).text("igeeks AG", L, 58);

    const top = 196, h = 272;
    doc.rect(0, top, PW, h).fill(ACCENT);
    doc.rect(0, top + h - 5, PW, 5).fill(C.accentDark);
    let y = top + 34;
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#ffffff").opacity(0.8)
      .text(san(meta.kicker || "MICROSOFT 365").toUpperCase(), L, y, { characterSpacing: 1.6, lineBreak: false });
    doc.opacity(1);
    y += 24;
    for (const line of meta.titleLines || ["Dokumentation"]) {
      doc.font("Helvetica-Bold").fontSize(30).fillColor("#ffffff").text(san(line), L, y, { width: W, lineBreak: false });
      y += 36;
    }
    if (meta.subtitle) {
      doc.font("Helvetica").fontSize(11).fillColor("#ffffff").opacity(0.9).text(san(meta.subtitle), L, y + 2, { width: W });
      doc.opacity(1);
    }
    doc.font("Helvetica-Bold").fontSize(17).fillColor("#ffffff").text(san(meta.tenantName || "—"), L, top + h - 74, { width: W, lineBreak: false });
    doc.font("Helvetica").fontSize(9.5).fillColor("#ffffff").opacity(0.85)
      .text(san([meta.organization, "Stand " + fmtDate(meta.date)].filter(Boolean).join("   ·   ")), L, top + h - 48, { width: W, lineBreak: false });
    doc.opacity(1);

    const tiles = meta.coverTiles || [];
    if (tiles.length) {
      const ty = top + h + 30, gap = 12, tw = (W - gap * (tiles.length - 1)) / tiles.length, th = 70;
      tiles.forEach((t, i) => {
        const x = L + i * (tw + gap);
        doc.roundedRect(x, ty, tw, th, 6).fill(C.card);
        const tone = TONES[t.tone] || null;
        doc.font("Helvetica-Bold").fontSize(22).fillColor(tone ? tone.fg : C.text).text(san(String(t.value)), x + 14, ty + 12, { width: tw - 28, lineBreak: false });
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.muted).text(san(t.label).toUpperCase(), x + 14, ty + 44, { width: tw - 28, characterSpacing: 0.4 });
      });
    }
    if (meta.stamps && meta.stamps.length) {
      doc.font("Helvetica").fontSize(8.5).fillColor(C.muted)
        .text("Datenerhebung: " + san(meta.stamps.join("  ·  ")), L, top + h + (tiles.length ? 116 : 30), { width: W, lineGap: 1.5 });
    }
    // Fussnoten des Deckblatts liegen unter dem Satzspiegel — ohne diesen Kniff
    // bricht pdfkit sie auf eine eigene Seite um.
    const keepBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8.5).fillColor(C.muted).text("Vertraulich — nur für den Empfänger bestimmt.", L, doc.page.height - 96, { width: W });
    if (meta.coverNote) doc.font("Helvetica").fontSize(8.5).fillColor(C.muted).text(san(meta.coverNote), L, doc.y + 2, { width: W, lineGap: 1 });
    doc.page.margins.bottom = keepBottom;
    // Seite für das Inhaltsverzeichnis reservieren — gefüllt wird sie in finish().
    doc.addPage();
    doc.addPage();
  }

  // ---------------------------------------------------------------- Überschriften
  function h1(title, opts) {
    const appendix = !!(opts && opts.appendix);
    if (appendix) appendixNo++; else chapterNo++;
    subNo = 0;
    const num = appendix ? String.fromCharCode(64 + appendixNo) : String(chapterNo);
    ensure(130);
    if (doc.y > doc.page.margins.top + 4) doc.moveDown(1.3);
    const y = doc.y;
    doc.roundedRect(L, y - 1, 24, 24, 5).fill(ACCENT);
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#ffffff").text(num, L, y + 5, { width: 24, align: "center", lineBreak: false });
    const full = (appendix ? "Anhang: " : "") + title;
    doc.font("Helvetica-Bold").fontSize(16).fillColor(C.text).text(san(full), L + 34, y + 2, { width: W - 34 });
    doc.y = Math.max(doc.y, y + 26) + 10; doc.x = L;
    current = full; h1.num = num;
    toc.push({ level: 1, num, title: full, page: pageIndex() });
    chapters.push({ page: pageIndex(), title: full, top: y < doc.page.margins.top + 40 });
  }
  function h2(title) {
    ensure(64);
    doc.moveDown(0.9);
    subNo++;
    const num = `${h1.num}.${subNo}`;
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(12).fillColor(ACCENT).text(num, L, y, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(12).fillColor(C.text).text(san(title), L + 38, y, { width: W - 38 });
    doc.moveDown(0.35); doc.x = L;
    toc.push({ level: 2, num, title, page: pageIndex() });
  }
  /** Objektüberschrift (App, Richtlinie, Konto) mit optionaler Pille rechts. */
  function h3(title, pillText, tone) {
    ensure(76);
    doc.moveDown(0.8);
    const y = doc.y;
    doc.rect(L, y + 1, 3, 13).fill(ACCENT);
    doc.font("Helvetica-Bold").fontSize(10.8).fillColor(C.text).text(san(title), L + 10, y, { width: W - (pillText ? 140 : 10) });
    const endY = doc.y;
    if (pillText) pillAt(san(pillText), L + W, y + 0.5, tone || "info", "right");
    doc.y = Math.max(endY, y + 14); doc.x = L;
  }
  function h4(label) {
    ensure(34);
    doc.moveDown(0.45);
    doc.font("Helvetica-Bold").fontSize(7.8).fillColor(ACCENT).text(san(label).toUpperCase(), L, doc.y, { width: W, characterSpacing: 0.6 });
    doc.moveDown(0.2); doc.x = L;
  }

  // ---------------------------------------------------------------- Text
  const body = (t, o) => { doc.font("Helvetica").fontSize(9.6).fillColor(C.text).text(san(t), L, doc.y, { width: W, lineGap: 1.8, ...(o || {}) }); doc.x = L; };
  const small = (t, o) => { doc.font("Helvetica").fontSize(8.2).fillColor(C.muted).text(san(t), L, doc.y, { width: W, lineGap: 1.2, ...(o || {}) }); doc.x = L; };
  function bullet(t, tone) {
    ensure(15);
    const y = doc.y;
    doc.circle(L + 8, y + 4.6, 1.8).fill(tone && TONES[tone] ? TONES[tone].fg : ACCENT);
    doc.font("Helvetica").fontSize(9).fillColor(tone && TONES[tone] ? TONES[tone].fg : C.text).text(san(t), L + 16, y, { width: W - 16, lineGap: 1.2 });
    doc.x = L;
  }

  // ---------------------------------------------------------------- Pillen
  function pillSize(text, size) {
    doc.font("Helvetica-Bold").fontSize(size || 7.2);
    return { w: doc.widthOfString(text) + 12, h: (size || 7.2) + 6 };
  }
  function pillAt(text, x, y, tone, align, size) {
    const t = TONES[tone] || TONES.muted;
    const s = pillSize(text, size);
    const px = align === "right" ? x - s.w : x;
    doc.roundedRect(px, y, s.w, s.h, s.h / 2).fill(t.bg);
    doc.font("Helvetica-Bold").fontSize(size || 7.2).fillColor(t.fg).text(text, px + 6, y + 3, { lineBreak: false });
    return s.w;
  }

  // ---------------------------------------------------------------- Kacheln
  function tiles(cells) {
    const gap = 10, h = 58;
    ensure(h + 14);
    const y = doc.y + 2;
    const w = (W - gap * (cells.length - 1)) / cells.length;
    cells.forEach((c, i) => {
      const x = L + i * (w + gap);
      const tone = TONES[c.tone] || null;
      doc.roundedRect(x, y, w, h, 6).fill(tone && c.value && c.value !== "0" ? tone.bg : C.card);
      doc.font("Helvetica-Bold").fontSize(18).fillColor(tone && c.value && c.value !== "0" ? tone.fg : C.text)
        .text(san(String(c.value)), x + 10, y + 10, { width: w - 20, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(6.8).fillColor(C.muted).text(san(c.label).toUpperCase(), x + 10, y + 36, { width: w - 20, characterSpacing: 0.3 });
    });
    doc.y = y + h + 10; doc.x = L;
  }

  // ---------------------------------------------------------------- Schlüssel/Wert
  function kv(label, value, o) {
    o = o || {};
    if (value === null || value === undefined || value === "") return;
    const font = o.mono ? "Courier" : "Helvetica", size = o.mono ? 7.9 : 9;
    doc.font(font).fontSize(size);
    const hv = doc.heightOfString(san(value), { width: W - 136, lineGap: 1.2 });
    doc.font("Helvetica-Bold").fontSize(8);
    const hl = doc.heightOfString(san(label), { width: 124 });
    const h = Math.max(hv, hl, 11);
    ensure(Math.min(h, 220) + 3);
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(C.muted).text(san(label), L, y + 1, { width: 124 });
    doc.font(font).fontSize(size).fillColor(o.tone && TONES[o.tone] ? TONES[o.tone].fg : C.text).text(san(value), L + 136, y, { width: W - 136, lineGap: 1.2 });
    doc.y = Math.max(doc.y, y + h) + 3; doc.x = L;
  }
  /** Mehrere Schlüssel/Wert-Zeilen in einer Karte mit Akzentleiste. */
  function card(pairs, o) {
    o = o || {};
    const rows = pairs.filter(p => p && p[1] !== null && p[1] !== undefined && p[1] !== "");
    if (!rows.length) return;
    const pad = 10, lw = 122, vw = W - pad * 2 - lw - 12;
    const heights = rows.map(([l, v, ro]) => {
      doc.font(ro && ro.mono ? "Courier" : "Helvetica").fontSize(ro && ro.mono ? 7.9 : 8.8);
      const hv = doc.heightOfString(san(v), { width: vw, lineGap: 1.1 });
      doc.font("Helvetica-Bold").fontSize(7.8);
      return Math.max(hv, doc.heightOfString(san(l), { width: lw }), 10) + 4;
    });
    // Die Karte fliesst über Seitenumbrüche: Zeilen werden seitenweise zu
    // Abschnitten gebündelt, jeder Abschnitt bekommt seinen eigenen Hintergrund.
    // Zusammengehalten wird nur der Anfang (erste Zeile), damit keine leere
    // Kartenkante am Seitenende steht.
    ensure(Math.min(heights[0] + pad * 2, 160));
    let i = 0;
    while (i < rows.length) {
      const segStart = doc.y + 2;
      let h = pad, j = i;
      while (j < rows.length && (segStart + h + heights[j] + pad <= bottom() || j === i)) { h += heights[j]; j++; }
      h += pad;
      doc.roundedRect(L, segStart, W, h, 5).fill(o.fill || C.card);
      doc.rect(L, segStart, 3, h).fill(o.accent || ACCENT);
      let y = segStart + pad;
      for (let k = i; k < j; k++) {
        const [l, v, ro] = rows[k];
        doc.font("Helvetica-Bold").fontSize(7.8).fillColor(C.muted).text(san(l), L + pad + 4, y + 1, { width: lw });
        doc.font(ro && ro.mono ? "Courier" : "Helvetica").fontSize(ro && ro.mono ? 7.9 : 8.8)
          .fillColor(ro && ro.tone && TONES[ro.tone] ? TONES[ro.tone].fg : C.text).text(san(v), L + pad + 4 + lw + 12, y, { width: vw, lineGap: 1.1 });
        y += heights[k];
      }
      doc.y = segStart + h + 2; doc.x = L;
      i = j;
      if (i < rows.length) doc.addPage();
    }
    doc.moveDown(0.3);
  }
  /** Hervorgehobener Satz (z. B. Klartext einer CA-Richtlinie). */
  function quote(t, tone) {
    doc.font("Helvetica").fontSize(9.4);
    const h = doc.heightOfString(san(t), { width: W - 24, lineGap: 1.6 }) + 14;
    ensure(h + 6);
    const y = doc.y + 2;
    const tt = TONES[tone] || TONES.info;
    doc.roundedRect(L, y, W, h, 5).fill(tt.bg);
    doc.rect(L, y, 3, h).fill(tt.fg);
    doc.font("Helvetica").fontSize(9.4).fillColor(C.text).text(san(t), L + 14, y + 7, { width: W - 24, lineGap: 1.6 });
    doc.y = y + h + 6; doc.x = L;
  }
  /** Hinweis-Kasten mit Titel. */
  function note(title, t, tone) {
    const tt = TONES[tone] || TONES.info;
    doc.font("Helvetica").fontSize(8.8);
    const hb = doc.heightOfString(san(t), { width: W - 28, lineGap: 1.3 });
    const h = hb + (title ? 26 : 14);
    ensure(h + 6);
    const y = doc.y + 2;
    doc.roundedRect(L, y, W, h, 5).fill(tt.bg);
    let ty = y + 7;
    if (title) { doc.font("Helvetica-Bold").fontSize(9).fillColor(tt.fg).text(san(title), L + 14, ty, { width: W - 28 }); ty += 13; }
    doc.font("Helvetica").fontSize(8.8).fillColor(C.text).text(san(t), L + 14, ty, { width: W - 28, lineGap: 1.3 });
    doc.y = y + h + 6; doc.x = L;
  }

  // ---------------------------------------------------------------- Tabelle
  /**
   * cols: [{ label, w }] (w = Anteil der Breite)
   * Zelle: Text oder { text, bold, tone, pill, indent, mono }
   */
  function table(cols, rows, o) {
    o = o || {};
    const size = o.size || 8.1;
    const widths = cols.map(c => Math.floor(c.w * W));
    const xs = [];
    let acc = L;
    widths.forEach(w => { xs.push(acc); acc += w; });
    const head = () => {
      const hy = doc.y;
      doc.roundedRect(L, hy, W, 16, 3).fill(C.head);
      cols.forEach((c, i) => {
        // Schmale Spalten: Schrift verkleinern statt umbrechen.
        const label = san(c.label).toUpperCase();
        let fsz = 6.8;
        doc.font("Helvetica-Bold");
        while (fsz > 5.4 && doc.fontSize(fsz).widthOfString(label) + label.length * 0.4 > widths[i] - 10) fsz -= 0.2;
        doc.fontSize(fsz).fillColor(ACCENT).text(label, xs[i] + 6, hy + 5 + (6.8 - fsz) / 2, { lineBreak: false, characterSpacing: 0.4 });
      });
      doc.y = hy + 18;
    };
    ensure(50);
    head();
    rows.forEach((row, ri) => {
      const cells = row.map(c => (c && typeof c === "object") ? c : { text: c });
      const txt = c => san(cap(c.text == null || c.text === "" ? "—" : c.text, 1000));
      const hs = cells.map((c, i) => {
        if (c.pill) return pillSize(txt(c)).h;
        doc.font(c.mono ? "Courier" : (c.bold ? "Helvetica-Bold" : "Helvetica")).fontSize(c.mono ? size - 0.4 : size);
        return doc.heightOfString(txt(c), { width: widths[i] - 12 - (c.indent || 0), lineGap: 0.6 });
      });
      const h = Math.max(...hs) + 8;
      if (doc.y + h > bottom()) { doc.addPage(); head(); }
      const ry = doc.y;
      if (ri % 2 === 1) doc.rect(L, ry, W, h).fill(C.zebra);
      cells.forEach((c, i) => {
        if (c.pill) { pillAt(txt(c), xs[i] + 6, ry + 3.5, c.pill); return; }
        const tone = c.tone && TONES[c.tone] ? TONES[c.tone].fg : C.text;
        doc.font(c.mono ? "Courier" : (c.bold ? "Helvetica-Bold" : "Helvetica")).fontSize(c.mono ? size - 0.4 : size).fillColor(tone)
          .text(txt(c), xs[i] + 6 + (c.indent || 0), ry + 4, { width: widths[i] - 12 - (c.indent || 0), lineGap: 0.6 });
      });
      doc.y = ry + h;
    });
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.x = L;
    doc.moveDown(0.45);
  }

  // ---------------------------------------------------------------- Kette
  /**
   * Ketten-Diagramm, z. B. [Erforderlich] › [App-Gruppe] › [Gerätegruppe, Gerätegruppe] › [12 Geräte].
   * steps: [{ nodes: [{ label, sub, kind }], connector }] — connector: Text am Pfeil davor.
   * kind: app | dev | usr | bad | plain | pill-<tone>
   */
  function chain(steps) {
    const nodeH = (n) => n.kind && n.kind.startsWith("pill") ? 14 : (n.sub ? 26 : 17);
    const nodeW = (n) => {
      if (n.kind && n.kind.startsWith("pill")) return pillSize(san(n.label), 7.4).w;
      doc.font("Helvetica-Bold").fontSize(8);
      const w1 = doc.widthOfString(san(n.label));
      doc.font("Helvetica").fontSize(6.6);
      const w2 = n.sub ? doc.widthOfString(san(n.sub)) : 0;
      return Math.min(Math.max(w1, w2) + 14, W * 0.62);
    };
    // Zeilen bilden: Knoten eines Schritts stehen untereinander, Schritte nebeneinander
    const cols = steps.map(s => ({ ...s, w: Math.max(...s.nodes.map(nodeW)), h: s.nodes.reduce((a, n) => a + nodeH(n) + 4, -4) }));
    const arrowW = 30;
    const lines = [];
    let curLine = [], curW = 0;
    for (const c of cols) {
      const need = (curLine.length ? arrowW : 0) + c.w;
      if (curLine.length && curW + need > W) { lines.push(curLine); curLine = []; curW = 0; }
      curLine.push(c); curW += (curLine.length > 1 ? arrowW : 0) + c.w;
    }
    if (curLine.length) lines.push(curLine);
    lines.forEach((line, li) => {
      const lh = Math.max(...line.map(c => c.h));
      ensure(lh + 8);
      const y0 = doc.y + 2;
      let x = L + (li > 0 ? 14 : 0);
      if (li > 0) { doc.font("Helvetica-Bold").fontSize(10).fillColor(C.faint).text("›", L + 2, y0 + lh / 2 - 6, { lineBreak: false }); }
      line.forEach((c, ci) => {
        if (ci > 0) {
          const ay = y0 + Math.min(lh, 17) / 2;
          doc.moveTo(x + 3, ay).lineTo(x + arrowW - 6, ay).lineWidth(0.9).strokeColor(C.faint).stroke();
          doc.moveTo(x + arrowW - 9, ay - 3).lineTo(x + arrowW - 5, ay).lineTo(x + arrowW - 9, ay + 3).lineWidth(0.9).strokeColor(C.faint).stroke();
          if (c.connector) doc.font("Helvetica").fontSize(5.6).fillColor(C.faint).text(san(c.connector), x - 4, ay + 3.5, { width: arrowW + 8, align: "center", lineBreak: false });
          x += arrowW;
        }
        let ny = y0;
        for (const n of c.nodes) {
          if (n.kind && n.kind.startsWith("pill")) {
            pillAt(san(n.label), x, ny + 1.5, n.kind.slice(5) || "info", null, 7.4);
          } else {
            const st = NODE[n.kind] || NODE.plain;
            const w = nodeW(n), h = nodeH(n);
            doc.lineWidth(0.8);
            doc.roundedRect(x, ny, w, h, 4).fillAndStroke(st.fill, st.border);
            doc.font("Helvetica-Bold").fontSize(8).fillColor(C.text).text(san(n.label), x + 7, ny + 4.5, { width: w - 12, lineBreak: false, ellipsis: true });
            if (n.sub) doc.font("Helvetica").fontSize(6.6).fillColor(C.muted).text(san(n.sub), x + 7, ny + 15, { width: w - 12, lineBreak: false, ellipsis: true });
          }
          ny += nodeH(n) + 4;
        }
        x += c.w;
      });
      doc.y = y0 + lh + 6; doc.x = L;
    });
  }

  // ---------------------------------------------------------------- Abschluss
  function finish() {
    const range = doc.bufferedPageRange();
    const total = range.count;
    // Inhaltsverzeichnis (Seite 2)
    if (total > 1) {
      doc.switchToPage(1);
      doc.y = doc.page.margins.top;
      doc.font("Helvetica-Bold").fontSize(16).fillColor(C.text).text("Inhalt", L, doc.y);
      doc.moveDown(0.8);
      const entries = toc.length > 42 ? toc.filter(e => e.level === 1) : toc;
      for (const e of entries) {
        const y = doc.y;
        const indent = e.level === 1 ? 0 : 26;
        const size = e.level === 1 ? 10 : 9;
        doc.font(e.level === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(e.level === 1 ? ACCENT : C.muted)
          .text(e.num, L + indent, y, { lineBreak: false });
        const tx = L + indent + (e.level === 1 ? 22 : 30);
        doc.font(e.level === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(C.text)
          .text(san(cap(e.title, 78)), tx, y, { width: W - (tx - L) - 40, lineBreak: false });
        const tw = doc.widthOfString(san(cap(e.title, 78)));
        const dotsFrom = tx + tw + 6, dotsTo = L + W - 30;
        if (dotsTo > dotsFrom) {
          doc.font("Helvetica").fontSize(size).fillColor(C.faint);
          let dx = dotsFrom;
          while (dx < dotsTo) { doc.text(".", dx, y, { lineBreak: false }); dx += 4; }
        }
        doc.font(e.level === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(C.text)
          .text(String(e.page), L + W - 26, y, { width: 26, align: "right", lineBreak: false });
        doc.y = y + (e.level === 1 ? 17 : 14);
        if (e.level === 1) doc.y += 2;
      }
    }
    // Kopf- und Fusszeilen (ab Seite 2)
    for (let p = range.start + 1; p < range.start + total; p++) {
      doc.switchToPage(p);
      const keepB = doc.page.margins.bottom, keepT = doc.page.margins.top;
      doc.page.margins.bottom = 0; doc.page.margins.top = 0;
      // Kapitel, das oben auf der Seite läuft: das erste, das hier beginnt, sonst das zuletzt begonnene.
      const chapter = chapters.find(c => c.page === p && c.top) || chapters.filter(c => c.page < p).pop() || chapters.find(c => c.page === p);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(ACCENT).text(san(meta.footerLabel || "Dokumentation"), L, 36, { width: W / 2, lineBreak: false });
      if (chapter && p > 1) doc.font("Helvetica").fontSize(7.5).fillColor(C.muted).text(san(cap(chapter.title, 70)), L + W / 2, 36, { width: W / 2, align: "right", lineBreak: false });
      doc.moveTo(L, 50).lineTo(L + W, 50).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.moveTo(L, doc.page.height - 50).lineTo(L + W, doc.page.height - 50).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.font("Helvetica").fontSize(7.5).fillColor(C.muted).text(san(`igeeks AG · ${meta.tenantName || ""} · Stand ${fmtDate(meta.date)}`), L, doc.page.height - 42, { width: W - 80, lineBreak: false });
      doc.font("Helvetica").fontSize(7.5).fillColor(C.muted).text(`Seite ${p} von ${total - 1}`, L + W - 80, doc.page.height - 42, { width: 80, align: "right", lineBreak: false });
      doc.page.margins.bottom = keepB; doc.page.margins.top = keepT;
    }
    doc.end();
    return done;
  }

  return {
    doc, W, L, ensure, cover, h1, h2, h3, h4, body, small, bullet, kv, card, quote, note, table, tiles, chain, pillAt, finish,
    get current() { return current; }
  };
}

module.exports = { create, san, cap, fmtDate, fmtDateTime, pl, TONES, ACCENT };
