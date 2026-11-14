import { Array, Clock, Effect, Match, Option, Schema, pipe } from "effect"
import { Submodel } from "foldkit"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import type * as Html from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import {
  BinaryEdit,
  EditorFileMode,
  FileEntry,
  FileEntryKind,
  PreviewContent,
  arrayBufferToBase64,
  base64ToUint8Array,
  requireActiveStorage,
  revokeActivePreviewUrl,
} from "./files"
import {
  applyHashlineEdits,
  formatFencedHashlineFile,
  formatLlmContext,
  formatUpdatedHashlines,
  HashlineApplyResult,
} from "./hashline"
import { viewIcon } from "./icons"
import { encodeSubPath } from "./route"
import {
  deleteUserTemplate,
  getStoredUserTemplates,
  sanitizeTemplateName,
  saveUserTemplate,
} from "./storage"
import { BUILTIN_TEMPLATES, replaceFileExtension, StarterTemplate } from "./templates"

export { BinaryEdit, EditorFileMode, PreviewContent }
export { BUILTIN_TEMPLATES, replaceFileExtension, StarterTemplate }

// MODEL

export const AlertVariant = Schema.Literals(["info", "warning", "danger"])
export type AlertVariant = typeof AlertVariant.Type

export const AlertBanner = Schema.Struct({
  message: Schema.String,
  variant: AlertVariant,
})
export type AlertBanner = typeof AlertBanner.Type

export const OverwriteSource = defineTaggedUnion({
  CreateFile: {
    content: Schema.String,
    selectedTemplateId: Schema.String,
    userTemplates: Schema.Array(StarterTemplate),
  },
  EditFile: {
    originalName: Schema.String,
    fileMode: EditorFileMode,
  },
})
export type OverwriteSource = typeof OverwriteSource.Type

export const Model = defineTaggedUnion({
  CreateFile: {
    name: Schema.String,
    content: Schema.String,
    selectedTemplateId: Schema.String,
    userTemplates: Schema.Array(StarterTemplate),
    isSavingTemplate: Schema.Boolean,
    isDeletingTemplate: Schema.Boolean,
    newTemplateLabel: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
    maybeAlertBanner: Schema.Option(AlertBanner),
    maybePasteError: Schema.Option(Schema.String),
    isLlmBarOpen: Schema.Boolean,
    isMaximized: Schema.Boolean,
  },
  CreateFolder: {
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
  EditFolder: {
    originalName: Schema.String,
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
  EditFile: {
    originalName: Schema.String,
    name: Schema.String,
    fileMode: EditorFileMode,
    maybeValidationError: Schema.Option(Schema.String),
    maybeAlertBanner: Schema.Option(AlertBanner),
    maybePasteError: Schema.Option(Schema.String),
    isLlmBarOpen: Schema.Boolean,
    isMaximized: Schema.Boolean,
  },
  ConfirmDelete: {
    entryName: Schema.String,
    entryKind: FileEntryKind,
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
  ConfirmOverwrite: {
    targetName: Schema.String,
    source: OverwriteSource,
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
})
export type Model = typeof Model.Type

type CreateFileModel = Extract<Model, { readonly _tag: "CreateFile" }>
type EditFileModel = Extract<Model, { readonly _tag: "EditFile" }>
type BinaryFileMode = Extract<EditorFileMode, { readonly _tag: "Binary" }>

export const makeCreateFile = (
  userTemplates: ReadonlyArray<StarterTemplate> = [],
): CreateFileModel => ({
  _tag: "CreateFile",
  name: "Neu.html",
  content: "",
  selectedTemplateId: "builtin:empty",
  userTemplates,
  isSavingTemplate: false,
  isDeletingTemplate: false,
  newTemplateLabel: "",
  maybeValidationError: Option.none(),
  maybeAlertBanner: Option.none(),
  maybePasteError: Option.none(),
  isLlmBarOpen: false,
  isMaximized: false,
})

export const setAlertBanner = (model: Model, maybeAlertBanner: Option.Option<AlertBanner>): Model =>
  Model.match(model, {
    CreateFile: (state) => modifyFields(state, { maybeAlertBanner: () => maybeAlertBanner }),
    CreateFolder: (state) => modifyFields(state, { maybeAlertBanner: () => maybeAlertBanner }),
    EditFolder: (state) => modifyFields(state, { maybeAlertBanner: () => maybeAlertBanner }),
    EditFile: (state) => modifyFields(state, { maybeAlertBanner: () => maybeAlertBanner }),
    ConfirmDelete: (state) => modifyFields(state, { maybeAlertBanner: () => maybeAlertBanner }),
    ConfirmOverwrite: (state) => modifyFields(state, { maybeAlertBanner: () => maybeAlertBanner }),
  })

export const getAlertBanner = (model: Model): Option.Option<AlertBanner> =>
  Model.match(model, {
    CreateFile: (state) => state.maybeAlertBanner,
    CreateFolder: (state) => state.maybeAlertBanner,
    EditFolder: (state) => state.maybeAlertBanner,
    EditFile: (state) => state.maybeAlertBanner,
    ConfirmDelete: (state) => state.maybeAlertBanner,
    ConfirmOverwrite: (state) => state.maybeAlertBanner,
  })

const getTextFileContext = (
  model: Model,
): Option.Option<{ readonly fileName: string; readonly content: string }> =>
  Model.match(model, {
    CreateFile: (state) => Option.some({ fileName: state.name, content: state.content }),
    EditFile: (state) =>
      EditorFileMode.match(state.fileMode, {
        Text: ({ content }) => Option.some({ fileName: state.name, content }),
        Binary: () => Option.none(),
      }),
    CreateFolder: () => Option.none(),
    EditFolder: () => Option.none(),
    ConfirmDelete: () => Option.none(),
    ConfirmOverwrite: () => Option.none(),
  })

const toggleLlmBar = (model: Model): Model =>
  Model.match(model, {
    CreateFile: (state) => modifyFields(state, { isLlmBarOpen: (open) => !open }),
    EditFile: (state) => modifyFields(state, { isLlmBarOpen: (open) => !open }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmDelete: () => model,
    ConfirmOverwrite: () => model,
  })

const setPasteError = (model: Model, maybePasteError: Option.Option<string>): Model =>
  Model.match(model, {
    CreateFile: (state) => modifyFields(state, { maybePasteError: () => maybePasteError }),
    EditFile: (state) => modifyFields(state, { maybePasteError: () => maybePasteError }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmDelete: () => model,
    ConfirmOverwrite: () => model,
  })

const applyTextContentUpdate = (
  model: Model,
  content: string,
  maybeAlertBanner: Option.Option<AlertBanner>,
): Model =>
  Model.match(model, {
    CreateFile: (state) =>
      modifyFields(state, {
        content: () => content,
        maybeAlertBanner: () => maybeAlertBanner,
        maybePasteError: () => Option.none(),
      }),
    EditFile: (state) =>
      EditorFileMode.match(state.fileMode, {
        Text: () =>
          modifyFields(state, {
            fileMode: () => EditorFileMode.Text({ content }),
            maybeAlertBanner: () => maybeAlertBanner,
            maybePasteError: () => Option.none(),
          }),
        Binary: () => state,
      }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmDelete: () => model,
    ConfirmOverwrite: () => model,
  })

// MESSAGE & OUTMESSAGE

export const Message = defineMessageUnion({
  UpdatedName: {
    name: Schema.String,
  },
  UpdatedTextContent: {
    content: Schema.String,
  },
  SelectedTemplate: {
    templateId: Schema.String,
  },
  ClickedOpenSaveTemplate: {},
  ClickedCancelSaveTemplate: {},
  UpdatedNewTemplateLabel: {
    label: Schema.String,
  },
  ClickedConfirmSaveTemplate: {},
  GeneratedTemplateTimestamp: {
    timestamp: Schema.Number,
  },
  ClickedOpenDeleteTemplate: {},
  ClickedCancelDeleteTemplate: {},
  ClickedConfirmDeleteTemplate: {},
  CompletedLoadUserTemplates: {
    templates: Schema.Array(StarterTemplate),
  },
  CompletedSaveUserTemplate: {
    template: StarterTemplate,
  },
  CompletedDeleteUserTemplate: {
    templateId: Schema.String,
  },
  ToggledBase64: {
    isChecked: Schema.Boolean,
  },
  SucceededLoadBase64: {
    base64Content: Schema.String,
  },
  FailedLoadBase64: {
    message: Schema.String,
  },
  UpdatedBase64Content: {
    base64Content: Schema.String,
  },
  ClickedToggleLlmBar: {},
  ClickedToggleMaximize: {},
  ClickedCopyDts: {},
  SucceededCopyApiDtsToClipboard: {},
  FailedCopyApiDtsToClipboard: {
    message: Schema.String,
  },
  ClickedCopyLlmContext: {},
  SucceededCopyLlmContext: {},
  FailedCopyLlmContext: {
    message: Schema.String,
  },
  ClickedCopyFileHashes: {},
  SucceededCopyFileHashes: {},
  FailedCopyFileHashes: {
    message: Schema.String,
  },
  ClickedPasteLlmEdits: {},
  SucceededReadClipboardForLlmEdits: {
    text: Schema.String,
  },
  FailedReadClipboardForLlmEdits: {
    message: Schema.String,
  },
  SucceededCopyUpdatedHashes: {},
  FailedCopyUpdatedHashes: {
    message: Schema.String,
  },
  CompletedCopyPasteErrorToClipboard: {},
  ClickedDismissAlert: {},
  ClickedSave: {},
  ClickedSaveAndOpen: {},
  ClickedConfirmOverwrite: {},
  ClickedCancelOverwrite: {},
  ClickedDelete: {},
  ClickedConfirmDelete: {},
  ClickedCancelDelete: {},
  ClickedClose: {},
  SucceededSaveChanges: {
    entries: Schema.Array(FileEntry),
  },
  SucceededSaveAndOpen: {
    entries: Schema.Array(FileEntry),
    savedFileName: Schema.String,
    url: Schema.String,
  },
  CompletedOpenInNewTab: {},
  FailedSaveChanges: {
    message: Schema.String,
  },
  SucceededDeleteEntry: {
    entries: Schema.Array(FileEntry),
  },
  FailedDeleteEntry: {
    message: Schema.String,
  },
  CompletedFocusNameInput: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineTaggedUnion({
  None: {},
  CloseModal: { replaceUrl: Schema.Boolean },
  EntriesUpdated: { entries: Schema.Array(FileEntry), closeModal: Schema.Boolean },
  ShowAlert: {
    banner: AlertBanner,
    closeModal: Schema.Boolean,
    replaceUrl: Schema.Boolean,
  },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

const BinaryOrText = (
  fileMode: EditorFileMode,
  handlers: {
    readonly text: (content: string) => Promise<void>
    readonly binaryEditing: (content: string) => Promise<void>
    readonly binaryRename: () => Promise<void>
  },
): Promise<void> =>
  EditorFileMode.match(fileMode, {
    Text: ({ content }) => handlers.text(content),
    Binary: ({ edit }) =>
      BinaryEdit.match(edit, {
        Locked: handlers.binaryRename,
        Disabled: handlers.binaryRename,
        Loading: handlers.binaryRename,
        Editing: ({ content }) => handlers.binaryEditing(content),
      }),
  })

export const GenerateTemplateTimestamp = Command.define("GenerateTemplateTimestamp", {
  messages: [Message.GeneratedTemplateTimestamp],
  execute: Clock.currentTimeMillis.pipe(
    Effect.map((timestamp) => Message.GeneratedTemplateTimestamp({ timestamp })),
  ),
})

export const FocusNameInput = Command.define("FocusNameInput", {
  messages: [Message.CompletedFocusNameInput],
  execute: Dom.focus("#modal-file-name").pipe(
    Effect.as(Message.CompletedFocusNameInput()),
    Effect.catch(() => Effect.succeed(Message.CompletedFocusNameInput())),
  ),
})

export const LoadUserTemplates = Command.define("LoadUserTemplates", {
  messages: [Message.CompletedLoadUserTemplates],
  execute: Effect.tryPromise({
    try: async () => {
      const stored = await getStoredUserTemplates(
        requireActiveStorage().type,
        requireActiveStorage().rootHandle,
      )
      const templates: ReadonlyArray<StarterTemplate> = Array.map(stored, (t) => ({
        id: t.id,
        label: t.label,
        defaultFileName: t.defaultFileName,
        content: t.content,
        isBuiltin: false,
      }))
      return Message.CompletedLoadUserTemplates({ templates })
    },
    catch: () => new Error("Failed to load user templates"),
  }).pipe(
    Effect.catch(() => Effect.succeed(Message.CompletedLoadUserTemplates({ templates: [] }))),
  ),
})

export const SaveUserTemplate = Command.define("SaveUserTemplate", {
  args: {
    template: StarterTemplate,
  },
  messages: [Message.CompletedSaveUserTemplate],
  execute: ({ template }) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        await saveUserTemplate(storage.type, storage.rootHandle, template.label, template.content)
        return Message.CompletedSaveUserTemplate({ template })
      },
      catch: () => new Error("Failed to save user template"),
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedSaveUserTemplate({ template })))),
})

export const DeleteUserTemplate = Command.define("DeleteUserTemplate", {
  args: {
    name: Schema.String,
    templateId: Schema.String,
  },
  messages: [Message.CompletedDeleteUserTemplate],
  execute: ({ name, templateId }) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        await deleteUserTemplate(storage.type, storage.rootHandle, name)
        return Message.CompletedDeleteUserTemplate({ templateId })
      },
      catch: () => new Error("Failed to delete user template"),
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.CompletedDeleteUserTemplate({ templateId }))),
    ),
})

export const LoadBase64 = Command.define("LoadBase64", {
  args: {
    entryName: Schema.String,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededLoadBase64, Message.FailedLoadBase64],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        const buffer = await storage.readFileBuffer(args.subPath, args.entryName)
        const base64Content = arrayBufferToBase64(buffer)
        return Message.SucceededLoadBase64({ base64Content })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadBase64({
            message: `Dateiinhalt konnte nicht als Base64 geladen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

const executeSaveChanges = async (
  model: Model,
  subPath: ReadonlyArray<string>,
): Promise<{ readonly entries: ReadonlyArray<FileEntry>; readonly savedFileName: string }> => {
  const storage = requireActiveStorage()

  const saveEditedFile = (originalName: string, targetName: string, fileMode: EditorFileMode) =>
    BinaryOrText(fileMode, {
      text: async (content) => {
        await storage.writeFile(subPath, targetName, content)
        if (originalName !== targetName) {
          await storage.deleteEntry(subPath, originalName, "file")
        }
      },
      binaryEditing: async (content) => {
        await storage.writeFileBuffer(subPath, targetName, base64ToUint8Array(content))
        if (originalName !== targetName) {
          await storage.deleteEntry(subPath, originalName, "file")
        }
      },
      binaryRename: () => storage.renameBinaryFile(subPath, originalName, targetName),
    })

  const savedFileName = await Match.value(model).pipe(
    Match.tag("CreateFolder", async ({ name }) => {
      const targetName = name.trim()
      await storage.createDirectory(subPath, targetName)
      return targetName
    }),
    Match.tag("EditFolder", async ({ name, originalName }) => {
      const newName = name.trim()
      if (newName !== originalName) {
        await storage.renameDirectory(subPath, originalName, newName)
      }
      return newName
    }),
    Match.tag("CreateFile", async ({ name, content }) => {
      const targetName = name.trim()
      await storage.writeFile(subPath, targetName, content)
      return targetName
    }),
    Match.tag("EditFile", async ({ name, originalName, fileMode }) => {
      const targetName = name.trim()
      await saveEditedFile(originalName, targetName, fileMode)
      return targetName
    }),
    Match.tag("ConfirmOverwrite", async ({ targetName, source }) => {
      await Match.value(source).pipe(
        Match.tag("CreateFile", async ({ content }) => {
          await storage.writeFile(subPath, targetName, content)
        }),
        Match.tag("EditFile", async ({ originalName, fileMode }) => {
          await saveEditedFile(originalName, targetName, fileMode)
        }),
        Match.exhaustive,
      )
      return targetName
    }),
    Match.tag("ConfirmDelete", () => Promise.resolve("")),
    Match.exhaustive,
  )

  revokeActivePreviewUrl()
  const updatedEntries = await storage.listEntries(subPath)
  return { entries: updatedEntries, savedFileName }
}

export const SaveChanges = Command.define("SaveChanges", {
  args: {
    model: Model,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededSaveChanges, Message.FailedSaveChanges],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const { entries } = await executeSaveChanges(args.model, args.subPath)
        return Message.SucceededSaveChanges({ entries })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSaveChanges({
            message: `Speichern fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const SaveAndOpenChanges = Command.define("SaveAndOpenChanges", {
  args: {
    model: Model,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededSaveAndOpen, Message.FailedSaveChanges],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const { entries, savedFileName } = await executeSaveChanges(args.model, args.subPath)
        const url = `/${encodeSubPath([...args.subPath, savedFileName])}`
        return Message.SucceededSaveAndOpen({ entries, savedFileName, url })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSaveChanges({
            message: `Speichern fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const OpenUrlInNewTab = Command.define("OpenUrlInNewTab", {
  args: {
    url: Schema.String,
  },
  messages: [Message.CompletedOpenInNewTab],
  execute: ({ url }) =>
    Effect.sync(() => {
      window.open(url, "_blank", "noopener")
      return Message.CompletedOpenInNewTab()
    }),
})

export const DeleteEntry = Command.define("DeleteEntry", {
  args: {
    entryName: Schema.String,
    entryKind: FileEntryKind,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededDeleteEntry, Message.FailedDeleteEntry],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()

        await storage.deleteEntry(args.subPath, args.entryName, args.entryKind)
        revokeActivePreviewUrl()
        const updatedEntries = await storage.listEntries(args.subPath)
        return Message.SucceededDeleteEntry({ entries: updatedEntries })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDeleteEntry({
            message: `Löschen fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

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

export const CopyFileHashesToClipboard = Command.define("CopyFileHashesToClipboard", {
  args: {
    fileName: Schema.String,
    content: Schema.String,
  },
  messages: [Message.SucceededCopyFileHashes, Message.FailedCopyFileHashes],
  execute: ({ fileName, content }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(formatFencedHashlineFile(fileName, content))
        return Message.SucceededCopyFileHashes()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedCopyFileHashes({
            message: `Kopieren fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const CopyLlmContextToClipboard = Command.define("CopyLlmContextToClipboard", {
  args: {
    fileName: Schema.String,
    content: Schema.String,
  },
  messages: [Message.SucceededCopyLlmContext, Message.FailedCopyLlmContext],
  execute: ({ fileName, content }) =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch("/api.d.ts", { cache: "no-cache" })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} beim Laden von /api.d.ts`)
        }
        const dtsText = await res.text()
        const promptText = formatLlmContext(fileName, content, dtsText)
        await navigator.clipboard.writeText(promptText)
        return Message.SucceededCopyLlmContext()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedCopyLlmContext({
            message: `Kopieren fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const ReadClipboardForLlmEdits = Command.define("ReadClipboardForLlmEdits", {
  messages: [Message.SucceededReadClipboardForLlmEdits, Message.FailedReadClipboardForLlmEdits],
  execute: Effect.tryPromise({
    try: async () => {
      const text = await navigator.clipboard.readText()
      return Message.SucceededReadClipboardForLlmEdits({ text })
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.FailedReadClipboardForLlmEdits({
          message: `Zwischenablage konnte nicht gelesen werden: ${error.message}`,
        }),
      ),
    ),
  ),
})

export const CopyUpdatedHashesToClipboard = Command.define("CopyUpdatedHashesToClipboard", {
  args: {
    fileName: Schema.String,
    changedLines: Schema.String,
  },
  messages: [Message.SucceededCopyUpdatedHashes, Message.FailedCopyUpdatedHashes],
  execute: ({ fileName, changedLines }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(formatUpdatedHashlines(fileName, changedLines))
        return Message.SucceededCopyUpdatedHashes()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedCopyUpdatedHashes({
            message: `Neue Hashes konnten nicht kopiert werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const CopyPasteErrorToClipboard = Command.define("CopyPasteErrorToClipboard", {
  args: {
    errorText: Schema.String,
  },
  messages: [Message.CompletedCopyPasteErrorToClipboard],
  execute: ({ errorText }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(errorText)
        return Message.CompletedCopyPasteErrorToClipboard()
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedCopyPasteErrorToClipboard()))),
})

// UPDATE

const whenCreateFile = (
  model: Model,
  fn: (state: CreateFileModel) => {
    readonly model: Model
    readonly commands?: ReadonlyArray<Command.Command<Message>>
    readonly outMessage: OutMessage
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Match.value(model).pipe(
    Match.tag("CreateFile", fn),
    Match.orElse(() => ({ model, outMessage: OutMessage.None() })),
  )

const whenBinaryEditor = (
  model: Model,
  fn: (
    editState: EditFileModel,
    binaryMode: BinaryFileMode,
  ) => {
    readonly model: Model
    readonly commands?: ReadonlyArray<Command.Command<Message>>
    readonly outMessage: OutMessage
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Match.value(model).pipe(
    Match.tag("EditFile", (editState) =>
      Match.value(editState.fileMode).pipe(
        Match.tag("Binary", (binaryMode) => fn(editState, binaryMode)),
        Match.orElse(() => ({ model, outMessage: OutMessage.None() })),
      ),
    ),
    Match.orElse(() => ({ model, outMessage: OutMessage.None() })),
  )

const handleSaveAction = (
  model: Model,
  context: {
    readonly subPath: ReadonlyArray<string>
    readonly existingEntries: ReadonlyArray<FileEntry>
  },
  openInNewTab: boolean,
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} => {
  const makeSaveCommand = (nextModel: Model) =>
    openInNewTab
      ? SaveAndOpenChanges({ model: nextModel, subPath: context.subPath })
      : SaveChanges({ model: nextModel, subPath: context.subPath })

  const validateName = (rawName: string, isFolder: boolean): Option.Option<string> => {
    const trimmed = rawName.trim()
    if (!trimmed) {
      return Option.some(
        isFolder
          ? "Bitte geben Sie einen Ordnernamen ein."
          : "Bitte geben Sie einen Dateinamen ein.",
      )
    }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      return Option.some(
        `Der ${isFolder ? "Ordnername" : "Dateiname"} darf keine Schrägstriche enthalten.`,
      )
    }
    return Option.none()
  }

  const existingNames = new Set(Array.map(context.existingEntries, (e) => e.name))

  return Model.match(model, {
    CreateFolder: (createFolder) => {
      const error = validateName(createFolder.name, true)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(createFolder, {
            maybeValidationError: () => error,
            maybeAlertBanner: () => Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const trimmed = createFolder.name.trim()
      if (existingNames.has(trimmed)) {
        return {
          model: modifyFields(createFolder, {
            maybeValidationError: () =>
              Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
            maybeAlertBanner: () => Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const nextModel = modifyFields(createFolder, {
        maybeAlertBanner: () => Option.none(),
      })
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    EditFolder: (editFolder) => {
      const error = validateName(editFolder.name, true)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(editFolder, {
            maybeValidationError: () => error,
            maybeAlertBanner: () => Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const trimmed = editFolder.name.trim()
      if (trimmed !== editFolder.originalName && existingNames.has(trimmed)) {
        return {
          model: modifyFields(editFolder, {
            maybeValidationError: () =>
              Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
            maybeAlertBanner: () => Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const nextModel = modifyFields(editFolder, {
        maybeAlertBanner: () => Option.none(),
      })
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    CreateFile: (createFile) => {
      const error = validateName(createFile.name, false)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(createFile, {
            maybeValidationError: () => error,
            maybeAlertBanner: () => Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const trimmed = createFile.name.trim()
      if (existingNames.has(trimmed)) {
        return {
          model: Model.ConfirmOverwrite({
            targetName: trimmed,
            source: OverwriteSource.CreateFile({
              content: createFile.content,
              selectedTemplateId: createFile.selectedTemplateId,
              userTemplates: createFile.userTemplates,
            }),
            maybeAlertBanner: Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const nextModel = modifyFields(createFile, {
        maybeAlertBanner: () => Option.none(),
      })
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    EditFile: (editFile) => {
      const error = validateName(editFile.name, false)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(editFile, {
            maybeValidationError: () => error,
            maybeAlertBanner: () => Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }

      const trimmed = editFile.name.trim()

      const maybeBase64Content = EditorFileMode.match(editFile.fileMode, {
        Text: () => Option.none<string>(),
        Binary: ({ edit }) =>
          BinaryEdit.match(edit, {
            Locked: () => Option.none<string>(),
            Disabled: () => Option.none<string>(),
            Loading: () => Option.none<string>(),
            Editing: ({ content }) => Option.some(content),
          }),
      })

      if (Option.isSome(maybeBase64Content)) {
        try {
          base64ToUint8Array(maybeBase64Content.value)
        } catch {
          return {
            model: modifyFields(editFile, {
              maybeValidationError: () =>
                Option.some("Ungültige Base64-Kodierung. Bitte überprüfen Sie die Eingabe."),
              maybeAlertBanner: () => Option.none(),
            }),
            outMessage: OutMessage.None(),
          }
        }
      }

      if (trimmed !== editFile.originalName && existingNames.has(trimmed)) {
        const isText = EditorFileMode.match(editFile.fileMode, {
          Text: () => true,
          Binary: () => false,
        })
        if (!isText && Option.isNone(maybeBase64Content)) {
          return {
            model: modifyFields(editFile, {
              maybeValidationError: () =>
                Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
              maybeAlertBanner: () => Option.none(),
            }),
            outMessage: OutMessage.None(),
          }
        }
        return {
          model: Model.ConfirmOverwrite({
            targetName: trimmed,
            source: OverwriteSource.EditFile({
              originalName: editFile.originalName,
              fileMode: editFile.fileMode,
            }),
            maybeAlertBanner: Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }

      const nextModel = modifyFields(editFile, {
        maybeAlertBanner: () => Option.none(),
      })
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    ConfirmDelete: () => ({
      model,
      outMessage: OutMessage.None(),
    }),
    ConfirmOverwrite: () => ({
      model: modifyFields(model, {
        maybeAlertBanner: () => Option.none(),
      }),
      commands: [makeSaveCommand(model)],
      outMessage: OutMessage.None(),
    }),
  })
}

export const update = (
  model: Model,
  message: Message,
  context: {
    readonly subPath: ReadonlyArray<string>
    readonly existingEntries: ReadonlyArray<FileEntry>
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Message.match(message, {
    UpdatedName: ({ name }) => ({
      model: Model.match(model, {
        CreateFile: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
            maybeAlertBanner: () => Option.none(),
          }),
        CreateFolder: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
            maybeAlertBanner: () => Option.none(),
          }),
        EditFolder: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
            maybeAlertBanner: () => Option.none(),
          }),
        EditFile: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
            maybeAlertBanner: () => Option.none(),
          }),
        ConfirmDelete: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    UpdatedTextContent: ({ content }) => ({
      model: Model.match(model, {
        CreateFile: (state) =>
          modifyFields(state, {
            content: () => content,
            maybeAlertBanner: () => Option.none(),
            maybePasteError: () => Option.none(),
          }),
        CreateFolder: () => model,
        EditFolder: () => model,
        EditFile: (state) =>
          EditorFileMode.match(state.fileMode, {
            Text: () =>
              modifyFields(state, {
                fileMode: () => EditorFileMode.Text({ content }),
                maybeAlertBanner: () => Option.none(),
                maybePasteError: () => Option.none(),
              }),
            Binary: () => state,
          }),
        ConfirmDelete: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    SelectedTemplate: ({ templateId }) =>
      whenCreateFile(model, (state) => {
        const allTemplates = [...BUILTIN_TEMPLATES, ...state.userTemplates]
        return Option.match(
          Array.findFirst(allTemplates, (t) => t.id === templateId),
          {
            onNone: () => ({ model: state, outMessage: OutMessage.None() }),
            onSome: (template) => ({
              model: modifyFields(state, {
                selectedTemplateId: () => template.id,
                content: () => template.content,
                name: () => replaceFileExtension(state.name, template.defaultFileName),
                isDeletingTemplate: () => false,
                maybeAlertBanner: () => Option.none(),
              }),
              outMessage: OutMessage.None(),
            }),
          },
        )
      }),

    ClickedOpenSaveTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isSavingTemplate: () => true,
          isDeletingTemplate: () => false,
          newTemplateLabel: () => state.name.trim() || "Meine Vorlage",
          maybeAlertBanner: () => Option.none(),
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedCancelSaveTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isSavingTemplate: () => false,
          newTemplateLabel: () => "",
          maybeAlertBanner: () => Option.none(),
        }),
        outMessage: OutMessage.None(),
      })),

    UpdatedNewTemplateLabel: ({ label }) =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          newTemplateLabel: () => label,
          maybeAlertBanner: () => Option.none(),
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedConfirmSaveTemplate: () =>
      whenCreateFile(model, (state) => {
        const trimmedLabel = state.newTemplateLabel.trim()
        if (!trimmedLabel) {
          return { model: state, outMessage: OutMessage.None() }
        }
        return {
          model: modifyFields(state, {
            maybeAlertBanner: () => Option.none(),
          }),
          commands: [GenerateTemplateTimestamp()],
          outMessage: OutMessage.None(),
        }
      }),

    GeneratedTemplateTimestamp: ({ timestamp }) =>
      whenCreateFile(model, (state) => {
        const trimmedLabel = state.newTemplateLabel.trim()
        if (!trimmedLabel) {
          return { model: state, outMessage: OutMessage.None() }
        }
        // NOTE: name, id and file name must match what storage reloads from disk
        const takenNames = new Set(Array.map(state.userTemplates, (t) => t.label.toLowerCase()))
        const baseName = sanitizeTemplateName(trimmedLabel)
        const dot = baseName.lastIndexOf(".")
        const stem = dot > 0 ? baseName.slice(0, dot) : baseName
        const ext = dot > 0 ? baseName.slice(dot) : ""
        // NOTE: never overwrite an existing template; append a counter instead
        const name =
          Array.makeBy(1000, (i) => (i === 0 ? baseName : `${stem} (${i + 1})${ext}`)).find(
            (candidate) => !takenNames.has(candidate.toLowerCase()),
          ) ?? `${stem}-${timestamp}${ext}`
        const id = `user:${name}`
        const newTemplate: StarterTemplate = {
          id,
          label: name,
          defaultFileName: name,
          content: state.content,
          isBuiltin: false,
        }
        const nextTemplates = [...state.userTemplates, newTemplate]
        return {
          model: modifyFields(state, {
            userTemplates: () => nextTemplates,
            selectedTemplateId: () => id,
            isSavingTemplate: () => false,
            newTemplateLabel: () => "",
            maybeAlertBanner: () => Option.none(),
          }),
          commands: [
            SaveUserTemplate({
              template: newTemplate,
            }),
          ],
          outMessage: OutMessage.None(),
        }
      }),

    ClickedOpenDeleteTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isDeletingTemplate: () => true,
          isSavingTemplate: () => false,
          maybeAlertBanner: () => Option.none(),
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedCancelDeleteTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isDeletingTemplate: () => false,
          maybeAlertBanner: () => Option.none(),
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedConfirmDeleteTemplate: () =>
      whenCreateFile(model, (state) => {
        const templateToDelete = Array.findFirst(
          state.userTemplates,
          (t) => t.id === state.selectedTemplateId,
        )
        if (Option.isNone(templateToDelete)) {
          return {
            model: modifyFields(state, {
              isDeletingTemplate: () => false,
              maybeAlertBanner: () => Option.none(),
            }),
            outMessage: OutMessage.None(),
          }
        }
        const nextTemplates = Array.filter(
          state.userTemplates,
          (t) => t.id !== state.selectedTemplateId,
        )
        return {
          model: modifyFields(state, {
            userTemplates: () => nextTemplates,
            selectedTemplateId: () => "builtin:empty",
            isDeletingTemplate: () => false,
            maybeAlertBanner: () => Option.none(),
          }),
          commands: [
            DeleteUserTemplate({
              name: templateToDelete.value.label,
              templateId: templateToDelete.value.id,
            }),
          ],
          outMessage: OutMessage.None(),
        }
      }),

    CompletedLoadUserTemplates: ({ templates }) =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          userTemplates: () => templates,
        }),
        outMessage: OutMessage.None(),
      })),

    CompletedSaveUserTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: state,
        outMessage: OutMessage.None(),
      })),

    CompletedDeleteUserTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: state,
        outMessage: OutMessage.None(),
      })),

    ToggledBase64: ({ isChecked }) =>
      whenBinaryEditor(model, (editState, binaryMode) => {
        const isLocked = BinaryEdit.match(binaryMode.edit, {
          Locked: () => true,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => false,
        })
        if (isLocked) {
          return { model, outMessage: OutMessage.None() }
        }

        if (!isChecked) {
          return {
            model: modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  edit: () => BinaryEdit.Disabled(),
                }),
              maybeAlertBanner: () => Option.none(),
            }),
            outMessage: OutMessage.None(),
          }
        }

        return {
          model: modifyFields(editState, {
            fileMode: () =>
              modifyFields(binaryMode, {
                edit: () => BinaryEdit.Loading(),
              }),
            maybeAlertBanner: () => Option.none(),
          }),
          commands: [LoadBase64({ entryName: editState.originalName, subPath: context.subPath })],
          outMessage: OutMessage.None(),
        }
      }),

    SucceededLoadBase64: ({ base64Content }) =>
      whenBinaryEditor(model, (editState, binaryMode) => ({
        model: modifyFields(editState, {
          fileMode: () =>
            modifyFields(binaryMode, {
              edit: () => BinaryEdit.Editing({ content: base64Content }),
            }),
          maybeAlertBanner: () => Option.none(),
        }),
        outMessage: OutMessage.None(),
      })),

    FailedLoadBase64: ({ message: errorMessage }) =>
      whenBinaryEditor(model, (editState, binaryMode) => ({
        model: setAlertBanner(
          modifyFields(editState, {
            fileMode: () =>
              modifyFields(binaryMode, {
                edit: () => BinaryEdit.Disabled(),
              }),
          }),
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
        ),
        outMessage: OutMessage.None(),
      })),

    UpdatedBase64Content: ({ base64Content }) =>
      whenBinaryEditor(model, (editState, binaryMode) => {
        const isEditing = BinaryEdit.match(binaryMode.edit, {
          Locked: () => false,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => true,
        })
        if (!isEditing) {
          return { model, outMessage: OutMessage.None() }
        }

        return {
          model: modifyFields(editState, {
            fileMode: () =>
              modifyFields(binaryMode, {
                edit: () => BinaryEdit.Editing({ content: base64Content }),
              }),
            maybeAlertBanner: () => Option.none(),
          }),
          outMessage: OutMessage.None(),
        }
      }),

    ClickedToggleLlmBar: () => ({
      model: toggleLlmBar(model),
      outMessage: OutMessage.None(),
    }),

    ClickedToggleMaximize: () => ({
      model: Model.match(model, {
        CreateFile: (state) => modifyFields(state, { isMaximized: (max) => !max }),
        EditFile: (state) => modifyFields(state, { isMaximized: (max) => !max }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmDelete: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    ClickedCopyDts: () => ({
      model: setAlertBanner(model, Option.none()),
      commands: [CopyApiDtsToClipboard()],
      outMessage: OutMessage.None(),
    }),

    SucceededCopyApiDtsToClipboard: () => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: "/api.d.ts in die Zwischenablage kopiert",
          variant: "info",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    FailedCopyApiDtsToClipboard: ({ message: errorMessage }) => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: errorMessage,
          variant: "danger",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    ClickedCopyLlmContext: () =>
      Option.match(getTextFileContext(model), {
        onNone: () => ({ model, outMessage: OutMessage.None() }),
        onSome: ({ fileName, content }) => ({
          model: setAlertBanner(setPasteError(model, Option.none()), Option.none()),
          commands: [CopyLlmContextToClipboard({ fileName, content })],
          outMessage: OutMessage.None(),
        }),
      }),

    SucceededCopyLlmContext: () => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: "Datei und /api.d.ts für KI in die Zwischenablage kopiert",
          variant: "info",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    ClickedDismissAlert: () => ({
      model: setAlertBanner(model, Option.none()),
      outMessage: OutMessage.None(),
    }),

    FailedCopyLlmContext: ({ message: errorMessage }) => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: errorMessage,
          variant: "danger",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    ClickedCopyFileHashes: () =>
      Option.match(getTextFileContext(model), {
        onNone: () => ({ model, outMessage: OutMessage.None() }),
        onSome: ({ fileName, content }) => ({
          model: setAlertBanner(setPasteError(model, Option.none()), Option.none()),
          commands: [CopyFileHashesToClipboard({ fileName, content })],
          outMessage: OutMessage.None(),
        }),
      }),

    SucceededCopyFileHashes: () => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: "Datei mit Hashes in die Zwischenablage kopiert",
          variant: "info",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    FailedCopyFileHashes: ({ message: errorMessage }) => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: errorMessage,
          variant: "danger",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    ClickedPasteLlmEdits: () => ({
      model: setAlertBanner(setPasteError(model, Option.none()), Option.none()),
      commands: [ReadClipboardForLlmEdits()],
      outMessage: OutMessage.None(),
    }),

    SucceededReadClipboardForLlmEdits: ({ text }) =>
      Option.match(getTextFileContext(model), {
        onNone: () => ({ model, outMessage: OutMessage.None() }),
        onSome: ({ fileName, content: currentContent }) =>
          HashlineApplyResult.match(applyHashlineEdits(currentContent, text), {
            Ok: ({ content: nextContent, appliedCount, changedLines }) => ({
              model: applyTextContentUpdate(
                model,
                nextContent,
                Option.some({
                  message: `${appliedCount} Bearbeitung(en) angewendet – neue Hashes in die Zwischenablage kopiert`,
                  variant: "info",
                }),
              ),
              commands: [CopyUpdatedHashesToClipboard({ fileName, changedLines })],
              outMessage: OutMessage.None(),
            }),
            Error: ({ message: errorMessage }) => ({
              model: setAlertBanner(
                setPasteError(model, Option.some(errorMessage)),
                Option.some({
                  message: errorMessage,
                  variant: "danger",
                }),
              ),
              commands: [CopyPasteErrorToClipboard({ errorText: errorMessage })],
              outMessage: OutMessage.None(),
            }),
          }),
      }),

    SucceededCopyUpdatedHashes: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    FailedCopyUpdatedHashes: ({ message: errorMessage }) => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: errorMessage,
          variant: "danger",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    FailedReadClipboardForLlmEdits: ({ message: errorMessage }) => ({
      model: setAlertBanner(
        setPasteError(model, Option.some(errorMessage)),
        Option.some({
          message: errorMessage,
          variant: "danger",
        }),
      ),
      commands: [CopyPasteErrorToClipboard({ errorText: errorMessage })],
      outMessage: OutMessage.None(),
    }),

    CompletedCopyPasteErrorToClipboard: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    ClickedSave: () => handleSaveAction(model, context, false),

    ClickedSaveAndOpen: () => handleSaveAction(model, context, true),

    ClickedConfirmOverwrite: () => ({
      model: modifyFields(model, {
        maybeAlertBanner: () => Option.none(),
      }),
      commands: [SaveChanges({ model, subPath: context.subPath })],
      outMessage: OutMessage.None(),
    }),

    ClickedCancelOverwrite: () =>
      Model.match(model, {
        ConfirmOverwrite: ({ targetName, source }) =>
          OverwriteSource.match(source, {
            CreateFile: ({ content, selectedTemplateId, userTemplates }) => ({
              model: Model.CreateFile({
                name: targetName,
                content,
                selectedTemplateId,
                userTemplates,
                isSavingTemplate: false,
                isDeletingTemplate: false,
                newTemplateLabel: "",
                maybeValidationError: Option.none(),
                maybeAlertBanner: Option.none(),
                maybePasteError: Option.none(),
                isLlmBarOpen: false,
                isMaximized: false,
              }),
              outMessage: OutMessage.None(),
            }),
            EditFile: ({ originalName, fileMode }) => ({
              model: Model.EditFile({
                originalName,
                name: targetName,
                fileMode,
                maybeValidationError: Option.none(),
                maybeAlertBanner: Option.none(),
                maybePasteError: Option.none(),
                isLlmBarOpen: false,
                isMaximized: false,
              }),
              outMessage: OutMessage.None(),
            }),
          }),
        CreateFile: () => ({ model, outMessage: OutMessage.None() }),
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        EditFolder: () => ({ model, outMessage: OutMessage.None() }),
        EditFile: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmDelete: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedDelete: () =>
      Model.match(model, {
        EditFolder: ({ originalName }) => ({
          model: Model.ConfirmDelete({
            entryName: originalName,
            entryKind: "directory",
            maybeAlertBanner: Option.none(),
          }),
          outMessage: OutMessage.None(),
        }),
        EditFile: ({ originalName }) => ({
          model: Model.ConfirmDelete({
            entryName: originalName,
            entryKind: "file",
            maybeAlertBanner: Option.none(),
          }),
          outMessage: OutMessage.None(),
        }),
        CreateFile: () => ({ model, outMessage: OutMessage.None() }),
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmDelete: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmOverwrite: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedConfirmDelete: () =>
      Model.match(model, {
        ConfirmDelete: ({ entryName, entryKind }) => ({
          model: modifyFields(model, {
            maybeAlertBanner: () => Option.none(),
          }),
          commands: [DeleteEntry({ entryName, entryKind, subPath: context.subPath })],
          outMessage: OutMessage.None(),
        }),
        CreateFile: () => ({ model, outMessage: OutMessage.None() }),
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        EditFolder: () => ({ model, outMessage: OutMessage.None() }),
        EditFile: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmOverwrite: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedCancelDelete: () => ({
      model,
      outMessage: OutMessage.CloseModal({ replaceUrl: true }),
    }),

    ClickedClose: () => ({
      model,
      outMessage: OutMessage.CloseModal({ replaceUrl: true }),
    }),

    SucceededSaveChanges: ({ entries }) => ({
      model,
      outMessage: OutMessage.EntriesUpdated({ entries, closeModal: true }),
    }),

    SucceededSaveAndOpen: ({ entries, savedFileName, url }) => {
      const banner = Option.some({
        message: "Gespeichert und in neuem Tab geöffnet",
        variant: "info" as const,
      })
      const nextModel = Model.match(model, {
        CreateFile: (state) =>
          Model.EditFile({
            originalName: savedFileName,
            name: savedFileName,
            fileMode: EditorFileMode.Text({ content: state.content }),
            maybeValidationError: Option.none(),
            maybeAlertBanner: banner,
            maybePasteError: Option.none(),
            isLlmBarOpen: state.isLlmBarOpen,
            isMaximized: state.isMaximized,
          }),
        EditFile: (state) =>
          modifyFields(state, {
            originalName: () => savedFileName,
            name: () => savedFileName,
            maybeValidationError: () => Option.none(),
            maybeAlertBanner: () => banner,
            maybePasteError: () => Option.none(),
          }),
        CreateFolder: () => setAlertBanner(model, banner),
        EditFolder: () => setAlertBanner(model, banner),
        ConfirmDelete: () => setAlertBanner(model, banner),
        ConfirmOverwrite: () => setAlertBanner(model, banner),
      })

      return {
        model: nextModel,
        commands: [OpenUrlInNewTab({ url })],
        outMessage: OutMessage.EntriesUpdated({ entries, closeModal: false }),
      }
    },

    CompletedOpenInNewTab: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    FailedSaveChanges: ({ message: errorMessage }) => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: errorMessage,
          variant: "danger",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    SucceededDeleteEntry: ({ entries }) => ({
      model,
      outMessage: OutMessage.EntriesUpdated({ entries, closeModal: true }),
    }),

    FailedDeleteEntry: ({ message: errorMessage }) => ({
      model: setAlertBanner(
        model,
        Option.some({
          message: errorMessage,
          variant: "danger",
        }),
      ),
      outMessage: OutMessage.None(),
    }),

    CompletedFocusNameInput: () => ({
      model,
      outMessage: OutMessage.None(),
    }),
  })

// VIEW

const viewTemplatePicker = (state: CreateFileModel, h: Html.HtmlBuilder<Message>): Html.Html => {
  const selectedTemplate = Array.findFirst(
    state.userTemplates,
    (t) => t.id === state.selectedTemplateId,
  )
  const isCustomSelected = Option.isSome(selectedTemplate)
  const selectedTemplateLabel = Option.match(selectedTemplate, {
    onNone: () => "Vorlage",
    onSome: (t) => t.label,
  })

  return h.div(
    [h.Class("form-group")],
    [
      h.label([h.For("modal-template-select")], ["Vorlage:"]),
      h.div(
        [h.Class("template-toolbar")],
        [
          h.select(
            [
              h.Id("modal-template-select"),
              h.Class("form-input"),
              h.Value(state.selectedTemplateId),
              h.OnChange((templateId) => Message.SelectedTemplate({ templateId })),
            ],
            [
              ...(Array.isReadonlyArrayNonEmpty(state.userTemplates)
                ? [
                    h.optgroup(
                      [h.LabelAttr("Eigene Vorlagen")],
                      pipe(
                        state.userTemplates,
                        Array.map((t) =>
                          h.option(
                            [h.Value(t.id), h.Selected(t.id === state.selectedTemplateId)],
                            [t.label],
                          ),
                        ),
                      ),
                    ),
                  ]
                : []),
              h.optgroup(
                [h.LabelAttr("Standard-Vorlagen")],
                pipe(
                  BUILTIN_TEMPLATES,
                  Array.map((t) =>
                    h.option(
                      [h.Value(t.id), h.Selected(t.id === state.selectedTemplateId)],
                      [t.label],
                    ),
                  ),
                ),
              ),
            ],
          ),
          !state.isSavingTemplate && !state.isDeletingTemplate
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-save-template"),
                  h.Class("btn btn-secondary btn-icon"),
                  h.Title("Aktuellen Inhalt als eigene Vorlage speichern"),
                  h.AriaLabel("Aktuellen Inhalt als eigene Vorlage speichern"),
                  h.OnClick(Message.ClickedOpenSaveTemplate()),
                ],
                [viewIcon("save", h)],
              )
            : h.empty,
          isCustomSelected && !state.isSavingTemplate && !state.isDeletingTemplate
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-delete-template"),
                  h.Class("btn btn-danger btn-icon"),
                  h.Title("Ausgewählte eigene Vorlage löschen"),
                  h.AriaLabel("Ausgewählte eigene Vorlage löschen"),
                  h.OnClick(Message.ClickedOpenDeleteTemplate()),
                ],
                [viewIcon("trash", h)],
              )
            : h.empty,
        ],
      ),
      state.isSavingTemplate
        ? h.div(
            [h.Id("modal-save-template-box"), h.Class("template-save-row")],
            [
              h.input([
                h.Type("text"),
                h.Id("modal-template-name"),
                h.Class("form-input"),
                h.Placeholder("Name der Vorlage (z. B. Mein Dashboard)"),
                h.Value(state.newTemplateLabel),
                h.OnInput((label) => Message.UpdatedNewTemplateLabel({ label })),
              ]),
              h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-cancel-save-template"),
                  h.Class("btn btn-secondary icon-label-btn"),
                  h.AriaLabel("Abbrechen"),
                  h.DataAttribute("tip", "Abbrechen"),
                  h.OnClick(Message.ClickedCancelSaveTemplate()),
                ],
                [
                  h.span(
                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                    [viewIcon("close", h)],
                  ),
                  h.span([h.Class("icon-label-btn-text")], ["Abbrechen"]),
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-confirm-save-template"),
                  h.Class("btn btn-primary icon-label-btn"),
                  h.AriaLabel("Speichern"),
                  h.DataAttribute("tip", "Speichern"),
                  h.OnClick(Message.ClickedConfirmSaveTemplate()),
                ],
                [
                  h.span(
                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                    [viewIcon("save", h)],
                  ),
                  h.span([h.Class("icon-label-btn-text")], ["Speichern"]),
                ],
              ),
            ],
          )
        : h.empty,
      state.isDeletingTemplate
        ? h.div(
            [h.Id("modal-delete-template-box"), h.Class("template-save-row")],
            [
              h.span(
                [h.Class("template-delete-prompt")],
                [`Vorlage „${selectedTemplateLabel}“ wirklich löschen?`],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-cancel-delete-template"),
                  h.Class("btn btn-secondary icon-label-btn"),
                  h.AriaLabel("Abbrechen"),
                  h.DataAttribute("tip", "Abbrechen"),
                  h.OnClick(Message.ClickedCancelDeleteTemplate()),
                ],
                [
                  h.span(
                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                    [viewIcon("close", h)],
                  ),
                  h.span([h.Class("icon-label-btn-text")], ["Abbrechen"]),
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-confirm-delete-template"),
                  h.Class("btn btn-danger icon-label-btn"),
                  h.AriaLabel("Löschen"),
                  h.DataAttribute("tip", "Löschen"),
                  h.OnClick(Message.ClickedConfirmDeleteTemplate()),
                ],
                [
                  h.span(
                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                    [viewIcon("trash", h)],
                  ),
                  h.span([h.Class("icon-label-btn-text")], ["Löschen"]),
                ],
              ),
            ],
          )
        : h.empty,
    ],
  )
}

const viewPreviewContent = (preview: PreviewContent, h: Html.HtmlBuilder<Message>): Html.Html =>
  PreviewContent.match(preview, {
    None: () => h.empty,
    Image: ({ objectUrl }) =>
      h.figure(
        [h.Id("modal-file-preview"), h.Class("file-preview")],
        [h.img([h.Src(objectUrl), h.Alt("Vorschau der Datei"), h.Class("file-preview-image")])],
      ),
    Pdf: ({ objectUrl }) =>
      h.figure(
        [h.Id("modal-file-preview"), h.Class("file-preview")],
        [h.iframe([h.Src(objectUrl), h.Title("Vorschau der Datei"), h.Class("file-preview-pdf")])],
      ),
  })

const viewEditorFileBody = (
  fileMode: EditorFileMode,
  h: Html.HtmlBuilder<Message>,
): ReadonlyArray<Html.Html> =>
  EditorFileMode.match(fileMode, {
    Text: ({ content }) => [
      h.div(
        [h.Class("form-group")],
        [
          h.label([h.For("modal-file-content")], ["Inhalt:"]),
          h.textarea([
            h.Id("modal-file-content"),
            h.Class("form-textarea"),
            h.Placeholder("Geben Sie hier den Dateiinhalt ein..."),
            h.Spellcheck(false),
            h.Value(content),
            h.OnInput((text) => Message.UpdatedTextContent({ content: text })),
          ]),
        ],
      ),
    ],

    Binary: ({ preview, edit }) => {
      const { isLocked, isChecked, isLoading, isEditing, lockReason, base64Content } =
        BinaryEdit.match(edit, {
          Locked: ({ reason }) => ({
            isLocked: true,
            isChecked: false,
            isLoading: false,
            isEditing: false,
            lockReason: reason,
            base64Content: "",
          }),
          Disabled: () => ({
            isLocked: false,
            isChecked: false,
            isLoading: false,
            isEditing: false,
            lockReason: "",
            base64Content: "",
          }),
          Loading: () => ({
            isLocked: false,
            isChecked: true,
            isLoading: true,
            isEditing: false,
            lockReason: "",
            base64Content: "",
          }),
          Editing: ({ content }) => ({
            isLocked: false,
            isChecked: true,
            isLoading: false,
            isEditing: true,
            lockReason: "",
            base64Content: content,
          }),
        })

      return [
        h.div(
          [h.Class("form-group")],
          [
            !isLocked
              ? h.label(
                  [h.Class("form-check")],
                  [
                    h.input([
                      h.Type("checkbox"),
                      h.Id("modal-use-base64"),
                      h.Checked(isChecked),
                      h.Disabled(isLoading),
                      h.OnChange(() =>
                        Message.ToggledBase64({
                          isChecked: !isChecked,
                        }),
                      ),
                    ]),
                    h.span([], ["Binärdatei bearbeiten"]),
                  ],
                )
              : h.p([h.Class("form-hint")], [lockReason]),
            isEditing
              ? h.div(
                  [h.Id("modal-base64-editor"), h.Class("form-group")],
                  [
                    h.label([h.For("modal-file-content-b64")], ["Base64-Inhalt:"]),
                    h.textarea([
                      h.Id("modal-file-content-b64"),
                      h.Class("form-textarea form-textarea-mono"),
                      h.Spellcheck(false),
                      h.Placeholder("Base64-Daten dieser Datei"),
                      h.Value(base64Content),
                      h.OnInput((value) =>
                        Message.UpdatedBase64Content({
                          base64Content: value,
                        }),
                      ),
                    ]),
                  ],
                )
              : h.empty,
            isChecked ? h.empty : viewPreviewContent(preview, h),
          ],
        ),
      ]
    },
  })

const viewModalAlertBanner = (
  maybeAlertBanner: Option.Option<AlertBanner>,
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
  Option.match(maybeAlertBanner, {
    onNone: () => h.empty,
    onSome: (banner) =>
      h.div(
        [
          h.Id("modal-alert-area"),
          h.Class(`alert alert-${banner.variant} alert-dismissible mb-3 modal-alert-banner`),
          h.Role(banner.variant === "danger" ? "alert" : "status"),
          h.AriaLive("polite"),
        ],
        [
          h.span([h.Class("alert-message")], [banner.message]),
          h.button(
            [
              h.Type("button"),
              h.Class("alert-close-btn"),
              h.AriaLabel("Hinweis schließen"),
              h.OnClick(Message.ClickedDismissAlert()),
            ],
            [viewIcon("close", h)],
          ),
        ],
      ),
  })

const viewLlmButtons = (
  maybePasteError: Option.Option<string>,
  h: Html.HtmlBuilder<Message>,
): ReadonlyArray<Html.Html> => [
  h.button(
    [
      h.Type("button"),
      h.Id("modal-btn-copy-dts"),
      h.Class("btn btn-secondary icon-label-btn"),
      h.AriaLabel("/app.d.ts kopieren"),
      h.DataAttribute("tip", "/app.d.ts kopieren"),
      h.OnClick(Message.ClickedCopyDts()),
    ],
    [
      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("clipboard", h)]),
      h.span([h.Class("icon-label-btn-text")], ["/app.d.ts"]),
    ],
  ),
  h.button(
    [
      h.Type("button"),
      h.Id("modal-btn-copy-llm"),
      h.Class("btn btn-secondary icon-label-btn"),
      h.AriaLabel("Datei, /api.d.ts und Anleitung für KI kopieren"),
      h.DataAttribute("tip", "Datei, /api.d.ts und Anleitung kopieren"),
      h.OnClick(Message.ClickedCopyLlmContext()),
    ],
    [
      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("clipboard", h)]),
      h.span([h.Class("icon-label-btn-text")], ["Mit Anleitung"]),
    ],
  ),
  h.button(
    [
      h.Type("button"),
      h.Id("modal-btn-copy-hashes"),
      h.Class("btn btn-secondary icon-label-btn"),
      h.AriaLabel("Nur Datei mit Hashes kopieren"),
      h.DataAttribute("tip", "Nur Datei mit Hashes kopieren"),
      h.OnClick(Message.ClickedCopyFileHashes()),
    ],
    [
      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("clipboard", h)]),
      h.span([h.Class("icon-label-btn-text")], ["Datei"]),
    ],
  ),
  Option.match(maybePasteError, {
    onNone: () =>
      h.button(
        [
          h.Type("button"),
          h.Id("modal-btn-paste-llm"),
          h.Class("btn btn-secondary icon-label-btn"),
          h.AriaLabel("KI-Änderungen einfügen"),
          h.DataAttribute("tip", "KI-Änderungen einfügen"),
          h.OnClick(Message.ClickedPasteLlmEdits()),
        ],
        [
          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("install", h)]),
          h.span([h.Class("icon-label-btn-text")], ["Einfügen"]),
        ],
      ),
    onSome: (pasteError) =>
      h.button(
        [
          h.Type("button"),
          h.Id("modal-btn-paste-llm"),
          h.Class("btn btn-danger icon-label-btn"),
          h.AriaLabel(`Fehler beim Einfügen: ${pasteError}`),
          h.DataAttribute("tip", "Fehler (in Zwischenablage kopiert)"),
          h.OnClick(Message.ClickedPasteLlmEdits()),
        ],
        [
          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("warning", h)]),
          h.span([h.Class("icon-label-btn-text")], ["Fehler"]),
        ],
      ),
  }),
]

const viewEditorModal = (
  {
    titleText,
    noun,
    isFolder,
    isTextFile,
    isLlmBarOpen,
    isMaximized,
    isEditingExisting,
    nameValue,
    maybeValidationError,
    maybeAlertBanner,
    maybePasteError,
    extraBodyNodes,
  }: {
    readonly titleText: string
    readonly noun: "Datei" | "Ordner"
    readonly isFolder: boolean
    readonly isTextFile: boolean
    readonly isLlmBarOpen: boolean
    readonly isMaximized: boolean
    readonly isEditingExisting: boolean
    readonly nameValue: string
    readonly maybeValidationError: Option.Option<string>
    readonly maybeAlertBanner: Option.Option<AlertBanner>
    readonly maybePasteError: Option.Option<string>
    readonly extraBodyNodes: ReadonlyArray<Html.Html>
  },
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const saveLabel = isEditingExisting ? "Speichern" : "Erstellen"

  return h.div(
    [
      h.Class(isMaximized ? "modal-overlay modal-overlay-maximized" : "modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy("modal-title"),
    ],
    [
      h.div(
        [h.Class(isMaximized ? "modal-content is-maximized" : "modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3([h.Id("modal-title"), h.Class("modal-title")], [titleText]),
              h.div(
                [h.Class("modal-header-actions")],
                [
                  !isFolder
                    ? h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-maximize"),
                          h.Class("modal-close-btn modal-header-btn"),
                          h.AriaLabel(isMaximized ? "Wiederherstellen" : "Maximieren"),
                          h.AriaPressed(isMaximized ? "true" : "false"),
                          h.Title(isMaximized ? "Wiederherstellen" : "Maximieren"),
                          h.OnClick(Message.ClickedToggleMaximize()),
                        ],
                        [viewIcon(isMaximized ? "restore" : "maximize", h)],
                      )
                    : h.empty,
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("modal-close-btn"),
                      h.AriaLabel("Schließen"),
                      h.OnClick(Message.ClickedClose()),
                    ],
                    [viewIcon("close", h)],
                  ),
                ],
              ),
            ],
          ),
          h.form(
            [h.Id("modal-form"), h.OnSubmit(Message.ClickedSave())],
            [
              h.div(
                [h.Class("modal-body")],
                [
                  viewModalAlertBanner(maybeAlertBanner, h),
                  Option.match(maybeValidationError, {
                    onNone: () => h.empty,
                    onSome: (error) =>
                      h.div([h.Class("alert alert-danger mb-3"), h.Role("alert")], [error]),
                  }),
                  h.div(
                    [h.Class("form-group")],
                    [
                      h.label([h.For("modal-file-name")], [`${noun}name:`]),
                      h.input([
                        h.Type("text"),
                        h.Id("modal-file-name"),
                        h.Class("form-input"),
                        h.Value(nameValue),
                        h.Required(true),
                        h.Placeholder(isFolder ? "z. B. projekte" : "z. B. index.html, daten.json"),
                        h.Autocomplete("off"),
                        h.OnInput((name) => Message.UpdatedName({ name })),
                      ]),
                    ],
                  ),
                  ...extraBodyNodes,
                ],
              ),
              h.footer(
                [h.Class("modal-footer")],
                [
                  ...(isTextFile && isLlmBarOpen
                    ? viewLlmButtons(maybePasteError, h)
                    : isEditingExisting
                      ? [
                          h.button(
                            [
                              h.Type("button"),
                              h.Id("modal-btn-delete"),
                              h.Class("btn btn-danger icon-label-btn"),
                              h.AriaLabel("Löschen"),
                              h.DataAttribute("tip", "Löschen"),
                              h.OnClick(Message.ClickedDelete()),
                            ],
                            [
                              h.span(
                                [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                                [viewIcon("trash", h)],
                              ),
                              h.span([h.Class("icon-label-btn-text")], ["Löschen"]),
                            ],
                          ),
                        ]
                      : []),
                  isTextFile
                    ? h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-toggle-llm"),
                          h.Class("btn btn-secondary icon-label-btn modal-footer-push-right"),
                          h.AriaLabel("LLM-Werkzeuge"),
                          h.AriaExpanded(isLlmBarOpen),
                          h.DataAttribute("tip", "LLM-Werkzeuge"),
                          h.OnClick(Message.ClickedToggleLlmBar()),
                        ],
                        [
                          h.span(
                            [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                            [viewIcon("ai", h)],
                          ),
                          h.span([h.Class("icon-label-btn-text")], ["LLM"]),
                        ],
                      )
                    : h.empty,
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("modal-btn-cancel"),
                      h.Class(
                        isTextFile
                          ? "btn btn-secondary icon-label-btn"
                          : "btn btn-secondary icon-label-btn modal-footer-push-right",
                      ),
                      h.AriaLabel("Abbrechen"),
                      h.DataAttribute("tip", "Abbrechen"),
                      h.OnClick(Message.ClickedClose()),
                    ],
                    [
                      h.span(
                        [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                        [viewIcon("close", h)],
                      ),
                      h.span([h.Class("icon-label-btn-text")], ["Abbrechen"]),
                    ],
                  ),
                  h.button(
                    [
                      h.Type("submit"),
                      h.Id("modal-btn-save"),
                      h.Class("btn btn-primary icon-label-btn save-modal-btn"),
                      h.AriaLabel(saveLabel),
                      h.DataAttribute("tip", saveLabel),
                      h.OnClick(Message.ClickedSave(), { defaultAction: "Prevent" }),
                    ],
                    [
                      h.span(
                        [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                        [viewIcon("save", h)],
                      ),
                      h.span([h.Class("icon-label-btn-text")], [saveLabel]),
                    ],
                  ),
                  isTextFile && isLlmBarOpen
                    ? h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-save-and-open"),
                          h.Class("btn btn-secondary icon-label-btn"),
                          h.AriaLabel("Speichern und in neuem Tab anzeigen"),
                          h.DataAttribute("tip", "Speichern und in neuem Tab anzeigen"),
                          h.OnClick(Message.ClickedSaveAndOpen()),
                        ],
                        [
                          h.span(
                            [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                            [viewIcon("desktop", h)],
                          ),
                          h.span([h.Class("icon-label-btn-text")], ["Anzeigen"]),
                        ],
                      )
                    : h.empty,
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewConfirmDeleteModal = (
  entryName: string,
  entryKind: FileEntryKind,
  maybeAlertBanner: Option.Option<AlertBanner>,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const isFolder = entryKind === "directory"
  const noun = isFolder ? "den Ordner" : "die Datei"
  return h.div(
    [
      h.Class("modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy("modal-title"),
    ],
    [
      h.div(
        [h.Class("modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3([h.Id("modal-title"), h.Class("modal-title")], ["Eintrag löschen"]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.ClickedCancelDelete()),
                ],
                [viewIcon("close", h)],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              viewModalAlertBanner(maybeAlertBanner, h),
              h.p(
                [],
                [
                  isFolder
                    ? `Möchten Sie ${noun} „${entryName}“ und dessen gesamten Inhalt wirklich unwiderruflich löschen?`
                    : `Möchten Sie ${noun} „${entryName}“ wirklich unwiderruflich löschen?`,
                ],
              ),
            ],
          ),
          h.footer(
            [h.Class("modal-footer")],
            [
              h.div([h.Class("modal-footer-left")]),
              h.div(
                [h.Class("modal-footer-right")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-secondary"),
                      h.OnClick(Message.ClickedCancelDelete()),
                    ],
                    ["Abbrechen"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-danger"),
                      h.OnClick(Message.ClickedConfirmDelete()),
                    ],
                    ["Löschen"],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewConfirmOverwriteModal = (
  targetName: string,
  maybeAlertBanner: Option.Option<AlertBanner>,
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
  h.div(
    [
      h.Class("modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy("modal-title"),
    ],
    [
      h.div(
        [h.Class("modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3([h.Id("modal-title"), h.Class("modal-title")], ["Datei überschreiben?"]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.ClickedCancelOverwrite()),
                ],
                [viewIcon("close", h)],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              viewModalAlertBanner(maybeAlertBanner, h),
              h.p(
                [],
                [
                  `Ein Eintrag mit dem Namen „${targetName}“ existiert bereits. Möchten Sie ihn überschreiben?`,
                ],
              ),
            ],
          ),
          h.footer(
            [h.Class("modal-footer")],
            [
              h.div([h.Class("modal-footer-left")]),
              h.div(
                [h.Class("modal-footer-right")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-secondary"),
                      h.OnClick(Message.ClickedCancelOverwrite()),
                    ],
                    ["Abbrechen"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-danger"),
                      h.OnClick(Message.ClickedConfirmOverwrite()),
                    ],
                    ["Überschreiben"],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h): Html.Html =>
  Model.match(model, {
    CreateFile: (state) =>
      viewEditorModal(
        {
          titleText: "Neue Datei erstellen",
          noun: "Datei",
          isFolder: false,
          isTextFile: true,
          isLlmBarOpen: state.isLlmBarOpen,
          isMaximized: state.isMaximized,
          isEditingExisting: false,
          nameValue: state.name,
          maybeValidationError: state.maybeValidationError,
          maybeAlertBanner: state.maybeAlertBanner,
          maybePasteError: state.maybePasteError,
          extraBodyNodes: [
            viewTemplatePicker(state, h),
            ...viewEditorFileBody(EditorFileMode.Text({ content: state.content }), h),
          ],
        },
        h,
      ),

    CreateFolder: ({ name, maybeValidationError, maybeAlertBanner }) =>
      viewEditorModal(
        {
          titleText: "Neuen Ordner erstellen",
          noun: "Ordner",
          isFolder: true,
          isTextFile: false,
          isLlmBarOpen: false,
          isMaximized: false,
          isEditingExisting: false,
          nameValue: name,
          maybeValidationError,
          maybeAlertBanner,
          maybePasteError: Option.none(),
          extraBodyNodes: [],
        },
        h,
      ),

    EditFolder: ({ originalName, name, maybeValidationError, maybeAlertBanner }) =>
      viewEditorModal(
        {
          titleText: `Ordner bearbeiten: ${originalName}`,
          noun: "Ordner",
          isFolder: true,
          isTextFile: false,
          isLlmBarOpen: false,
          isMaximized: false,
          isEditingExisting: true,
          nameValue: name,
          maybeValidationError,
          maybeAlertBanner,
          maybePasteError: Option.none(),
          extraBodyNodes: [],
        },
        h,
      ),

    EditFile: ({
      originalName,
      name,
      fileMode,
      maybeValidationError,
      maybeAlertBanner,
      maybePasteError,
      isLlmBarOpen,
      isMaximized,
    }) =>
      viewEditorModal(
        {
          titleText: `Datei bearbeiten: ${originalName}`,
          noun: "Datei",
          isFolder: false,
          isTextFile: fileMode._tag === "Text",
          isLlmBarOpen,
          isMaximized,
          isEditingExisting: true,
          nameValue: name,
          maybeValidationError,
          maybeAlertBanner,
          maybePasteError,
          extraBodyNodes: viewEditorFileBody(fileMode, h),
        },
        h,
      ),

    ConfirmDelete: ({ entryName, entryKind, maybeAlertBanner }) =>
      viewConfirmDeleteModal(entryName, entryKind, maybeAlertBanner, h),

    ConfirmOverwrite: ({ targetName, maybeAlertBanner }) =>
      viewConfirmOverwriteModal(targetName, maybeAlertBanner, h),
  }),
)
