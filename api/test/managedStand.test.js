"use strict";
// Stand-Freeze im Managed Service: Versionen, Pflicht-Begruendung, Drift und
// die Schutzregel gegen die globale igeeks-Baseline. Ausfuehren: npm test (im Ordner api).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const STAND = require("../lib/managedStand");
const S = require("../lib/managedService");
const STANDPDF = require("../lib/managedStandPdf");

const BASELINE = path.join(__dirname, "..", "baseline", "baseline.json");
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stand-"));
const TID = "tenant-a";

const caItems = (state) => ({
  p1: { name: "001 - GLOBAL - MFA für alle", state, managed: true, body: { displayName: "001 - GLOBAL - MFA für alle", state, conditions: { users: { includeUsers: ["All"], excludeGroups: ["g1"] }, applications: { includeApplications: ["All"] } }, grantControls: { operator: "OR", builtInControls: ["mfa"] } } },
  p2: { name: "Kunde - Block Legacy", state: "enabled", managed: false, body: { displayName: "Kunde - Block Legacy", state: "enabled", conditions: { clientAppTypes: ["exchangeActiveSync", "other"] }, grantControls: { builtInControls: ["block"] } } }
});
const threatItems = () => ({ "Antispam:Default": { kind: "Antispam", name: "Default", body: { Name: "Default", IsDefault: true, HighConfidencePhishAction: "Quarantine", BulkThreshold: 6 } } });
function writeSnap(dir, area, items) {
  const d = path.join(dir, "managed", TID, "snap");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, area + ".json"), JSON.stringify({ at: new Date().toISOString(), items }));
}

test("Erstaufnahme ist vorlaeufig, Einfrieren braucht Begruendung und erzeugt neue Version", () => {
  const dir = tmp();
  const r = STAND.referenceFor(dir, TID, "ca", caItems("enabled"));
  assert.equal(r.created, true);
  assert.equal(r.ver.v, 1);
  assert.equal(r.ver.provisional, true);
  // zweiter Bereich kommt als eigene Version dazu, der erste bleibt erhalten
  const r2 = STAND.referenceFor(dir, TID, "threat", threatItems());
  assert.equal(r2.ver.v, 2);
  assert.ok(r2.ver.areas.ca && r2.ver.areas.threat);

  writeSnap(dir, "ca", caItems("enabled"));
  writeSnap(dir, "threat", threatItems());
  assert.throws(() => S.freezeStand(dir, TID, "nils", "kurz"), /Begründung/);
  const v3 = S.freezeStand(dir, TID, "nils", "Onboarding abgeschlossen, Change #4711");
  assert.equal(v3.v, 3);
  assert.equal(v3.provisional, false);
  assert.equal(STAND.index(dir, TID).current, 3);
  // alte Versionen unveraendert lesbar
  assert.equal(STAND.get(dir, TID, 1).provisional, true);
});

test("Versionen sind unveraenderlich, Schreiben ausserhalb stand/ wird verweigert", () => {
  const dir = tmp();
  STAND.referenceFor(dir, TID, "ca", caItems("enabled"));
  assert.throws(() => STAND._guardedWrite(dir, TID, "v0001.json", { x: 1 }, { once: true }), /unveränderlich/);
  assert.throws(() => STAND._guardedWrite(dir, TID, "../base/ca.json", {}), /verweigert/);
  assert.throws(() => STAND._guardedWrite(dir, TID, path.relative(path.join(dir, "managed", TID, "stand"), BASELINE), {}), /verweigert/);
  // Pfadteile in der Tenant-ID werden entschaerft und landen im eigenen Ordner
  STAND._guardedWrite(dir, "../../x", "index.json", { current: null, versions: [] });
  assert.ok(fs.existsSync(path.join(dir, "managed", ".._.._x", "stand", "index.json")));
});

test("Drift wird gegen den Stand erkannt, Uebernehmen braucht Begruendung und schliesst den Befund", async () => {
  const dir = tmp();
  const before = sha(BASELINE);
  STAND.referenceFor(dir, TID, "ca", caItems("enabled"));
  writeSnap(dir, "ca", caItems("enabled"));
  S.freezeStand(dir, TID, "nils", "Abnahme mit Kunde am 16.10.");
  // Policy wird abgeschaltet -> kritischer Drift
  const now = caItems("disabled");
  const ref = STAND.referenceFor(dir, TID, "ca", now);
  assert.equal(ref.created, false);
  const ch = STAND.compareItems("ca", ref.ver.areas.ca.items, now);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].type, "geändert");
  // Befund simulieren wie run() ihn ablegt
  writeSnap(dir, "ca", now);
  const ff = path.join(dir, "managed", TID, "findings.json");
  fs.writeFileSync(ff, JSON.stringify({ f1: { id: "f1", area: "ca", drift: true, objId: "p1", status: "open", severity: "critical", history: [] } }));
  assert.throws(() => S.acceptBaseline(dir, TID, "ca", "nils", "p1", ""), /Begründung/);
  const ver = S.acceptBaseline(dir, TID, "ca", "nils", "p1", "Bewusst abgeschaltet, Change #4712");
  assert.equal(ver.kind, "accept");
  assert.equal(ver.changes.length, 1);
  const f = JSON.parse(fs.readFileSync(ff, "utf8")).f1;
  assert.equal(f.status, "resolved");
  assert.match(f.history[0].what, /Stand v\d+ übernommen: Bewusst abgeschaltet/);
  // Drift-Bericht gegen die vorige Version zeigt die Abweichung
  const doc = S.standDocument(dir, TID, ver.v - 1, true);
  assert.equal(doc.drift.changes.length, 1);
  // die globale Best-Practice-Vorlage ist unberuehrt
  assert.equal(sha(BASELINE), before);
  // PDF laesst sich bauen (Stand + Drift-Bericht)
  for (const d of [S.standDocument(dir, TID, null, false), doc]) {
    const pdf = await STANDPDF.build({ name: "Test AG", organization: "test.onmicrosoft.com" }, d);
    assert.ok(pdf.length > 2000 && pdf.slice(0, 4).toString() === "%PDF");
  }
});

test("Bisherige Baseline-Dateien werden einmalig als v1 uebernommen", () => {
  const dir = tmp();
  const legacy = path.join(dir, "managed", TID, "base");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "ca.json"), JSON.stringify({ acceptedAt: "2026-10-01T08:00:00Z", acceptedBy: "matthias", items: caItems("enabled") }));
  const r = STAND.referenceFor(dir, TID, "ca", caItems("enabled"));
  assert.equal(r.created, false);
  assert.equal(r.ver.kind, "migrated");
  assert.equal(r.ver.provisional, false);
  assert.ok(fs.existsSync(path.join(legacy, "ca.json")), "Altbestand bleibt liegen");
});

test("Managed-Module haben keinen Schreibweg zur Best-Practice-Vorlage oder zu zugelassenen Abweichungen", () => {
  for (const f of ["managedStand.js", "managedService.js", "managedRoutes.js", "managedStandPdf.js"]) {
    // Kommentare duerfen die Begriffe nennen, der Code nicht.
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /require\(["']\.\/baseline["']\)/, f + " bindet baseline.js ein");
    assert.doesNotMatch(src, /acceptedDeviations/, f + " fasst acceptedDeviations an");
    assert.doesNotMatch(src, /saveBaseline|writeBaseline/, f + " schreibt eine Baseline");
  }
});
