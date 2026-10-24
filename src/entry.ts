import "./style.css"
import { Effect } from "effect"
import * as Runtime from "foldkit/runtime"
import { registerSW } from "virtual:pwa-register"
import { setRegisterServiceWorker, supportsDirectoryPicker, supportsOPFS } from "./files"
import { Flags, Model, init, subscriptions, update, view } from "./main"

setRegisterServiceWorker(registerSW)

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
})

Runtime.run(application, {
  flags: Effect.sync(() => ({
    hasDirectoryPicker: supportsDirectoryPicker(),
    hasOPFS: supportsOPFS(),
    initialPathname: window.location.pathname,
    initialSearch: window.location.search,
  })),
})
