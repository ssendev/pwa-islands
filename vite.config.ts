import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: 'pwaislands.localhost',
  },

  plugins: [VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    registerType: 'autoUpdate',
    injectRegister: false,

    pwaAssets: {
      disabled: false,
      config: true,
    },

    manifest: {
      name: 'PWA Islands',
      short_name: 'PWA Islands',
      description: 'Offline-capable progressive web application islands',
      theme_color: '#2e69c9',
      background_color: '#2e69c9',
      display: "fullscreen"
    },

    injectManifest: {
      globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
    },

    devOptions: {
      enabled: true,
      type: 'module',
    },
  })],
})
