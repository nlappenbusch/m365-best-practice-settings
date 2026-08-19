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
  }
})

export const config = writable(defaultConfig())
