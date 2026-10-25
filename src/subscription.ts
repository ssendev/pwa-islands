import { Effect, Option, Schema, Stream } from "effect"
import * as Dom from "foldkit/dom"
import * as Subscription from "foldkit/subscription"
import { setDeferredInstallPrompt } from "./files"
import { Message } from "./message"
import { type Model, ModalState } from "./model"

const isBeforeInstallPromptEvent = (event: Event): event is BeforeInstallPromptEvent =>
  "prompt" in event && typeof event.prompt === "function" && "userChoice" in event

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  escapeKey: entry(
    {
      isActive: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        isActive:
          model.isSettingsOpen ||
          ModalState.match(model.modalState, {
            Closed: () => false,
            CreateFile: () => true,
            CreateFolder: () => true,
            EditFolder: () => true,
            EditFile: () => true,
            ConfirmDelete: () => true,
            ConfirmOverwrite: () => true,
            ImportConflict: () => true,
            Help: () => true,
          }),
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
                return Option.some(Message.ClickedOutsideSettingsMenu())
              }
              return Option.none()
            },
          }),
          Effect.sync(() => isSettingsOpen),
        ),
    },
  ),

  beforeInstallPrompt: Subscription.persistentEntry(
    Dom.streamFromEventFilterMapPreventDefault({
      target: window,
      type: "beforeinstallprompt",
      filterMapEvent: (event) => {
        if (!isBeforeInstallPromptEvent(event)) {
          return Option.none()
        }
        setDeferredInstallPrompt(Option.some(event))
        return Option.some(Message.CapturedInstallPrompt())
      },
    }),
  ),

  appInstalled: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window,
      type: "appinstalled",
      mapEvent: () => {
        setDeferredInstallPrompt(Option.none())
        return Message.InstalledApp()
      },
    }),
  ),
}))
