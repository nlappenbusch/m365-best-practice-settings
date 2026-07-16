/**
 * Tab "Agent-Downloads" — Bitdefender GravityZone + N-able N-sight RMM.
 *
 * Portiert aus dem PowerShell-Agent-Downloader. Das Frontend kennt keine
 * API-Keys: es ruft nur /api/downloads/* auf, das Backend haengt die Auth an
 * und streamt die Datei zurueck.
 *
 * Die Routen liegen hinter demselben Auth-Guard wie der Live-Deploy — ohne
 * Anmeldung (Tab "Live-Deploy") kommt 401, dann zeigen wir den Hinweis.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let bdAll = [];
  let rmmAll = [];
  let loadedOnce = false;

  function setStatus(el, text, isErr) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "dl-status" + (isErr ? " err" : "");
  }

  /** Download ueber ein unsichtbares <a> anstossen (Browser uebernimmt den Rest). */
  function fileDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1500);
  }

  async function api(path) {
    const r = await fetch(path, { credentials: "same-origin" });
    if (r.status === 401) { const e = new Error("Nicht angemeldet"); e.auth = true; throw e; }
    return r.json();
  }

  // ------------------------------------------------------------------ Bitdefender
  async function loadBd() {
    const st = $("#bdStatus");
    $("#bdList").innerHTML = "";
    setStatus(st, "Pakete laden …");
    try {
      const r = await api("/api/downloads/bd/packages");
      if (r.error) { setStatus(st, "Fehler: " + r.error, true); return; }
      bdAll = r.packages || [];
      if (!bdAll.length) { setStatus(st, "Keine Pakete gefunden.", true); return; }
      setStatus(st, bdAll.length + " Pakete geladen.");
      renderBd(bdAll);
    } catch (e) {
      setStatus(st, e.auth ? "Nicht angemeldet." : "Fehler: " + e.message, true);
    }
  }

  function renderBd(list) {
    const box = $("#bdList");
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="dl-empty">Keine Treffer.</div>'; return; }

    list.forEach((p) => {
      const row = document.createElement("div");
      row.className = "dl-card";
      const btns = [];
      if (p.installLinkWindows) btns.push({ u: p.installLinkWindows, t: "⬇ Windows Installer", primary: true });
      if (p.fullKitWindowsX64) btns.push({ u: p.fullKitWindowsX64, t: "Full Kit x64" });
      if (p.fullKitWindowsArm64) btns.push({ u: p.fullKitWindowsArm64, t: "Full Kit ARM64" });
      if (p.fullKitWindowsX32) btns.push({ u: p.fullKitWindowsX32, t: "Full Kit x32" });

      row.innerHTML =
        '<div class="dl-name">' + esc(p.packageName) + "</div>" +
        '<div class="dl-actions">' +
        btns.map((b, i) =>
          '<button class="btn ' + (b.primary ? "btn-primary" : "btn-secondary") +
          ' dl-btn" data-i="' + i + '">' + esc(b.t) + "</button>").join("") +
        "</div>";

      row.querySelectorAll(".dl-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const b = btns[Number(btn.getAttribute("data-i"))];
          fileDownload("/api/downloads/bd/download?u=" + encodeURIComponent(b.u));
          setStatus($("#bdStatus"), "Download gestartet — Seite offen lassen.");
        });
      });
      box.appendChild(row);
    });
  }

  // ------------------------------------------------------------------ N-sight RMM
  async function loadRmm() {
    const st = $("#rmmStatus");
    $("#rmmList").innerHTML = "";
    setStatus(st, "Clients laden … (Server-Erkennung kann kurz dauern)");
    try {
      const r = await api("/api/downloads/rmm/clients");
      if (r.error) { setStatus(st, "Fehler: " + r.error, true); return; }
      rmmAll = r.clients || [];
      if (!rmmAll.length) { setStatus(st, "Keine Clients gefunden.", true); return; }
      setStatus(st, rmmAll.length + " Clients geladen" + (r.server ? " (Server: " + r.server + ")" : "") + ".");
      renderRmm(rmmAll);
    } catch (e) {
      setStatus(st, e.auth ? "Nicht angemeldet." : "Fehler: " + e.message, true);
    }
  }

  function renderRmm(list) {
    const box = $("#rmmList");
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="dl-empty">Keine Treffer.</div>'; return; }

    list.forEach((cl) => {
      const card = document.createElement("div");
      card.className = "dl-card";
      card.innerHTML =
        '<div class="dl-name dl-click">▸ ' + esc(cl.name) +
        ' <small>(Client-ID: ' + esc(cl.id) + ")</small></div>";
      card.querySelector(".dl-click").addEventListener("click", () => toggleSites(card, cl));
      box.appendChild(card);
    });
  }

  async function toggleSites(card, cl) {
    const open = card.querySelector(".dl-sites");
    if (open) { open.remove(); return; }

    const wrap = document.createElement("div");
    wrap.className = "dl-sites";
    wrap.innerHTML = '<div class="dl-empty">Sites laden …</div>';
    card.appendChild(wrap);

    try {
      const r = await api("/api/downloads/rmm/sites?clientid=" + encodeURIComponent(cl.id));
      if (r.error) { wrap.innerHTML = '<div class="dl-empty err">' + esc(r.error) + "</div>"; return; }
      const sites = r.sites || [];
      if (!sites.length) { wrap.innerHTML = '<div class="dl-empty">Keine Sites.</div>'; return; }
      wrap.innerHTML = "";

      sites.forEach((s) => {
        const el = document.createElement("div");
        el.className = "dl-site";
        el.innerHTML =
          '<div class="dl-name">' + esc(s.name) + ' <small>(Site-ID: ' + esc(s.id) + ")</small></div>" +
          '<div class="dl-actions">' +
          '<button class="btn btn-primary dl-btn" data-t="remote_worker">⬇ Remote Worker</button>' +
          '<button class="btn btn-secondary dl-btn" data-t="group_policy">Group Policy</button>' +
          "</div>";

        el.querySelectorAll(".dl-btn").forEach((b) => {
          b.addEventListener("click", () => {
            const os = ($("#rmmOs") && $("#rmmOs").value) || "windows";
            const type = b.getAttribute("data-t");
            fileDownload("/api/downloads/rmm/download" +
              "?endcustomerid=" + encodeURIComponent(cl.id) +
              "&siteid=" + encodeURIComponent(s.id) +
              "&type=" + encodeURIComponent(type) +
              "&os=" + encodeURIComponent(os));
            setStatus($("#rmmStatus"),
              "Download gestartet (" + type + ", " + os + "). Build kann dauern — Seite offen lassen.");
          });
        });
        wrap.appendChild(el);
      });
    } catch (e) {
      wrap.innerHTML = '<div class="dl-empty err">Fehler: ' + esc(e.message) + "</div>";
    }
  }

  // ------------------------------------------------------------------ Init
  async function initDownloads() {
    if (loadedOnce) return;
    loadedOnce = true;

    let cfg;
    try {
      cfg = await api("/api/downloads/config");
    } catch (e) {
      loadedOnce = false; // beim naechsten Tab-Wechsel nochmal versuchen
      if (e.auth) { $("#dlAuth").style.display = ""; $("#dlOffline").style.display = "none"; }
      else { $("#dlOffline").style.display = ""; }
      $("#dlMain").style.display = "none";
      return;
    }

    $("#dlAuth").style.display = "none";
    $("#dlOffline").style.display = "none";
    $("#dlMain").style.display = "";

    if (cfg.bd) { $("#bdBox").style.display = ""; $("#bdDisabled").style.display = "none"; loadBd(); }
    else { $("#bdBox").style.display = "none"; $("#bdDisabled").style.display = ""; }

    if (cfg.rmm) { $("#rmmBox").style.display = ""; $("#rmmDisabled").style.display = "none"; loadRmm(); }
    else { $("#rmmBox").style.display = "none"; $("#rmmDisabled").style.display = ""; }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#bdReload") && $("#bdReload").addEventListener("click", loadBd);
    $("#rmmReload") && $("#rmmReload").addEventListener("click", loadRmm);

    $("#bdQ") && $("#bdQ").addEventListener("input", (e) => {
      const t = e.target.value.trim().toLowerCase();
      renderBd(t ? bdAll.filter((p) => (p.packageName || "").toLowerCase().includes(t)) : bdAll);
    });
    $("#rmmQ") && $("#rmmQ").addEventListener("input", (e) => {
      const t = e.target.value.trim().toLowerCase();
      renderRmm(t ? rmmAll.filter((c) => (c.name || "").toLowerCase().includes(t)) : rmmAll);
    });

    // Erst laden, wenn der Tab wirklich geoeffnet wird (spart API-Calls beim Start).
    document.querySelectorAll('.tab-btn[data-tab="downloads"]').forEach((b) =>
      b.addEventListener("click", initDownloads));
  });
})();
