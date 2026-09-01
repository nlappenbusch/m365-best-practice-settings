// Konfigurations-Store — volles Datenmodell, 1:1 aus dem Vanilla-app.js.
import { writable } from 'svelte/store'

export const defaultConfig = () => ({
  global: {
    domains: ['example.com'],
    onmicrosoftDomain: 'example.onmicrosoft.com',
    adminEmail: 'admin@example.com',
    igeeksEmail: 'support@msp-provider.com'
  },
  antiPhishing: {
    spoofIntelligence: true,
    firstContactTip: true,
    unauthSenderSymbol: true,
    viaTag: true,
    honorDmarc: true,
    dmarcQuarantineAction: 'Quarantine',
    dmarcRejectAction: 'Reject',
    spoofAction: 'Quarantine'
  },
  antiSpam: {
    bulkThreshold: 7,
    // Legacy-ASF: Microsoft-Empfehlung Off (siehe Best-Practices-Tab).
    bizInfoUrls: false,
    numericIpUrls: false,
    urlRedirect: false,
    emptyMessages: false,
    jsVbScript: false,
    frameIframe: false,
    sensitiveWords: false,
    spfHardFail: false,
    backscatter: false,
    spamAction: 'Quarantine',
    highConfSpamAction: 'Quarantine',
    // Bulk (Graymail/Newsletter) gehoert in den Junk-Ordner, nicht in die
    // Quarantaene — sonst muellt Werbepost die Quarantaene-Benachrichtigung zu.
    // Kunden, die bewusst "nur Inbox + Quarantaene" wollen (z.B. PKRueck),
    // weichen per gewollter Abweichung auf Quarantine ab.
    bulkAction: 'MoveToJmf',
    phishAction: 'Quarantine',
    highConfPhishAction: 'Quarantine'
  },
  antiMalware: {
    commonAttachFilter: true,
    zapMalware: true,
    customFileTypes: '.ace, .apk, .app, .appx, .arj, .bat, .cab, .cmd, .com, .deb, .dex, .dll, .dmg, .elf, .exe, .hta, .img, .iso, .jar, .jnlp, .kext, .lha, .lib, .library, .lnk, .lzh, .macho, .msc, .msi, .msix, .msp, .mst, .pif, .pkg, .prf, .ps1, .scr, .sct, .sys, .vb, .vbe, .vbs, .vxd, .wsc, .wsf, .wsh, .xll',
    malwareAction: 'Reject'
  },
  // Ausgehend & Organisation — CIS 2.1.6, 2.1.15, 6.2.1, 6.2.3, 6.5.5.
  // Anders als die BP_-Policies sind das organisationsweite Einstellungen an
  // der Standard-Richtlinie bzw. am Tenant; genau dort schauen auch die
  // Pruefwerkzeuge hin.
  outbound: {
    notifyOutboundSpam: true,
    limitExternalPerHour: 500,
    limitInternalPerHour: 1000,
    limitPerDay: 1000,
    // CIS empfiehlt BlockUser (Sperre bis zur manuellen Freigabe). Das ist eine
    // Betriebsentscheidung mit spuerbarer Wirkung auf den Betroffenen und
    // braucht eine geklaerte Zustaendigkeit — deshalb hier der mildere Default.
    thresholdAction: 'BlockUserForToday',
    externalTagging: true,
    // Die beiden folgenden koennen laufenden Betrieb unterbrechen und stehen
    // deshalb aus: erst Bestandsaufnahme im Tenant, dann anhaken.
    blockAutoForward: false,
    rejectDirectSend: false
  }
})

export const config = writable(defaultConfig())
