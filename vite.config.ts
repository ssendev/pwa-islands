import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [VitePWA({
    registerType: 'prompt',
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

    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      cleanupOutdatedCaches: true,
      clientsClaim: true,
    },

    devOptions: {
      enabled: false,
      type: 'module',
    },
  })],
})
