import { defineConfig } from "vitest/config"
import { notoEmoji } from "./tools/noto-emoji.ts"

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("0.1.0"),
  },
  plugins: [notoEmoji()],
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    environment: "happy-dom",
    setupFiles: ["./src/vitest-setup.ts"],
    server: {
      deps: {
        inline: ["foldkit", "@foldkit/ui", "@foldkit/devtools"],
      },
    },
  },
})
