"use strict";
/**
 * App-Hygiene: prueft die vorhandenen Win32-Apps eines Tenants gegen das
 * gemeinsame Grundgeruest aus der Wissensbasis (Kap. 9.7).
 *
 * Der Anlass sind reale Befunde aus zwei Kundentenants — Kundenname im
 * App-Namen, ein zweites Mal derselbe Installer in der Kommandozeile, ein
 * Bitdefender-Token auf en-US neben einem auf de-DE, "n-Abel" als Hersteller,
 * leeres Mindest-Betriebssystem. Nichts davon faellt im Portal auf, jedes
 * einzelne kostet spaeter Zeit.
 *
 * Rein lesend. Das Modul aendert nichts — es sagt, was zu aendern ist, und wo.
 * Graph: GET /deviceAppManagement/mobileApps (+ Detail je App).
 * Permission: DeviceManagementApps.ReadWrite.All (hat das Tool bereits).
 */
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true, retryTransient: true };
const WIN32_TYPE = "#microsoft.graph.win32LobApp";

// Was ueber alle Tenants gleich heissen muss. Der Abgleich laeuft ueber die
// Erkennungsmuster, nicht ueber den Anzeigenamen — der ist ja gerade das, was
// hier haeufig falsch ist.
const BEKANNTE_AGENTS = [
  {
    key: "rmm",
    label: "RMM-Agent (N-able N-sight)",
    match: /advanced monitoring|n-?sight|n-?able|AGENT_\d+_V/i,
    sollPublisher: "N-able Technologies Ltd",
    publisherFalsch: /^n-?abel/i,
    sollName: "Advanced Monitoring Agent",
    beschreibungsMuster: /igeeks RMM Client/i,
    hinweisErkennung: "Inno-Setup schreibt weder DisplayVersion noch Publisher in die Registry. Eine Registry-Erkennung mit Versionsvergleich läuft deshalb ins Leere und rollt den Agent endlos neu aus — Datei-Regel auf winagent.exe, Version „grösser oder gleich“."
  },
  {
    key: "bitdefender",
    label: "Bitdefender Endpoint Security",
    match: /bitdefender|setupdownloader/i,
    sollPublisher: "Bitdefender",
    sollName: "Bitdefender Endpoint Security",
    beschreibungsMuster: /Bitdefender Endpoint Security Agent/i
  },
  {
    key: "bitwarden",
    label: "Bitwarden",
    match: /bitwarden/i,
    sollPublisher: "Bitwarden Inc.",
    sollName: "Bitwarden"
  },
  {
    key: "forticlient",
    label: "FortiClient",
    match: /forticlient/i,
    sollPublisher: "Fortinet"
  }
];

// ---------------------------------------------------------------- Bitdefender-Token
/**
 * Das Token in eckigen Klammern hinter `setupdownloader_` ist die komplette
 * Paket-URL, Base64-kodiert — Bitdefender ersetzt darin "/" durch "-".
 * Dekodiert steht dort die GravityZone-Paket-URL samt Sprache. Damit laesst
 * sich jede vorgefundene Kommandozeile pruefen, ohne sie auszufuehren.
 *
 * Das Token ist kundenspezifisch und wie ein Geheimnis zu behandeln: Wer es
 * hat, kann Geraete in den GravityZone-Mandanten des Kunden einschreiben.
 * Deshalb gibt dieses Modul es NIE vollstaendig zurueck, sondern nur gekuerzt.
 */
function decodeBitdefenderToken(token) {
  const raw = String(token || "");
  if (!raw) return null;
  let text;
  try {
    text = Buffer.from(raw.replace(/-/g, "/"), "base64").toString("utf8");
  } catch (e) {
    return { lesbar: false, grund: "Token liess sich nicht als Base64 lesen." };
  }
  if (!/^https?:\/\//i.test(text)) {
    return { lesbar: false, grund: "Dekodiert steht dort keine URL — vermutlich kein GravityZone-Token." };
  }
  let url;
  try { url = new URL(text); } catch (e) { return { lesbar: false, grund: "Dekodierter Inhalt ist keine gültige URL." }; }

  // .../Packages/BSTWIN/0/<PaketID>/installer.xml?lang=<Sprache>
  const teile = url.pathname.split("/").filter(Boolean);
  const paketId = teile.length >= 2 ? teile[teile.length - 2] : null;
  return {
    lesbar: true,
    host: url.host,
    paketId,
    sprache: url.searchParams.get("lang") || null,
    tokenKurz: kuerzeToken(raw)
  };
}

/** Token nur in erkennbarer Kurzform — nie vollstaendig in Oberflaeche oder Log. */
function kuerzeToken(raw) {
  const t = String(raw || "");
  return t.length <= 14 ? t : `${t.slice(0, 6)}…${t.slice(-6)}`;
}

/** Alle setupdownloader-Tokens einer Kommandozeile, in Reihenfolge. */
function bitdefenderTokens(commandLine) {
  const out = [];
  const re = /setupdownloader_\[([A-Za-z0-9+\-=_]+)\]/gi;
  let m;
  while ((m = re.exec(String(commandLine || ""))) !== null) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------- Pruefungen
/** Nennt der Anzeigename den Kunden? Vergleich gegen Tenantname und Domain-Labels. */
function kundennameImNamen(displayName, tenant) {
  const name = String(displayName || "");
  const kandidaten = new Set();
  String((tenant && tenant.name) || "").split(/[^A-Za-zÄÖÜäöü0-9]+/).forEach(w => { if (w.length >= 4) kandidaten.add(w.toLowerCase()); });
  const org = String((tenant && tenant.organization) || "");
  org.split(".").forEach(w => { if (w.length >= 4 && !/^(onmicrosoft|com|ch|net|org)$/i.test(w)) kandidaten.add(w.toLowerCase()); });

  const treffer = [...kandidaten].filter(k => name.toLowerCase().includes(k));
  return treffer.length ? treffer : null;
}

function befund(schwere, titel, text, empfehlung) {
  return { schwere, titel, text, empfehlung: empfehlung || null };
}

/**
 * Eine einzelne App pruefen. `app` ist das Graph-Detailobjekt einer win32LobApp,
 * `assignments` die dazugehoerigen Zuweisungen mit aufgeloesten Gruppennamen.
 */
function pruefeApp(app, assignments, tenant) {
  const agent = BEKANNTE_AGENTS.find(a =>
    a.match.test(String(app.displayName || "")) ||
    a.match.test(String(app.installCommandLine || "")) ||
    a.match.test(String(app.setupFilePath || ""))
  ) || null;

  const funde = [];
  const cmd = String(app.installCommandLine || "");

  // --- Kundenname im Anzeigenamen
  const treffer = kundennameImNamen(app.displayName, tenant);
  if (treffer) {
    funde.push(befund("warn", "Kundenname im App-Namen",
      `Der Anzeigename enthält „${treffer.join("“, „")}“. Der Tenant ist der Kunde — der Name doppelt die Information und bricht den Abgleich über alle Tenants.`,
      "Anzeigename auf den reinen Produktnamen kürzen, Kundenbezug in die Beschreibung."));
  }

  // --- Mindest-Betriebssystem
  const minOs = app.minimumSupportedWindowsRelease || (app.minimumSupportedOperatingSystem
    ? Object.keys(app.minimumSupportedOperatingSystem).find(k => app.minimumSupportedOperatingSystem[k] === true)
    : null);
  if (!minOs) {
    funde.push(befund("warn", "Mindest-Betriebssystem nicht gesetzt",
      "Ohne Wert versucht Intune die Installation auch auf abgekündigten Builds und produziert Fehler statt „nicht anwendbar“.",
      "Niedrigsten im Tenant unterstützten Build setzen (Regelfall Windows 10 22H2)."));
  }

  // --- Installer-Dateiname gegen Kommandozeile
  const setupDatei = String(app.setupFilePath || "").trim();
  if (setupDatei && cmd && !cmd.toLowerCase().includes(setupDatei.toLowerCase())) {
    funde.push(befund("fehler", "Kommandozeile nennt eine andere Datei als die hochgeladene",
      `Hochgeladen ist „${setupDatei}“, die Kommandozeile startet „${cmd.split(/\s+/)[0]}“.`,
      "Die häufigste Fehlerquelle nach einem Versions- oder Paketwechsel — Kommandozeile auf den tatsächlichen Dateinamen ziehen."));
  }

  // --- Bitdefender: doppelte Nennung und fremde Tokens
  const tokens = bitdefenderTokens(cmd);
  let bitdefender = null;
  if (tokens.length) {
    const einzeln = [...new Set(tokens)];
    const dekodiert = einzeln.map(t => ({ token: kuerzeToken(t), ...decodeBitdefenderToken(t) }));
    bitdefender = { anzahlNennungen: tokens.length, tokens: dekodiert };

    if (tokens.length > 1 && einzeln.length === 1) {
      funde.push(befund("warn", "Installer steht zweimal in der Kommandozeile",
        "Derselbe setupdownloader wird zweimal genannt. Der zweite Aufruf ist ein toter Parameter, aus einer Vorlage mitgeschleppt.",
        "Auf eine einzige Nennung kürzen: setupdownloader_[<Token>].exe /bdparams /silent"));
    }
    if (einzeln.length > 1) {
      const sprachen = [...new Set(dekodiert.map(d => d.sprache).filter(Boolean))];
      funde.push(befund("fehler", "Zwei verschiedene GravityZone-Pakete in einer Kommandozeile",
        `Die Zeile nennt ${einzeln.length} unterschiedliche Tokens${sprachen.length > 1 ? ` (Sprachen: ${sprachen.join(", ")})` : ""}. Welches Paket installiert wird, hängt allein an der ersten Nennung.`,
        "Auf ein Token reduzieren — passend zur hochgeladenen Datei — und auf einem Testgerät verifizieren."));
    }
    const unlesbar = dekodiert.filter(d => d.lesbar === false);
    if (unlesbar.length) {
      funde.push(befund("warn", "Token nicht lesbar",
        unlesbar.map(u => u.grund).join(" "),
        "Kommandozeile gegen das Paket aus GravityZone prüfen."));
    }
  }

  // --- Agent-spezifische Sollwerte
  if (agent) {
    const publisher = String(app.publisher || "").trim();
    if (agent.publisherFalsch && agent.publisherFalsch.test(publisher)) {
      funde.push(befund("warn", "Hersteller falsch geschrieben",
        `Eingetragen ist „${publisher}“.`,
        `Korrekt ist „${agent.sollPublisher}“ — so steht es auch in der Registry des installierten Agents.`));
    } else if (!publisher) {
      funde.push(befund("warn", "Hersteller leer", "Das Feld ist in Patch My PC Pflicht und landet in Intune als publisher.",
        agent.sollPublisher ? `Erwartet: „${agent.sollPublisher}“.` : null));
    }

    const beschreibung = String(app.description || "").trim();
    if (agent.beschreibungsMuster && !agent.beschreibungsMuster.test(beschreibung)) {
      funde.push(befund("hinweis", "Beschreibung ohne Kundenbezug",
        beschreibung ? `Eingetragen ist „${beschreibung.slice(0, 80)}“.` : "Das Feld ist leer.",
        "Ohne Kundenbezug sehen zwei Kundentenants in der Patch-My-PC-Übersicht identisch aus — Form: „igeeks RMM Client – <Kunde>“."));
    }

    if (agent.key === "rmm") {
      const regelTypen = (app.detectionRules || []).map(r => String(r["@odata.type"] || ""));
      const hatRegistryRegel = regelTypen.some(t => /RegistryDetection/i.test(t));
      const hatDateiRegel = regelTypen.some(t => /FileSystemDetection/i.test(t));
      if (hatRegistryRegel && !hatDateiRegel) {
        funde.push(befund("warn", "Erkennung über die Registry", agent.hinweisErkennung,
          "Datei-Regel: C:\\Program Files (x86)\\Advanced Monitoring Agent, winagent.exe, Versionsvergleich „grösser oder gleich“."));
      }
      if (!regelTypen.length) {
        funde.push(befund("hinweis", "Keine Erkennungsregel auslesbar",
          "Graph liefert für diese App keine detectionRules — im Portal prüfen, ob eine gesetzt ist.", null));
      }
    }
  }

  // --- Zuweisung: 1:1-Prinzip
  const required = assignments.filter(a => a.intent === "required");
  const available = assignments.filter(a => a.intent === "available" || a.intent === "availableWithoutEnrollment");
  const uninstall = assignments.filter(a => a.intent === "uninstall");

  if (agent && !required.length) {
    funde.push(befund("fehler", "Pflicht-Agent ohne Required-Zuweisung",
      assignments.length ? "Es gibt Zuweisungen, aber keine mit Intent „Erforderlich“." : "Diese App ist niemandem zugewiesen.",
      "Pflicht-Agents werden still erzwungen — genau eine Gruppe unter „Erforderlich“."));
  }
  if (required.length > 1) {
    funde.push(befund("warn", "Mehr als eine Required-Gruppe",
      `Zugewiesen an: ${required.map(a => a.gruppe).join(", ")}.`,
      "1:1-Prinzip: genau eine App-Zielgruppe je App, gesteuert über das Nesting der Gerätegruppen."));
  }
  if (agent && available.length) {
    funde.push(befund("hinweis", "Zusätzlich als „Verfügbar“ zugewiesen",
      "Pflicht-Agents gehören nicht als Selbstbedienung ins Unternehmensportal.", "Available-Zuweisung entfernen."));
  }
  if (uninstall.length) {
    funde.push(befund("warn", "Uninstall-Zuweisung vorhanden",
      `Deinstallation zugewiesen an: ${uninstall.map(a => a.gruppe).join(", ")}.`,
      "Ein Agent wird beim Geräte-Offboarding entfernt, nicht per Gruppenwechsel."));
  }
  const leere = assignments.filter(a => a.mitgliederBekannt && a.mitglieder === 0);
  if (leere.length) {
    funde.push(befund("warn", "Zielgruppe erreicht kein Gerät",
      `Leer: ${leere.map(a => a.gruppe).join(", ")}.`,
      "Der häufigste stille Fehler: Gruppe da, App zugewiesen, aber niemand drin."));
  }

  return {
    id: app.id,
    displayName: app.displayName,
    publisher: app.publisher || "",
    description: app.description || "",
    version: app.displayVersion || null,
    setupFilePath: app.setupFilePath || null,
    installCommandLine: maskiereTokens(cmd),
    minimumSupportedWindowsRelease: app.minimumSupportedWindowsRelease || null,
    agent: agent ? { key: agent.key, label: agent.label } : null,
    bitdefender,
    assignments,
    funde,
    schwere: funde.some(f => f.schwere === "fehler") ? "fehler" : (funde.some(f => f.schwere === "warn") ? "warn" : (funde.length ? "hinweis" : "ok"))
  };
}

/** Kommandozeile fuer die Anzeige entschaerfen: Tokens raus, Rest bleibt lesbar. */
function maskiereTokens(cmd) {
  return String(cmd || "").replace(/setupdownloader_\[([A-Za-z0-9+\-=_]+)\]/gi,
    (_, t) => `setupdownloader_[${kuerzeToken(t)}]`);
}

// ---------------------------------------------------------------- Einsammeln
/**
 * Alle Win32-Apps eines Tenants pruefen.
 *
 * Zwei Runden: erst die Liste (billig, eine Abfrage), dann je App das Detail —
 * Erkennungsregeln und Kommandozeile stehen in der Sammelabfrage nicht
 * zuverlaessig drin. Bei sehr vielen Apps wird die Detailrunde begrenzt, damit
 * ein Tenant mit hunderten Apps nicht in einen Timeout laeuft.
 */
async function pruefeTenant(tenant, certPemPath, opts) {
  const maxDetails = (opts && opts.maxDetails) || 60;

  const alle = await graphAllPages(tenant, certPemPath,
    "/deviceAppManagement/mobileApps?$expand=assignments&$top=50", BETA);
  const win32 = alle.filter(a => String(a["@odata.type"] || "") === WIN32_TYPE);

  // Gruppennamen und Mitgliederzahlen einmal aufloesen — dieselbe Gruppe taucht
  // typischerweise an mehreren Apps auf.
  const groupIds = new Set();
  win32.forEach(a => (a.assignments || []).forEach(x => {
    const gid = x.target && x.target.groupId;
    if (gid) groupIds.add(gid);
  }));
  const gruppen = new Map();
  for (const gid of groupIds) {
    try {
      const g = await graphReq(tenant, certPemPath, "GET", `/groups/${gid}?$select=displayName,groupTypes`);
      let mitglieder = null;
      try {
        const c = await graphReq(tenant, certPemPath, "GET", `/groups/${gid}/members/$count`, null,
          { headers: { ConsistencyLevel: "eventual" } });
        mitglieder = typeof c === "number" ? c : Number(c && c.raw);
      } catch (e) { /* Mitgliederzahl ist Kuer, kein Muss */ }
      gruppen.set(gid, { name: g.displayName, mitglieder: Number.isFinite(mitglieder) ? mitglieder : null });
    } catch (e) {
      gruppen.set(gid, { name: gid + " (nicht auflösbar)", mitglieder: null });
    }
  }

  const apps = [];
  let detailFehlt = 0;
  for (const kurz of win32) {
    let voll = kurz;
    if (apps.length < maxDetails) {
      try {
        voll = await graphReq(tenant, certPemPath, "GET", `/deviceAppManagement/mobileApps/${kurz.id}`, null, BETA);
      } catch (e) { detailFehlt++; }
    } else {
      detailFehlt++;
    }

    const assignments = (kurz.assignments || []).map(a => {
      const gid = a.target && a.target.groupId;
      const g = gid ? gruppen.get(gid) : null;
      const typ = String((a.target || {})["@odata.type"] || "");
      return {
        intent: a.intent || "unbekannt",
        gruppe: g ? g.name : (/allDevices/i.test(typ) ? "Alle Geräte" : (/allLicensedUsers/i.test(typ) ? "Alle Benutzer" : (gid || typ))),
        mitglieder: g ? g.mitglieder : null,
        mitgliederBekannt: !!(g && g.mitglieder !== null)
      };
    });

    apps.push(pruefeApp(voll, assignments, tenant));
  }

  apps.sort((a, b) => {
    const rang = { fehler: 0, warn: 1, hinweis: 2, ok: 3 };
    const d = rang[a.schwere] - rang[b.schwere];
    return d !== 0 ? d : String(a.displayName).localeCompare(String(b.displayName));
  });

  return {
    apps,
    zusammenfassung: {
      gesamt: apps.length,
      fehler: apps.filter(a => a.schwere === "fehler").length,
      warn: apps.filter(a => a.schwere === "warn").length,
      hinweis: apps.filter(a => a.schwere === "hinweis").length,
      ok: apps.filter(a => a.schwere === "ok").length,
      agents: apps.filter(a => a.agent).length,
      detailFehlt
    }
  };
}

module.exports = {
  pruefeTenant, pruefeApp, decodeBitdefenderToken, bitdefenderTokens,
  kundennameImNamen, maskiereTokens, kuerzeToken, BEKANNTE_AGENTS
};
