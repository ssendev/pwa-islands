# PWA Islands

Dies ist eine PWA welche mit der eine reihe von mini APPs (.html single file pages) mit FS API gespeichert und dann angezeigt werden können. Sie ist als PWA direkt in Browsern oder auch als Tauri App zum installieren verfügbar.

# UI

aller UI text MUSS in Deutsch geschrieben werden

# Befehle

prefer these over raw oxlint, oxfmt calls

`npm run -s build`
`npm run -s test`
`npm run -s format`
`npm run -s lint`
`npm run -s typecheck`
`npm run -s fix` runs `format && lint && typecheck`

# Islands-API

die .html projekte können die öffentliche API für Islands verwenden. Sie ist in `src/api-types.ts` definiert und wird mit `import islands from '/api.js'` eingebunden.

# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

## Project Notes

Domain vocabulary, deployment steps, local conventions that differ from Foldkit's defaults: write them here.
