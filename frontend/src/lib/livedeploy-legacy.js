// Verbatim aus dem Vanilla-livedeploy.js portiert; nur die Session-Integration
// (window.M365Session/session-change -> Svelte-Store) minimal adaptiert.
/* eslint-disable */
import { get } from 'svelte/store'
import { config as ldConfigStore } from './config.js'
import { session as ldSession, refreshSession } from './session.js'

// Live-Variable, damit der verbatim uebernommene Code `config.global.xxx` liest.
let config = get(ldConfigStore)
ldConfigStore.subscribe((v) => { config = v })

// ============================================
// Live-Deploy (Backend unter /api/, siehe api/server.js)
// Nutzt das globale `config`-Objekt aus app.js.
// ============================================
function ldEsc(s) {
    const div = document.createElement('div');
    div.textContent = String(s == null ? '' : s);
    return div.innerHTML;
}

async function ldApi(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && typeof opts.body === 'object') {
        opts.body = JSON.stringify(opts.body);
        opts.headers['Content-Type'] = 'application/json';
    }
    opts.credentials = 'same-origin';
    const r = await fetch(path, opts);
    let data = {};
    try { data = await r.json(); } catch (e) { /* leere Antwort */ }
    if (!r.ok) {
        const err = new Error(data.error || ('HTTP ' + r.status));
        err.status = r.status;
        err.hint = data.hint;
        throw err;
    }
    return data;
}

// Anzeige-Helfer
const LD_PHASE_ICONS = {
    'Quarantine Policies': '🔒',
    'Anti-Phishing': '🎣',
    'Anti-Spam': '📧',
    'Anti-Malware': '🦠',
    'Alert Policy (Security & Compliance)': '🔔'
};
const LD_ACTION_DE = { created: 'angelegt', updated: 'aktualisiert' };

function ldElapsed(startIso, endIso) {
    const ms = (endIso ? new Date(endIso) : new Date()) - new Date(startIso);
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' min';
}

export function initializeLiveDeploy() {
    const tab = document.getElementById('livedeploy');
    if (!tab) return;

    const elOffline = document.getElementById('ldOffline');
    const elNeedLogin = document.getElementById('ldNeedLogin');
    const elMain = document.getElementById('ldMain');
    const elLog = document.getElementById('ldLog');

    let deployRunning = false;
    let pollTimer = null;    // Onboarding-Poll
    let jobTimer = null;     // Deploy-Job-Poll
    let currentSnippet = ''; // Snippet des manuellen Alert-Policy-Schritts
    let lastAudit = null;    // letztes Audit-Ergebnis fuer den PDF-Report
    let ldDeviations = [];   // pro Tenant als "gewollt" markierte Abweichungen [{key,reason,ts}]
    let ldAuditCtx = null;   // Rohkontext des letzten Audits fuer lokales Re-Rendern

    function show(el, visible) { if (el) el.style.display = visible ? '' : 'none'; }
    function log(html) { elLog.innerHTML = html; }

    // Kopieren-Button des manuellen Snippets (Delegation, da der Log-Bereich
    // waehrend des Job-Pollings immer wieder neu gerendert wird).
    elLog.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'ldCopySnippet' && currentSnippet) {
            navigator.clipboard.writeText(currentSnippet).then(() => { e.target.textContent = '✓ Kopiert'; });
        }
        if (e.target && e.target.closest && e.target.closest('#ldAuditPdf')) {
            openAuditPdfReport();
        }
        const devBtn = e.target && e.target.closest && e.target.closest('.ld-dev-btn');
        if (devBtn) { handleDeviationClick(devBtn); }
    });

    // ---------- Session ----------
    // Der Login liegt global im Header (session.js), weil er auch die
    // Agent-Downloads gatet. Hier wird nur noch auf den Zustand reagiert.
    async function applySession(s) {
        if (!s.online) {
            show(elNeedLogin, false);
            show(elMain, false);
            show(elOffline, true);
            elOffline.innerHTML = '<strong>⚠️ Backend nicht erreichbar.</strong> Das Live-Deploy-Backend läuft nur im Docker-Stack (<code>docker compose up -d</code>). Im statischen Betrieb stehen weiterhin die generierten PowerShell-Skripte zur Verfügung.';
            return;
        }
        show(elOffline, false);
        show(elNeedLogin, !s.loggedIn);
        show(elMain, !!s.loggedIn);
        if (s.loggedIn) await loadTenants();
        if (s.pwsh && s.pwsh.checked && !s.pwsh.ok) {
            show(elOffline, true);
            elOffline.innerHTML = '<strong>⚠️ pwsh fehlt im Backend-Container.</strong> Deploys werden fehlschlagen — Container-Image prüfen.';
        }
    }

    // Bleibt als Name erhalten: wird nach Aktionen aufgerufen, die den Zustand
    // aendern koennen. Der refresh loest session-change aus -> applySession.
    async function refreshState() {
        await refreshSession();
    }

    const _ldUnsub = ldSession.subscribe((s) => applySession(s));

    // ---------- Tenants ----------
    async function loadTenants() {
        const box = document.getElementById('ldTenants');
        let tenants = [];
        try { tenants = await ldApi('/api/tenants'); } catch (e) { box.innerHTML = '<em>' + ldEsc(e.message) + '</em>'; return; }
        if (!tenants.length) { box.innerHTML = '<em>Noch keine Tenants onboardet — unten den ersten Tenant hinzufügen.</em>'; return; }
        box.innerHTML = tenants.map(t => {
            const ready = t.certPresent && t.exoRole && t.sccRole && t.tcm;
            const missing = [
                t.certPresent ? null : 'Zertifikat',
                t.exoRole ? null : 'Exchange-Rolle',
                t.sccRole ? null : 'Compliance-Rolle',
                t.tcm ? null : 'TCM'
            ].filter(Boolean);
            const badge = ready
                ? '<span class="ld-badge ok">✓ bereit</span>'
                : '<span class="ld-badge warn" title="' + ldEsc(missing.join(', ') + ' fehlt — Tenant neu onboarden') + '">⚠ ' + ldEsc(missing.join(', ')) + ' fehlt</span>';
            return `
            <div class="ld-tenant" data-id="${ldEsc(t.id)}">
                <div class="ld-tenant-head">
                    <div class="ld-tenant-info">
                        <strong>${ldEsc(t.name)} ${badge}</strong>
                        <small>${ldEsc(t.organization || t.tenantId)} · App ${ldEsc((t.appId || '').slice(0, 8))}…</small>
                    </div>
                    <span class="ld-tenant-chev" aria-hidden="true">▾</span>
                </div>
                <div class="ld-tenant-body">
                    <div class="ld-tenant-section">
                        <h5>🛡 Mail-Security</h5>
                        <p class="ld-section-hint">Best-Practice-Policies (Anti-Phishing/Spam/Malware/Quarantäne) aus der Vorlage anwenden.</p>
                        <div class="ld-section-actions">
                            <button class="btn btn-secondary" data-action="test" title="Nur Verbindung testen">Verbindung testen</button>
                            <button class="btn btn-primary" data-action="deploy">Deployen</button>
                        </div>
                    </div>
                    <div class="ld-tenant-section">
                        <h5>💻 Intune-Baseline <small>(OpenIntuneBaseline)</small></h5>
                        <p class="ld-section-hint">„Win - OIB"-Policies anzeigen und dynamischen Security-Gruppen zuweisen.</p>
                        <div class="ld-section-actions">
                            <button class="btn btn-secondary" data-action="oib">🧩 OIB-Policies zuweisen</button>
                        </div>
                    </div>
                    <div class="ld-tenant-section">
                        <h5>🔎 Audit</h5>
                        <p class="ld-section-hint">Ist-Zustand aus dem Tenant lesen und mit der Vorlage vergleichen (Soll/Ist).</p>
                        <div class="ld-section-actions">
                            <button class="btn btn-secondary" data-action="audit">Ist-Zustand prüfen</button>
                        </div>
                    </div>
                    <div class="ld-tenant-section">
                        <h5>⚙ Verwaltung</h5>
                        <div class="ld-section-actions">
                            <button class="btn btn-secondary" data-action="fix" title="App-Registrierung prüfen/reparieren: Permission, Consent, Rollen, Zertifikat">🔧 Reparieren</button>
                            <button class="btn btn-secondary" data-action="remove" title="Tenant aus dem Tool entfernen">✕ Entfernen</button>
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    document.getElementById('ldTenants').addEventListener('click', async (e) => {
        // Kopfzeile klicken -> Tenant-Karte auf/zu (tenant-zentrisch: erst Tenant
        // waehlen, dann seine Aktionen). Nur eine Karte offen halten.
        const head = e.target.closest('.ld-tenant-head');
        if (head) {
            const card = head.closest('.ld-tenant');
            const wasOpen = card.classList.contains('open');
            document.querySelectorAll('#ldTenants .ld-tenant.open').forEach(c => c.classList.remove('open'));
            if (!wasOpen) card.classList.add('open');
            return;
        }
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const row = btn.closest('.ld-tenant');
        const id = row.dataset.id;
        const name = row.querySelector('strong').firstChild.textContent.trim();
        const action = btn.dataset.action;

        if (action === 'remove') {
            if (!confirm('Tenant "' + name + '" aus dem Tool entfernen? (Die App-Registrierung im Tenant bleibt bestehen.)')) return;
            try { await ldApi('/api/tenants/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (err) { alert(err.message); }
            await loadTenants();
            return;
        }

        if (action === 'test') {
            btn.disabled = true; btn.textContent = '…';
            log('<div class="ld-job"><div class="ld-job-head"><strong>Verbindungstest: ' + ldEsc(name) + '</strong></div>' +
                '<div class="ld-step running"><span class="ld-spinner"></span> Verbinde app-only mit Exchange Online — dauert ca. 20–30 Sekunden…</div></div>');
            try {
                const r = await ldApi('/api/tenants/' + encodeURIComponent(id) + '/test', { method: 'POST' });
                log('<div class="ld-job"><div class="ld-banner ok">✅ Verbindung OK — der Tenant ist bereit für den Deploy.</div>' +
                    '<div class="ld-step"><small>Accepted Domains im Tenant: ' + (r.domains || []).map(ldEsc).join(', ') + '</small></div></div>');
            } catch (err) {
                log('<div class="ld-job"><div class="ld-banner fail">❌ ' + ldEsc(err.message) + '</div>' +
                    (err.hint ? '<div class="ld-step"><small>💡 ' + ldEsc(err.hint) + '</small></div>' : '') + '</div>');
            }
            btn.disabled = false; btn.textContent = 'Test';
            return;
        }

        if (action === 'audit') {
            btn.disabled = true; btn.textContent = '…';
            log('<div class="ld-job"><div class="ld-job-head"><strong>🔎 Ist-Zustand: ' + ldEsc(name) + '</strong></div>' +
                '<div class="ld-step running"><span class="ld-spinner"></span> Lese Policies aus dem Tenant — dauert ca. 30–60 Sekunden…</div></div>');
            try {
                const r = await ldApi('/api/tenants/' + encodeURIComponent(id) + '/audit', { method: 'POST' });
                ldDeviations = Array.isArray(r.acceptedDeviations) ? r.acceptedDeviations : [];
                renderAudit(id, name, r.audit || {}, r.alertPolicy || null);
            } catch (err) {
                log('<div class="ld-job"><div class="ld-banner fail">❌ ' + ldEsc(err.message) + '</div></div>');
            }
            btn.disabled = false; btn.textContent = '🔎 Prüfen';
            return;
        }

        if (action === 'fix') {
            startPermissionFix(id, name);
            return;
        }

        if (action === 'oib') {
            btn.disabled = true; btn.textContent = '…';
            log('<div class="ld-job"><div class="ld-job-head"><strong>🧩 OIB-Policies: ' + ldEsc(name) + '</strong></div>' +
                '<div class="ld-step running"><span class="ld-spinner"></span> Lade Policies und dynamische Gruppen aus dem Tenant…</div></div>');
            try {
                const data = await ldApi('/api/tenants/' + encodeURIComponent(id) + '/oib');
                renderOib(id, name, data);
            } catch (err) {
                log('<div class="ld-job"><div class="ld-banner fail">❌ ' + ldEsc(err.message) + '</div>' +
                    '<div class="ld-step"><small>💡 Braucht die Graph-Permissions (DeviceManagementConfiguration, Group.Read) — ggf. einmal 🔧 Reparieren ausführen.</small></div></div>');
            }
            btn.disabled = false; btn.textContent = '🧩 OIB';
            return;
        }

        if (action === 'deploy') {
            if (deployRunning) { alert('Es läuft bereits ein Deploy — bitte warten.'); return; }
            showDeployConfirm(id, name);
            return;
        }
    });

    // ---------- Permission-Fixer (bestehende App-Registrierung reparieren) ----------
    async function startPermissionFix(id, name) {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        log('<div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Starte Reparatur für ' + ldEsc(name) + '…</div></div>');
        let start;
        try {
            start = await ldApi('/api/tenants/' + encodeURIComponent(id) + '/fix/start', { method: 'POST' });
        } catch (e) {
            log('<div class="ld-job"><div class="ld-banner fail">❌ ' + ldEsc(e.message) + '</div></div>');
            return;
        }
        log(`
            <div class="ld-job">
                <div class="ld-job-head"><strong>🔧 App-Registrierung reparieren: ${ldEsc(name)}</strong></div>
                <div class="ld-step"><small>Prüft und repariert: Exchange.ManageAsApp, Admin-Consent, Exchange-Admin- + Compliance-Rolle, Zertifikat-Hinterlegung. Das bestehende Zertifikat bleibt unangetastet.</small></div>
                <div class="ld-onboard-step">1️⃣ Öffne <a href="${ldEsc(start.verificationUri)}" target="_blank" rel="noopener">${ldEsc(start.verificationUri)}</a></div>
                <div class="ld-onboard-step">2️⃣ Melde dich als <strong>Admin von ${ldEsc(name)}</strong> an und gib diesen Code ein:
                    <span class="ld-code">${ldEsc(start.userCode)}</span>
                    <button class="btn btn-secondary" id="ldCopyFixCode" style="padding:0.2rem 0.6rem; font-size:0.8rem;">Kopieren</button>
                </div>
                <div class="ld-onboard-step">3️⃣ <span id="ldFixStatus"><span class="ld-spinner"></span> Warte auf deine Anmeldung…</span></div>
            </div>`);
        document.getElementById('ldCopyFixCode').addEventListener('click', () => {
            navigator.clipboard.writeText(start.userCode).then(() => {
                document.getElementById('ldCopyFixCode').textContent = '✓ Kopiert';
            });
        });

        const stateIcons = { ok: '✅', fixed: '🔧', failed: '❌' };
        const stateText = { ok: 'war korrekt', fixed: 'repariert', failed: 'fehlgeschlagen' };
        const poll = async () => {
            let r;
            try {
                r = await ldApi('/api/fix/poll', { method: 'POST' });
            } catch (e) {
                const el = document.getElementById('ldFixStatus');
                if (el) el.innerHTML = '❌ ' + ldEsc(e.message);
                return;
            }
            if (r.status === 'pending') {
                pollTimer = setTimeout(poll, (r.interval || start.interval || 5) * 1000);
                return;
            }
            if (r.status === 'error') {
                const el = document.getElementById('ldFixStatus');
                if (el) el.innerHTML = '❌ ' + ldEsc(r.error);
                return;
            }
            const items = r.items || [];
            const failed = items.filter(i => i.state === 'failed').length;
            const fixedCount = items.filter(i => i.state === 'fixed').length;
            const banner = failed > 0
                ? '<div class="ld-banner warn">⚠️ ' + failed + ' Punkt(e) konnten nicht repariert werden — Details unten.</div>'
                : (fixedCount > 0
                    ? '<div class="ld-banner ok">✅ Reparatur abgeschlossen — ' + fixedCount + ' Punkt(e) korrigiert, Rest war bereits korrekt.</div>'
                    : '<div class="ld-banner ok">✅ Alles bereits korrekt — nichts zu reparieren.</div>');
            const rows = items.map(i =>
                '<div class="ld-step ' + (i.state === 'failed' ? 'fail' : 'ok') + '"><span class="ld-ico">' + stateIcons[i.state] + '</span> ' +
                ldEsc(i.name) + ' <small>(' + stateText[i.state] + (i.detail ? ' — ' + ldEsc(i.detail) : '') + ')</small></div>'
            ).join('');
            log('<div class="ld-job"><div class="ld-job-head"><strong>🔧 Reparatur: ' + ldEsc(name) + '</strong></div>' + banner + rows +
                '<div class="ld-step"><small>💡 Danach mit „Test" die Verbindung prüfen — frisch reparierte Rollen brauchen ggf. ein paar Minuten Replikationszeit.</small></div></div>');
            await loadTenants();
        };
        pollTimer = setTimeout(poll, (start.interval || 5) * 1000);
    }

    // ---------- OIB-Policy-Zuweisung ----------
    function renderOib(tenantRecId, name, data) {
        const groups = data.groups || [];
        const policies = data.policies || [];
        if (!policies.length) {
            log('<div class="ld-job"><div class="ld-banner warn">⚠️ Keine "Win - OIB"-Policies im Tenant gefunden — zuerst die OIB-Baseline importieren.</div></div>');
            return;
        }
        if (!groups.length) {
            log('<div class="ld-job"><div class="ld-banner warn">⚠️ Keine dynamischen Security Groups gefunden — zuerst die Gerätegruppen (AAD-DEV-*) anlegen.</div></div>');
            return;
        }

        // Nach Typ gruppieren
        const byType = [];
        for (const p of policies) {
            let grp = byType.find(g => g.type === p.type);
            if (!grp) { grp = { type: p.type, items: [] }; byType.push(grp); }
            grp.items.push(p);
        }

        const intentsWarn = data.intentsError
            ? '<div class="ld-banner warn">⚠️ Endpoint-Security-Policies (intents) konnten nicht geladen werden: ' + ldEsc(data.intentsError) +
              '<br><small>Settings-Catalog-Policies sind trotzdem verfügbar. Falls gerade erst 🔧 repariert wurde: ein paar Minuten Consent-Replikation abwarten und erneut öffnen.</small></div>'
            : '';

        const groupOptions = groups.map(g =>
            '<option value="' + ldEsc(g.id) + '" title="' + ldEsc(g.membershipRule) + '">' + ldEsc(g.displayName) + '</option>').join('');

        const policyRow = (p) => {
            const assigned = (p.assignments || []).map(a => ldEsc(a.label)).join(', ');
            return `
                <label class="ld-oib-row" data-policy-id="${ldEsc(p.id)}">
                    <input type="checkbox" class="ld-oib-cb" data-id="${ldEsc(p.id)}" data-apitype="${ldEsc(p.apiType)}">
                    <span class="ld-oib-name">${ldEsc(p.name)}</span>
                    <small class="ld-oib-assigned">${assigned ? '→ ' + assigned : '→ nicht zugewiesen'}</small>
                </label>`;
        };

        const typeBlocks = byType.map(grp => `
            <div class="ld-phase complete">
                <div class="ld-phase-title">🧩 ${ldEsc(grp.type)} (${grp.items.length})
                    <button class="btn btn-secondary ld-oib-selgroup" data-type="${ldEsc(grp.type)}" style="padding:0.1rem 0.5rem; font-size:0.75rem;">alle</button>
                </div>
                ${grp.items.map(policyRow).join('')}
            </div>`).join('');

        log(`
            <div class="ld-job" id="ldOibBox">
                <div class="ld-job-head"><strong>🧩 OIB-Policies: ${ldEsc(name)}</strong>
                    <span class="ld-job-meta">${policies.length} Policies · ${groups.length} dynamische Gruppen</span></div>
                ${intentsWarn}
                <div class="ld-oib-target">
                    <label for="ldOibGroup"><strong>Zielgruppe (dynamische Security Group):</strong></label>
                    <select id="ldOibGroup">${groupOptions}</select>
                </div>
                <div class="ld-oib-toolbar">
                    <button class="btn btn-secondary" id="ldOibAll" style="padding:0.25rem 0.7rem; font-size:0.8rem;">Alle auswählen</button>
                    <button class="btn btn-secondary" id="ldOibNone" style="padding:0.25rem 0.7rem; font-size:0.8rem;">Keine</button>
                </div>
                ${typeBlocks}
                <div class="ld-confirm-actions">
                    <button class="btn btn-primary" id="ldOibAssign">Auswahl der Zielgruppe zuweisen</button>
                </div>
                <div id="ldOibResult"></div>
            </div>`);

        const refreshAssignedMarks = () => {
            const gid = document.getElementById('ldOibGroup').value;
            for (const p of policies) {
                const row = document.querySelector('.ld-oib-row[data-policy-id="' + CSS.escape(p.id) + '"]');
                if (!row) continue;
                const already = (p.assignments || []).some(a => a.groupId === gid);
                row.classList.toggle('already', already);
                const cb = row.querySelector('.ld-oib-cb');
                cb.disabled = already;
                if (already) cb.checked = false;
                row.querySelector('.ld-oib-assigned').textContent =
                    (already ? '✓ bereits dieser Gruppe zugewiesen · ' : '') +
                    ((p.assignments || []).length ? '→ ' + p.assignments.map(a => a.label).join(', ') : '→ nicht zugewiesen');
            }
        };
        document.getElementById('ldOibGroup').addEventListener('change', refreshAssignedMarks);
        refreshAssignedMarks();

        document.getElementById('ldOibAll').addEventListener('click', () => {
            document.querySelectorAll('.ld-oib-cb:not(:disabled)').forEach(cb => cb.checked = true);
        });
        document.getElementById('ldOibNone').addEventListener('click', () => {
            document.querySelectorAll('.ld-oib-cb').forEach(cb => cb.checked = false);
        });
        document.querySelectorAll('.ld-oib-selgroup').forEach(b => b.addEventListener('click', () => {
            const box = b.closest('.ld-phase');
            box.querySelectorAll('.ld-oib-cb:not(:disabled)').forEach(cb => cb.checked = true);
        }));

        document.getElementById('ldOibAssign').addEventListener('click', async () => {
            const gid = document.getElementById('ldOibGroup').value;
            const gname = groups.find(g => g.id === gid)?.displayName || gid;
            const selected = [...document.querySelectorAll('.ld-oib-cb:checked')].map(cb => ({ id: cb.dataset.id, apiType: cb.dataset.apitype }));
            if (!selected.length) { alert('Keine Policies ausgewählt.'); return; }
            if (!confirm(selected.length + ' Policy/Policies der Gruppe "' + gname + '" zuweisen?\n\nBestehende Assignments bleiben erhalten (Merge).')) return;
            const btn = document.getElementById('ldOibAssign');
            btn.disabled = true; btn.textContent = 'Weise zu…';
            const resultBox = document.getElementById('ldOibResult');
            resultBox.innerHTML = '<div class="ld-step running"><span class="ld-spinner"></span> Zuweisung läuft…</div>';
            try {
                const r = await ldApi('/api/tenants/' + encodeURIComponent(tenantRecId) + '/oib/assign', { method: 'POST', body: { groupId: gid, policies: selected } });
                const nameById = new Map(policies.map(p => [p.id, p.name]));
                const icon = { assigned: '✅', skipped: '⏭️', failed: '❌' };
                const text = { assigned: 'zugewiesen', skipped: 'war bereits zugewiesen', failed: 'Fehler' };
                const okCount = (r.results || []).filter(x => x.status === 'assigned').length;
                const failCount = (r.results || []).filter(x => x.status === 'failed').length;
                resultBox.innerHTML =
                    '<div class="ld-banner ' + (failCount ? 'warn' : 'ok') + '">' +
                    (failCount ? '⚠️ ' + failCount + ' Fehler — Details unten. ' : '✅ ') +
                    okCount + ' Policy/Policies der Gruppe „' + ldEsc(gname) + '" zugewiesen.</div>' +
                    (r.results || []).map(x =>
                        '<div class="ld-step ' + (x.status === 'failed' ? 'fail' : 'ok') + '">' + icon[x.status] + ' ' +
                        ldEsc(nameById.get(x.id) || x.id) + ' <small>(' + text[x.status] + (x.error ? ' — ' + ldEsc(x.error) : '') + ')</small></div>'
                    ).join('');
            } catch (err) {
                resultBox.innerHTML = '<div class="ld-banner fail">❌ ' + ldEsc(err.message) + '</div>';
            }
            btn.disabled = false; btn.textContent = 'Auswahl der Zielgruppe zuweisen';
        });
    }

    // ---------- Ist-Zustand-Audit: Soll/Ist-Vergleich ----------
    function ldDomainsEqual(ist, soll) {
        const norm = a => (Array.isArray(a) ? a : (a ? [a] : [])).map(d => String(d).toLowerCase()).sort();
        const i = norm(ist), s = norm(soll);
        return i.length === s.length && i.every((v, k) => v === s[k]);
    }

    function ldPermFlags(permString, expected) {
        // expected: { PermissionToRequestRelease: true, ... } gegen den Ist-String pruefen
        const bad = [];
        for (const [flag, want] of Object.entries(expected)) {
            const isTrue = new RegExp(flag + ':\\s*True', 'i').test(String(permString || ''));
            if (isTrue !== want) bad.push(flag.replace('PermissionTo', '') + (want ? ' fehlt' : ' zu viel'));
        }
        return bad;
    }

    let auditPollTimer = null;

    function renderAudit(tenantRecId, name, audit, alertPolicy) {
        if (auditPollTimer) { clearTimeout(auditPollTimer); auditPollTimer = null; }
        ldAuditCtx = { tenantRecId, name, audit, alertPolicy };
        const ap = config.antiPhishing, as = config.antiSpam, am = config.antiMalware, g = config.global;
        const autoDomains = !!(document.getElementById('ldAutoDomains') && document.getElementById('ldAutoDomains').checked);
        const sollDomains = autoDomains ? (audit.acceptedDomains || []) : [...g.domains, g.onmicrosoftDomain].filter(Boolean);
        const groups = [];

        function group(icon, title) { const grp = { icon, title, checks: [] }; groups.push(grp); return grp; }
        function ok(grp, label, ist) { grp.checks.push({ state: 'ok', label, detail: ist }); }
        function bad(grp, label, soll, ist) { grp.checks.push({ state: 'bad', label, detail: 'Soll: ' + soll + ' · Ist: ' + ist }); }
        function missing(grp, label) { grp.checks.push({ state: 'missing', label, detail: 'nicht vorhanden — Deploy ausführen' }); }
        function info(grp, label, detail) { grp.checks.push({ state: 'info', label, detail }); }
        function cmp(grp, label, soll, ist) {
            if (String(soll) === String(ist)) ok(grp, label, String(ist));
            else bad(grp, label, String(soll), String(ist == null ? '(leer)' : ist));
        }
        function cmpBool(grp, label, soll, ist) { cmp(grp, label, soll ? 'true' : 'false', ist === true ? 'true' : (ist === false ? 'false' : ist)); }

        // Quarantine Policies
        const gq = group('🔒', 'Quarantine Policies');
        if (!audit.quarantineSelf) missing(gq, 'BP_Quarantine-SelfReleaseNotification');
        else {
            const q = audit.quarantineSelf;
            ok(gq, 'BP_Quarantine-SelfReleaseNotification', 'vorhanden');
            cmpBool(gq, 'SelfRelease: Benachrichtigung aktiv', true, q.ESNEnabled);
            cmpBool(gq, 'SelfRelease: inkl. blockierte Absender', true, q.IncludeMessagesFromBlockedSenderAddress);
            const badFlags = ldPermFlags(q.Permissions, { PermissionToAllowSender: true, PermissionToBlockSender: true, PermissionToRequestRelease: true, PermissionToRelease: false, PermissionToPreview: true, PermissionToDelete: true });
            if (badFlags.length === 0) ok(gq, 'SelfRelease: Berechtigungen (59)', 'korrekt');
            else bad(gq, 'SelfRelease: Berechtigungen (59)', 'AllowSender+BlockSender+RequestRelease+Preview+Delete', badFlags.join(', '));
        }
        if (!audit.quarantineRequest) missing(gq, 'BP_Quarantine-RequestReleaseNotification');
        else {
            const q = audit.quarantineRequest;
            ok(gq, 'BP_Quarantine-RequestReleaseNotification', 'vorhanden');
            cmpBool(gq, 'RequestRelease: Benachrichtigung aktiv', true, q.ESNEnabled);
            cmpBool(gq, 'RequestRelease: ohne blockierte Absender', false, q.IncludeMessagesFromBlockedSenderAddress);
            const badFlags = ldPermFlags(q.Permissions, { PermissionToAllowSender: false, PermissionToBlockSender: true, PermissionToRequestRelease: true, PermissionToRelease: false, PermissionToPreview: true, PermissionToDelete: false });
            if (badFlags.length === 0) ok(gq, 'RequestRelease: Berechtigungen (26)', 'korrekt');
            else bad(gq, 'RequestRelease: Berechtigungen (26)', 'BlockSender+RequestRelease+Preview', badFlags.join(', '));
        }

        // Anti-Phishing
        const gp = group('🎣', 'Anti-Phishing');
        if (!audit.antiPhish) missing(gp, 'BP_AntiPhishing');
        else {
            const p = audit.antiPhish;
            cmpBool(gp, 'Policy aktiv', true, p.Enabled);
            cmpBool(gp, 'Spoof Intelligence', ap.spoofIntelligence, p.EnableSpoofIntelligence);
            cmpBool(gp, 'First Contact Safety Tip', ap.firstContactTip, p.EnableFirstContactSafetyTips);
            cmpBool(gp, 'Unauth-Sender-Symbol (?)', ap.unauthSenderSymbol, p.EnableUnauthenticatedSender);
            cmpBool(gp, 'Via-Tag', ap.viaTag, p.EnableViaTag);
            cmpBool(gp, 'DMARC beachten', ap.honorDmarc, p.HonorDmarcPolicy);
            cmp(gp, 'DMARC p=quarantine', ap.dmarcQuarantineAction, p.DmarcQuarantineAction);
            cmp(gp, 'DMARC p=reject', ap.dmarcRejectAction, p.DmarcRejectAction);
            cmp(gp, 'Spoof-Aktion', ap.spoofAction, p.AuthenticationFailAction);
            cmp(gp, 'Spoof-Quarantine-Tag', 'BP_Quarantine-SelfReleaseNotification', p.SpoofQuarantineTag);
        }
        if (!audit.antiPhishRule) missing(gp, 'BP_AntiPhishing_Rule');
        else {
            cmp(gp, 'Rule aktiv', 'Enabled', audit.antiPhishRule.State);
            if (ldDomainsEqual(audit.antiPhishRule.RecipientDomainIs, sollDomains)) ok(gp, 'Rule-Domains', (audit.antiPhishRule.RecipientDomainIs || []).join(', '));
            else bad(gp, 'Rule-Domains', sollDomains.join(', '), (audit.antiPhishRule.RecipientDomainIs || []).join(', ') || '(leer)');
        }

        // Anti-Spam
        const gs = group('📧', 'Anti-Spam');
        if (!audit.antiSpam) missing(gs, 'BP_AntiSpam_Inbound');
        else {
            const s = audit.antiSpam;
            cmp(gs, 'Bulk-Schwelle', as.bulkThreshold, s.BulkThreshold);
            cmp(gs, 'Spam-Aktion', as.spamAction, s.SpamAction);
            cmp(gs, 'High-Conf-Spam-Aktion', as.highConfSpamAction, s.HighConfidenceSpamAction);
            cmp(gs, 'Bulk-Aktion', as.bulkAction, s.BulkSpamAction);
            cmp(gs, 'Phishing-Aktion', as.phishAction, s.PhishSpamAction);
            cmp(gs, 'High-Conf-Phishing-Aktion', as.highConfPhishAction, s.HighConfidencePhishAction);
            cmp(gs, 'Quarantäne-Aufbewahrung (Tage)', 30, s.QuarantineRetentionPeriod);
            const tagChecks = [
                ['Spam-Tag', s.SpamQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
                ['High-Conf-Spam-Tag', s.HighConfidenceSpamQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
                ['Bulk-Tag', s.BulkQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
                ['Phishing-Tag', s.PhishQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
                ['High-Conf-Phishing-Tag', s.HighConfidencePhishQuarantineTag, 'BP_Quarantine-RequestReleaseNotification']
            ];
            const badTags = tagChecks.filter(([, ist, soll]) => String(ist) !== soll).map(([l, ist]) => l + '=' + (ist || '(leer)'));
            if (badTags.length === 0) ok(gs, 'Quarantine-Tags (5)', 'alle korrekt');
            else bad(gs, 'Quarantine-Tags (5)', 'BP_-Tags', badTags.join(', '));
            // Legacy-ASF (Advanced Spam Filter): Best Practice = alle Off. Jeden
            // Filter einzeln ausweisen, damit im Audit/PDF pro Filter der Off/On-
            // Zustand sichtbar ist (nicht nur aggregiert). Soll = Vorlage; die
            // Vorlage hat alle 9 auf Off (Microsoft-Empfehlung, ARC/Composite-Auth
            // nicht uebersteuern, hohe False-Positive-Rate, nicht als FP meldbar).
            const markMap = [
                ['bizInfoUrls', 'IncreaseScoreWithBizOrInfoUrls', 'ASF: URLs zu .biz/.info'],
                ['numericIpUrls', 'IncreaseScoreWithNumericIps', 'ASF: Numerische IP in URL'],
                ['urlRedirect', 'IncreaseScoreWithRedirectToOtherPort', 'ASF: URL-Redirect zu anderem Port'],
                ['emptyMessages', 'MarkAsSpamEmptyMessages', 'ASF: Leere Nachrichten'],
                ['jsVbScript', 'MarkAsSpamJavaScriptInHtml', 'ASF: JavaScript/VBScript in HTML'],
                ['frameIframe', 'MarkAsSpamFramesInHtml', 'ASF: Frame/IFrame-Tags'],
                ['sensitiveWords', 'MarkAsSpamSensitiveWordList', 'ASF: Sensible Wörter'],
                ['spfHardFail', 'MarkAsSpamSpfRecordHardFail', 'ASF: SPF Hard Fail'],
                ['backscatter', 'MarkAsSpamFromAddressAuthFail', 'ASF: Backscatter / From-Auth-Fail']
            ];
            const asfOn = markMap.filter(([, istKey]) => String(s[istKey]) === 'On').length;
            info(gs, 'Erweiterte Spam-Filter (ASF, 9)', asfOn === 0
                ? 'alle Off — Best Practice (Microsoft empfiehlt Off)'
                : asfOn + ' von 9 aktiviert — Microsoft empfiehlt Off, nur gezielt & mit Grund aktivieren');
            for (const [cfgKey, istKey, label] of markMap) {
                cmp(gs, label, (as[cfgKey] ? 'On' : 'Off'), s[istKey]);
            }
        }
        if (!audit.antiSpamRule) missing(gs, 'BP_AntiSpam_Inbound_Rule');
        else {
            cmp(gs, 'Rule aktiv', 'Enabled', audit.antiSpamRule.State);
            if (ldDomainsEqual(audit.antiSpamRule.RecipientDomainIs, sollDomains)) ok(gs, 'Rule-Domains', (audit.antiSpamRule.RecipientDomainIs || []).join(', '));
            else bad(gs, 'Rule-Domains', sollDomains.join(', '), (audit.antiSpamRule.RecipientDomainIs || []).join(', ') || '(leer)');
        }

        // Anti-Malware
        const gm = group('🦠', 'Anti-Malware');
        if (!audit.malware) missing(gm, 'BP_AntiMalware');
        else {
            const m = audit.malware;
            cmpBool(gm, 'Anhang-Filter aktiv', am.commonAttachFilter, m.EnableFileFilter);
            cmpBool(gm, 'Zero-Hour Auto Purge (ZAP)', am.zapMalware, m.ZapEnabled);
            cmp(gm, 'Quarantine-Tag', 'BP_Quarantine-RequestReleaseNotification', m.QuarantineTag);
            cmp(gm, 'Admin-Benachrichtigung an', g.adminEmail, m.InternalSenderAdminAddress);
            const soll = String(am.customFileTypes || '').split(',').map(t => t.trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean);
            const ist = (m.FileTypes || []).map(t => String(t).toLowerCase());
            const fehlt = soll.filter(t => !ist.includes(t));
            const extra = ist.filter(t => !soll.includes(t));
            if (fehlt.length === 0 && extra.length === 0) ok(gm, 'Blockierte Dateitypen (' + ist.length + ')', 'identisch mit Konfiguration');
            else bad(gm, 'Blockierte Dateitypen', soll.length + ' Typen', (fehlt.length ? 'fehlt: ' + fehlt.join(', ') : '') + (extra.length ? (fehlt.length ? ' · ' : '') + 'zusätzlich: ' + extra.join(', ') : ''));
        }
        if (!audit.malwareRule) missing(gm, 'BP_AntiMalware_Rule');
        else {
            cmp(gm, 'Rule aktiv', 'Enabled', audit.malwareRule.State);
            if (ldDomainsEqual(audit.malwareRule.RecipientDomainIs, sollDomains)) ok(gm, 'Rule-Domains', (audit.malwareRule.RecipientDomainIs || []).join(', '));
            else bad(gm, 'Rule-Domains', sollDomains.join(', '), (audit.malwareRule.RecipientDomainIs || []).join(', ') || '(leer)');
        }

        // Alert Policy — via TCM-Snapshot (Graph)
        const ga = group('🔔', 'Alert Policy (Security & Compliance)');
        const ap2 = alertPolicy || { status: 'error', error: 'keine TCM-Daten' };
        if (ap2.status === 'pending') {
            ga.checks.push({ state: 'loading', label: 'BP_UserRequestReleaseStatus', detail: 'TCM-Snapshot läuft — Ergebnis kommt gleich…' });
        } else if (ap2.status === 'error') {
            info(ga, 'BP_UserRequestReleaseStatus', 'nicht prüfbar: ' + (ap2.error || 'unbekannt') + (ap2.hint ? ' · ' + ap2.hint : ''));
        } else if (!ap2.found) {
            ga.checks.push({ state: 'missing', label: 'BP_UserRequestReleaseStatus', detail: 'nicht vorhanden — Snippet aus dem Deploy-Ergebnis auf Windows ausführen' });
        } else {
            ok(ga, 'BP_UserRequestReleaseStatus', 'vorhanden (geprüft via TCM-Snapshot)');
            cmpBool(ga, 'Alert aktiv', true, !ap2.disabled);
            const soll = [g.adminEmail, g.igeeksEmail].filter(Boolean).map(e => e.toLowerCase());
            const ist = (ap2.notifyUser || []).map(e => String(e).toLowerCase());
            const fehlend = soll.filter(e => !ist.includes(e));
            if (fehlend.length === 0) ok(ga, 'Empfänger', (ap2.notifyUser || []).join(', '));
            else bad(ga, 'Empfänger', soll.join(', '), (ap2.notifyUser || []).join(', ') || '(leer)');
        }

        // Gewollte Abweichungen (pro Tenant markiert) ueberschreiben bad/missing
        // -> 'accepted' (ℹ️, zaehlt nicht als Abweichung). Key = Gruppe :: Label.
        const devMap = {};
        for (const d of (ldDeviations || [])) { if (d && d.key) devMap[d.key] = d.reason; }
        for (const grp of groups) {
            for (const c of grp.checks) {
                if ((c.state === 'bad' || c.state === 'missing') && devMap[ldDevKey(grp.title, c.label)] != null) {
                    c.state = 'accepted';
                    c.reason = devMap[ldDevKey(grp.title, c.label)];
                }
            }
        }

        // Rendern
        const allChecks = groups.flatMap(grp => grp.checks);
        const countable = allChecks.filter(c => c.state !== 'info' && c.state !== 'loading' && c.state !== 'accepted');
        const okCount = countable.filter(c => c.state === 'ok').length;
        const acceptedCount = allChecks.filter(c => c.state === 'accepted').length;
        const allOk = okCount === countable.length;
        const iconFor = { ok: '✅', bad: '❌', missing: '⚠️', info: 'ℹ️', accepted: 'ℹ️' };
        const clsFor = { ok: 'ok', bad: 'fail', missing: 'retry', info: '', loading: 'running', accepted: 'accepted' };
        const rowHtml = (grp, c) => {
            const ico = c.state === 'loading' ? '<span class="ld-spinner"></span>' : iconFor[c.state];
            const key = encodeURIComponent(ldDevKey(grp.title, c.label));
            let extra = '';
            if (c.state === 'bad' || c.state === 'missing') {
                extra = ' <button class="ld-dev-btn" data-devact="accept" data-devkey="' + key + '" title="Diese Abweichung als bewusst/gewollt markieren (erscheint dann als ℹ️ statt ❌, auch im PDF)">als gewollt markieren</button>';
            } else if (c.state === 'accepted') {
                extra = ' <span class="ld-dev-reason">✋ gewollt: ' + ldEsc(c.reason || '') + '</span>' +
                    ' <button class="ld-dev-btn" data-devact="clear" data-devkey="' + key + '" title="Markierung entfernen — Check wird wieder als Abweichung gewertet">✕</button>';
            }
            return '<div class="ld-step ' + clsFor[c.state] + '"><span class="ld-ico">' + ico + '</span> ' +
                ldEsc(c.label) + ' <small>' + ldEsc(c.detail) + '</small>' + extra + '</div>';
        };
        const groupHtml = groups.map(grp => {
            const anyBad = grp.checks.some(c => c.state === 'bad' || c.state === 'missing');
            return '<div class="ld-phase ' + (anyBad ? 'active' : 'complete') + '"><div class="ld-phase-title">' + grp.icon + ' ' + ldEsc(grp.title) + '</div>' +
                grp.checks.map(c => rowHtml(grp, c)).join('') + '</div>';
        }).join('');
        const accNote = acceptedCount ? ' <span class="ld-acc-note">· ' + acceptedCount + ' als gewollt markiert</span>' : '';
        const banner = allOk
            ? '<div class="ld-banner ok">✅ Ist-Zustand entspricht der Konfiguration (' + okCount + '/' + countable.length + ' Checks OK).' + accNote + '</div>'
            : '<div class="ld-banner warn">⚠️ ' + (countable.length - okCount) + ' von ' + countable.length + ' Checks weichen ab — ein Deploy bringt den Tenant auf den Soll-Zustand.' + accNote + '</div>';
        const domSrc = autoDomains ? 'Accepted Domains des Tenants' : 'Domains aus dem Konfigurations-Tab';
        lastAudit = { name, groups, okCount, total: countable.length, accepted: acceptedCount, allOk, domSrc, sollDomains: sollDomains.slice() };
        log('<div class="ld-job"><div class="ld-job-head"><strong>🔎 Ist-Zustand: ' + ldEsc(name) + '</strong>' +
            '<span class="ld-job-meta">Soll-Domains: ' + ldEsc(domSrc) + '</span>' +
            '<button id="ldAuditPdf" class="btn btn-secondary ld-pdf-btn" title="Diese Dokumentation als PDF speichern (Druckdialog → „Als PDF speichern")">📄 Als PDF dokumentieren</button>' +
            '</div>' + banner + groupHtml + '</div>');

        // TCM-Snapshot lief beim Audit noch — weiter pollen und dann neu rendern
        if (ap2.status === 'pending' && ap2.jobId) {
            let tries = 0;
            const pollTcm = async () => {
                let result;
                try {
                    result = await ldApi('/api/tenants/' + encodeURIComponent(tenantRecId) + '/tcm/' + encodeURIComponent(ap2.jobId));
                } catch (e) {
                    renderAudit(tenantRecId, name, audit, { status: 'error', error: e.message });
                    return;
                }
                if (result.status === 'pending') {
                    if (++tries >= 24) { renderAudit(tenantRecId, name, audit, { status: 'error', error: 'TCM-Snapshot dauert ungewöhnlich lange — später erneut prüfen.' }); return; }
                    auditPollTimer = setTimeout(pollTcm, 5000);
                    return;
                }
                renderAudit(tenantRecId, name, audit, result);
            };
            auditPollTimer = setTimeout(pollTcm, 5000);
        }
    }

    // ---------- Audit-Report als PDF ----------
    // Baut aus dem zuletzt gerenderten Audit (gleiche groups-Struktur wie oben)
    // ein eigenstaendiges, druckoptimiertes HTML-Dokument und oeffnet den
    // Druckdialog. "Als PDF speichern" liefert dann die fertige Doku — ohne
    // zusaetzliche Library, mit echtem Vektor-Text und sauberen Seitenumbruechen.
    function ldAuditStatusMeta(state) {
        switch (state) {
            case 'ok': return { label: 'Konform', cls: 'ok' };
            case 'bad': return { label: 'Abweichung', cls: 'bad' };
            case 'missing': return { label: 'Fehlt', cls: 'missing' };
            case 'accepted': return { label: 'Gewollt', cls: 'accepted' };
            case 'loading': return { label: 'Läuft', cls: 'info' };
            default: return { label: 'Info', cls: 'info' };
        }
    }

    function ldAuditSollIst(check) {
        const d = String(check.detail || '');
        const m = /^Soll:\s*(.*?)\s*·\s*Ist:\s*(.*)$/.exec(d);
        if (m) return { soll: m[1] || '(leer)', ist: m[2] || '(leer)' };
        return { soll: '', ist: d };
    }

    function buildAuditReportHtml(data) {
        const now = new Date();
        const dateStr = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
        const deviations = data.total - data.okCount;
        const pct = data.total ? Math.round((data.okCount / data.total) * 100) : 100;
        const accepted = data.accepted || 0;
        const summaryCls = data.allOk ? 'ok' : (deviations > (data.total / 4) ? 'bad' : 'warn');
        const accSuffix = accepted ? ' ' + accepted + ' Abweichung(en) sind als bewusst/gewollt markiert (siehe „Gewollt").' : '';
        const summaryText = (data.allOk
            ? 'Der Ist-Zustand entspricht vollständig der Best-Practice-Vorlage.'
            : deviations + ' von ' + data.total + ' Prüfpunkten weichen von der Vorlage ab. Ein Deploy bringt den Tenant auf den Soll-Zustand.') + accSuffix;

        const sections = data.groups.map(grp => {
            const gTotal = grp.checks.filter(c => c.state !== 'info' && c.state !== 'loading' && c.state !== 'accepted').length;
            const gOk = grp.checks.filter(c => c.state === 'ok').length;
            const gBadge = gTotal ? (gOk === gTotal
                ? '<span class="sec-badge ok">' + gOk + '/' + gTotal + ' konform</span>'
                : '<span class="sec-badge warn">' + gOk + '/' + gTotal + ' konform</span>')
                : '<span class="sec-badge info">Info</span>';
            const rows = grp.checks.map(c => {
                const sm = ldAuditStatusMeta(c.state);
                const si = ldAuditSollIst(c);
                const istCell = c.state === 'accepted'
                    ? (si.ist ? ldEsc(si.ist) : '<span class="muted">—</span>') + '<div class="rsn">✋ gewollt: ' + ldEsc(c.reason || '') + '</div>'
                    : (si.ist ? ldEsc(si.ist) : '<span class="muted">—</span>');
                return '<tr>' +
                    '<td class="c-check">' + ldEsc(c.label) + '</td>' +
                    '<td class="c-status"><span class="pill ' + sm.cls + '">' + sm.label + '</span></td>' +
                    '<td class="c-soll">' + (si.soll ? ldEsc(si.soll) : '<span class="muted">—</span>') + '</td>' +
                    '<td class="c-ist">' + istCell + '</td>' +
                    '</tr>';
            }).join('');
            return '<section class="cat">' +
                '<div class="cat-head"><span class="cat-title">' + grp.icon + ' ' + ldEsc(grp.title) + '</span>' + gBadge + '</div>' +
                '<table class="cat-table"><thead><tr>' +
                '<th class="c-check">Prüfpunkt</th><th class="c-status">Status</th><th class="c-soll">Soll (Best Practice)</th><th class="c-ist">Ist (Tenant)</th>' +
                '</tr></thead><tbody>' + rows + '</tbody></table></section>';
        }).join('');

        const domList = (data.sollDomains && data.sollDomains.length) ? data.sollDomains.join(', ') : '—';

        return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
            '<title>Ist-Zustand ' + ldEsc(data.name) + ' — M365 Security Doku</title>' +
            '<style>' + ldAuditReportCss() + '</style></head><body>' +
            '<button class="no-print print-btn" onclick="window.print()">📄 Als PDF speichern / Drucken</button>' +
            '<div class="page">' +
              '<header class="rpt-head">' +
                '<div class="rpt-head-main">' +
                  '<div class="rpt-kicker">M365 Security Policy Manager</div>' +
                  '<h1>Ist-Zustand Dokumentation</h1>' +
                  '<div class="rpt-sub">Best-Practice-Audit der Exchange-Online-Schutzrichtlinien</div>' +
                '</div>' +
                '<div class="rpt-score ' + summaryCls + '"><div class="score-num">' + pct + '%</div><div class="score-lbl">konform</div></div>' +
              '</header>' +
              '<div class="meta-grid">' +
                '<div class="meta-cell"><span class="meta-k">Tenant</span><span class="meta-v">' + ldEsc(data.name) + '</span></div>' +
                '<div class="meta-cell"><span class="meta-k">Erstellt am</span><span class="meta-v">' + dateStr + ' · ' + timeStr + ' Uhr</span></div>' +
                '<div class="meta-cell"><span class="meta-k">Soll-Domains</span><span class="meta-v">' + ldEsc(data.domSrc) + '</span></div>' +
                '<div class="meta-cell"><span class="meta-k">Geprüfte Domains</span><span class="meta-v">' + ldEsc(domList) + '</span></div>' +
              '</div>' +
              '<div class="summary ' + summaryCls + '"><strong>Ergebnis:</strong> ' + summaryText + '</div>' +
              sections +
              '<footer class="rpt-foot">Automatisch erzeugt vom M365 Security Policy Manager · ' + dateStr + ' ' + timeStr +
                ' · Soll = Best-Practice-Vorlage, Ist = live aus dem Tenant gelesen (app-only Exchange Online / Graph).</footer>' +
            '</div></body></html>';
    }

    function ldAuditReportCss() {
        return [
            '*{box-sizing:border-box;margin:0;padding:0}',
            'body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#1d2939;background:#f2f4f7;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
            '.page{max-width:820px;margin:24px auto;background:#fff;padding:32px 36px 40px;box-shadow:0 2px 18px rgba(16,24,40,.12);border-radius:6px}',
            '.rpt-head{display:flex;align-items:center;justify-content:space-between;gap:20px;background:linear-gradient(120deg,#1e3a8a,#4338ca);color:#fff;padding:22px 26px;border-radius:10px;margin:-8px 0 22px}',
            '.rpt-kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.82;font-weight:600}',
            '.rpt-head h1{font-size:25px;font-weight:700;margin:4px 0 2px;line-height:1.15}',
            '.rpt-sub{font-size:12.5px;opacity:.85}',
            '.rpt-score{flex:none;text-align:center;min-width:96px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.14)}',
            '.rpt-score .score-num{font-size:30px;font-weight:800;line-height:1}',
            '.rpt-score .score-lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;margin-top:3px}',
            '.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px}',
            '.meta-cell{background:#f8fafc;border:1px solid #eaecf0;border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;gap:2px}',
            '.meta-k{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#667085;font-weight:600}',
            '.meta-v{font-size:13.5px;font-weight:600;color:#1d2939;word-break:break-word}',
            '.summary{border-radius:8px;padding:11px 14px;font-size:13px;margin-bottom:22px;border:1px solid}',
            '.summary.ok{background:#ecfdf3;border-color:#abefc6;color:#067647}',
            '.summary.warn{background:#fffaeb;border-color:#fedf89;color:#b54708}',
            '.summary.bad{background:#fef3f2;border-color:#fecdca;color:#b42318}',
            '.rpt-score.ok{background:rgba(255,255,255,.18)}',
            '.cat{margin-bottom:16px;border:1px solid #eaecf0;border-radius:9px;overflow:hidden;break-inside:avoid;page-break-inside:avoid}',
            '.cat-head{display:flex;align-items:center;justify-content:space-between;background:#f8fafc;border-bottom:1px solid #eaecf0;padding:9px 14px}',
            '.cat-title{font-size:14.5px;font-weight:700;color:#1d2939}',
            '.sec-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px}',
            '.sec-badge.ok{background:#ecfdf3;color:#067647}',
            '.sec-badge.warn{background:#fffaeb;color:#b54708}',
            '.sec-badge.info{background:#eef1f5;color:#475467}',
            '.cat-table{width:100%;border-collapse:collapse;font-size:12px}',
            '.cat-table th{text-align:left;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:#667085;font-weight:700;padding:7px 12px;background:#fcfcfd;border-bottom:1px solid #eaecf0}',
            '.cat-table td{padding:7px 12px;border-bottom:1px solid #f2f4f7;vertical-align:top}',
            '.cat-table tr:last-child td{border-bottom:none}',
            '.cat-table tbody tr:nth-child(even) td{background:#fcfcfd}',
            '.c-check{width:30%;font-weight:600;color:#1d2939}',
            '.c-status{width:16%}',
            '.c-soll{width:27%;color:#475467}',
            '.c-ist{width:27%;color:#1d2939}',
            '.muted{color:#98a2b3}',
            '.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;white-space:nowrap}',
            '.pill.ok{background:#ecfdf3;color:#067647}',
            '.pill.bad{background:#fef3f2;color:#b42318}',
            '.pill.missing{background:#fffaeb;color:#b54708}',
            '.pill.info{background:#eef1f5;color:#475467}',
            '.pill.accepted{background:#eff4ff;color:#3538cd}',
            '.rsn{font-size:10px;color:#3538cd;margin-top:3px;font-style:italic}',
            '.rpt-foot{margin-top:20px;padding-top:12px;border-top:1px solid #eaecf0;font-size:10.5px;color:#98a2b3;line-height:1.5}',
            '.print-btn{position:fixed;top:16px;right:16px;z-index:9;background:#4338ca;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 3px 10px rgba(67,56,202,.35)}',
            '@media print{body{background:#fff}.no-print{display:none!important}.page{box-shadow:none;margin:0;max-width:none;border-radius:0;padding:0}.rpt-head{margin-top:0}}',
            '@page{size:A4;margin:14mm}'
        ].join('');
    }

    function openAuditPdfReport() {
        if (!lastAudit) return;
        const html = buildAuditReportHtml(lastAudit);
        const w = window.open('', '_blank');
        if (!w) {
            alert('Der Browser hat das PDF-Fenster blockiert. Bitte Pop-ups für diese Seite erlauben und erneut „Als PDF dokumentieren" klicken.');
            return;
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
        // Druckdialog kurz nach dem Laden — der Nutzer waehlt dort „Als PDF speichern".
        setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 400);
    }

    // ---------- Gewollte Abweichungen ----------
    // Stabiler Schluessel eines Checks: Gruppentitel + Label (Label allein ist
    // nicht eindeutig — "Rule aktiv"/"Rule-Domains" gibt es je Policy).
    function ldDevKey(groupTitle, label) { return groupTitle + ' :: ' + label; }

    async function handleDeviationClick(btn) {
        if (!ldAuditCtx) return;
        const act = btn.dataset.devact;
        const key = decodeURIComponent(btn.dataset.devkey || '');
        if (!key) return;
        let reason = '';
        if (act === 'accept') {
            reason = (window.prompt('Begründung für die gewollte Abweichung (erscheint im Audit-PDF):', '') || '').trim();
            if (!reason) return; // abgebrochen oder leer
        }
        btn.disabled = true;
        try {
            const r = await ldApi('/api/tenants/' + encodeURIComponent(ldAuditCtx.tenantRecId) + '/deviations',
                { method: 'POST', body: { key, reason } });
            ldDeviations = Array.isArray(r.acceptedDeviations) ? r.acceptedDeviations : [];
        } catch (err) {
            alert('Konnte die Markierung nicht speichern: ' + err.message);
            btn.disabled = false;
            return;
        }
        // Lokal neu rendern — kein erneuter (langsamer) EXO-Audit noetig.
        renderAudit(ldAuditCtx.tenantRecId, ldAuditCtx.name, ldAuditCtx.audit, ldAuditCtx.alertPolicy);
    }

    // ---------- Deploy: Zusammenfassung -> Start -> Live-Fortschritt ----------
    function showDeployConfirm(id, name) {
        const autoDomains = !!(document.getElementById('ldAutoDomains') && document.getElementById('ldAutoDomains').checked);
        const domains = [...config.global.domains, config.global.onmicrosoftDomain].filter(Boolean);
        const as = config.antiSpam, am = config.antiMalware, g = config.global;
        const fileTypeCount = String(am.customFileTypes || '').split(',').map(s => s.trim()).filter(Boolean).length;
        const recipients = [g.adminEmail, g.igeeksEmail].filter(Boolean).join(', ');
        const domainRow = autoDomains
            ? '<li><strong>Domains:</strong> automatisch aus dem Ziel-Tenant (Get-AcceptedDomain) ✅</li>'
            : '<li><strong>Domains:</strong> ' + domains.map(ldEsc).join(', ') + ' <span class="ld-warn">← aus dem Konfigurations-Tab, bitte prüfen!</span></li>';
        log(`
            <div class="ld-confirm">
                <strong>🚀 Deploy nach ${ldEsc(name)} — das wird angewendet:</strong>
                <ul>
                    ${domainRow}
                    <li><strong>Spam / High-Conf-Spam / Bulk:</strong> ${ldEsc(as.spamAction)} / ${ldEsc(as.highConfSpamAction)} / ${ldEsc(as.bulkAction)} (Bulk-Schwelle ${ldEsc(as.bulkThreshold)})</li>
                    <li><strong>Phishing / High-Conf-Phishing:</strong> ${ldEsc(as.phishAction)} / ${ldEsc(as.highConfPhishAction)}</li>
                    <li><strong>Anhang-Filter:</strong> ${fileTypeCount} blockierte Dateitypen · ZAP ${am.zapMalware ? 'an' : 'aus'}</li>
                    <li><strong>Quarantäne-Benachrichtigungen + Alert Policy an:</strong> ${ldEsc(recipients)}</li>
                </ul>
                <small>Alles idempotent: Vorhandene BP_-Policies werden aktualisiert, fehlende angelegt.</small>
                <div class="ld-confirm-actions">
                    <button class="btn btn-primary" id="ldConfirmGo">🚀 Jetzt deployen</button>
                    <button class="btn btn-secondary" id="ldConfirmCancel">Abbrechen</button>
                </div>
            </div>`);
        document.getElementById('ldConfirmGo').addEventListener('click', () => startDeploy(id, name, autoDomains));
        document.getElementById('ldConfirmCancel').addEventListener('click', () => log('Deploy abgebrochen — nichts verändert.'));
    }

    async function startDeploy(id, name, autoDomains) {
        deployRunning = true;
        if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
        log('<div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Starte Deploy…</div></div>');
        let start;
        try {
            start = await ldApi('/api/tenants/' + encodeURIComponent(id) + '/deploy', { method: 'POST', body: { config, autoDomains } });
        } catch (err) {
            deployRunning = false;
            log('<div class="ld-job"><div class="ld-banner fail">❌ ' + ldEsc(err.message) + '</div></div>');
            return;
        }
        const jobId = start.jobId;
        const poll = async () => {
            let job;
            try {
                job = await ldApi('/api/jobs/' + encodeURIComponent(jobId));
            } catch (err) {
                deployRunning = false;
                log('<div class="ld-job"><div class="ld-banner fail">❌ Fortschritt nicht abrufbar: ' + ldEsc(err.message) + '</div></div>');
                return;
            }
            renderJob(job, name);
            if (job.status === 'running') {
                jobTimer = setTimeout(poll, 1500);
            } else {
                deployRunning = false;
            }
        };
        poll();
    }

    function renderJob(job, name) {
        const total = job.steps.length;
        const finished = job.steps.filter(s => s.state === 'done' || s.state === 'failed').length;
        const pct = total ? Math.round(finished / total * 100) : 0;
        const running = job.status === 'running';

        // Schritte nach Phase gruppieren (Reihenfolge aus dem Steps-Array)
        const phases = [];
        for (const s of job.steps) {
            let ph = phases.find(p => p.name === s.phase);
            if (!ph) { ph = { name: s.phase, steps: [] }; phases.push(ph); }
            ph.steps.push(s);
        }

        const stepHtml = (s) => {
            if (s.state === 'pending') return '<div class="ld-step pending"><span class="ld-ico">○</span> ' + ldEsc(s.name) + '</div>';
            if (s.state === 'running') return '<div class="ld-step running"><span class="ld-spinner"></span> ' + ldEsc(s.name) + ' <small>wird angewendet…</small></div>';
            if (s.state === 'retry') return '<div class="ld-step retry"><span class="ld-ico">🔁</span> ' + ldEsc(s.name) + ' <small>' + s.try + '. Versuch läuft… (' + ldEsc((s.lastError || '').slice(0, 120)) + ')</small></div>';
            if (s.state === 'done') return '<div class="ld-step ok"><span class="ld-ico">✅</span> ' + ldEsc(s.name) + ' <small>(' + ldEsc(LD_ACTION_DE[s.action] || s.action) + (s.tries > 1 ? ', ' + s.tries + '. Versuch' : '') + ')</small></div>';
            if (s.state === 'manual') {
                currentSnippet = s.snippet || '';
                return '<div class="ld-step manual"><span class="ld-ico">📋</span> ' + ldEsc(s.name) + ' — <small>manueller Schritt</small>' +
                    '<div class="ld-manual-box"><small>' + ldEsc(s.info || '') + '</small>' +
                    '<pre class="ld-snippet">' + ldEsc(s.snippet || '') + '</pre>' +
                    '<button class="btn btn-secondary" id="ldCopySnippet" style="padding:0.25rem 0.7rem; font-size:0.8rem;">📋 Snippet kopieren</button></div></div>';
            }
            return '<div class="ld-step fail"><span class="ld-ico">❌</span> ' + ldEsc(s.name) + ' — <small>' + ldEsc(s.error || 'Fehler') + '</small></div>';
        };

        const phaseHtml = phases.map(ph => {
            const icon = LD_PHASE_ICONS[ph.name] || '⚙️';
            const allDone = ph.steps.every(s => s.state === 'done');
            const anyActive = ph.steps.some(s => s.state === 'running' || s.state === 'retry');
            const cls = anyActive ? 'active' : (allDone ? 'complete' : '');
            return '<div class="ld-phase ' + cls + '"><div class="ld-phase-title">' + icon + ' ' + ldEsc(ph.name) + '</div>' + ph.steps.map(stepHtml).join('') + '</div>';
        }).join('');

        let banner = '';
        if (job.status === 'done') {
            const manualCount = job.steps.filter(s => s.state === 'manual').length;
            banner = manualCount > 0
                ? '<div class="ld-banner ok">✅ Alle automatischen Schritte erfolgreich (' + ldElapsed(job.startedAt, job.finishedAt) + ') — ' + manualCount + ' manueller Schritt übrig (siehe 📋 unten).</div>'
                : '<div class="ld-banner ok">✅ Fertig — alle ' + total + ' Schritte erfolgreich (' + ldElapsed(job.startedAt, job.finishedAt) + ').</div>';
        } else if (job.status === 'partial') {
            const failed = job.steps.filter(s => s.state === 'failed').length;
            banner = '<div class="ld-banner warn">⚠️ ' + failed + ' von ' + total + ' Schritten fehlgeschlagen (Details unten). Einfach erneut deployen — erfolgreiche Schritte werden dabei nur aktualisiert.</div>';
        } else if (job.status === 'failed') {
            banner = '<div class="ld-banner fail">❌ ' + ldEsc(job.error || 'Deploy fehlgeschlagen') + (job.hint ? '<br><small>💡 ' + ldEsc(job.hint) + '</small>' : '') + '</div>';
        }

        const domainsLine = job.domains && job.domains.length
            ? '<div class="ld-step"><small>Rules gelten für: ' + job.domains.map(ldEsc).join(', ') + '</small></div>' : '';

        log(`
            <div class="ld-job">
                <div class="ld-job-head">
                    <strong>${running ? '⏳' : ''} Deploy nach ${ldEsc(name)}</strong>
                    <span class="ld-job-meta">${running ? ldEsc(job.phase) + ' · läuft seit ' : ''}${ldElapsed(job.startedAt, job.finishedAt)}</span>
                </div>
                <div class="ld-progress"><div class="ld-progress-fill${running ? ' animated' : ''}" style="width:${pct}%"></div></div>
                <div class="ld-progress-label">${finished} / ${total} Schritte</div>
                ${banner}
                ${domainsLine}
                ${phaseHtml}
            </div>`);
    }

    // ---------- Onboarding (Device-Code) ----------
    document.getElementById('ldOnboardBtn').addEventListener('click', async () => {
        const box = document.getElementById('ldDeviceCode');
        const tenant = document.getElementById('ldOnboardTenant').value.trim();
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        box.style.display = '';
        box.innerHTML = '<span class="ld-spinner"></span> Starte Onboarding…';
        let start;
        try {
            start = await ldApi('/api/onboard/start', { method: 'POST', body: { tenant } });
        } catch (e) {
            box.innerHTML = '❌ ' + ldEsc(e.message);
            return;
        }
        box.innerHTML = `
            <div class="ld-onboard-step">1️⃣ Öffne <a href="${ldEsc(start.verificationUri)}" target="_blank" rel="noopener">${ldEsc(start.verificationUri)}</a></div>
            <div class="ld-onboard-step">2️⃣ Melde dich als <strong>Admin des Ziel-Tenants</strong> an und gib diesen Code ein:
                <span class="ld-code">${ldEsc(start.userCode)}</span>
                <button class="btn btn-secondary" id="ldCopyCode" style="padding:0.2rem 0.6rem; font-size:0.8rem;">Kopieren</button>
            </div>
            <div class="ld-onboard-step">3️⃣ <span id="ldOnboardStatus"><span class="ld-spinner"></span> Warte auf deine Anmeldung… (Code ist ca. 15 Minuten gültig)</span></div>`;
        document.getElementById('ldCopyCode').addEventListener('click', () => {
            navigator.clipboard.writeText(start.userCode).then(() => {
                document.getElementById('ldCopyCode').textContent = '✓ Kopiert';
            });
        });

        const poll = async () => {
            let r;
            try {
                r = await ldApi('/api/onboard/poll', { method: 'POST' });
            } catch (e) {
                document.getElementById('ldOnboardStatus').innerHTML = '❌ ' + ldEsc(e.message);
                return;
            }
            if (r.status === 'pending') {
                pollTimer = setTimeout(poll, (r.interval || start.interval || 5) * 1000);
                return;
            }
            if (r.status === 'error') {
                document.getElementById('ldOnboardStatus').innerHTML = '❌ ' + ldEsc(r.error);
                return;
            }
            const su = r.setup || {};
            const item = (ok, label) => '<span class="ld-badge ' + (ok ? 'ok' : 'warn') + '">' + (ok ? '✓' : '⚠') + ' ' + label + '</span>';
            const warn = (r.warnings && r.warnings.length)
                ? '<div style="margin-top:0.4rem;">' + r.warnings.map(w => '⚠️ ' + ldEsc(w)).join('<br>') + '</div>' : '';
            document.getElementById('ldOnboardStatus').innerHTML =
                '✅ <strong>' + ldEsc(r.tenant.name) + '</strong> ist onboardet.' +
                '<div class="ld-setup-list">' +
                item(su.app, 'App-Registrierung') + item(su.consent, 'Admin-Consent') +
                item(su.exoRole, 'Exchange-Admin-Rolle') + item(su.sccRole, 'Compliance-Rolle') +
                item(su.tcm, 'TCM (Alert-Prüfung)') + item(su.cert, 'Zertifikat') +
                '</div>' + warn +
                '<small>💡 Frische App-Registrierungen brauchen ein paar Minuten Replikationszeit — erst mit „Test" prüfen, dann deployen.</small>';
            await loadTenants();
        };
        pollTimer = setTimeout(poll, (start.interval || 5) * 1000);
    });

    // Cleanup fuer die Svelte-Komponente (onDestroy).
    return function teardown() {
        try { _ldUnsub(); } catch (e) {}
        if (pollTimer) { clearTimeout(pollTimer); clearInterval(pollTimer); }
        if (jobTimer) { clearTimeout(jobTimer); clearInterval(jobTimer); }
    };
}
