import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const root = fileURLToPath(new URL("..", import.meta.url))
const defaultCacheDir = join(root, ".generated", "noto-emoji")
const GOOGLE_NOTO_BASE_URL = "https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/svg"

/**
 * Wandelt ein Emoji (z. B. "📁.svg" oder "⚙️.svg") in den entsprechenden
 * Google Noto Dateinamen um (z. B. "emoji_u1f4c1.svg" bzw. "emoji_u2699.svg").
 */
export function emojiToNotoFilename(name: string): string {
  const clean = name.replace(/\.svg$/, "")
  const codePoints = Array.from(clean)
    .map((c) => c.codePointAt(0)!.toString(16).toLowerCase())
    .filter((h) => h !== "fe0f")
  return `emoji_u${codePoints.join("_")}.svg`
}

/**
 * Normalisiert den Dateinamen auf der Festplatte (entfernt Variationsselektoren wie FE0F).
 */
export function normalizeEmojiFilename(name: string): string {
  const clean = name.replace(/\.svg$/, "").replace(/\uFE0F/g, "")
  return `${clean}.svg`
}

export interface NotoEmojiOptions {
  readonly cacheDir?: string
}

const EMOJI_REGEX = /(?:^|[\\/]|@)emoji(?::|[\\/])(.+?\.svg)$/

/**
 * Vite-Plugin, das Emoji-SVG-Importe (z. B. `./emoji/📁.svg`) abfängt,
 * bei Bedarf aus dem offiziellen Google Noto Emoji Git herunterlädt,
 * im Cache-Verzeichnis (`.generated/noto-emoji`) speichert und als SVG-Asset auflöst.
 */
export function notoEmoji(options: NotoEmojiOptions = {}): Plugin {
  const cacheDir = options.cacheDir ?? defaultCacheDir
  const inFlight = new Map<string, Promise<string>>()

  async function ensureDownloaded(rawName: string): Promise<string> {
    const filename = normalizeEmojiFilename(rawName)
    const filePath = join(cacheDir, filename)

    if (existsSync(filePath)) {
      return filePath
    }

    const pending = inFlight.get(filename)
    if (pending) {
      return pending
    }

    const promise = (async () => {
      try {
        mkdirSync(cacheDir, { recursive: true })
        const notoName = emojiToNotoFilename(rawName)
        const url = `${GOOGLE_NOTO_BASE_URL}/${notoName}`
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error(
            `Failed to download Noto SVG for "${rawName}" from ${url}: ${res.status} ${res.statusText}`,
          )
        }
        let svg = await res.text()
        if (svg.includes("xlink:href") && !svg.includes("xmlns:xlink")) {
          svg = svg.replace("<svg ", '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ')
        }
        writeFileSync(filePath, svg, "utf-8")
        return filePath
      } finally {
        inFlight.delete(filename)
      }
    })()

    inFlight.set(filename, promise)
    return promise
  }

  return {
    name: "noto-emoji",
    async buildStart() {
      const iconsTsPath = join(root, "src", "icons.ts")
      if (!existsSync(iconsTsPath)) return
      const content = readFileSync(iconsTsPath, "utf-8")
      const matches = content.matchAll(new RegExp(EMOJI_REGEX.source, "g"))
      const downloads: Promise<string>[] = []
      for (const m of matches) {
        downloads.push(ensureDownloaded(m[1]))
      }
      if (downloads.length > 0) {
        await Promise.all(downloads)
      }
    },
    async resolveId(id) {
      const match = id.match(EMOJI_REGEX)
      if (match) {
        return await ensureDownloaded(match[1])
      }
      return null
    },
  }
}
