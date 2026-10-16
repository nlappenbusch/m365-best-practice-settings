"use strict";
// KI-Dienste und Message-Center-Einordnung gegen einen lokalen Fake-Dienst
// (OpenAI-kompatibel) — ohne echte Keys und ohne Internet. Ausfuehren: npm test.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const AI = require("../lib/aiProviders");
const MCAI = require("../lib/mcAi");

function fakeServer(handler) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const out = handler(JSON.parse(body || "{}"), req);
        res.writeHead(out.status || 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}
const chat = text => ({ body: { choices: [{ message: { content: text }, finish_reason: "stop" }] } });

test("Keys werden verschluesselt abgelegt und nie ausgeliefert", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-"));
  AI.init(dir);
  const id = AI.saveProvider({ type: "openai", label: "OpenAI Test", model: "gpt-x", key: "sk-geheim-1234" });
  const raw = fs.readFileSync(path.join(dir, "ai-providers.json"), "utf8");
  assert.doesNotMatch(raw, /sk-geheim/);
  const v = AI.publicView();
  const p = v.providers.find(x => x.id === id);
  assert.equal(p.hasKey, true);
  assert.equal(p.keyHint, "…1234");
  assert.doesNotMatch(JSON.stringify(v), /sk-geheim/);
  // leerer Key beim Bearbeiten = unveraendert
  AI.saveProvider({ id, type: "openai", label: "OpenAI umbenannt", model: "gpt-y", key: "" });
  assert.equal(AI.publicView().providers.find(x => x.id === id).keyHint, "…1234");
  assert.throws(() => AI.saveProvider({ type: "openai", model: "gpt-x" }), /API-Key fehlt/);
  assert.throws(() => AI.saveProvider({ type: "openai-compatible", model: "llama" }), /Adresse/);
  assert.throws(() => AI.saveProvider({ type: "azure-foundry", model: "Mistral-Large", key: "k" }), /Foundry-Endpoint/);
});

test("Azure AI Foundry: api-key-Header, api-version und Modell im Body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-"));
  AI.init(dir);
  let seen = null;
  const srv = await fakeServer((body, req) => { seen = { url: req.url, key: req.headers["api-key"], model: body.model }; return chat('{"ok":true}'); });
  try {
    const id = AI.saveProvider({ type: "azure-foundry", label: "Foundry", model: "Mistral-Large-2411", baseUrl: srv.url.replace(/\/v1$/, "/models"), key: "foundry-key" });
    const r = await AI.complete(null, { providerId: id, prompt: "x", json: true });
    assert.deepEqual(r.json, { ok: true });
    assert.equal(seen.url, "/models/chat/completions?api-version=2024-05-01-preview");
    assert.equal(seen.key, "foundry-key");
    assert.equal(seen.model, "Mistral-Large-2411");
  } finally { srv.srv.closeAllConnections(); srv.srv.close(); }
});

test("Ausweichdienst springt ein, wenn der erste nicht antwortet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-"));
  AI.init(dir);
  const bad = await fakeServer(() => ({ status: 500, body: { error: { message: "kaputt" } } }));
  const good = await fakeServer(() => chat('{"ok":true}'));
  try {
    const a = AI.saveProvider({ type: "openai-compatible", label: "Kaputt", model: "m", baseUrl: bad.url });
    const b = AI.saveProvider({ type: "openai-compatible", label: "Lokal", model: "m", baseUrl: good.url });
    AI.setAssign("messages", [a, b]);
    const r = await AI.complete("messages", { prompt: "x", json: true });
    assert.equal(r.provider.label, "Lokal");
    assert.deepEqual(r.json, { ok: true });
    const t = await AI.test(a);
    assert.equal(t.ok, false);
    assert.match(t.error, /HTTP 500/);
  } finally { for (const s of [bad.srv, good.srv]) { s.closeAllConnections(); s.close(); } }
});

test("Message Center: KI bewertet je Kunde, Profil im Prompt, Cache haelt bis Profil sich aendert", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-"));
  AI.init(dir);
  const prompts = [];
  const srv = await fakeServer(body => {
    const p = body.messages.map(m => m.content).join("\n");
    prompts.push(p);
    const ids = [...p.matchAll(/"id":"(MC\d+)"/g)].map(x => x[1]);
    return chat(JSON.stringify({ items: ids.map((id, i) => ({
      id, art: i === 0 ? "handeln" : i === 1 ? "chance" : "nicht", titel: "Titel " + id, kurz: "Kurz", warum: "Weil 12 Windows-Geräte",
      wer: "Alle", wann: "Ab Mai", wasTun: ["Schritt 1"], kunde: i < 2 ? "Satz für den Kunden" : ""
    })) }));
  });
  try {
    const id = AI.saveProvider({ type: "openai-compatible", label: "Lokal", model: "m", baseUrl: srv.url });
    AI.setAssign("messages", [id]);
    const messages = [
      { id: "MC1", title: "A", services: ["Teams"], modified: "1", summary: "x" },
      { id: "MC2", title: "B", services: ["Intune"], modified: "1", summary: "x" },
      { id: "MC3", title: "C", services: ["Dynamics"], modified: "1", summary: "x" },
      { id: "MC4", title: "D", services: ["Yammer"], modified: "1", summary: "x", notInTenant: true }
    ];
    const facts = { licenses: { licensedUsers: 30, skus: [{ name: "Microsoft 365 Business Premium", assigned: 30 }] }, devices: { byOs: { Windows: { total: 12 } } } };
    const c1 = await MCAI.evaluate({ tenant: { name: "Kunde" }, messages, facts, cache: {}, note: "Treuhandbüro" });
    assert.equal(Object.keys(c1).length, 3, "nicht lizenzierte Meldung geht nicht an die KI");
    assert.equal(c1.MC1.ai.art, "handeln");
    assert.equal(c1.MC1.ai.relevant, true);
    assert.equal(c1.MC2.ai.relevant, true);
    assert.equal(c1.MC3.ai.relevant, false);
    assert.equal(c1.MC1.ai.provider, "Lokal");
    assert.match(prompts[0], /Treuhandbüro/);
    assert.match(prompts[0], /Business Premium \(30\)/);
    assert.doesNotMatch(prompts[0], /@/, "keine Mailadressen im Prompt");
    // gleicher Stand + gleiches Profil -> kein neuer Aufruf
    const n = prompts.length;
    assert.equal(await MCAI.evaluate({ tenant: { name: "Kunde" }, messages, facts, cache: c1, note: "Treuhandbüro" }), null);
    assert.equal(prompts.length, n);
    // Kundennotiz geaendert -> neu bewerten
    const c2 = await MCAI.evaluate({ tenant: { name: "Kunde" }, messages, facts, cache: c1, note: "Treuhandbüro, neu mit Teams-Telefonie" });
    assert.ok(c2 && prompts.length > n);
  } finally { srv.srv.closeAllConnections(); srv.srv.close(); }
});

test("Ohne eingerichteten Dienst: keine Bewertung, klare Fehlermeldung", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-"));
  AI.init(dir);
  const keep = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(AI.enabledFor("messages"), false);
    assert.equal(await MCAI.evaluate({ messages: [{ id: "MC1", modified: "1" }], facts: {}, cache: {} }), null);
    await assert.rejects(AI.complete("tickets", { prompt: "x" }), /Kein KI-Dienst/);
  } finally { if (keep) process.env.ANTHROPIC_API_KEY = keep; }
});
