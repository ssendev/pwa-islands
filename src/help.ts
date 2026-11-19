import { Duration, Effect, Option, Schema } from "effect"
import { Submodel } from "foldkit"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import type * as Html from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { viewHelpDe } from "./help-de"
import { viewHelpEn } from "./help-en"
import type { Language } from "./i18n"
import { HelpTopic, buildHelpUrl } from "./route"
import { AlertBanner } from "./toast"

export { HelpTopic }

// MODEL

export const CopyDtsState = defineTaggedUnion({
  Idle: {},
  Copying: {},
  Copied: {},
})
export type CopyDtsState = typeof CopyDtsState.Type

export const Model = Schema.Struct({
  maybeOpenTopic: Schema.Option(HelpTopic),
  copyDtsState: CopyDtsState,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ToggledTopic: {
    topic: HelpTopic,
    isOpen: Schema.Boolean,
  },
  ClickedCopyDts: {},
  SucceededCopyApiDtsToClipboard: {},
  CompletedWaitBeforeResetCopyDts: {},
  FailedCopyApiDtsToClipboard: {
    message: Schema.String,
  },
  CompletedScrollHelpTopicIntoView: {},
  ClickedClose: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineTaggedUnion({
  None: {},
  ReplaceUrl: {
    url: Schema.String,
  },
  ShowAlert: {
    banner: AlertBanner,
  },
  CloseModal: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const CopyApiDtsToClipboard = Command.define("CopyApiDtsToClipboard", {
  messages: [Message.SucceededCopyApiDtsToClipboard, Message.FailedCopyApiDtsToClipboard],
  execute: Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api.d.ts", { cache: "no-cache" })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} beim Laden von /api.d.ts`)
      }
      const dtsText = await res.text()
      await navigator.clipboard.writeText(dtsText)
      return Message.SucceededCopyApiDtsToClipboard()
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.FailedCopyApiDtsToClipboard({
          message: `Kopieren fehlgeschlagen: ${error.message}`,
        }),
      ),
    ),
  ),
})

export const WaitBeforeResetCopyDts = Command.define("WaitBeforeResetCopyDts", {
  messages: [Message.CompletedWaitBeforeResetCopyDts],
  execute: Effect.sleep(Duration.seconds(2)).pipe(
    Effect.as(Message.CompletedWaitBeforeResetCopyDts()),
  ),
})

export const ScrollHelpTopicIntoView = Command.define("ScrollHelpTopicIntoView", {
  args: {
    topic: HelpTopic,
  },
  messages: [Message.CompletedScrollHelpTopicIntoView],
  execute: ({ topic }) =>
    Dom.scrollIntoViewAfterPaint(`.help-topic[data-topic="${topic}"] > .help-topic-summary`, {
      block: "nearest",
    }).pipe(
      Effect.as(Message.CompletedScrollHelpTopicIntoView()),
      Effect.catch(() => Effect.succeed(Message.CompletedScrollHelpTopicIntoView())),
    ),
})

// INIT

export const init = (maybeTopic: Option.Option<HelpTopic>): Model => ({
  maybeOpenTopic: maybeTopic,
  copyDtsState: CopyDtsState.Idle(),
})

// UPDATE

export const update = (
  model: Model,
  message: Message,
  subPath: ReadonlyArray<string>,
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Message.match(message, {
    ToggledTopic: ({ topic, isOpen }) => {
      const nextMaybeOpenTopic: Option.Option<HelpTopic> = isOpen
        ? Option.some(topic)
        : Option.exists(model.maybeOpenTopic, (t) => t === topic)
          ? Option.none()
          : model.maybeOpenTopic

      const isUnchanged = Option.match(model.maybeOpenTopic, {
        onNone: () => Option.isNone(nextMaybeOpenTopic),
        onSome: (current) => Option.exists(nextMaybeOpenTopic, (next) => next === current),
      })

      if (isUnchanged) {
        return { model, outMessage: OutMessage.None() }
      }

      return {
        model: modifyFields(model, {
          maybeOpenTopic: () => nextMaybeOpenTopic,
        }),
        commands: isOpen ? [ScrollHelpTopicIntoView({ topic })] : [],
        outMessage: OutMessage.ReplaceUrl({
          url: buildHelpUrl(subPath, nextMaybeOpenTopic),
        }),
      }
    },

    ClickedCopyDts: () => ({
      model: modifyFields(model, {
        copyDtsState: () => CopyDtsState.Copying(),
      }),
      commands: [CopyApiDtsToClipboard()],
      outMessage: OutMessage.None(),
    }),

    SucceededCopyApiDtsToClipboard: () => ({
      model: modifyFields(model, {
        copyDtsState: () => CopyDtsState.Copied(),
      }),
      commands: [WaitBeforeResetCopyDts()],
      outMessage: OutMessage.None(),
    }),

    CompletedWaitBeforeResetCopyDts: () => ({
      model: CopyDtsState.match(model.copyDtsState, {
        Copied: () =>
          modifyFields(model, {
            copyDtsState: () => CopyDtsState.Idle(),
          }),
        Idle: () => model,
        Copying: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    FailedCopyApiDtsToClipboard: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        copyDtsState: () => CopyDtsState.Idle(),
      }),
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: `Kopieren hat nicht geklappt: ${errorMessage} Öffnen Sie /api.d.ts direkt im Browser und kopieren Sie den Text von Hand.`,
          variant: "danger",
        },
      }),
    }),

    CompletedScrollHelpTopicIntoView: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    ClickedClose: () => ({
      model,
      outMessage: OutMessage.CloseModal(),
    }),
  })

// VIEW

export type ViewInputs = {
  readonly origin: string
  readonly hasDirectoryPicker: boolean
  readonly hasOPFS: boolean
  readonly hasTauri: boolean
  readonly language: Language
}

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, context, h): Html.Html =>
    context.language === "de" ? viewHelpDe(model, context, h) : viewHelpEn(model, context, h),
)
