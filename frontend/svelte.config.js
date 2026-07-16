/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  // Die .input-group-Labels stehen als Beschriftung ueber ihrem Control (wie im
  // Vanilla-Tool), sind aber nicht per for=/Wrapping assoziiert. Diese eine
  // a11y-Regel unterdruecken, damit echte Warnungen sichtbar bleiben.
  onwarn: (warning, handler) => {
    if (warning.code === 'a11y_label_has_associated_control') return
    handler(warning)
  }
}
