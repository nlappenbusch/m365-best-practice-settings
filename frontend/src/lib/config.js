// Konfigurations-Store. Start mit dem globalen Abschnitt (Domains/E-Mails) —
// waechst in Meilenstein 4 (Konfiguration) um die Policy-Einstellungen.
// Defaults 1:1 aus dem Vanilla-Stand.
import { writable } from 'svelte/store'

export const config = writable({
  global: {
    domains: ['example.com', 'example.de'],
    onmicrosoftDomain: 'example.onmicrosoft.com',
    adminEmail: 'admin@example.com',
    igeeksEmail: 'support@msp-provider.com'
  }
})
