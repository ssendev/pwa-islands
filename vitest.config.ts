import { defineConfig } from "vitest/config"
import { licensesPlugin } from "./tools/licenses.ts"
import { notoEmoji } from "./tools/noto-emoji.ts"

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("0.1.0"),
  },
  plugins: [licensesPlugin(), notoEmoji()],
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    environment: "happy-dom",
    isolate: false,
    setupFiles: ["./src/vitest-setup.ts"],
    server: {
      deps: {
        inline: ["foldkit", "@foldkit/ui", "@foldkit/devtools"],
      },
    },
  },
})
