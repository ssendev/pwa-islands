import { Effect, Option, Schema, Stream } from "effect"
import * as Dom from "foldkit/dom"
import * as Subscription from "foldkit/subscription"
import {
  type BeforeInstallPromptEvent,
  getRegisterServiceWorker,
  setDeferredInstallPrompt,
  setRefreshServiceWorker,
} from "./files"
import { Message } from "./message"
import type { Model } from "./model"

const serviceWorkerStream: Stream.Stream<Message> = Stream.callback(() =>
  Effect.acquireRelease(
    Effect.sync(() => {
      try {
        const registerSW = getRegisterServiceWorker()
        if (!registerSW) {
          return
        }
        const refreshSW = registerSW({
          immediate: true,
          onNeedReload() {
            // In autoUpdate mode, onNeedReload prevents window.location.reload()
            // so open windows are not disrupted by an automatic reload.
            console.log("PWA: onNeedReload - Service Worker aktualisiert")
          },
          onOfflineReady() {
            console.log("PWA: onOfflineReady - App ist bereit für die Offline-Nutzung")
          },
          onRegisterError(error) {
            console.error(
              "PWA: onRegisterError - Fehler bei der Service-Worker-Registrierung:",
              error,
            )
          },
        })
        setRefreshServiceWorker(refreshSW)
      } catch (error) {
        console.error("PWA: Fehler beim Registrieren des Service Workers:", error)
      }
    }),
    () =>
      Effect.sync(() => {
        setRefreshServiceWorker(null)
      }),
  ).pipe(Effect.flatMap(() => Effect.never)),
)

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  escapeKey: entry(
    {
      isActive: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        isActive: model.isSettingsOpen || model.modalState._tag !== "Closed",
      }),
      dependenciesToStream: ({ isActive }) =>
        Dom.streamFromKeyBindings<Message>({
          bindings: [
            {
              keys: "Escape",
              isEnabled: isActive,
              whileTyping: "Allow",
              mapEvent: () => Message.PressedEscape(),
            },
          ],
        }),
    },
  ),

  outsideSettingsClick: entry(
    {
      isSettingsOpen: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        isSettingsOpen: model.isSettingsOpen,
      }),
      dependenciesToStream: ({ isSettingsOpen }) =>
        Stream.when(
          Dom.streamFromEventFilterMap({
            target: document,
            type: "click",
            filterMapEvent: (event) => {
              const target = event.target
              if (!(target instanceof Node)) {
                return Option.none()
              }
              const settingsRoot = document.getElementById("settings-menu")
              if (settingsRoot && !settingsRoot.contains(target)) {
                return Option.some(Message.ClosedSettingsMenu())
              }
              return Option.none()
            },
          }),
          Effect.sync(() => isSettingsOpen),
        ),
    },
  ),

  popState: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window,
      type: "popstate",
      mapEvent: () =>
        Message.NavigatedPopState({
          pathname: window.location.pathname,
          search: window.location.search,
        }),
    }),
  ),

  beforeInstallPrompt: Subscription.persistentEntry(
    Dom.streamFromEventFilterMapPreventDefault({
      target: window,
      type: "beforeinstallprompt",
      filterMapEvent: (event) => {
        setDeferredInstallPrompt(event as BeforeInstallPromptEvent)
        return Option.some(Message.CapturedInstallPrompt())
      },
    }),
  ),

  appInstalled: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window,
      type: "appinstalled",
      mapEvent: () => {
        setDeferredInstallPrompt(null)
        return Message.InstalledApp()
      },
    }),
  ),

  serviceWorker: Subscription.persistentEntry(serviceWorkerStream),
}))
