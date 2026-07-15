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

function initializeLiveDeploy() {
    const tab = document.getElementById('livedeploy');
    if (!tab) return;

    const elOffline = document.getElementById('ldOffline');
    const elLogin = document.getElementById('ldLogin');
    const elMain = document.getElementById('ldMain');
    const elLog = document.getElementById('ldLog');

    function show(el, visible) { el.style.display = visible ? '' : 'none'; }
    function log(html) { elLog.innerHTML = html; }

    async function refreshState() {
        try {
            const h = await ldApi('/api/health');
            show(elOffline, false);
            show(elLogin, !h.loggedIn);
            show(elMain, !!h.loggedIn);
            if (h.loggedIn) await loadTenants();
            if (h.pwsh && h.pwsh.checked && !h.pwsh.ok) {
                show(elOffline, true);
                elOffline.innerHTML = '<strong>⚠️ pwsh fehlt im Backend-Container.</strong> Deploys werden fehlschlagen — Container-Image prüfen.';
            }
        } catch (e) {
            show(elOffline, true);
            show(elLogin, false);
            show(elMain, false);
        }
    }

    // Login
    document.getElementById('ldLoginBtn').addEventListener('click', async () => {
        const errBox = document.getElementById('ldLoginError');
        show(errBox, false);
        try {
            await ldApi('/api/login', {
                method: 'POST',
                body: { username: document.getElementById('ldUser').value, password: document.getElementById('ldPass').value }
            });
            document.getElementById('ldPass').value = '';
            await refreshState();
        } catch (e) {
            errBox.textContent = e.message;
            show(errBox, true);
        }
    });
    document.getElementById('ldLogoutBtn').addEventListener('click', async () => {
        try { await ldApi('/api/logout', { method: 'POST' }); } catch (e) { /* egal */ }
        await refreshState();
    });

    // Tenants
    async function loadTenants() {
        const box = document.getElementById('ldTenants');
        let tenants = [];
        try { tenants = await ldApi('/api/tenants'); } catch (e) { box.innerHTML = '<em>' + ldEsc(e.message) + '</em>'; return; }
        if (!tenants.length) { box.innerHTML = '<em>Noch keine Tenants onboardet.</em>'; return; }
        box.innerHTML = tenants.map(t => `
            <div class="ld-tenant" data-id="${ldEsc(t.id)}">
                <div class="ld-tenant-info">
                    <strong>${ldEsc(t.name)}</strong>
                    <small>${ldEsc(t.organization || t.tenantId)} · App ${ldEsc((t.appId || '').slice(0, 8))}…
                        ${t.certPresent ? '· 🔑 Cert' : '· <span class="ld-warn">Cert fehlt</span>'}
                        ${t.exoRole ? '' : '· <span class="ld-warn">EXO-Rolle fehlt</span>'}
                        ${t.sccRole ? '' : '· <span class="ld-warn">Compliance-Rolle fehlt (Alert Policy) — neu onboarden</span>'}</small>
                </div>
                <div class="ld-tenant-actions">
                    <button class="btn btn-secondary" data-action="test">Test</button>
                    <button class="btn btn-primary" data-action="deploy">Deploy</button>
                    <button class="btn btn-secondary" data-action="remove" title="Tenant aus dem Tool entfernen">✕</button>
                </div>
            </div>`).join('');
    }

    document.getElementById('ldTenants').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const row = btn.closest('.ld-tenant');
        const id = row.dataset.id;
        const name = row.querySelector('strong').textContent;
        const action = btn.dataset.action;

        if (action === 'remove') {
            if (!confirm('Tenant "' + name + '" aus dem Tool entfernen? (Die App-Registrierung im Tenant bleibt bestehen.)')) return;
            try { await ldApi('/api/tenants/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (err) { alert(err.message); }
            await loadTenants();
            return;
        }

        if (action === 'test') {
            btn.disabled = true; btn.textContent = '…';
            log('⏳ Verbindungstest zu <strong>' + ldEsc(name) + '</strong> läuft…');
            try {
                const r = await ldApi('/api/tenants/' + encodeURIComponent(id) + '/test', { method: 'POST' });
                log('✅ Verbindung OK. Accepted Domains: ' + (r.domains || []).map(ldEsc).join(', '));
            } catch (err) {
                log('❌ ' + ldEsc(err.message) + (err.hint ? '<br><small>' + ldEsc(err.hint) + '</small>' : ''));
            }
            btn.disabled = false; btn.textContent = 'Test';
            return;
        }

        if (action === 'deploy') {
            const autoDomains = !!(document.getElementById('ldAutoDomains') && document.getElementById('ldAutoDomains').checked);
            const domains = [...config.global.domains, config.global.onmicrosoftDomain].filter(Boolean);
            const domainInfo = autoDomains
                ? 'automatisch aus dem Tenant (Get-AcceptedDomain)'
                : domains.join(', ') + '  (aus dem Konfigurations-Tab!)';
            if (!confirm('Aktuelle Konfiguration jetzt in "' + name + '" deployen?\n\nDomains: ' + domainInfo +
                '\n\nEs werden die BP_-Policies (Quarantine, Anti-Phishing, Anti-Spam, Anti-Malware) und die Alert Policy für Quarantine-Release-Anfragen gesetzt bzw. aktualisiert.')) return;
            btn.disabled = true; btn.textContent = '…';
            log('⏳ Deploy nach <strong>' + ldEsc(name) + '</strong> läuft — das kann einige Minuten dauern…');
            try {
                const r = await ldApi('/api/tenants/' + encodeURIComponent(id) + '/deploy', { method: 'POST', body: { config, autoDomains } });
                const steps = (r.result && r.result.steps) || [];
                const rows = steps.map(s => s.ok
                    ? '<div class="ld-step ok">✅ ' + ldEsc(s.name) + ' <small>(' + ldEsc(s.action) + (s.tries > 1 ? ', ' + s.tries + '. Versuch' : '') + ')</small></div>'
                    : '<div class="ld-step fail">❌ ' + ldEsc(s.name) + ' — <small>' + ldEsc(s.error) + '</small></div>'
                ).join('');
                const doms = (r.result && r.result.domains) || [];
                log('<strong>Deploy nach ' + ldEsc(name) + ' abgeschlossen</strong><br><small>Domains: '
                    + doms.map(ldEsc).join(', ') + '</small>' + rows
                    + (r.note ? '<div class="ld-step"><small>ℹ️ ' + ldEsc(r.note) + '</small></div>' : ''));
            } catch (err) {
                log('❌ ' + ldEsc(err.message) + (err.hint ? '<br><small>' + ldEsc(err.hint) + '</small>' : ''));
            }
            btn.disabled = false; btn.textContent = 'Deploy';
            return;
        }
    });

    // Onboarding (Device-Code)
    let pollTimer = null;
    document.getElementById('ldOnboardBtn').addEventListener('click', async () => {
        const box = document.getElementById('ldDeviceCode');
        const tenant = document.getElementById('ldOnboardTenant').value.trim();
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        box.style.display = '';
        box.innerHTML = '⏳ Starte Onboarding…';
        let start;
        try {
            start = await ldApi('/api/onboard/start', { method: 'POST', body: { tenant } });
        } catch (e) {
            box.innerHTML = '❌ ' + ldEsc(e.message);
            return;
        }
        box.innerHTML = 'Anmeldung als <strong>Admin des Ziel-Tenants</strong>:<br>' +
            '1. Öffne <a href="' + ldEsc(start.verificationUri) + '" target="_blank" rel="noopener">' + ldEsc(start.verificationUri) + '</a><br>' +
            '2. Code eingeben: <strong style="font-size:1.3em; letter-spacing:2px;">' + ldEsc(start.userCode) + '</strong><br>' +
            '<span id="ldOnboardStatus">⏳ Warte auf Anmeldung…</span>';

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
            const warn = (r.warnings && r.warnings.length)
                ? '<br>⚠️ ' + r.warnings.map(ldEsc).join('<br>⚠️ ') : '';
            document.getElementById('ldOnboardStatus').innerHTML =
                '✅ Tenant <strong>' + ldEsc(r.tenant.name) + '</strong> onboardet (App ' + ldEsc(r.tenant.appId) + ').' + warn +
                '<br><small>Hinweis: Frische App-Registrierungen brauchen ein paar Minuten Replikationszeit, bevor der erste Deploy klappt.</small>';
            await loadTenants();
        };
        pollTimer = setTimeout(poll, (start.interval || 5) * 1000);
    });

    // Erst prüfen, wenn der Tab geöffnet wird (spart Requests im statischen Betrieb).
    let checked = false;
    document.querySelectorAll('.tab-btn[data-tab="livedeploy"]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (checked) return;
            checked = true;
            refreshState();
        });
    });
}
