/// <reference lib="webworker" />
import { Option } from "effect"
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
} from "./storage"

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>
}

void self.skipWaiting()
clientsClaim()

// NOTE: Single reference to self.__WB_MANIFEST allowed for vite-plugin-pwa injection
const precacheManifest: Array<string | { revision: string | null; url: string }> =
  self.__WB_MANIFEST || []

precacheAndRoute(precacheManifest)
cleanupOutdatedCaches()

// NOTE: Bound to URL handler is created lazily in appShell because in dev mode precacheManifest is empty
registerRoute(
  ({ request, sameOrigin }) => sameOrigin && request.mode === "navigate",
  async ({ request, url, event }) => {
    if (url.searchParams.has(ISLAND_PARAM)) {
      return appShell(request, url, event)
    }

    const relativePath = resolveRequestPath(url.pathname)

    try {
      const maybeSaved = await findSavedFile(relativePath)
      if (Option.isSome(maybeSaved)) {
        return fileResponse(maybeSaved.value)
      }
    } catch (err) {
      console.error("SW: Fehler beim Laden der Datei:", err)
    }

    return appShell(request, url, event)
  },
)

registerRoute(
  ({ request, url, sameOrigin }) =>
    sameOrigin &&
    url.pathname !== "/" &&
    !isInternalPath(url.pathname) &&
    request.mode !== "navigate",
  async ({ request, url }) => {
    const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ""))
    try {
      const maybeSaved = relativePath ? await findSavedFile(relativePath) : Option.none()
      if (Option.isSome(maybeSaved)) {
        return fileResponse(maybeSaved.value)
      }
    } catch (err) {
      console.error("SW: Fehler beim Laden der Datei:", err)
    }

    return fetch(request)
  },
)

registerRoute(
  ({ request }) => request.mode === "navigate",
  ({ request, url, event }) => appShell(request, url, event),
)

function resolveRequestPath(pathname: string): string {
  const decoded = decodeURIComponent(pathname)
  const trimmed = decoded.replace(/^\/+|\/+$/g, "")
  return trimmed || DEFAULT_INDEX_FILE
}

function fileResponse(saved: SavedFile): Response {
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

function isInternalPath(pathname: string): boolean {
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
