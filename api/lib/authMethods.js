"use strict";
/**
 * Authentifizierungsmethoden: die Richtlinie gegen die Realitaet.
 *
 * Warum beides noetig ist: Die Methodenrichtlinie sagt, was ERLAUBT ist. Was
 * BENUTZT wird, steht an den Benutzern. Bei PSP standen am 02.10.2026 alle fuenf
 * relevanten Methoden auf `disabled` — und vier Benutzer hatten trotzdem
 * Microsoft Authenticator registriert. Kein Widerspruch, sondern der Beleg
 * dafuer, dass die Migration nicht abgeschlossen war (`policyMigrationState`)
 * und die alte MFA-Verwaltung parallel weiterlief.
 *
 * Daraus folgt: Ein Blick in die Methodenrichtlinie allein beschreibt den
 * Mandanten NICHT. Ein Screenshot davon ist bis zum Abschluss der Migration
 * kein Beleg. Genau das soll dieser Bereich sagen, statt es jeden selbst
 * herausfinden zu lassen.
 *
 * Der zweite Ertrag ist die Folgenabschaetzung: Telefon (SMS/Anruf) gilt als
 * phishbar und gehoert abgeschaltet — aber nur, wenn niemand es als EINZIGE
 * Methode hat. Diese Zahl steht nirgends im Portal.
 *
 * Ausschliesslich lesend. Das Schreiben der Methodenrichtlinie braucht
 * Policy.ReadWrite.AuthenticationMethod, das die App bewusst nicht hat — die
 * Aenderung gehoert ins Skript oder ins Portal, mit Protokoll.
 */
const { graphReq, graphAllPages } = require("./graph");

const V1 = { retryTransient: 4 };

// Anzeigenamen und fachliche Einordnung. `soll` ist eine Empfehlung, keine
// Messlatte — der Bereich bewertet nicht, er stellt gegenueber.
const METHODEN = {
  microsoftAuthenticator: { label: "Authenticator-App", soll: "enabled", grund: "Trag-Methode, bei Nummernabgleich nicht phishbar" },
  fido2: { label: "FIDO2-Schlüssel", soll: "enabled", grund: "stärkste Methode, keine Nachteile" },
  softwareOath: { label: "OATH-Token (Software)", soll: "enabled", grund: "Reserve, typisch für Notfallkonten" },
  hardwareOath: { label: "OATH-Token (Hardware)", soll: null, grund: "optional" },
  temporaryAccessPass: { label: "Befristeter Zugriffspass", soll: "enabled", grund: "Einführung neuer Geräte ohne Telefon" },
  sms: { label: "SMS", soll: "disabled", grund: "phishbar, SIM-Swap" },
  voice: { label: "Telefonanruf", soll: "disabled", grund: "phishbar" },
  email: { label: "E-Mail", soll: "disabled", grund: "als Anmeldefaktor ungeeignet" },
  x509Certificate: { label: "Zertifikat", soll: null, grund: "nur mit eigener PKI" },
  qrCodePin: { label: "QR-Code mit PIN", soll: null, grund: "Sonderfall Frontline" }
};

// Welche registrierte Methode entspricht welcher Richtlinie? Der Report
// userRegistrationDetails benennt Methoden anders als die Richtlinie.
const REG_ZU_METHODE = {
  microsoftAuthenticatorPush: "microsoftAuthenticator",
  microsoftAuthenticatorPasswordless: "microsoftAuthenticator",
  softwareOneTimePasscode: "softwareOath",
  hardwareOneTimePasscode: "hardwareOath",
  mobilePhone: "sms",
  officePhone: "voice",
  alternateMobilePhone: "sms",
  email: "email",
  fido2SecurityKey: "fido2",
  passKeyDeviceBound: "fido2",
  passKeyDeviceBoundAuthenticator: "fido2",
  passKeyDeviceBoundWindowsHello: "windowsHelloForBusiness",
  windowsHelloForBusiness: "windowsHelloForBusiness",
  temporaryAccessPass: "temporaryAccessPass",
  x509Certificate: "x509Certificate"
};

// Methoden, die als zweiter Faktor taugen. Kennwort und SSPR-Varianten nicht.
const KEIN_FAKTOR = new Set(["password", "securityQuestion", "email"]);

async function analyse(tenant, cert, say) {
  say = say || (() => {});
  const luecken = [];

  say("Methodenrichtlinie lesen");
  let amp = null;
  try {
    amp = await graphReq(tenant, cert, "GET", "/policies/authenticationMethodsPolicy", null, V1);
  } catch (e) {
    return { ok: false, error: "Methodenrichtlinie nicht lesbar (Policy.Read.All): " + e.message };
  }

  say("Registrierte Methoden je Benutzer lesen");
  let reg = [];
  try {
    reg = await graphAllPages(tenant, cert, "/reports/authenticationMethods/userRegistrationDetails?$top=999", V1);
  } catch (e) {
    luecken.push("Registrierungsbericht nicht lesbar (UserAuthenticationMethod.Read.All bzw. Reports.Read.All): " + e.message);
  }

  // --- Je Methode: Zustand der Richtlinie gegen die Zahl der Registrierungen
  const konf = new Map();
  for (const c of (amp.authenticationMethodConfigurations || [])) konf.set(c.id, c);

  const registriertJeMethode = new Map();
  for (const r of reg) {
    for (const m of (r.methodsRegistered || [])) {
      const key = REG_ZU_METHODE[m] || m;
      registriertJeMethode.set(key, (registriertJeMethode.get(key) || 0) + 1);
    }
  }

  const zeilen = [];
  for (const [id, meta] of Object.entries(METHODEN)) {
    const c = konf.get(id);
    if (!c) continue;
    const registriert = registriertJeMethode.get(id) || 0;
    const zeile = {
      id, label: meta.label, zustand: c.state, soll: meta.soll, grund: meta.grund,
      registriert,
      ziel: (c.includeTargets || []).map(t => t.id === "all_users" ? "alle Benutzer" : (t.id || t.targetType)).join(", "),
      befund: null
    };
    // Der Fall, der bei PSP den Ausschlag gab: aus in der Richtlinie, aber
    // benutzt. Das ist kein Konfigurationsfehler, sondern ein Hinweis darauf,
    // dass die Richtlinie nicht die wirksame Stelle ist.
    if (c.state === "disabled" && registriert > 0) {
      zeile.befund = `In der Richtlinie aus, aber von ${registriert} Konto(en) registriert — die Richtlinie ist hier nicht die wirksame Stelle.`;
    } else if (meta.soll && c.state !== meta.soll) {
      zeile.befund = meta.soll === "enabled"
        ? "Empfohlen, aber nicht eingeschaltet."
        : "Empfohlen abzuschalten.";
    }
    zeilen.push(zeile);
  }

  // --- Folgenabschaetzung je abschaltbarer Methode: wer verliert dadurch
  // seinen EINZIGEN zweiten Faktor?
  const konten = [];
  for (const r of reg) {
    const faktoren = (r.methodsRegistered || [])
      .map(m => REG_ZU_METHODE[m] || m)
      .filter(m => !KEIN_FAKTOR.has(m));
    konten.push({
      upn: r.userPrincipalName, name: r.userDisplayName,
      istAdmin: !!r.isAdmin,
      mfaRegistriert: r.isMfaRegistered !== false,
      faktoren: [...new Set(faktoren)]
    });
  }

  const folgen = [];
  for (const z of zeilen) {
    if (z.soll !== "disabled" || z.zustand === "disabled") continue;
    const betroffen = konten.filter(k => k.faktoren.includes(z.id));
    const verlieren = betroffen.filter(k => k.faktoren.filter(f => f !== z.id).length === 0);
    folgen.push({
      id: z.id, label: z.label,
      betroffen: betroffen.length,
      verlierenAllesText: verlieren.map(k => k.upn),
      sperrbar: verlieren.length === 0
    });
  }

  const ohneMfa = konten.filter(k => !k.faktoren.length);

  // --- Migrationsstand: der Punkt, der alles andere relativiert
  const migration = {
    stand: amp.policyMigrationState || "(unbekannt)",
    abgeschlossen: amp.policyMigrationState === "migrationComplete"
  };

  const befunde = [];
  if (!migration.abgeschlossen) {
    befunde.push({
      state: "warn",
      text: `Migration nicht abgeschlossen (${migration.stand}). Bis dahin gilt die alte MFA-/SSPR-Verwaltung teilweise parallel weiter — die Methodenrichtlinie allein beschreibt den Mandanten nicht, und ein Screenshot davon ist kein Beleg.`
    });
  }
  if (ohneMfa.length) {
    befunde.push({
      state: "fail",
      text: `${ohneMfa.length} Konto(en) ohne jeden zweiten Faktor: ${ohneMfa.slice(0, 8).map(k => k.upn).join(", ")}${ohneMfa.length > 8 ? " …" : ""}`
    });
  }
  for (const z of zeilen) {
    if (z.zustand === "disabled" && z.registriert > 0) {
      befunde.push({ state: "warn", text: `${z.label}: ${z.befund}` });
    }
  }
  for (const f of folgen) {
    if (!f.sperrbar) {
      befunde.push({
        state: "warn",
        text: `${f.label} abzuschalten würde ${f.verlierenAllesText.length} Konto(en) ohne zweiten Faktor zurücklassen: ${f.verlierenAllesText.join(", ")}. Erst Alternative registrieren lassen.`
      });
    } else if (f.betroffen > 0) {
      befunde.push({
        state: "ok",
        text: `${f.label} ist abschaltbar: ${f.betroffen} Konto(en) nutzen es, alle haben eine Alternative.`
      });
    }
  }

  return {
    ok: true, migration, zeilen, folgen,
    konten: konten.sort((a, b) => String(a.upn).localeCompare(String(b.upn), "de")),
    ohneMfa: ohneMfa.map(k => k.upn),
    befunde, luecken
  };
}

module.exports = { analyse };
