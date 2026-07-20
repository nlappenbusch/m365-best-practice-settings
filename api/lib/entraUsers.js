/**
 * Entra-Nutzerverwaltung fuer die Conditional-Access-Schutzgruppen: bestehende
 * Nutzer suchen (Assignment-Assistent) und einen dedizierten Break-Glass-Nutzer
 * anlegen (Notfallzugriffskonto).
 */
const crypto = require("crypto");
const { graphReq } = require("./graph");

/** Nutzer per Name/UPN/Mail suchen (Advanced Query — braucht ConsistencyLevel: eventual). */
async function searchUsers(tenant, certPemPath, query) {
  const q = String(query || "").trim().replace(/'/g, "''");
  if (q.length < 2) return [];
  const props = ["displayName", "givenName", "surname", "mail", "userPrincipalName"];
  const filter = props.map(p => `startswith(${p},'${q}')`).join(" or ");
  const r = await graphReq(tenant, certPemPath, "GET",
    `/users?$filter=${filter}&$select=id,displayName,userPrincipalName,mail&$top=15&$orderby=displayName&$count=true`,
    null, { headers: { ConsistencyLevel: "eventual" }, retryTransient: true });
  return (r.value || []).map(u => ({ id: u.id, displayName: u.displayName, userPrincipalName: u.userPrincipalName, mail: u.mail }));
}

/** Starkes Zufallspasswort, das Entras Standard-Komplexitaet (3 von 4 Klassen) garantiert erfuellt. */
function generateStrongPassword() {
  const classes = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%^&*-_="];
  const pick = set => set[crypto.randomInt(set.length)];
  const chars = classes.map(pick);
  const all = classes.join("");
  while (chars.length < 24) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * Neuen Break-Glass-Nutzer anlegen. WICHTIG (Microsoft-Best-Practice fuer
 * Notfallzugriffskonten): forceChangePasswordNextSignIn bleibt false — ein
 * Konto, das beim ersten Login einen Passwortwechsel/MFA-Setup verlangt, ist
 * im echten Notfall (z.B. MFA-Ausfall) nutzlos. Das Passwort wird NUR in der
 * Rueckgabe dieses Aufrufs sichtbar — Graph speichert es nicht im Klartext,
 * ein spaeteres Auslesen ist nicht moeglich.
 */
async function createBreakGlassUser(tenant, certPemPath, domain, username) {
  const local = String(username || "").trim().toLowerCase().replace(/[^a-z0-9.\-_]/g, "");
  if (!local) throw new Error("Ungueltiger Benutzername.");
  const upn = `${local}@${domain}`;
  const password = generateStrongPassword();
  const created = await graphReq(tenant, certPemPath, "POST", "/users", {
    accountEnabled: true,
    displayName: `Break-Glass (${local})`,
    mailNickname: local,
    userPrincipalName: upn,
    passwordProfile: { password, forceChangePasswordNextSignIn: false },
    passwordPolicies: "DisablePasswordExpiration"
  });
  return { id: created.id, userPrincipalName: upn, password };
}

module.exports = { searchUsers, createBreakGlassUser };
