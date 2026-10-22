<script>
  import { tenants } from './tenantStore.js'
  let users = $state(0), price = $state(0.99), fee = $state(0), currency = $state('CHF')
  let total = $derived(Math.max(0,users || 0) * Math.max(0,price || 0) + Math.max(0,fee || 0))
</script>
<div class="cp-head"><div><h2>Service-Kostenplanung</h2><p>Eigene Konditionen für dein Managed-Service-Angebot</p></div></div>
<div class="cp-note">Unverbindliche Kalkulation mit deinen Eingaben. Hier wird keine Subscription gebucht und keine Zahlung ausgelöst. Preise und Lizenzmengen werden nicht automatisch aus einem Abrechnungssystem übernommen.</div>
<div class="cp-kpis"><div class="cp-kpi"><span>Angelegte Mandanten</span><strong>{$tenants.length}</strong></div><div class="cp-kpi"><span>Benutzer (Eingabe)</span><strong>{users || 0}</strong></div><div class="cp-kpi"><span>Monatliche Schätzung</span><strong>{total.toFixed(2)} {currency}</strong></div><div class="cp-kpi"><span>Jahreswert</span><strong>{(total*12).toFixed(2)} {currency}</strong></div></div>
<section class="cp-panel"><h3>Konditionen</h3><div class="cp-toolbar" style="margin-top:20px"><label>Lizenzierte Benutzer<input type="number" min="0" step="1" bind:value={users}/></label><label>Preis je Benutzer / Monat<input type="number" min="0" step="0.01" bind:value={price}/></label><label>Grundgebühr / Monat<input type="number" min="0" step="0.01" bind:value={fee}/></label><label>Währung<select bind:value={currency}><option>CHF</option><option>EUR</option></select></label></div></section>
