import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  renderDownloadsHtml,
  scanAvailableDownloads,
  serializeDownloadsManifest,
} from "../tools/downloads-page.ts"

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const distDownloadsDir = join(rootDir, "dist", "downloads")

// Ermittle die erlaubten Build-Ziele (aus CLI-Argumenten oder Umgebungsvariable BUILD_TARGETS)
const cliArgs = process.argv.slice(2)
const envTargets = process.env.BUILD_TARGETS
  ? process.env.BUILD_TARGETS.split(/[\s,]+/).filter(Boolean)
  : undefined
const targets = cliArgs.length > 0 ? cliArgs : envTargets

// 1. Bereinige dist/downloads/ vollständig, damit keine alten Artefakte verbleiben
rmSync(distDownloadsDir, { recursive: true, force: true })
mkdirSync(distDownloadsDir, { recursive: true })

// 2. Scanne ausschließlich die in diesem Durchlauf tatsächlich gewählten Pakete
const manifest = scanAvailableDownloads(rootDir, { targets })

// 3. Kopiere die gefundenen Binärdateien nach dist/downloads/
for (const item of manifest.downloads) {
  if (item.sourcePath) {
    const destPath = join(distDownloadsDir, item.filename)
    copyFileSync(item.sourcePath, destPath)
    console.log(`[prepare-downloads] Copied ${item.filename} (${item.size})`)
  }
}

// 4. Schreibe downloads.json ausschließlich in dist/downloads/ (ohne sourcePath)
const manifestJson = serializeDownloadsManifest(manifest)
writeFileSync(join(distDownloadsDir, "downloads.json"), manifestJson, "utf8")
console.log(
  `[prepare-downloads] Generated dist/downloads/downloads.json with ${manifest.downloads.length} downloads`,
)

// 5. Emittiere das finale standalone dist/downloads/index.html
const html = renderDownloadsHtml(manifest)
writeFileSync(join(distDownloadsDir, "index.html"), html, "utf8")
console.log("[prepare-downloads] Emitted standalone dist/downloads/index.html")
