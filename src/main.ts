import "./style.css"
import { initPWA } from "./pwa.ts"
import { renderFilesView } from "./files.ts"

const app = document.querySelector<HTMLDivElement>("#app")!

app.innerHTML = `
  <main id="router-view" class="router-view"></main>

  <div
    id="pwa-toast"
    role="alert"
    aria-labelledby="toast-message"
  >
    <div class="message">
      <span id="toast-message"></span>
    </div>
    <div class="buttons">
      <button id="pwa-refresh" type="button">
        Neu laden
      </button>
      <button id="pwa-close" type="button">
        Schließen
      </button>
    </div>
  </div>
`

const routerView = app.querySelector<HTMLElement>("#router-view")!

// Es gibt nur noch eine Ansicht: die Dateiverwaltung. Gespeicherte Dateien
// liegen direkt unter /<name> und werden vom Service Worker ausgeliefert,
// dorthin wird per echter Navigation (location.assign) gewechselt.
renderFilesView(routerView)

// Initialize PWA service worker toast
initPWA(app)
