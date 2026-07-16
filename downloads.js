/**
 * Tab "Agent-Downloads" — Bitdefender GravityZone + N-able N-sight RMM.
 *
 * Portiert aus dem PowerShell-Agent-Downloader. Das Frontend kennt keine
 * API-Keys: es ruft nur /api/downloads/* auf, das Backend haengt die Auth an
 * und streamt die Datei zurueck.
 *
 * Die Routen liegen hinter demselben Auth-Guard wie der Live-Deploy — ohne
 * Anmeldung (Tab "Live-Deploy") kommt 401, dann zeigen wir den Hinweis.
 *
 * UI: zwei Sub-Tabs, damit immer nur EINE Liste sichtbar ist, plus eine
 * Scroll-Box fester Hoehe und eine klebende Filterleiste — sonst scrollt man
 * sich bei vielen Paketen/Clients tot.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let bdAll = [];
  let rmmAll = [];
  let cfg = null;
  let initDone = false;
  const loaded = { bd: false, rmm: false };

  function setStatus(el, text, isErr) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "dl-status" + (isErr ? " err" : "");
  }

  function setCount(el, shown, total) {
    if (!el) return;
    el.textContent = !total ? "" : (shown === total ? total + "" : shown + " von " + total);
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
    setCount($("#bdCount"), 0, 0);
    setStatus(st, "Pakete laden …");
    try {
      const r = await api("/api/downloads/bd/packages");
      if (r.error) { setStatus(st, "Fehler: " + r.error, true); return; }
      bdAll = r.packages || [];
      loaded.bd = true;
      if (!bdAll.length) { setStatus(st, "Keine Pakete gefunden.", true); return; }
      setStatus(st, "");
      renderBd(bdAll);
    } catch (e) {
      setStatus(st, e.auth ? "Nicht angemeldet." : "Fehler: " + e.message, true);
    }
  }

  function renderBd(list) {
    const box = $("#bdList");
    box.innerHTML = "";
    setCount($("#bdCount"), list.length, bdAll.length);
    if (!list.length) { box.innerHTML = '<div class="dl-empty">Keine Treffer.</div>'; return; }

    list.forEach((p) => {
      const btns = [];
      if (p.installLinkWindows) btns.push({ u: p.installLinkWindows, t: "⬇ Installer", primary: true });
      if (p.fullKitWindowsX64) btns.push({ u: p.fullKitWindowsX64, t: "x64" });
      if (p.fullKitWindowsArm64) btns.push({ u: p.fullKitWindowsArm64, t: "ARM64" });
      if (p.fullKitWindowsX32) btns.push({ u: p.fullKitWindowsX32, t: "x32" });

      const row = document.createElement("div");
      row.className = "dl-card";
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
    setCount($("#rmmCount"), 0, 0);
    setStatus(st, "Clients laden … (Server-Erkennung kann kurz dauern)");
    try {
      const r = await api("/api/downloads/rmm/clients");
      if (r.error) { setStatus(st, "Fehler: " + r.error, true); return; }
      rmmAll = r.clients || [];
      loaded.rmm = true;
      if (!rmmAll.length) { setStatus(st, "Keine Clients gefunden.", true); return; }
      setStatus(st, r.server ? "Server: " + r.server : "");
      renderRmm(rmmAll);
    } catch (e) {
      setStatus(st, e.auth ? "Nicht angemeldet." : "Fehler: " + e.message, true);
    }
  }

  function renderRmm(list) {
    const box = $("#rmmList");
    box.innerHTML = "";
    setCount($("#rmmCount"), list.length, rmmAll.length);
    if (!list.length) { box.innerHTML = '<div class="dl-empty">Keine Treffer.</div>'; return; }

    list.forEach((cl) => {
      // dl-item klammert Zeile + aufgeklappte Sites (die Zeile selbst ist flex).
      const item = document.createElement("div");
      item.className = "dl-item";
      item.innerHTML =
        '<div class="dl-card dl-click"><div class="dl-name">▸ ' + esc(cl.name) +
        ' <small>(ID: ' + esc(cl.id) + ")</small></div></div>";
      item.querySelector(".dl-click").addEventListener("click", () => toggleSites(item, cl));
      box.appendChild(item);
    });
  }

  async function toggleSites(item, cl) {
    const open = item.querySelector(".dl-sites");
    if (open) { open.remove(); return; }

    const wrap = document.createElement("div");
    wrap.className = "dl-sites";
    wrap.innerHTML = '<div class="dl-empty">Sites laden …</div>';
    item.appendChild(wrap);

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
          '<div class="dl-name">' + esc(s.name) + ' <small>(Site: ' + esc(s.id) + ")</small></div>" +
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

  // ------------------------------------------------------------------ Sub-Tabs
  function switchSub(name) {
    document.querySelectorAll(".dl-subtab").forEach((b) =>
      b.classList.toggle("active", b.getAttribute("data-sub") === name));
    const bd = $("#dlPanelBd"), rmm = $("#dlPanelRmm");
    if (bd) bd.classList.toggle("active", name === "bd");
    if (rmm) rmm.classList.toggle("active", name === "rmm");

    // Erst laden, wenn das Panel wirklich aufgeht.
    if (name === "bd" && cfg && cfg.bd && !loaded.bd) loadBd();
    if (name === "rmm" && cfg && cfg.rmm && !loaded.rmm) loadRmm();
  }

  // ------------------------------------------------------------------ Init
  async function initDownloads() {
    if (initDone) return;
    initDone = true;

    try {
      cfg = await api("/api/downloads/config");
    } catch (e) {
      initDone = false; // beim naechsten Tab-Wechsel nochmal versuchen
      if (e.auth) { $("#dlAuth").style.display = ""; $("#dlOffline").style.display = "none"; }
      else { $("#dlOffline").style.display = ""; }
      $("#dlMain").style.display = "none";
      return;
    }

    $("#dlAuth").style.display = "none";
    $("#dlOffline").style.display = "none";
    $("#dlMain").style.display = "";

    $("#bdBox").style.display = cfg.bd ? "" : "none";
    $("#bdDisabled").style.display = cfg.bd ? "none" : "";
    $("#rmmBox").style.display = cfg.rmm ? "" : "none";
    $("#rmmDisabled").style.display = cfg.rmm ? "none" : "";

    // Auf den Sub-Tab starten, der tatsaechlich was kann.
    switchSub(cfg.bd || !cfg.rmm ? "bd" : "rmm");
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".dl-subtab").forEach((b) =>
      b.addEventListener("click", () => switchSub(b.getAttribute("data-sub"))));

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

    // Der Login sitzt global im Header (session.js) — auf Wechsel reagieren,
    // damit man nach dem Anmelden nicht erst den Tab neu oeffnen muss.
    document.addEventListener("session-change", (e) => {
      const s = e.detail;
      const tabOpen = $("#downloads") && $("#downloads").classList.contains("active");

      if (!s.online || !s.loggedIn) {
        initDone = false;
        loaded.bd = false;
        loaded.rmm = false;
        $("#dlMain").style.display = "none";
        $("#dlOffline").style.display = s.online ? "none" : "";
        $("#dlAuth").style.display = s.online && !s.loggedIn ? "" : "none";
        return;
      }
      if (tabOpen) { initDone = false; initDownloads(); }
    });
  });
})();
