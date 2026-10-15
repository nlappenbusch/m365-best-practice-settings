<script>
  // Ringanzeige fuer Prozentwerte (Secure Score, Compliance).
  let { value = null, size = 92, stroke = 9, label = '', sub = '' } = $props()
  let pct = $derived(value == null ? 0 : Math.max(0, Math.min(100, Number(value))))
  let tone = $derived(value == null ? 'neutral' : pct >= 70 ? 'ok' : pct >= 45 ? 'warn' : 'crit')
  let r = $derived((size - stroke) / 2)
  let circ = $derived(2 * Math.PI * r)
</script>

<div class="ring {tone}" style="width:{size}px;height:{size}px">
  <svg viewBox="0 0 {size} {size}" width={size} height={size} aria-hidden="true">
    <circle cx={size / 2} cy={size / 2} r={r} class="track" stroke-width={stroke} fill="none" />
    <circle cx={size / 2} cy={size / 2} r={r} class="val" stroke-width={stroke} fill="none"
      stroke-dasharray={circ} stroke-dashoffset={circ * (1 - pct / 100)} stroke-linecap="round"
      transform="rotate(-90 {size / 2} {size / 2})" />
  </svg>
  <div class="txt">
    <strong style="font-size:{Math.round(size / 4.6)}px">{value == null ? '—' : Math.round(value) + '%'}</strong>
    {#if label}<span>{label}</span>{/if}
    {#if sub}<em>{sub}</em>{/if}
  </div>
</div>

<style>
  .ring{position:relative;flex:none}
  .ring svg{display:block}
  .track{stroke:var(--bg-inset)}
  .val{transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1);stroke:var(--accent)}
  .ok .val{stroke:var(--ok)}.warn .val{stroke:var(--warn)}.crit .val{stroke:var(--crit)}.neutral .val{stroke:var(--rule)}
  .txt{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.05;text-align:center}
  .txt strong{font-weight:800;letter-spacing:-.03em}
  .txt span{font-size:.6rem;color:var(--text-faint);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-top:.15rem}
  .txt em{font-style:normal;font-size:.62rem;color:var(--text-dim);margin-top:.1rem}
</style>
