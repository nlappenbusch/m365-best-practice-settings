<script>
  import { config } from '../lib/config.js'
  import { docsHtml, recoHtml } from '../lib/wissenTemplates.js'
  import { autopilotHtml, oibHtml, namingHtml, patchMyPcHtml, conditionalAccessHtml, intuneBackupHtml, mappingsHtml } from '../lib/wissenIntune.js'
  import { openConfigDoc } from '../lib/configDoc.js'
  import { openKnowledgeDoc } from '../lib/knowledgeDoc.js'
  import { goToTab } from '../lib/tabStore.js'

  const docs = docsHtml()
  let reco = $derived(recoHtml($config.global.adminEmail))
  const autopilot = autopilotHtml()
  const oib = oibHtml()
  const naming = namingHtml()
  const patchMyPc = patchMyPcHtml()
  const condAccess = conditionalAccessHtml()
  const intuneBackup = intuneBackupHtml()
  const mappings = mappingsHtml()

  let sub = $state('mailsec')

  // {@html}-Blöcke können keine Svelte-Handler tragen — Sprung-Buttons in den
  // Wissenstexten (data-goto="...") werden deshalb per Klick-Delegation am
  // gemeinsamen Wrapper abgefangen.
  function onContentClick(e) {
    const btn = e.target.closest('[data-goto]')
    if (btn) goToTab(btn.dataset.goto)
  }

  const topics = [
    { id: 'mailsec',   icon: '🛡',  title: 'Mail-Security', teaser: 'Quarantäne-Policies, ASF, DMARC — und warum Microsofts Default nicht reicht.' },
    { id: 'autopilot', icon: '🚀', title: 'Autopilot',     teaser: 'Vom GroupTag zum fertig eingerichteten Gerät, ohne Login am Gerät.' },
    { id: 'oib',       icon: '💻', title: 'OpenIntuneBaseline', teaser: 'Das CIS-Delta, ISO-27001-Mapping und die vier Break-Risk-Policies.' },
    { id: 'ca',        icon: '🔐', title: 'Conditional Access', teaser: 'Ring-Konzept, Schutzgruppen und warum nie direkt scharf angelegt wird.' },
    { id: 'backup',    icon: '💾', title: 'Intune-Backup',  teaser: 'Nicht-destruktives Restore und Drift-Vergleich zwischen Ständen.' },
    { id: 'mappings',  icon: '🗺️', title: 'Mappings',      teaser: 'Laufwerke und Drucker auf Cloud-only-Geräten — zwei unterschiedliche Ansätze.' },
    { id: 'pmp',       icon: '🧩', title: 'Patch My PC',   teaser: 'Automatisches Third-Party-Patch- und App-Management.' },
    { id: 'naming',    icon: '🏷️', title: 'Namenskonventionen', teaser: 'Gruppenkonzept — inkl. Live-Generator für korrekte Namen.' }
  ]

  // ---------- Interaktiver Gruppennamen-Generator (Namenskonvention) ----------
  const NAME_CATS = {
    dev:  { prefix: 'AAD-DEV-',  placeholder: 'STD / PROD / KIOSK / EXEC', hint: 'Geräterolle — kurz & sprechend, nicht nach Formfaktor.' },
    pmp:  { prefix: 'AAD-PMP-',  placeholder: 'GoogleChrome', hint: 'Exakter App-Name, 1:1 pro Patch-My-PC-App.' },
    app:  { prefix: 'AAD-APP-',  placeholder: 'ZeiterfassungXY', hint: 'Selbst paketierte (nicht PMP-verwaltete) App.' },
    usr:  { prefix: 'AAD-USR-',  placeholder: 'AppProtection', hint: 'Nur wenn wirklich der Mensch das Ziel ist.' },
    role: { prefix: 'AAD-ROLE-', placeholder: 'Helpdesk', hint: 'Admin-/RBAC-Rollenzuweisung.' }
  }
  let nameCat = $state('dev')
  let nameDetail = $state('STD')
  let nameRing = $state('')
  let nameCopied = $state(false)

  function cleanDetail(s) {
    // NFKD zerlegt Umlaute in Basisbuchstabe + Akzentzeichen (z.B. "ö" -> "o" + Akzent);
    // der zweite Schritt entfernt neben Leerzeichen/Sonderzeichen damit auch das Akzentzeichen.
    return String(s || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '')
  }
  let cleanedDetail = $derived(cleanDetail(nameDetail))
  let generatedName = $derived(NAME_CATS[nameCat].prefix + (cleanedDetail || '…') + (nameCat === 'dev' && nameRing ? '-' + nameRing : ''))
  // GroupTag (OrderID) = Gruppenname ohne das "AAD-"-Praefix (siehe "GroupTag <-> Geraetegruppe"
  // unten) - z.B. Gruppe AAD-DEV-STD -> Tag DEV-STD. Nur den Rollen-Teil zu nehmen waere falsch
  // und wuerde genau den in der Doku gewarnten Fehler "Geraet landet in keiner Gruppe" erzeugen.
  let groupTagValue = $derived(nameCat === 'dev' && cleanedDetail
    ? NAME_CATS.dev.prefix.replace(/^AAD-/, '') + cleanedDetail + (nameRing ? '-' + nameRing : '')
    : '')
  let orderIdRule = $derived(groupTagValue
    ? '(device.devicePhysicalIds -any (_ -eq "[OrderID]:' + groupTagValue + '"))'
    : '')

  function copyName() {
    navigator.clipboard?.writeText(generatedName).then(() => {
      nameCopied = true
      setTimeout(() => (nameCopied = false), 1500)
    })
  }

  function pdfMailSecurity() {
    openKnowledgeDoc({
      title: 'Mail-Security — Best Practice Dokumentation',
      lead: 'Hintergrund und Best Practices zur Exchange-Online-Schutzkonfiguration',
      bodyHtml: '<h3>Best Practice Documentation</h3>' + docs + '<h3>Best Practices &amp; Empfehlungen</h3>' + reco,
      footerNote: 'Reiner Hintergrund-/Referenztext, unabhängig vom konkreten Tenant.'
    })
  }
  function pdfAutopilot() {
    openKnowledgeDoc({
      title: 'Autopilot — Geräteprovisionierung (Blueprint)',
      lead: 'GroupTag-Konzept, Admin-Einmal-Setup, Feld-Runbook und Sicherheitshinweise',
      bodyHtml: autopilot,
      footerNote: 'Abgeglichen mit den Tabs 🚀 Autopilot / 💻 Intune dieses Tools.'
    })
  }
  function pdfOib() {
    openKnowledgeDoc({
      title: 'OpenIntuneBaseline (OIB) — Management Summary',
      lead: 'Auditfähige Begründung des CIS-Deltas, ISO-27001-Mapping und praktische Anwendung',
      bodyHtml: oib,
      footerNote: 'Referenz-Frameworks: CIS Windows Benchmarks, Microsoft Intune Security Baseline, ISO/IEC 27001 Annex A (2022).'
    })
  }
  function pdfNaming() {
    openKnowledgeDoc({
      title: 'Gruppenkonzept & Namenskonventionen M365',
      lead: 'Zentrale Referenz für Entra-ID-Gruppen in Managed-Setups',
      bodyHtml: naming,
      footerNote: 'Gilt für Autopilot-, OIB- und App-Zuweisungen gleichermassen.'
    })
  }
  function pdfConditionalAccess() {
    openKnowledgeDoc({
      title: 'Conditional Access — Ring-Konzept & Sicherheitsleitplanken',
      lead: 'Gestufter Rollout (Pilot → UAT → Broad), Schutzgruppen und warum nie direkt scharf angelegt wird',
      bodyHtml: condAccess,
      footerNote: 'Abgeglichen mit dem Tab 🔐 Conditional Access dieses Tools.'
    })
  }
  function pdfIntuneBackup() {
    openKnowledgeDoc({
      title: 'Intune-Backup & -Restore',
      lead: 'Nicht-destruktives Restore-Konzept und Drift-Vergleich',
      bodyHtml: intuneBackup,
      footerNote: 'Abgeglichen mit dem Tab 💻 Intune → Backup & Restore dieses Tools.'
    })
  }
  function pdfMappings() {
    openKnowledgeDoc({
      title: 'Mappings — Laufwerke & Drucker auf Cloud-only-Geräten',
      lead: 'Zwei unterschiedliche Ansätze und warum jeweils der eine gewählt wurde',
      bodyHtml: mappings,
      footerNote: 'Abgeglichen mit dem Tab 🗺️ Mappings dieses Tools.'
    })
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div onclick={onContentClick}>
<div class="wissen-hero">
  <h1>📖 Wissen</h1>
  <p>Hintergrund, Begründungen und Referenzmaterial zu allem, was dieses Tool automatisiert — mit direkten
    Sprüngen zu den passenden Werkzeugen.</p>

  <div class="kpi-grid">
    <div class="kpi-tile"><b>5</b><span>Bedrohungskategorien (Mail)</span></div>
    <div class="kpi-tile warn"><b>9</b><span>ASF-Schalter bewusst "Off"</span></div>
    <div class="kpi-tile bad"><b>4</b><span>Break-Risk-Policies markiert</span></div>
    <div class="kpi-tile ok"><b>7</b><span>Werkzeuge direkt verlinkt</span></div>
  </div>
</div>

<section class="docs-section">
  <h2>Konfig-Doku (PDF)</h2>
  <div class="alert alert-info" style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;">
      <strong>Nüchterne Konfigurationsdokumentation der aktuellen Mail-Security-Vorlage</strong> —
      alle <code>BP_</code>-Policies mit Parametern, Quarantäne-Berechtigungen, ASF-Begründung und
      Dateityp-Liste. Wird live aus der Vorlage erzeugt und ist damit immer aktuell.
    </div>
    <button class="btn btn-primary" style="white-space:nowrap;" onclick={() => openConfigDoc($config)}>
      📘 Öffnen / als PDF speichern
    </button>
  </div>
  <p style="font-size:.85rem;color:var(--text-dim);margin-top:.5rem;">
    💡 Die Doku eines <em>konkreten Tenants</em> (Ist-Zustand + gewollte Abweichungen mit Begründung)
    gibt es im Tab <strong>Audit</strong>.
  </p>
  <div class="alert alert-info" style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-top:0.75rem;">
    <div style="flex:1;min-width:260px;">
      <strong>Nützliche externe Tools:</strong> Schnellzugriff auf alle Microsoft-Admin-Portale —
      <a href="https://cmd.ms" target="_blank" rel="noopener"><strong>cmd.ms</strong></a>
      (merkbares URL-Schema, z.B. <code>entra.cmd.ms</code>, <code>intune.cmd.ms</code>, <code>ca.cmd.ms</code>) und
      <a href="https://msportals.io" target="_blank" rel="noopener"><strong>msportals.io</strong></a>
      (durchsuchbare Linkliste sämtlicher Admin-Portale inkl. Deep-Links).
    </div>
  </div>
</section>

<!-- Themenwahl als kompakte Reiterleiste: acht Karten mit Teasertext waren
     eine halbe Bildschirmseite, bevor der eigentliche Inhalt begann. Der
     Teaser steht jetzt im Tooltip. -->
<div class="topic-bar">
  {#each topics as t (t.id)}
    <button type="button" class="topic-chip" class:active={sub === t.id}
            title={t.teaser} onclick={() => (sub = t.id)}>
      {t.title}
    </button>
  {/each}
</div>

<div class="dl-panel" class:active={sub === 'mailsec'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfMailSecurity}>Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Best Practice Documentation</h2>
    <div class="docs-content">{@html docs}</div>
  </section>
  <section class="recommendations-section">
    <h2>Best Practices &amp; Empfehlungen</h2>
    <div class="recommendations-content">{@html reco}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'autopilot'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfAutopilot}>Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Blueprint — Geräteprovisionierung (Autopilot)</h2>
    <div class="docs-content">{@html autopilot}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'oib'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfOib}>Als PDF speichern (Audit-tauglich)</button>
  </div>
  <section class="docs-section">
    <h2>OpenIntuneBaseline (OIB) — Management Summary</h2>
    <div class="docs-content">{@html oib}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'ca'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfConditionalAccess}>Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Conditional Access — Ring-Konzept &amp; Sicherheitsleitplanken</h2>
    <div class="docs-content">{@html condAccess}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'backup'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfIntuneBackup}>Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Intune-Backup &amp; -Restore</h2>
    <div class="docs-content">{@html intuneBackup}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'mappings'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfMappings}>Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Mappings — Laufwerke &amp; Drucker auf Cloud-only-Geräten</h2>
    <div class="docs-content">{@html mappings}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'pmp'}>
  <section class="docs-section">
    <h2>Automatisiertes Third-Party-Patch- und App-Management mit Patch My PC</h2>
    <div class="docs-content">{@html patchMyPc}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'naming'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfNaming}>Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Gruppenkonzept &amp; Namenskonventionen M365 (Blueprint)</h2>

    <div class="name-builder">
      <h4>Gruppennamen live generieren</h4>
      <div class="name-builder-row">
        <label class="name-builder-field">
          Kategorie
          <select bind:value={nameCat}>
            <option value="dev">Gerätegruppe</option>
            <option value="pmp">App-Gruppe (Patch My PC)</option>
            <option value="app">App-Gruppe (manuell)</option>
            <option value="usr">Benutzergruppe</option>
            <option value="role">Rolle / RBAC</option>
          </select>
        </label>
        <label class="name-builder-field">
          Detail
          <input type="text" bind:value={nameDetail} placeholder={NAME_CATS[nameCat].placeholder} />
        </label>
        {#if nameCat === 'dev'}
          <label class="name-builder-field">
            Rollout-Ring (optional)
            <select bind:value={nameRing}>
              <option value="">— kein Ring —</option>
              <option value="PILOT">PILOT</option>
              <option value="UAT">UAT</option>
              <option value="BROAD">BROAD</option>
            </select>
          </label>
        {/if}
      </div>
      <div class="name-builder-output">
        <code>{generatedName}</code>
        <button type="button" class="btn btn-secondary" style="font-size:.78rem;padding:.35rem .65rem;" onclick={copyName}>
          {nameCopied ? '✅ Kopiert' : '📋 Kopieren'}
        </button>
      </div>
      {#if orderIdRule}
        <p class="name-builder-hint">GroupTag (OrderID) im Staging-Paket: <code>{groupTagValue}</code> — dynamische
          Mitgliedschaftsregel für diese Gerätegruppe: <code>{orderIdRule}</code>
        </p>
      {/if}
      <p class="name-builder-hint">{NAME_CATS[nameCat].hint}</p>
    </div>

    <div class="docs-content">{@html naming}</div>
  </section>
</div>
</div>
