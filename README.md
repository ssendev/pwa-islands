<p align="center">
  <img src="src/assets/pwa-islands.svg" alt="PWA Islands" width="128" height="128" />
</p>

<h1 align="center">PWA Islands</h1>

<p align="center">
  <em>Drop in HTML files, run them on a secure origin—no <code>file://</code>, no server, no internet needed.</em>
</p>

PWA Islands lets you store, edit, and run single-file `.html` mini-apps locally on a secure origin. Use it directly <a href="https://pwaislands.ssen.dev">in the browser as an offline-capable PWA</a>, or install it as a <a href="https://github.com/ssendev/pwa-islands/releases">native desktop/mobile app.</a>

## Features

- **Offline-first & secure origin** — Run local `.html` files without `file://` restrictions or an internet connection.
- **PWA & Tauri** — Works in the browser (File System API) and as a native app (Linux, Windows, macOS, Android).
- **Built-in editor** — Inspect and edit your HTML apps in place with Monaco Editor.
- **Islands API** — Give your mini-apps read/write access to files in the selected workspace folder.
- **Multilingual UI** — Supports English and German.

## Islands API

Mini-apps can import the public API from `/api.js` (typed in [src/api-types.ts](src/api-types.ts)) to work with files in the active directory:

```html
<script type="module">
  import islands from "/api.js"

  const entries = await islands.list()
  await islands.write("notes/hello.txt", "Hello from an island!", { overwrite: true })
  const text = await islands.read("notes/hello.txt")
</script>
```

## Development

```bash
npm install
npm run dev        # Start the Vite dev server (PWA)
npm run tauri:dev  # Start the Tauri desktop app
```

### Common Scripts

```bash
npm run build      # Build the PWA
npm run tauri:build # Build the Tauri app
npm run test       # Run tests (Vitest)
npm run fix        # Format, lint, and typecheck
```
