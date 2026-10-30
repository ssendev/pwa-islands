// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const allSvgPath = join(root, "node_modules", "@svgmoji", "noto", "sprites", "all.svg")
const outDir = join(root, "src", "assets", "noto")

const allSvg = readFileSync(allSvgPath, "utf-8")
mkdirSync(outDir, { recursive: true })

/** @type {Record<string, string>} */
const mapping = {
  folder: "1F4C1",
  "folder-open": "1F4C2",
  file: "1F4C4",
  "file-image": "1F5BC",
  "file-pdf": "1F4D5",
  "file-html": "1F310",
  "file-code": "1F4BB",
  "file-css": "1F3A8",
  "file-config": "1F527",
  "file-text": "1F4DD",
  "file-csv": "1F4CA",
  "file-audio": "1F3B5",
  "file-video": "1F3AC",
  "file-archive": "1F5C3",
  "file-font": "1F524",
  settings: "2699",
  help: "2753",
  "file-info": "2139",
  package: "1F4E6",
  plug: "1F50C",
  install: "1F4E5",
  plus: "2795",
  upload: "1F4E4",
  edit: "270F",
  lock: "1F512",
  warning: "26A0",
  save: "1F4BE",
  trash: "1F5D1",
  close: "2716",
  clipboard: "1F4CB",
  puzzle: "1F9E9",
  check: "2705",
  cross: "274C",
}

for (const [name, hex] of Object.entries(mapping)) {
  const start = allSvg.indexOf(`id="${hex}"`)
  if (start === -1) {
    throw new Error(`Hexcode ${hex} for ${name} not found in @svgmoji/noto sprites/all.svg`)
  }
  const open = allSvg.lastIndexOf("<svg", start)
  const close = allSvg.indexOf("</svg>", start) + 6
  let svg = allSvg.slice(open, close)

  // Ensure xmlns:xlink is present for files using xlink:href
  if (!svg.includes("xmlns:xlink")) {
    svg = svg.replace("<svg ", '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ')
  }

  writeFileSync(join(outDir, `${name}.svg`), svg, "utf-8")
}

console.log("Extracted 33 Noto SVG icons to src/assets/noto/")
