"use strict";
/**
 * Layout der Ist-Zustand-Dokumentation (pdfkit) — nachgebaut nach der Vorlage, die
 * für SG Value Partners von Hand entstand (ist.css): schlichte Kopfzeile mit Logo,
 * nummerierte fette Überschriften in igeeks-Petrol ohne Deko-Striche davor, eine
 * feine Linie unter der Kapitelüberschrift, Tabellen mit kleinem Versalien-Kopf, der
 * sich bei jedem Seitenumbruch wiederholt, Status-Pillen, Kennzahl-Kacheln,
 * Speicherbalken, Fusszeile «Seite x von y». Keine erzwungenen Seitenumbrüche:
 * umbrochen wird nur, wenn die Seite voll ist; Zeilen werden nicht geteilt.
 *
 * Bewusst getrennt von lib/pdfDesign.js (Konfig-Doku und Nachweise mit Deckblatt
 * und Inhaltsverzeichnis): Diese Doku ist ein Kundendokument mit eigener Vorlage,
 * und die bestehenden PDFs sollen sich durch sie nicht verändern.
 */
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { san } = require("./pdfDesign");

const LOGO_PATH = path.join(__dirname, "..", "assets", "igeeks-logo.png");
const C = {
  accent: "#0081ad", text: "#373737", dark: "#232a31", muted: "#707070", faint: "#8a97a2", note: "#5a6b78",
  line: "#d7dee3", rowLine: "#eef2f4", headLine: "#cfd8de", kpiBg: "#f7fafc", barBg: "#eef2f4", sign: "#9aa7b1"
};
// Status-Pillen wie .st-ok / .st-nt / .st-open / .st-na in ist.css
const TONE = {
  ok: { fg: "#1f7a3f", bg: "#eaf6ee", bd: "#bfe3cb" },
  nt: { fg: "#8a5a00", bg: "#fff6e0", bd: "#f0d89a" },
  open: { fg: "#8f1f1f", bg: "#fcebeb", bd: "#efc2c2" },
  na: { fg: "#5a6b78", bg: "#f1f4f6", bd: "#d7dee3" },
  info: { fg: "#005f80", bg: "#e3f1f7", bd: "#b9dcea" }
};
const FONT = { r: "Helvetica", b: "Helvetica-Bold", m: "Courier", i: "Helvetica-Oblique" };

function create(meta) {
  meta = meta || {};
  const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 54, left: 37, right: 37 }, bufferPages: true, info: { Title: san(meta.title || "Ist-Zustand Microsoft 365"), Author: "igeeks AG" } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const top = () => doc.page.margins.top;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const atTop = () => doc.y <= top() + 2;
  const ensure = h => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = top(); } };

  // ---------------------------------------------------------------- Text-Bausteine
  /** runs: String oder [{ t, f: r|b|m|i, c, s }] — Fliesstext mit Hervorhebungen. */
  function runs(x) {
    if (x && !Array.isArray(x) && typeof x === "object" && Array.isArray(x.runs)) x = x.runs;
    return typeof x === "string" ? [{ t: x }] : (x || []).filter(r => r && r.t !== undefined && r.t !== null && r.t !== "");
  }
  function drawRuns(list, x, y, width, o) {
    o = o || {};
    const size = o.size || 9;
    const rs = runs(list);
    if (!rs.length) return;
    doc.x = x; doc.y = y;
    rs.forEach((r, i) => {
      const f = FONT[r.f || o.f || "r"];
      const s = r.f === "m" ? (r.s || size) * 0.9 : (r.s || size);
      doc.font(f).fontSize(s).fillColor(r.c || o.color || C.text);
      const last = i === rs.length - 1;
      if (i === 0) doc.text(san(r.t), x, y, { width, lineGap: o.lineGap === undefined ? 1.6 : o.lineGap, continued: !last, align: o.align || "left" });
      else doc.text(san(r.t), { continued: !last, lineGap: o.lineGap === undefined ? 1.6 : o.lineGap });
    });
  }
  function measureRuns(list, width, o) {
    o = o || {};
    const rs = runs(list);
    if (!rs.length) return 0;
    // Gemischte Schriften: mit der breitesten gemessen, damit nichts überläuft.
    const txt = rs.map(r => r.t).join("");
    const hasMono = rs.some(r => r.f === "m");
    doc.font(hasMono ? FONT.m : (rs.every(r => r.f === "b") ? FONT.b : FONT.r)).fontSize((o.size || 9) * (hasMono ? 0.9 : 1));
    return doc.heightOfString(san(txt), { width, lineGap: o.lineGap === undefined ? 1.6 : o.lineGap });
  }

  // Überschriften werden erst gezeichnet, wenn der nächste Inhalt kommt — zusammen
  // mit dessen erstem Stück. So bleibt keine Überschrift allein am Seitenende stehen.
  let pending = [];
  function flush(need) {
    if (!pending.length) return;
    const total = pending.reduce((a, x) => a + x.h, 0);
    ensure(total + (need || 0));
    const list = pending; pending = [];
    for (const x of list) x.draw();
  }

  function p(x, o) {
    o = o || {};
    const h = measureRuns(x, W, o);
    flush(Math.min(h, 40) + 2);
    ensure(Math.min(h, 40) + 2);
    drawRuns(x, L, doc.y, W, o);
    doc.x = L;
    doc.y += o.after === undefined ? 5 : o.after;
  }
  const note = (x, o) => p(runs(x).map(r => ({ ...r, c: r.c || C.note })), { size: 7.9, ...(o || {}) });

  function ul(items, o) {
    o = o || {};
    for (const it of items) {
      const h = measureRuns(it, W - 14, { size: o.size || 9 });
      flush(Math.min(h, 30) + 2);
      ensure(Math.min(h, 30) + 2);
      const y = doc.y;
      doc.circle(L + 5, y + 4.4, 1.5).fill(o.bullet || C.text);
      drawRuns(it, L + 14, y, W - 14, { size: o.size || 9 });
      doc.x = L; doc.y += 2.5;
    }
    doc.y += 3;
  }

  // ---------------------------------------------------------------- Kopf
  function header(h) {
    const y0 = top();
    let logoOk = false;
    try { if (fs.existsSync(LOGO_PATH)) { doc.image(LOGO_PATH, L, y0 - 2, { height: 27 }); logoOk = true; } } catch (e) { /* Text-Ersatz */ }
    if (!logoOk) doc.font(FONT.b).fontSize(15).fillColor(C.accent).text("igeeks", L, y0 + 4, { lineBreak: false });
    doc.font(FONT.r).fontSize(7.8).fillColor("#747373").text("Managed Services & Security", L, y0 + 29, { lineBreak: false });
    doc.font(FONT.b).fontSize(14).fillColor(C.accent).text(san(h.kicker || "Ist-Zustand"), L, y0 + 5, { width: W, align: "right", lineBreak: false });
    doc.font(FONT.r).fontSize(8.2).fillColor(C.muted).text(san(h.stamp || ""), L, y0 + 25, { width: W, align: "right", lineBreak: false });
    const ly = y0 + 42;
    doc.rect(L, ly, W, 2.2).fill(C.accent);
    doc.y = ly + 14; doc.x = L;
    doc.font(FONT.b).fontSize(15.5).fillColor(C.dark).text(san(h.title), L, doc.y, { width: W });
    doc.y += 1;
    if (h.sub) doc.font(FONT.r).fontSize(9.6).fillColor(C.muted).text(san(h.sub), L, doc.y, { width: W });
    doc.y += 8;
  }

  // ---------------------------------------------------------------- Überschriften
  function h2(num, title) {
    pending.push({ h: 38, draw: () => drawH2(num, title) });
  }
  function drawH2(num, title) {
    if (!atTop()) doc.y += 13;
    const y = doc.y;
    doc.font(FONT.b).fontSize(12).fillColor(C.accent);
    const nw = num ? doc.widthOfString(san(String(num))) + 8 : 0;
    if (num) doc.text(san(String(num)), L, y, { lineBreak: false });
    doc.text(san(title), L + nw, y, { width: W - nw });
    const ly = doc.y + 1.5;
    doc.moveTo(L, ly).lineTo(L + W, ly).lineWidth(0.7).strokeColor(C.line).stroke();
    doc.y = ly + 6; doc.x = L;
  }
  function h3(num, title) {
    pending.push({ h: 24, draw: () => drawH3(num, title) });
  }
  function drawH3(num, title) {
    if (!atTop()) doc.y += 8;
    const y = doc.y;
    doc.font(FONT.b).fontSize(9.8).fillColor(C.dark);
    const nw = num ? doc.widthOfString(san(String(num))) + 7 : 0;
    if (num) doc.text(san(String(num)), L, y, { lineBreak: false });
    doc.text(san(title), L + nw, y, { width: W - nw });
    doc.y += 3; doc.x = L;
  }

  // ---------------------------------------------------------------- Pillen
  function pillMetrics(text, maxW) {
    const t = san(text);
    // Erst verkleinern, dann (nur an Wortgrenzen) umbrechen.
    for (let fs = 6.6; fs >= 5.6; fs -= 0.2) {
      doc.font(FONT.b).fontSize(fs);
      const w = doc.widthOfString(t) + 10;
      if (w <= maxW) return { w, h: 10.5, lines: 1, t, fs };
    }
    doc.font(FONT.b).fontSize(6.2);
    const h = doc.heightOfString(t, { width: maxW - 10, lineGap: 0.8 });
    return { w: maxW, h: h + 4.5, lines: 2, t, fs: 6.2 };
  }
  function pill(text, tone, x, y, maxW) {
    const m = pillMetrics(text, maxW || 200);
    const c = TONE[tone] || TONE.na;
    doc.lineWidth(0.6);
    doc.roundedRect(x, y, m.w, m.h, 5).fillAndStroke(c.bg, c.bd);
    doc.font(FONT.b).fontSize(m.fs).fillColor(c.fg);
    if (m.lines === 1) doc.text(m.t, x + 5, y + 2.4 + (6.6 - m.fs) / 2, { lineBreak: false });
    else doc.text(m.t, x + 5, y + 2.4, { width: m.w - 10, lineGap: 0.8 });
    return m;
  }

  // ---------------------------------------------------------------- Tabellen
  // Zelle: String | Teil | [Teile]. Teil: { t, f, c, s } Text · { pill, tone } · { pills: [{t,tone}] }
  //        · { sub } Kommentarzeile · { bar: { v, max, label } } Speicherbalken · { runs: [...] }
  function partsOf(cell) {
    if (cell === null || cell === undefined || cell === "") return [{ t: "—" }];
    if (typeof cell === "string" || typeof cell === "number") return [{ t: String(cell) }];
    if (Array.isArray(cell)) {
      const a = cell.filter(x => x !== null && x !== undefined && x !== "");
      return a.length ? a.flatMap(partsOf) : [{ t: "—" }];
    }
    return [cell];
  }
  function partHeight(pt, w, size) {
    if (pt.pill !== undefined) return pillMetrics(pt.pill, w).h;
    if (pt.pills) { let x = 0, lines = 1; for (const q of pt.pills) { const m = pillMetrics(q.t, w); if (x + m.w > w && x > 0) { lines++; x = 0; } x += m.w + 3; } return lines * 12.5 - 2; }
    if (pt.bar) return 15.5;
    if (pt.sub !== undefined) { doc.font(FONT.r).fontSize(size * 0.86); return doc.heightOfString(san(pt.sub), { width: w, lineGap: 0.9 }) + 2; }
    if (pt.runs) return measureRuns(pt.runs, w, { size, lineGap: 1 });
    const f = FONT[pt.f || "r"];
    const s = pt.f === "m" ? (pt.s || size) * 0.9 : (pt.s || size);
    doc.font(f).fontSize(s);
    return doc.heightOfString(san(pt.t), { width: w, lineGap: 1 });
  }
  function drawPart(pt, x, y, w, size) {
    if (pt.pill !== undefined) return pill(pt.pill, pt.tone, x, y, w).h;
    if (pt.pills) {
      let cx = x, cy = y;
      for (const q of pt.pills) { const m = pillMetrics(q.t, w); if (cx + m.w > x + w && cx > x) { cx = x; cy += 12.5; } pill(q.t, q.tone, cx, cy, w); cx += m.w + 3; }
      return cy - y + 10.5;
    }
    if (pt.bar) {
      const { v, max, label } = pt.bar;
      doc.roundedRect(x, y + 2, w, 5, 2.5).fill(C.barBg);
      const bw = v ? Math.max(1.5, w * Math.min(1, v / (max || 1))) : 0;
      if (bw) doc.roundedRect(x, y + 2, bw, 5, 2.5).fill(C.accent);
      doc.font(FONT.r).fontSize(6.8).fillColor(C.note).text(san(label || ""), x, y + 8.5, { width: w, lineBreak: false });
      return 15.5;
    }
    if (pt.sub !== undefined) {
      doc.font(FONT.r).fontSize(size * 0.86).fillColor(C.note).text(san(pt.sub), x, y + 1.5, { width: w, lineGap: 0.9 });
      return doc.y - y;
    }
    if (pt.runs) { drawRuns(pt.runs, x, y, w, { size, lineGap: 1 }); return doc.y - y; }
    const f = FONT[pt.f || "r"];
    const s = pt.f === "m" ? (pt.s || size) * 0.9 : (pt.s || size);
    doc.font(f).fontSize(s).fillColor(pt.c || C.text).text(san(pt.t), x, y, { width: w, lineGap: 1 });
    return doc.y - y;
  }
  /**
   * cols: [{ label, w }] (w = Anteil der Breite, Summe ≈ 1)
   * o: { size (Standard 8.2; "klein" 7.3), head: false, pad }
   */
  function table(cols, rows, o) {
    o = o || {};
    const size = o.size || 8.2;
    const pad = o.pad || 4, vpad = 3.4;
    const widths = cols.map(c => c.w * W);
    const xs = []; let acc = L; for (const w of widths) { xs.push(acc); acc += w; }
    // Kopfbeschriftung: in schmalen Spalten verkleinern statt mitten im Wort umbrechen.
    const labels = cols.map((c, i) => {
      const t = san(String(c.label || "").toUpperCase());
      const longest = t.split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), "");
      let fs = 6.3;
      doc.font(FONT.b);
      while (fs > 4.8 && doc.fontSize(fs).widthOfString(longest) + longest.length * 0.25 > widths[i] - pad * 2) fs -= 0.2;
      return { t, fs };
    });
    const head = () => {
      if (o.head === false) return;
      const y = doc.y;
      let hh = 0;
      const hs = labels.map((l, i) => doc.font(FONT.b).fontSize(l.fs).heightOfString(l.t, { width: widths[i] - pad * 2, characterSpacing: 0.25 }));
      hh = Math.max(...hs);
      labels.forEach((l, i) => doc.font(FONT.b).fontSize(l.fs).fillColor(C.faint).text(l.t, xs[i] + pad, y + 2 + (hh - hs[i]), { width: widths[i] - pad * 2, characterSpacing: 0.25 }));
      const ly = y + hh + 4.5;
      doc.moveTo(L, ly).lineTo(L + W, ly).lineWidth(0.7).strokeColor(C.headLine).stroke();
      doc.y = ly + 0.5;
    };
    const measure = row => Math.max(...row.map((cell, i) => {
      const ps = partsOf(cell);
      return ps.reduce((a, pt, k) => a + partHeight(pt, widths[i] - pad * 2, size) + (k ? 1.5 : 0), 0);
    })) + vpad * 2;
    flush(Math.min(rows.length ? measure(rows[0]) : 0, 200) + 24);
    ensure(Math.min(rows.length ? measure(rows[0]) : 0, 200) + 22);
    doc.y += 2;
    head();
    const maxRow = bottom() - top() - 30;
    for (const row of rows) {
      let h = measure(row);
      if (h > maxRow) h = maxRow;             // sehr lange Zelle: wird unten abgeschnitten statt die Seite zu sprengen
      if (doc.y + h > bottom()) { doc.addPage(); doc.y = top(); head(); }
      const y = doc.y;
      row.forEach((cell, i) => {
        let cy = y + vpad;
        partsOf(cell).forEach((pt, k) => { if (k) cy += 1.5; cy += drawPart(pt, xs[i] + pad, cy, widths[i] - pad * 2, size); });
      });
      doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.5).strokeColor(C.rowLine).stroke();
      doc.y = y + h;
    }
    doc.x = L;
    doc.y += 6;
  }

  /** Schlüssel/Wert-Tabelle ohne Kopf (Kopfdaten, Einstellungen). */
  function kv(rows, o) {
    o = o || {};
    table([{ label: "", w: o.w || 0.28 }, { label: "", w: 1 - (o.w || 0.28) }],
      rows.filter(Boolean).map(([k, v]) => [{ t: k, c: C.muted }, v]), { head: false, size: o.size || 8.4 });
  }

  // ---------------------------------------------------------------- Kennzahlen
  function kpis(items) {
    const gap = 7, n = items.length, w = (W - gap * (n - 1)) / n;
    const hs = items.map(k => {
      doc.font(FONT.r).fontSize(6.7);
      return 34 + (k.detail ? doc.heightOfString(san(k.detail), { width: w - 14, lineGap: 0.6 }) + 2 : 0);
    });
    const h = Math.max(...hs) + 8;
    flush(h + 10);
    ensure(h + 10);
    const y = doc.y + 3;
    items.forEach((k, i) => {
      const x = L + i * (w + gap);
      doc.lineWidth(0.6);
      doc.roundedRect(x, y, w, h, 2.5).fillAndStroke(C.kpiBg, C.line);
      doc.rect(x, y, 2.4, h).fill(C.accent);
      doc.font(FONT.b).fontSize(13.2).fillColor(C.accent).text(san(String(k.value)), x + 8, y + 6, { width: w - 14, lineBreak: false });
      doc.font(FONT.b).fontSize(7.6).fillColor(C.dark).text(san(k.label), x + 8, y + 23, { width: w - 14, lineBreak: false });
      if (k.detail) doc.font(FONT.r).fontSize(6.7).fillColor(C.note).text(san(k.detail), x + 8, y + 33.5, { width: w - 14, lineGap: 0.6 });
    });
    doc.y = y + h + 9; doc.x = L;
  }

  // ---------------------------------------------------------------- Freigabe
  function sign(rows) {
    const h = 30 + rows.length * 44;
    flush(h);
    ensure(h);
    const cols = [0.34, 0.3, 0.12, 0.24].map(f => f * W);
    const xs = []; let acc = L; for (const w of cols) { xs.push(acc); acc += w; }
    let y = doc.y + 2;
    ["", "Name", "Datum", "Unterschrift"].forEach((t, i) => doc.font(FONT.b).fontSize(6.3).fillColor(C.faint).text(t.toUpperCase(), xs[i] + 4, y, { width: cols[i] - 8, characterSpacing: 0.25, lineBreak: false }));
    y += 12;
    for (const r of rows) {
      doc.font(FONT.r).fontSize(8.4);
      const rh = Math.max(...r.map((t, i) => doc.heightOfString(san(t || " "), { width: cols[i] - 8 })));
      y += 24;
      r.forEach((t, i) => doc.font(FONT.r).fontSize(8.4).fillColor(C.text).text(san(t || ""), xs[i] + 4, y, { width: cols[i] - 8 }));
      y += rh + 2;
      doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.7).strokeColor(C.sign).stroke();
    }
    doc.y = y + 10; doc.x = L;
  }
  function foot(text) {
    flush(26);
    ensure(26);
    doc.y += 8;
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.font(FONT.r).fontSize(7.4).fillColor(C.faint).text(san(text), L, doc.y + 5, { width: W });
  }

  // ---------------------------------------------------------------- Abschluss
  function finish(footLeft) {
    flush(0);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 30;
      doc.font(FONT.r).fontSize(6.8).fillColor(C.faint).text(san(footLeft || ""), L, y, { width: W - 80, lineBreak: false });
      doc.text(`Seite ${i - range.start + 1} von ${range.count}`, L + W - 80, y, { width: 80, align: "right", lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
    return done;
  }

  return { doc, L, W, C, TONE, ensure, p, note, ul, header, h2, h3, table, kv, kpis, sign, foot, finish, pill, runs, top, bottom };
}

module.exports = { create, C, TONE };
