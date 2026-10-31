import "./style.css"
import { Effect } from "effect"
import * as Runtime from "foldkit/runtime"
import { registerSW } from "virtual:pwa-register"
import {
  isWindows,
  isWindowsOrLinux,
  supportsDirectoryPicker,
  supportsOPFS,
  supportsTauri,
} from "./files"
import { Flags, Message, Model, init, subscriptions, update, view } from "./main"

registerSW({
  immediate: true,
  onNeedReload() {
    console.log("PWA: onNeedReload - Service Worker aktualisiert")
  },
  onOfflineReady() {
    console.log("PWA: onOfflineReady - App ist bereit für die Offline-Nutzung")
  },
  onRegisterError(error) {
    console.error("PWA: onRegisterError - Fehler bei der Service-Worker-Registrierung:", error)
  },
})

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

      win.onResized(checkMaximized).catch(() => {})
      checkMaximized()
    })
    .catch(() => {})
}
