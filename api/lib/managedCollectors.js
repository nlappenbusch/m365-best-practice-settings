"use strict";
/**
 * Managed Service (MSP-Betrieb): Kollektoren.
 *
 * Jeder Kollektor liest den IST-Zustand EINES Bereichs aus dem Kundentenant —
 * ausschliesslich lesend — und liefert:
 *   metrics   Kennzahlen fuer Kacheln (label, value, state ok|warn|crit)
 *   data      die Detaildaten fuer die Fachansicht (gekappt)
 *   snapshot  { key -> Objekt } fuer die Drift-Erkennung (Vergleich mit dem
 *             vorigen Lauf bzw. mit der quittierten Baseline)
 *   findings  konkrete Befunde mit Kontext und Handlungsschritten
 *
 * Fehler bleiben im Kollektor: fehlt eine Lizenz (Entra P2, Defender) oder eine
 * Berechtigung, liefert genau dieser Bereich { ok:false, error } und alle
 * anderen laufen weiter. Eine Luecke muss sichtbar sein, nicht "alles gruen".
 *
 * Die Exchange-Bereiche (Threat Policies, Quarantaene, Inbox-Regeln,
 * Block-/Allow-Listen) laufen gemeinsam in EINER pwsh-Sitzung — jede
 * Connect-ExchangeOnline-Verbindung kostet 20–40 Sekunden.
 */
const { graphReq, graphAllPages } = require("./graph");
const EXO = require("./exorunner");
const EVIDENCE = require("./evidence");
const LICENSES = require("./licenses");
const CONDACCESS = require("./conditionalAccess");

const V1 = { retryTransient: 2 };
const BETA = { beta: true, retryTransient: 2 };
const DAY = 86400000;

const arr = v => Array.isArray(v) ? v : (v === null || v === undefined || v === "" ? [] : [v]);
const strip = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const cut = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const metric = (label, value, state, detail) => ({ label, value, state: state || "ok", detail: detail || null });
const isoDaysAgo = d => new Date(Date.now() - d * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

// Portal-Sprunglinks — Operations soll vom Befund direkt an die richtige Stelle.
const PORTAL = {
  ca: id => `https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/PolicyBlade/policyId/${encodeURIComponent(id)}`,
  caList: "https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies",
  riskyUsers: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/SecurityMenuBlade/~/RiskyUsers",
  riskDetections: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/SecurityMenuBlade/~/RiskDetections",
  user: id => `https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(id)}`,
  secureScore: "https://security.microsoft.com/securescore?viewid=actions",
  quarantine: "https://security.microsoft.com/quarantine",
  consentRequests: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AccessRequests",
  consentSettings: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ConsentPoliciesMenuBlade/~/UserSettings",
  messageCenter: id => `https://admin.microsoft.com/#/MessageCenter/:/messages/${encodeURIComponent(id)}`,
  licenses: "https://admin.microsoft.com/#/licenses",
  sharing: "https://admin.microsoft.com/sharepoint?page=sharing&modern=true",
  device: id => `https://intune.microsoft.com/#view/Microsoft_Intune_Devices/DeviceSettingsMenuBlade/~/overview/mdmDeviceId/${encodeURIComponent(id)}`,
  devices: "https://intune.microsoft.com/#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/allDevices",
  compliance: "https://intune.microsoft.com/#view/Microsoft_Intune_DeviceSettings/DevicesComplianceMenu/~/policies",
  threat: "https://security.microsoft.com/threatpolicy",
  tabl: "https://security.microsoft.com/tenantAllowBlockList",
  mailbox: "https://admin.exchange.microsoft.com/#/mailboxes",
  outbound: "https://security.microsoft.com/antispam"
};

// Aktive Service Plans des Tenants (fuer "nicht lizenziert" statt "Fehler").
// null = nicht lesbar -> der Aufrufer meldet dann den urspruenglichen Fehler.
async function tenantPlans(tenant, cert) {
  try {
    const skus = await graphAllPages(tenant, cert, "/subscribedSkus", V1);
    const plans = new Set();
    for (const s of skus) {
      if (!((s.prepaidUnits && s.prepaidUnits.enabled > 0) || s.consumedUnits > 0)) continue;
      for (const p of arr(s.servicePlans)) if (p.provisioningStatus === "Success") plans.add(String(p.servicePlanName || ""));
    }
    return plans;
  } catch (e) { return null; }
}
// Bereich ohne passende Lizenz: laeuft "ok", zeigt den Grund, erzeugt keine Befunde.
function unlicensed(product, note) {
  return { metrics: [metric("Lizenz", "kein " + product, "ok")], data: { unlicensed: product, note }, snapshot: {}, findings: [] };
}

// ============================================================ Conditional Access
// Felder, die sich bei jedem Lesen aendern oder nichts ueber die Wirkung sagen.
const CA_VOLATILE = new Set(["id", "createdDateTime", "modifiedDateTime", "templateId", "managed", "@odata.context"]);
function caNormalize(p) {
  const o = {};
  for (const [k, v] of Object.entries(p)) if (!CA_VOLATILE.has(k)) o[k] = v;
  return o;
}

async function collectCa(tenant, cert) {
  const all = await CONDACCESS.listAllPolicies(tenant, cert);
  const snapshot = {};
  for (const p of all) snapshot[p.id] = { name: p.displayName, state: p.state, managed: !!p.managed, body: caNormalize(p) };
  const enabled = all.filter(p => p.state === "enabled");
  const reportOnly = all.filter(p => p.state === "enabledForReportingButNotEnforced");
  const disabled = all.filter(p => p.state === "disabled");

  // Security Defaults: kleine Tenants (ohne Entra P1) schuetzen sich darueber
  // statt ueber CA. Beides schliesst sich aus — ohne erzwungene CA, aber mit
  // Security Defaults ist der Tenant nicht ungeschuetzt. null = nicht lesbar.
  let securityDefaults = null;
  try {
    const sd = await graphReq(tenant, cert, "GET", "/policies/identitySecurityDefaultsEnforcementPolicy", null, V1);
    securityDefaults = !!sd.isEnabled;
  } catch (e) { /* Policy.Read.All fehlt — dann bleibt es bei der CA-Sicht */ }

  const findings = [];
  if (!enabled.length && securityDefaults) {
    findings.push({
      key: "secdefaults-only", severity: "low", title: "Schutz nur über Security Defaults",
      summary: `Keine CA-Policy erzwungen (${all.length} vorhanden, davon ${reportOnly.length} Report-only), aber Security Defaults sind aktiv: MFA-Registrierung, MFA für Admins, Legacy Auth blockiert. Grundschutz vorhanden, aber ohne Ausnahmen, Gerätebedingungen oder Standortregeln.`,
      steps: ["Bewusster Zustand (kein Entra ID P1)? Dann quittieren.",
        "Mit Entra ID P1 (z. B. Business Premium): CA-Baseline vorbereiten und Security Defaults erst beim Scharfschalten der CA-Policies abschalten — beides gleichzeitig geht nicht."],
      links: [{ label: "CA-Policies", url: PORTAL.caList }], tab: "ca"
    });
  } else if (!enabled.length) {
    findings.push({
      key: "no-enabled", severity: "critical", title: "Keine aktive Conditional-Access-Policy",
      summary: `Im Tenant ist keine einzige CA-Policy erzwungen (${all.length} vorhanden, davon ${reportOnly.length} Report-only)${securityDefaults === false ? " und Security Defaults sind aus — kein MFA-Zwang über Entra." : "."}`,
      context: [["Security Defaults", securityDefaults === false ? "aus" : "nicht lesbar"]],
      steps: [securityDefaults === false ? "Sofort: entweder Security Defaults einschalten (ohne P1) oder die CA-Baseline scharf schalten." : "Prüfen, ob Security Defaults stattdessen aktiv sind (Entra → Eigenschaften).",
        "igeeks-CA-Baseline im Bereich «Conditional Access»: Report-only-Ergebnisse prüfen, dann ringweise erzwingen.",
        "Mindestens MFA für alle Benutzer und Block Legacy Auth erzwingen."],
      links: [{ label: "CA-Policies", url: PORTAL.caList }], tab: "ca"
    });
  }
  // igeeks-verwaltete Baseline-Policies (BP_), die nicht erzwungen sind.
  // Ab sechs gebuendelt: ein komplett im Report-only-Modus stehender Rollout
  // (z. B. 32 Policies) soll die Arbeitsliste nicht mit Einzelbefunden fluten.
  const notEnforced = all.filter(x => x.managed && x.state !== "enabled");
  if (notEnforced.length > 5) {
    findings.push({
      key: "bp-not-enforced-bulk", severity: enabled.length ? "medium" : "high",
      title: `${notEnforced.length} Baseline-Policies nicht erzwungen`,
      summary: `${notEnforced.filter(p => p.state === "enabledForReportingButNotEnforced").length} im Report-only-Modus, ${notEnforced.filter(p => p.state === "disabled").length} deaktiviert. Der Baseline-Rollout ist nicht abgeschlossen — die Policies protokollieren nur, sie schützen nicht.`,
      context: [["Beispiele", notEnforced.slice(0, 6).map(p => p.displayName).join(" · ")]],
      steps: ["Report-only-Ergebnisse der letzten 14 Tage in den Anmeldeprotokollen prüfen (Filter «Conditional Access: Report-only»).",
        "Ringweise scharf schalten (Pilot → UAT → Broad) im Bereich «Conditional Access», zuerst MFA und Block Legacy Auth.",
        "Bewusst nicht erzwungene Policies einzeln dokumentieren und diesen Befund mit Begründung quittieren."],
      links: [{ label: "CA-Policies", url: PORTAL.caList }], tab: "ca",
      evidence: notEnforced.slice(0, 40).map(p => ({ policy: p.displayName, status: p.state === "disabled" ? "Deaktiviert" : "Report-only" }))
    });
  }
  for (const p of notEnforced.length > 5 ? [] : notEnforced) {
    findings.push({
      key: "bp-not-enforced:" + p.id, severity: "medium",
      title: `Baseline-Policy nicht erzwungen: ${p.displayName}`,
      summary: `Status «${p.state === "disabled" ? "Deaktiviert" : "Report-only"}». Die Policy gehört zur igeeks-Baseline, wirkt aber nicht.`,
      context: [["Policy", p.displayName], ["Status", p.state]],
      steps: ["Report-only-Ergebnisse der letzten 14 Tage in den Anmeldeprotokollen prüfen (Spalte «Report-only»).",
        "Wenn keine unerwarteten Blockierungen: Policy auf «Ein» stellen — Ring für Ring.",
        "Bewusste Ausnahme? Dann Befund quittieren und Begründung als Notiz festhalten."],
      links: [{ label: "Policy öffnen", url: PORTAL.ca(p.id) }], tab: "ca"
    });
  }
  return {
    metrics: [
      metric("Policies", all.length, all.length ? "ok" : "crit"),
      metric("Erzwungen", enabled.length, enabled.length ? "ok" : "crit"),
      metric("Report-only", reportOnly.length, reportOnly.length ? "warn" : "ok"),
      metric("Deaktiviert", disabled.length, disabled.length ? "warn" : "ok")
    ],
    data: { policies: all.map(p => ({ id: p.id, name: p.displayName, state: p.state, managed: !!p.managed, modified: p.modifiedDateTime || p.createdDateTime || null })) },
    snapshot, findings
  };
}

// Wer hat die Policy zuletzt angefasst? Fuer Drift-Befunde der wichtigste Kontext.
async function lastPolicyActor(tenant, cert, policyId) {
  try {
    const r = await graphReq(tenant, cert, "GET",
      `/auditLogs/directoryAudits?$filter=${encodeURIComponent(`targetResources/any(t:t/id eq '${policyId}')`)}&$top=1`, null, V1);
    const e = (r.value || [])[0];
    if (!e) return null;
    const ib = e.initiatedBy || {};
    return {
      at: e.activityDateTime, activity: e.activityDisplayName,
      actor: (ib.user && (ib.user.userPrincipalName || ib.user.displayName)) || (ib.app && ib.app.displayName) || "unbekannt"
    };
  } catch (e) { return null; }
}

// ============================================================ Identity Protection
async function collectRisk(tenant, cert) {
  const gaps = [];
  let riskyUsers = [];
  try {
    riskyUsers = await graphAllPages(tenant, cert,
      "/identityProtection/riskyUsers?$select=id,userPrincipalName,userDisplayName,riskLevel,riskState,riskDetail,riskLastUpdatedDateTime&$top=500", V1);
  } catch (e) { gaps.push("Risky Users nicht lesbar (Entra ID P2 + IdentityRiskyUser.Read.All): " + e.message); }
  let detections = [];
  try {
    detections = await graphAllPages(tenant, cert,
      `/identityProtection/riskDetections?$filter=${encodeURIComponent("detectedDateTime ge " + isoDaysAgo(14))}&$top=500`, V1);
  } catch (e) { gaps.push("Risikoerkennungen nicht lesbar (IdentityRiskEvent.Read.All): " + e.message); }
  if (gaps.length === 2) {
    // Ohne Entra ID P1/P2 gibt es keine Identity Protection — das ist kein
    // Lesefehler, sondern ein Lizenzzustand, und soll auch so dastehen.
    const plans = await tenantPlans(tenant, cert);
    if (plans && ![...plans].some(p => /^AAD_PREMIUM/.test(p))) return unlicensed("Entra ID P1/P2", "Risikobenutzer und Anmelderisiken gibt es erst mit Entra ID P1 (eingeschränkt) bzw. P2.");
    throw new Error(gaps.join(" · "));
  }

  const atRisk = riskyUsers.filter(u => u.riskState === "atRisk" || u.riskState === "confirmedCompromised");
  const signIn = detections.filter(d => String(d.activity || "").toLowerCase() === "signin");
  const userRisk = detections.filter(d => String(d.activity || "").toLowerCase() === "user");

  const byUser = new Map();
  for (const d of detections) {
    const k = String(d.userPrincipalName || d.userId || "").toLowerCase();
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(d);
  }

  const findings = [];
  for (const u of atRisk) {
    const det = (byUser.get(String(u.userPrincipalName || "").toLowerCase()) || [])
      .sort((a, b) => String(b.detectedDateTime).localeCompare(String(a.detectedDateTime)));
    const compromised = u.riskState === "confirmedCompromised";
    const sev = compromised || u.riskLevel === "high" ? "critical" : u.riskLevel === "medium" ? "high" : "medium";
    const where = det.filter(d => d.location).slice(0, 3)
      .map(d => [d.location.city, d.location.countryOrRegion].filter(Boolean).join(", ") + (d.ipAddress ? ` (${d.ipAddress})` : ""));
    findings.push({
      key: "user:" + u.id, severity: sev, entity: String(u.userPrincipalName || "").toLowerCase(),
      title: `${compromised ? "Kompromittiert bestätigt" : "Risikobenutzer"}: ${u.userDisplayName || u.userPrincipalName}`,
      summary: `Benutzerrisiko «${u.riskLevel}» (${u.riskDetail || u.riskState}), zuletzt aktualisiert ${String(u.riskLastUpdatedDateTime || "").slice(0, 10)}.` +
        (det.length ? ` ${det.length} Erkennung(en) in 14 Tagen: ${[...new Set(det.map(d => d.riskEventType))].slice(0, 4).join(", ")}.` : ""),
      context: [["Konto", u.userPrincipalName], ["Risiko", `${u.riskLevel} / ${u.riskState}`],
        ...(where.length ? [["Herkunft", where.join(" · ")]] : [])],
      steps: [
        "Mit dem Benutzer telefonisch (nicht per Mail) klären, ob die Anmeldungen von ihm stammen.",
        "Wenn nicht eindeutig: Sitzungen widerrufen und Passwort-Reset erzwingen (Bereich «Tickets» → Benutzeraktionen).",
        "Registrierte MFA-Methoden des Kontos prüfen — neu hinzugefügte unbekannte Methoden entfernen.",
        "Inbox-Regeln und Weiterleitungen des Postfachs prüfen (siehe Bereich «Postfächer» in dieser Ansicht).",
        "Danach Risiko in Entra als «Kompromittierung verworfen» oder «bestätigt» markieren."
      ],
      links: [{ label: "Risky Users", url: PORTAL.riskyUsers }, { label: "Benutzer", url: PORTAL.user(u.id) }],
      evidence: det.slice(0, 10).map(d => ({ at: d.detectedDateTime, typ: d.riskEventType, level: d.riskLevel, ip: d.ipAddress || "", ort: d.location ? [d.location.city, d.location.countryOrRegion].filter(Boolean).join(", ") : "" }))
    });
  }
  // Hohe Sign-in-Risiken ohne (noch) erhoehtes Benutzerrisiko: eigener Befund,
  // gebuendelt pro Benutzer, damit ein Angriffsversuch nicht 30 Zeilen erzeugt.
  for (const [upn, list] of byUser) {
    if (atRisk.some(u => String(u.userPrincipalName || "").toLowerCase() === upn)) continue;
    const hi = list.filter(d => String(d.activity).toLowerCase() === "signin" && d.riskLevel === "high" && d.riskState !== "remediated" && d.riskState !== "dismissed");
    if (!hi.length) continue;
    findings.push({
      key: "signin:" + upn, severity: "high", entity: upn,
      title: `Hohes Anmelderisiko: ${upn}`,
      summary: `${hi.length} Anmeldung(en) mit hohem Risiko in 14 Tagen (${[...new Set(hi.map(d => d.riskEventType))].join(", ")}).`,
      context: [["Konto", upn], ["Letzte", String(hi[0].detectedDateTime || "").slice(0, 16).replace("T", " ")]],
      steps: ["Anmeldeprotokoll des Kontos filtern: waren die Anmeldungen erfolgreich?",
        "Erfolgreich und nicht vom Benutzer: wie bei kompromittiertem Konto vorgehen (Sitzungen widerrufen, Passwort, MFA-Methoden).",
        "Prüfen, ob eine CA-Policy für Anmelderisiko «hoch» greift — wenn nicht, ist das eine Lücke."],
      links: [{ label: "Risikoerkennungen", url: PORTAL.riskDetections }],
      evidence: hi.slice(0, 10).map(d => ({ at: d.detectedDateTime, typ: d.riskEventType, ip: d.ipAddress || "", ort: d.location ? [d.location.city, d.location.countryOrRegion].filter(Boolean).join(", ") : "" }))
    });
  }

  const snapshot = {};
  for (const u of atRisk) snapshot[u.id] = { upn: u.userPrincipalName, level: u.riskLevel, state: u.riskState };
  return {
    metrics: [
      metric("Risikobenutzer", atRisk.length, atRisk.some(u => u.riskLevel === "high") ? "crit" : atRisk.length ? "warn" : "ok"),
      metric("Sign-in-Risiken 14 T.", signIn.length, signIn.some(d => d.riskLevel === "high") ? "warn" : "ok"),
      metric("User-Risiken 14 T.", userRisk.length, userRisk.length ? "warn" : "ok")
    ],
    data: {
      gaps,
      riskyUsers: atRisk.map(u => ({ id: u.id, upn: u.userPrincipalName, name: u.userDisplayName, level: u.riskLevel, state: u.riskState, detail: u.riskDetail, updated: u.riskLastUpdatedDateTime })),
      detections: detections.slice(0, 200).map(d => ({ at: d.detectedDateTime, upn: d.userPrincipalName, activity: d.activity, typ: d.riskEventType, level: d.riskLevel, state: d.riskState, ip: d.ipAddress || "", ort: d.location ? [d.location.city, d.location.countryOrRegion].filter(Boolean).join(", ") : "" }))
    },
    snapshot, findings
  };
}

// ============================================================ Secure Score
async function collectScore(tenant, cert) {
  const scores = (await graphReq(tenant, cert, "GET", "/security/secureScores?$top=90", null, V1)).value || [];
  if (!scores.length) throw new Error("Keine Secure-Score-Daten (SecurityEvents.Read.All fehlt oder Tenant zu neu).");
  scores.sort((a, b) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)));
  const latest = scores[scores.length - 1];
  const pct = s => s && s.maxScore ? Math.round((s.currentScore / s.maxScore) * 1000) / 10 : null;
  const trend = scores.map(s => ({ d: String(s.createdDateTime).slice(0, 10), score: Math.round(s.currentScore * 10) / 10, max: s.maxScore, pct: pct(s) }));
  const weekAgo = scores.find(s => new Date(s.createdDateTime).getTime() >= Date.now() - 8 * DAY) || scores[0];
  const monthAgo = scores.find(s => new Date(s.createdDateTime).getTime() >= Date.now() - 31 * DAY) || scores[0];
  const comparative = {};
  for (const c of arr(latest.averageComparativeScores)) {
    if (c.basis && c.averageScore !== undefined) comparative[c.basis] = Math.round(c.averageScore * 10) / 10;
  }

  let profiles = [];
  try { profiles = await graphAllPages(tenant, cert, "/security/secureScoreControlProfiles?$top=500", V1); } catch (e) { /* Massnahmen optional */ }
  const current = new Map(arr(latest.controlScores).map(c => [c.controlName, c]));
  const measures = [];
  for (const p of profiles) {
    if (p.deprecated) continue;
    const st = arr(p.controlStateUpdates).slice(-1)[0];
    const state = st && st.state ? st.state : "Default";
    if (/ignored|thirdparty|resolved/i.test(state)) continue;
    const cs = current.get(p.id);
    const have = cs ? Number(cs.score) || 0 : 0;
    const gain = Math.round(((Number(p.maxScore) || 0) - have) * 10) / 10;
    if (gain <= 0) continue;
    measures.push({
      id: p.id, title: p.title, category: p.controlCategory, service: p.service, gain, maxScore: p.maxScore, have,
      cost: p.implementationCost || "", impact: p.userImpact || "", tier: p.tier || "", actionType: p.actionType || "",
      rank: p.rank || 999, remediation: cut(strip(p.remediation), 1200), why: cut(strip(p.remediationImpact), 600),
      url: p.actionUrl || PORTAL.secureScore, implementation: cs ? (cs.implementationStatus || "") : ""
    });
  }
  const costRank = { Low: 0, Moderate: 1, High: 2 };
  measures.sort((a, b) => b.gain - a.gain || (costRank[a.cost] ?? 1) - (costRank[b.cost] ?? 1) || a.rank - b.rank);
  // Quick Wins: geringer Aufwand, kaum Benutzerauswirkung, spuerbarer Gewinn.
  for (const m of measures) m.quickWin = (m.cost === "Low" && /low|none/i.test(m.impact || "Low") && m.gain >= 2);

  const cur = pct(latest);
  const delta7 = Math.round(((cur || 0) - (pct(weekAgo) || 0)) * 10) / 10;
  const delta30 = Math.round(((cur || 0) - (pct(monthAgo) || 0)) * 10) / 10;
  const top = measures.slice(0, 10);
  const potential = Math.round(Math.min(100, ((latest.currentScore + top.reduce((n, m) => n + m.gain, 0)) / latest.maxScore) * 100) * 10) / 10;

  const findings = [];
  if (delta7 <= -3) {
    findings.push({
      key: "drop7", severity: delta7 <= -8 ? "high" : "medium",
      title: `Secure Score in 7 Tagen um ${Math.abs(delta7)} Prozentpunkte gefallen`,
      summary: `Von ${pct(weekAgo)}% auf ${cur}%. Ein Rückgang heisst: eine Einstellung wurde zurückgenommen oder neue Pflichtkontrollen kamen dazu.`,
      steps: ["Secure-Score-Verlauf im Defender-Portal öffnen (Registerkarte «Verlauf»): welche Kontrolle hat Punkte verloren?",
        "Gegen die Changes/Evidence dieses Tenants abgleichen — wer hat was wann geändert?",
        "Ungewollte Rücknahme: Einstellung wiederherstellen. Gewollt: Befund mit Begründung quittieren."],
      links: [{ label: "Secure Score", url: "https://security.microsoft.com/securescore?viewid=history" }], tab: "score"
    });
  }
  for (const m of measures.filter(x => x.quickWin).slice(0, 5)) {
    findings.push({
      key: "qw:" + m.id, severity: "low", title: `Quick Win Secure Score (+${m.gain}): ${m.title}`,
      summary: `Geringer Aufwand, geringe Benutzerauswirkung. Bereich ${m.category || "—"}${m.service ? " · " + m.service : ""}.`,
      steps: m.remediation ? m.remediation.split(/\n+/).filter(Boolean).slice(0, 6) : ["Massnahme im Defender-Portal öffnen und umsetzen."],
      links: [{ label: "Massnahme öffnen", url: m.url }], tab: "score"
    });
  }

  return {
    metrics: [
      metric("Secure Score", cur !== null ? cur + "%" : "—", cur === null ? "warn" : cur < 40 ? "crit" : cur < 60 ? "warn" : "ok",
        `${Math.round(latest.currentScore)} / ${Math.round(latest.maxScore)} Punkte`),
      metric("Δ 7 Tage", (delta7 > 0 ? "+" : "") + delta7, delta7 < -3 ? "crit" : delta7 < 0 ? "warn" : "ok"),
      metric("Δ 30 Tage", (delta30 > 0 ? "+" : "") + delta30, delta30 < -3 ? "warn" : "ok"),
      metric("Potenzial Top 10", potential + "%", "ok")
    ],
    data: {
      current: { pct: cur, score: latest.currentScore, max: latest.maxScore, at: latest.createdDateTime, delta7, delta30, potential, licensedUsers: latest.licensedUserCount, activeUsers: latest.activeUserCount },
      comparative, trend, measures: measures.slice(0, 40)
    },
    snapshot: { score: { pct: cur } },
    findings
  };
}

// ============================================================ App-Consent-Anfragen
const HIGH_RISK_SCOPES = /^(Mail\.ReadWrite|Mail\.Send|Mail\.Read|MailboxSettings\.ReadWrite|Files\.ReadWrite\.All|Files\.Read\.All|Sites\.ReadWrite\.All|Sites\.FullControl\.All|Directory\.ReadWrite\.All|User\.ReadWrite\.All|full_access_as_user|EWS\.AccessAsUser\.All|Contacts\.ReadWrite|Calendars\.ReadWrite|Notes\.ReadWrite\.All|Application\.ReadWrite\.All|RoleManagement\.ReadWrite\.Directory)$/i;

async function collectConsent(tenant, cert) {
  const requests = await graphAllPages(tenant, cert,
    `/identityGovernance/appConsent/appConsentRequests?$filter=${encodeURIComponent("userConsentRequests/any(u:u/status eq 'InProgress')")}`, V1);
  const out = [];
  for (const r of requests.slice(0, 50)) {
    let users = [];
    try {
      users = await graphAllPages(tenant, cert,
        `/identityGovernance/appConsent/appConsentRequests/${encodeURIComponent(r.id)}/userConsentRequests?$filter=${encodeURIComponent("status eq 'InProgress'")}`, V1);
    } catch (e) { /* Details optional */ }
    const scopes = arr(r.pendingScopes).map(s => s.displayName).filter(Boolean);
    out.push({
      id: r.id, appId: r.appId, app: r.appDisplayName, scopes, risky: scopes.filter(s => HIGH_RISK_SCOPES.test(s)),
      requests: users.map(u => ({
        by: (u.createdBy && u.createdBy.user && (u.createdBy.user.userPrincipalName || u.createdBy.user.displayName)) || "?",
        at: u.createdDateTime, reason: cut(u.reason, 400)
      }))
    });
  }
  // Rahmenbedingungen: darf der Benutzer ueberhaupt selbst zustimmen?
  let userConsent = null, workflow = null;
  try {
    const az = await graphReq(tenant, cert, "GET", "/policies/authorizationPolicy", null, V1);
    const pol = arr((az.defaultUserRolePermissions || {}).permissionGrantPoliciesAssigned || (az.value && az.value[0] && az.value[0].defaultUserRolePermissions.permissionGrantPoliciesAssigned));
    userConsent = pol.some(p => /legacy/i.test(p)) ? "all" : pol.some(p => /low/i.test(p)) ? "low" : pol.length ? "custom" : "none";
  } catch (e) { /* optional */ }
  try {
    const w = await graphReq(tenant, cert, "GET", "/policies/adminConsentRequestPolicy", null, V1);
    workflow = { enabled: !!w.isEnabled, reviewers: arr(w.reviewers).length, durationDays: w.requestDurationInDays };
  } catch (e) { /* optional */ }

  const findings = [];
  for (const r of out) {
    const latest = r.requests.map(x => x.at).sort().slice(-1)[0];
    findings.push({
      key: "req:" + r.id, severity: r.risky.length ? "high" : "medium", entity: r.appId,
      title: `App-Consent-Anfrage: ${r.app || r.appId}`,
      summary: `${r.requests.length || 1} Benutzer warten auf Freigabe. Angefragt: ${r.scopes.slice(0, 8).join(", ") || "—"}` +
        (r.risky.length ? `. Kritische Berechtigungen: ${r.risky.join(", ")}.` : "."),
      context: [["App", r.app || "—"], ["App-ID", r.appId], ["Angefragt von", r.requests.map(x => x.by).slice(0, 5).join(", ") || "—"],
        ...(latest ? [["Letzte Anfrage", String(latest).slice(0, 10)]] : []),
        ...(r.requests.find(x => x.reason) ? [["Begründung", r.requests.find(x => x.reason).reason]] : [])],
      steps: [
        "Herausgeber prüfen: verifizierter Publisher? Bekannter Hersteller? Datenschutz-/AGB-Links vorhanden?",
        r.risky.length ? `Kritische Rechte (${r.risky.join(", ")}) nur freigeben, wenn der Zweck fachlich begründet ist — sonst ablehnen.` : "Angefragte Rechte gegen den genannten Zweck abgleichen.",
        "Bei Freigabe: auf die anfragenden Benutzer bzw. eine Gruppe einschränken («Zuweisung erforderlich» setzen).",
        "Entscheid dem Benutzer zurückmelden — Ablehnung mit Begründung."
      ],
      links: [{ label: "Consent-Anfragen", url: PORTAL.consentRequests }], tab: "consent"
    });
  }
  if (userConsent === "all") {
    findings.push({
      key: "userconsent-all", severity: "high", title: "Benutzer dürfen jeder App selbst Berechtigungen erteilen",
      summary: "Die Einwilligungsrichtlinie erlaubt Benutzer-Consent für alle Apps (Legacy-Einstellung). Das ist der klassische Weg für Consent-Phishing.",
      steps: ["Entra → Unternehmensanwendungen → Einwilligung und Berechtigungen: «Benutzereinwilligung für Apps von verifizierten Herausgebern, für ausgewählte Berechtigungen» oder «Nicht zulassen» wählen.",
        "Gleichzeitig den Admin-Consent-Workflow aktivieren, damit Benutzer stattdessen anfragen können."],
      links: [{ label: "Einwilligungseinstellungen", url: PORTAL.consentSettings }], tab: "consent"
    });
  }
  if (workflow && !workflow.enabled) {
    findings.push({
      key: "workflow-off", severity: "low", title: "Admin-Consent-Workflow ist ausgeschaltet",
      summary: "Benutzer können keine Freigabe anfragen — sie bleiben ohne Rückmeldung blockiert oder weichen auf Schatten-IT aus. Anfragen landen dann auch nicht in diesem Monitoring.",
      steps: ["Entra → Unternehmensanwendungen → Einwilligung und Berechtigungen → Admin-Consent-Einstellungen: «Benutzer können Administratoreinwilligung anfordern» = Ja.",
        "Prüfer: die igeeks-Betreuungsgruppe bzw. die Kunden-IT eintragen."],
      links: [{ label: "Einwilligungseinstellungen", url: PORTAL.consentSettings }], tab: "consent"
    });
  }
  const snapshot = {};
  for (const r of out) snapshot[r.id] = { app: r.app, scopes: r.scopes, n: r.requests.length };
  return {
    metrics: [
      metric("Offene Anfragen", out.length, out.some(r => r.risky.length) ? "crit" : out.length ? "warn" : "ok"),
      metric("Benutzer-Consent", userConsent === "all" ? "alle Apps" : userConsent === "low" ? "eingeschränkt" : userConsent === "none" ? "aus" : userConsent || "—", userConsent === "all" ? "crit" : "ok"),
      metric("Anfrage-Workflow", workflow ? (workflow.enabled ? "aktiv" : "aus") : "—", workflow && !workflow.enabled ? "warn" : "ok")
    ],
    data: { requests: out, userConsent, workflow },
    snapshot, findings
  };
}

// ============================================================ Geraete-Compliance
async function collectDevices(tenant, cert) {
  let devices;
  try {
    devices = await graphAllPages(tenant, cert,
      "/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,userPrincipalName,managedDeviceOwnerType,isEncrypted,model,manufacturer&$top=999", V1);
  } catch (e) {
    const plans = await tenantPlans(tenant, cert);
    if (plans && ![...plans].some(p => /INTUNE/.test(p))) return unlicensed("Intune", "Ohne Intune-Lizenz gibt es keine verwalteten Geräte und keine Compliance.");
    throw e;
  }
  let policies = null, settings = null;
  try { policies = await graphAllPages(tenant, cert, "/deviceManagement/deviceCompliancePolicies?$select=id,displayName", V1); } catch (e) { /* optional */ }
  try { settings = (await graphReq(tenant, cert, "GET", "/deviceManagement/settings", null, BETA)) || null; } catch (e) {
    try { settings = ((await graphReq(tenant, cert, "GET", "/deviceManagement?$select=settings", null, V1)) || {}).settings || null; } catch (e2) { /* optional */ }
  }
  const now = Date.now();
  const stale = d => d.lastSyncDateTime && now - new Date(d.lastSyncDateTime).getTime() > 30 * DAY;
  const nonCompliant = devices.filter(d => d.complianceState === "noncompliant");
  const grace = devices.filter(d => d.complianceState === "inGracePeriod");
  const unknown = devices.filter(d => ["unknown", "notApplicable", "configManager"].includes(d.complianceState));
  const staleList = devices.filter(stale);
  const compliant = devices.filter(d => d.complianceState === "compliant").length;
  const rate = devices.length ? Math.round((compliant / devices.length) * 1000) / 10 : null;
  const byOs = {};
  for (const d of devices) {
    const os = d.operatingSystem || "Unbekannt";
    byOs[os] = byOs[os] || { total: 0, compliant: 0, noncompliant: 0 };
    byOs[os].total++;
    if (d.complianceState === "compliant") byOs[os].compliant++;
    if (d.complianceState === "noncompliant") byOs[os].noncompliant++;
  }

  const findings = [];
  const devRow = d => ({ name: d.deviceName, os: `${d.operatingSystem || ""} ${d.osVersion || ""}`.trim(), user: d.userPrincipalName || "—", sync: String(d.lastSyncDateTime || "").slice(0, 10), state: d.complianceState });
  // Bis 15 Geraete einzeln (Operations will den konkreten Namen), darueber gebuendelt.
  if (nonCompliant.length && nonCompliant.length <= 15) {
    for (const d of nonCompliant) {
      findings.push({
        key: "nc:" + d.id, severity: "medium", entity: String(d.userPrincipalName || "").toLowerCase(),
        title: `Gerät nicht konform: ${d.deviceName}`,
        summary: `${d.operatingSystem} ${d.osVersion || ""} · ${d.userPrincipalName || "kein Benutzer"} · letzte Synchronisierung ${String(d.lastSyncDateTime || "").slice(0, 10)}.`,
        context: [["Gerät", d.deviceName], ["Benutzer", d.userPrincipalName || "—"], ["Besitz", d.managedDeviceOwnerType || "—"], ["Verschlüsselt", d.isEncrypted ? "ja" : "nein"]],
        steps: ["Gerät in Intune öffnen → Gerätekonformität: welche Einstellung ist «Nicht konform»?",
          "Typisch: BitLocker, OS-Version, Defender-Signaturen, Kennwort — Benutzer gezielt anleiten oder Remediation anstossen.",
          "Synchronisierung auslösen und nach 1–2 h erneut prüfen. Wirkt eine CA-Policy «konformes Gerät», ist der Benutzer aktuell blockiert."],
        links: [{ label: "Gerät öffnen", url: PORTAL.device(d.id) }], tab: "devices"
      });
    }
  } else if (nonCompliant.length) {
    findings.push({
      key: "nc-bulk", severity: nonCompliant.length / Math.max(1, devices.length) > 0.2 ? "high" : "medium",
      title: `${nonCompliant.length} Geräte nicht konform`,
      summary: `${Math.round(nonCompliant.length / Math.max(1, devices.length) * 100)}% des Bestands. Häufung deutet auf eine Policy- oder Plattform-Ursache statt Einzelfälle.`,
      context: Object.entries(byOs).filter(([, v]) => v.noncompliant).map(([k, v]) => [k, `${v.noncompliant} von ${v.total}`]),
      steps: ["Intune → Geräte → Konformität → «Einstellungskonformität»: welche Einzelregel scheitert am häufigsten?",
        "Gemeinsame Ursache beheben (z. B. Mindest-OS-Version anheben erst nach Update-Ring, BitLocker-Policy prüfen).",
        "Restliche Einzelfälle in der Geräteliste dieser Ansicht abarbeiten."],
      links: [{ label: "Konformität", url: PORTAL.compliance }], tab: "devices"
    });
  }
  if (staleList.length) {
    findings.push({
      key: "stale", severity: "low", title: `${staleList.length} Geräte seit über 30 Tagen nicht synchronisiert`,
      summary: "Veraltete Einträge verzerren die Compliance-Quote und können Lizenzen binden.",
      steps: ["Liste prüfen: ausgemustert → in Intune und Entra löschen (Autopilot-Eintrag bleibt).",
        "Noch in Gebrauch → Benutzer kontaktieren, Gerät einschalten und synchronisieren lassen.",
        "Optional Intune-Bereinigungsregel (z. B. 90 Tage) setzen."],
      links: [{ label: "Alle Geräte", url: PORTAL.devices }], tab: "devices",
      evidence: staleList.slice(0, 25).map(devRow)
    });
  }
  if (policies && !policies.length && devices.length) {
    findings.push({
      key: "no-policy", severity: "high", title: "Keine Compliance-Policy vorhanden",
      summary: `${devices.length} verwaltete Geräte, aber keine Konformitätsrichtlinie. Ohne Policy hat «konform» keine Aussagekraft.`,
      steps: ["Compliance-Policies je Plattform aus der OpenIntuneBaseline zuweisen (Bereich «Intune Policies»).",
        "Danach «Geräte ohne Konformitätsrichtlinie» auf «Nicht konform» stellen."],
      links: [{ label: "Konformität", url: PORTAL.compliance }], tab: "devices"
    });
  }
  if (settings && settings.secureByDefault === false && devices.length) {
    findings.push({
      key: "secure-by-default", severity: "medium", title: "Geräte ohne Compliance-Policy gelten als konform",
      summary: "Die Intune-Einstellung «Geräte ohne zugewiesene Konformitätsrichtlinie markieren als» steht auf «Konform». Ein Gerät, das keiner Policy unterliegt, passiert damit jede CA-Regel «konformes Gerät».",
      steps: ["Intune → Endpunktsicherheit → Gerätekonformität → Konformitätsrichtlinieneinstellungen: auf «Nicht konform» setzen.",
        "Vorher prüfen, dass jede Plattform eine zugewiesene Policy hat — sonst werden Benutzer blockiert."],
      links: [{ label: "Konformität", url: PORTAL.compliance }], tab: "devices"
    });
  }
  const snapshot = {};
  for (const d of nonCompliant) snapshot[d.id] = { name: d.deviceName, state: d.complianceState };
  return {
    metrics: [
      metric("Geräte", devices.length),
      metric("Konform", rate !== null ? rate + "%" : "—", rate === null ? "ok" : rate < 80 ? "crit" : rate < 95 ? "warn" : "ok"),
      metric("Nicht konform", nonCompliant.length, nonCompliant.length ? "warn" : "ok"),
      metric("> 30 T. ohne Sync", staleList.length, staleList.length ? "warn" : "ok")
    ],
    data: {
      rate, byOs, policies: policies ? policies.length : null, secureByDefault: settings ? settings.secureByDefault : null,
      noncompliant: nonCompliant.slice(0, 200).map(d => ({ id: d.id, ...devRow(d) })),
      grace: grace.slice(0, 100).map(d => ({ id: d.id, ...devRow(d) })),
      unknown: unknown.length,
      stale: staleList.slice(0, 200).map(d => ({ id: d.id, ...devRow(d) }))
    },
    snapshot, findings
  };
}

// ============================================================ Lizenzen
async function collectLicenses(tenant, cert) {
  const r = await LICENSES.runLicenseReport(tenant, cert);
  const t = r.totals || {};
  const f = r.findings || {};
  const findings = [];
  if ((f.disabledWithLicense || []).length) {
    findings.push({
      key: "disabled", severity: "medium", title: `${f.disabledWithLicense.length} deaktivierte Konten mit Lizenz`,
      summary: "Bezahlte Lizenzen an gesperrten Konten — meist Austritte, bei denen das Offboarding nicht fertig wurde.",
      steps: ["Je Konto klären: Austritt (Lizenz entfernen, Postfach ggf. in Shared Mailbox umwandeln) oder vorübergehend gesperrt (Notiz).",
        "Frei werdende Seats beim nächsten Renewal reduzieren."],
      links: [{ label: "Lizenzen", url: PORTAL.licenses }], tab: "licenses",
      evidence: f.disabledWithLicense.slice(0, 30).map(u => ({ konto: u.displayName, upn: u.upn, lizenzen: (u.licenses || []).join(", ") }))
    });
  }
  if ((f.inactiveWithLicense || []).length) {
    findings.push({
      key: "inactive", severity: "low", title: `${f.inactiveWithLicense.length} lizenzierte Konten seit über ${r.inactiveDays} Tagen inaktiv`,
      summary: "Kandidaten für Lizenzrückgabe oder Offboarding — und ungenutzte Konten sind Angriffsfläche.",
      steps: ["Liste mit dem Kunden abgleichen (HR/Austritte).", "Nicht mehr benötigt: Konto sperren, Lizenz entfernen."],
      links: [{ label: "Lizenzen", url: PORTAL.licenses }], tab: "licenses",
      evidence: f.inactiveWithLicense.slice(0, 30).map(u => ({ konto: u.displayName, upn: u.upn, letzte: u.lastSignIn || "nie" }))
    });
  }
  const unused = (f.unusedPaidSeats || []);
  if (unused.length && t.freeSeats > 3) {
    findings.push({
      key: "freeseats", severity: "low", title: `${t.freeSeats} bezahlte Lizenzen nicht zugewiesen`,
      summary: unused.map(s => `${s.name}: ${s.available} frei`).slice(0, 5).join(" · "),
      steps: ["Mit dem Kunden klären: Reserve für Eintritte oder reduzierbar?", "Reduktion zum Vertragsende (NCE: nur beim Renewal) vormerken."],
      links: [{ label: "Lizenzen", url: PORTAL.licenses }], tab: "licenses"
    });
  }
  const multi = (f.multiSuite || []).filter(m => m.verdict !== "addon");
  if (multi.length) {
    findings.push({
      key: "multisuite", severity: "low", title: `${multi.length} Konten mehrfach lizenziert`,
      summary: "Überlappende Suiten (z. B. Business Premium + E3) — eine davon ist meist überflüssig.",
      steps: ["Je Konto die überlappende Suite entfernen, nachdem geprüft ist, dass keine exklusive Funktion verloren geht."],
      links: [{ label: "Lizenzen", url: PORTAL.licenses }], tab: "licenses",
      evidence: multi.slice(0, 30).map(m => ({ konto: m.displayName, upn: m.upn, lizenzen: (m.licenses || []).join(", ") }))
    });
  }
  const snapshot = {};
  for (const s of r.skus || []) {
    if (s.free) continue;
    snapshot[s.skuPartNumber || s.name] = { name: s.name, purchased: s.purchased, assigned: s.assigned };
  }
  return {
    metrics: [
      metric("Lizenziert", t.licensedUsers),
      metric("Freie Seats", t.freeSeats, t.freeSeats > 5 ? "warn" : "ok"),
      metric("An deaktivierten Konten", t.disabledWithLicense, t.disabledWithLicense ? "warn" : "ok"),
      metric(`Inaktiv > ${r.inactiveDays} T.`, t.inactiveWithLicense === null ? "—" : t.inactiveWithLicense, t.inactiveWithLicense ? "warn" : "ok")
    ],
    data: {
      totals: t, inactiveDays: r.inactiveDays, signInAvailable: r.signInAvailable,
      skus: (r.skus || []).filter(s => !s.free).map(s => ({ name: s.name, part: s.skuPartNumber, purchased: s.purchased, assigned: s.assigned, available: s.available })),
      disabled: (f.disabledWithLicense || []).slice(0, 100).map(u => ({ name: u.displayName, upn: u.upn, licenses: u.licenses })),
      inactive: (f.inactiveWithLicense || []).slice(0, 100).map(u => ({ name: u.displayName, upn: u.upn, last: u.lastSignIn || null, licenses: u.licenses }))
    },
    snapshot, findings
  };
}

// ============================================================ Message Center
// Dienstbezeichnungen im Message Center <-> Service Plans der Tenant-Lizenzen.
const SERVICE_MAP = [
  [/exchange/i, /^EXCHANGE_|EXCHANGEONLINE/],
  [/teams|skype/i, /^TEAMS|^MCO/],
  [/sharepoint|onedrive/i, /^SHAREPOINT|ONEDRIVE/],
  [/intune|endpoint manager/i, /INTUNE/],
  [/defender for office|office 365 advanced threat/i, /ATP_ENTERPRISE|THREAT_INTELLIGENCE/],
  [/defender for endpoint|defender xdr|microsoft 365 defender/i, /WINDEFATP|MDE_|ATP_ENTERPRISE|THREAT_INTELLIGENCE/],
  [/defender for cloud apps/i, /ADALLOM/],
  [/defender for identity/i, /^ATA$|AAD_PREMIUM_P2/],
  [/power apps|power automate|power platform|dataverse/i, /POWERAPPS|FLOW_|DYN365_CDS/],
  [/power bi/i, /BI_AZURE|POWER_BI/],
  [/purview|information protection|compliance|data loss/i, /INFORMATION_PROTECTION|MIP_|RMS_S|M365_ADVANCED_AUDITING|LOCKBOX|EQUIVIO|DLP|INSIDER_RISK|RECORDS_MANAGEMENT/],
  [/viva|workplace analytics/i, /VIVA|WORKPLACE_ANALYTICS|MYANALYTICS|INSIGHTS/],
  [/copilot/i, /COPILOT/],
  [/planner|project/i, /PROJECTWORKMANAGEMENT|PROJECT_/],
  [/forms/i, /FORMS_PLAN/],
  [/stream/i, /STREAM/],
  [/bookings/i, /MICROSOFTBOOKINGS/],
  [/yammer|viva engage/i, /YAMMER/],
  [/windows|autopatch|universal print/i, /WIN10|WINDOWS|UNIVERSAL_PRINT|AUTOPATCH|WINBIZ/],
  [/microsoft 365 apps|office for the web|office/i, /OFFICESUBSCRIPTION|SHAREPOINTWAC|OFFICE_BUSINESS/],
  [/dynamics/i, /DYN365|D365|CRM/]
];
const ALWAYS_SERVICES = /entra|azure active directory|identity|microsoft 365 suite|admin center|microsoft 365 for the web|security/i;

function tenantServiceSet(skus) {
  const plans = new Set();
  for (const s of skus || []) {
    if (!(s.prepaidUnits && (s.prepaidUnits.enabled || 0) > 0) && !(s.consumedUnits > 0)) continue;
    for (const p of arr(s.servicePlans)) if (p.provisioningStatus === "Success" || p.provisioningStatus === "PendingActivation") plans.add(String(p.servicePlanName || ""));
  }
  return plans;
}
function serviceInTenant(service, plans) {
  if (ALWAYS_SERVICES.test(service)) return true;
  for (const [re, planRe] of SERVICE_MAP) {
    if (re.test(service)) return [...plans].some(p => planRe.test(p));
  }
  return null; // unbekannt -> neutral
}

/**
 * Konkrete, tenant-bezogene Handlungshinweise aus den Fakten, die die anderen
 * Kollektoren im selben Lauf erhoben haben. Regelbasiert und nachvollziehbar —
 * die optionale KI-Einordnung (managedService.js) kommt obendrauf.
 */
// ---------- Message-Center-Text gliedern
// Microsoft schreibt die Meldungen fast immer in festen Abschnitten
// ("[What and Why]", "[When this will happen]", ...). Die Gliederung geht beim
// blossen Entfernen der Tags verloren — deshalb vorher Abschnitte schneiden.
const MC_HEADINGS = [
  [/what and why|what is happening|what'?s changing|summary/i, "Was ändert sich", "what"],
  [/when this will happen|schedule|timeline|rollout|availability/i, "Zeitplan", "when"],
  [/how this (will )?affect|impact|who is affected/i, "Auswirkung", "impact"],
  [/what you (need|can) (to )?do|prepare|action|recommend/i, "Was zu tun ist", "todo"],
  [/compliance/i, "Compliance", "compliance"],
  [/additional information|learn more|more information|resources/i, "Weitere Informationen", "more"]
];
// Datumsangaben im Zeitplan ("October 31, 2026", "late October 2026") fuer den
// Zeitstrahl in der Oberflaeche.
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
function mcMilestones(sections) {
  const out = [];
  const when = sections.filter(s => s.key === "when");
  const scan = list => { for (const s of list) for (const raw of s.lines) scanLine(raw); };
  const scanLine = raw => {
    const l = raw.replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1");
    const re = /\b(early|mid|late|end of|beginning of)?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2},\s*)?(\d{4})\b/gi;
    let m;
    while ((m = re.exec(l)) !== null) {
      const mon = MONTHS[m[2].toLowerCase()];
      const day = m[3] ? parseInt(m[3], 10) : (/late|end/i.test(m[1] || "") ? 25 : /mid/i.test(m[1] || "") ? 15 : 1);
      const d = new Date(Date.UTC(parseInt(m[4], 10), mon, day));
      // Beschriftung = Satzteil um das Datum ("extended into October 2026"),
      // nicht der ganze Absatz. Verschobene Alt-Termine als solche markieren.
      const before = l.slice(0, m.index).split(/[.;,!?]\s+|\s[-–]\s/).pop().replace(/^•\s*/, "").trim();
      const superseded = /originally|previously|initially|was planned|urspr/i.test(before);
      const label = cut((before ? before + " " : "") + m[0].trim(), 70);
      if (!out.some(x => x.date === d.toISOString().slice(0, 10))) out.push({ date: d.toISOString().slice(0, 10), approx: !m[3], label, superseded });
    }
  };
  scan(when);
  if (!out.length) scan(sections.filter(s => s.key === "what" || s.key === "intro"));
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
}

function mcSections(html) {
  const text = String(html || "")
    // Links erhalten: [[Text|URL]] — die Oberflaeche macht daraus echte Links.
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, u, t) => `[[${t.replace(/<[^>]+>/g, "").trim() || u}|${u}]]`)
    .replace(/<li[^>]*>/gi, "\n• ").replace(/<\/li>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d|ul|ol)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    // Ueberschriften stehen nicht immer auf eigener Zeile: "… patience. [What and
    // Why:] The TAC …" — auf eigene Zeile ziehen, Doppelpunkt in der Klammer weg.
    // "|" ausgeschlossen, damit [[Linktext|URL]] unangetastet bleibt.
    .replace(/\s*\[(?!\[)([A-Za-z][^[\]\n|]{2,60}?)\s*:?\]\s*:?\s*/g, "\n[$1]\n")
    .replace(/\n\s*\n+/g, "\n").trim();
  let updated = null;
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const sections = [];
  let cur = { key: "intro", title: "", lines: [] };
  for (const l of lines) {
    const up = l.match(/^Updated ([A-Z][a-z]+ \d{1,2}, \d{4})\s*:?\s*(.*)$/);
    if (up && !sections.length && !cur.lines.length) { updated = { date: up[1], note: up[2] || "" }; continue; }
    const h = l.match(/^\[([^\]]{3,60})\]\s*(.*)$/);
    if (h) {
      if (cur.lines.length || cur.title) sections.push(cur);
      const m = MC_HEADINGS.find(([re]) => re.test(h[1]));
      cur = { key: m ? m[2] : "other", title: m ? m[1] : h[1], original: h[1], lines: h[2] ? [h[2]] : [] };
      continue;
    }
    cur.lines.push(l);
  }
  if (cur.lines.length || cur.title) sections.push(cur);
  const out = sections.map(s => ({ key: s.key, title: s.title, original: s.original || null, lines: s.lines.slice(0, 60).map(x => cut(x, 2000)) }));
  const what = out.find(s => s.key === "what") || out.find(s => s.key === "intro") || out[0];
  const sentences = what ? what.lines.filter(x => !x.startsWith("•")).join(" ").split(/(?<=[.!?])\s+/).filter(Boolean) : [];
  let lead = sentences[0] || "";
  if (sentences[1] && (lead + " " + sentences[1]).length <= 300) lead += " " + sentences[1];
  const impact = out.find(s => s.key === "impact");
  // "Who is affected" steht meist als Unterzeile im Auswirkungsabschnitt.
  let affected = [];
  if (impact) {
    const i = impact.lines.findIndex(x => /who is affected|betroffen/i.test(x));
    const inline = i >= 0 ? impact.lines[i].replace(/^.*?who is affected\s*:?\s*/i, "").trim() : "";
    if (inline) affected.push(inline.split(/(?<=[.!?])\s+/)[0]);
    const from = i >= 0 ? impact.lines.slice(i + 1) : impact.lines;
    // Nur die Aufzaehlung direkt unter "Who is affected" — die naechste
    // Zwischenzeile ("Platforms/Services", "What will happen") beendet sie.
    for (const x of from) {
      if (x.startsWith("•")) { affected.push(x.replace(/^•\s*/, "")); continue; }
      if (affected.length || i >= 0) break;
      affected.push(x);
    }
    affected = affected.slice(0, 4);
  }
  const plainLead = lead.replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1");
  return { updated, sections: out, lead: plainLead, affected, milestones: mcMilestones(out), plain: text.replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1") };
}

// ---------- Betrifft das den Tenant?
// Plattform-spezifische Meldungen (z. B. "Defender for Endpoint auf Amazon
// Linux ARM64") gegen die Geraete abgleichen. Server erscheinen nicht in
// Intune — dort lautet das Urteil "pruefen" mit dem Ort, wo man nachsieht.
const MC_PLATFORMS = [
  { key: "amazonlinux", re: /Amazon Linux/i, label: "Amazon Linux", server: true },
  { key: "rhel", re: /\b(Red Hat|RHEL)\b/i, label: "Red Hat Enterprise Linux", server: true },
  { key: "suse", re: /\b(SUSE|SLES)\b/i, label: "SUSE Linux", server: true },
  { key: "oracle", re: /Oracle Linux/i, label: "Oracle Linux", server: true },
  { key: "debian", re: /\bDebian\b/i, label: "Debian", server: true },
  { key: "ubuntu", re: /\bUbuntu\b/i, label: "Ubuntu", server: true, intune: /linux|ubuntu/i },
  { key: "linux", re: /\bLinux\b/i, label: "Linux", server: true, intune: /linux/i },
  { key: "winserver", re: /Windows Server/i, label: "Windows Server", server: true },
  { key: "macos", re: /\bmacOS\b/i, label: "macOS", intune: /mac/i },
  { key: "ios", re: /\b(iOS|iPadOS)\b/i, label: "iOS/iPadOS", intune: /ios|ipad/i },
  { key: "android", re: /\bAndroid\b/i, label: "Android", intune: /android/i },
  { key: "windows", re: /\bWindows (10|11)\b/i, label: "Windows 10/11", intune: /windows/i },
  // Teams-Geraete: Abgleich gegen das Teams-Geraeteinventar statt Intune.
  { key: "teamsrooms", re: /Teams Rooms?\b|Microsoft Teams Room|\bMTR(oW|oA)?\b/i, label: "Teams Rooms", teams: ["teamsRoom", "collaborationBar", "touchConsole"] },
  { key: "sip", re: /\bSIP\b/, label: "SIP-Geräte", teams: ["sip"] },
  { key: "teamsphone", re: /Teams phones?|\bIP phones?|desk phones?|common area phones?/i, label: "Teams-Telefone", teams: ["ipPhone", "lowCostPhone"] },
  { key: "teamsdisplay", re: /Teams displays?/i, label: "Teams Displays", teams: ["teamsDisplay"] },
  { key: "teamspanel", re: /Teams panels?/i, label: "Teams Panels", teams: ["teamsPanel"] },
  { key: "surfacehub", re: /Surface Hub/i, label: "Surface Hub", teams: ["surfaceHub"] },
  { key: "collabbar", re: /collaboration bars?/i, label: "Collaboration Bars", teams: ["collaborationBar"] }
];
function mcPlatforms(msg, parsed) {
  // Plattform aus Titel + "Wer ist betroffen" — nicht aus dem ganzen Text, sonst
  // macht "AL2 on AMD64 is not affected" oder ein Nebensatz jede Meldung plattformspezifisch.
  const hay = [msg.title, ...(parsed.affected || [])].join(" \n ");
  const found = MC_PLATFORMS.filter(p => p.re.test(hay));
  // "Linux" allein nur, wenn keine konkretere Distribution genannt ist.
  const specific = found.filter(p => p.key !== "linux" || found.length === 1);
  // Geht es um Teams-Geraete, sind "Android"/"Windows" deren Betriebssystem
  // ("Teams Rooms on Android") — nicht die Intune-Geraete des Tenants.
  if (specific.some(p => p.teams)) return specific.filter(p => p.teams);
  return specific;
}
// Teams-Geraete (Teams Admin Center) — Rooms, SIP, Telefone usw. sind keine
// Intune-Geraete; Grundlage ist /teamwork/devices (TeamworkDevice.Read.All).
const TEAMS_DEVICE_LABEL = { teamsRoom: "Teams Rooms", collaborationBar: "Collaboration Bars", touchConsole: "Touch-Konsolen", surfaceHub: "Surface Hubs",
  teamsDisplay: "Teams Displays", teamsPanel: "Teams Panels", ipPhone: "Teams-Telefone", lowCostPhone: "Teams-Telefone", sip: "SIP-Geräte", unknown: "Sonstige" };
const TEAMS_SINGULAR = { "Teams Rooms": "Teams Room", "SIP-Geräte": "SIP-Gerät", "Teams-Telefone": "Teams-Telefon", "Teams Displays": "Teams Display", "Teams Panels": "Teams Panel", "Collaboration Bars": "Collaboration Bar" };
async function teamsDevices(tenant, cert) {
  try {
    const list = await graphAllPages(tenant, cert, "/teamwork/devices?$select=id,deviceType,healthStatus,activityState", BETA);
    const byType = {};
    for (const d of list) byType[d.deviceType || "unknown"] = (byType[d.deviceType || "unknown"] || 0) + 1;
    return { readable: true, total: list.length, byType };
  } catch (e) {
    return { readable: false, error: /forbidden|authorization|permission|403/i.test(e.message) ? "TeamworkDevice.Read.All fehlt, im Tab Tenants einmal Reparieren" : e.message };
  }
}

function mcVerdict(msg, parsed, facts, svc) {
  if (svc.notInTenant) return { verdict: "nein", reason: `Dienst nicht lizenziert (${msg.services.join(", ")}).` };
  const plats = mcPlatforms(msg, parsed);
  if (plats.length) {
    const dev = facts.devices && facts.devices.byOs;
    const td = facts.teamsDevices;
    const hits = [], zero = [], servers = [], teamsUnknown = [];
    for (const p of plats) {
      if (p.teams) {
        if (!td || !td.readable) { teamsUnknown.push(p.label); continue; }
        const n = p.teams.reduce((a, k) => a + (td.byType[k] || 0), 0);
        if (n > 0) hits.push(`${n} ${n === 1 ? (TEAMS_SINGULAR[p.label] || p.label) : p.label}`); else zero.push(p.label);
        continue;
      }
      if (p.server && !p.intune) { servers.push(p.label); continue; }
      const n = dev ? Object.entries(dev).filter(([k]) => p.intune.test(k)).reduce((a, [, v]) => a + v.total, 0) : null;
      if (n === null) servers.push(p.label); else if (n > 0) hits.push(`${n} ${p.label}`); else zero.push(p.label);
    }
    if (hits.length) return { verdict: "ja", reason: `Betrifft ${hits.join(", ")}${plats.some(p => p.teams) ? "" : "-Geräte"} in diesem Tenant.`, platforms: plats.map(p => p.label) };
    if (teamsUnknown.length) return { verdict: "pruefen", reason: `Betrifft ${teamsUnknown.join(", ")}. Teams-Geräteinventar nicht lesbar${td && td.error ? " (" + td.error + ")" : ""} — im Teams Admin Center unter Teams-Geräte nachsehen.`, platforms: plats.map(p => p.label), check: "https://admin.teams.microsoft.com/devices" };
    if (zero.length && plats.every(p => p.teams)) return { verdict: "nein", reason: `Betrifft nur ${zero.join(", ")} — im Teams Admin Center sind keine solchen Geräte registriert (${td.total} Teams-Geräte insgesamt).`, platforms: plats.map(p => p.label) };
    if (servers.length) return { verdict: "pruefen", reason: `Nur ${servers.join(", ")} betroffen. Server und Linux-Systeme erscheinen nicht in Intune — im Defender-Portal unter Geräteinventar nach Betriebssystem filtern.`, platforms: plats.map(p => p.label), check: "https://security.microsoft.com/machines" };
    return { verdict: "nein", reason: `Nur ${zero.join(", ")} betroffen — in diesem Tenant keine solchen Geräte verwaltet.`, platforms: plats.map(p => p.label) };
  }
  if (svc.inTenant) return { verdict: msg.actionRequiredByDateTime || svc.adminImpact ? "ja" : "info", reason: `Dienst im Einsatz (${msg.services.join(", ")}).` };
  return { verdict: "pruefen", reason: "Dienstzuordnung nicht eindeutig." };
}

function contextActions(msg, facts) {
  const text = `${msg.title} ${strip(msg.body && msg.body.content).slice(0, 4000)}`;
  const out = [];
  const dev = facts.devices && facts.devices.byOs;
  const osCount = re => dev ? Object.entries(dev).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v.total, 0) : null;
  if (/\b(iOS|iPadOS)\b/i.test(text) && osCount(/ios|ipad/i)) out.push(`Betrifft ${osCount(/ios|ipad/i)} verwaltete iOS/iPadOS-Geräte in diesem Tenant — Mindestversion in den Compliance-Policies abgleichen.`);
  if (/\bAndroid\b/i.test(text) && osCount(/android/i)) out.push(`Betrifft ${osCount(/android/i)} verwaltete Android-Geräte — Enrollment-Typ (Work Profile/AOSP) und Policies prüfen.`);
  if (/\bmacOS\b/i.test(text) && osCount(/mac/i)) out.push(`Betrifft ${osCount(/mac/i)} verwaltete macOS-Geräte.`);
  if (/\bWindows (10|11)\b/i.test(text) && osCount(/windows/i)) out.push(`Betrifft ${osCount(/windows/i)} verwaltete Windows-Geräte — Update-Ringe/Feature-Update-Policy prüfen.`);
  if (/conditional access|bedingter zugriff/i.test(text) && facts.ca) out.push(`Tenant hat ${facts.ca.total} CA-Policies (${facts.ca.enabled} erzwungen, ${facts.ca.reportOnly} Report-only) — betroffene Bedingungen in diesen Policies prüfen.`);
  if (/(sharing|freigabe|anyone link|anonymous)/i.test(text) && facts.sharing && facts.sharing.capability) out.push(`Externe Freigabe im Tenant: «${facts.sharing.label}» — Auswirkung auf bestehende Links prüfen.`);
  if (/(SMTP AUTH|basic auth|Basic Authentication|legacy auth)/i.test(text) && facts.exo && facts.exo.smtpAuthDisabled !== undefined) out.push(`SMTP AUTH ist tenantweit ${facts.exo.smtpAuthDisabled ? "deaktiviert" : "AKTIV"} — ${facts.exo.smtpAuthDisabled ? "Ausnahmen je Postfach im Bereich «Mail Audit» prüfen" : "Geräte/Apps, die SMTP AUTH nutzen (Scanner, ERP), vor dem Stichtag umstellen"}.`);
  if (/(Exchange Web Services|\bEWS\b)/i.test(text)) out.push("Apps mit EWS-Zugriff identifizieren (Enterprise Apps mit «full_access_as_app» / «EWS.AccessAsUser.All») und Migration auf Graph mit dem Hersteller klären.");
  if (/(quarantine|quarantäne|anti-?spam|anti-?phish|safe links|safe attachments)/i.test(text) && facts.threat) out.push(`Threat Policies: ${facts.threat.summary} — geänderte Standardwerte gegen die igeeks-Baseline prüfen.`);
  if (/(mailbox|postfach|outlook)/i.test(text) && facts.exo && facts.exo.mailboxes) out.push(`Betrifft potenziell ${facts.exo.mailboxes} Postfächer (${facts.exo.shared || 0} freigegebene).`);
  if (/(license|lizenz|SKU)/i.test(text) && facts.licenses) out.push(`Lizenzbestand: ${facts.licenses.licensedUsers} lizenzierte Benutzer — betroffene SKU im Bestand prüfen.`);
  return out;
}

async function collectMessages(tenant, cert, facts, cache) {
  const msgs = await graphAllPages(tenant, cert,
    `/admin/serviceAnnouncement/messages?$filter=${encodeURIComponent("lastModifiedDateTime ge " + isoDaysAgo(45))}&$top=100`, V1);
  let skus = [];
  try { skus = await graphAllPages(tenant, cert, "/subscribedSkus", V1); } catch (e) { /* ohne Lizenzen keine Dienst-Filterung */ }
  const plans = tenantServiceSet(skus);
  const now = Date.now();
  const scored = msgs.map(m => {
    const services = arr(m.services);
    const matches = services.map(s => serviceInTenant(s, plans));
    const inTenant = matches.some(x => x === true);
    const notInTenant = services.length && matches.every(x => x === false);
    const tags = arr(m.tags);
    const due = m.actionRequiredByDateTime ? new Date(m.actionRequiredByDateTime).getTime() : null;
    let score = 20;
    if (inTenant) score += 35;
    if (notInTenant) score -= 60;
    if (m.isMajorChange) score += 15;
    if (due) score += due - now < 30 * DAY ? 30 : 15;
    if (tags.some(t => /admin impact|retirement|breaking/i.test(t))) score += 12;
    if (tags.some(t => /user impact/i.test(t))) score += 6;
    if (m.category === "preventOrFixIssue") score += 15;
    if (m.category === "stayInformed") score -= 8;
    if (tags.some(t => /new feature|feature update/i.test(t)) && !due) score -= 6;
    const parsed = mcSections(m.body && m.body.content);
    const adminImpact = tags.some(t => /admin impact|retirement|breaking/i.test(t));
    const v = mcVerdict({ ...m, services }, parsed, facts, { inTenant, notInTenant, adminImpact });
    // Das Urteil uebersteuert den Score: "nicht betroffen" ist nie relevant,
    // "betroffen + Stichtag" immer oben.
    if (v.verdict === "nein") score = Math.min(score, 15);
    if (v.verdict === "ja" && due) score = Math.max(score, 70);
    const relevance = score >= 60 ? "hoch" : score >= 35 ? "mittel" : "gering";
    const ai = cache && cache[m.id] && cache[m.id].modified === m.lastModifiedDateTime ? cache[m.id].ai : null;
    const actions = v.verdict === "nein" ? [] : contextActions(m, facts);
    if (v.check) actions.unshift(`Prüfen: ${v.reason}`);
    if (due && v.verdict === "ja") actions.push(`Bis ${new Date(due).toLocaleDateString("de-CH")} umsetzen: als Ticket einplanen und den Kunden vorab informieren, falls Benutzer etwas merken.`);
    if (due && v.verdict === "pruefen") actions.push(`Betroffenheit vor dem ${new Date(due).toLocaleDateString("de-CH")} klären; wenn nicht betroffen, Meldung als gelesen markieren.`);
    return {
      id: m.id, title: m.title, services, category: m.category, severity: m.severity, tags, major: !!m.isMajorChange,
      due: m.actionRequiredByDateTime || null, start: m.startDateTime, modified: m.lastModifiedDateTime,
      score: Math.max(0, Math.min(100, score)), relevance, inTenant, notInTenant: !!notInTenant,
      verdict: v.verdict, verdictReason: v.reason, platforms: v.platforms || [], checkUrl: v.check || null,
      lead: parsed.lead, affected: parsed.affected, updated: parsed.updated, milestones: parsed.milestones,
      sections: parsed.sections.filter(s => s.key !== "intro" || s.lines.length).slice(0, 8),
      summary: cut(parsed.plain, 4000),
      actions, ai,
      url: PORTAL.messageCenter(m.id)
    };
  }).sort((a, b) => b.score - a.score || String(b.modified).localeCompare(String(a.modified)));

  const relevant = scored.filter(m => m.verdict !== "nein" && m.verdict !== "info" && m.relevance !== "gering");
  const findings = [];
  for (const m of relevant.filter(x => x.due && new Date(x.due).getTime() > now - 7 * DAY)) {
    const days = Math.round((new Date(m.due).getTime() - now) / DAY);
    findings.push({
      key: "mc:" + m.id, severity: m.verdict === "pruefen" ? "low" : days <= 14 ? "high" : days <= 45 ? "medium" : "low",
      title: `${m.verdict === "pruefen" ? "Prüfen" : "Microsoft-Änderung"} bis ${new Date(m.due).toLocaleDateString("de-CH")}: ${m.title}`,
      summary: `${m.lead || m.id} — ${m.verdictReason} ${days >= 0 ? "Noch " + days + " Tage." : "Stichtag überschritten."}`,
      context: [["Meldung", m.id], ["Dienste", m.services.join(", ")], ["Betroffen", m.verdict === "ja" ? "ja" : "unklar — prüfen"], ...(m.affected.length ? [["Laut Microsoft betroffen", m.affected.join(" · ")]] : [])],
      steps: (m.ai && m.ai.actions && m.ai.actions.length ? m.ai.actions : m.actions).concat(["Meldung im Message Center als gelesen markieren, sobald eingeplant."]),
      links: [{ label: "Im Message Center öffnen", url: m.url }], tab: "messages"
    });
  }
  return {
    metrics: [
      metric("Meldungen 45 T.", msgs.length),
      metric("Relevant", relevant.length, relevant.length ? "warn" : "ok"),
      metric("Mit Stichtag", relevant.filter(x => x.due).length, relevant.some(x => x.due && new Date(x.due).getTime() - now < 30 * DAY) ? "crit" : "ok")
    ],
    // schema 2: ungekuerzter Text + Gliederung. Aeltere Daten erkennt die Oberflaeche daran.
    data: { schema: 2, messages: scored.slice(0, 120), servicePlans: plans.size, teamsDevices: facts.teamsDevices || null },
    snapshot: Object.fromEntries(relevant.map(m => [m.id, { title: m.title, due: m.due, modified: m.modified }])),
    findings
  };
}

// ============================================================ SharePoint-Freigaben
const SHARING_OPS_OUT = ["AnonymousLinkCreated", "AnonymousLinkUpdated", "CompanyLinkCreated", "SecureLinkCreated", "AddedToSecureLink", "SharingInvitationCreated", "SharingSet"];
const SHARING_OPS_IN = ["AnonymousLinkUsed", "SharingInvitationAccepted", "SecureLinkUsed", "CompanySharingLinkUsed"];
const SHARING_LABEL = {
  disabled: "Nur intern", existingExternalUserSharingOnly: "Nur bestehende Gäste",
  externalUserSharingOnly: "Neue und bestehende Gäste", externalUserAndGuestSharing: "Jeder (anonyme Links)"
};

/**
 * Freigabelinks laufen ueber das Unified Audit Log (Graph-Abfrage ist
 * asynchron und braucht Minuten). Deshalb zustandsbehaftet: ein Lauf stellt
 * die Abfrage, ein spaeterer holt das Ergebnis ab. ualState wird vom Aufrufer
 * persistiert.
 */
async function collectSharing(tenant, cert, ualState) {
  const st = { ...(ualState || {}) };
  let settings = null;
  try { settings = await graphReq(tenant, cert, "GET", "/admin/sharepoint/settings", null, V1); } catch (e) { /* optional */ }

  let events = st.events || [];
  let pendingNote = null;
  if (st.pending) {
    const s = await EVIDENCE.ualStatus(tenant, cert, st.pending.graphId).catch(e => ({ status: "failed", error: e.message }));
    if (s.status === "succeeded") {
      const rec = await EVIDENCE.ualRecords(tenant, cert, st.pending.graphId, 5000);
      events = rec.records.map(x => ({
        at: x.at, op: x.operation, user: x.user, target: x.target, ip: x.ip,
        dir: SHARING_OPS_IN.includes(x.operation) ? "in" : "out",
        anonymous: /^Anonymous/i.test(x.operation)
      }));
      st.lastWindow = { from: st.pending.from, to: st.pending.to, fetchedAt: new Date().toISOString() };
      st.pending = null;
    } else if (s.status === "failed" || s.status === "cancelled" || (Date.now() - new Date(st.pending.createdAt).getTime() > 6 * 3600000)) {
      pendingNote = "Audit-Log-Abfrage fehlgeschlagen oder abgelaufen — wird neu gestellt.";
      st.pending = null;
    } else {
      pendingNote = "Audit-Log-Abfrage läuft (Microsoft braucht dafür einige Minuten) — Ergebnis kommt mit dem nächsten Lauf.";
    }
  }
  // Neue Abfrage hoechstens alle 6 h: Fenster = letzte 7 Tage bis heute.
  if (!st.pending && (!st.lastWindow || Date.now() - new Date(st.lastWindow.fetchedAt).getTime() > 6 * 3600000)) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    try {
      const q = await EVIDENCE.ualCreate(tenant, cert, { name: "Managed Service: Freigabelinks", from, to, operations: [...SHARING_OPS_OUT, ...SHARING_OPS_IN] });
      st.pending = { graphId: q.graphId, from, to, createdAt: new Date().toISOString() };
      if (!pendingNote) pendingNote = "Audit-Log-Abfrage gestellt — Ergebnis kommt mit dem nächsten Lauf.";
    } catch (e) {
      pendingNote = "Audit-Log nicht abfragbar (AuditLogsQuery.Read.All fehlt?): " + e.message;
    }
  }
  st.events = events.slice(0, 3000);

  const out = events.filter(e => e.dir === "out");
  const inn = events.filter(e => e.dir === "in");
  const anonOut = out.filter(e => e.anonymous);
  const anonIn = inn.filter(e => e.anonymous);
  const byUser = {};
  for (const e of out) {
    const u = String(e.user || "?").toLowerCase();
    byUser[u] = byUser[u] || { user: u, out: 0, anonymous: 0, invites: 0 };
    byUser[u].out++;
    if (e.anonymous) byUser[u].anonymous++;
    if (/Invitation/i.test(e.op)) byUser[u].invites++;
  }
  const topSharers = Object.values(byUser).sort((a, b) => b.anonymous - a.anonymous || b.out - a.out).slice(0, 25);

  const findings = [];
  const cap = settings && settings.sharingCapability;
  if (cap === "externalUserAndGuestSharing") {
    findings.push({
      key: "anyone-enabled", severity: "medium", title: "Anonyme «Jeder»-Links tenantweit erlaubt",
      summary: "Dateien können ohne Anmeldung geteilt werden. Wer den Link hat, hat die Datei — auch nach Weiterleitung.",
      context: [["Einstellung", SHARING_LABEL[cap]], ["Anonyme Links 7 T.", String(anonOut.length)]],
      steps: ["Mit dem Kunden klären, ob anonyme Links fachlich nötig sind.",
        "Wenn ja: Ablauf erzwingen (z. B. 30 Tage) und Berechtigung auf «Anzeigen» begrenzen.",
        "Wenn nein: auf «Neue und bestehende Gäste» reduzieren — bestehende Jeder-Links funktionieren dann nicht mehr (vorher kommunizieren)."],
      links: [{ label: "Freigabe-Einstellungen", url: PORTAL.sharing }], tab: "sharing"
    });
  }
  for (const u of topSharers.filter(x => x.anonymous >= 10)) {
    findings.push({
      key: "anon-heavy:" + u.user, severity: "medium", entity: u.user,
      title: `${u.anonymous} anonyme Links in 7 Tagen: ${u.user}`,
      summary: "Auffällig viele Jeder-Links von einem Konto — Massenfreigabe oder Datenabfluss?",
      steps: ["Betroffene Dateien in der Freigabeliste unten prüfen (Pfad, Art der Dateien).",
        "Mit dem Benutzer klären; nicht mehr benötigte Links in OneDrive/SharePoint unter «Zugriff verwalten» entfernen.",
        "Konto gleichzeitig unter Risikobenutzer prüfen — ein kompromittiertes Konto zeigt oft dieses Muster."],
      links: [{ label: "Freigabe-Einstellungen", url: PORTAL.sharing }], tab: "sharing",
      evidence: anonOut.filter(e => String(e.user).toLowerCase() === u.user).slice(0, 20).map(e => ({ at: e.at, op: e.op, ziel: e.target }))
    });
  }
  return {
    metrics: [
      metric("Externe Freigabe", cap ? SHARING_LABEL[cap] || cap : "—", cap === "externalUserAndGuestSharing" ? "warn" : "ok"),
      metric("Links erstellt 7 T.", out.length, "ok"),
      metric("davon anonym", anonOut.length, anonOut.length > 20 ? "warn" : "ok"),
      metric("Zugriffe von aussen", inn.length, anonIn.length > 50 ? "warn" : "ok")
    ],
    data: {
      capability: cap || null, label: cap ? SHARING_LABEL[cap] || cap : null,
      defaultLinkType: settings ? settings.defaultSharingLinkType || null : null,
      anyoneExpiry: settings ? settings.anyoneLinkExpirationInDays ?? null : null,
      domainRestriction: settings ? settings.sharingDomainRestrictionMode || null : null,
      window: st.lastWindow || null, note: pendingNote,
      topSharers, recent: events.slice(0, 300)
    },
    snapshot: {},
    findings,
    ualState: st,
    facts: { capability: cap || null, label: cap ? SHARING_LABEL[cap] || cap : null }
  };
}

// ============================================================ Exchange (ein pwsh-Lauf)
const MAX_MAILBOXES = Number(process.env.MANAGED_MAX_MAILBOXES || 400);

function exoScript(opts) {
  const max = Math.max(1, Math.min(5000, Number(opts.maxMailboxes) || MAX_MAILBOXES));
  const want = new Set(opts.parts);
  // Mehrwertige Felder als String-Arrays ausgeben: ConvertTo-Json serialisiert
  // EXO-Objekte (SmtpAddress, ProxyAddress) sonst als verschachtelte Objekte.
  return String.raw`
$ErrorActionPreference = 'Stop'
$out = @{}; $errs = @{}
function P($l) { Write-Output ('BPPROGRESS' + (@{ type = 'phase'; label = $l } | ConvertTo-Json -Compress) + 'ENDPROGRESS') }
function S($v) { if ($null -eq $v) { return @() } ; return @($v | ForEach-Object { "$_" }) }
try { $out.accepted = @(Get-AcceptedDomain | ForEach-Object { "$($_.DomainName)".ToLower() }) } catch { $errs.accepted = $_.Exception.Message }
try { $tc = Get-TransportConfig; $out.transport = @{ SmtpClientAuthenticationDisabled = [bool]$tc.SmtpClientAuthenticationDisabled } } catch { $errs.transport = $_.Exception.Message }
${want.has("threat") ? String.raw`
P 'Threat Policies'
$t = @{}
try { $t.antiPhish = @(Get-AntiPhishPolicy | Select-Object Name,IsDefault,Enabled,PhishThresholdLevel,EnableMailboxIntelligence,EnableMailboxIntelligenceProtection,EnableSpoofIntelligence,EnableUnauthenticatedSender,EnableViaTag,EnableTargetedUserProtection,EnableTargetedDomainsProtection,EnableOrganizationDomainsProtection,TargetedUserProtectionAction,MailboxIntelligenceProtectionAction,AuthenticationFailAction,HonorDmarcPolicy,EnableFirstContactSafetyTips) } catch { $errs.antiPhish = $_.Exception.Message }
try { $t.contentFilter = @(Get-HostedContentFilterPolicy | Select-Object Name,IsDefault,SpamAction,HighConfidenceSpamAction,PhishSpamAction,HighConfidencePhishAction,BulkSpamAction,BulkThreshold,QuarantineRetentionPeriod,InlineSafetyTipsEnabled,PhishZapEnabled,SpamZapEnabled,@{n='AllowedSenderDomains';e={S $_.AllowedSenderDomains}},@{n='AllowedSenders';e={S $_.AllowedSenders}},@{n='BlockedSenderDomains';e={S $_.BlockedSenderDomains}}) } catch { $errs.contentFilter = $_.Exception.Message }
try { $t.malware = @(Get-MalwareFilterPolicy | Select-Object Name,IsDefault,EnableFileFilter,ZapEnabled,FileTypeAction,EnableInternalSenderAdminNotifications) } catch { $errs.malware = $_.Exception.Message }
try { $t.outbound = @(Get-HostedOutboundSpamFilterPolicy | Select-Object Name,IsDefault,AutoForwardingMode,RecipientLimitExternalPerHour,RecipientLimitInternalPerHour,RecipientLimitPerDay,ActionWhenThresholdReached) } catch { $errs.outbound = $_.Exception.Message }
try { $t.safeLinks = @(Get-SafeLinksPolicy | Select-Object Name,EnableSafeLinksForEmail,EnableSafeLinksForTeams,EnableSafeLinksForOffice,TrackClicks,AllowClickThrough,ScanUrls,EnableForInternalSenders,DeliverMessageAfterScan) } catch { $errs.safeLinks = $_.Exception.Message }
try { $t.safeAttachments = @(Get-SafeAttachmentPolicy | Select-Object Name,Enable,Action,QuarantineTag,Redirect) } catch { $errs.safeAttachments = $_.Exception.Message }
try { $t.presetEop = @(Get-EOPProtectionPolicyRule | Select-Object Name,State,Priority) } catch { $errs.presetEop = $_.Exception.Message }
try { $t.presetAtp = @(Get-ATPProtectionPolicyRule | Select-Object Name,State,Priority) } catch { $errs.presetAtp = $_.Exception.Message }
try { $t.remoteDomains = @(Get-RemoteDomain | Select-Object Name,@{n='DomainName';e={"$($_.DomainName)"}},AutoForwardEnabled) } catch { $errs.remoteDomains = $_.Exception.Message }
$out.threat = $t
` : ""}
${want.has("quarantine") ? String.raw`
P 'Quarantäne-Freigabeanfragen'
try { $out.quarantine = @(Get-QuarantineMessage -ReleaseStatus Requested -PageSize 500 | Select-Object Identity,ReceivedTime,SenderAddress,@{n='Recipients';e={S $_.RecipientAddress}},Subject,@{n='QType';e={"$($_.QuarantineTypes)"}},Type,PolicyName,Expires,Direction) } catch { $errs.quarantine = $_.Exception.Message }
` : ""}
${want.has("mailboxes") || want.has("senderlists") ? String.raw`
P 'Postfächer lesen'
$mbx = @()
try { $mbx = @(Get-EXOMailbox -ResultSize Unlimited -RecipientTypeDetails UserMailbox,SharedMailbox -Properties ForwardingSmtpAddress,ForwardingAddress,DeliverToMailboxAndForward | Select-Object UserPrincipalName,PrimarySmtpAddress,DisplayName,RecipientTypeDetails,@{n='Fwd';e={"$($_.ForwardingSmtpAddress)"}},@{n='FwdAddr';e={"$($_.ForwardingAddress)"}},DeliverToMailboxAndForward) } catch { $errs.mailboxes = $_.Exception.Message }
$out.mailboxCount = $mbx.Count
$out.mailboxes = @($mbx | Select-Object UserPrincipalName,@{n='Smtp';e={"$($_.PrimarySmtpAddress)"}},DisplayName,@{n='Type';e={"$($_.RecipientTypeDetails)"}},Fwd,FwdAddr,DeliverToMailboxAndForward)
$rules = New-Object System.Collections.Generic.List[object]
$junk = New-Object System.Collections.Generic.List[object]
$i = 0; $max = ${max}
foreach ($m in ($mbx | Select-Object -First $max)) {
  $i++
  if ($i % 25 -eq 1) { P ("Postfächer prüfen " + $i + "/" + [Math]::Min($mbx.Count, $max)) }
  $id = "$($m.PrimarySmtpAddress)"
  ${want.has("mailboxes") ? String.raw`try {
    foreach ($r in @(Get-InboxRule -Mailbox $id -WarningAction SilentlyContinue)) {
      $rules.Add([pscustomobject]@{ Mailbox = $id; Name = "$($r.Name)"; RuleId = "$($r.RuleIdentity)"; Enabled = [bool]$r.Enabled; Priority = $r.Priority;
        From = (S $r.From); SubjectContainsWords = (S $r.SubjectContainsWords); BodyContainsWords = (S $r.BodyContainsWords);
        ForwardTo = (S $r.ForwardTo); ForwardAsAttachmentTo = (S $r.ForwardAsAttachmentTo); RedirectTo = (S $r.RedirectTo);
        DeleteMessage = [bool]$r.DeleteMessage; SoftDeleteMessage = [bool]$r.SoftDeleteMessage; MoveToFolder = "$($r.MoveToFolder)"; MarkAsRead = [bool]$r.MarkAsRead; StopProcessingRules = [bool]$r.StopProcessingRules })
    }
  } catch { }` : ""}
  ${want.has("senderlists") ? String.raw`try {
    $j = Get-MailboxJunkEmailConfiguration -Identity $id -ErrorAction Stop
    $ts = S $j.TrustedSendersAndDomains; $bs = S $j.BlockedSendersAndDomains
    if ($ts.Count -or $bs.Count -or -not $j.Enabled) { $junk.Add([pscustomobject]@{ Mailbox = $id; Enabled = [bool]$j.Enabled; Trusted = $ts; Blocked = $bs; ContactsTrusted = [bool]$j.ContactsTrusted }) }
  } catch { }` : ""}
}
$out.rules = $rules; $out.junk = $junk; $out.scanned = [Math]::Min($mbx.Count, $max)
` : ""}
${want.has("senderlists") ? String.raw`
P 'Tenant Allow/Block List'
$tabl = New-Object System.Collections.Generic.List[object]
foreach ($lt in 'Sender','Url','FileHash') {
  try { foreach ($x in @(Get-TenantAllowBlockListItems -ListType $lt)) { $tabl.Add([pscustomobject]@{ ListType = $lt; Value = "$($x.Value)"; Action = "$($x.Action)"; Expiration = "$($x.ExpirationDate)"; Modified = "$($x.LastModifiedDateTime)"; Notes = "$($x.Notes)"; Id = "$($x.Identity)" }) } } catch { $errs['tabl_' + $lt] = $_.Exception.Message }
}
$out.tabl = $tabl
` : ""}
$out.errors = $errs
Write-Output ('BEGINJSON' + ($out | ConvertTo-Json -Depth 8 -Compress) + 'ENDJSON')
`;
}

const FREEMAIL = /^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|yahoo\.[a-z.]+|gmx\.[a-z.]+|web\.de|bluewin\.ch|icloud\.com|me\.com|aol\.com|proton(mail)?\.(com|me)|t-online\.de|sunrise\.ch|hispeed\.ch)$/i;

function smtpOf(v) {
  const s = String(v || "");
  const m = s.match(/\[?(?:SMTP|smtp):([^\]\s]+)\]?/) || s.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m ? m[1].toLowerCase() : null;
}
const domainOf = a => String(a || "").split("@")[1] || "";

/** Wertet das EXO-Ergebnis in die vier Bereiche aus. */
function evaluateExo(raw, parts) {
  const res = {};
  const errs = raw.errors || {};
  const accepted = new Set(arr(raw.accepted).map(d => String(d).toLowerCase()));
  const isExternal = a => { const d = domainOf(a); return !!d && !accepted.has(d) && ![...accepted].some(x => d.endsWith("." + x)); };

  // Weiterleitungs-Policy: Outbound-Spam-Policy (AutoForwardingMode) + Remote Domain.
  const t = raw.threat || {};
  const outDefault = arr(t.outbound).find(p => p.IsDefault) || arr(t.outbound)[0] || null;
  const fwdMode = outDefault ? String(outDefault.AutoForwardingMode || "Automatic") : null;
  const remoteDefault = arr(t.remoteDomains).find(d => d.DomainName === "*") || null;
  // "Automatic" ist laut Microsoft seit 2020 gleichbedeutend mit "Off".
  const fwdBlocked = fwdMode ? /^(off|automatic)$/i.test(fwdMode) || (remoteDefault && remoteDefault.AutoForwardEnabled === false) : null;
  const facts = {
    mailboxes: raw.mailboxCount || 0, shared: arr(raw.mailboxes).filter(m => /shared/i.test(m.Type)).length,
    smtpAuthDisabled: raw.transport ? raw.transport.SmtpClientAuthenticationDisabled : undefined,
    forwardingPolicy: fwdMode, forwardingBlocked: fwdBlocked
  };

  // ---------------- Threat Policies
  if (parts.includes("threat")) {
    const failed = ["antiPhish", "contentFilter", "malware", "outbound"].filter(k => errs[k]);
    if (failed.length === 4) res.threat = { error: "Threat Policies nicht lesbar: " + errs.antiPhish };
    else {
      const snapshot = {};
      const put = (kind, list, pick) => { for (const p of arr(list)) snapshot[kind + ":" + p.Name] = { kind, name: p.Name, body: pick ? pick(p) : p }; };
      put("AntiPhish", t.antiPhish); put("Antispam", t.contentFilter); put("Antimalware", t.malware);
      put("Outbound", t.outbound); put("SafeLinks", t.safeLinks); put("SafeAttachments", t.safeAttachments);
      put("PresetEOP", t.presetEop); put("PresetATP", t.presetAtp);
      put("RemoteDomain", t.remoteDomains);
      const findings = [];
      const presetOn = arr(t.presetEop).concat(arr(t.presetAtp)).filter(r => /enabled/i.test(r.State)).map(r => r.Name);
      for (const p of arr(t.contentFilter)) {
        if (p.HighConfidencePhishAction && !/quarantine/i.test(p.HighConfidencePhishAction)) {
          findings.push({ key: "hcphish:" + p.Name, severity: "high", title: `Antispam «${p.Name}»: Hochvertrauens-Phishing wird nicht quarantäniert`,
            summary: `Aktion «${p.HighConfidencePhishAction}». Mails mit sicherem Phishing-Verdikt können im Postfach landen.`,
            steps: ["Defender → Richtlinien → Antispam → Policy öffnen → «Phishing mit hoher Zuverlässigkeit» = Nachricht unter Quarantäne stellen.",
              "Oder die Policy in der igeeks-Baseline («Mail Security → Policies») neu ausrollen."], links: [{ label: "Antispam", url: PORTAL.outbound }], tab: "threat" });
        }
        const allowedDomains = arr(p.AllowedSenderDomains);
        if (allowedDomains.length) {
          findings.push({ key: "allowdomains:" + p.Name, severity: allowedDomains.some(d => FREEMAIL.test(d) || accepted.has(String(d).toLowerCase())) ? "high" : "medium",
            title: `Antispam «${p.Name}»: ${allowedDomains.length} Absenderdomänen pauschal erlaubt`,
            summary: `Erlaubte Domänen umgehen den Spamfilter komplett: ${allowedDomains.slice(0, 8).join(", ")}${allowedDomains.length > 8 ? " …" : ""}. Eigene oder Freemail-Domänen hier sind ein Spoofing-Freipass.`,
            steps: ["Jede Domäne begründen lassen. Ersatz: Eintrag in der Tenant Allow/Block List mit Ablaufdatum oder Advanced Delivery (für Phishing-Simulationen).",
              "Eigene Domänen und Freemail-Domänen sofort entfernen."], links: [{ label: "Antispam", url: PORTAL.outbound }], tab: "threat" });
        }
      }
      for (const p of arr(t.malware)) {
        if (p.EnableFileFilter === false) findings.push({ key: "filefilter:" + p.Name, severity: "medium", title: `Antimalware «${p.Name}»: Filter für gefährliche Dateitypen aus`,
          summary: "Ausführbare Anhänge (.exe, .iso, .js …) werden nicht anhand des Typs blockiert.",
          steps: ["Defender → Antimalware → Policy → «Allgemeiner Anlagenfilter» einschalten (Standardliste genügt)."], links: [{ label: "Antimalware", url: PORTAL.threat }], tab: "threat" });
      }
      for (const p of arr(t.antiPhish)) {
        if (p.EnableSpoofIntelligence === false) findings.push({ key: "spoof:" + p.Name, severity: "medium", title: `Anti-Phishing «${p.Name}»: Spoof-Intelligence aus`,
          summary: "Gefälschte Absender (auch der eigenen Domäne) werden nicht erkannt.",
          steps: ["Defender → Anti-Phishing → Policy → Spoof → «Spoof-Intelligence aktivieren»."], links: [{ label: "Anti-Phishing", url: PORTAL.threat }], tab: "threat" });
      }
      if (fwdMode && !fwdBlocked) {
        findings.push({ key: "autofwd-on", severity: "high", title: "Automatische Weiterleitung nach extern ist erlaubt",
          summary: `Ausgehende Spamrichtlinie: AutoForwardingMode = ${fwdMode}. Jede Inbox-Regel kann damit Mails unbemerkt nach aussen schicken.`,
          steps: ["Defender → Antispam → Ausgehende Richtlinie (Standard) → «Automatische Weiterleitung» = Aus.",
            "Fachlich nötige Weiterleitungen über eine eigene ausgehende Richtlinie nur für diese Postfächer erlauben.",
            "Bestehende externe Weiterleitungen (Bereich «Postfächer») vorher mit dem Kunden durchgehen."],
          links: [{ label: "Ausgehende Richtlinie", url: PORTAL.outbound }], tab: "threat" });
      }
      res.threat = {
        metrics: [
          metric("Policies", Object.keys(snapshot).length),
          metric("Voreinstellungen", presetOn.length ? presetOn.length + " aktiv" : "keine", "ok"),
          metric("Weiterleitung extern", fwdMode ? (fwdBlocked ? "blockiert" : "erlaubt") : "—", fwdBlocked === false ? "crit" : "ok"),
          metric("Safe Links", errs.safeLinks ? "n/a" : arr(t.safeLinks).length ? "konfiguriert" : "keine Policy", errs.safeLinks ? "warn" : "ok")
        ],
        data: { policies: t, errors: Object.fromEntries(Object.entries(errs).filter(([k]) => ["antiPhish", "contentFilter", "malware", "outbound", "safeLinks", "safeAttachments", "presetEop", "presetAtp", "remoteDomains"].includes(k))), forwarding: { mode: fwdMode, blocked: fwdBlocked } },
        snapshot, findings,
        facts: { summary: `${arr(t.antiPhish).length} Anti-Phishing, ${arr(t.contentFilter).length} Antispam, ${arr(t.malware).length} Antimalware${presetOn.length ? ", Voreinstellungen aktiv" : ""}` }
      };
    }
  }

  // ---------------- Quarantaene
  if (parts.includes("quarantine")) {
    if (errs.quarantine) res.quarantine = { error: "Quarantäne nicht lesbar: " + errs.quarantine };
    else {
      const list = arr(raw.quarantine).map(q => ({
        id: q.Identity, at: q.ReceivedTime, from: q.SenderAddress, to: arr(q.Recipients), subject: q.Subject, type: q.QType || q.Type, policy: q.PolicyName, expires: q.Expires
      }));
      const findings = list.map(q => {
        const dangerous = /phish|malware/i.test(q.type || "");
        return {
          key: "rel:" + q.id, severity: dangerous ? "high" : "medium", entity: (q.to[0] || "").toLowerCase(),
          title: `Freigabeanfrage Quarantäne: ${cut(q.subject || "(ohne Betreff)", 80)}`,
          summary: `${q.to.join(", ")} möchte eine Mail von ${q.from} freigeben lassen (${q.type || "?"}). Läuft ab: ${String(q.expires || "").slice(0, 10) || "—"}.`,
          context: [["Empfänger", q.to.join(", ")], ["Absender", q.from], ["Typ", q.type || "—"], ["Policy", q.policy || "—"], ["Eingang", String(q.at || "").slice(0, 16).replace("T", " ")]],
          steps: dangerous
            ? ["NICHT ungeprüft freigeben: Verdikt ist Phishing/Malware.", "Header, Absender-Authentifizierung (SPF/DKIM/DMARC) und Links in der Vorschau prüfen.",
              "Legitim (False Positive): freigeben UND an Microsoft als «Kein Phishing» melden. Sonst ablehnen und Benutzer kurz informieren."]
            : ["Mail in der Quarantäne-Vorschau prüfen: erwarteter Absender, plausibler Inhalt?", "Legitim: freigeben und ggf. als False Positive melden. Wiederkehrender Absender → Eintrag in der Tenant Allow List mit Ablauf statt Dauer-Freigaben.",
              "Spam: Anfrage ablehnen."],
          links: [{ label: "Quarantäne", url: PORTAL.quarantine }], tab: "quarantine"
        };
      });
      res.quarantine = {
        metrics: [metric("Offene Freigabeanfragen", list.length, list.some(q => /phish|malware/i.test(q.type || "")) ? "crit" : list.length ? "warn" : "ok")],
        data: { requests: list }, snapshot: Object.fromEntries(list.map(q => [q.id, { subject: q.subject, from: q.from }])), findings
      };
    }
  }

  // ---------------- Inbox-Regeln + Postfach-Weiterleitungen
  if (parts.includes("mailboxes")) {
    if (errs.mailboxes) res.mailboxes = { error: "Postfächer nicht lesbar: " + errs.mailboxes };
    else {
      const rules = arr(raw.rules).map(r => {
        const targets = [...arr(r.ForwardTo), ...arr(r.ForwardAsAttachmentTo), ...arr(r.RedirectTo)].map(smtpOf).filter(Boolean);
        const external = targets.filter(isExternal);
        const folder = String(r.MoveToFolder || "");
        const hidingFolder = /rss|archive|archiv|conversation history|unterhaltungsverlauf|junk|junk-e-mail|deleted items|gelöschte/i.test(folder);
        const tinyName = String(r.Name || "").replace(/[\s.\-_]/g, "").length <= 1;
        const keywordHit = /invoice|rechnung|payment|zahlung|bank|iban|wire|überweisung|password|passwort|urgent|dringend/i.test([...arr(r.SubjectContainsWords), ...arr(r.BodyContainsWords)].join(" "));
        const suspicious = r.Enabled && ((r.DeleteMessage || r.SoftDeleteMessage || hidingFolder) && (r.MarkAsRead || keywordHit || tinyName));
        return {
          mailbox: String(r.Mailbox || "").toLowerCase(), name: r.Name, ruleId: r.RuleId, enabled: !!r.Enabled,
          forwardTo: targets, external, delete: !!(r.DeleteMessage || r.SoftDeleteMessage), moveTo: folder, markRead: !!r.MarkAsRead,
          conditions: [...arr(r.From).map(x => "von " + (smtpOf(x) || x)), ...arr(r.SubjectContainsWords).map(x => "Betreff ~ " + x), ...arr(r.BodyContainsWords).map(x => "Text ~ " + x)].slice(0, 6),
          suspicious, keywordHit, tinyName
        };
      });
      const mbxFwd = arr(raw.mailboxes).filter(m => m.Fwd || m.FwdAddr).map(m => ({
        mailbox: String(m.Smtp || m.UserPrincipalName || "").toLowerCase(), name: m.DisplayName, to: smtpOf(m.Fwd) || m.FwdAddr || "",
        external: m.Fwd ? isExternal(smtpOf(m.Fwd)) : false, keepCopy: !!m.DeliverToMailboxAndForward
      }));
      const findings = [];
      for (const r of rules.filter(x => x.enabled && x.external.length)) {
        findings.push({
          key: "fwdrule:" + r.mailbox + ":" + r.ruleId, severity: fwdBlocked ? "medium" : "critical", entity: r.mailbox,
          title: `${fwdBlocked ? "Drift" : "Datenabfluss möglich"}: Inbox-Regel «${r.name}» leitet nach extern weiter — ${r.mailbox}`,
          summary: fwdBlocked
            ? `Regel «${r.name}» → ${r.external.join(", ")}. Die Organisation blockiert externe Weiterleitung (${fwdMode}) — die Regel ist wirkungslos und erzeugt NDRs beim Benutzer. Abweichung vom Soll-Zustand.`
            : `Regel «${r.name}» → ${r.external.join(", ")}. Externe Weiterleitung ist erlaubt (${fwdMode || "unbekannt"}) — Mails verlassen den Tenant.`,
          context: [["Postfach", r.mailbox], ["Regel", r.name], ["Ziel", r.external.join(", ")], ["Bedingungen", r.conditions.join(" · ") || "alle Mails"], ["Policy", `AutoForwardingMode ${fwdMode || "?"}`]],
          steps: [
            "Mit dem Benutzer klären, ob er die Regel selbst angelegt hat und wozu.",
            "Nicht bekannt oder nicht begründet: Regel entfernen (Exchange Admin Center → Postfach → bzw. Remove-InboxRule) und Konto auf Kompromittierung prüfen (Anmeldeprotokoll, Risikobenutzer).",
            fwdBlocked ? "Begründet und gewollt: Ausnahme über eine eigene ausgehende Spamrichtlinie nur für dieses Postfach — sonst bleibt sie wirkungslos." : "Weiterleitung organisationweit sperren (Befund «Automatische Weiterleitung nach extern ist erlaubt»)."
          ],
          links: [{ label: "Postfächer (EXO)", url: PORTAL.mailbox }], tab: "mailboxes"
        });
      }
      for (const r of rules.filter(x => x.suspicious && !x.external.length)) {
        findings.push({
          key: "susprule:" + r.mailbox + ":" + r.ruleId, severity: "high", entity: r.mailbox,
          title: `Verdächtige Inbox-Regel (BEC-Muster) «${r.name}»: ${r.mailbox}`,
          summary: `Regel «${r.name}» ${r.delete ? "löscht" : "verschiebt nach «" + r.moveTo + "»"}${r.markRead ? " und markiert als gelesen" : ""}${r.keywordHit ? " — Schlüsselwörter wie Rechnung/Zahlung/Bank" : ""}. Typisch für kompromittierte Konten, die Rückfragen verstecken.`,
          context: [["Postfach", r.mailbox], ["Regel", r.name], ["Bedingungen", r.conditions.join(" · ") || "alle Mails"]],
          steps: ["Regel deaktivieren (nicht sofort löschen — Beweissicherung).", "Benutzer telefonisch fragen, ob die Regel von ihm stammt.",
            "Nicht von ihm: Vorfall — Sitzungen widerrufen, Passwort, MFA-Methoden prüfen, gesendete Elemente auf Betrugsmails an Kunden prüfen."],
          links: [{ label: "Postfächer (EXO)", url: PORTAL.mailbox }], tab: "mailboxes"
        });
      }
      for (const m of mbxFwd.filter(x => x.external)) {
        findings.push({
          key: "mbxfwd:" + m.mailbox, severity: fwdBlocked ? "medium" : "critical", entity: m.mailbox,
          title: `Postfach-Weiterleitung nach extern: ${m.mailbox} → ${m.to}`,
          summary: `Auf Postfachebene gesetzt (ForwardingSmtpAddress)${m.keepCopy ? ", Kopie bleibt im Postfach" : ", OHNE Kopie im Postfach"}. ${fwdBlocked ? "Durch die Organisationsrichtlinie blockiert — Drift." : "Externe Weiterleitung ist erlaubt — wirksam."}`,
          context: [["Postfach", m.mailbox], ["Ziel", m.to], ["Kopie behalten", m.keepCopy ? "ja" : "nein"]],
          steps: ["Mit dem Kunden klären, ob die Weiterleitung bewusst eingerichtet wurde (Austritt, privates Postfach?).",
            "Nicht begründet: Weiterleitung im Exchange Admin Center entfernen.", "Begründet: dokumentieren und — falls Policy blockiert — gezielte Ausnahme einrichten."],
          links: [{ label: "Postfächer (EXO)", url: PORTAL.mailbox }], tab: "mailboxes"
        });
      }
      const perUser = {};
      for (const r of rules) {
        perUser[r.mailbox] = perUser[r.mailbox] || { mailbox: r.mailbox, rules: 0, enabled: 0, forwarding: 0, external: 0, suspicious: 0 };
        const u = perUser[r.mailbox];
        u.rules++; if (r.enabled) u.enabled++; if (r.forwardTo.length) u.forwarding++; if (r.external.length) u.external++; if (r.suspicious) u.suspicious++;
      }
      const snapshot = {};
      for (const r of rules) snapshot[r.mailbox + ":" + r.ruleId] = { mailbox: r.mailbox, name: r.name, enabled: r.enabled, forwardTo: r.forwardTo, delete: r.delete, moveTo: r.moveTo };
      for (const m of mbxFwd) snapshot["fwd:" + m.mailbox] = { mailbox: m.mailbox, to: m.to, keepCopy: m.keepCopy };
      res.mailboxes = {
        metrics: [
          metric("Postfächer geprüft", `${raw.scanned || 0}/${raw.mailboxCount || 0}`, (raw.scanned || 0) < (raw.mailboxCount || 0) ? "warn" : "ok"),
          metric("Mit eigenen Regeln", Object.keys(perUser).length),
          metric("Externe Weiterleitung", rules.filter(r => r.external.length).length + mbxFwd.filter(m => m.external).length,
            (rules.some(r => r.external.length && r.enabled) || mbxFwd.some(m => m.external)) ? (fwdBlocked ? "warn" : "crit") : "ok"),
          metric("Verdächtig", rules.filter(r => r.suspicious).length, rules.some(r => r.suspicious) ? "crit" : "ok")
        ],
        data: { perUser: Object.values(perUser).sort((a, b) => b.external - a.external || b.suspicious - a.suspicious || b.rules - a.rules), rules: rules.slice(0, 1500), mailboxForwarding: mbxFwd, forwarding: { mode: fwdMode, blocked: fwdBlocked }, scanned: raw.scanned || 0, total: raw.mailboxCount || 0 },
        snapshot, findings
      };
    }
  }

  // ---------------- Persoenliche Block-/Allow-Listen + Tenant Allow/Block List
  if (parts.includes("senderlists")) {
    if (errs.mailboxes) res.senderlists = { error: "Postfächer nicht lesbar: " + errs.mailboxes };
    else {
      const junk = arr(raw.junk).map(j => ({ mailbox: String(j.Mailbox || "").toLowerCase(), enabled: !!j.Enabled, trusted: arr(j.Trusted).map(x => String(x).toLowerCase()), blocked: arr(j.Blocked).map(x => String(x).toLowerCase()) }));
      const tabl = arr(raw.tabl).map(x => ({ type: x.ListType, value: x.Value, action: x.Action, expires: x.Expiration || null, modified: x.Modified || null, notes: x.Notes || "", id: x.Id }));
      const findings = [];
      for (const j of junk) {
        const own = j.trusted.filter(x => accepted.has(x.replace(/^.*@/, "")) || accepted.has(x));
        const free = j.trusted.filter(x => FREEMAIL.test(x.replace(/^.*@/, "")) && !x.includes("@"));
        if (own.length || free.length) {
          findings.push({
            key: "trustown:" + j.mailbox, severity: "medium", entity: j.mailbox,
            title: `Sichere Absender umgehen den Spoofing-Schutz: ${j.mailbox}`,
            summary: `${own.length ? "Eigene Domäne(n) " + own.slice(0, 3).join(", ") : ""}${own.length && free.length ? " und " : ""}${free.length ? "ganze Freemail-Domänen " + free.slice(0, 3).join(", ") : ""} stehen in der persönlichen Liste «Sichere Absender». Gefälschte Mails mit diesen Absendern landen im Posteingang.`,
            context: [["Postfach", j.mailbox], ["Sichere Absender", String(j.trusted.length)]],
            steps: ["Einträge der eigenen Domäne und ganzer Freemail-Domänen aus der Liste des Benutzers entfernen (Outlook → Junk-E-Mail-Optionen bzw. Set-MailboxJunkEmailConfiguration).",
              "Benutzer kurz informieren, warum. Wiederkehrend legitime Einzeladressen dürfen bleiben."],
            links: [{ label: "Postfächer (EXO)", url: PORTAL.mailbox }], tab: "senderlists"
          });
        }
        if (!j.enabled) {
          findings.push({ key: "junkoff:" + j.mailbox, severity: "low", entity: j.mailbox, title: `Junk-E-Mail-Filter im Postfach ausgeschaltet: ${j.mailbox}`,
            summary: "Spam, den EOP nur markiert (SCL 5–6), landet im Posteingang statt im Junk-Ordner.",
            steps: ["Junk-E-Mail-Regel im Postfach wieder aktivieren (Set-MailboxJunkEmailConfiguration -Enabled $true)."], links: [{ label: "Postfächer (EXO)", url: PORTAL.mailbox }], tab: "senderlists" });
        }
      }
      for (const x of tabl.filter(x => /allow/i.test(x.action) && (!x.expires || /never|^$/i.test(String(x.expires)) || String(x.expires).startsWith("12/31/9999") || String(x.expires).startsWith("9999")))) {
        findings.push({
          key: "tablallow:" + x.type + ":" + x.value, severity: "medium",
          title: `Dauerhafter Allow-Eintrag (${x.type}): ${cut(x.value, 70)}`,
          summary: "Allow-Einträge ohne Ablauf umgehen Filter dauerhaft. Microsoft empfiehlt Ablaufdaten; Absender-Allows sollten nach Bereinigung des False Positives auslaufen.",
          context: [["Liste", x.type], ["Wert", x.value], ["Notiz", x.notes || "—"]],
          steps: ["Grund des Eintrags klären (Notiz, Ticket).", "Ablaufdatum setzen (z. B. 30/45 Tage) oder Eintrag entfernen, wenn das Filterproblem behoben ist."],
          links: [{ label: "Tenant Allow/Block List", url: PORTAL.tabl }], tab: "senderlists"
        });
      }
      const snapshot = {};
      for (const j of junk) {
        for (const v of j.trusted) snapshot["t:" + j.mailbox + ":" + v] = { mailbox: j.mailbox, list: "Sichere Absender", value: v };
        for (const v of j.blocked) snapshot["b:" + j.mailbox + ":" + v] = { mailbox: j.mailbox, list: "Blockierte Absender", value: v };
      }
      for (const x of tabl) snapshot["tabl:" + x.type + ":" + x.action + ":" + x.value] = { mailbox: "(Tenant)", list: `Tenant ${x.action} ${x.type}`, value: x.value };
      res.senderlists = {
        metrics: [
          metric("Postfächer mit eigener Liste", junk.filter(j => j.trusted.length || j.blocked.length).length),
          metric("Sichere Absender", junk.reduce((n, j) => n + j.trusted.length, 0)),
          metric("Blockierte Absender", junk.reduce((n, j) => n + j.blocked.length, 0)),
          metric("Tenant-Liste", tabl.length + " Einträge", tabl.some(x => /allow/i.test(x.action)) ? "warn" : "ok")
        ],
        data: { junk: junk.slice(0, 1500), tabl, scanned: raw.scanned || 0, total: raw.mailboxCount || 0, errors: Object.fromEntries(Object.entries(errs).filter(([k]) => k.startsWith("tabl_"))) },
        snapshot, findings
      };
    }
  }
  return { results: res, facts };
}

async function collectExo(tenant, cert, parts, opts, onProgress) {
  const script = exoScript({ parts, maxMailboxes: opts && opts.maxMailboxes });
  const r = await EXO.runExo({ appId: tenant.clientId, organization: tenant.organization, certPemPath: cert }, script, 40 * 60000,
    p => { if (p && p.label && onProgress) onProgress("Exchange: " + p.label); });
  if (!r.ok) throw new Error(r.error || "Exchange-Lauf fehlgeschlagen");
  if (r.data && r.data.ok === false) throw new Error(r.data.error || "Exchange-Verbindung fehlgeschlagen");
  return evaluateExo(r.data || {}, parts);
}

const GRAPH_COLLECTORS = {
  ca: collectCa, risk: collectRisk, score: collectScore, consent: collectConsent,
  devices: collectDevices, licenses: collectLicenses
};

module.exports = {
  GRAPH_COLLECTORS, collectMessages, collectSharing, collectExo, evaluateExo, lastPolicyActor, PORTAL, strip, cut, arr, mcSections, mcVerdict, teamsDevices
};
