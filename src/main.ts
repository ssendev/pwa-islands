import './style.css'
import { setupCounter } from './counter.ts'
import { initPWA } from './pwa.ts'
import icons from './assets/icons.svg?no-inline'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
<section id="center">
  <button id="counter" type="button" class="counter"></button>
</section>

<div class="ticks"></div>

<section id="next-steps">
  <div id="documentation">
    <svg class="icon" role="presentation" aria-hidden="true"><use href="${icons}#documentation-icon"></use></svg>
  </div>
</section>

<div class="ticks"></div>
<section id="spacer"></section>

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
        Reload
      </button>
      <button id="pwa-close" type="button">
        Close
      </button>
  </div>
</div>
`

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)

initPWA(app)
