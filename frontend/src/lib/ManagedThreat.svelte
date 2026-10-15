<script>
  // Threat Policies im Detail: jede Einstellung mit deutschem Namen, Ist-Wert,
  // Empfehlung und Ampel; dazu die Abweichung von der quittierten Baseline
  // (aus den Drift-Befunden). Empfehlung = Microsoft-Voreinstellung «Standard»
  // (Stand 2026) bzw. igeeks-Baseline, wo sie strenger ist.
  let { data, findings = [], onFinding = null } = $props()

  const yes = v => v === true, no = v => v === false
  const oneOf = (...a) => v => a.map(x => String(x).toLowerCase()).includes(String(v).toLowerCase())
  const max = n => v => v !== null && v !== undefined && Number(v) <= n
  const min = n => v => v !== null && v !== undefined && Number(v) >= n
  const empty = v => !v || (Array.isArray(v) && !v.length)

  // [Feld, deutscher Name, Empfehlung (Text), Pruefung, Erklaerung]
  const SPEC = {
    antiPhish: { label: 'Anti-Phishing', icon: '🎣', fields: [
      ['Enabled', 'Policy aktiv', 'Ein', yes],
      ['PhishThresholdLevel', 'Phishing-Schwellenwert', '2 (aggressiv) oder höher', min(2), '1 = Standard von Microsoft, 2–4 = zunehmend strenger'],
      ['EnableSpoofIntelligence', 'Spoof-Intelligence', 'Ein', yes, 'Erkennt gefälschte Absender'],
      ['HonorDmarcPolicy', 'DMARC-Richtlinie des Absenders befolgen', 'Ein', yes],
      ['AuthenticationFailAction', 'Aktion bei Spoofing', 'Junk oder Quarantäne', oneOf('MoveToJmf', 'Quarantine')],
      ['EnableMailboxIntelligence', 'Postfachintelligenz', 'Ein', yes, 'Lernt die Kontakte des Benutzers'],
      ['EnableMailboxIntelligenceProtection', 'Schutz durch Postfachintelligenz', 'Ein', yes],
      ['MailboxIntelligenceProtectionAction', 'Aktion Postfachintelligenz', 'Junk oder Quarantäne', oneOf('MoveToJmf', 'Quarantine')],
      ['EnableOrganizationDomainsProtection', 'Schutz eigener Domänen (Impersonation)', 'Ein', yes],
      ['EnableTargetedUserProtection', 'Schutz ausgewählter Benutzer (VIP)', 'Ein', yes, 'Geschäftsleitung, Finanzen'],
      ['TargetedUserProtectionAction', 'Aktion Benutzer-Impersonation', 'Quarantäne', oneOf('Quarantine')],
      ['EnableUnauthenticatedSender', 'Fragezeichen bei nicht authentifizierten Absendern', 'Ein', yes],
      ['EnableViaTag', '«via»-Kennzeichnung', 'Ein', yes],
      ['EnableFirstContactSafetyTips', 'Hinweis «Erster Kontakt»', 'Ein', yes]
    ]},
    contentFilter: { label: 'Antispam (eingehend)', icon: '🛡', fields: [
      ['SpamAction', 'Spam', 'Junk-Ordner', oneOf('MoveToJmf', 'Quarantine')],
      ['HighConfidenceSpamAction', 'Spam mit hoher Zuverlässigkeit', 'Quarantäne', oneOf('Quarantine')],
      ['PhishSpamAction', 'Phishing', 'Quarantäne', oneOf('Quarantine')],
      ['HighConfidencePhishAction', 'Phishing mit hoher Zuverlässigkeit', 'Quarantäne', oneOf('Quarantine')],
      ['BulkSpamAction', 'Massenmail', 'Junk-Ordner', oneOf('MoveToJmf', 'Quarantine')],
      ['BulkThreshold', 'Schwellenwert Massenmail (BCL)', '6 oder tiefer', max(6), 'Tiefer = strenger'],
      ['QuarantineRetentionPeriod', 'Aufbewahrung Quarantäne (Tage)', '30', min(30)],
      ['SpamZapEnabled', 'ZAP für Spam', 'Ein', yes, 'Entfernt nachträglich erkannte Mails aus dem Postfach'],
      ['PhishZapEnabled', 'ZAP für Phishing', 'Ein', yes],
      ['InlineSafetyTipsEnabled', 'Sicherheitstipps', 'Ein', yes],
      ['AllowedSenderDomains', 'Pauschal erlaubte Domänen', 'keine', empty, 'Umgehen den Filter komplett'],
      ['AllowedSenders', 'Pauschal erlaubte Absender', 'keine', empty],
      ['BlockedSenderDomains', 'Blockierte Domänen', '—', null]
    ]},
    malware: { label: 'Antimalware', icon: '🦠', fields: [
      ['EnableFileFilter', 'Filter gefährlicher Dateitypen', 'Ein', yes],
      ['FileTypeAction', 'Aktion bei gefährlichem Dateityp', 'Ablehnen', oneOf('Reject', 'Quarantine')],
      ['ZapEnabled', 'ZAP für Malware', 'Ein', yes],
      ['EnableInternalSenderAdminNotifications', 'Admin-Hinweis bei internen Absendern', 'Ein', yes]
    ]},
    outbound: { label: 'Ausgehend', icon: '📤', fields: [
      ['AutoForwardingMode', 'Automatische Weiterleitung nach extern', 'Aus', oneOf('Off', 'Automatic'), '«Automatic» = seit 2020 gleichbedeutend mit Aus'],
      ['RecipientLimitExternalPerHour', 'Max. externe Empfänger pro Stunde', '500 oder weniger', v => v === 0 || max(500)(v), '0 = Microsoft-Standardlimit'],
      ['RecipientLimitInternalPerHour', 'Max. interne Empfänger pro Stunde', '1000 oder weniger', v => v === 0 || max(1000)(v)],
      ['RecipientLimitPerDay', 'Max. Empfänger pro Tag', '1000 oder weniger', v => v === 0 || max(1000)(v)],
      ['ActionWhenThresholdReached', 'Aktion bei Überschreitung', 'Benutzer sperren', oneOf('BlockUser')]
    ]},
    safeLinks: { label: 'Safe Links', icon: '🔗', fields: [
      ['EnableSafeLinksForEmail', 'In E-Mails', 'Ein', yes],
      ['EnableSafeLinksForTeams', 'In Teams', 'Ein', yes],
      ['EnableSafeLinksForOffice', 'In Office-Apps', 'Ein', yes],
      ['ScanUrls', 'Links in Echtzeit prüfen', 'Ein', yes],
      ['DeliverMessageAfterScan', 'Zustellung erst nach Prüfung', 'Ein', yes],
      ['EnableForInternalSenders', 'Auch für interne Absender', 'Ein', yes],
      ['TrackClicks', 'Klicks protokollieren', 'Ein', yes],
      ['AllowClickThrough', 'Durchklicken zur Originaladresse erlauben', 'Aus', no]
    ]},
    safeAttachments: { label: 'Safe Attachments', icon: '📎', fields: [
      ['Enable', 'Aktiv', 'Ein', yes],
      ['Action', 'Aktion bei Malware', 'Blockieren', oneOf('Block')],
      ['QuarantineTag', 'Quarantänerichtlinie', 'AdminOnlyAccessPolicy', null],
      ['Redirect', 'Umleitung an Adresse', '—', null]
    ]},
    remoteDomains: { label: 'Remote Domains', icon: '🌐', fields: [
      ['DomainName', 'Domäne', '—', null],
      ['AutoForwardEnabled', 'Automatische Weiterleitung', 'Aus (Standard-Domäne *)', no]
    ]},
    presetEop: { label: 'Voreinstellung EOP', icon: '⚙', fields: [['State', 'Status', 'Enabled', oneOf('Enabled')], ['Priority', 'Priorität', '—', null]] },
    presetAtp: { label: 'Voreinstellung Defender', icon: '⚙', fields: [['State', 'Status', 'Enabled', oneOf('Enabled')], ['Priority', 'Priorität', '—', null]] }
  }
  const KIND = { antiPhish: 'AntiPhish', contentFilter: 'Antispam', malware: 'Antimalware', outbound: 'Outbound', safeLinks: 'SafeLinks', safeAttachments: 'SafeAttachments', presetEop: 'PresetEOP', presetAtp: 'PresetATP', remoteDomains: 'RemoteDomain' }

  let cat = $state('antiPhish')
  let onlyBad = $state(false)

  const DE = { true: 'Ein', false: 'Aus', MoveToJmf: 'Junk-Ordner', Quarantine: 'Quarantäne', Reject: 'Ablehnen', Delete: 'Löschen', AddXHeader: 'X-Header', ModifySubject: 'Betreff ändern', NoAction: 'Keine Aktion', Redirect: 'Umleiten', BlockUser: 'Benutzer sperren', BlockUserForToday: 'Für heute sperren', Alert: 'Nur Warnung', Off: 'Aus', On: 'Ein', Automatic: 'Automatisch (= Aus)', Block: 'Blockieren', DynamicDelivery: 'Dynamische Zustellung', Allow: 'Zulassen', Enabled: 'Aktiv', Disabled: 'Deaktiviert' }
  function show(v) {
    if (v === null || v === undefined || v === '') return '—'
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'keine'
    return DE[String(v)] ?? String(v)
  }

  let policies = $derived(data?.policies || {})
  let cats = $derived(Object.keys(SPEC).map(k => {
    const list = (policies[k] || [])
    const rows = list.map(p => rate(k, p))
    return { k, ...SPEC[k], list, bad: rows.reduce((n, r) => n + r.bad, 0), err: data?.errors?.[k] || null }
  }))

  function driftFor(kind, name) {
    const f = findings.find(x => x.area === 'threat' && x.drift && x.objId === `${KIND[kind]}:${name}`)
    return f || null
  }
  function rate(k, p) {
    const fields = SPEC[k].fields.map(([key, label, rec, test, hint]) => {
      const v = p[key]
      const ok = test ? !!test(v) : null
      return { key, label, rec, hint, v, ok: v === undefined ? null : ok }
    })
    // Remote Domains: nur die Standarddomaene * muss Weiterleitung verbieten.
    if (k === 'remoteDomains' && p.DomainName !== '*') for (const f of fields) if (f.key === 'AutoForwardEnabled') f.ok = null
    const drift = driftFor(k, p.Name)
    const changed = new Set((drift?.diff || []).map(d => String(d.path).split('.')[0]))
    for (const f of fields) f.changed = changed.has(f.key)
    return { p, fields, bad: fields.filter(f => f.ok === false).length, drift }
  }
  let current = $derived(cats.find(c => c.k === cat))
</script>

<div class="tp">
  <nav class="tcats">
    {#each cats as c}
      <button class:active={cat === c.k} onclick={() => cat = c.k}>
        <span class="ic">{c.icon}</span>
        <span class="tl"><b>{c.label}</b><small>{c.err ? 'nicht lesbar' : c.list.length + (c.list.length === 1 ? ' Policy' : ' Policies')}</small></span>
        {#if c.bad}<span class="bad">{c.bad}</span>{:else if c.list.length}<span class="ok">✓</span>{/if}
      </button>
    {/each}
  </nav>

  <div class="tmain">
    <div class="thead">
      <h4>{current.icon} {current.label}</h4>
      <label class="tgl"><input type="checkbox" bind:checked={onlyBad} /> nur Abweichungen</label>
    </div>
    {#if current.err}
      <div class="alert alert-warning">Nicht lesbar: {current.err}</div>
    {:else if !current.list.length}
      <div class="emptyp">Keine Policy dieser Art im Tenant{['safeLinks', 'safeAttachments', 'presetAtp'].includes(cat) ? ' — Defender for Office 365 fehlt oder ist nicht konfiguriert.' : '.'}</div>
    {:else}
      {#each current.list.map(p => rate(cat, p)) as r}
        <section class="pol" class:hasbad={r.bad}>
          <header>
            <div>
              <b>{r.p.Name}</b>
              {#if r.p.IsDefault}<span class="chip">Standard-Policy</span>{/if}
              {#if /^BP_/.test(r.p.Name)}<span class="chip ig">igeeks-Baseline</span>{/if}
              {#if /Built-In|Preset|Standard Preset|Strict Preset/i.test(r.p.Name)}<span class="chip">von Microsoft</span>{/if}
            </div>
            <div class="score">
              {#if r.drift}<button class="driftb" onclick={() => onFinding && onFinding(r.drift)}>Drift zur Baseline</button>{/if}
              <span class:sbad={r.bad} class:sok={!r.bad}>{r.bad ? r.bad + ' abweichend' : 'entspricht Empfehlung'}</span>
            </div>
          </header>
          <table>
            <thead><tr><th>Einstellung</th><th>Ist</th><th>Empfehlung</th><th></th></tr></thead>
            <tbody>
              {#each r.fields.filter(f => !onlyBad || f.ok === false || f.changed) as f}
                <tr class:rbad={f.ok === false} class:chg={f.changed}>
                  <td><span class="fl">{f.label}</span>{#if f.hint}<span class="fh">{f.hint}</span>{/if}<code>{f.key}</code></td>
                  <td class="val">{show(f.v)}{#if f.changed}<em title="Weicht von der quittierten Baseline ab">geändert</em>{/if}</td>
                  <td class="rec">{f.rec}</td>
                  <td class="st">{#if f.ok === true}<span class="g">●</span>{:else if f.ok === false}<span class="r">●</span>{:else}<span class="n">○</span>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .tp{display:grid;grid-template-columns:230px minmax(0,1fr);gap:.9rem;align-items:start}
  .tcats{display:flex;flex-direction:column;gap:.25rem;position:sticky;top:calc(var(--topbar-h) + .8rem)}
  .tcats button{all:unset;cursor:pointer;box-sizing:border-box;display:grid;grid-template-columns:26px 1fr auto;gap:.5rem;align-items:center;padding:.5rem .6rem;border-radius:10px;border:1px solid transparent}
  .tcats button:hover{background:var(--bg-inset)}.tcats button.active{background:var(--bg-raised);border-color:var(--accent);box-shadow:var(--shadow-sm)}
  .ic{font-size:1rem;text-align:center}
  .tl{display:flex;flex-direction:column}.tl b{font-size:.8rem}.tl small{font-size:.64rem;color:var(--text-faint)}
  .bad{font-size:.66rem;font-weight:900;background:var(--crit);color:#fff;border-radius:999px;padding:.05rem .45rem}
  .ok{color:var(--ok);font-weight:900}
  .tmain{display:flex;flex-direction:column;gap:.7rem;min-width:0}
  .thead{display:flex;justify-content:space-between;align-items:center}.thead h4{margin:0;font-size:1rem}
  .tgl{display:flex;gap:.35rem;align-items:center;font-size:.76rem;font-weight:700}
  .emptyp{border:1px dashed var(--rule);border-radius:12px;padding:1rem;color:var(--text-dim);font-size:.82rem}
  .pol{border:1px solid var(--rule);border-radius:12px;background:var(--bg-raised);overflow:hidden}
  .pol.hasbad{border-left:4px solid var(--crit)}
  .pol header{display:flex;justify-content:space-between;gap:.6rem;align-items:center;padding:.6rem .8rem;border-bottom:1px solid var(--rule);flex-wrap:wrap}
  .pol header b{font-size:.9rem;margin-right:.4rem}
  .chip{font-size:.6rem;font-weight:800;background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.1rem .45rem;margin-right:.25rem}
  .chip.ig{background:var(--accent-wash);color:var(--accent)}
  .score{display:flex;gap:.5rem;align-items:center}
  .score span{font-size:.7rem;font-weight:800;border-radius:999px;padding:.15rem .55rem}
  .sbad{background:var(--crit-wash);color:var(--crit)}.sok{background:var(--ok-wash);color:var(--ok)}
  .driftb{all:unset;cursor:pointer;font-size:.68rem;font-weight:800;background:#ede7f6;color:#5e35b1;border-radius:999px;padding:.15rem .55rem}
  table{width:100%;border-collapse:collapse;font-size:.78rem}
  th{text-align:left;font-size:.6rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text-faint);padding:.4rem .8rem;background:var(--bg-inset)}
  td{padding:.45rem .8rem;border-top:1px solid var(--rule);vertical-align:top}
  .fl{display:block;font-weight:600}.fh{display:block;font-size:.68rem;color:var(--text-dim)}
  code{font-size:.62rem;color:var(--text-faint);font-family:var(--font-mono)}
  .val{font-weight:700;word-break:break-word;max-width:260px}.val em{display:inline-block;margin-left:.35rem;font-style:normal;font-size:.6rem;font-weight:800;background:#ede7f6;color:#5e35b1;border-radius:999px;padding:.05rem .4rem}
  .rec{color:var(--text-dim)}
  .st{text-align:center;width:28px}.g{color:var(--ok)}.r{color:var(--crit)}.n{color:var(--text-faint)}
  tr.rbad td{background:color-mix(in srgb,var(--crit-wash) 70%,transparent)}
  tr.chg td:first-child{box-shadow:inset 3px 0 0 #7e57c2}
  @media(max-width:900px){.tp{grid-template-columns:1fr}.tcats{position:static;flex-direction:row;flex-wrap:wrap}}
</style>
