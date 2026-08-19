import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Frontend fuer den igeeks Security Policy Manager.
// Dev: `npm run dev` -> Vite auf :5173, /api wird ans Node-Backend geproxied.
// Prod: `npm run build` -> dist/, das der website-Container per nginx ausliefert.
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      // Backend lokal starten:  (cd api && PORT=3000 node server.js)
      '/api': { target: 'http://localhost:3000', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
