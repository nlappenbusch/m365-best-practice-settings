/**
 * CA-Zustandsvorlagen: den Ist-Zustand eines Referenz-Mandanten festhalten und
 * auf einem anderen Mandanten nachziehen.
 *
 * Wozu: Nach dem Ausrollen liegen alle Policies im Report-only-Zustand (siehe
 * Leitplanken in conditionalAccess.js). Welche davon in einem eingespielten
 * Mandanten tatsaechlich scharf sind und welche bewusst im Beobachtungsmodus
 * bleiben, ist Erfahrungswissen — bisher steckte es nur in Koepfen und
 * Dokumenten. Eine Vorlage haelt genau das fest: je Policy den Zustand, den
 * der Referenz-Mandant hat.
 *
 * Leitplanken — bewusst eng gehalten, weil Conditional Access einen Mandanten
 * komplett aussperren kann:
 *  - Eine Vorlage legt NIE eine Policy an und loescht nie eine. Sie aendert
 *    ausschliesslich den Zustand bereits vorhandener Policies. Das Anlegen
 *    bleibt deployTier() vorbehalten, das weiterhin nur Report-only erzeugt.
 *  - Nur Policies nach dem eigenen Namensschema ("<Nr> - <RING> - ...") werden
 *    angefasst. Fremd-Policies werden erfasst, aber nie veraendert.
 *  - Der Abgleich laeuft ueber den Policy-Key (Nummer + Ring), nicht ueber die
 *    Mandanten-ID — dieselbe Policy hat in jedem Mandanten eine andere ID.
 *  - Eine Policy scharfzuschalten ist der gefaehrliche Teil. Er passiert nur,
 *    wenn der Aufrufer ihn ausdruecklich verlangt (allowEnable). Ohne das Flag
 *    werden ausschliesslich Zustaende gesetzt, die nichts erzwingen.
 */
const fs = require("fs");
const path = require("path");
const CA = require("./conditionalAccess");
const { CA_POLICY_TEMPLATES } = require("./conditionalAccessPolicies");

const TEMPLATE_DIRNAME = "ca-templates";
const ERLAUBTE_ZUSTAENDE = ["enabled", "enabledForReportingButNotEnforced", "disabled"];
// Zustaende, die nichts erzwingen und deshalb ohne allowEnable gesetzt werden duerfen
const UNGEFAEHRLICH = ["enabledForReportingButNotEnforced", "disabled"];


/**
 * Aus welcher Vorlage stammt eine Policy? Der Katalog fuehrt die Policies je
 * Tier mit "<Nr> - <RING> - ..." als Namen; die Nummer ist der stabile Teil.
 * Zurueckgegeben wird das KLEINSTE Tier, das die Nummer enthaelt — die
 * groesseren enthalten die kleineren mit, und wer nachziehen muss, will den
 * geringsten Eingriff.
 */
const TIER_REIHENFOLGE = ["bareMinimum", "aadp1", "aadp1p2"];
let NUMMER_ZU_TIER = null;

function nummerAusName(displayName) {
  const m = String(displayName || "").match(/^(\d+)\s*-/);
  return m ? m[1] : null;
}

function tierIndex() {
  if (NUMMER_ZU_TIER) return NUMMER_ZU_TIER;
  NUMMER_ZU_TIER = new Map();
  for (const tier of TIER_REIHENFOLGE) {
    for (const pol of (CA_POLICY_TEMPLATES[tier] || [])) {
      const nr = nummerAusName(pol.displayName);
      if (nr && !NUMMER_ZU_TIER.has(nr)) NUMMER_ZU_TIER.set(nr, tier);
    }
  }
  return NUMMER_ZU_TIER;
}

function tierFuerPolicy(displayName) {
  const nr = nummerAusName(displayName);
  if (!nr) return null;
  const tier = tierIndex().get(nr) || null;
  if (!tier) return null;
  const meta = (CA.TIER_META || {})[tier] || {};
  return { key: tier, label: meta.shortLabel || meta.label || tier };
}

function templateDir(stateDir) {
  const d = path.join(stateDir, TEMPLATE_DIRNAME);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Dateiname aus dem Anzeigenamen — nur harmlose Zeichen, damit kein Pfad entsteht. */
function templateId(name) {
  const s = String(name || "").trim().toLowerCase()
    .replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "vorlage";
}

function templatePath(stateDir, id) {
  const sicher = templateId(id);
  return path.join(templateDir(stateDir), `${sicher}.json`);
}

/**
 * Ist-Zustand eines Mandanten als Vorlage festhalten.
 * Erfasst wird jede Policy mit Name, Key und Zustand; Fremd-Policies werden
 * mitgeschrieben, aber als nicht verwaltet gekennzeichnet.
 */
async function captureTemplate(stateDir, tenant, certPemPath, opts = {}) {
  const name = String(opts.name || tenant.name || tenant.id || "Vorlage").trim();
  const id = templateId(opts.id || name);

  const policies = await CA.listAllPolicies(tenant, certPemPath);

  const eintraege = policies.map(p => ({
    key: CA.policyKey(p.displayName),
    displayName: p.displayName,
    state: p.state,
    managed: !!p.managed,
    tier: p.managed ? tierFuerPolicy(p.displayName) : null
  })).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), "de"));

  const verwaltet = eintraege.filter(e => e.managed);
  const doc = {
    id,
    name,
    notiz: String(opts.notiz || ""),
    quelle: {
      tenantId: tenant.tenantId || null,
      tenantName: tenant.name || null,
      erfasstAm: new Date().toISOString()
    },
    zusammenfassung: {
      gesamt: eintraege.length,
      verwaltet: verwaltet.length,
      aktiv: verwaltet.filter(e => e.state === "enabled").length,
      reportOnly: verwaltet.filter(e => e.state === "enabledForReportingButNotEnforced").length,
      deaktiviert: verwaltet.filter(e => e.state === "disabled").length
    },
    policies: eintraege
  };

  fs.writeFileSync(templatePath(stateDir, id), JSON.stringify(doc, null, 2), "utf8");
  return doc;
}

function listTemplates(stateDir) {
  const d = templateDir(stateDir);
  return fs.readdirSync(d)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
        return {
          id: doc.id,
          name: doc.name,
          notiz: doc.notiz || "",
          quelle: doc.quelle || {},
          zusammenfassung: doc.zusammenfassung || {}
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.quelle?.erfasstAm || "").localeCompare(String(a.quelle?.erfasstAm || "")));
}

function loadTemplate(stateDir, id) {
  const p = templatePath(stateDir, id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function deleteTemplate(stateDir, id) {
  const p = templatePath(stateDir, id);
  if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  return false;
}

/**
 * Vorlage gegen einen Ziel-Mandanten halten, ohne etwas zu aendern.
 * Liefert je Policy, was passieren wuerde — Grundlage fuer die Anzeige vor
 * dem Anwenden.
 */
async function compareToTemplate(tenant, certPemPath, template) {
  const vorhanden = await CA.listAllPolicies(tenant, certPemPath);
  const nachKey = new Map();
  for (const p of vorhanden) nachKey.set(CA.policyKey(p.displayName), p);

  const zeilen = [];
  for (const soll of (template.policies || [])) {
    if (!soll.managed) continue; // Fremd-Policies der Quelle sind nicht uebertragbar
    const ist = nachKey.get(soll.key);
    if (!ist) {
      const tier = soll.tier || tierFuerPolicy(soll.displayName);
      zeilen.push({
        key: soll.key, displayName: soll.displayName,
        sollState: soll.state, istState: null, tier: tier,
        aktion: "fehlt",
        hinweis: tier
          ? `Nicht vorhanden — steckt in der Vorlage «${tier.label}», die zuerst ausgerollt werden muss.`
          : "Policy im Ziel-Mandanten nicht vorhanden — zuerst ausrollen."
      });
      continue;
    }
    if (!ist.managed) {
      zeilen.push({
        key: soll.key, displayName: ist.displayName,
        sollState: soll.state, istState: ist.state,
        aktion: "uebersprungen", hinweis: "Policy folgt nicht dem eigenen Namensschema — wird nicht angefasst."
      });
      continue;
    }
    if (ist.state === soll.state) {
      zeilen.push({
        key: soll.key, displayName: ist.displayName, policyId: ist.id,
        sollState: soll.state, istState: ist.state,
        aktion: "unveraendert", hinweis: ""
      });
      continue;
    }
    zeilen.push({
      key: soll.key, displayName: ist.displayName, policyId: ist.id,
      sollState: soll.state, istState: ist.state,
      aktion: "aendern",
      hinweis: soll.state === "enabled"
        ? "Schaltet die Policy scharf — wirkt sofort auf alle Anmeldungen im Geltungsbereich."
        : ""
    });
  }

  // Policies im Ziel, die die Vorlage nicht kennt
  const bekannt = new Set((template.policies || []).map(p => p.key));
  for (const p of vorhanden) {
    const k = CA.policyKey(p.displayName);
    if (bekannt.has(k)) continue;
    zeilen.push({
      key: k, displayName: p.displayName, policyId: p.id,
      sollState: null, istState: p.state,
      aktion: "nicht-in-vorlage",
      hinweis: "Im Ziel vorhanden, in der Vorlage nicht enthalten — bleibt unberuehrt."
    });
  }

  return {
    template: { id: template.id, name: template.name, quelle: template.quelle },
    zeilen,
    fehlendeTiers: (() => {
      const m = new Map();
      for (const z of zeilen) {
        if (z.aktion !== "fehlt" || !z.tier) continue;
        const e = m.get(z.tier.key) || { key: z.tier.key, label: z.tier.label, anzahl: 0 };
        e.anzahl++; m.set(z.tier.key, e);
      }
      return [...m.values()].sort((a, b) => b.anzahl - a.anzahl);
    })(),
    zusammenfassung: {
      zuAendern: zeilen.filter(z => z.aktion === "aendern").length,
      davonScharf: zeilen.filter(z => z.aktion === "aendern" && z.sollState === "enabled").length,
      fehlt: zeilen.filter(z => z.aktion === "fehlt").length,
      unveraendert: zeilen.filter(z => z.aktion === "unveraendert").length
    }
  };
}

/**
 * Zustaende der Vorlage auf dem Ziel-Mandanten setzen.
 *
 * opts.allowEnable  — ohne dieses Flag wird keine Policy scharfgeschaltet
 * opts.nurKeys      — optionale Auswahl: nur diese Policy-Keys anfassen
 */
async function applyTemplateStates(tenant, certPemPath, template, opts = {}, onProgress) {
  const vergleich = await compareToTemplate(tenant, certPemPath, template);
  const auswahl = Array.isArray(opts.nurKeys) && opts.nurKeys.length
    ? new Set(opts.nurKeys) : null;

  const zuTun = vergleich.zeilen.filter(z =>
    z.aktion === "aendern" && (!auswahl || auswahl.has(z.key)));

  const ergebnisse = [];
  let i = 0;
  for (const z of zuTun) {
    i++;
    if (!ERLAUBTE_ZUSTAENDE.includes(z.sollState)) {
      ergebnisse.push({ ...z, status: "abgelehnt", grund: `Unzulaessiger Zustand: ${z.sollState}` });
      continue;
    }
    if (!UNGEFAEHRLICH.includes(z.sollState) && !opts.allowEnable) {
      ergebnisse.push({ ...z, status: "uebersprungen", grund: "Scharfschalten wurde nicht freigegeben." });
      continue;
    }
    if (onProgress) onProgress({ done: i, total: zuTun.length, current: z.displayName });
    try {
      await CA.setPolicyState(tenant, certPemPath, z.policyId, z.sollState);
      ergebnisse.push({ ...z, status: "gesetzt" });
    } catch (e) {
      ergebnisse.push({ ...z, status: "fehler", grund: e.message });
    }
  }

  return {
    template: { id: template.id, name: template.name },
    gesamt: zuTun.length,
    gesetzt: ergebnisse.filter(r => r.status === "gesetzt").length,
    uebersprungen: ergebnisse.filter(r => r.status === "uebersprungen").length,
    fehler: ergebnisse.filter(r => r.status === "fehler").length,
    ergebnisse
  };
}

module.exports = {
  captureTemplate, listTemplates, loadTemplate, deleteTemplate,
  compareToTemplate, applyTemplateStates, templateId
};
