/**
 * Globale Session — der Login gatet Live-Deploy UND Agent-Downloads, deshalb
 * lebt er im Header statt in einem einzelnen Tab.
 *
 * Andere Module haengen sich an das Event `session-change` (document) und
 * bekommen { online, loggedIn, pwsh }. Wer spaeter dran ist, liest
 * window.M365Session.state.
 *
 * Muss VOR livedeploy.js / downloads.js geladen werden: der erste refresh()
 * laeuft async, die Consumer haben ihre Listener also rechtzeitig registriert.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const state = { online: false, loggedIn: false, pwsh: null };

  function emit() {
    document.dispatchEvent(new CustomEvent("session-change", { detail: Object.assign({}, state) }));
  }

  function paint() {
    const st = $("#sessionState");
    const li = $("#sessionLoginBtn");
    const lo = $("#sessionLogoutBtn");
    if (!st || !li || !lo) return;

    if (!state.online) {
      st.textContent = "⚠️ Backend offline";
      st.className = "session-state off";
      li.style.display = "none";
      lo.style.display = "none";
    } else if (state.loggedIn) {
      st.textContent = "✓ angemeldet";
      st.className = "session-state on";
      li.style.display = "none";
      lo.style.display = "";
    } else {
      st.textContent = "🔒 nicht angemeldet";
      st.className = "session-state";
      li.style.display = "";
      lo.style.display = "none";
    }
  }

  async function refresh() {
    try {
      const r = await fetch("/api/health", { credentials: "same-origin" });
      const h = await r.json();
      state.online = !!h.ok;
      state.loggedIn = !!h.loggedIn;
      state.pwsh = h.pwsh || null;
    } catch (e) {
      state.online = false;
      state.loggedIn = false;
      state.pwsh = null;
    }
    paint();
    emit();
    return Object.assign({}, state);
  }

  // ---------- Login-Modal ----------
  function openLogin() {
    const m = $("#loginModal");
    if (!m) return;
    $("#loginError").style.display = "none";
    m.style.display = "flex";
    setTimeout(() => { const p = $("#ldPass"); p && p.focus(); }, 50);
  }
  function closeLogin() {
    const m = $("#loginModal");
    if (m) m.style.display = "none";
  }

  async function doLogin() {
    const err = $("#loginError");
    err.style.display = "none";
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: ($("#ldUser") || {}).value || "admin",
          password: ($("#ldPass") || {}).value || ""
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Login fehlgeschlagen");
      $("#ldPass").value = "";
      closeLogin();
      await refresh();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = "";
    }
  }

  async function doLogout() {
    try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch (e) { /* egal */ }
    await refresh();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#sessionLoginBtn") && $("#sessionLoginBtn").addEventListener("click", openLogin);
    $("#sessionLogoutBtn") && $("#sessionLogoutBtn").addEventListener("click", doLogout);
    $("#loginSubmitBtn") && $("#loginSubmitBtn").addEventListener("click", doLogin);
    $("#loginModalClose") && $("#loginModalClose").addEventListener("click", closeLogin);
    $("#ldPass") && $("#ldPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    $("#loginModal") && $("#loginModal").addEventListener("click", (e) => {
      if (e.target && e.target.id === "loginModal") closeLogin();   // Klick auf Backdrop
    });

    refresh();   // async -> die Consumer-Listener stehen bis zum Dispatch
  });

  window.M365Session = {
    refresh,
    get state() { return Object.assign({}, state); }
  };
})();
