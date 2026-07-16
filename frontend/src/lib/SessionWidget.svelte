<script>
  import { session, login, logout } from './session.js'

  let modalOpen = $state(false)
  let username = $state('admin')
  let password = $state('')
  let error = $state('')

  function open() { error = ''; password = ''; modalOpen = true }
  function close() { modalOpen = false }

  async function submit() {
    error = ''
    try {
      await login(username, password)
      password = ''
      modalOpen = false
    } catch (e) {
      error = e.message
    }
  }
</script>

<svelte:window onkeydown={(e) => modalOpen && e.key === 'Escape' && close()} />

<div class="session-box">
  {#if !$session.online}
    <span class="session-state off">⚠️ Backend offline</span>
  {:else if $session.loggedIn}
    <span class="session-state on">✓ angemeldet</span>
    <button class="btn btn-secondary" onclick={logout}>Abmelden</button>
  {:else}
    <span class="session-state">🔒 nicht angemeldet</span>
    <button class="btn btn-secondary" onclick={open}>Anmelden</button>
  {/if}
</div>

{#if modalOpen}
  <!-- Backdrop schliesst per Klick; Escape via window. Dialog-Semantik am Inhalt. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal" style="display:flex" onclick={(e) => e.target === e.currentTarget && close()}>
    <div class="modal-content" style="max-width:420px" role="dialog" aria-modal="true" aria-label="Anmelden">
      <div class="modal-header">
        <h2>Anmelden</h2>
        <button class="close-btn" onclick={close}>&times;</button>
      </div>
      <div class="modal-body">
        <div class="input-group">
          <label for="sw-user">Benutzer</label>
          <input id="sw-user" type="text" bind:value={username} autocomplete="username" />
        </div>
        <div class="input-group" style="margin-top:.75rem">
          <label for="sw-pass">Passwort</label>
          <input id="sw-pass" type="password" bind:value={password}
                 autocomplete="current-password"
                 onkeydown={(e) => e.key === 'Enter' && submit()} />
          <small>Steht beim ersten Start im Container-Log:
            <code>docker logs m365-security-api</code></small>
        </div>
        {#if error}
          <div class="alert alert-warning" style="margin-top:.75rem">{error}</div>
        {/if}
        <div style="display:flex;justify-content:flex-end;margin-top:1rem">
          <button class="btn btn-primary" onclick={submit}>Anmelden</button>
        </div>
      </div>
    </div>
  </div>
{/if}
