import { Array, Effect, Match, Option, Schema } from "effect"
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

export { BinaryEdit, EditorFileMode, PreviewContent }

// MODEL

export const OverwriteSource = defineTaggedUnion({
  CreateFile: {
    content: Schema.String,
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
    maybeValidationError: Schema.Option(Schema.String),
  },
  CreateFolder: {
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
  },
  EditFolder: {
    originalName: Schema.String,
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
  },
  EditFile: {
    originalName: Schema.String,
    name: Schema.String,
    fileMode: EditorFileMode,
    maybeValidationError: Schema.Option(Schema.String),
  },
  ConfirmDelete: {
    entryName: Schema.String,
    entryKind: FileEntryKind,
  },
  ConfirmOverwrite: {
    targetName: Schema.String,
    source: OverwriteSource,
  },
})
export type Model = typeof Model.Type

type EditFileModel = Extract<Model, { readonly _tag: "EditFile" }>
type BinaryFileMode = Extract<EditorFileMode, { readonly _tag: "Binary" }>

export const AlertVariant = Schema.Literals(["info", "warning", "danger"])
export type AlertVariant = typeof AlertVariant.Type

export const AlertBanner = Schema.Struct({
  message: Schema.String,
  variant: AlertVariant,
})
export type AlertBanner = typeof AlertBanner.Type

// MESSAGE & OUTMESSAGE

export const Message = defineMessageUnion({
  UpdatedName: {
    name: Schema.String,
  },
  UpdatedTextContent: {
    content: Schema.String,
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
  ClickedSave: {},
  ClickedConfirmOverwrite: {},
  ClickedCancelOverwrite: {},
  ClickedDelete: {},
  ClickedConfirmDelete: {},
  ClickedCancelDelete: {},
  ClickedClose: {},
  SucceededSaveChanges: {
    entries: Schema.Array(FileEntry),
  },
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
  EntriesUpdated: { entries: Schema.Array(FileEntry) },
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

export const FocusNameInput = Command.define("FocusNameInput", {
  messages: [Message.CompletedFocusNameInput],
  execute: Dom.focus("#modal-file-name").pipe(
    Effect.as(Message.CompletedFocusNameInput()),
    Effect.catch(() => Effect.succeed(Message.CompletedFocusNameInput())),
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

export const SaveChanges = Command.define("SaveChanges", {
  args: {
    model: Model,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededSaveChanges, Message.FailedSaveChanges],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()

        const saveEditedFile = (
          originalName: string,
          targetName: string,
          fileMode: EditorFileMode,
        ) =>
          BinaryOrText(fileMode, {
            text: async (content) => {
              await storage.writeFile(args.subPath, targetName, content)
              if (originalName !== targetName) {
                await storage.deleteEntry(args.subPath, originalName, "file")
              }
            },
            binaryEditing: async (content) => {
              await storage.writeFileBuffer(args.subPath, targetName, base64ToUint8Array(content))
              if (originalName !== targetName) {
                await storage.deleteEntry(args.subPath, originalName, "file")
              }
            },
            binaryRename: () => storage.renameBinaryFile(args.subPath, originalName, targetName),
          })

        await Match.value(args.model).pipe(
          Match.tag("CreateFolder", ({ name }) =>
            storage.createDirectory(args.subPath, name.trim()),
          ),
          Match.tag("EditFolder", async ({ name, originalName }) => {
            const newName = name.trim()
            if (newName !== originalName) {
              await storage.renameDirectory(args.subPath, originalName, newName)
            }
          }),
          Match.tag("CreateFile", ({ name, content }) =>
            storage.writeFile(args.subPath, name.trim(), content),
          ),
          Match.tag("EditFile", async ({ name, originalName, fileMode }) => {
            await saveEditedFile(originalName, name.trim(), fileMode)
          }),
          Match.tag("ConfirmOverwrite", async ({ targetName, source }) => {
            await Match.value(source).pipe(
              Match.tag("CreateFile", async ({ content }) => {
                await storage.writeFile(args.subPath, targetName, content)
              }),
              Match.tag("EditFile", async ({ originalName, fileMode }) => {
                await saveEditedFile(originalName, targetName, fileMode)
              }),
              Match.exhaustive,
            )
          }),
          Match.tag("ConfirmDelete", () => Promise.resolve()),
          Match.exhaustive,
        )

        revokeActivePreviewUrl()
        const updatedEntries = await storage.listEntries(args.subPath)
        return Message.SucceededSaveChanges({ entries: updatedEntries })
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

// UPDATE

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
          }),
        CreateFolder: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
          }),
        EditFolder: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
          }),
        EditFile: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
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
          }),
        CreateFolder: () => model,
        EditFolder: () => model,
        EditFile: (state) =>
          EditorFileMode.match(state.fileMode, {
            Text: () =>
              modifyFields(state, {
                fileMode: () => EditorFileMode.Text({ content }),
              }),
            Binary: () => state,
          }),
        ConfirmDelete: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

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
        }),
        outMessage: OutMessage.None(),
      })),

    FailedLoadBase64: ({ message: errorMessage }) =>
      whenBinaryEditor(model, (editState, binaryMode) => ({
        model: modifyFields(editState, {
          fileMode: () =>
            modifyFields(binaryMode, {
              edit: () => BinaryEdit.Disabled(),
            }),
        }),
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
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
          }),
          outMessage: OutMessage.None(),
        }
      }),

    ClickedSave: () => {
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
              }),
              outMessage: OutMessage.None(),
            }
          }
          return {
            model,
            commands: [SaveChanges({ model: createFolder, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        },
        EditFolder: (editFolder) => {
          const error = validateName(editFolder.name, true)
          if (Option.isSome(error)) {
            return {
              model: modifyFields(editFolder, {
                maybeValidationError: () => error,
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
              }),
              outMessage: OutMessage.None(),
            }
          }
          return {
            model,
            commands: [SaveChanges({ model: editFolder, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        },
        CreateFile: (createFile) => {
          const error = validateName(createFile.name, false)
          if (Option.isSome(error)) {
            return {
              model: modifyFields(createFile, {
                maybeValidationError: () => error,
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
                }),
              }),
              outMessage: OutMessage.None(),
            }
          }
          return {
            model,
            commands: [SaveChanges({ model: createFile, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        },
        EditFile: (editFile) => {
          const error = validateName(editFile.name, false)
          if (Option.isSome(error)) {
            return {
              model: modifyFields(editFile, {
                maybeValidationError: () => error,
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
              }),
              outMessage: OutMessage.None(),
            }
          }

          return {
            model,
            commands: [SaveChanges({ model: editFile, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        },
        ConfirmDelete: () => ({
          model,
          outMessage: OutMessage.None(),
        }),
        ConfirmOverwrite: () => ({
          model,
          commands: [SaveChanges({ model, subPath: context.subPath })],
          outMessage: OutMessage.None(),
        }),
      })
    },

    ClickedConfirmOverwrite: () => ({
      model,
      commands: [SaveChanges({ model, subPath: context.subPath })],
      outMessage: OutMessage.None(),
    }),

    ClickedCancelOverwrite: () =>
      Model.match(model, {
        ConfirmOverwrite: ({ targetName, source }) =>
          OverwriteSource.match(source, {
            CreateFile: ({ content }) => ({
              model: Model.CreateFile({
                name: targetName,
                content,
                maybeValidationError: Option.none(),
              }),
              outMessage: OutMessage.None(),
            }),
            EditFile: ({ originalName, fileMode }) => ({
              model: Model.EditFile({
                originalName,
                name: targetName,
                fileMode,
                maybeValidationError: Option.none(),
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
          model: Model.ConfirmDelete({ entryName: originalName, entryKind: "directory" }),
          outMessage: OutMessage.None(),
        }),
        EditFile: ({ originalName }) => ({
          model: Model.ConfirmDelete({ entryName: originalName, entryKind: "file" }),
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
          model,
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
      outMessage: OutMessage.EntriesUpdated({ entries }),
    }),

    FailedSaveChanges: ({ message: errorMessage }) => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    SucceededDeleteEntry: ({ entries }) => ({
      model,
      outMessage: OutMessage.EntriesUpdated({ entries }),
    }),

    FailedDeleteEntry: ({ message: errorMessage }) => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    CompletedFocusNameInput: () => ({
      model,
      outMessage: OutMessage.None(),
    }),
  })

// VIEW

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

const viewEditorModal = (
  {
    titleText,
    noun,
    isFolder,
    isEditingExisting,
    nameValue,
    maybeValidationError,
    extraBodyNodes,
  }: {
    readonly titleText: string
    readonly noun: "Datei" | "Ordner"
    readonly isFolder: boolean
    readonly isEditingExisting: boolean
    readonly nameValue: string
    readonly maybeValidationError: Option.Option<string>
    readonly extraBodyNodes: ReadonlyArray<Html.Html>
  },
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const saveLabel = isEditingExisting ? "Speichern" : "Erstellen"

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
              h.h3([h.Id("modal-title"), h.Class("modal-title")], [titleText]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.ClickedClose()),
                ],
                ["×"],
              ),
            ],
          ),
          h.form(
            [h.Id("modal-form"), h.OnSubmit(Message.ClickedSave())],
            [
              h.div(
                [h.Class("modal-body")],
                [
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
                  h.div(
                    [h.Class("modal-footer-left")],
                    [
                      isEditingExisting
                        ? h.button(
                            [
                              h.Type("button"),
                              h.Id("modal-btn-delete"),
                              h.Class("btn btn-danger icon-label-btn"),
                              h.AriaLabel("Löschen"),
                              h.DataAttribute("tip", "Löschen"),
                              h.OnClick(Message.ClickedDelete()),
                            ],
                            [
                              h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["🗑️"]),
                              h.span([h.Class("icon-label-btn-text")], ["Löschen"]),
                            ],
                          )
                        : h.empty,
                    ],
                  ),
                  h.div(
                    [h.Class("modal-footer-right")],
                    [
                      h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-cancel"),
                          h.Class("btn btn-secondary icon-label-btn"),
                          h.AriaLabel("Abbrechen"),
                          h.DataAttribute("tip", "Abbrechen"),
                          h.OnClick(Message.ClickedClose()),
                        ],
                        [
                          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["✕"]),
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
                          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["💾"]),
                          h.span([h.Class("icon-label-btn-text")], [saveLabel]),
                        ],
                      ),
                    ],
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

const viewConfirmDeleteModal = (
  entryName: string,
  entryKind: FileEntryKind,
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
                ["×"],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
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

const viewConfirmOverwriteModal = (targetName: string, h: Html.HtmlBuilder<Message>): Html.Html =>
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
                ["×"],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
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
    CreateFile: ({ name, content, maybeValidationError }) =>
      viewEditorModal(
        {
          titleText: "Neue Datei erstellen",
          noun: "Datei",
          isFolder: false,
          isEditingExisting: false,
          nameValue: name,
          maybeValidationError,
          extraBodyNodes: viewEditorFileBody(EditorFileMode.Text({ content }), h),
        },
        h,
      ),

    CreateFolder: ({ name, maybeValidationError }) =>
      viewEditorModal(
        {
          titleText: "Neuen Ordner erstellen",
          noun: "Ordner",
          isFolder: true,
          isEditingExisting: false,
          nameValue: name,
          maybeValidationError,
          extraBodyNodes: [],
        },
        h,
      ),

    EditFolder: ({ originalName, name, maybeValidationError }) =>
      viewEditorModal(
        {
          titleText: `Ordner bearbeiten: ${originalName}`,
          noun: "Ordner",
          isFolder: true,
          isEditingExisting: true,
          nameValue: name,
          maybeValidationError,
          extraBodyNodes: [],
        },
        h,
      ),

    EditFile: ({ originalName, name, fileMode, maybeValidationError }) =>
      viewEditorModal(
        {
          titleText: `Datei bearbeiten: ${originalName}`,
          noun: "Datei",
          isFolder: false,
          isEditingExisting: true,
          nameValue: name,
          maybeValidationError,
          extraBodyNodes: viewEditorFileBody(fileMode, h),
        },
        h,
      ),

    ConfirmDelete: ({ entryName, entryKind }) => viewConfirmDeleteModal(entryName, entryKind, h),

    ConfirmOverwrite: ({ targetName }) => viewConfirmOverwriteModal(targetName, h),
  }),
)
