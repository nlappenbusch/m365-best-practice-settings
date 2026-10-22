<script>
  import Modal from './CockpitModal.svelte'
  import { onMount } from 'svelte'
  import { apiGet, apiPost } from './api.js'
  import { url, csv } from './cockpit.js'
  import { goToTab } from './tabStore.js'
  import { fmtDateTime } from './product.js'
  let { tenant } = $props()
  let data = $state(null), error = $state(''), loading = $state(false), q = $state(''), tab = $state('users'), filter = $state('all'), selected = $state(null), action = $state(''), result = $state(null), acting = $state(false)
  let users = $derived((data?.users || []).filter(u => !q || `${u.displayName} ${u.userPrincipalName}`.toLowerCase().includes(q.toLowerCase())).filter(u => tab === 'guests' ? u.userType === 'Guest' : true).filter(u => filter === 'all' || (filter === 'active' ? u.accountEnabled : filter === 'inactive' ? !u.accountEnabled : filter === 'licensed' ? u.assignedLicenses.length > 0 : u.mfaRegistered === false)))
  let registered = $derived(data?.users?.filter(u => u.mfaRegistered === true).length || 0)
  let known = $derived(data?.users?.filter(u => u.mfaRegistered !== null).length || 0)
  let mfaPct = $derived(known ? Math.round(registered / known * 1000) / 10 : null)
  let currentScore = $derived(data?.scores?.[0])
  let score = $derived(currentScore?.maxScore ? Math.round(currentScore.currentScore / currentScore.maxScore * 100) : null)
  async function load() { loading = true; error = ''; try { data = await apiGet(url(tenant.id, 'identity')) } catch(e) { error = e.message }; loading = false }
  onMount(load)
  async function execute() {
    acting = true; error = ''
    try { result = (await apiPost(`/api/tenants/${encodeURIComponent(tenant.id)}/user-actions/${action}`, { userId: selected.id })).result; selected = null; await load() } catch(e) { error = e.message }
    acting = false
  }
</script>
<div class="cp-head"><div><h2>Benutzer & Identität</h2><p>{tenant.name} · Entra ID</p></div><div class="cp-actions"><button class="btn btn-secondary" onclick={() => csv('Benutzer', ['Name','UPN','Aktiv','Typ','MFA registriert'], users.map(u => [u.displayName,u.userPrincipalName,u.accountEnabled,u.userType,u.mfaRegistered]))}>CSV Export</button><button class="btn btn-primary" onclick={load} disabled={loading}>{loading ? 'Lade…' : 'Jetzt synchronisieren'}</button></div></div>
<div class="cp-tabs">{#each [['users','Benutzer'],['guests','Gäste'],['groups','Gruppen'],['charts','Kennzahlen in Grafiken']] as [id,name]}<button class:active={tab === id} onclick={() => tab = id}>{name}</button>{/each}</div>
{#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
{#if data?.gaps?.length}<div class="cp-note cp-gaps">Nicht abrufbar: {data.gaps.map(g => g.source + ': ' + g.message).join(' · ')}</div>{/if}
{#if data}
<div class="cp-note">MFA zeigt die Registrierung von Methoden. Ob MFA bei einer Anmeldung erzwungen wird, ist in Conditional Access zu prüfen. Stand: {fmtDateTime(data.at)}</div>
{#if tab === 'charts'}
  <div class="cp-charts">
    <section class="cp-panel cp-chart"><h3>Entra ID</h3>{#each [['Benutzer gesamt',data.users?.length],['Aktive Konten',data.users?.filter(u => u.accountEnabled).length],['Lizenzierte Benutzer',data.users?.filter(u => u.assignedLicenses.length).length],['Gäste',data.users?.filter(u => u.userType === 'Guest').length],['Gruppen',data.groups?.length]] as [label,value]}<div class="cp-legend"><span>{label}</span><strong>{value ?? '—'}</strong></div>{/each}</section>
    <section class="cp-panel cp-chart"><h3>MFA-Registrierung</h3><div class="cp-ring" style:--value={mfaPct || 0}><strong>{mfaPct === null ? '—' : mfaPct + '%'}</strong></div><div class="cp-legend"><span>Registriert</span><strong>{registered}</strong></div><div class="cp-legend"><span>Nicht registriert</span><strong>{known - registered}</strong></div><div class="cp-legend"><span>Unbekannt</span><strong>{(data.users?.length || 0) - known}</strong></div></section>
    <section class="cp-panel cp-chart"><h3>Microsoft Secure Score</h3><div class="cp-ring" style:--value={score || 0}><strong>{score === null ? '—' : score + '%'}</strong></div><p>{currentScore ? `${currentScore.currentScore} von ${currentScore.maxScore} Punkten` : 'Keine Score-Daten verfügbar'}</p></section>
    <section class="cp-panel cp-chart"><h3>Geräte</h3>{#each [['Konform',data.devices?.filter(d => d.complianceState === 'compliant').length],['Nicht konform',data.devices?.filter(d => d.complianceState === 'noncompliant').length],['Andere / unbekannt',data.devices?.filter(d => !['compliant','noncompliant'].includes(d.complianceState)).length]] as [label,value]}<div class="cp-legend"><span>{label}</span><strong>{value ?? '—'}</strong></div>{/each}<button class="btn btn-secondary" onclick={() => goToTab('intune')}>Geräte verwalten</button></section>
  </div>
{:else if tab === 'groups'}
  <div class="cp-table-wrap"><table><thead><tr><th>Gruppenname</th><th>Typ</th><th>Mitgliedschaft</th></tr></thead><tbody>{#each data.groups || [] as g}<tr><td>{g.displayName}</td><td>{g.securityEnabled ? 'Sicherheit' : 'Microsoft 365 / Verteiler'}</td><td>{g.groupTypes.includes('DynamicMembership') ? 'Dynamisch' : 'Zugewiesen'}</td></tr>{:else}<tr><td colspan="3">Keine Gruppen verfügbar.</td></tr>{/each}</tbody></table></div>
{:else}
  <div class="cp-kpis">{#each [['all','Benutzer gesamt',data.users?.length],['active','Aktive Benutzer',data.users?.filter(u => u.accountEnabled).length],['licensed','Lizenziert',data.users?.filter(u => u.assignedLicenses.length).length],['nomfa','MFA nicht registriert',data.users?.filter(u => u.mfaRegistered === false).length]] as [id,label,value]}<button class="cp-kpi" class:active={filter === id} onclick={() => filter = id}><span>{label}</span><strong>{value ?? '—'}</strong></button>{/each}</div>
  <div class="cp-panel cp-toolbar"><input type="search" placeholder="Benutzer durchsuchen…" aria-label="Benutzer durchsuchen" bind:value={q}/><select aria-label="Kontostatus" bind:value={filter}><option value="all">Alle Benutzer</option><option value="active">Aktiv</option><option value="inactive">Deaktiviert</option><option value="licensed">Lizenziert</option><option value="nomfa">MFA nicht registriert</option></select><span class="cp-sub">{users.length} Ergebnisse</span></div>
  <div class="cp-table-wrap"><table><thead><tr><th>Anzeigename</th><th>MFA registriert</th><th>Status</th><th>Typ</th><th>Lizenzen</th><th>Aktionen</th></tr></thead><tbody>{#each users as u}<tr><td><strong>{u.displayName}</strong><small>{u.userPrincipalName}</small></td><td class:cp-ok={u.mfaRegistered === true} class:cp-crit={u.mfaRegistered === false}>{u.mfaRegistered === null ? 'Unbekannt' : u.mfaRegistered ? 'Ja' : 'Nein'}</td><td><span class="cp-badge" class:ok={u.accountEnabled}>{u.accountEnabled ? 'Aktiv' : 'Deaktiviert'}</span></td><td>{u.userType}</td><td>{u.assignedLicenses.length}</td><td><button class="btn btn-secondary" disabled={tenant.readOnly} onclick={() => { selected = u; action = 'revoke-sessions' }}>Verwalten</button></td></tr>{:else}<tr><td colspan="6">Keine Benutzer in dieser Ansicht.</td></tr>{/each}</tbody></table></div>
{/if}
{:else if loading}<div class="cp-empty">Identitätsdaten werden geladen…</div>{/if}
{#if selected}<Modal {error} label="Benutzer verwalten" onclose={() => selected = null} busy={acting}><h3>{selected.displayName}</h3><p>{selected.userPrincipalName}</p><label>Aktion<select bind:value={action}><option value="revoke-sessions">Sitzungen beenden</option><option value="reset-mfa">MFA zurücksetzen</option><option value="reset-password">Passwort zurücksetzen</option></select></label><div class="cp-note">Die Aktion wirkt auf dieses Konto. Bestehende serverseitige Freigaben und Tenant-Berechtigungen gelten weiterhin.</div><div class="cp-actions"><button class="btn btn-secondary" disabled={acting} onclick={() => selected = null}>Abbrechen</button><button class="btn btn-primary" disabled={acting} onclick={execute}>{acting ? 'Wird ausgeführt…' : 'Aktion ausführen'}</button></div></Modal>{/if}
{#if result}<Modal {error} label="Aktion abgeschlossen" onclose={() => result = null} busy={false}><h3>Aktion abgeschlossen</h3>{#if result.tempPassword}<p>Temporäres Passwort (einmalige Anzeige):</p><code>{result.tempPassword}</code>{:else}<p>Die Anfrage wurde erfolgreich verarbeitet.</p>{/if}<div class="cp-actions"><button class="btn btn-primary" onclick={() => result = null}>Schließen</button></div></Modal>{/if}
