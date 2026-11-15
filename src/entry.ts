import "./style.css"
import { Effect } from "effect"
import * as Runtime from "foldkit/runtime"
import { registerSW } from "virtual:pwa-register"
import {
  exitFullscreenWindow,
  isWindowFullscreen,
  isWindows,
  isWindowsOrLinux,
  supportsDirectoryPicker,
  supportsOPFS,
  supportsTauri,
  toggleFullscreenWindow,
} from "./files"
import { Flags, Message, Model, init, subscriptions, update, view } from "./main"
import { initMarkdown } from "./markdown"
import { registerMonacoEditorElement } from "./monaco-element"
import type { AlertBanner } from "./toast"

const dispatchServiceWorkerToast = (banner: AlertBanner) => {
  window.dispatchEvent(new CustomEvent("pwaislands:sw-toast", { detail: banner }))
}

registerMonacoEditorElement()

if (supportsTauri()) {
  // In nativen Tauri-Apps sind alle Web-Assets bereits lokal in der Binärdatei gebündelt.
  // Ein Service Worker darf hier nicht aktiv sein, da er alte Builds im Webview-Cache
  // festhält und Versionsupdates blockiert. Eventuell vorhandene Service Worker und
  // Caches (z. B. aus vorherigen Builds) werden bereinigt.
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
      })),
    })

    if (!supportsTauri()) {
      registerSW({
        immediate: true,
        onNeedReload() {
          dispatchServiceWorkerToast({
            message: "Update bereit – bitte Seite neu laden.",
            variant: "info",
          })
        },
        onOfflineReady() {
          dispatchServiceWorkerToast({
            message: "App ist bereit für die Offline-Nutzung.",
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
          dispatchServiceWorkerToast({
            message: detail
              ? `Fehler bei der Service-Worker-Registrierung: ${detail}`
              : "Fehler bei der Service-Worker-Registrierung.",
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
