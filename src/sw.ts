/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { clientsClaim } from 'workbox-core'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { findSavedFile, getMimeType } from './storage.ts'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>
}

self.skipWaiting()
clientsClaim()

precacheAndRoute(self.__WB_MANIFEST || [])
cleanupOutdatedCaches()

// App-Shell nur noch für die App-Route /files. / wird von der Datei-Route
// unten behandelt (gespeicherte index.html); fehlt sie, greift der Catch-all
// und liefert die App-Shell aus dem Precache.
// WICHTIG: Handler erst zur Laufzeit erzeugen. In Dev ist das Precaching-Manifest
// leer, dann wirft createHandlerBoundToURL('index.html') einen non-precached-url-
// Fehler und die SW-Evaluation schlägt fehl.
registerRoute(
  new NavigationRoute(
    ({ request, url, event }) => appShell(request, url, event),
    { allowlist: [/^\/files\/?$/] }
  )
)

// Intercept requests for saved files directly at the root (z. B. /foo.html,
// /script.js). Der Pfad ist der Pfad der gespeicherten Datei; / steht dabei
// für index.html. Die App-Route /files wird vorher von der NavigationRoute
// abgefangen, daher ist hier kein /files-Ausschluss nötig.
registerRoute(
  ({ request, sameOrigin }) => sameOrigin && request.mode === 'navigate',
  async ({ request, url, event }) => {
    // /foo.html -> gespeicherte Datei foo.html; / -> index.html;
    // /foo -> foo/index.html (wie bei einem Webserver mit Index-Datei).
    const relativePath = resolveRequestPath(url.pathname)

    try {
      const file = await findSavedFile(relativePath)
      if (file) {
        const mimeType = getMimeType(relativePath, file.type)
        return new Response(file, {
          status: 200,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': file.size.toString(),
            'Cache-Control': 'no-cache',
          },
        })
      }
    } catch (err) {
      console.error('SW: Fehler beim Laden der Datei:', err)
    }

    // Datei nicht gefunden: App-Shell ausliefern, damit die App eine deutsche
    // 404-/„Ordner wählen"-Meldung zeigen kann.
    return appShell(request, url, event)
  }
)

// Sub-Ressourcen gespeicherter Dateien (nicht-navigationale Requests, z. B. CSS,
// JS oder Bilder, die eine Island-Datei relativ nachlädt).
// Vite-Dev-Pfade (/src/, /@vite/, /node_modules/, /@fs/) werden nie als
// gespeicherte Dateien behandelt, damit der Dev-Modulgraph intakt bleibt.
registerRoute(
  ({ request, url, sameOrigin }) =>
    sameOrigin &&
    url.pathname !== '/' &&
    !isDevInternalPath(url.pathname) &&
    request.mode !== 'navigate',
  async ({ request, url }) => {
    const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
    try {
      const file = relativePath ? await findSavedFile(relativePath) : null
      if (file) {
        const mimeType = getMimeType(relativePath, file.type)
        return new Response(file, {
          status: 200,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': file.size.toString(),
            'Cache-Control': 'no-cache',
          },
        })
      }
    } catch (err) {
      console.error('SW: Fehler beim Laden der Datei:', err)
    }

    return fetch(request)
  }
)

// Catch-all für alle übrigen Navigationen (z. B. /irgendwas).
// Verhält sich wie die Startseite /: liefert die App-Shell aus dem Precache.
// Muss NACH den Datei-Routen registriert sein, greift aber ohnehin nur für
// nicht bereits erfasste Navigationen.
registerRoute(
  ({ request }) => request.mode === 'navigate',
  ({ request, url, event }) => appShell(request, url, event)
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
  const trimmed = decoded.replace(/^\/+|\/+$/g, '')
  if (!trimmed) return 'index.html'

  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  if (lastSegment.includes('.')) return trimmed

  return `${trimmed}/index.html`
}

/** Vite-Dev-/Build-interne Pfade, die nie gespeicherte Dateien sind. */
function isDevInternalPath(pathname: string): boolean {
  return (
    pathname.startsWith('/src/') ||
    pathname.startsWith('/@vite/') ||
    pathname.startsWith('/@fs/') ||
    pathname.startsWith('/@id/') ||
    pathname.startsWith('/node_modules/') ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/dev-sw.js') ||
    pathname.startsWith('/manifest.webmanifest') ||
    pathname === '/sw.js' ||
    pathname === '/registerSW.js'
  )
}

async function appShell(
  request: Request,
  url: URL,
  event: ExtendableEvent
): Promise<Response> {
  try {
    const handler = createHandlerBoundToURL('index.html')
    return await handler({ request, url, event, params: {} })
  } catch (err) {
    console.error('SW: App-Shell konnte nicht geladen werden:', err)
    return fetch(request)
  }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
