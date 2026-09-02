"use strict";
/**
 * Lokale Administratoren fuer die Einfuehrungsphase — befristet, eng zugewiesen,
 * mit Enddatum.
 *
 * Der Hintergrund (Kap. 9.8 der Wissensbasis): Zielbild ist, dass es auf
 * Clients keine zusaetzlichen lokalen Administratoren gibt. Waehrend des
 * Aufbaus eines Kunden ist das nicht durchhaltbar — Ersteinrichtung, Migration
 * und Nacharbeit verlangen laufend lokale Rechte. Wer dafuer jedes Mal das
 * LAPS-Kennwort im Portal nachschlaegt und abtippt, sorgt in der Praxis dafuer,
 * dass genau dieses Kennwort notiert und weitergegeben wird.
 *
 * Deshalb eine benannte Ausnahme mit drei Eigenschaften:
 *  1. NICHT ueber den tenantweiten Entra-Schalter ("Additional local
 *     administrators on all Microsoft Entra joined devices") — der gilt fuer
 *     alle Entra-joined Geraete und laesst sich nicht eingrenzen.
 *  2. Sondern ueber Intune (CSP LocalUsersAndGroups): haengt an einer
 *     Geraetegruppe und ist mit einem Klick wieder weg.
 *  3. Mit Enddatum. Ohne benanntes Ende wird aus der Ausnahme der Dauerzustand.
 *
 * Preis der Ausnahme, offen benannt: Ein lokaler Administrator kann
 * Sicherheitsagenten abschalten (Bitdefender-Tamper-Protection, RMM-Dienst) und
 * Teile der Baseline lokal aushebeln. Kurz halten, eng zuweisen, nicht auf
 * Geraeten im Regelbetrieb mit Kundendaten.
 *
 * Weg: Custom-Konfigurationsprofil (OMA-URI) — gleiches Muster wie
 * lib/browserExtensions.js, aus demselben Grund: stabiler Pfad statt
 * versionsabhaengiger Settings-Catalog-Ids.
 */
const { graphReq, graphAllPages } = require("./graph");
const NAMING = require("./naming");

const NAME_KIND = "localAdminSetup";
const GROUP_KIND = "localAdminGroup";
const NAME_SEP = "\u0001";

const OMA_URI = "./Device/Vendor/MSFT/Policy/Config/LocalUsersAndGroups/Configure";

// Die lokale Administratorengruppe wird ueber ihre bekannte SID angesprochen,
// nicht ueber den Namen: Auf einem deutschen Windows heisst sie
// "Administratoren", auf einem franzoesischen "Administrateurs" — die SID ist
// ueberall dieselbe. Mit dem Namen waere die Policy auf jedem nicht-englischen
// Geraet wirkungslos, ohne dass es eine Fehlermeldung gaebe.
const BUILTIN_ADMINS_SID = "S-1-5-32-544";

/**
 * Entra-Gruppen-Objekt-Id in ihre SID umrechnen.
 *
 * Windows spricht Entra-Gruppen in dieser Policy ueber ihre SID an, nicht ueber
 * die Objekt-Id. Der Intune-Picker rechnet sie im Portal selbst um; wer die
 * Policy per API baut, muss es selbst tun — und genau hier verrennt man sich
 * leicht, weil eine GUID nicht Byte fuer Byte gelesen wird: Die ersten drei
 * Felder liegen im Speicher little-endian, die letzten acht Bytes so, wie sie
 * dastehen. Aus vier 32-Bit-Werten daraus wird S-1-12-1-a-b-c-d.
 */
function groupSid(objectId) {
  const hex = String(objectId || "").replace(/[{}]/g, "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw Object.assign(new Error("Ungültige Gruppen-Id: " + objectId), { status: 400 });
  }
  const b = Buffer.from(hex, "hex");
  // .NET-Byte-Reihenfolge einer GUID nachbauen: Data1 (4 Byte), Data2 (2),
  // Data3 (2) gedreht, Data4 (8) unveraendert.
  const le = Buffer.concat([
    Buffer.from(b.subarray(0, 4)).reverse(),
    Buffer.from(b.subarray(4, 6)).reverse(),
    Buffer.from(b.subarray(6, 8)).reverse(),
    b.subarray(8, 16)
  ]);
  const teile = [0, 4, 8, 12].map(off => le.readUInt32LE(off));
  return "S-1-12-1-" + teile.join("-");
}

/**
 * Das Konfigurations-XML der CSP.
 * action="U" heisst Update: Die genannten Mitglieder kommen dazu, bestehende
 * bleiben. "R" (Replace) wuerde die lokale Administratorengruppe leerraeumen —
 * inklusive des LAPS-Kontos und des eingebauten Administrators.
 */
function buildConfigXml(sids) {
  const eintraege = sids.map(s => `    <add member="${s}" />`).join("\n");
  return [
    "<GroupConfiguration>",
    `  <accessgroup desc="${BUILTIN_ADMINS_SID}">`,
    '    <group action="U" />',
    eintraege,
    "  </accessgroup>",
    "</GroupConfiguration>"
  ].join("\n");
}

function sanitizeProfileName(name) {
  return String(name || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "Einfuehrung";
}

function knownPrefixes(tenant) {
  return NAMING.candidates(NAME_KIND, { name: NAME_SEP }, tenant && tenant.id)
    .map(c => c.split(NAME_SEP)[0])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------- Gruppe
/**
 * Die Rollengruppe sicherstellen, deren Mitglieder waehrend der Einfuehrung
 * lokal Administrator sind. Idempotent ueber alle bekannten Namensschemata:
 * Ein Schemawechsel darf keine zweite Gruppe daneben erzeugen.
 *
 * Bewusst eine eigene, benannte Gruppe und keine bestehende Sammelgruppe: Wer
 * hier drin steht, hat auf den Geraeten der Einfuehrungsphase volle lokale
 * Rechte — das muss man an einer Stelle sehen und leeren koennen.
 */
async function ensureGroup(tenant, cert) {
  const namen = NAMING.candidates(GROUP_KIND, {}, tenant && tenant.id);
  const gesucht = namen.map(n => n.toLowerCase());

  const vorhanden = await graphAllPages(tenant, cert,
    "/groups?$filter=securityEnabled eq true&$select=id,displayName,description&$top=100", { retryTransient: true });
  const treffer = vorhanden.find(g => gesucht.includes(String(g.displayName || "").toLowerCase()));
  if (treffer) return { created: false, group: { id: treffer.id, displayName: treffer.displayName } };

  const displayName = namen[0];
  const created = await graphReq(tenant, cert, "POST", "/groups", {
    displayName,
    description: "Befristete Ausnahme: Mitglieder sind während der Einführungsphase lokale Administratoren auf den zugewiesenen Geräten. Nach dem Rückbau leeren.",
    mailEnabled: false,
    mailNickname: displayName.replace(/[^A-Za-z0-9]/g, "").slice(0, 60) || "DeviceLocalAdminSetup",
    securityEnabled: true
  }, { retryTransient: true });

  return { created: true, group: { id: created.id, displayName: created.displayName } };
}

/** Mitglieder der Gruppe — die Oberflaeche zeigt sie, damit niemand raten muss. */
async function listMembers(tenant, cert, groupId) {
  const m = await graphAllPages(tenant, cert,
    `/groups/${encodeURIComponent(groupId)}/members?$select=id,displayName,userPrincipalName&$top=100`, { retryTransient: true });
  return m.map(u => ({ id: u.id, displayName: u.displayName || "", upn: u.userPrincipalName || "" }));
}

// ---------------------------------------------------------------- Profil
/** Vorhandene Profile dieses Werkzeugs. */
async function listProfiles(tenant, cert) {
  const all = await graphAllPages(tenant, cert,
    "/deviceManagement/deviceConfigurations?$select=id,displayName,description,lastModifiedDateTime", { retryTransient: true });
  const prefixes = knownPrefixes(tenant);
  const eigene = all.filter(c => prefixes.some(p => String(c.displayName || "").startsWith(p)));

  const out = [];
  for (const c of eigene) {
    let zuweisungen = [];
    try {
      const r = await graphReq(tenant, cert, "GET", `/deviceManagement/deviceConfigurations/${c.id}/assignments`, null, { retryTransient: true });
      zuweisungen = (r.value || []).map(a => (a.target && a.target.groupId) || null).filter(Boolean);
    } catch (e) { /* Zuweisungen sind Zusatzinfo */ }
    out.push({
      id: c.id,
      displayName: c.displayName,
      description: c.description || "",
      lastModified: c.lastModifiedDateTime || null,
      gruppenIds: zuweisungen
    });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Profil anlegen/aktualisieren und den Geraetegruppen der Einfuehrungsphase
 * zuweisen. `enddatum` ist Pflicht und landet in der Beschreibung des Profils —
 * damit steht es auch dort, wo jemand nachschaut, der dieses Werkzeug nie
 * gesehen hat.
 */
async function deployProfile(tenant, cert, { profileName, groupId, deviceGroupIds, enddatum }) {
  const clean = sanitizeProfileName(profileName);
  const ids = (Array.isArray(deviceGroupIds) ? deviceGroupIds : []).filter(Boolean);
  if (!ids.length) {
    throw Object.assign(new Error("Mindestens eine Gerätegruppe auswählen — die Ausnahme gehört an die Geräte der Einführungsphase, nie an den ganzen Bestand."), { status: 400 });
  }
  if (!groupId) {
    throw Object.assign(new Error("Keine Rollengruppe angegeben."), { status: 400 });
  }
  const ende = pruefeEnddatum(enddatum);

  const sid = groupSid(groupId);
  const name = NAMING.name(NAME_KIND, { name: clean }, tenant && tenant.id);

  const body = {
    "@odata.type": "#microsoft.graph.windows10CustomConfiguration",
    displayName: name,
    description: `Befristete Ausnahme bis ${ende.anzeige}: Mitglieder der zugewiesenen Rollengruppe sind auf diesen Geräten lokale Administratoren. `
      + "Rückbau ist Teil der Abnahme — Profil entfernen, Gruppe leeren. Erzeugt vom M365 Security Policy Manager.",
    omaSettings: [{
      "@odata.type": "#microsoft.graph.omaSettingString",
      displayName: "LocalUsersAndGroups/Configure",
      description: `Fügt die Gruppen-SID ${sid} der lokalen Administratorengruppe hinzu (action="U", bestehende Mitglieder bleiben).`,
      omaUri: OMA_URI,
      value: buildConfigXml([sid])
    }]
  };

  const all = await graphAllPages(tenant, cert,
    "/deviceManagement/deviceConfigurations?$select=id,displayName", { retryTransient: true });
  const wanted = NAMING.candidates(NAME_KIND, { name: clean }, tenant && tenant.id);
  const match = all.find(c => wanted.indexOf(c.displayName) >= 0);

  let profileId;
  if (match) {
    await graphReq(tenant, cert, "PATCH", `/deviceManagement/deviceConfigurations/${match.id}`, body, { retryTransient: true });
    profileId = match.id;
  } else {
    const created = await graphReq(tenant, cert, "POST", "/deviceManagement/deviceConfigurations", body, { retryTransient: true });
    profileId = created.id;
  }

  await graphReq(tenant, cert, "POST", `/deviceManagement/deviceConfigurations/${profileId}/assign`, {
    assignments: ids.map(g => ({ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: g } }))
  }, { retryTransient: true });

  return { profileId, displayName: match ? match.displayName : name, updated: !!match, sid, enddatum: ende.iso, gruppen: ids.length };
}

/**
 * Rueckbau: Profil loeschen. Die Gruppe bleibt bewusst stehen (sie ist der Ort,
 * an dem dokumentiert ist, wer die Ausnahme hatte) — geleert wird sie getrennt,
 * damit beides eine bewusste Handlung ist.
 */
async function removeProfile(tenant, cert, profileId) {
  await graphReq(tenant, cert, "DELETE", `/deviceManagement/deviceConfigurations/${encodeURIComponent(profileId)}`, null, { retryTransient: true });
  return { removed: true };
}

/** Gruppe leeren — der zweite Teil des Rueckbaus. */
async function clearGroup(tenant, cert, groupId) {
  const members = await listMembers(tenant, cert, groupId);
  let entfernt = 0;
  for (const m of members) {
    await graphReq(tenant, cert, "DELETE", `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(m.id)}/$ref`, null, { retryTransient: true });
    entfernt++;
  }
  return { entfernt };
}

/**
 * Enddatum pruefen: Pflicht, in der Zukunft, hoechstens ein halbes Jahr weg.
 * Die Obergrenze ist Absicht — "befristet" mit einem Datum in zwei Jahren ist
 * keine Befristung, sondern eine Ausrede.
 */
function pruefeEnddatum(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw Object.assign(new Error("Enddatum fehlt oder hat nicht das Format JJJJ-MM-TT."), { status: 400 });
  }
  const d = new Date(s + "T23:59:59");
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error("Enddatum ist kein gültiges Datum."), { status: 400 });
  const jetzt = new Date();
  if (d < jetzt) throw Object.assign(new Error("Das Enddatum liegt in der Vergangenheit."), { status: 400 });
  const maxTage = 183;
  if ((d - jetzt) / 86400000 > maxTage) {
    throw Object.assign(new Error(`Das Enddatum liegt mehr als ${maxTage} Tage in der Zukunft. Die Ausnahme ist für die Einführungsphase gedacht — für Dauerlösungen ist PIM der richtige Weg.`), { status: 400 });
  }
  return { iso: s, anzeige: `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` };
}

module.exports = {
  OMA_URI, BUILTIN_ADMINS_SID,
  groupSid, buildConfigXml, sanitizeProfileName, pruefeEnddatum,
  ensureGroup, listMembers, listProfiles, deployProfile, removeProfile, clearGroup
};
