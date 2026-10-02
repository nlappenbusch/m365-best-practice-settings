"use strict";
/**
 * Notfallkonto: ist es BENUTZBAR?
 *
 * Bisher galt im Conditional-Access-Tab die Gruppe als «gefuellt», sobald sie
 * ein Mitglied hatte (memberCount > 0) — und damit verschwanden auch die
 * Warnungen vor dem Scharfschalten. Das ist zu wenig und war bei PSP am
 * 01.10.2026 nachweislich falsch: Das Konto lag in der Gruppe, war sauber aus
 * allen 21 Richtlinien ausgenommen — und hatte WEDER eine Verzeichnisrolle NOCH
 * einen zweiten Faktor. Es waere im Ernstfall hereingekommen und haette nichts
 * reparieren koennen. Das Werkzeug meldete «✓ Break-Glass gefuellt».
 *
 * Ein Notfallkonto braucht vier Dinge, und drei davon sieht man an der
 * Mitgliederzahl nicht:
 *   1. Das Konto ist aktiviert.
 *   2. Es hat eine Verzeichnisrolle, mit der es reparieren kann (Globaler Admin).
 *   3. Es hat einen zweiten Faktor — sonst sperrt die erste scharfe Richtlinie,
 *      die MFA verlangt, auch das Notfallkonto aus.
 *   4. Es ist aus JEDER Richtlinie ausgenommen, nicht nur aus den eigenen.
 *      Microsoft-managed Policies erscheinen nachtraeglich und kennen die
 *      eigenen Ausschlussgruppen nicht.
 *
 * Dazu: wurde es je benutzt? Ausgenommen zu sein ist keine Funktionspruefung.
 *
 * Ausschliesslich lesend.
 */
const { graphReq, graphAllPages } = require("./graph");

const V1 = { retryTransient: 4 };
const GA_TEMPLATE = "62e90394-69f5-4237-9190-012177145e10";

const METHOD_LABEL = {
  microsoftAuthenticatorAuthenticationMethod: "Authenticator-App",
  phoneAuthenticationMethod: "Telefon",
  fido2AuthenticationMethod: "FIDO2-Schlüssel",
  windowsHelloForBusinessAuthenticationMethod: "Windows Hello",
  emailAuthenticationMethod: "E-Mail",
  passwordAuthenticationMethod: "Kennwort",
  softwareOathAuthenticationMethod: "OATH-Token (Software)",
  temporaryAccessPassAuthenticationMethod: "Befristeter Zugriffspass",
  x509CertificateAuthenticationMethod: "Zertifikat"
};

function L(x) { return Array.isArray(x) ? x.filter(Boolean) : []; }

/**
 * Prueft die Mitglieder der Break-Glass-Gruppe gegen alle vier Kriterien.
 *
 * groupId  — die Break-Glass-Schutzgruppe (null, wenn sie nicht existiert)
 * policies — alle CA-Richtlinien des Mandanten (bereits geladen, um einen
 *            zweiten Abruf zu sparen)
 */
async function checkBreakGlass(tenant, cert, groupId, policies) {
  const befunde = [];
  const mitglieder = [];

  if (!groupId) {
    return {
      vorhanden: false, brauchbar: false, mitglieder: [],
      befunde: ["Die Break-Glass-Gruppe existiert nicht. Ohne Notfallkonto kann eine scharfe Richtlinie den Mandanten aussperren."]
    };
  }

  let rohMitglieder = [];
  try {
    rohMitglieder = await graphAllPages(tenant, cert,
      `/groups/${groupId}/members?$select=id,displayName,userPrincipalName,accountEnabled`, V1);
  } catch (e) {
    return { vorhanden: true, brauchbar: false, mitglieder: [], befunde: ["Mitglieder der Break-Glass-Gruppe nicht lesbar: " + e.message] };
  }

  if (!rohMitglieder.length) {
    return {
      vorhanden: true, brauchbar: false, mitglieder: [],
      befunde: ["Die Break-Glass-Gruppe ist leer. Es gibt kein Notfallkonto."]
    };
  }

  // Rollen einmal fuer alle lesen statt je Konto — bei Mandanten mit vielen
  // Zuweisungen ist das der Unterschied zwischen einem und zwanzig Abrufen.
  let rollenDefs = new Map(), zuweisungen = [];
  try {
    for (const r of await graphAllPages(tenant, cert, "/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId", V1)) {
      rollenDefs.set(r.id, { name: r.displayName, templateId: r.templateId || r.id });
    }
    zuweisungen = await graphAllPages(tenant, cert, "/roleManagement/directory/roleAssignments?$top=999", V1);
  } catch (e) {
    befunde.push("Rollenzuweisungen nicht lesbar (RoleManagement.Read.Directory): " + e.message);
  }

  for (const m of rohMitglieder) {
    const eintrag = {
      id: m.id, upn: m.userPrincipalName || m.id, name: m.displayName || m.userPrincipalName,
      aktiv: m.accountEnabled !== false,
      rollen: [], globalerAdmin: false,
      methoden: [], zweiterFaktor: 0,
      ausgenommenAus: 0, policiesGesamt: policies.length, nichtAusgenommen: [],
      letzteAnmeldung: null, jeBenutzt: null,
      maengel: []
    };

    // --- Rolle
    for (const a of zuweisungen) {
      if (a.principalId !== m.id) continue;
      const def = rollenDefs.get(a.roleDefinitionId);
      if (!def) continue;
      eintrag.rollen.push(def.name);
      if (def.templateId === GA_TEMPLATE) eintrag.globalerAdmin = true;
    }

    // --- Anmeldemethoden
    try {
      const meth = await graphAllPages(tenant, cert, `/users/${m.id}/authentication/methods`, V1);
      for (const x of meth) {
        const t = String(x["@odata.type"] || "").replace("#microsoft.graph.", "");
        eintrag.methoden.push(METHOD_LABEL[t] || t);
        if (t !== "passwordAuthenticationMethod") eintrag.zweiterFaktor++;
      }
    } catch (e) {
      eintrag.maengel.push("Anmeldemethoden nicht lesbar: " + e.message);
    }

    // --- Ausnahmen: direkt oder ueber eine Gruppe, in der das Konto ist
    let eigeneGruppen = new Set([groupId]);
    try {
      const g = await graphAllPages(tenant, cert, `/users/${m.id}/transitiveMemberOf/microsoft.graph.group?$select=id`, V1);
      for (const x of g) eigeneGruppen.add(x.id);
    } catch (e) { /* der Hebel allein genuegt als Naeherung */ }

    for (const p of policies) {
      const u = (p.conditions && p.conditions.users) || {};
      const ok = L(u.excludeUsers).includes(m.id) ||
                 L(u.excludeGroups).some(g => eigeneGruppen.has(g));
      if (ok) eintrag.ausgenommenAus++;
      else eintrag.nichtAusgenommen.push({ name: p.displayName, state: p.state });
    }

    // --- Je benutzt? signInActivity hinkt bei Entra bis zu zwei Stunden nach,
    // das Ueberwachungsprotokoll ist schneller. Ein vom Konto SELBST ausgeloestes
    // Ereignis belegt die Anmeldung mittelbar — eine Methode registriert nur,
    // wer drin war.
    try {
      const u = await graphReq(tenant, cert, "GET",
        `/users?$filter=id eq '${m.id}'&$select=signInActivity`, null, V1);
      const sa = (u.value && u.value[0] && u.value[0].signInActivity) || null;
      if (sa) eintrag.letzteAnmeldung = sa.lastSignInDateTime || sa.lastSuccessfulSignInDateTime || null;
    } catch (e) { /* optional */ }
    if (!eintrag.letzteAnmeldung) {
      try {
        const si = await graphReq(tenant, cert, "GET",
          `/auditLogs/signIns?$filter=userId eq '${m.id}'&$top=10`, null, V1);
        const ok = (si.value || []).filter(s => s.status && s.status.errorCode === 0);
        if (ok.length) eintrag.letzteAnmeldung = ok.map(s => s.createdDateTime).sort().pop();
      } catch (e) { /* optional */ }
    }
    eintrag.jeBenutzt = !!eintrag.letzteAnmeldung;

    // --- Urteil je Konto
    if (!eintrag.aktiv) eintrag.maengel.push("Konto ist deaktiviert");
    if (!eintrag.globalerAdmin) eintrag.maengel.push("keine Rolle Globaler Administrator — kaeme herein, koennte aber nichts reparieren");
    if (!eintrag.zweiterFaktor) eintrag.maengel.push("kein zweiter Faktor — wird von der ersten scharfen MFA-Richtlinie mit ausgesperrt");
    if (eintrag.nichtAusgenommen.length) eintrag.maengel.push(`aus ${eintrag.nichtAusgenommen.length} von ${policies.length} Richtlinien nicht ausgenommen`);
    eintrag.brauchbar = eintrag.maengel.length === 0;

    mitglieder.push(eintrag);
  }

  const brauchbare = mitglieder.filter(x => x.brauchbar);
  if (!brauchbare.length) {
    befunde.push("Kein Mitglied der Break-Glass-Gruppe ist benutzbar. Vor dem Scharfschalten von Conditional Access beheben.");
  }
  // Nie benutzt ist kein Mangel, aber ein offener Nachweis — ausgenommen zu
  // sein ist keine Funktionspruefung.
  const nieBenutzt = brauchbare.filter(x => !x.jeBenutzt);
  if (brauchbare.length && nieBenutzt.length === brauchbare.length) {
    befunde.push("Technisch benutzbar, aber nie angemeldet — die Funktionspruefung fehlt noch.");
  }

  return {
    vorhanden: true,
    brauchbar: brauchbare.length > 0,
    anzahlBrauchbar: brauchbare.length,
    mitglieder,
    befunde
  };
}

module.exports = { checkBreakGlass };
