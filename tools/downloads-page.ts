import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { Plugin } from "vite"

export interface DownloadItem {
  id: string
  platform: string
  title: string
  filename: string
  url: string
  size: string
  bytes: number
  sha256: string
  arch: string
  format: string
  description: string
  command?: string
  hint?: string
  sourcePath?: string
}

export interface DownloadsManifest {
  version: string
  updatedAt: string
  downloads: DownloadItem[]
}

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const computeSha256 = (filePath: string): string => {
  const buffer = readFileSync(filePath)
  return createHash("sha256").update(buffer).digest("hex")
}

const findFiles = (dir: string, predicate: (name: string) => boolean): string[] => {
  if (!existsSync(dir)) return []
  const results: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, predicate))
    } else if (entry.isFile() && predicate(entry.name)) {
      results.push(fullPath)
    }
  }
  return results
}

export function readTauriVersion(rootDir: string): string {
  const tauriConfPath = join(rootDir, "src-tauri", "tauri.conf.json")
  if (existsSync(tauriConfPath)) {
    try {
      const conf = JSON.parse(readFileSync(tauriConfPath, "utf8")) as { version?: string }
      if (conf.version) {
        return conf.version
      }
    } catch {
      // Fallback below
    }
  }
  return "0.1.0"
}

export interface ParsedVersion {
  raw: string
  major: number
  minor: number
  patch: number
  build: number
}

/**
 * Parst eine Versionsnummer aus einem Dateinamen oder String.
 * Erkennt gängige Muster wie:
 * - 0.1.125
 * - 0.1.125-1 (RPM)
 * - _0.1.125_
 */
export function parseVersionString(str: string): ParsedVersion | null {
  const match = str.match(/(?:^|[-_v])(\d+)\.(\d+)(?:\.(\d+))?(?:-(\d+))?/)
  if (!match) return null

  return {
    raw: `${match[1]}.${match[2]}${match[3] !== undefined ? `.${match[3]}` : ""}`,
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3] !== undefined ? parseInt(match[3], 10) : 0,
    build: match[4] !== undefined ? parseInt(match[4], 10) : 0,
  }
}

/**
 * Vergleicht zwei Versionen. Gibt > 0 zurück wenn a > b, < 0 wenn a < b, 0 wenn gleich.
 */
export function compareParsedVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  return a.build - b.build
}

function readApkMetadata(apkPath: string): { versionName?: string; versionCode?: number } {
  try {
    const dir = dirname(apkPath)
    const metaPath = join(dir, "output-metadata.json")
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        elements?: Array<{ versionName?: string; versionCode?: number }>
      }
      const element = meta.elements?.[0]
      if (element) {
        return {
          versionName: element.versionName,
          versionCode: element.versionCode,
        }
      }
    }
  } catch {
    // Fallback
  }
  return {}
}

/**
 * Filtert eine Liste von Downloads, sodass von jeder Paketart (Plattform + Format + Architektur)
 * nur die höchste Version übrig bleibt.
 */
export function filterHighestVersionPerKind(items: DownloadItem[]): DownloadItem[] {
  const groups = new Map<string, DownloadItem[]>()
  const order: string[] = []

  for (const item of items) {
    const key = `${item.platform}:${item.format}:${item.arch}`.toLowerCase()
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(item)
  }

  const result: DownloadItem[] = []

  for (const key of order) {
    const list = groups.get(key)
    if (!list || list.length === 0) continue

    if (list.length === 1) {
      result.push(list[0])
      continue
    }

    list.sort((a, b) => {
      const vA =
        parseVersionString(a.filename) ?? (a.sourcePath ? parseVersionString(a.sourcePath) : null)
      const vB =
        parseVersionString(b.filename) ?? (b.sourcePath ? parseVersionString(b.sourcePath) : null)

      if (vA && vB) {
        const cmp = compareParsedVersions(vA, vB)
        if (cmp !== 0) return -cmp // Höchste Version zuerst
      } else if (vA && !vB) {
        return -1
      } else if (!vA && vB) {
        return 1
      }

      const mtimeA = a.sourcePath && existsSync(a.sourcePath) ? statSync(a.sourcePath).mtimeMs : 0
      const mtimeB = b.sourcePath && existsSync(b.sourcePath) ? statSync(b.sourcePath).mtimeMs : 0
      return mtimeB - mtimeA
    })

    result.push(list[0])
  }

  return result
}

export interface ScanDownloadsOptions {
  targets?: string[]
}

/**
 * Scannt die tatsächlichen Build-Ausgaben in src-tauri dynamisch und erstellt
 * das Manifest aus den gefundenen Binärdateien.
 * Unterstützt Filterung nach erlaubten Zielen.
 */
export function scanAvailableDownloads(
  rootDir: string,
  options?: ScanDownloadsOptions | string[],
): DownloadsManifest {
  const version = readTauriVersion(rootDir)
  const downloads: DownloadItem[] = []

  const targetList = options
    ? (Array.isArray(options) ? options : options.targets)?.map((t) => t.toLowerCase().trim())
    : undefined

  const isTargetAllowed = (format: string): boolean => {
    if (!targetList || targetList.length === 0 || targetList.includes("all")) {
      return true
    }
    // Wenn ausschließlich "web" gewählt wurde, sind keine nativen Installer erlaubt
    if (targetList.includes("web") && targetList.length === 1) {
      return false
    }
    const fmt = format.toLowerCase()
    if (fmt === "apk" && (targetList.includes("apk") || targetList.includes("android"))) {
      return true
    }
    return targetList.includes(fmt)
  }

  // 1. Linux AppImage
  if (isTargetAllowed("appimage")) {
    const appImages = findFiles(
      join(rootDir, "src-tauri", "target", "release", "bundle", "appimage"),
      (f) => f.endsWith(".AppImage"),
    )
    for (const src of appImages) {
      const stat = statSync(src)
      downloads.push({
        id: "linux-appimage",
        platform: "Linux",
        title: "Linux AppImage",
        filename: basename(src),
        url: `/downloads/${basename(src)}`,
        size: formatSize(stat.size),
        bytes: stat.size,
        sha256: computeSha256(src),
        arch: "x86_64",
        format: "AppImage",
        description:
          "Universelles Linux-Paket, das auf modernen Distributionen direkt ohne Installation ausgeführt werden kann.",
        command: `chmod +x ${basename(src)} && ./${basename(src)}`,
        hint: "Datei im Terminal ausführbar machen und ausführen, oder in den Dateieigenschaften 'Ausführen als Programm' aktivieren.",
        sourcePath: src,
      })
    }
  }

  // 2. Linux Debian (.deb)
  if (isTargetAllowed("deb")) {
    const debs = findFiles(join(rootDir, "src-tauri", "target", "release", "bundle", "deb"), (f) =>
      f.endsWith(".deb"),
    )
    for (const src of debs) {
      const stat = statSync(src)
      downloads.push({
        id: "linux-deb",
        platform: "Linux",
        title: "Debian / Ubuntu (.deb)",
        filename: basename(src),
        url: `/downloads/${basename(src)}`,
        size: formatSize(stat.size),
        bytes: stat.size,
        sha256: computeSha256(src),
        arch: "amd64",
        format: "deb",
        description:
          "Installationspaket für Debian, Ubuntu, Linux Mint, Pop!_OS und verwandte Distributionen.",
        command: `sudo dpkg -i ${basename(src)}`,
        hint: "Per Terminal mit dpkg oder durch Doppelklick im Software-Center installieren.",
        sourcePath: src,
      })
    }
  }

  // 3. Linux RPM (.rpm)
  if (isTargetAllowed("rpm")) {
    const rpms = findFiles(join(rootDir, "src-tauri", "target", "release", "bundle", "rpm"), (f) =>
      f.endsWith(".rpm"),
    )
    for (const src of rpms) {
      const stat = statSync(src)
      downloads.push({
        id: "linux-rpm",
        platform: "Linux",
        title: "Fedora / openSUSE (.rpm)",
        filename: basename(src),
        url: `/downloads/${basename(src)}`,
        size: formatSize(stat.size),
        bytes: stat.size,
        sha256: computeSha256(src),
        arch: "x86_64",
        format: "rpm",
        description: "RPM-Paket für Fedora, RHEL, openSUSE, CentOS und kompatible Systeme.",
        command: `sudo dnf install ./${basename(src)}`,
        hint: "Per Terminal mit dnf oder über das Paketverwaltungsprogramm Ihrer Distribution installieren.",
        sourcePath: src,
      })
    }
  }

  // 4. Android APK (.apk)
  if (isTargetAllowed("apk")) {
    const apks = findFiles(
      join(rootDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk"),
      (f) => f.endsWith(".apk") && !f.includes("androidTest"),
    )
    for (const src of apks) {
      const stat = statSync(src)
      const apkMeta = readApkMetadata(src)
      const targetVersion = apkMeta.versionName ?? version
      const targetFilename = `pwa-islands_${targetVersion}_universal.apk`
      downloads.push({
        id: "android-apk",
        platform: "Android",
        title: "Android (.apk)",
        filename: targetFilename,
        url: `/downloads/${targetFilename}`,
        size: formatSize(stat.size),
        bytes: stat.size,
        sha256: computeSha256(src),
        arch: "universal",
        format: "apk",
        description:
          "Installationsdatei für Android-Smartphones und -Tablets mit nativer Dateisystem-Integration.",
        command: `adb install -r ${targetFilename}`,
        hint: "APK auf das Smartphone laden, öffnen und Installation bestätigen (ggf. 'Unbekannte Quellen' erlauben), oder per USB-Debugging mit adb installieren.",
        sourcePath: src,
      })
    }
  }

  // 5. Windows / macOS (falls vorhanden)
  if (isTargetAllowed("exe") || isTargetAllowed("nsis") || isTargetAllowed("windows")) {
    const exes = findFiles(join(rootDir, "src-tauri", "target", "release", "bundle", "nsis"), (f) =>
      f.endsWith(".exe"),
    )
    for (const src of exes) {
      const stat = statSync(src)
      downloads.push({
        id: "windows-exe",
        platform: "Windows",
        title: "Windows Installer (.exe)",
        filename: basename(src),
        url: `/downloads/${basename(src)}`,
        size: formatSize(stat.size),
        bytes: stat.size,
        sha256: computeSha256(src),
        arch: "x64",
        format: "exe",
        description: "Installationsprogramm für Windows 10/11.",
        command: `.\\${basename(src)}`,
        hint: "Setup-Datei per Doppelklick öffnen und den Schritten des Assistenten folgen.",
        sourcePath: src,
      })
    }
  }

  if (isTargetAllowed("dmg") || isTargetAllowed("macos")) {
    const dmgs = findFiles(join(rootDir, "src-tauri", "target", "release", "bundle", "dmg"), (f) =>
      f.endsWith(".dmg"),
    )
    for (const src of dmgs) {
      const stat = statSync(src)
      downloads.push({
        id: "macos-dmg",
        platform: "macOS",
        title: "macOS (.dmg)",
        filename: basename(src),
        url: `/downloads/${basename(src)}`,
        size: formatSize(stat.size),
        bytes: stat.size,
        sha256: computeSha256(src),
        arch: "universal",
        format: "dmg",
        description: "Apple Disk Image für macOS.",
        command: `open ${basename(src)}`,
        hint: "DMG-Datei öffnen und das Symbol in den Programme-Ordner ziehen.",
        sourcePath: src,
      })
    }
  }

  const filteredDownloads = filterHighestVersionPerKind(downloads)

  let manifestVersion = version
  let parsedManifestVersion = parseVersionString(manifestVersion)

  for (const item of filteredDownloads) {
    const parsed = parseVersionString(item.filename)
    if (parsed) {
      if (!parsedManifestVersion || compareParsedVersions(parsed, parsedManifestVersion) > 0) {
        parsedManifestVersion = parsed
        manifestVersion = parsed.raw
      }
    }
  }

  return {
    version: manifestVersion,
    updatedAt: new Date().toISOString(),
    downloads: filteredDownloads,
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export function renderDownloadsHtml(manifest: DownloadsManifest): string {
  const cardsHtml =
    manifest.downloads.length === 0
      ? `
      <div class="empty-state">
        <p>Aktuell sind noch keine Build-Pakete gebaut.</p>
        <p class="empty-state-hint">Führen Sie <code>npm run tauri:build</code> aus, um die Desktop- und Mobilpakete zu erstellen.</p>
      </div>
    `
      : manifest.downloads
          .map((item) => {
            const commandBlock = item.command
              ? `
        <div class="code-block">
          <div class="code-header">
            <span>Terminal-Befehl:</span>
            <button class="copy-btn" data-copy="${escapeHtml(item.command)}" title="In die Zwischenablage kopieren">Kopieren</button>
          </div>
          <code>${escapeHtml(item.command)}</code>
        </div>
      `
              : ""

            const hintBlock = item.hint
              ? `
        <p class="card-hint"><span class="hint-label">Hinweis:</span> ${escapeHtml(item.hint)}</p>
      `
              : ""

            const shaBlock = item.sha256
              ? `
        <div class="sha-line">
          <span class="sha-label">SHA-256:</span>
          <code class="sha-code">${escapeHtml(item.sha256.substring(0, 16))}…</code>
          <button class="copy-btn-mini" data-copy="${escapeHtml(item.sha256)}" title="Vollständigen SHA-256 Hash kopieren">Kopieren</button>
        </div>
      `
              : ""

            return `
      <article class="download-card" id="${escapeHtml(item.id)}">
        <div class="card-header">
          <div class="card-title-group">
            <span class="platform-tag platform-${escapeHtml(item.platform.toLowerCase())}">${escapeHtml(item.platform)}</span>
            <h2 class="card-title">${escapeHtml(item.title)}</h2>
          </div>
          <div class="card-meta">
            <span class="meta-pill meta-size">${escapeHtml(item.size)}</span>
            <span class="meta-pill meta-arch">${escapeHtml(item.arch)}</span>
          </div>
        </div>

        <p class="card-description">${escapeHtml(item.description)}</p>

        ${hintBlock}
        ${commandBlock}
        ${shaBlock}

        <div class="card-footer">
          <a class="download-button" href="${escapeHtml(item.url)}" download="${escapeHtml(item.filename)}">
            <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>${escapeHtml(item.filename)} herunterladen</span>
          </a>
        </div>
      </article>
      `
          })
          .join("\n")

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Downloads — PWA Islands</title>
  <meta name="description" content="Offizielle Downloads für PWA Islands: Native Versionen für Linux (AppImage, deb, rpm) und Android (APK) mit Dateisystem-Integration." />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root {
      --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-hover: #f1f5f9;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #aa3bff;
      --accent-hover: #9333ea;
      --accent-light: rgba(170, 59, 255, 0.1);
      --radius: 12px;
      --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0f19;
        --surface: #131c2e;
        --surface-hover: #1e293b;
        --border: #26334d;
        --text: #f8fafc;
        --text-muted: #94a3b8;
        --accent: #c084fc;
        --accent-hover: #d8b4fe;
        --accent-light: rgba(192, 132, 252, 0.15);
        --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.2);
        --shadow-lg: 0 10px 20px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.3);
      }
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font);
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 1rem 1.5rem;
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(8px);
    }

    .nav-container {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .brand-link {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      text-decoration: none;
      color: var(--text);
      font-weight: 600;
      font-size: 1.15rem;
    }

    .brand-logo {
      width: 32px;
      height: 32px;
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 500;
      transition: background 0.2s, border-color 0.2s;
    }

    .back-btn:hover {
      background: var(--surface-hover);
      border-color: var(--accent);
    }

    main {
      flex: 1;
      max-width: 1100px;
      width: 100%;
      margin: 0 auto;
      padding: 3rem 1.5rem;
    }

    .hero {
      text-align: center;
      margin-bottom: 3rem;
    }

    .hero-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      background: var(--accent-light);
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }

    .hero h1 {
      font-size: 2.75rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      margin-bottom: 0.75rem;
    }

    .hero p {
      font-size: 1.2rem;
      color: var(--text-muted);
      max-width: 650px;
      margin: 0 auto;
    }

    .downloads-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3.5rem;
    }

    .empty-state {
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
      padding: 3rem 1.5rem;
      text-align: center;
      color: var(--text-muted);
    }

    .empty-state-hint {
      margin-top: 0.75rem;
      font-size: 0.9rem;
    }

    .empty-state-hint code {
      font-family: var(--mono);
      background: var(--bg);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    .download-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow);
      transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
    }

    .download-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-lg);
      border-color: var(--accent);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 1rem;
      gap: 0.5rem;
    }

    .card-title-group {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .platform-tag {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--accent);
    }

    .card-title {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    .card-meta {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }

    .meta-pill {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      background: var(--surface-hover);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .card-description {
      color: var(--text-muted);
      font-size: 0.95rem;
      margin-bottom: 1rem;
      flex: 1;
    }

    .card-hint {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 0.9rem;
      line-height: 1.45;
    }

    .hint-label {
      font-weight: 600;
      color: var(--text);
    }

    .code-block {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem;
      margin-bottom: 1rem;
      font-family: var(--mono);
      font-size: 0.85rem;
    }

    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.4rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      font-weight: 600;
    }

    .code-block code {
      display: block;
      overflow-x: auto;
      white-space: pre;
      color: var(--text);
    }

    .copy-btn, .copy-btn-mini {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .copy-btn:hover, .copy-btn-mini:hover {
      background: var(--surface-hover);
      border-color: var(--accent);
    }

    .sha-line {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1.25rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .sha-code {
      font-family: var(--mono);
      background: var(--bg);
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    .card-footer {
      margin-top: auto;
    }

    .download-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--accent);
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.95rem;
      border-radius: var(--radius);
      transition: background 0.2s, transform 0.1s;
    }

    .download-button:hover {
      background: var(--accent-hover);
    }

    .download-button:active {
      transform: scale(0.99);
    }

    .info-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 2rem;
      box-shadow: var(--shadow);
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 2rem;
    }

    .info-box h3 {
      font-size: 1.2rem;
      margin-bottom: 0.75rem;
    }

    .info-box ul {
      list-style-type: disc;
      padding-left: 1.25rem;
      color: var(--text-muted);
      font-size: 0.95rem;
    }

    .info-box li {
      margin-bottom: 0.4rem;
    }

    .info-box p {
      color: var(--text-muted);
      font-size: 0.95rem;
    }

    footer {
      border-top: 1px solid var(--border);
      padding: 2rem 1.5rem;
      text-align: center;
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: #10b981;
      color: #ffffff;
      padding: 0.75rem 1.25rem;
      border-radius: var(--radius);
      font-weight: 600;
      font-size: 0.9rem;
      box-shadow: var(--shadow-lg);
      transform: translateY(100px);
      opacity: 0;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s;
      z-index: 100;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body>
  <header>
    <div class="nav-container">
      <a href="/" class="brand-link">
        <img src="/favicon.svg" alt="PWA Islands Icon" class="brand-logo" />
        <span>PWA Islands</span>
      </a>
    </div>
  </header>

  <main>
    <section class="hero">
      <span class="hero-badge">Version ${escapeHtml(manifest.version)}</span>
      <h1>Downloads</h1>
      <p>PWA Islands als native Anwendung für Linux und Android. Genießen Sie dauerhaften Offline-Zugriff und direkte Dateisystem-Integration.</p>
    </section>

    <section class="downloads-grid">
      ${cardsHtml}
    </section>

    <section class="info-section">
      <div class="info-box">
        <h3>Vorteile der nativen Tauri-Apps</h3>
        <ul>
          <li>Direkter Zugriff auf das lokale Dateisystem ohne wiederholte Browser-Freigabedialoge.</li>
          <li>100% offline-fähig: Funktioniert ohne jegliche Internetverbindung.</li>
          <li>Eigenständiges Fenster ohne Browser-Symbolleisten oder störende URL-Leisten.</li>
          <li>Volle Unterstützung aller Islands-APIs für lokale HTML-Anwendungen.</li>
        </ul>
      </div>

      <div class="info-box">
        <h3>Direkt im Browser nutzen</h3>
        <p>Sie möchten keine Anwendung installieren? PWA Islands läuft auch direkt im modernen Webbrowser mit voller Unterstützung für die File System Access API und OPFS.</p>
        <p style="margin-top: 0.75rem;">
          <a href="/" class="back-btn">Web-Version im Browser öffnen</a>
        </p>
      </div>
    </section>
  </main>

  <footer>
    <p>PWA Islands · Offline-fähige HTML-Anwendungen mit Dateisystem-API</p>
  </footer>

  <div id="toast" class="toast">In die Zwischenablage kopiert!</div>

  <script>
    document.addEventListener("DOMContentLoaded", () => {
      const toast = document.getElementById("toast");
      let toastTimer = null;

      function showToast(msg) {
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add("show");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toast.classList.remove("show");
        }, 2200);
      }

      document.querySelectorAll("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const text = btn.getAttribute("data-copy");
          if (!text) return;
          try {
            await navigator.clipboard.writeText(text);
            showToast("Befehl in die Zwischenablage kopiert!");
          } catch (err) {
            console.error("Kopieren fehlgeschlagen:", err);
          }
        });
      });
    });
  </script>
</body>
</html>
`
}

/**
 * Vite Dev-Server Middleware:
 * Bedient /downloads und /downloads/index.html während der lokalen Entwicklung.
 * Der Vite-Build selbst emittiert /downloads NICHT, sondern überlässt dies
 * dem Standalone-Skript scripts/prepare-downloads.mjs.
 */
export function downloadsPlugin(): Plugin {
  let root = process.cwd()

  return {
    name: "pwa-islands:downloads-server",
    configResolved(config) {
      root = config.root
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0]
        if (url === "/downloads" || url === "/downloads/" || url === "/downloads/index.html") {
          const manifest = scanAvailableDownloads(root)
          const html = renderDownloadsHtml(manifest)
          res.setHeader("Content-Type", "text/html; charset=utf-8")
          res.end(html)
          return
        }
        if (url === "/downloads/downloads.json") {
          const manifest = scanAvailableDownloads(root)
          res.setHeader("Content-Type", "application/json; charset=utf-8")
          res.end(JSON.stringify(manifest, null, 2))
          return
        }
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0]
        if (url === "/downloads") {
          res.writeHead(302, { Location: "/downloads/" })
          res.end()
          return
        }
        next()
      })
    },
  }
}
