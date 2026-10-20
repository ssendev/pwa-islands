import { VitePWA } from "vite-plugin-pwa"
import { defineConfig, build, type Plugin } from "vite"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL(".", import.meta.url))
const apiTypesEntry = join(root, "src", "api-types.ts")
const apiDtsFile = join(root, ".generated", "api.d.ts")

const dtsHeader = `/**
 * PWA Islands – Typdeklarationen für die API.
 *
 * Verwendung in einer Island:
 *
 *   <script type="module">
 *     import islands from '/api.js'
 *     console.log(await islands.list())
 *   </script>
 */

`

const dtsFooter = `
/** Die Islands-API, die \`/api.js\` als Standard-Export bereitstellt. */
declare const islands: IslandsApi

declare module '*/api.js' {
  const islands: IslandsApi
  export default islands
}
`

/**
 * Erzeugt aus src/api-types.ts eine ambiente Typdeklaration (`api.d.ts`).
 * Vite selbst kann keine .d.ts erzeugen (es entfernt Typen nur), daher wird
 * hier der TypeScript-Compiler aufgerufen. Das Ergebnis wird gecacht.
 */
function buildApiDts(): string {
  const tmp = mkdtempSync(join(tmpdir(), "islands-dts-"))
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "bin", "tsc"),
        apiTypesEntry,
        "--ignoreConfig",
        "--declaration",
        "--emitDeclarationOnly",
        "--outDir",
        tmp,
        "--module",
        "esnext",
        "--target",
        "es2023",
        "--lib",
        "es2023,dom",
        "--strict",
        "--skipLibCheck",
      ],
      { stdio: "inherit" },
    )

    const emitted = readFileSync(join(tmp, "api-types.d.ts"), "utf8").trim()
    // Ambient machen: `export` entfernen, damit die Typen ohne Import global
    // verfügbar sind (Nutzung über `/// <reference path="/api.d.ts" />`).
    // Zusätzlich zwischen aufeinanderfolgenden Deklarationen eine Leerzeile
    // einfügen (tsc gibt sie ohne aus) und Mehrfach-Leerzeilen reduzieren.
    const flattened = emitted
      .replace(/^export /gm, "")
      // tsc gibt aufeinanderfolgende Deklarationen ohne Leerzeile aus.
      .replace(/([;}])\n(?=(?:type|interface|declare) )/g, "$1\n\n")
      .replace(/^\/\*\*\n/gm, "/**\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n+(?=\/(?:\*\*|\/))/g, "\n\n")
    return dtsHeader + flattened + "\n" + dtsFooter
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Bündelt src/api.ts zu einem eigenständigen ES-Modul, das die API als
 * Default-Export bereitstellt. Es gibt bewusst keine globale Variable: eine
 * Island bindet die API ausschließlich über
 * `import islands from '/api.js'` ein (in einem `<script type="module">`).
 * Wird in Dev und Build gleich verwendet, damit beide dasselbe liefern.
 */
async function buildApiJs(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "islands-api-"))
  try {
    await build({
      root,
      configFile: false,
      logLevel: "warn",
      publicDir: false,
      build: {
        outDir: tmp,
        emptyOutDir: false,
        write: true,
        // Vite 8 (rolldown) minifiziert ES-Lib-Builds mit `minify: true`/`'oxc'`
        // nicht (codegen bleibt aus). Terser liefert hier das erwartete Ergebnis.
        minify: "terser",
        lib: {
          entry: join(root, "src", "api.ts"),
          formats: ["es"],
          fileName: () => "api.js",
        },
      },
    })
    return readFileSync(join(tmp, "api.js"), "utf8")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Stellt die Datei-API unter stabilen Pfaden (ohne Hash) bereit:
 *
 * - src/api.ts wird als eigenständiges IIFE-Bundle `api.js` gebaut.
 * - `api.d.ts` wird aus src/api-types.ts generiert.
 * - In der Entwicklung werden beide Pfade über eine Middleware bedient,
 *   im Build als Assets in dist/ ausgegeben.
 *
 * Beide Dateien landen dadurch im dist/Wurzelverzeichnis und werden vom
 * Precache-Glob erfasst.
 */
function islandsApiPlugin(): Plugin[] {
  let dtsCache: string | null = null
  const getDts = () => (dtsCache ??= buildApiDts())

  // api.ts einmalig bündeln und das Ergebnis cachen (Dev und Build).
  let apiJsCache: Promise<string> | null = null
  const getApiJs = () =>
    (apiJsCache ??= buildApiJs().catch((err) => {
      apiJsCache = null
      throw err
    }))

  return [
    {
      name: "pwa-islands:api-serve",
      apply: "serve",
      configureServer(server) {
        // In Dev gibt es keinen Build-Schritt, der api.ts bündelt. Damit /api.js
        // trotzdem ein eigenständiges Skript ist (wie in Produktion, ohne
        // offene Imports), wird es hier gebündelt und zwischengespeichert.
        server.middlewares.use(async (req, res, next) => {
          const path = (req.url ?? "").split("?")[0]
          if (path === "/api.d.ts") {
            const dts = getDts()
            mkdirSync(dirname(apiDtsFile), { recursive: true })
            writeFileSync(apiDtsFile, dts, "utf8")
            res.setHeader("Content-Type", "application/typescript; charset=utf-8")
            res.end(dts)
            return
          }
          if (path === "/api.js") {
            try {
              const code = await getApiJs()
              res.setHeader("Content-Type", "text/javascript; charset=utf-8")
              res.end(code)
            } catch (err) {
              apiJsCache = null
              next(err as Error)
            }
            return
          }
          next()
        })
      },
    },
    {
      name: "pwa-islands:api-assets",
      apply: "build",
      async generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "api.d.ts",
          source: getDts(),
        })
        this.emitFile({
          type: "asset",
          fileName: "api.js",
          source: await getApiJs(),
        })
      },
    },
  ]
}

export default defineConfig({
  server: {
    host: "pwaislands.localhost",
  },

  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
      },
    },
  },

  plugins: [
    ...islandsApiPlugin(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,

      pwaAssets: {
        disabled: false,
        config: true,
      },

      manifest: {
        name: "PWA Islands",
        short_name: "PWA Islands",
        description: "Offline-capable progressive web application islands",
        theme_color: "#2e69c9",
        background_color: "#2e69c9",
        display: "fullscreen",
      },

      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,d.ts}"],

        // Vite 8 hat `inlineDynamicImports` durch `codeSplitting: false` ersetzt;
        // das Plugin setzt im Service-Worker-Build noch die alte Option.
        buildPlugins: {
          rollup: [
            {
              name: "pwa-islands:code-splitting",
              outputOptions: <T extends object>(outputOptions: T): T => ({
                ...outputOptions,
                codeSplitting: false,
                // Rolldown meldet sonst „inlineDynamicImports wird wegen
                // codeSplitting: false ignoriert“.
                inlineDynamicImports: undefined,
              }),
            },
          ],
        },
      },

      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
})
