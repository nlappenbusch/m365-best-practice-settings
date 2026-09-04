/**
 * Admin-Panel: Übersicht über die Geheimnisse, die dieses Werkzeug hält.
 *
 * Grundhaltung: Die Übersicht zeigt, WELCHE Geheimnisse existieren und in
 * welchem Zustand — nicht deren Werte. Jedes Einblenden ist ein eigener,
 * bestätigter Aufruf und landet im Audit-Log.
 *
 * Warum nicht alles auf einmal rendern: Hier liegen die Zertifikats-
 * Privatschlüssel für jeden angebundenen Kundentenant, mit Rechten bis
 * RoleManagement.ReadWrite.Directory. Eine Seite, die sie gleichzeitig anzeigt,
 * macht aus einem übernommenen Browser-Tab oder einem Screenshot die
 * Kompromittierung sämtlicher Mandate. Einzeln einblenden kostet einen Klick
 * und begrenzt genau das.
 *
 * Zwei Dinge sind bewusst NICHT abrufbar und werden nur als Zustand gelistet:
 *   - MCP-API-Keys   → nur als SHA-256-Hash gespeichert; der Klartext wird
 *                      einmalig bei der Erzeugung gezeigt
 *   - Admin-Passwort → gesalzener Hash; Quelle der Wahrheit ist ADMIN_PASSWORD
 * Das Panel behauptet nicht, sie zeigen zu können.
 */
const fs = require("fs");
const crypto = require("crypto");

// Umgebungsvariablen, die das Panel überhaupt kennt. Bewusst eine feste Liste
// statt process.env durchzureichen — sonst wäre jede künftige Variable
// automatisch über die Weboberfläche abrufbar.
const ENV_SECRETS = [
  ["ADMIN_PASSWORD", "Anmeldung an diesem Werkzeug (Quelle der Wahrheit, überschreibt den gespeicherten Hash)", "hoch", "Dieses Werkzeug"],
  ["ANTHROPIC_API_KEY", "KI-Funktionen: Vorschläge und Maester-Erklärungen", "mittel", "Angebundene Dienste"],
  ["SDP_API_KEY", "ServiceDesk Plus — Ticket-Copilot, Worklogs", "mittel", "Angebundene Dienste"],
  ["BD_API_KEY", "Bitdefender GravityZone — Paketabruf und Installationsstatus", "mittel", "Angebundene Dienste"],
  ["RMM_API_KEY", "N-sight RMM — Geräte- und Agent-Abfragen", "mittel", "Angebundene Dienste"]
];

// Begleitende Einstellungen ohne Geheimnischarakter. Sie stehen hier, weil die
// Frage «womit spricht das Werkzeug nach draussen?» sonst nur zur Haelfte
// beantwortet ist — ein Key ohne die zugehoerige Gegenstelle sagt wenig.
const ENV_CONFIG = [
  ["BD_HOST", "GravityZone-Gegenstelle"],
  ["RMM_SERVER", "N-sight-Gegenstelle"],
  ["SDP_BASE_URL", "ServiceDesk-Plus-Gegenstelle"],
  ["SDP_OWNER_ID", "Technikerkonto für Worklogs"],
  ["ADMIN_USER", "Anmeldename an diesem Werkzeug"],
  ["ANTHROPIC_MODEL", "verwendetes Sprachmodell"],
  ["STATE_DIR", "Ablage für Zustand und Zertifikate"]
];

// Integrationen, die bewusst OHNE hinterlegte Zugangsdaten arbeiten. Auch das
// ist eine Antwort auf die Frage, was das Werkzeug haelt: naemlich nichts.
const CREDENTIAL_FREE = [
  {
    id: "info:forticlient",
    kind: "FortiClient / Fortigate",
    label: "FortiClient-Installer",
    scope: "forticlient.igeekscloud.ch",
    note: "Speichert keine Zugangsdaten. Das Werkzeug laedt den Installer von einer fest verdrahteten, vertrauenswuerdigen URL — andere Hosts weist es ab. Die site-spezifische Ordner-URL wird pro Einsatz angegeben, nicht hinterlegt."
  },
  {
    id: "info:bitwarden",
    kind: "Bitwarden",
    label: "Bitwarden-Desktop-App",
    scope: "Intune-Win32-App",
    note: "Speichert keine Zugangsdaten. Es wird nur das oeffentliche Installationspaket verpackt und ueber Intune verteilt; die Region wird beim Ausrollen mitgegeben."
  }
];

function maskValue(v) {
  const s = String(v || "");
  if (!s) return "";
  if (s.length <= 8) return "•".repeat(s.length);
  return s.slice(0, 3) + "…" + s.slice(-3) + `  (${s.length} Zeichen)`;
}

function collectSecrets(loadState, certPemPath) {
  const s = loadState();
  const out = [];

  // 1. Zertifikats-Privatschlüssel je Tenant — das Wertvollste hier.
  for (const t of (s.tenants || [])) {
    const p = certPemPath(t.tenantId);
    let exists = false, size = 0, mtime = null, notAfter = null, subject = null;
    try {
      const st = fs.statSync(p);
      exists = true; size = st.size; mtime = st.mtime.toISOString();
      try {
        const x = new crypto.X509Certificate(fs.readFileSync(p, "utf8"));
        notAfter = x.validTo; subject = x.subject;
      } catch (e) { /* PEM enthält evtl. nur den Schlüssel, kein Zertifikat */ }
    } catch (e) { /* Datei nicht vorhanden */ }
    out.push({
      id: "cert:" + t.tenantId,
      group: "Kundentenants",
      kind: "Zertifikat (Privatschlüssel)",
      label: t.name || t.tenantId,
      scope: t.organization || t.tenantId,
      recoverable: exists,
      editable: true,
      editHint: "PEM mit privatem Schlüssel. Der vorherige Stand wird als .bak daneben gelegt.",
      severity: "hoch",
      meta: {
        "Vorhanden": exists ? "ja" : "nein",
        "Grösse": exists ? size + " Bytes" : "—",
        "Geändert": mtime ? mtime.slice(0, 19).replace("T", " ") : "—",
        "Fingerabdruck": t.certThumbprint || "—",
        "Gültig bis": notAfter || "—",
        "Antragsteller": subject || "—",
        "App-Id": t.clientId || "—",
        "Datei": p
      },
      note: exists ? null : "Datei fehlt — die Anmeldung an diesem Tenant schlägt fehl. «Reparieren» im Tab Tenants legt ein neues Zertifikat an."
    });
  }

  // 2. SSO-Clientgeheimnis (Anmeldung über den igeeks-Tenant)
  if (s.sso && s.sso.clientSecret) {
    out.push({
      id: "sso:clientSecret", group: "Dieses Werkzeug", kind: "SSO-Clientgeheimnis", label: "Anmeldung über igeeks-Tenant",
      scope: s.sso.tenantId || "—", recoverable: true, severity: "hoch",
      editable: true,
      editHint: "Nach dem Rotieren im Entra-Portal hier eintragen.",
      meta: {
        "Client-Id": s.sso.clientId || "—",
        "Tenant-Id": s.sso.tenantId || "—",
        "Wert": maskValue(s.sso.clientSecret)
      }
    });
  }

  // 3. Sitzungsgeheimnis
  if (s.sessionSecret) {
    out.push({
      id: "state:sessionSecret", group: "Dieses Werkzeug", kind: "Sitzungsgeheimnis", label: "Signiert die Anmelde-Cookies",
      scope: "dieses Werkzeug", recoverable: true, severity: "mittel",
      editable: true,
      editHint: "Mindestens 16 Zeichen. Meldet beim Speichern alle offenen Sitzungen ab, auch die eigene.",
      meta: { "Wert": maskValue(s.sessionSecret) },
      note: "Wird es geändert, sind alle offenen Sitzungen sofort ungültig."
    });
  }

  // 4. Umgebungsvariablen mit Geheimnischarakter
  for (const [name, desc, severity, group] of ENV_SECRETS) {
    const v = process.env[name];
    out.push({
      id: "env:" + name, group, kind: "Umgebungsvariable", label: name, scope: "Prozess",
      recoverable: !!v, severity,
      editable: false,
      meta: {
        "Zweck": desc,
        "Gesetzt": v ? "ja" : "nein",
        "Wert": v ? maskValue(v) : "—",
        "Ändern auf m365.nerdag.ch": "GitHub Secret " + name + " im Repo nlappenbusch/m365-best-practice-settings (Settings → Secrets and variables → Actions), danach Deploy auslösen",
        "Ändern auf igeeks-prod": "Vault: kv-v2/<cluster>/m365-configurator#" + name + ", danach Pod neu starten"
      },
      note: (v ? "" : "Nicht gesetzt — die zugehörige Funktion steht damit nicht zur Verfügung. ") +
        "Hier bewusst nur zur Ansicht: Der Wert kommt beim Start aus der Umgebung des Containers. " +
        "Zur Laufzeit gesetzt würde er beim nächsten Deploy oder Pod-Neustart überschrieben — " +
        "das Panel würde also eine Änderung vortäuschen, die nicht hält."
    });
  }

  // 4b. Integrationen ohne hinterlegte Zugangsdaten
  for (const c of CREDENTIAL_FREE) {
    out.push(Object.assign({}, c, {
      group: "Angebundene Dienste", recoverable: false, severity: "—", meta: {}
    }));
  }

  // 4c. Begleitende Einstellungen, damit die Gegenstellen sichtbar sind.
  //     Kein Geheimnis, deshalb direkt im Klartext.
  out.push({
    id: "info:envConfig", group: "Angebundene Dienste",
    kind: "Einstellungen (kein Geheimnis)", label: "Gegenstellen und Betriebswerte",
    scope: "Prozess", recoverable: false, severity: "—",
    meta: Object.fromEntries(ENV_CONFIG.map(([n, d]) => [n, (process.env[n] || "— nicht gesetzt") + "   (" + d + ")"])),
    note: "Diese Werte tragen kein Geheimnis und stehen deshalb offen. Sie zeigen, mit welchen Gegenstellen das Werkzeug spricht."
  });

  // 5. Nicht wiederherstellbar — der Vollständigkeit halber gelistet, damit
  //    niemand sie hier sucht und glaubt, sie wären verloren gegangen.
  const keys = s.mcpApiKeys || [];
  out.push({
    id: "info:mcpKeys", group: "Nicht abrufbar", kind: "MCP-API-Keys", label: keys.length + " Key(s)",
    scope: "MCP-Clients", recoverable: false, severity: "—",
    meta: Object.fromEntries(keys.map(k => [
      k.label || k.id,
      "erstellt " + String(k.createdAt || "?").slice(0, 10) + ", zuletzt genutzt " + (k.lastUsedAt ? String(k.lastUsedAt).slice(0, 10) : "nie")
    ])),
    note: "Nur als SHA-256-Hash gespeichert. Der Klartext erscheint einmalig bei der Erzeugung und ist danach weg — auch für Admins. Verloren heisst: neuen Key ausstellen und den alten widerrufen."
  });
  out.push({
    id: "info:adminPassword", group: "Nicht abrufbar", kind: "Admin-Passwort", label: (s.auth && s.auth.username) || "admin",
    scope: "dieses Werkzeug", recoverable: false, severity: "—",
    meta: { "Verfahren": "gesalzener Hash", "Salz hinterlegt": (s.auth && s.auth.salt) ? "ja" : "—" },
    note: "Als gesalzener Hash gespeichert, nicht rückrechenbar. Ändern geht über die Umgebungsvariable ADMIN_PASSWORD."
  });

  return out;
}

function revealSecret(id, loadState, certPemPath) {
  const s = loadState();

  if (id.startsWith("cert:")) {
    const tenantId = id.slice(5);
    const t = (s.tenants || []).find(x => x.tenantId === tenantId);
    let value;
    try { value = fs.readFileSync(certPemPath(tenantId), "utf8"); }
    catch (e) { return { status: 404, error: "Zertifikatsdatei nicht gefunden." }; }
    return { label: t ? (t.name || tenantId) : tenantId, value };
  }
  if (id === "sso:clientSecret") return { label: "SSO-Clientgeheimnis", value: s.sso && s.sso.clientSecret };
  if (id === "state:sessionSecret") return { label: "Sitzungsgeheimnis", value: s.sessionSecret };
  if (id.startsWith("env:")) {
    const name = id.slice(4);
    if (!ENV_SECRETS.some(e => e[0] === name)) {
      return { status: 400, error: "Diese Umgebungsvariable ist nicht freigegeben." };
    }
    return { label: name, value: process.env[name] };
  }
  return { status: 400, error: "Unbekanntes oder nicht wiederherstellbares Geheimnis." };
}

/**
 * Was sich hier überhaupt ändern lässt.
 *
 * Nur was im Zustand oder als Datei liegt. Umgebungsvariablen stehen bewusst
 * NICHT drin: Sie kommen aus der Umgebung des Containers (GitHub-Secret,
 * Compose). Ein zur Laufzeit gesetzter Wert würde nur den laufenden Prozess
 * betreffen und beim nächsten Neustart verschwinden — das Panel würde also
 * etwas versprechen, das nicht hält.
 */
const EDITABLE = {
  "sso:clientSecret": {
    label: "SSO-Clientgeheimnis",
    multiline: false,
    hint: "Nach dem Rotieren im Entra-Portal hier das neue Geheimnis eintragen. Bis dahin schlägt die Anmeldung über den igeeks-Tenant fehl.",
    apply(state, value) { state.sso = Object.assign({}, state.sso || {}, { clientSecret: value }); }
  },
  "state:sessionSecret": {
    label: "Sitzungsgeheimnis",
    multiline: false,
    hint: "Ändern meldet sofort ALLE offenen Sitzungen ab, auch die eigene. Danach neu anmelden.",
    minLength: 16,
    apply(state, value) { state.sessionSecret = value; }
  }
};

function isCertId(id) { return id.startsWith("cert:"); }

function updateSecret(id, value, deps) {
  const { loadState, saveState, certPemPath } = deps;

  // Zertifikatsdateien: liegen auf der Platte, nicht im Zustand.
  if (isCertId(id)) {
    const tenantId = id.slice(5);
    const s = loadState();
    const t = (s.tenants || []).find(x => x.tenantId === tenantId);
    if (!t) return { status: 404, error: "Tenant nicht gefunden." };
    if (!/-----BEGIN [A-Z ]+-----/.test(value) || !/-----END [A-Z ]+-----/.test(value)) {
      return { status: 400, error: "Das sieht nicht nach einem PEM aus (BEGIN/END-Block fehlt). Nichts geändert." };
    }
    const p = certPemPath(tenantId);
    // Vorherigen Stand danebenlegen, damit ein Fehlgriff nicht endgültig ist.
    try { if (fs.existsSync(p)) fs.copyFileSync(p, p + ".bak"); } catch (e) { /* egal */ }
    fs.writeFileSync(p, value, "utf8");
    return {
      label: t.name || tenantId,
      warning: "Die Anmeldung gelingt nur, wenn das zugehörige öffentliche Zertifikat an der App-Registrierung hinterlegt ist. Passt es nicht, meldet Graph AADSTS700027 — «Reparieren» im Tab Tenants richtet das ein. Der vorherige Stand liegt als .bak daneben."
    };
  }

  const def = EDITABLE[id];
  if (!def) return { status: 400, error: "Dieses Geheimnis lässt sich hier nicht ändern." };
  if (def.minLength && value.length < def.minLength) {
    return { status: 400, error: `Mindestens ${def.minLength} Zeichen. Nichts geändert.` };
  }
  const s = loadState();
  def.apply(s, value);
  saveState(s);
  return { label: def.label, warning: def.hint };
}

/**
 * Hängt die Endpunkte ein.
 * deps: { loadState, saveState, certPemPath, logMcpAction }
 */
function mountAdminSecrets(app, deps) {
  const { loadState, saveState, certPemPath, logMcpAction } = deps;
  // Zugriffsschranke fuer den ganzen Bereich. Faellt sie weg (aeltere Aufrufer),
  // bleibt das Verhalten wie vorher -- der Server soll daran nicht starten-brechen.
  const allowed = deps.requireSecretsAccess || (() => true);

  app.get("/api/admin/secrets", (req, res) => {
    if (!allowed(req, res)) return;
    res.json({ ok: true, secrets: collectSecrets(loadState, certPemPath) });
  });

  app.post("/api/admin/secrets/reveal", (req, res) => {
    if (!allowed(req, res)) return;
    const b = req.body || {};
    const id = String(b.id || "");
    if (b.confirm !== true) return res.status(400).json({ error: "Bestätigung fehlt (confirm: true)." });

    const r = revealSecret(id, loadState, certPemPath);
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    if (!r.value) return res.status(404).json({ error: "Kein Wert hinterlegt." });

    logMcpAction({ actor: "admin-panel", action: "Geheimnis eingeblendet", detail: r.label + " (" + id + ")" });
    res.json({ ok: true, id, label: r.label, value: r.value });
  });

  // Schreiben passiert ausschliesslich hier — beim ausdruecklichen Speichern.
  // Das Bearbeiten in der Oberflaeche aendert bis dahin nichts.
  app.post("/api/admin/secrets/update", (req, res) => {
    if (!allowed(req, res)) return;
    const b = req.body || {};
    const id = String(b.id || "");
    const value = String(b.value != null ? b.value : "");
    if (b.confirm !== true) return res.status(400).json({ error: "Bestätigung fehlt (confirm: true)." });
    if (!value.trim()) return res.status(400).json({ error: "Leerer Wert — nichts geändert." });

    const r = updateSecret(id, value, { loadState, saveState, certPemPath });
    if (r.error) return res.status(r.status || 400).json({ error: r.error });

    logMcpAction({ actor: "admin-panel", action: "Geheimnis geändert", detail: r.label + " (" + id + ")" });
    res.json({ ok: true, id, label: r.label, warning: r.warning || null });
  });
}

module.exports = { mountAdminSecrets, collectSecrets, revealSecret, updateSecret, maskValue };
