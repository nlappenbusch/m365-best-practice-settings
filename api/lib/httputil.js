"use strict";
/** Kleine Helfer fuer Datei-Downloads (von bitdefender.js und nsight.js genutzt). */

/** Verbietet Pfad-/Sonderzeichen im Dateinamen (kommt aus fremden Headern). */
function sanitizeFileName(name) {
  return String(name || "download").replace(/[\\/:*?"<>|]/g, "_").trim() || "download";
}

/** Dateiname aus Content-Disposition, sonst Fallback. Immer entschaerft. */
function fileNameFromDisposition(disposition, fallback) {
  let name = fallback;
  if (disposition) {
    const m = /filename\*?=("?)([^";]+)/i.exec(disposition);
    if (m && m[2]) {
      let fn = m[2].replace(/^UTF-8''/i, "");
      try { fn = decodeURIComponent(fn); } catch (e) { /* roh weiterverwenden */ }
      if (fn.trim()) name = fn;
    }
  }
  return sanitizeFileName(name);
}

module.exports = { sanitizeFileName, fileNameFromDisposition };
