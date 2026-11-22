import "./style.css"
import { Effect } from "effect"
import * as Runtime from "foldkit/runtime"
import { registerSW } from "virtual:pwa-register"
import {
  exitFullscreenWindow,
  getOpenExternalLinksInBrowserState,
  isWindowFullscreen,
  isWindows,
  isWindowsOrLinux,
  openExternalUrlInTauri,
  supportsDirectoryPicker,
  supportsOPFS,
  supportsTauri,
  toggleFullscreenWindow,
} from "./files"
import { Flags, Message, Model, init, subscriptions, update, view } from "./main"
import { detectBrowserLanguage, getDocumentLanguage, t } from "./i18n"
import { initMarkdown } from "./markdown"
import { registerMonacoEditorElement } from "./monaco-element"
import type { AlertBanner } from "./toast"

const dispatchServiceWorkerToast = (banner: AlertBanner) => {
  window.dispatchEvent(new CustomEvent("pwaislands:sw-toast", { detail: banner }))
}

registerMonacoEditorElement()

if (supportsTauri()) {
  // In native Tauri apps, all web assets are already bundled locally in the binary.
  // A Service Worker must not be active here, as it holds onto old builds in the webview cache
  // and blocks version updates. Clean up any existing Service Workers and caches (e.g. from previous builds).
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
      let hadRegistrations = registrations.length > 0
      for (const registration of registrations) {
        await registration.unregister()
      }
      let hadCaches = false
      if ("caches" in window) {
        const keys = await caches.keys()
        if (keys.length > 0) {
          hadCaches = true
          for (const key of keys) {
            await caches.delete(key)
          }
        }
      }
      if (hadRegistrations || hadCaches || navigator.serviceWorker.controller) {
        const reloadKey = "pwaislands:sw-cleaned"
        if (!sessionStorage.getItem(reloadKey)) {
          sessionStorage.setItem(reloadKey, "1")
          window.location.reload()
        }
      }
    })
  }
}

const container = document.getElementById("app")
if (!container) {
  throw new Error("Root element #app not found")
}

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  container,
  routing: {
    onUrlRequest: (request) => Message.RequestedUrl({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
})

void initMarkdown()
  .catch((error) => {
    console.error("Markdown-Parser konnte nicht initialisiert werden:", error)
  })
  .finally(() => {
    Runtime.run(application, {
      flags: Effect.sync(() => ({
        hasDirectoryPicker: supportsDirectoryPicker(),
        hasOPFS: supportsOPFS(),
        hasTauri: supportsTauri(),
        isWindowsOrLinux: isWindowsOrLinux(),
        isWindows: isWindows(),
        origin: window.location.origin,
        language: detectBrowserLanguage(),
      })),
    })

    if (!supportsTauri()) {
      registerSW({
        immediate: true,
        onNeedReload() {
          if (import.meta.env.DEV) {
            return
          }
          dispatchServiceWorkerToast({
            message: t(getDocumentLanguage()).sw.updateReady,
            variant: "info",
          })
        },
        onOfflineReady() {
          if (import.meta.env.DEV) {
            return
          }
          dispatchServiceWorkerToast({
            message: t(getDocumentLanguage()).sw.offlineReady,
            variant: "info",
          })
        },
        onRegisterError(error) {
          console.error(
            "PWA: onRegisterError - Fehler bei der Service-Worker-Registrierung:",
            error,
          )
          const detail =
            error instanceof Error ? error.message : typeof error === "string" ? error : ""
          const swTr = t(getDocumentLanguage()).sw
          dispatchServiceWorkerToast({
            message: detail ? swTr.registerErrorWithDetail(detail) : swTr.registerError,
            variant: "danger",
          })
        },
      })
    }
  })

if (supportsTauri()) {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      win
        .onFocusChanged(({ payload: focused }) => {
          window.dispatchEvent(new Event(focused ? "focus" : "blur"))
        })
        .catch(() => {})

      const checkMaximized = () => {
        win
          .isMaximized()
          .then((maximized) => {
            window.dispatchEvent(
              new CustomEvent("pwaislands:window-maximized", { detail: maximized }),
            )
          })
          .catch(() => {})
      }

      const checkFullscreen = () => {
        win
          .isFullscreen()
          .then((fullscreen) => {
            document.body.classList.toggle("is-fullscreen", fullscreen)
            window.dispatchEvent(
              new CustomEvent("pwaislands:window-fullscreen", { detail: fullscreen }),
            )
          })
          .catch(() => {})
      }

      win
        .onResized(() => {
          checkMaximized()
          checkFullscreen()
        })
        .catch(() => {})
      checkMaximized()
      checkFullscreen()
    })
    .catch(() => {})
}

if (typeof document !== "undefined") {
  document.addEventListener("fullscreenchange", () => {
    const isFullscreen = Boolean(document.fullscreenElement)
    document.body.classList.toggle("is-fullscreen", isFullscreen)
    window.dispatchEvent(new CustomEvent("pwaislands:window-fullscreen", { detail: isFullscreen }))
  })
}

const isExternalBrowserUrl = (href: string): string | null => {
  try {
    const parsed = new URL(href, window.location.href)
    if (parsed.protocol === "mailto:") {
      return parsed.href
    }
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "tauri.localhost"
    ) {
      return parsed.href
    }
    return null
  } catch {
    return null
  }
}

if (supportsTauri()) {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) {
      return
    }
    const target = event.target
    if (!(target instanceof Element)) {
      return
    }
    const anchor = target.closest("a[href]")
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) {
      return
    }
    const externalUrl = isExternalBrowserUrl(anchor.href)
    if (externalUrl === null) {
      return
    }
    const isPwaWebUrl = new URL(externalUrl).hostname === "pwaislands.ssen.dev"
    if (getOpenExternalLinksInBrowserState() || isPwaWebUrl) {
      event.preventDefault()
      void openExternalUrlInTauri(externalUrl).catch((error) => {
        console.error("Failed to open external URL:", error)
      })
    }
  })

  window.addEventListener("message", async (event) => {
    if (event.data?.type === "TAURI_QUERY_OPEN_EXTERNAL_LINKS") {
      if (event.source && "postMessage" in event.source) {
        ;(event.source as Window).postMessage(
          {
            type: "TAURI_OPEN_EXTERNAL_LINKS_STATE",
            enabled: getOpenExternalLinksInBrowserState(),
          },
          "*",
        )
      }
    } else if (
      event.data?.type === "TAURI_OPEN_EXTERNAL_LINK" &&
      typeof event.data.url === "string" &&
      getOpenExternalLinksInBrowserState()
    ) {
      await openExternalUrlInTauri(event.data.url).catch((error) => {
        console.error("Failed to open external URL:", error)
      })
    }
  })
}

if (supportsTauri() && isWindowsOrLinux()) {
  window.addEventListener("message", async (event) => {
    if (event.data?.type === "TAURI_EXIT_FULLSCREEN") {
      const isFs = await isWindowFullscreen()
      if (isFs) {
        await exitFullscreenWindow()
      } else if (event.data?.key === "Escape") {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      }
    } else if (event.data?.type === "TAURI_TOGGLE_FULLSCREEN") {
      await toggleFullscreenWindow()
    }
  })

  window.addEventListener("keydown", async (event) => {
    if (event.key === "F11" && !event.defaultPrevented) {
      event.preventDefault()
      await toggleFullscreenWindow()
    }
  })
}
