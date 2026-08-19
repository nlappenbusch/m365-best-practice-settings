<script>
  // Vollbild-Login-Gate: SSO ueber den iGeeks-Tenant ist der primaere Weg,
  // der lokale Passwort-Login bleibt als Fallback (aufklappbar).
  import { session, login } from './session.js'
  import { apiGet } from './api.js'

  let ssoEnabled = $state(null) // null = noch nicht geladen
  let ssoError = $state(null)
  let showPassword = $state(false)
  let username = $state('admin')
  let password = $state('')
  let error = $state('')
  let busy = $state(false)
  let ssoChecked = false

  $effect(() => {
    if ($session.ready && $session.online && !$session.loggedIn && !ssoChecked) {
      ssoChecked = true
      loadSsoConfig()
    }
    // Nach Login (oder offline) zuruecksetzen, damit beim naechsten Erscheinen
    // des Gates die SSO-Verfuegbarkeit FRISCH geladen wird — sie kann sich in
    // der Zwischenzeit geaendert haben (Admin hat SSO gerade eingerichtet).
    if ($session.loggedIn || !($session.ready && $session.online)) {
      ssoChecked = false
      ssoEnabled = null
    }
  })

  async function loadSsoConfig() {
    try {
      const r = await apiGet('/api/sso/config')
      ssoEnabled = !!r.enabled
    } catch (e) {
      ssoEnabled = false
    }
    // Fehlermeldung aus einem fehlgeschlagenen SSO-Callback (?ssoError=...) anzeigen
    const p = new URLSearchParams(window.location.search)
    if (p.get('ssoError')) {
      ssoError = p.get('ssoError')
      history.replaceState(null, '', window.location.pathname)
    }
  }

  function startSso() { window.location.href = '/api/auth/sso/start' }

  async function submitPassword() {
    error = ''
    busy = true
    try {
      await login(username, password)
      password = ''
    } catch (e) {
      error = e.message
    }
    busy = false
  }

  const visible = $derived($session.ready && $session.online && !$session.loggedIn)
</script>

{#if visible}
  <div class="login-gate">
    <div class="login-card">
      <div class="login-brand">
        <div class="login-logo">🛡</div>
        <h1>M365 Security Policy Manager</h1>
        <p class="login-sub">Managed M365 Security</p>
      </div>

      {#if ssoError}
        <div class="alert alert-warning login-alert">⚠️ {ssoError}</div>
      {/if}

      {#if ssoEnabled === null}
        <div class="ld-step running"><span class="ld-spinner"></span> Lade Anmeldeoptionen…</div>
      {:else}
        {#if ssoEnabled}
          <button class="login-ms-btn" onclick={startSso}>
            <svg class="login-ms-logo" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Mit Microsoft anmelden
          </button>
          <div class="login-divider"><span>oder</span></div>
          <button type="button" class="login-pw-toggle" class:open={showPassword} onclick={() => (showPassword = !showPassword)}>
            <span class="login-pw-toggle-ico">🔑</span>
            {showPassword ? 'Passwort-Anmeldung verbergen' : 'Mit Passwort anmelden'}
            <span class="login-pw-toggle-car">{showPassword ? '▴' : '▾'}</span>
          </button>
        {/if}

        {#if !ssoEnabled || showPassword}
          <div class="login-pw-form">
            <div class="input-group">
              <label for="lg-user">Benutzer</label>
              <input id="lg-user" type="text" bind:value={username} autocomplete="username" />
            </div>
            <div class="input-group">
              <label for="lg-pass">Passwort</label>
              <input id="lg-pass" type="password" bind:value={password} autocomplete="current-password"
                     onkeydown={(e) => e.key === 'Enter' && submitPassword()} />
            </div>
            {#if error}
              <div class="alert alert-warning login-alert">{error}</div>
            {/if}
            <button class="btn btn-primary login-pw-btn" onclick={submitPassword} disabled={busy}>
              {busy ? '…' : 'Anmelden'}
            </button>
            {#if !ssoEnabled}
              <p class="login-hint">💡 Microsoft-Login (SSO) lässt sich nach der Anmeldung im Tab „🏢 Tenants“ einrichten.</p>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
