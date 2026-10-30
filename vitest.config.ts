import { defineConfig } from "vitest/config"
import { notoEmoji } from "./tools/noto-emoji.ts"

export default defineConfig({
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
