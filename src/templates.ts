import { Schema } from "effect"
import { getFileExtension } from "./storage"

export const StarterTemplate = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  defaultFileName: Schema.String,
  content: Schema.String,
  isBuiltin: Schema.Boolean,
})
export type StarterTemplate = typeof StarterTemplate.Type

export const BUILTIN_TEMPLATES: ReadonlyArray<StarterTemplate> = [
  {
    id: "builtin:empty",
    label: "Leere Datei",
    defaultFileName: "Neu.html",
    content: "",
    isBuiltin: true,
  },
  {
    id: "builtin:island",
    label: "PWA Island (mit /api.js)",
    defaultFileName: "island.html",
    content: `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Meine Island</title>
    <style>
      *, *::before, *::after {
        box-sizing: border-box;
      }
      :root {
        color-scheme: light dark;
        font-family: system-ui, sans-serif;
        line-height: 1.5;
        overflow-wrap: break-word;
        text-wrap: pretty;
        font-size: 4vw; /* Portrait (taller than wide) */
      }
      @media (orientation: landscape) {
        :root {
          font-size: 2.25vw; /* Landscape (wider than tall) */
        }
      }
      body {
        margin: 0;
        padding: 0.5rem;
      }
      input, button, textarea, select {
        font: inherit;
      }
      img, svg, video {
        max-width: 100%;
        height: auto;
      }
      h1, h2, h3, h4, h5, h6 {
        text-wrap: balance;
      }
      pre {
        white-space: pre-wrap;
        background-color: light-dark(#f4f4f4, #2a2a2a);
      }
    </style>
  </head>
  <body>
    <header>
      <nav><a href="/?pwaislands">PWA Islands</a></nav>
    </header>
    <main>
      <h1>Meine Island</h1>
      <pre id="output">Lade Dateien…</pre>
    </main>

    <script type="module">
      import islands from "/api.js"

      const entries = await islands.list()
      document.getElementById("output").textContent = JSON.stringify(entries, null, 2)
    </script>
  </body>
</html>
`,
    isBuiltin: true,
  },
  {
    id: "builtin:html",
    label: "HTML5 Grundgerüst",
    defaultFileName: "index.html",
    content: `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Meine Island</title>
    <style>
      *, *::before, *::after {
        box-sizing: border-box;
      }
      :root {
        color-scheme: light dark;
        font-family: system-ui, sans-serif;
        line-height: 1.5;
        overflow-wrap: break-word;
        text-wrap: pretty;
        font-size: 4vw; /* Portrait (taller than wide) */
      }
      @media (orientation: landscape) {
        :root {
          font-size: 2.25vw; /* Landscape (wider than tall) */
        }
      }
      body {
        margin: 0;
        padding: 0.5rem;
      }
      input, button, textarea, select {
        font: inherit;
      }
      img, svg, video {
        max-width: 100%;
        height: auto;
      }
      h1, h2, h3, h4, h5, h6 {
        text-wrap: balance;
      }
      pre {
        white-space: pre-wrap;
        background-color: light-dark(#f4f4f4, #2a2a2a);
      }
    </style>
  </head>
  <body>
    <header>
      <nav><a href="/?pwaislands">PWA Islands</a></nav>
    </header>
    <main>
      <h1>Meine Island</h1>
    </main>
  </body>
</html>
`,
    isBuiltin: true,
  },
  {
    id: "builtin:json",
    label: "JSON-Datei",
    defaultFileName: "daten.json",
    content: `{\n  "hallo": [1,2,3],\n  "welt": "!"\n}\n`,
    isBuiltin: true,
  },
  {
    id: "builtin:markdown",
    label: "Markdown-Notiz",
    defaultFileName: "notiz.md",
    content: `# Notiz\n\n`,
    isBuiltin: true,
  },
]

export function replaceFileExtension(currentName: string, templateFileName: string): string {
  const templateExt = getFileExtension(templateFileName)
  const trimmed = currentName.trim()
  if (!trimmed) {
    return templateFileName
  }
  if (!templateExt) {
    return trimmed // Keep current extension if the template has none!
  }
  const lastDot = trimmed.lastIndexOf(".")
  const baseName = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed
  return `${baseName}.${templateExt}`
}
