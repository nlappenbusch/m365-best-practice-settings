"use strict";
/**
 * ServiceDesk Plus — LESENDER Direktzugriff auf die Postgres-Datenbank.
 *
 * Warum ueberhaupt: die V3-API liefert einzelne Tickets und 100er-Seiten. Alles
 * was ueber den Bestand rechnet (Worklogs eines Monats, Ticketverlauf eines
 * Kunden, Soll/Ist je Projekt) waere darueber dutzende Requests -- in SQL ist es
 * eine Abfrage. Gemessen 3 ms Netzlatenz vom Pod zur DB (Diagnose-Tab).
 *
 * GESCHRIEBEN WIRD HIER NIE. Jede Aenderung an SDP laeuft weiter ueber die API
 * (sdp.js). Das ist eine bewusste Entscheidung: ManageEngine supportet keinen
 * Direktzugriff auf die Datenbank, und schreibend waere man bei einem Problem
 * allein. Lesend ist das Risiko ein veraltetes Schema nach einem SDP-Update --
 * das faellt als Fehlermeldung auf, nicht als stille Falschzahl.
 *
 * SQL ist der bevorzugte LESEweg, aber nie der einzige: steht die Verbindung
 * nicht (kein Passwort gesetzt, Instanz ausserhalb des igeeks-Netzes, DB weg),
 * faellt jede Leseoperation auf die API zurueck. ready() ist der Schalter, an
 * dem die aufrufende Stelle das entscheidet.
 *
 * Weil es (Stand 11.09.2026) keinen eigenen read-only Datenbankbenutzer gibt --
 * an der SDP-Datenbank darf nichts angelegt werden --, wird "nur lesen" hier
 * dreifach erzwungen:
 *
 *   1. Verbindungsoption default_transaction_read_only=on. Postgres selbst
 *      weist dann jedes INSERT/UPDATE/DELETE ab.
 *   2. Jede Abfrage laeuft in BEGIN READ ONLY ... ROLLBACK.
 *   3. Die Abfrage wird in SELECT * FROM ( ... ) LIMIT $1 eingepackt. Das
 *      erzwingt eine Ergebnismenge, das Zeilenlimit -- und weil damit ein
 *      Parameter im Spiel ist, laeuft sie ueber das Extended Protocol: mehrere
 *      Statements in einem Aufruf sind dort technisch nicht moeglich.
 *
 * Dazu ein Textfilter gegen die offensichtlichen Faelle. Der ist die schwaechste
 * der vier Schichten und ersetzt keine davon.
 *
 * Zugangsdaten: Host/Port/DB/User aus der Umgebung (Default = die bekannte
 * Instanz), das Passwort bewusst NICHT. Es wird zur Laufzeit gesetzt und lebt
 * nur im Arbeitsspeicher -- nach einem Pod-Neustart ist es weg. Grund: es ist
 * das Passwort des Schema-Owners. Als Secret im Cluster haette jeder, der dort
 * an Secrets kommt, Vollzugriff auf die Ticketdatenbank. Wer den Komfort will,
 * kann SDP_DB_PASSWORD trotzdem setzen -- dann aber bitte im Wissen darum.
 */

const { Pool } = require("pg");

const MAX_ROWS = 2000;
const DEFAULT_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 15000;

// Nur im Prozessspeicher, nie in den State geschrieben.
let runtimePassword = null;
let pool = null;
let poolKey = "";

function config() {
  return {
    host: (process.env.SDP_DB_HOST || "10.0.10.105").trim(),
    port: Number(process.env.SDP_DB_PORT || 65432),
    database: (process.env.SDP_DB_NAME || "servicedesk").trim(),
    user: (process.env.SDP_DB_USER || "sdpadmin").trim()
  };
}

function password() {
  return runtimePassword || (process.env.SDP_DB_PASSWORD || "").trim() || null;
}

/** Status fuer die Oberflaeche -- ohne das Passwort selbst. */
function status() {
  const c = config();
  return {
    host: c.host, port: c.port, database: c.database, user: c.user,
    hasPassword: !!password(),
    fromEnv: !runtimePassword && !!(process.env.SDP_DB_PASSWORD || "").trim(),
    maxRows: MAX_ROWS
  };
}

/**
 * Ist der SQL-Leseweg nutzbar? Der Schalter fuer "SQL bevorzugt, sonst API".
 * Bewusst nur eine Konfigurationspruefung und kein Netzwerktest -- ein Ping pro
 * Leseoperation waere teurer als der Fallback selbst. Faellt die DB waehrend
 * einer Abfrage aus, faengt das der Fehlerpfad der Leseoperation ab.
 */
function ready() {
  return !!password();
}

function setPassword(pw) {
  runtimePassword = String(pw || "").trim() || null;
  closePool();
}

function clearPassword() {
  runtimePassword = null;
  closePool();
}

function closePool() {
  if (pool) { const p = pool; pool = null; poolKey = ""; p.end().catch(() => {}); }
}

function getPool(ssl) {
  const pw = password();
  if (!pw) throw Object.assign(new Error("Kein Datenbank-Passwort gesetzt."), { status: 400 });
  const c = config();
  const key = [c.host, c.port, c.database, c.user, pw, ssl ? "ssl" : "plain"].join("|");
  if (pool && poolKey === key) return pool;
  closePool();
  pool = new Pool({
    host: c.host, port: c.port, database: c.database, user: c.user, password: pw,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    // rejectUnauthorized: false, weil eine interne Datenbank praktisch immer ein
    // selbstsigniertes Zertifikat hat. Es geht hier um den Verbindungstyp, den
    // pg_hba.conf verlangt (hostssl statt host) -- nicht um Serverauthentizitaet.
    ssl: ssl ? { rejectUnauthorized: false } : false,
    // Erste Verteidigungslinie: die Sitzung selbst darf nicht schreiben.
    options: "-c default_transaction_read_only=on -c statement_timeout=" + STATEMENT_TIMEOUT_MS + " -c idle_in_transaction_session_timeout=20000"
  });
  pool.on("error", () => {}); // ein gestorbener Idle-Client darf den Prozess nicht mitnehmen
  poolKey = key;
  return pool;
}

// Welcher Verbindungstyp zuletzt funktioniert hat. Postgres haengt bei einer
// abgelehnten Verbindung an, welchen Typ es geprueft hat ("no encryption" bzw.
// "SSL on"). Steht in pg_hba.conf ein hostssl-Eintrag, scheitert der Klartext-
// versuch und der TLS-Versuch klappt -- also einmal automatisch nachfassen,
// statt den Menschen raten zu lassen.
let sslModus = false;

async function getClient() {
  try {
    return await getPool(sslModus).connect();
  } catch (e) {
    const pgHba = /no pg_hba\.conf entry/i.test(String((e && e.message) || ""));
    if (pgHba && !sslModus) {
      closePool();
      try {
        const client = await getPool(true).connect();
        sslModus = true; // hat geklappt: ab jetzt gleich verschluesselt verbinden
        return client;
      } catch (e2) {
        closePool();
        throw e2;
      }
    }
    throw e;
  }
}

// Alles, was schreibt, Rechte aendert, das Dateisystem anfasst oder nach
// draussen telefoniert. Wortgrenzen, damit last_update/offset/updated_at nicht
// faelschlich anschlagen.
const VERBOTEN = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|reindex|cluster|merge|call|do|lock|listen|notify|prepare|execute|discard|reset|refresh|import|checkpoint|commit|rollback|savepoint|begin|start)\b/i;
// Achtung bei den Funktionsnamen: \b greift nach einem Unterstrich NICHT --
// "\bdblink\b" laesst "dblink_exec" durch (beim Test am 11.09.2026 aufgefallen).
// Deshalb Praefix-Match mit \w*. dblink ist der wichtigste Eintrag der Liste:
// es oeffnet eine EIGENE Verbindung und waere damit der einzige Weg, an der
// Nur-Lese-Sitzung vorbeizuschreiben.
const VERBOTENE_FUNKTIONEN = /\b(dblink\w*|postgres_fdw\w*|pg_read\w*|pg_ls\w*|pg_stat_file\w*|pg_file\w*|pg_logical\w*|lo_import\w*|lo_export\w*|pg_terminate\w*|pg_cancel\w*|pg_sleep\w*|set_config\w*|pg_reload\w*|pg_execute\w*|query_to_xml\w*)/i;

/**
 * Textfilter. Bewusst streng: lieber eine harmlose Abfrage zurueckweisen als
 * eine schaedliche durchlassen. Semikolons sind komplett verboten (auch in
 * Zeichenketten) -- das kostet selten etwas und spart eine Parser-Diskussion.
 */
function pruefen(sql) {
  const s = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!s) throw Object.assign(new Error("Leere Abfrage."), { status: 400 });
  if (s.length > 20000) throw Object.assign(new Error("Abfrage zu lang (max. 20000 Zeichen)."), { status: 400 });
  if (s.includes(";")) {
    throw Object.assign(new Error("Semikolon nicht erlaubt -- es geht genau eine Abfrage pro Aufruf."), { status: 400 });
  }
  if (!/^(select|with)\b/i.test(s)) {
    throw Object.assign(new Error("Nur SELECT (oder WITH ... SELECT) ist erlaubt."), { status: 400 });
  }
  const v = VERBOTEN.exec(s) || VERBOTENE_FUNKTIONEN.exec(s);
  if (v) {
    throw Object.assign(new Error('Schluesselwort "' + v[0] + '" ist hier nicht erlaubt -- dieser Zugang liest nur.'), { status: 400 });
  }
  return s;
}

/**
 * Eine Leseabfrage ausfuehren. Liefert Spalten, Zeilen und ob das Limit
 * gegriffen hat.
 *
 * Fallstrick: der LIMIT-Wrapper macht aus der Abfrage eine Unterabfrage. Ein
 * "SELECT a.*, b.* FROM ... JOIN ..." mit gleichnamigen Spalten scheitert dann
 * mit "column specified more than once" -- Spalten in so einem Fall einzeln
 * benennen oder mit AS umbenennen.
 */
async function query(sql, opts = {}) {
  const s = pruefen(sql);
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_ROWS, 1), MAX_ROWS);
  const started = Date.now();
  // Der Verbindungsaufbau gehoert in denselben Fehlerpfad wie die Abfrage --
  // sonst faellt ein pg_hba-/Passwortfehler ungefangen durch und landet beim
  // Aufrufer als 500 statt als erklaerter 400.
  let client;
  try {
    client = await getClient();
  } catch (e) {
    throw Object.assign(new Error(uebersetzen(e)), { status: 400 });
  }
  try {
    await client.query("BEGIN READ ONLY");
    const r = await client.query({ text: "SELECT * FROM (" + s + ") AS q LIMIT $1", values: [limit] });
    await client.query("ROLLBACK");
    return {
      columns: (r.fields || []).map(f => f.name),
      rows: r.rows || [],
      rowCount: (r.rows || []).length,
      limit,
      truncated: (r.rows || []).length >= limit,
      ms: Date.now() - started
    };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw Object.assign(new Error(uebersetzen(e)), { status: 400 });
  } finally {
    client.release();
  }
}

/** Postgres-Fehler in eine Meldung uebersetzen, mit der man etwas anfangen kann. */
function uebersetzen(e) {
  const m = String((e && e.message) || e);
  // Der haeufigste Fall bei einer fremdverwalteten Datenbank: Port offen,
  // Anmeldung aber gar nicht erst zugelassen. Postgres nennt dabei die
  // Quell-IP -- genau die Angabe, die fuer die Freigabe gebraucht wird.
  if (/no pg_hba\.conf entry/i.test(m)) {
    const ip = (/host "([^"]+)"/i.exec(m) || [])[1];
    return "Postgres laesst diese Verbindung nicht zu (kein Eintrag in pg_hba.conf" +
      (ip ? " fuer " + ip : "") + "). Der Port ist offen, es fehlt die Freigabe der Quelladresse auf dem SDP-Server" +
      (sslModus ? " -- auch verschluesselt abgelehnt." : ", auch verschluesselt.") +
      " Die Adresse wechselt bei jedem Neustart der Instanz, freigegeben werden muss daher das Subnetz.";
  }
  if (e && e.code === "28P01") return "Anmeldung abgelehnt -- Passwort falsch.";
  if (e && e.code === "3D000") return "Datenbank nicht gefunden.";
  if (e && e.code === "57014") return "Abfrage nach " + (STATEMENT_TIMEOUT_MS / 1000) + "s abgebrochen (statement_timeout).";
  if (e && e.code === "25006") return "Schreibversuch in einer Nur-Lese-Sitzung abgewiesen.";
  if (e && e.code === "42501") return "Keine Berechtigung fuer dieses Objekt.";
  if (e && (e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND")) {
    return "Datenbank nicht erreichbar (" + e.code + ") -- der Diagnose-Tab zeigt, ob die Strecke offen ist.";
  }
  return m;
}

/** Verbindung pruefen, ohne etwas zu lesen, was jemanden etwas angeht. */
async function ping() {
  const r = await query("SELECT current_database() AS db, current_user AS benutzer, version() AS version", { limit: 1 });
  return r.rows[0] || {};
}

/** Tabellen mit Zeilenschaetzung aus den Planner-Statistiken (kein COUNT ueber alles). */
async function tables(suche) {
  const like = String(suche || "").trim().toLowerCase();
  const filter = like ? " AND lower(c.relname) LIKE " + literal("%" + like + "%") : "";
  return query(
    "SELECT c.relname AS tabelle, " +
    "CASE WHEN c.reltuples < 0 THEN 0 ELSE c.reltuples::bigint END AS zeilen_geschaetzt, " +
    "pg_size_pretty(pg_total_relation_size(c.oid)) AS groesse " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE c.relkind IN ('r','v','m','p') AND n.nspname = 'public'" + filter + " " +
    "ORDER BY c.reltuples DESC", { limit: MAX_ROWS });
}

/** Spalten einer Tabelle. */
async function columns(table) {
  const t = String(table || "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(t)) throw Object.assign(new Error("Ungueltiger Tabellenname."), { status: 400 });
  return query(
    "SELECT column_name AS spalte, data_type AS typ, is_nullable AS nullable, column_default AS standard " +
    "FROM information_schema.columns " +
    "WHERE table_schema = 'public' AND lower(table_name) = " + literal(t.toLowerCase()) + " " +
    "ORDER BY ordinal_position", { limit: MAX_ROWS });
}

/** Einfache Zeichenkette fuer die beiden internen Abfragen oben. */
function literal(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

module.exports = { config, status, ready, setPassword, clearPassword, query, ping, tables, columns, MAX_ROWS };
