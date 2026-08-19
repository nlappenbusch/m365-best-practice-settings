"use strict";
/**
 * Direkte Schreib-Aktionen auf einzelne Nutzerkonten -- Gegenstueck zum
 * generischen Tenant-weiten Policy-Import (customPolicy.js). Jede Aktion ist
 * bewusst einzeln kuratiert und nutzt ausschliesslich offiziell dokumentierte,
 * stabile Graph-v1.0-Endpunkte (keine geratenen/instabilen Payload-Strukturen
 * wie beim Settings-Catalog-Import).
 *
 * Permission: alle Aktionen ausser resetUserMfa laufen ueber Berechtigungen,
 * die GRAPH_APP_PERMS bereits abdeckt (User.ReadWrite.All, Group.ReadWrite.All).
 * resetUserMfa braucht zusaetzlich UserAuthenticationMethod.ReadWrite.All --
 * bestehende Tenants brauchen dafuer einmal "Reparieren" (server.js).
 */
const { graphReq } = require("./graph");
const { generateStrongPassword } = require("./entraUsers");

// Auth-Methoden-Typ -> Plural-Pfadsegment fuer die typ-spezifische Delete-Route
// (Graph erlaubt kein Loeschen ueber den generischen /authentication/methods/
// {id}-Pfad, nur ueber den typ-spezifischen). Nur die in der Praxis haeufigen
// Typen -- unbekannte Typen werden bewusst NICHT geloescht, sondern gemeldet.
const AUTH_METHOD_DELETE_PATH = {
  "#microsoft.graph.phoneAuthenticationMethod": "phoneMethods",
  "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod": "microsoftAuthenticatorMethods",
  "#microsoft.graph.fido2AuthenticationMethod": "fido2Methods",
  "#microsoft.graph.softwareOathAuthenticationMethod": "softwareOathMethods",
  "#microsoft.graph.temporaryAccessPassAuthenticationMethod": "temporaryAccessPassMethods",
  "#microsoft.graph.emailAuthenticationMethod": "emailMethods"
};

/** MFA zuruecksetzen: alle bekannten Nicht-Passwort-Methoden entfernen. */
async function resetUserMfa(tenant, cert, userId) {
  const methods = await graphReq(tenant, cert, "GET", `/users/${encodeURIComponent(userId)}/authentication/methods`, null, {});
  const list = (methods.value || []).filter(m => m["@odata.type"] !== "#microsoft.graph.passwordAuthenticationMethod");
  const removed = [], skipped = [];
  for (const m of list) {
    const seg = AUTH_METHOD_DELETE_PATH[m["@odata.type"]];
    if (!seg) { skipped.push({ type: m["@odata.type"], reason: "Unbekannter Methodentyp -- nicht automatisch entfernt." }); continue; }
    try {
      await graphReq(tenant, cert, "DELETE", `/users/${encodeURIComponent(userId)}/authentication/${seg}/${encodeURIComponent(m.id)}`, null, {});
      removed.push({ type: m["@odata.type"], displayName: m.displayName || null });
    } catch (e) {
      skipped.push({ type: m["@odata.type"], reason: e.message });
    }
  }
  if (!removed.length && !skipped.length) skipped.push({ type: null, reason: "Keine MFA-Methoden registriert (nur Passwort)." });
  return { removed, skipped };
}

/** Temporaeres Passwort setzen -- Standard-Graph-Pattern (kein Beta noetig). */
async function resetUserPassword(tenant, cert, userId) {
  const tempPassword = generateStrongPassword();
  await graphReq(tenant, cert, "PATCH", `/users/${encodeURIComponent(userId)}`, {
    passwordProfile: { password: tempPassword, forceChangePasswordNextSignIn: true }
  }, {});
  return { tempPassword };
}

/** Alle Sitzungen widerrufen (erzwingt Neuanmeldung ueberall). */
async function revokeUserSessions(tenant, cert, userId) {
  await graphReq(tenant, cert, "POST", `/users/${encodeURIComponent(userId)}/revokeSignInSessions`, {}, {});
  return { revoked: true };
}

/** Gruppenmitgliedschaft aendern (add/remove). */
async function changeGroupMembership(tenant, cert, userId, groupId, action) {
  if (action === "add") {
    await graphReq(tenant, cert, "POST", `/groups/${encodeURIComponent(groupId)}/members/$ref`, {
      "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`
    }, {});
  } else if (action === "remove") {
    await graphReq(tenant, cert, "DELETE", `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`, null, {});
  } else {
    throw Object.assign(new Error("Unbekannte Aktion: " + action + " (erwartet 'add' oder 'remove')."), { status: 400 });
  }
  return { action };
}

module.exports = { resetUserMfa, resetUserPassword, revokeUserSessions, changeGroupMembership };
