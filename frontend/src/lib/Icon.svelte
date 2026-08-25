<script>
  // Strichicons statt Emoji.
  //
  // Bewusst als Inline-SVG und nicht als Icon-Font (Font Awesome & Co.):
  // - keine externe Abhängigkeit — der Container liefert alles selbst aus, und
  //   der Egress ins Internet ist in beiden Umgebungen eingeschränkt
  // - kein Font-Ladeflackern, keine zusätzliche Datei
  // - färbt sich über currentColor mit, funktioniert damit in Hell und Dunkel
  //   und auf farbigen Flächen ohne Sonderbehandlung
  // Die Pfade folgen dem Lucide-Set (ISC-Lizenz), 24x24-Raster.
  let { name, size = 18, stroke = 1.75, label = null } = $props()

  const PATHS = {
    // Navigation
    building: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z|M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2|M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2|M10 6h4|M10 10h4|M10 14h4|M10 18h4',
    sliders: 'M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6',
    shieldCheck: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z|m9 12 2 2 4-4',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M22 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75',
    mail: 'M22 7 13.03 12.7a1.94 1.94 0 0 1-2.06 0L2 7|M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    search: 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z|m21 21-4.3-4.3',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z|M9 3v15|M15 6v15',
    package: 'm7.5 4.27 9 5.15|M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z|m3.3 7 8.7 5 8.7-5|M12 22V12',
    tag: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z|M7 7h.01',
    rocket: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91 0z|m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z|M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0|M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
    shuffle: 'm18 14 4 4-4 4|m18 2 4 4-4 4|M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22|M2 6h1.972a4 4 0 0 1 3.6 2.2|M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45',
    chart: 'M3 3v16a2 2 0 0 0 2 2h16|M18 17V9|M13 17V5|M8 17v-3',
    coins: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z|M18.09 10.37A6 6 0 1 1 10.34 18|M7 6h1v4|m16.71 13.88.7.71-2.82 2.82',
    ticket: 'M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z|M13 5v2|M13 17v2|M13 11v2',
    stethoscope: 'M11 2v2|M5 2v2|M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1|M8 15a6 6 0 0 0 12 0v-3|M20 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    book: 'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20',
    lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z|M7 11V7a5 5 0 0 1 10 0v4',
    userCog: 'M10 15H6a4 4 0 0 0-4 4v2|M12.4 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z|M18 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z|M20.5 14.5 20 15|M16 20l-.5.5|M15 15.5l.5.5|M20 20l.5.5',
    wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',

    // Zustände und Aktionen
    check: 'm20 6-11 11-5-5',
    alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z|M12 9v4|M12 17h.01',
    x: 'M18 6 6 18|m6 6 12 12',
    refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16|M8 16H3v5',
    plus: 'M5 12h14|M12 5v14',
    chevronLeft: 'm15 18-6-6 6-6',
    chevronRight: 'm9 18 6-6-6-6',
    menu: 'M4 6h16|M4 12h16|M4 18h16',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M12 2v2|M12 20v2|m4.93 4.93 1.41 1.41|m17.66 17.66 1.41 1.41|M2 12h2|M20 12h2|m6.34 17.66-1.41 1.41|m19.07 4.93-1.41 1.41',
    moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z',
    contrast: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M12 18a6 6 0 0 0 0-12z'
  }

  const d = $derived(PATHS[name] || PATHS.settings)
</script>

<svg class="ico" width={size} height={size} viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round"
     aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label}>
  {#each d.split('|') as p}<path d={p} />{/each}
</svg>
