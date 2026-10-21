import { readFileSync } from "node:fs"
import { join } from "node:path"

import { instructions } from "@vite-pwa/assets-generator/api/instructions"
import { minimal2023Preset } from "@vite-pwa/assets-generator/config"

import type { VitePluginPWAAPI } from "vite-plugin-pwa"
import type { Plugin, ResolvedConfig } from "vite"

/**
 * Nur das Maskable-Icon austauschen -- alles andere erzeugt `vite-plugin-pwa`.
 *
 * Beim installierten Icon maskiert die Plattform selbst. Alles, was das Motiv
 * schon an den Rand malt -- Gloss-Verlauf, weisser Innenrahmen, runder Clip --
 * steht gegen diese Maske und hinterlaesst einen Saum. Diese Elemente tragen in
 * `public/favicon.svg` die Klasse `no-maskable`.
 *
 * Der Generator liest genau ein Bild und zeichnet daraus alle Icon-Arten, fuer
 * das Maskable-Icon braucht es also einen zweiten Durchlauf mit bereinigtem SVG.
 * Das laesst sich nicht konfigurieren: Der Aufruf steht im `closeBundle` von
 * `vite-plugin-pwa` und ueberschreibt mit `overrideAssets` fest auf `true`.
 *
 * Deshalb haengt sich dieses Plugin VOR das PWA-Paket und ersetzt in dessen
 * Anweisungen nur `maskable`. Das PWA-Paket liest die Anweisungen in
 * `generateBundle` (Manifest-Icons) und `closeBundle` (Dateien) aus demselben
 * Objekt -- steht die Ersetzung vorher, schreiben alle Beteiligten das richtige
 * Bild, ohne dass eine Datei nachtraeglich ueberschrieben wird.
 *
 * Die Reihenfolge kommt von `enforce: "pre"`: `vite-plugin-pwa` laeuft mit
 * `enforce: "pre"`, `vite-plugin-pwa:build` mit `enforce: "post"`, und Vite
 * haengt die Plugins aus der `plugins`-Liste in dieser Reihenfolge dazwischen
 * ein (siehe `resolvePlugins` in Vite).
 */
const ICON_SVG = "public/favicon.svg"
const OFF_CLASS = "no-maskable"

/**
 * Kein Polster fuer Maskable und Apple.
 *
 * Der Generator gibt beiden `padding: 0.3` auf Weiss vor -- richtig fuer ein
 * Motiv, das selbst schon Abstand zum Rand hat, falsch hier: Beide Plattformen
 * schneiden das Icon zu (Android und Chrome maskieren, iOS legt eine
 * Superellipse darueber), und ein Polster ist dann ein Rahmen, der stehen
 * bleibt. Das Motiv fuellt die Flaeche, den Rand machen die Plattformen.
 *
 * Einzige Stelle, an der die Werte fuer diese beiden Icons stehen:
 * `pwa-assets.config.ts` beschreibt nur die uebrigen.
 */
const PRESET = {
  ...minimal2023Preset,
  maskable: {
    ...minimal2023Preset.maskable,
    padding: 0,
  },
  apple: {
    ...minimal2023Preset.apple,
    padding: 0,
  },
}

/**
 * Elemente mit `class="no-maskable"` samt Inhalt entfernen.
 *
 * Der Clip-Path traegt die Klasse selbst und verschwindet damit ganz: Ein
 * leerer `<clipPath>` wuerde alles abschneiden, und der Verweis
 * `url(#appClip)` zeigt dann ins Leere -- das SVG bleibt dadurch gueltig.
 */
function stripOff(svg: string): string {
  const cls = `\\s+class\\s*=\\s*(["'])[^"']*${OFF_CLASS}[^"']*\\2`
  const empty = new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*?${cls}[^>]*/>`, "g")
  const nested = new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*?${cls}[^>]*>[\\s\\S]*?</\\1\\s*>`, "g")

  return svg.replace(nested, "").replace(empty, "")
}

export function maskableIcon(): Plugin {
  let config: ResolvedConfig

  return {
    name: "pwa-islands:maskable-icon",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved
    },
    async buildStart() {
      const generator = await pwaApi(config)?.pwaAssetsGenerator()

      if (!generator) {
        throw new Error(
          "pwa-islands:maskable-icon: kein Asset-Generator -- `pwaAssets` in vite.config.ts pruefen",
        )
      }

      const svg = readFileSync(join(config.root, ICON_SVG), "utf8")

      if (!svg.includes(OFF_CLASS)) {
        throw new Error(`pwa-islands:maskable-icon: in ${ICON_SVG} fehlt die Klasse "${OFF_CLASS}"`)
      }

      const stripped = stripOff(svg)

      if (stripped === svg) {
        throw new Error(
          `pwa-islands:maskable-icon: in ${ICON_SVG} wurde kein Element mit "${OFF_CLASS}" entfernt`,
        )
      }

      /*
       * Die Anweisungen des PWA-Pakets gehoeren ihm -- hier werden nur
       * `maskable` und `apple` ersetzt. Beide zeigen den Rand des Motivs der
       * Plattform, die sie zuschneidet: Android und Chrome maskieren, iOS legt
       * eine Superellipse darueber. Alles andere bleibt unveraendert, damit die
       * uebrigen Icons exakt die des Generators sind.
       */
      const own = generator.instructions()
      const replacement = await instructions({
        imageResolver: () => Buffer.from(stripped),
        imageName: "favicon.svg",
        preset: PRESET,
        faviconPreset: "2023",
        htmlLinks: { xhtml: false, includeId: false },
        basePath: "/",
        resolveSvgName: (name: string) => name.split("/").pop() ?? name,
      })

      own.maskable = replacement.maskable
      own.apple = replacement.apple
    },
  }
}

/**
 * Das API-Objekt des PWA-Pakets. Im Build ruft das Paket `api.prepare` nie auf,
 * das Plugin-Objekt traegt es aber trotzdem an der Konfiguration.
 */
function pwaApi(config: ResolvedConfig): VitePluginPWAAPI | undefined {
  return config.plugins.find((plugin) => plugin.name === "vite-plugin-pwa")?.api as
    | VitePluginPWAAPI
    | undefined
}
