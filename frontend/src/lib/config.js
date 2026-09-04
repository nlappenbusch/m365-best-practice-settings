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
  // Safe Links / Safe Attachments (Defender for Office 365 P1/P2) — anders als
  // die drei Bereiche oben nicht bei jedem Tenant lizenziert, deshalb ein
  // eigener Schalter statt einer harten Vorgabe. Default an, weil die meisten
  // igeeks-Kunden Business Premium (und damit P1) haben; fehlt die Lizenz,
  // meldet der Deploy nur diese eine Phase als Fehler, der Rest laeuft durch.
  safeLinks: {
    enabled: true,
    enableForInternalSenders: true,
    allowClickThrough: false
  },
  safeAttach: {
    action: 'Block'
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
    // CIS-Empfehlung: Sperre bis zur manuellen Freigabe. Bewusst als Vorgabe
    // gesetzt (Entscheid Nils, 01.09.2026) — ein kompromittiertes Postfach, das
    // sich nach 24 Stunden von selbst entsperrt, ist kein Schutz. Setzt voraus,
    // dass geklaert ist, wer im Ereignisfall freigibt.
    thresholdAction: 'BlockUser',
    externalTagging: true,
    // Beide sind Best Practice und stehen deshalb als Vorgabe AN (Entscheid Nils,
    // 01.09.2026). Sie koennen laufenden Betrieb unterbrechen: gewollte
    // Weiterleitungen, Multifunktionsdrucker, Scan-to-Mail und Fachanwendungen mit
    // eigenem Mailversand — bei Direct Send ohne Fehlermeldung an den Absender.
    // Die Erhebungsbefehle stehen im Konfigurations-Tab und gehoeren vor dem
    // Ausrollen gelaufen; abwaehlen bleibt pro Tenant jederzeit moeglich.
    blockAutoForward: true,
    rejectDirectSend: true
  }
})

export const config = writable(defaultConfig())
