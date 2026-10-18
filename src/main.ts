import './style.css'
import { setupCounter } from './counter.ts'
import { initPWA } from './pwa.ts'
import { renderFilesView } from './files.ts'
import icons from './assets/icons.svg?no-inline'

const app = document.querySelector<HTMLDivElement>('#app')!

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

const routerView = app.querySelector<HTMLElement>('#router-view')!

export function navigate(path: string) {
  if (window.location.pathname !== path) {
    window.history.pushState(null, '', path)
  }
  renderRoute()
}

function renderMainView() {
  routerView.innerHTML = `
    <section id="center">
      <button id="counter" type="button" class="counter"></button>
      <button id="btn-navigate-files" type="button" class="btn btn-primary nav-button">
        📁 Zu den Dateien (/files)
      </button>
    </section>

    <div class="ticks"></div>

    <section id="next-steps">
      <div id="documentation">
        <svg class="icon" role="presentation" aria-hidden="true"><use href="${icons}#documentation-icon"></use></svg>
      </div>
    </section>

    <div class="ticks"></div>
    <section id="spacer"></section>
  `

  const counterBtn = routerView.querySelector<HTMLButtonElement>('#counter')!
  setupCounter(counterBtn)

  const navFilesBtn = routerView.querySelector<HTMLButtonElement>('#btn-navigate-files')!
  navFilesBtn.addEventListener('click', () => navigate('/files'))
}

function renderRoute() {
  const path = window.location.pathname.replace(/\/$/, '') || '/'
  // Nur die App-Routen werden clientseitig gerendert. Gespeicherte Dateien
  // liegen direkt unter /<name> und werden vom Service Worker ausgeliefert,
  // dorthin wird per echter Navigation (location.assign) gewechselt.
  if (path === '/files') {
    renderFilesView(routerView)
  } else {
    renderMainView()
  }
}

window.addEventListener('popstate', renderRoute)

// Initial render
renderRoute()

// Initialize PWA service worker toast
initPWA(app)
