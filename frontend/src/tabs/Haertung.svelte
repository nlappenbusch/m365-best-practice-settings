<script>
  // Tenant-Härtung — die Punkte der Onboarding-Checkliste, die bisher
  // Handarbeit im Portal waren (Kap. 9.8 der Wissensbasis).
  //
  // Vier Quellen, eine Seite:
  //   1. /policies/authorizationPolicy   — Standardberechtigungen, Gastrechte
  //   2. /policies/deviceRegistrationPolicy — wer Geräte joinen darf, lokale Admins
  //   3. Intune-Registrierungseinschränkungen — private Geräte
  //   4. Intune LocalUsersAndGroups — befristete lokale Admins der Einführung
  //
  // Warum 2 und 3 nebeneinander stehen: Der Entra-Schalter regelt den
  // Entra-Join, die Intune-Einschränkung die MDM-Einschreibung. Wer nur eines
  // setzt, lässt die andere Tür offen.
  //
  // Jede schreibende Aktion fragt vorher nach und nennt den Tenant beim Namen.
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let hard = $state(null)        // authorizationPolicy
  let score = $state(null)
  let hardError = $state(null)

  let dev = $state(null)         // deviceRegistrationPolicy
  let devError = $state(null)

  let enroll = $state(null)      // Intune-Registrierungseinschränkungen
  let enrollError = $state(null)

  let la = $state(null)          // lokale Admins Einführungsphase
  let laError = $state(null)

  let groups = $state([])
  let deviceGroupIds = $state([])

  let busy = $state(false)
  let loading = $state(false)
  let notice = $state(null)

  // Formularzustand der Einführungsphase
  let laProfileName = $state('Einfuehrung')
  let laEnddatum = $state('')
  let laSelGroups = $state({})
  let joinGroupId = $state('')

  const laSelected = $derived(Object.keys(laSelGroups).filter(g => laSelGroups[g]))
  const devGroups = $derived(groups.filter(g => deviceGroupIds.includes(g.id)))

  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if ($activeTab !== 'haertung') return
    if (!$session.loggedIn || !t) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    hard = null; dev = null; enroll = null; la = null
    laSelGroups = {}
    load()
  })

  async function load() {
    loading = true
    notice = null
    const id = encodeURIComponent($activeTenant.id)

    // Bewusst einzeln abgefangen: Fehlt eine Berechtigung, soll der Rest der
    // Seite trotzdem nutzbar bleiben und nur der betroffene Block das sagen.
    const [h, d, e, l, g, dyn] = await Promise.all([
      apiGet(`/api/tenants/${id}/hardening`).catch(err => ({ __err: err.message })),
      apiGet(`/api/tenants/${id}/entra/devicesettings`).catch(err => ({ __err: err.message })),
      apiGet(`/api/tenants/${id}/enrollmentrestrictions`).catch(err => ({ __err: err.message })),
      apiGet(`/api/tenants/${id}/localadmins`).catch(err => ({ __err: err.message })),
      apiGet(`/api/tenants/${id}/groups`).catch(() => ({ groups: [] })),
      apiPost('/api/grouptags/groups', { tenantId: $activeTenant.id }).catch(() => ({ groups: [] }))
    ])

    hardError = h.__err || null; hard = h.__err ? null : h.settings; score = h.__err ? null : h.score
    devError = d.__err || null; dev = d.__err ? null : d.settings
    enrollError = e.__err || null; enroll = e.__err ? null : e.items
    laError = l.__err || null; la = l.__err ? null : l
    groups = Array.isArray(g?.groups) ? g.groups : []
    deviceGroupIds = (Array.isArray(dyn?.groups) ? dyn.groups : []).filter(x => (x.tags || []).length).map(x => x.id)
    loading = false
  }

  function tenantName() { return $activeTenant ? $activeTenant.name : '' }

  async function run(fn, erfolg) {
    busy = true
    notice = null
    try {
      const r = await fn()
      notice = r && r.changed === false ? 'Stand war schon so — nichts geschrieben.' : erfolg
      await load()
    } catch (e) {
      notice = '❌ ' + e.message
    }
    busy = false
  }

  // ---------- Standardberechtigungen ----------
  function toggleSwitch(s) {
    const want = !s.ist
    if (!confirm(`„${s.label}" im Tenant ${tenantName()} auf ${want ? 'EIN' : 'AUS'} setzen?\n\n`
      + `Portal: ${s.portal}\n\n${s.warum}`)) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/hardening/switch`, { key: s.key, value: want }),
      `✅ „${s.label}" steht jetzt auf ${want ? 'ein' : 'aus'}.`)
  }

  function setGuestRole(key) {
    const opt = hard.guest.optionen.find(o => o.key === key)
    if (!opt || key === hard.guest.roleKey) return
    if (!confirm(`Gastzugriff im Tenant ${tenantName()} auf „${opt.label}" setzen?\n\n${opt.hint}`)) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/hardening/guestrole`, { role: key }),
      `✅ Gastzugriff steht jetzt auf „${opt.label}".`)
  }

  function setInvites(key) {
    const opt = hard.invites.optionen.find(o => o.key === key)
    if (!opt || key === hard.invites.value) return
    if (!confirm(`Einladungen im Tenant ${tenantName()} auf „${opt.label}" setzen?\n\n${opt.hint}\n\n`
      + 'Dem Kunden die Auswirkung auf die Zusammenarbeit mit Dritten bewusst machen.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/hardening/invites`, { value: key }),
      `✅ Einladungen stehen jetzt auf „${opt.label}".`)
  }

  function applyDefaults() {
    const offen = [
      ...hard.switches.filter(s => !s.kritisch && s.konform === false).map(s => s.label),
      ...(hard.guest.konform ? [] : ['Gastzugriff auf die restriktivste Stufe']),
      ...(hard.invites.konform ? [] : ['Einladungen nur durch Administratoren und Gasteinlader'])
    ]
    if (!offen.length) { notice = 'Alles steht schon auf dem Managed-Default.'; return }
    if (!confirm(`Im Tenant ${tenantName()} auf den Managed-Default ziehen:\n\n• ${offen.join('\n• ')}\n\n`
      + 'Das sind tenantweite Einstellungen. Vor allem die Gast- und Einladungspunkte ändern, '
      + 'wie der Kunde mit Externen zusammenarbeitet — vorher abstimmen.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/hardening/defaults`, {}),
      '✅ Managed-Default angewendet.')
  }

  // ---------- Geräte-Beitritt ----------
  function setJoin(mode) {
    const txt = { all: 'Alle Benutzer', none: 'Niemand', selected: 'Ausgewählte' }[mode]
    if (mode === 'selected' && !joinGroupId) { notice = '❌ Für „Ausgewählte" zuerst eine Gruppe wählen.'; return }
    const grp = groups.find(g => g.id === joinGroupId)
    if (!confirm(`Wer darf Geräte per Entra-Join in ${tenantName()} bringen?\n\nNeu: ${txt}`
      + (mode === 'selected' ? ` (${grp ? grp.displayName : joinGroupId})` : '')
      + '\n\nIm Managed-Setup kommen Geräte über Autopilot. Ab Werk darf jeder Benutzer bis zu 20 Geräte '
      + 'selbst joinen — so landen private Geräte im Tenant, sobald sich jemand mit Firmen-Anmeldedaten anmeldet.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/entra/devicesettings/join`,
      { mode, groupIds: mode === 'selected' ? [joinGroupId] : [] }), `✅ Beitritt steht jetzt auf „${txt}".`)
  }

  function setGlobalAdmins(value) {
    if (!confirm(`Globale Administratoren beim Entra-Join lokale Administratoren?\n\nTenant: ${tenantName()}\nNeu: ${value ? 'Ja' : 'Nein'}\n\n`
      + 'Managed-Default ist Nein — globale Administratoren haben auf Endgeräten nichts verloren (Tier-Trennung).')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/entra/devicesettings/localadmins`, { globalAdmins: value }),
      `✅ Globale Administratoren als lokale Admins: ${value ? 'ja' : 'nein'}.`)
  }

  function setRegisteringUsers(mode) {
    if (!confirm(`Wird der registrierende Benutzer beim Join lokaler Administrator?\n\nTenant: ${tenantName()}\n`
      + `Neu: ${mode === 'none' ? 'Niemand' : 'Alle'}\n\nManaged-Default ist Niemand — Benutzer bleiben Standardbenutzer. `
      + 'Lokale Rechte laufen über LAPS und, befristet, über die Ausnahme weiter unten.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/entra/devicesettings/localadmins`, { registeringUsers: mode }),
      '✅ Lokale Administratoren beim Join angepasst.')
  }

  let quotaInput = $state('')
  function setQuota() {
    const n = Number(quotaInput)
    if (!Number.isInteger(n) || n < 0 || n > 20) { notice = '❌ Kontingent muss zwischen 0 und 20 liegen.'; return }
    if (!confirm(`Gerätekontingent je Benutzer in ${tenantName()} auf ${n} setzen?\n\n`
      + 'Microsofts Vorgabe ist 20. Im Managed-Setup mit Autopilot braucht ein Benutzer keines, '
      + 'weil nicht er das Gerät einbringt.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/entra/devicesettings/quota`, { quota: n }),
      `✅ Gerätekontingent steht jetzt auf ${n}.`)
  }

  // ---------- Registrierungseinschränkungen ----------
  function togglePersonal(item) {
    const want = !item.personalDeviceEnrollmentBlocked
    if (!confirm(`Private Geräte in „${item.displayName}" ${want ? 'SPERREN' : 'ERLAUBEN'}?\n\nTenant: ${tenantName()}\n\n`
      + 'Das ist die Intune-Seite: Sie regelt die MDM-Einschreibung, der Entra-Schalter darüber den Entra-Join. '
      + 'Beide gehören gesetzt.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/enrollmentrestrictions/${encodeURIComponent(item.id)}/personal`, { blocked: want }),
      `✅ Private Geräte sind jetzt ${want ? 'gesperrt' : 'erlaubt'}.`)
  }

  // ---------- Lokale Admins: Einführungsphase ----------
  function ensureLaGroup() {
    if (!confirm(`Rollengruppe „${la.vorgeschlagenerName}" im Tenant ${tenantName()} anlegen?\n\n`
      + 'Ihre Mitglieder sind während der Einführungsphase lokale Administratoren auf den zugewiesenen Geräten. '
      + 'Die Gruppe wird leer angelegt.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/localadmins/group`, {}),
      '✅ Rollengruppe steht bereit — Mitglieder im Entra-Portal eintragen.')
  }

  function deployLa() {
    if (!la?.group) { notice = '❌ Zuerst die Rollengruppe anlegen.'; return }
    if (!laSelected.length) { notice = '❌ Mindestens eine Gerätegruppe wählen.'; return }
    if (!laEnddatum) { notice = '❌ Enddatum angeben — ohne Ende wird aus der Ausnahme der Dauerzustand.'; return }
    const namen = groups.filter(g => laSelected.includes(g.id)).map(g => g.displayName)
    if (!confirm(`Befristete lokale Administratoren in ${tenantName()} ausrollen?\n\n`
      + `Gruppe: ${la.group.displayName}\nGeräte: ${namen.join(', ')}\nBefristet bis: ${laEnddatum}\n\n`
      + 'Preis der Ausnahme: Ein lokaler Administrator kann Sicherheitsagenten abschalten '
      + '(Bitdefender-Tamper-Protection, RMM-Dienst) und Teile der Baseline lokal aushebeln. '
      + 'Nicht auf Geräte legen, die schon im Regelbetrieb mit Kundendaten sind.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/localadmins/deploy`, {
      profileName: laProfileName, groupId: la.group.id, deviceGroupIds: laSelected, enddatum: laEnddatum
    }), '✅ Ausnahme ausgerollt — Rückbau ist Teil der Abnahme.')
  }

  function removeLa(p) {
    if (!confirm(`Profil „${p.displayName}" in ${tenantName()} löschen?\n\n`
      + 'Damit endet die Ausnahme: Auf den zugewiesenen Geräten bleiben nur die regulären lokalen Administratoren. '
      + 'Danach die Gruppe leeren — beides gehört zum Rückbau.')) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/localadmins/remove`, { profileId: p.id }),
      '✅ Profil entfernt.')
  }

  function clearLaGroup() {
    if (!la?.group) return
    if (!confirm(`Alle ${la.members.length} Mitglieder aus „${la.group.displayName}" entfernen?\n\nTenant: ${tenantName()}`)) return
    run(() => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/localadmins/cleargroup`, { groupId: la.group.id }),
      '✅ Gruppe geleert.')
  }

  /** Enddatum aus der Profilbeschreibung ziehen — dort steht es im Klartext. */
  function endeAus(beschreibung) {
    const m = String(beschreibung || '').match(/bis (\d{2}\.\d{2}\.\d{4})/)
    return m ? m[1] : null
  }

  function abgelaufen(beschreibung) {
    const d = endeAus(beschreibung)
    if (!d) return false
    const [tag, monat, jahr] = d.split('.')
    return new Date(`${jahr}-${monat}-${tag}T23:59:59`) < new Date()
  }

  // Punkte, die es nicht per API gibt. Sie stehen hier, damit die Checkliste
  // vollständig ist — nicht, damit sie jemand übersieht.
  const MANUELL = [
    { titel: 'Remediations freischalten',
      portal: 'Intune > Mandantenadministration > Connectors und Token > Windows-Daten',
      text: 'Schalter „Ich bestätige, dass mein Mandant eine dieser Lizenzen besitzt" auf Ein (Vorgabe: Aus). Ohne ihn laufen Wartungen nicht — anlegen lassen sie sich trotzdem.' },
    { titel: 'Zugriff aufs Entra Admin Center einschränken',
      portal: 'Entra ID > Benutzer > Benutzereinstellungen',
      text: 'Nur Administratoren und IT-Koordinatoren. Für diesen Schalter gibt es keine saubere API.' },
    { titel: 'LinkedIn-Kontoverbindungen',
      portal: 'Entra ID > Benutzer > Benutzereinstellungen',
      text: 'Im Zweifel aus — Compliance und Datenschutz bewerten.' },
    { titel: 'Office-Selbstinstallation abschalten',
      portal: 'M365 Admin Center > Einstellungen > Dienste > Software-Download',
      text: 'Die Apps kommen über Intune (Tab Intune, Abschnitt Microsoft 365 Apps). Der Schalter selbst hat keine öffentliche API.' },
    { titel: 'Cross-Tenant-Zugriff auf Partnerdomänen begrenzen',
      portal: 'Entra ID > Externe Identitäten > Einstellungen für den Zugriff zwischen Mandanten',
      text: '„Einladungen nur für angegebene Domänen zulassen" — Partnerdomänen bewusst freischalten, mit dem Kunden abstimmen.' }
  ]
</script>

<TenantContext>
  <div class="ld-wrap">
    <p class="ld-section-hint">
      Die Grundeinstellungen, die bei jedem Managed-Tenant vor dem Regelbetrieb gesetzt werden — sie verhindern
      Shadow-IT, unkontrollierte Identitäten und ungeplante Geräte im Tenant. Alles hier wirkt <strong>tenantweit</strong>.
    </p>

    {#if notice}<div class="ld-banner {notice.startsWith('❌') ? 'warn' : 'ok'}"><div><b>{notice}</b></div></div>{/if}
    {#if loading}<p class="ld-section-hint"><span class="ld-spinner"></span> Lade…</p>{/if}

    <!-- 1: Standardberechtigungen -->
    <section class="hd-card">
      <div class="hd-head">
        <h4>Standardberechtigungen des Verzeichnisses</h4>
        {#if score}
          <span class="hd-score" class:ok={score.konform === score.gesamt}>{score.konform} / {score.gesamt} auf Sollwert</span>
        {/if}
      </div>

      {#if hardError}
        <div class="alert alert-warning">❌ {hardError}</div>
      {:else if hard}
        <table class="hd-table">
          <thead><tr><th>Einstellung</th><th>Ist</th><th>Soll</th><th></th></tr></thead>
          <tbody>
            {#each hard.switches as s (s.key)}
              <tr class:hd-krit={s.kritisch}>
                <td>
                  <b>{s.label}</b>
                  <div class="hd-why">{s.warum}</div>
                  <div class="hd-portal">{s.portal}</div>
                </td>
                <td>{s.ist === null ? '—' : (s.ist ? 'ein' : 'aus')}</td>
                <td>{s.soll ? 'ein' : 'aus'}</td>
                <td>
                  {#if s.kritisch}
                    <span class="hd-lock" title="Wird vom Tool bewusst nicht umgeschaltet">gesperrt</span>
                  {:else if s.konform}
                    <span class="hd-ok">✓</span>
                  {:else}
                    <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => toggleSwitch(s)}>
                      auf {s.soll ? 'ein' : 'aus'}
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        <div class="hd-grid2">
          <div>
            <label class="hd-label" for="hd-guest">Gastzugriff</label>
            <select id="hd-guest" class="hd-select" disabled={busy}
                    value={hard.guest.roleKey || ''} onchange={(e) => setGuestRole(e.currentTarget.value)}>
              {#if !hard.guest.roleKey}<option value="">{hard.guest.label}</option>{/if}
              {#each hard.guest.optionen as o (o.key)}
                <option value={o.key}>{o.label}{o.soll ? ' — Soll' : ''}</option>
              {/each}
            </select>
            <div class="hd-why">{hard.guest.optionen.find(o => o.key === hard.guest.roleKey)?.hint || 'Aktuelle Rolle ist keine der drei eingebauten.'}</div>
          </div>
          <div>
            <label class="hd-label" for="hd-inv">Wer darf Gäste einladen</label>
            <select id="hd-inv" class="hd-select" disabled={busy}
                    value={hard.invites.value || ''} onchange={(e) => setInvites(e.currentTarget.value)}>
              {#if !hard.invites.value}<option value="">—</option>{/if}
              {#each hard.invites.optionen as o (o.key)}
                <option value={o.key}>{o.label}{o.soll ? ' — Soll' : ''}</option>
              {/each}
            </select>
            <div class="hd-why">{hard.invites.optionen.find(o => o.key === hard.invites.value)?.hint || ''}</div>
          </div>
        </div>

        <div class="hd-actions">
          <button class="btn btn-primary" disabled={busy} onclick={applyDefaults}>Alles auf Managed-Default</button>
          <span class="hd-why">Ein einziger Schreibvorgang. Was schon stimmt, bleibt unangetastet.</span>
        </div>
      {/if}
    </section>

    <!-- 2: Geräte-Beitritt -->
    <section class="hd-card">
      <div class="hd-head"><h4>Geräte-Beitritt und lokale Administratoren (Entra)</h4></div>
      {#if devError}
        <div class="alert alert-warning">❌ {devError}</div>
      {:else if dev}
        <div class="hd-rows">
          <div class="hd-row">
            <div>
              <b>Wer darf Geräte joinen</b>
              <div class="hd-why">Aktuell: {dev.joinAllowed}. Im Managed-Setup kommen Geräte über Autopilot — „Niemand" oder eine benannte Koordinatoren-Gruppe.</div>
            </div>
            <div class="hd-row-act">
              <select class="hd-select hd-select-sm" bind:value={joinGroupId} disabled={busy}>
                <option value="">— Gruppe für „Ausgewählte" —</option>
                {#each groups as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
              </select>
              <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => setJoin('none')}>Niemand</button>
              <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => setJoin('selected')}>Ausgewählte</button>
              <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => setJoin('all')}>Alle</button>
            </div>
          </div>

          <div class="hd-row">
            <div>
              <b>Globale Administratoren werden lokale Admins</b>
              <div class="hd-why">Aktuell: {dev.localAdminsGlobalAdmins ? 'ja' : 'nein'}. Managed-Default ist nein — Tier-Trennung.</div>
            </div>
            <div class="hd-row-act">
              {#if dev.localAdminsGlobalAdmins}
                <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => setGlobalAdmins(false)}>auf nein</button>
              {:else}<span class="hd-ok">✓</span>{/if}
            </div>
          </div>

          <div class="hd-row">
            <div>
              <b>Registrierender Benutzer wird lokaler Admin</b>
              <div class="hd-why">Aktuell: {dev.localAdminsRegisteringUsers}. Managed-Default ist „Niemand" — Benutzer bleiben Standardbenutzer.</div>
            </div>
            <div class="hd-row-act">
              {#if /niemand/i.test(dev.localAdminsRegisteringUsers)}
                <span class="hd-ok">✓</span>
              {:else}
                <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => setRegisteringUsers('none')}>auf Niemand</button>
              {/if}
            </div>
          </div>

          <div class="hd-row">
            <div>
              <b>Gerätekontingent je Benutzer</b>
              <div class="hd-why">Aktuell: {dev.userDeviceQuota ?? '—'}. Microsofts Vorgabe ist 20.</div>
            </div>
            <div class="hd-row-act">
              <input class="hd-num" type="number" min="0" max="20" bind:value={quotaInput} placeholder={String(dev.userDeviceQuota ?? '')} />
              <button class="btn btn-secondary hd-btn" disabled={busy || quotaInput === ''} onclick={setQuota}>setzen</button>
            </div>
          </div>

          <div class="hd-row">
            <div>
              <b>Windows LAPS</b>
              <div class="hd-why">
                Aktuell: {dev.lapsEnabled ? 'aktiv' : 'nicht aktiv'}.
                Der Schalter sitzt im Tab <button class="hd-link" onclick={() => activeTab.set('intune')}>Intune</button>,
                direkt bei der LAPS-Policy — dort steht er im richtigen Zusammenhang.
              </div>
            </div>
            <div class="hd-row-act">{#if dev.lapsEnabled}<span class="hd-ok">✓</span>{:else}<span class="hd-warn">fehlt</span>{/if}</div>
          </div>
        </div>
      {/if}
    </section>

    <!-- 3: Registrierungseinschränkungen -->
    <section class="hd-card">
      <div class="hd-head"><h4>Registrierungseinschränkungen (Intune)</h4></div>
      <p class="hd-why" style="margin-top:0">
        Der Entra-Schalter oben regelt den Entra-Join, diese Einschränkung die MDM-Einschreibung.
        Wer nur eines setzt, lässt die andere Tür offen.
      </p>
      {#if enrollError}
        <div class="alert alert-warning">❌ {enrollError}</div>
      {:else if enroll}
        {#if !enroll.length}
          <p class="ld-section-hint">Keine Windows-Registrierungseinschränkung gefunden.</p>
        {:else}
          <table class="hd-table">
            <thead><tr><th>Richtlinie</th><th>Private Geräte</th><th></th></tr></thead>
            <tbody>
              {#each enroll as item (item.id)}
                <tr>
                  <td>
                    <b>{item.displayName}</b>
                    {#if item.istStandard}<span class="hd-tag">Standard</span>{/if}
                    {#if item.osMinimumVersion}<div class="hd-why">Mindest-OS: {item.osMinimumVersion}</div>{/if}
                  </td>
                  <td>{item.personalDeviceEnrollmentBlocked ? 'gesperrt' : 'erlaubt'}</td>
                  <td>
                    {#if item.personalDeviceEnrollmentBlocked}
                      <span class="hd-ok">✓</span>
                    {:else}
                      <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => togglePersonal(item)}>sperren</button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/if}
    </section>

    <!-- 4: Lokale Admins der Einführungsphase -->
    <section class="hd-card">
      <div class="hd-head"><h4>Lokale Administratoren für die Einführungsphase</h4></div>
      <p class="hd-why" style="margin-top:0">
        Zielbild bleibt: keine zusätzlichen lokalen Administratoren. Während des Aufbaus ist das nicht durchhaltbar —
        wer für jede Nacharbeit das LAPS-Kennwort abtippt, sorgt dafür, dass genau dieses Kennwort notiert und
        weitergegeben wird. Deshalb eine benannte, befristete Ausnahme über Intune statt über den tenantweiten
        Entra-Schalter, der sich nicht auf eine Gerätegruppe eingrenzen liesse.
      </p>

      {#if laError}
        <div class="alert alert-warning">❌ {laError}</div>
      {:else if la}
        {#if la.profiles.length}
          <div class="hd-rows">
            {#each la.profiles as p (p.id)}
              <div class="hd-row">
                <div>
                  <b>{p.displayName}</b>
                  <div class="hd-why">
                    {#if endeAus(p.description)}
                      Befristet bis {endeAus(p.description)}
                      {#if abgelaufen(p.description)}<span class="hd-warn"> — abgelaufen, Rückbau fällig</span>{/if}
                    {:else}
                      Kein Enddatum in der Beschreibung gefunden.
                    {/if}
                    · {p.gruppenIds.length} Gerätegruppe(n)
                  </div>
                </div>
                <div class="hd-row-act">
                  <button class="btn btn-secondary hd-btn" disabled={busy} onclick={() => removeLa(p)}>Rückbau</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <div class="hd-la">
          <div class="hd-la-group">
            {#if la.group}
              <div>
                <b>Rollengruppe:</b> <code>{la.group.displayName}</code>
                <div class="hd-why">
                  {la.members.length
                    ? `${la.members.length} Mitglied(er): ${la.members.map(m => m.displayName || m.upn).join(', ')}`
                    : 'Leer — Mitglieder im Entra-Portal eintragen. Solange sie leer ist, wirkt die Ausnahme auf niemanden.'}
                </div>
              </div>
              {#if la.members.length}
                <button class="btn btn-secondary hd-btn" disabled={busy} onclick={clearLaGroup}>Gruppe leeren</button>
              {/if}
            {:else}
              <div>
                <b>Rollengruppe fehlt</b>
                <div class="hd-why">Wird als <code>{la.vorgeschlagenerName}</code> leer angelegt.</div>
              </div>
              <button class="btn btn-secondary hd-btn" disabled={busy} onclick={ensureLaGroup}>Gruppe anlegen</button>
            {/if}
          </div>

          <div class="hd-la-form">
            <div class="input-group" style="max-width:200px; margin:0">
              <label for="la-name">Profilname</label>
              <input id="la-name" type="text" bind:value={laProfileName} />
            </div>
            <div class="input-group" style="max-width:200px; margin:0">
              <label for="la-ende">Befristet bis <small>(Pflicht)</small></label>
              <input id="la-ende" type="date" bind:value={laEnddatum} />
            </div>
          </div>

          <div class="hd-la-groups">
            <div class="hd-label">Gerätegruppen der Einführungsphase</div>
            {#if devGroups.length}
              <div class="hd-glist">
                {#each devGroups as g (g.id)}
                  <label class="hd-g" class:sel={laSelGroups[g.id]}>
                    <input type="checkbox" bind:checked={laSelGroups[g.id]} />
                    <span>{g.displayName}</span>
                  </label>
                {/each}
              </div>
            {:else}
              <p class="ld-section-hint">Keine dynamische Gerätegruppe gefunden — im Tab <strong>GroupTags</strong> zuerst eine anlegen.</p>
            {/if}
          </div>

          <button class="btn btn-primary" disabled={busy || !la.group || !laSelected.length || !laEnddatum} onclick={deployLa}>
            Ausnahme ausrollen
          </button>
        </div>
      {/if}
    </section>

    <!-- 5: Was manuell bleibt -->
    <section class="hd-card">
      <div class="hd-head"><h4>Bleibt Handarbeit im Portal</h4></div>
      <p class="hd-why" style="margin-top:0">Für diese Punkte gibt es keine brauchbare Schnittstelle. Sie stehen hier, damit die Checkliste vollständig ist.</p>
      <div class="hd-rows">
        {#each MANUELL as m (m.titel)}
          <div class="hd-row">
            <div>
              <b>{m.titel}</b>
              <div class="hd-why">{m.text}</div>
              <div class="hd-portal">{m.portal}</div>
            </div>
          </div>
        {/each}
      </div>
    </section>
  </div>
</TenantContext>
