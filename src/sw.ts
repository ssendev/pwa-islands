/// <reference lib="webworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from "workbox-precaching"
import { clientsClaim } from "workbox-core"
import { registerRoute } from "workbox-routing"
import { findSavedFile, getMimeType, ISLAND_PARAM } from "./storage.ts"

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>
}

void self.skipWaiting()
clientsClaim()

// Nur EINE Referenz auf self.__WB_MANIFEST erlaubt (vite-plugin-pwa ersetzt
// genau ein Vorkommen). Deshalb hier einmal in eine lokale Variable legen.
const precacheManifest: Array<string | { revision: string | null; url: string }> =
  self.__WB_MANIFEST || []

precacheAndRoute(precacheManifest)
cleanupOutdatedCaches()

// Die Datei-API (/api.js, /api.d.ts) liegt ungehasht im dist/Wurzelverzeichnis
// und steht in Produktion im Precache-Manifest, wird also von precacheAndRoute
// bedient. In der Entwicklung liefert das Vite-Plugin (vite.config.ts) die
// Dateien direkt aus. In beiden Fällen sind es daher nie gespeicherte Dateien:
// die Pfade werden in isInternalPath() ausgenommen (siehe unten),
// dedizierte Routen sind nicht nötig.

// Intercept requests for saved files directly at the root (z. B. /foo.html,
// /script.js). Der Pfad ist der Pfad der gespeicherten Datei. Falls unter dem
// Pfad keine Datei liegt – oder ?pwaislands gesetzt ist – wird die App-Shell
// ausgeliefert. Damit sind auch / und /files ohne gespeicherte index.html
// automatisch die App.
// WICHTIG: Der Handler wird erst zur Laufzeit erzeugt (appShell). In Dev ist das
// Precaching-Manifest leer, dann wirft createHandlerBoundToURL('index.html')
// einen non-precached-url-Fehler und die SW-Evaluation schlägt fehl.
registerRoute(
  ({ request, sameOrigin }) => sameOrigin && request.mode === "navigate",
  async ({ request, url, event }) => {
    // Mit ?pwaislands wird immer die App-Shell ausgeliefert – auch wenn unter
    // dem Pfad eine gespeicherte Datei liegt. Damit lässt sich eine Island
    // aufrufen und bearbeiten, statt sie zu rendern.
    if (url.searchParams.has(ISLAND_PARAM)) {
      return appShell(request, url, event)
    }

    // /foo.html -> gespeicherte Datei foo.html; / -> index.html; /foo ->
    // foo/index.html (wie bei einem Webserver mit Index-Datei).
    const relativePath = resolveRequestPath(url.pathname)

    try {
      const file = await findSavedFile(relativePath)
      if (file) {
        const mimeType = getMimeType(relativePath, file.type)
        return new Response(file, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Content-Length": file.size.toString(),
            "Cache-Control": "no-cache",
          },
        })
      }
    } catch (err) {
      console.error("SW: Fehler beim Laden der Datei:", err)
    }

    // Datei nicht gefunden: App-Shell ausliefern, damit die App eine deutsche
    // 404-/„Ordner wählen"-Meldung zeigen kann.
    return appShell(request, url, event)
  },
)

// Sub-Ressourcen gespeicherter Dateien (nicht-navigationale Requests, z. B. CSS,
// JS oder Bilder, die eine Island-Datei relativ nachlädt).
// App-eigene Dateien und Vite-Dev-Pfade (/src/, /@vite/, /node_modules/, /@fs/)
// werden nie als gespeicherte Dateien behandelt (siehe isInternalPath()).
registerRoute(
  ({ request, url, sameOrigin }) =>
    sameOrigin &&
    url.pathname !== "/" &&
    !isInternalPath(url.pathname) &&
    request.mode !== "navigate",
  async ({ request, url }) => {
    const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ""))
    try {
      const file = relativePath ? await findSavedFile(relativePath) : null
      if (file) {
        const mimeType = getMimeType(relativePath, file.type)
        return new Response(file, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Content-Length": file.size.toString(),
            "Cache-Control": "no-cache",
          },
        })
      }
    } catch (err) {
      console.error("SW: Fehler beim Laden der Datei:", err)
    }

    return fetch(request)
  },
)

// Catch-all für alle übrigen Navigationen (z. B. /irgendwas).
// Verhält sich wie die Startseite /: liefert die App-Shell aus dem Precache.
// Muss NACH den Datei-Routen registriert sein, greift aber ohnehin nur für
// nicht bereits erfasste Navigationen.
registerRoute(
  ({ request }) => request.mode === "navigate",
  ({ request, url, event }) => appShell(request, url, event),
)

/**
 * Bildet einen URL-Pfad auf den relativen Pfad der gespeicherten Datei ab.
 *
 * - "/"        -> "index.html"   (Wurzel-Index)
 * - "/foo"     -> "foo/index.html" (Ordner-Index, wie bei einem Webserver)
 * - "/foo/"    -> "foo/index.html"
 * - "/foo/a.js" -> "foo/a.js"
 *
 * Der Index-Fallback gilt nur, wenn der letzte Pfadabschnitt keinen Punkt
 * enthält (also kein Dateiname mit Endung ist). Andernfalls würde z. B.
 * "/style.css" fälschlich zu "style.css/index.html".
 */
function resolveRequestPath(pathname: string): string {
  const decoded = decodeURIComponent(pathname)
  const trimmed = decoded.replace(/^\/+|\/+$/g, "")
  if (!trimmed) return "index.html"
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  if (lastSegment.includes(".")) return trimmed

  return `${trimmed}/index.html`
}

/**
 * Pfade, die nie gespeicherte Dateien sind und daher von der Datei-Route
 * ausgenommen werden.
 *
 * Zwei Gruppen:
 * - App-eigene Dateien, die es in jedem Build gibt (API, Manifest, App-Assets).
 * - Vite-Dev-Pfade, die nur im Entwicklungsmodus existieren. Sie werden per
 *   import.meta.env.DEV entfernt, damit sie im Produktions-SW nicht mitlaufen.
 */
function isInternalPath(pathname: string): boolean {
  // Immer ausgenommen: Dateien der App selbst.
  if (
    pathname === "/api.js" ||
    pathname === "/api.d.ts" ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/manifest.webmanifest") ||
    pathname === "/sw.js" ||
    pathname === "/registerSW.js"
  ) {
    return true
  }

  // Nur im Entwicklungsmodus vorhanden (Vite-Modulgraph).
  if (import.meta.env.DEV) {
    return (
      pathname.startsWith("/src/") ||
      pathname.startsWith("/@vite/") ||
      pathname.startsWith("/@fs/") ||
      pathname.startsWith("/@id/") ||
      pathname.startsWith("/node_modules/") ||
      pathname.startsWith("/dev-sw.js")
    )
  }

  return false
}

async function appShell(request: Request, url: URL, event: ExtendableEvent): Promise<Response> {
  try {
    const handler = createHandlerBoundToURL("index.html")
    return await handler({ request, url, event, params: {} })
  } catch (err) {
    console.error("SW: App-Shell konnte nicht geladen werden:", err)
    return fetch(request)
  }
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting()
  }
})
