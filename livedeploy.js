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

function initializeLiveDeploy() {
    const tab = document.getElementById('livedeploy');
    if (!tab) return;

    const elOffline = document.getElementById('ldOffline');
    const elLogin = document.getElementById('ldLogin');
    const elMain = document.getElementById('ldMain');
    const elLog = document.getElementById('ldLog');

    let deployRunning = false;
    let pollTimer = null;   // Onboarding-Poll
    let jobTimer = null;    // Deploy-Job-Poll

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

    // ---------- Login ----------
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
    document.getElementById('ldPass').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('ldLoginBtn').click();
    });
    document.getElementById('ldLogoutBtn').addEventListener('click', async () => {
        try { await ldApi('/api/logout', { method: 'POST' }); } catch (e) { /* egal */ }
        await refreshState();
    });

    // ---------- Tenants ----------
    async function loadTenants() {
        const box = document.getElementById('ldTenants');
        let tenants = [];
        try { tenants = await ldApi('/api/tenants'); } catch (e) { box.innerHTML = '<em>' + ldEsc(e.message) + '</em>'; return; }
        if (!tenants.length) { box.innerHTML = '<em>Noch keine Tenants onboardet — unten den ersten Tenant hinzufügen.</em>'; return; }
        box.innerHTML = tenants.map(t => {
            const ready = t.certPresent && t.exoRole && t.sccRole;
            const missing = [
                t.certPresent ? null : 'Zertifikat',
                t.exoRole ? null : 'Exchange-Rolle',
                t.sccRole ? null : 'Compliance-Rolle'
            ].filter(Boolean);
            const badge = ready
                ? '<span class="ld-badge ok">✓ bereit</span>'
                : '<span class="ld-badge warn" title="' + ldEsc(missing.join(', ') + ' fehlt — Tenant neu onboarden') + '">⚠ ' + ldEsc(missing.join(', ')) + ' fehlt</span>';
            return `
            <div class="ld-tenant" data-id="${ldEsc(t.id)}">
                <div class="ld-tenant-info">
                    <strong>${ldEsc(t.name)} ${badge}</strong>
                    <small>${ldEsc(t.organization || t.tenantId)} · App ${ldEsc((t.appId || '').slice(0, 8))}…</small>
                </div>
                <div class="ld-tenant-actions">
                    <button class="btn btn-secondary" data-action="test">Test</button>
                    <button class="btn btn-primary" data-action="deploy">Deploy</button>
                    <button class="btn btn-secondary" data-action="remove" title="Tenant aus dem Tool entfernen">✕</button>
                </div>
            </div>`;
        }).join('');
    }

    document.getElementById('ldTenants').addEventListener('click', async (e) => {
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

        if (action === 'deploy') {
            if (deployRunning) { alert('Es läuft bereits ein Deploy — bitte warten.'); return; }
            showDeployConfirm(id, name);
            return;
        }
    });

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
            banner = '<div class="ld-banner ok">✅ Fertig — alle ' + total + ' Schritte erfolgreich (' + ldElapsed(job.startedAt, job.finishedAt) + ').</div>';
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
                item(su.exoRole, 'Exchange-Admin-Rolle') + item(su.sccRole, 'Compliance-Rolle') + item(su.cert, 'Zertifikat') +
                '</div>' + warn +
                '<small>💡 Frische App-Registrierungen brauchen ein paar Minuten Replikationszeit — erst mit „Test" prüfen, dann deployen.</small>';
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
