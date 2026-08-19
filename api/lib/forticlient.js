/**
 * FortiClient-Installer-Fetch.
 *
 * FortiClient EMS bietet keine API zum Enumerieren von Sites oder zum
 * Erzeugen von Installer-Links (vom Nutzer bestaetigt). Pro Kunde/Site liegt
 * stattdessen bereits ein von EMS vorkonfiguriertes MSI+MST-Paar unter einer
 * festen internen URL (forticlient.igeekscloud.ch) -- die .mst-Transform-
 * Datei enthaelt die Registrierung auf den passenden EMS-Server/Site, dort
 * hinein gebacken bei der Installer-Erzeugung in EMS selbst. Der Admin gibt
 * die site-spezifische Ordner-URL manuell an (aus der EMS-Site-Uebersicht
 * bekannt), wir laden von dort direkt beide Dateien.
 *
 * Silent-Install-Syntax (offiziell, Fortinet-Dokumentation + Community-Tip):
 *   msiexec /i "forticlient.msi" TRANSFORMS="forticlient.mst" /qn
 *           REBOOT=ReallySuppress DONT_PROMPT_REBOOT=1
 */
const ALLOWED_HOST = "forticlient.igeekscloud.ch";

function assertTrustedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { throw new Error("Ungueltige Installer-Ordner-URL."); }
  if (url.protocol !== "https:") throw new Error("Nur https:// erlaubt.");
  if (url.hostname !== ALLOWED_HOST) throw new Error(`Nur URLs von ${ALLOWED_HOST} erlaubt (Schutz gegen versehentliche/fremde URLs).`);
  return url;
}

async function fetchFile(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status}): ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

/** baseUrl = Ordner-URL bis inkl. "msi/x64/" (Trailing-Slash optional). */
async function fetchInstallerFiles(baseUrl) {
  assertTrustedUrl(baseUrl);
  const base = String(baseUrl).replace(/\/?$/, "/");
  const [msiBuffer, mstBuffer] = await Promise.all([
    fetchFile(base + "forticlient.msi"),
    fetchFile(base + "forticlient.mst")
  ]);
  return { msiBuffer, mstBuffer, msiName: "forticlient.msi", mstName: "forticlient.mst" };
}

module.exports = { fetchInstallerFiles };
