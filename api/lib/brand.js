"use strict";
/**
 * Absender/Marke fuer Berichte, PDFs und Paket-Metadaten -- bewusst nicht im Code
 * verdrahtet, sondern aus der Umgebung:
 *   BRAND_NAME     Firmenname (z. B. im PDF-Kopf, Fusszeile, Publisher)
 *   BRAND_TAGLINE  Zeile unter dem Namen im PDF-Kopf
 *   BRAND_FOOTER   Adresszeile am Ende der Ist-Zustand-Doku
 * Leer = neutrale Dokumente ohne Firmenangabe.
 * Logo optional: api/assets/brand-logo.png (PNG, ca. 300x110). Fehlt es, steht
 * der Name als Text da (oder nichts, wenn auch BRAND_NAME leer ist).
 */
const path = require("path");

const NAME = (process.env.BRAND_NAME || "").trim();
const TAGLINE = (process.env.BRAND_TAGLINE || "").trim();
const FOOTER = (process.env.BRAND_FOOTER || "").trim();
const LOGO_PATH = path.join(__dirname, "..", "assets", "brand-logo.png");
const PUBLISHER = NAME || "M365 Security Policy Manager";

/** "Name · " oder "" -- fuer Fusszeilen, die mit der Marke beginnen. */
const prefix = (sep = " · ") => (NAME ? NAME + sep : "");

module.exports = { NAME, TAGLINE, FOOTER, LOGO_PATH, PUBLISHER, prefix };
