/// <reference lib="webworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from "workbox-precaching"
import { clientsClaim } from "workbox-core"
import { registerRoute } from "workbox-routing"
import {
  DEFAULT_INDEX_FILE,
  findSavedFile,
  getMimeType,
  ISLAND_PARAM,
  type SavedFile,
} from "./storage.ts"

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
    // foo/index.html (wie bei einem Webserver mit Index-Datei). Welcher Fall
    // gilt, entscheidet das Dateisystem -- nicht ein Punkt im letzten
    // Pfadabschnitt (siehe resolveRequestPath).
    const relativePath = resolveRequestPath(url.pathname)

    try {
      const saved = await findSavedFile(relativePath)
      if (saved) {
        return fileResponse(saved)
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
      const saved = relativePath ? await findSavedFile(relativePath) : null
      if (saved) {
        return fileResponse(saved)
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
 * - "/"         -> "index.html"   (Wurzel-Index)
 * - "/foo"      -> "foo"          (Datei foo oder Ordner mit Index-Datei)
 * - "/foo/"     -> "foo"
 * - "/foo/a.js" -> "foo/a.js"
 *
 * Ob der Pfad eine Datei oder ein Ordner ist, wird hier NICHT geraten. Frueher
 * entschied ein Punkt im letzten Abschnitt darueber, was Ordner mit Punkt im
 * Namen ("projekte/v1.2") unerreichbar machte. Die Entscheidung faellt jetzt in
 * findSavedFile() anhand des Dateisystems.
 *
 * Die Wurzel wird hier zu "index.html" statt zu "" -- findSavedFile() liefert
 * fuer den leeren Pfad bewusst null, damit Sub-Ressourcen-Anfragen nichts aus
 * dem Wurzelordner ziehen.
 */
function resolveRequestPath(pathname: string): string {
  const decoded = decodeURIComponent(pathname)
  const trimmed = decoded.replace(/^\/+|\/+$/g, "")
  return trimmed || DEFAULT_INDEX_FILE
}

/** Baut die Antwort fuer eine gefundene gespeicherte Datei. */
function fileResponse(saved: SavedFile): Response {
  // Der gespeicherte Pfad traegt die Endung -- auch beim Ordner-Index, dessen
  // URL-Pfad keine hat.
  const mimeType = getMimeType(saved.path, saved.file.type)
  return new Response(saved.file, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": saved.file.size.toString(),
      "Cache-Control": "no-cache",
    },
  })
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
