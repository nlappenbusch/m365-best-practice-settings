/**
 * Administrative Rollen: wer hat erhöhte Rechte, und wie kam er dazu.
 *
 * Ausschliesslich lesend. Der Blick, den man bei einer Übernahme oder einem
 * Audit als erstes braucht: welche Rollen sind besetzt, wer sitzt drin, und
 * bei den Globalen Administratoren zusätzlich, über welche Gruppen sie
 * hängen — eine Gruppenmitgliedschaft ist der Weg, auf dem Rechte unbemerkt
 * wandern.
 *
 * Graph liefert nur AKTIVIERTE Verzeichnisrollen unter /directoryRoles.
 * Rollen, die nie vergeben wurden, existieren dort schlicht nicht — das ist
 * kein Fehler, sondern bedeutet "niemand hat sie".
 */
const { graphReq, graphAllPages } = require("./graph");

// Rollen, bei denen genauer hingeschaut wird. Global Administrator zuerst.
const HIGH_PRIVILEGE = [
  { match: /^(company|global) administrator$/i, key: "globalAdmin", label: "Globaler Administrator" },
  { match: /^privileged role administrator$/i, key: "privRole", label: "Administrator für privilegierte Rollen" },
  { match: /^privileged authentication administrator$/i, key: "privAuth", label: "Administrator für privilegierte Authentifizierung" },
  { match: /^security administrator$/i, key: "securityAdmin", label: "Sicherheitsadministrator" },
  { match: /^exchange administrator$/i, key: "exchangeAdmin", label: "Exchange-Administrator" },
  { match: /^intune administrator$/i, key: "intuneAdmin", label: "Intune-Administrator" },
  { match: /^user administrator$/i, key: "userAdmin", label: "Benutzeradministrator" },
  { match: /^application administrator$/i, key: "appAdmin", label: "Anwendungsadministrator" },
  { match: /^cloud application administrator$/i, key: "cloudAppAdmin", label: "Cloudanwendungsadministrator" }
];

function classify(roleName) {
  const hit = HIGH_PRIVILEGE.find(h => h.match.test(String(roleName || "").trim()));
  return hit ? hit.key : null;
}

function memberType(m) {
  const t = String(m["@odata.type"] || "").toLowerCase();
  if (t.includes("serviceprincipal")) return "servicePrincipal";
  if (t.includes("group")) return "group";
  return "user";
}

async function loadAdminRoles(tenant, cert) {
  const opts = { retryTransient: true };
  const roles = await graphAllPages(tenant, cert, "/directoryRoles?$select=id,displayName,description,roleTemplateId", opts);

  const out = [];
  const userCache = new Map();   // userId -> Detaildaten (mehrfach besetzte Konten nur einmal laden)

  for (const role of roles) {
    let members = [];
    try {
      members = await graphAllPages(tenant, cert,
        `/directoryRoles/${encodeURIComponent(role.id)}/members?$select=id,displayName,userPrincipalName,accountEnabled,onPremisesSyncEnabled,userType`, opts);
    } catch (e) {
      out.push({ id: role.id, displayName: role.displayName, privilege: classify(role.displayName), error: e.message, members: [] });
      continue;
    }

    const mapped = members.map(m => {
      const entry = {
        id: m.id,
        type: memberType(m),
        displayName: m.displayName || "",
        upn: m.userPrincipalName || "",
        accountEnabled: m.accountEnabled !== false,
        // Aus dem lokalen AD synchronisiert: fuer privilegierte Rollen die
        // Microsoft-Empfehlung ausdruecklich NICHT (ein kompromittiertes AD
        // reicht sonst bis in den Tenant).
        synced: m.onPremisesSyncEnabled === true,
        guest: m.userType === "Guest"
      };
      if (entry.type === "user" && !userCache.has(m.id)) userCache.set(m.id, entry);
      return entry;
    });

    out.push({
      id: role.id,
      displayName: role.displayName,
      description: role.description || "",
      privilege: classify(role.displayName),
      members: mapped
    });
  }

  // Gruppenmitgliedschaften nur fuer die Globalen Administratoren aufloesen —
  // fuer alle Rollenmitglieder waeren das zu viele Abfragen, und interessant
  // ist genau diese Gruppe.
  const gaRole = out.find(r => r.privilege === "globalAdmin");
  const globalAdmins = [];
  for (const m of (gaRole ? gaRole.members : [])) {
    const rec = { ...m, groups: [], otherRoles: [] };
    if (m.type === "user") {
      try {
        const groups = await graphAllPages(tenant, cert,
          `/users/${encodeURIComponent(m.id)}/memberOf?$select=id,displayName,groupTypes,membershipRule`, opts);
        rec.groups = groups
          .filter(g => String(g["@odata.type"] || "").toLowerCase().includes("group"))
          .map(g => ({
            id: g.id,
            displayName: g.displayName,
            dynamic: Array.isArray(g.groupTypes) && g.groupTypes.includes("DynamicMembership")
          }));
      } catch (e) { rec.groupsError = e.message; }
    }
    // In welchen weiteren Rollen sitzt derselbe Account?
    rec.otherRoles = out
      .filter(r => r.privilege !== "globalAdmin" && r.members.some(x => x.id === m.id))
      .map(r => r.displayName);
    globalAdmins.push(rec);
  }

  const findings = [];
  const activeGa = globalAdmins.filter(g => g.accountEnabled);
  if (activeGa.length === 0) {
    findings.push({ state: "crit", text: "Kein aktiver Globaler Administrator gefunden." });
  } else if (activeGa.length < 2) {
    findings.push({ state: "warn", text: "Nur ein aktiver Globaler Administrator — kein Break-Glass-Konto vorhanden." });
  } else if (activeGa.length > 4) {
    findings.push({ state: "warn", text: `${activeGa.length} aktive Globale Administratoren — Microsoft empfiehlt höchstens vier.` });
  }
  for (const g of globalAdmins.filter(g => g.synced)) {
    findings.push({ state: "crit", text: `${g.upn || g.displayName} ist aus dem lokalen AD synchronisiert — privilegierte Konten sollten cloud-only sein.` });
  }
  for (const g of globalAdmins.filter(g => g.guest)) {
    findings.push({ state: "crit", text: `${g.upn || g.displayName} ist ein Gastkonto mit Globaler Administratorrolle.` });
  }
  for (const g of globalAdmins.filter(g => g.type === "servicePrincipal")) {
    findings.push({ state: "warn", text: `Dienstprinzipal „${g.displayName}" hat die Globale Administratorrolle.` });
  }

  return {
    generatedAt: new Date().toISOString(),
    roles: out.sort((a, b) => (b.privilege ? 1 : 0) - (a.privilege ? 1 : 0) || a.displayName.localeCompare(b.displayName)),
    globalAdmins,
    findings,
    totals: {
      rolesInUse: out.filter(r => r.members.length).length,
      distinctAccounts: new Set(out.flatMap(r => r.members.map(m => m.id))).size,
      globalAdmins: globalAdmins.length,
      activeGlobalAdmins: activeGa.length
    }
  };
}

// Rollenvorlage "Global Administrator" — fest, tenant-unabhängig.
const GLOBAL_ADMIN_TEMPLATE = "62e90394-69f5-4237-9190-012177145e10";

/**
 * Verzeichnisrolle im Tenant besorgen. Rollen existieren unter
 * /directoryRoles erst, wenn sie mindestens einmal vergeben wurden — sonst
 * muessen sie aus der Vorlage aktiviert werden.
 */
async function ensureRole(tenant, cert, templateId) {
  const opts = { retryTransient: true };
  const existing = await graphAllPages(tenant, cert, "/directoryRoles?$select=id,displayName,roleTemplateId", opts);
  const hit = existing.find(r => r.roleTemplateId === templateId);
  if (hit) return hit;
  return graphReq(tenant, cert, "POST", "/directoryRoles", { roleTemplateId: templateId }, opts);
}

async function listGlobalAdmins(tenant, cert) {
  const role = await ensureRole(tenant, cert, GLOBAL_ADMIN_TEMPLATE);
  const members = await graphAllPages(tenant, cert,
    `/directoryRoles/${encodeURIComponent(role.id)}/members?$select=id,displayName,userPrincipalName,accountEnabled`,
    { retryTransient: true });
  return { role, members };
}

/** Benutzer zum Globalen Administrator machen. */
async function assignGlobalAdmin(tenant, cert, userId) {
  const { role, members } = await listGlobalAdmins(tenant, cert);
  if (members.some(m => m.id === userId)) return { ok: true, alreadyMember: true, roleId: role.id };

  await graphReq(tenant, cert, "POST", `/directoryRoles/${encodeURIComponent(role.id)}/members/$ref`, {
    "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`
  }, { retryTransient: true });
  return { ok: true, roleId: role.id };
}

/**
 * Rolle entziehen. Beim Globalen Administrator wird verhindert, dass der
 * letzte aktive entfernt wird — ein Tenant ohne Globalen Administrator laesst
 * sich nur noch ueber den Microsoft-Support zurueckholen.
 */
async function removeGlobalAdmin(tenant, cert, userId) {
  const { role, members } = await listGlobalAdmins(tenant, cert);
  const target = members.find(m => m.id === userId);
  if (!target) { const e = new Error("Dieses Konto hat die Rolle nicht."); e.status = 404; throw e; }

  const activeOthers = members.filter(m => m.id !== userId && m.accountEnabled !== false);
  if (activeOthers.length === 0) {
    const e = new Error("Das ist der letzte aktive Globale Administrator — Entfernen würde den Tenant führungslos zurücklassen.");
    e.status = 409;
    throw e;
  }

  await graphReq(tenant, cert, "DELETE",
    `/directoryRoles/${encodeURIComponent(role.id)}/members/${encodeURIComponent(userId)}/$ref`, null, { retryTransient: true });
  return { ok: true, remainingActive: activeOthers.length };
}

/**
 * Benutzerkonto loeschen. Zwei Sicherungen, weil das nicht zurueckzunehmen ist
 * (Graph legt es 30 Tage in den Papierkorb, danach ist es weg):
 *  - der UPN muss vom Aufrufer wortwoertlich mitgeschickt werden
 *  - ein aktiver Globaler Administrator wird nicht geloescht, solange er die
 *    Rolle noch traegt
 */
async function deleteUser(tenant, cert, userId, confirmUpn) {
  const user = await graphReq(tenant, cert, "GET",
    `/users/${encodeURIComponent(userId)}?$select=id,displayName,userPrincipalName,accountEnabled`, null, { retryTransient: true });

  if (String(confirmUpn || "").trim().toLowerCase() !== String(user.userPrincipalName || "").toLowerCase()) {
    const e = new Error("Bestätigung stimmt nicht mit dem Anmeldenamen überein.");
    e.status = 400;
    throw e;
  }

  const { members } = await listGlobalAdmins(tenant, cert);
  if (members.some(m => m.id === userId)) {
    const e = new Error("Dieses Konto ist Globaler Administrator — erst die Rolle entziehen, dann löschen.");
    e.status = 409;
    throw e;
  }

  await graphReq(tenant, cert, "DELETE", `/users/${encodeURIComponent(userId)}`, null, { retryTransient: true });
  return { ok: true, deleted: user.userPrincipalName };
}

module.exports = {
  loadAdminRoles, HIGH_PRIVILEGE,
  assignGlobalAdmin, removeGlobalAdmin, deleteUser, GLOBAL_ADMIN_TEMPLATE
};
