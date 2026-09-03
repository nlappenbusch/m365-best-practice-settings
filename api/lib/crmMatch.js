"use strict";
/**
 * SDP-CRM-Matcher: pro offenem SDP-Projekt pruefen, ob es einen Zoho-Deal gibt
 * (Serges Vorgabe "kein Angebot ohne Deal", Memory offerte-immer-deal-im-crm).
 *
 * Reiner Namensabgleich, keine externe Bibliothek -- die Deal-Namen sind meist
 * "<Kunde> - <Thema>" wie die SDP-Projektnamen (customerOf() in sdpProjects.js
 * nutzt dasselbe Muster), Account_Name ist der zweite Anker.
 */

const ZOHO = require("./zoho");
const { customerOf } = require("./sdpProjects");

const STOPWORDS = new Set(["ag", "gmbh", "sa", "sarl", "ev", "kg", "co", "und", "the", "der", "die", "das"]);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // Umlaute/Akzente einebnen
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

/** Jaccard-artiger Score über den Wortmengen, 0..1. */
function scoreOf(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens), b = new Set(bTokens);
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.min(a.size, b.size); // Containment statt reinem Jaccard: "Wild Schnyder" in "Wild Schnyder AG - Migration" soll voll zaehlen
}

/** Bestes Deal-Match fuer einen Projektnamen (bzw. dessen Kundenteil). Score-Schwelle 0.6 = "gefunden". */
function bestMatch(projectName, deals) {
  const cust = customerOf(projectName);
  const custTok = tokens(cust), nameTok = tokens(projectName);
  let best = null;
  for (const d of deals) {
    const s = Math.max(scoreOf(custTok, tokens(d.name)), scoreOf(custTok, tokens(d.account)), scoreOf(nameTok, tokens(d.name)) * 0.9);
    if (!best || s > best.score) best = { deal: d, score: s };
  }
  return best;
}

let cache = { at: 0, deals: null };
const TTL_MS = 10 * 60 * 1000; // Deal-Liste 10 Min cachen, das reicht fuer ein Dashboard und schont die Zoho-Quota

async function dealsFresh() {
  if (cache.deals && Date.now() - cache.at < TTL_MS) return cache.deals;
  const deals = await ZOHO.recentDeals(3);
  cache = { at: Date.now(), deals };
  return deals;
}

/** projects: [{id, name, customer}] aus listProjects(). Liefert Map projectId -> Matchresultat. */
async function matchAll(projects) {
  if (!ZOHO.config().enabled) return { enabled: false, matches: {} };
  const deals = await dealsFresh();
  const matches = {};
  for (const p of projects) {
    const best = bestMatch(p.name, deals);
    matches[p.id] = best && best.score >= 0.6
      ? { status: "matched", score: Math.round(best.score * 100) / 100, deal: best.deal }
      : { status: "none", score: best ? Math.round(best.score * 100) / 100 : 0, suggestion: best && best.score >= 0.3 ? best.deal : null };
  }
  return { enabled: true, matches };
}

module.exports = { matchAll, bestMatch, tokens };
