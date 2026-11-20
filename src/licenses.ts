import { Array } from "effect"
import licensesData from "virtual:licenses-data"

export interface LocalizedDescription {
  readonly en: string
  readonly de: string
}

export interface SoftwareLicense {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly url: string
  readonly description?: LocalizedDescription
}

export const DIRECT_DESCRIPTIONS: Readonly<Record<string, LocalizedDescription>> = {
  "@effect/platform-browser": {
    en: "Browser platform bindings for Effect",
    de: "Browser-Plattform-Anbindung für Effect",
  },
  "@foldkit/ui": {
    en: "Accessible UI components for Foldkit",
    de: "Barrierefreie UI-Komponenten für Foldkit",
  },
  "@tauri-apps/api": {
    en: "JavaScript bridge for the Tauri desktop/mobile runtime",
    de: "JavaScript-Brücke für die Tauri-Desktop-/Mobil-Laufzeit",
  },
  effect: {
    en: "TypeScript functional effect system",
    de: "Funktionales TypeScript-Effektsystem",
  },
  foldkit: {
    en: "Elm-inspired application framework",
    de: "Elm-inspiriertes Anwendungs-Framework",
  },
  md4x: {
    en: "Markdown parser & renderer",
    de: "Markdown-Parser & -Renderer",
  },
  "monaco-editor": {
    en: "Built-in code editor",
    de: "Integrierter Code-Editor",
  },
  gtk: {
    en: "Linux GTK window & UI integration",
    de: "Linux-GTK-Fenster- & UI-Integration",
  },
  log: {
    en: "Rust logging facade",
    de: "Rust-Logging-Fassade",
  },
  mime: {
    en: "MIME type parsing & handling",
    de: "MIME-Typ-Verarbeitung",
  },
  mime_guess: {
    en: "MIME type detection by file extension",
    de: "MIME-Typ-Erkennung anhand der Dateiendung",
  },
  serde: {
    en: "Rust serialization framework",
    de: "Rust-Serialisierungs-Framework",
  },
  serde_json: {
    en: "JSON serialization for Rust",
    de: "JSON-Serialisierung für Rust",
  },
  tauri: {
    en: "Native desktop & mobile app runtime",
    de: "Native Desktop- & Mobil-Laufzeit",
  },
  "tauri-plugin-dialog": {
    en: "Native file & folder picker dialogs",
    de: "Native Datei- & Ordner-Auswahldialoge",
  },
  "tauri-plugin-log": {
    en: "Tauri logging plugin",
    de: "Tauri-Logging-Plugin",
  },
  url: {
    en: "URL parsing & manipulation",
    de: "URL-Parsing & -Verarbeitung",
  },
  urlencoding: {
    en: "Percent-encoding for URLs",
    de: "Prozent-Kodierung für URLs",
  },
}

const attachDescription = (entry: SoftwareLicense): SoftwareLicense => {
  const description = DIRECT_DESCRIPTIONS[entry.name]
  if (description === undefined) {
    return entry
  }
  return { ...entry, description }
}

export const NPM_DIRECT_RUNTIME_LICENSES: ReadonlyArray<SoftwareLicense> = Array.map(
  licensesData.npmDirectRuntime,
  attachDescription,
)

export const NPM_TRANSITIVE_RUNTIME_LICENSES: ReadonlyArray<SoftwareLicense> =
  licensesData.npmTransitiveRuntime

export const NPM_DIRECT_DEV_LICENSES: ReadonlyArray<SoftwareLicense> = licensesData.npmDirectDev

export const NPM_TRANSITIVE_DEV_LICENSES: ReadonlyArray<SoftwareLicense> =
  licensesData.npmTransitiveDev

export const TAURI_DIRECT_LICENSES: ReadonlyArray<SoftwareLicense> = Array.map(
  licensesData.rustDirect,
  attachDescription,
)

export const TAURI_TRANSITIVE_LICENSES: ReadonlyArray<SoftwareLicense> = licensesData.rustTransitive
