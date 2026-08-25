/**
 * GroupTag-Verwaltung: dynamische Gerätegruppen und Autopilot-Zuordnung.
 *
 * Das GroupTag-Konzept haengt an einer Konvention: eine dynamische Security
 * Group, deren Mitgliedschaftsregel auf `[OrderID]:<Tag>` in devicePhysicalIds
 * prueft. Autopilot schreibt den GroupTag eines Geraets genau dorthin. Ohne
 * passende Gruppe laeuft ein GroupTag ins Leere -- das Geraet bekommt weder
 * Profil noch Policies.
 *
 * Zwei Zugangswege, weil dieses Modul an zwei Stellen gebraucht wird:
 *  - onboardete Tenants: Zertifikat der Management-App (tenant + certPemPath)
 *  - Migrations-Zieltenant: nur Client-ID + Secret, dort gibt es kein Zertifikat
 * Deshalb `access` als kleiner gemeinsamer Nenner statt zwei Codepfaden.
 */
const GRAPHLIB = require("./graph");

const GRAPH_V1 = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";

/** access: { kind:"cert", tenant, certPemPath } | { kind:"token", accessToken } */
async function req(access, method, path, body, opts) {
  if (access.kind === "cert") {
    return GRAPHLIB.graphReq(access.tenant, access.certPemPath, method, path, body, opts);
  }
  const base = (opts && opts.beta) ? GRAPH_BETA : GRAPH_V1;
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + access.accessToken,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) {
    const e = new Error((j && j.error && j.error.message) || text || ("Graph " + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

async function allPages(access, path, opts) {
  if (access.kind === "cert") {
    return GRAPHLIB.graphAllPages(access.tenant, access.certPemPath, path, opts);
  }
  const out = [];
  let next = path;
  while (next) {
    const page = next.startsWith("https://")
      ? await (async () => {
          const r = await fetch(next, { headers: { Authorization: "Bearer " + access.accessToken } });
          const t = await r.text();
          if (!r.ok) { const e = new Error(t); e.status = r.status; throw e; }
          return JSON.parse(t);
        })()
      : await req(access, "GET", next, null, opts);
    out.push(...(page.value || []));
    next = page["@odata.nextLink"] || null;
  }
  return out;
}

/** Token per client_credentials — fuer Tenants ohne hinterlegtes Zertifikat. */
async function tokenFromSecret(tenantName, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "client_credentials", client_id: clientId,
    client_secret: clientSecret, scope: "https://graph.microsoft.com/.default"
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantName)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error("Anmeldung fehlgeschlagen: " + (j.error_description || j.error || r.status));
    e.status = 400;
    throw e;
  }
  return j.access_token;
}

const TAG_RE = /\[OrderID\]:([^"'\s)]+)/gi;

function tagsFromRule(rule) {
  const out = [];
  let m;
  const re = new RegExp(TAG_RE.source, "gi");
  while ((m = re.exec(String(rule || ""))) !== null) out.push(m[1].trim());
  return out;
}

/** Name der Gruppe zu einem Tag — Konvention aus dem Autopilot-Bereich. */
function groupNameForTag(tag) { return "AAD-" + tag; }

/** Mitgliedschaftsregel für einen GroupTag. */
function ruleForTag(tag) {
  return `(device.devicePhysicalIds -any (_ -eq "[OrderID]:${tag}"))`;
}

/** Alle dynamischen Gerätegruppen mit den darin referenzierten GroupTags. */
async function listGroups(access) {
  const groups = await allPages(access,
    "/groups?$filter=" + encodeURIComponent("groupTypes/any(c:c eq 'DynamicMembership') and securityEnabled eq true") +
    "&$select=id,displayName,membershipRule,membershipRuleProcessingState&$top=100", { beta: true });

  return groups.map(g => ({
    id: g.id,
    displayName: g.displayName,
    rule: g.membershipRule || "",
    state: g.membershipRuleProcessingState || "",
    tags: tagsFromRule(g.membershipRule)
  })).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Autopilot-Geräte mit GroupTag und dem tatsächlichen Benutzer.
 *
 * Das Autopilot-Objekt kennt nur `userPrincipalName` — das ist die optionale
 * Vorabzuweisung ("dieses Gerät ist für Frau X reserviert") und in der Praxis
 * fast immer leer. Wer ein Gerät wirklich benutzt, steht am Intune-Objekt.
 * Deshalb werden die verwalteten Geräte einmal mitgeladen und über die
 * Seriennummer zugeordnet — ein Aufruf, nicht einer pro Gerät.
 */
async function listDevices(access) {
  const devices = await allPages(access,
    "/deviceManagement/windowsAutopilotDeviceIdentities?$top=200", { beta: true });

  const bySerial = new Map();
  try {
    const managed = await allPages(access,
      "/deviceManagement/managedDevices?$select=id,deviceName,serialNumber,userPrincipalName,userDisplayName,lastSyncDateTime&$top=500");
    for (const m of managed) {
      const key = String(m.serialNumber || "").trim().toLowerCase();
      if (key) bySerial.set(key, m);
    }
  } catch (e) {
    // Ohne DeviceManagementManagedDevices.Read bleibt die Spalte leer statt
    // die ganze Liste scheitern zu lassen.
  }

  return devices.map(d => {
    const m = bySerial.get(String(d.serialNumber || "").trim().toLowerCase()) || null;
    return {
      id: d.id,
      serialNumber: d.serialNumber || "",
      model: d.model || "",
      manufacturer: d.manufacturer || "",
      groupTag: d.groupTag || "",
      // Autopilot-Vorabzuweisung — meist leer, deshalb getrennt ausgewiesen
      assignedUser: d.userPrincipalName || "",
      // Tatsächlicher Benutzer und Gerätename aus Intune
      deviceName: m ? (m.deviceName || "") : "",
      user: m ? (m.userPrincipalName || "") : "",
      userDisplayName: m ? (m.userDisplayName || "") : "",
      lastSync: m ? (m.lastSyncDateTime || null) : null,
      enrollmentState: d.enrollmentState || "",
      lastContact: d.lastContactedDateTime || null
    };
  }).sort((a, b) => (a.groupTag || "~").localeCompare(b.groupTag || "~") || a.serialNumber.localeCompare(b.serialNumber));
}

/**
 * Dynamische Gruppe für einen GroupTag anlegen. Existiert bereits eine Gruppe,
 * deren Regel den Tag enthaelt, wird NICHTS angelegt -- zwei Gruppen auf
 * denselben Tag waeren stille Doppelzuweisungen.
 */
async function createGroupForTag(access, tag, displayName) {
  const clean = String(tag || "").trim();
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(clean)) {
    const e = new Error("GroupTag: nur Buchstaben, Ziffern, - und _ (max. 60 Zeichen).");
    e.status = 400;
    throw e;
  }

  const existing = await listGroups(access);
  const clash = existing.find(g => g.tags.includes(clean));
  if (clash) {
    return { created: false, reason: "exists", group: clash };
  }

  const name = String(displayName || "").trim() || groupNameForTag(clean);
  const created = await req(access, "POST", "/groups", {
    displayName: name,
    description: `Autopilot-Geräte mit GroupTag ${clean} (automatisch angelegt)`,
    mailEnabled: false,
    mailNickname: name.replace(/[^A-Za-z0-9]/g, "").slice(0, 60) || ("aad" + Date.now()),
    securityEnabled: true,
    groupTypes: ["DynamicMembership"],
    membershipRule: ruleForTag(clean),
    membershipRuleProcessingState: "On"
  });

  return {
    created: true,
    group: { id: created.id, displayName: created.displayName, rule: created.membershipRule, tags: [clean], state: "On" }
  };
}

/**
 * GroupTag eines Autopilot-Geraets setzen. Die Zuordnung zur Gruppe passiert
 * danach von selbst — die dynamische Regel greift, sobald Entra neu auswertet
 * (kann einige Minuten dauern).
 */
async function setDeviceTag(access, deviceId, tag) {
  const clean = String(tag || "").trim();
  if (clean && !/^[A-Za-z0-9_-]{1,60}$/.test(clean)) {
    const e = new Error("GroupTag: nur Buchstaben, Ziffern, - und _ (max. 60 Zeichen).");
    e.status = 400;
    throw e;
  }
  await req(access, "POST",
    `/deviceManagement/windowsAutopilotDeviceIdentities/${encodeURIComponent(deviceId)}/updateDeviceProperties`,
    { groupTag: clean }, { beta: true });
  return { ok: true, groupTag: clean };
}

module.exports = {
  tokenFromSecret, listGroups, listDevices, createGroupForTag, setDeviceTag,
  tagsFromRule, ruleForTag, groupNameForTag
};
