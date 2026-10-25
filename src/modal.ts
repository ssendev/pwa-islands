import { Array, Effect, Match, Option, Schema, pipe } from "effect"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import * as File from "foldkit/file"
import type * as Html from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import {
  BinaryEdit,
  EditorFileMode,
  PreviewContent,
  arrayBufferToBase64,
  base64ToUint8Array,
  findFreeFileName,
  getPendingImportFiles,
  loadEditorFileModeForEntry,
  requireActiveStorage,
  revokeActivePreviewUrl,
  setPendingImportFiles,
} from "./files"
import * as Help from "./help"
import { AlertBanner, FileEntry, FileEntryKind, buildFolderUrl } from "./route"

export { BinaryEdit, EditorFileMode, PreviewContent }

// MODEL

export const PendingImportFile = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  lastModified: Schema.Number,
})
export type PendingImportFile = typeof PendingImportFile.Type

export const ImportCollisionAction = Schema.Literals(["replace", "rename", "skip"])
export type ImportCollisionAction = typeof ImportCollisionAction.Type

export const ResolvedImportItem = Schema.Struct({
  sourceName: Schema.String,
  targetName: Schema.String,
  action: ImportCollisionAction,
})
export type ResolvedImportItem = typeof ResolvedImportItem.Type

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

export const ModalState = defineTaggedUnion({
  Closed: {},
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
  ImportConflict: {
    current: PendingImportFile,
    suggestedName: Schema.String,
    queue: Schema.Array(PendingImportFile),
    resolved: Schema.Array(ResolvedImportItem),
    applyToAll: Schema.Boolean,
  },
  Help: {
    help: Help.Model,
  },
})
export type ModalState = typeof ModalState.Type

type EditFileState = Extract<ModalState, { readonly _tag: "EditFile" }>
type BinaryFileMode = Extract<EditorFileMode, { readonly _tag: "Binary" }>

// MESSAGE

export const Message = defineMessageUnion({
  GotHelpMessage: {
    message: Help.Message,
  },
  SucceededInspectFileForEditor: {
    originalName: Schema.String,
    fileMode: EditorFileMode,
  },
  FailedInspectFileForEditor: {
    message: Schema.String,
  },
  UpdatedModalName: {
    name: Schema.String,
  },
  UpdatedModalTextContent: {
    content: Schema.String,
  },
  ToggledModalBase64: {
    isChecked: Schema.Boolean,
  },
  SucceededLoadModalBase64: {
    base64Content: Schema.String,
  },
  FailedLoadModalBase64: {
    message: Schema.String,
  },
  UpdatedModalBase64Content: {
    base64Content: Schema.String,
  },
  ClickedSaveModal: {},
  ClickedConfirmOverwrite: {},
  ClickedCancelOverwrite: {},
  ClickedDeleteModalEntry: {},
  ConfirmedDeleteModalEntry: {},
  ClickedCancelDeleteModal: {},
  ClickedCloseModal: {},
  SucceededSaveModalChanges: {
    entries: Schema.Array(FileEntry),
  },
  FailedSaveModalChanges: {
    message: Schema.String,
  },
  SucceededDeleteModalEntry: {
    entries: Schema.Array(FileEntry),
  },
  FailedDeleteModalEntry: {
    message: Schema.String,
  },
  CompletedSelectImportFiles: {
    files: Schema.Array(PendingImportFile),
  },
  SelectedImportConflictAction: {
    action: ImportCollisionAction,
  },
  ToggledImportConflictApplyToAll: {
    applyToAll: Schema.Boolean,
  },
  CancelledImportConflict: {},
  CompletedWritePendingImportFiles: {
    entries: Schema.Array(FileEntry),
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
  CompletedFocusModalNameInput: {},
  CompletedRevokeActivePreviewUrl: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineTaggedUnion({
  None: {},
  ReplaceUrl: {
    url: Schema.String,
  },
  EntriesUpdated: {
    entries: Schema.Array(FileEntry),
    maybeAlertBanner: Schema.Option(AlertBanner),
    replaceUrl: Schema.Boolean,
  },
  ShowAlert: {
    banner: AlertBanner,
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

export const InspectFileForEditor = Command.define("InspectFileForEditor", {
  args: {
    entryName: Schema.String,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededInspectFileForEditor, Message.FailedInspectFileForEditor],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        const fileMode = await loadEditorFileModeForEntry(storage, args.subPath, args.entryName)
        return Message.SucceededInspectFileForEditor({
          originalName: args.entryName,
          fileMode,
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedInspectFileForEditor({
            message: `Datei "${args.entryName}" konnte nicht gelesen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const RevokeActivePreviewUrl = Command.define("RevokeActivePreviewUrl", {
  messages: [Message.CompletedRevokeActivePreviewUrl],
  execute: Effect.sync(() => {
    revokeActivePreviewUrl()
    return Message.CompletedRevokeActivePreviewUrl()
  }),
})

export const FocusModalNameInput = Command.define("FocusModalNameInput", {
  messages: [Message.CompletedFocusModalNameInput],
  execute: Dom.focus("#modal-file-name").pipe(
    Effect.as(Message.CompletedFocusModalNameInput()),
    Effect.catch(() => Effect.succeed(Message.CompletedFocusModalNameInput())),
  ),
})

export const LoadModalBase64 = Command.define("LoadModalBase64", {
  args: {
    entryName: Schema.String,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededLoadModalBase64, Message.FailedLoadModalBase64],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        const buffer = await storage.readFileBuffer(args.subPath, args.entryName)
        const base64Content = arrayBufferToBase64(buffer)
        return Message.SucceededLoadModalBase64({ base64Content })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadModalBase64({
            message: `Dateiinhalt konnte nicht als Base64 geladen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const SaveModalChanges = Command.define("SaveModalChanges", {
  args: {
    modalState: ModalState,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededSaveModalChanges, Message.FailedSaveModalChanges],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()

        await Match.value(args.modalState).pipe(
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
            const newName = name.trim()
            await BinaryOrText(fileMode, {
              text: async (content) => {
                await storage.writeFile(args.subPath, newName, content)
                if (originalName !== newName) {
                  await storage.deleteEntry(args.subPath, originalName, "file")
                }
              },
              binaryEditing: async (content) => {
                await storage.writeFileBuffer(args.subPath, newName, base64ToUint8Array(content))
                if (originalName !== newName) {
                  await storage.deleteEntry(args.subPath, originalName, "file")
                }
              },
              binaryRename: () => storage.renameBinaryFile(args.subPath, originalName, newName),
            })
          }),
          Match.tag("ConfirmOverwrite", async ({ targetName, source }) => {
            await Match.value(source).pipe(
              Match.tag("CreateFile", async ({ content }) => {
                await storage.writeFile(args.subPath, targetName, content)
              }),
              Match.tag("EditFile", async ({ originalName, fileMode }) => {
                await BinaryOrText(fileMode, {
                  text: async (content) => {
                    await storage.writeFile(args.subPath, targetName, content)
                    if (originalName !== targetName) {
                      await storage.deleteEntry(args.subPath, originalName, "file")
                    }
                  },
                  binaryEditing: async (content) => {
                    await storage.writeFileBuffer(
                      args.subPath,
                      targetName,
                      base64ToUint8Array(content),
                    )
                    if (originalName !== targetName) {
                      await storage.deleteEntry(args.subPath, originalName, "file")
                    }
                  },
                  binaryRename: () =>
                    storage.renameBinaryFile(args.subPath, originalName, targetName),
                })
              }),
              Match.exhaustive,
            )
          }),
          Match.orElse(() => Promise.resolve()),
        )

        revokeActivePreviewUrl()
        const updatedEntries = await storage.listEntries(args.subPath)
        return Message.SucceededSaveModalChanges({ entries: updatedEntries })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSaveModalChanges({
            message: `Speichern fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const DeleteModalEntry = Command.define("DeleteModalEntry", {
  args: {
    entryName: Schema.String,
    entryKind: FileEntryKind,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededDeleteModalEntry, Message.FailedDeleteModalEntry],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()

        await storage.deleteEntry(args.subPath, args.entryName, args.entryKind)
        revokeActivePreviewUrl()
        const updatedEntries = await storage.listEntries(args.subPath)
        return Message.SucceededDeleteModalEntry({ entries: updatedEntries })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDeleteModalEntry({
            message: `Löschen fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const SelectImportFiles = Command.define("SelectImportFiles", {
  messages: [Message.CompletedSelectImportFiles],
  execute: File.selectMultiple([]).pipe(
    Effect.map((selectedFiles) => {
      setPendingImportFiles(selectedFiles)
      const pendingFiles = selectedFiles.map((file) => ({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      }))
      return Message.CompletedSelectImportFiles({ files: pendingFiles })
    }),
  ),
})

export const WritePendingImportFiles = Command.define("WritePendingImportFiles", {
  args: {
    items: Schema.Array(ResolvedImportItem),
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.CompletedWritePendingImportFiles],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()

        const pendingFiles = getPendingImportFiles()
        setPendingImportFiles([])

        const fileMap = new Map<string, globalThis.File>(pendingFiles.map((f) => [f.name, f]))

        const importResults = await Array.reduce(
          args.items,
          Promise.resolve({
            importedCount: 0,
            errors: [] as ReadonlyArray<string>,
          }),
          async (accPromise, item) => {
            const acc = await accPromise
            if (item.action === "skip") {
              return acc
            }
            const file = fileMap.get(item.sourceName)
            if (!file) {
              return acc
            }
            try {
              const buffer = await file.arrayBuffer()
              await storage.writeFileBuffer(args.subPath, item.targetName, buffer)
              return {
                ...acc,
                importedCount: acc.importedCount + 1,
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              return {
                ...acc,
                errors: [...acc.errors, `${item.targetName}: ${message}`],
              }
            }
          },
        )

        const entries = await storage.listEntries(args.subPath)
        if (Array.isReadonlyArrayNonEmpty(importResults.errors)) {
          return Message.CompletedWritePendingImportFiles({
            entries,
            maybeAlertBanner: Option.some({
              message: `Fehler beim Importieren (${importResults.importedCount} erfolgreich): ${Array.join(importResults.errors, "; ")}`,
              variant: "danger",
            }),
          })
        }

        return Message.CompletedWritePendingImportFiles({
          entries,
          maybeAlertBanner: Option.none(),
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.CompletedWritePendingImportFiles({
            entries: [],
            maybeAlertBanner: Option.some({
              message: `Fehler beim Datei-Import: ${error.message}`,
              variant: "danger",
            }),
          }),
        ),
      ),
    ),
})

// UPDATE

const whenBinaryEditor = (
  modalState: ModalState,
  fn: (
    editState: EditFileState,
    binaryMode: BinaryFileMode,
  ) => {
    readonly model: ModalState
    readonly commands?: ReadonlyArray<Command.Command<Message>>
    readonly outMessage: OutMessage
  },
): {
  readonly model: ModalState
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Match.value(modalState).pipe(
    Match.tag("EditFile", (editState) =>
      Match.value(editState.fileMode).pipe(
        Match.tag("Binary", (binaryMode) => fn(editState, binaryMode)),
        Match.orElse(() => ({ model: modalState, outMessage: OutMessage.None() })),
      ),
    ),
    Match.orElse(() => ({ model: modalState, outMessage: OutMessage.None() })),
  )

export const update = (
  modalState: ModalState,
  message: Message,
  context: {
    readonly subPath: ReadonlyArray<string>
    readonly existingEntries: ReadonlyArray<FileEntry>
  },
): {
  readonly model: ModalState
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Message.match(message, {
    GotHelpMessage: ({ message: helpMessage }) =>
      Match.value(modalState).pipe(
        Match.tag("Help", (helpState) => {
          const helpResult = Help.update(helpState.help, helpMessage, context.subPath)
          const mappedCommands = helpResult.commands
            ? Command.mapMessages(helpResult.commands, (msg) =>
                Message.GotHelpMessage({ message: msg }),
              )
            : []
          return Help.OutMessage.match(helpResult.outMessage, {
            None: () =>
              mappedCommands.length > 0
                ? {
                    model: ModalState.Help({ help: helpResult.model }),
                    commands: mappedCommands,
                    outMessage: OutMessage.None(),
                  }
                : {
                    model: ModalState.Help({ help: helpResult.model }),
                    outMessage: OutMessage.None(),
                  },
            ReplaceUrl: ({ url }) =>
              mappedCommands.length > 0
                ? {
                    model: ModalState.Help({ help: helpResult.model }),
                    commands: mappedCommands,
                    outMessage: OutMessage.ReplaceUrl({ url }),
                  }
                : {
                    model: ModalState.Help({ help: helpResult.model }),
                    outMessage: OutMessage.ReplaceUrl({ url }),
                  },
            CloseModal: () => ({
              model: ModalState.Closed(),
              commands: [...mappedCommands, RevokeActivePreviewUrl()],
              outMessage: OutMessage.ReplaceUrl({ url: buildFolderUrl(context.subPath) }),
            }),
          })
        }),
        Match.orElse(() => ({
          model: modalState,
          outMessage: OutMessage.None(),
        })),
      ),

    SucceededInspectFileForEditor: ({ originalName, fileMode }) => ({
      model: ModalState.EditFile({
        originalName,
        name: originalName,
        fileMode,
        maybeValidationError: Option.none(),
      }),
      commands: [FocusModalNameInput()],
      outMessage: OutMessage.None(),
    }),

    FailedInspectFileForEditor: ({ message: errorMessage }) => ({
      model: ModalState.Closed(),
      commands: [RevokeActivePreviewUrl()],
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        replaceUrl: true,
      }),
    }),

    UpdatedModalName: ({ name }) => ({
      model: ModalState.match(modalState, {
        Closed: () => modalState,
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
        ConfirmDelete: () => modalState,
        ConfirmOverwrite: () => modalState,
        ImportConflict: () => modalState,
        Help: () => modalState,
      }),
      outMessage: OutMessage.None(),
    }),

    UpdatedModalTextContent: ({ content }) => ({
      model: ModalState.match(modalState, {
        Closed: () => modalState,
        CreateFile: (state) =>
          modifyFields(state, {
            content: () => content,
          }),
        CreateFolder: () => modalState,
        EditFolder: () => modalState,
        EditFile: (state) =>
          EditorFileMode.match(state.fileMode, {
            Text: () =>
              modifyFields(state, {
                fileMode: () => EditorFileMode.Text({ content }),
              }),
            Binary: () => state,
          }),
        ConfirmDelete: () => modalState,
        ConfirmOverwrite: () => modalState,
        ImportConflict: () => modalState,
        Help: () => modalState,
      }),
      outMessage: OutMessage.None(),
    }),

    ToggledModalBase64: ({ isChecked }) =>
      whenBinaryEditor(modalState, (editState, binaryMode) => {
        const isLocked = BinaryEdit.match(binaryMode.edit, {
          Locked: () => true,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => false,
        })
        if (isLocked) {
          return { model: modalState, outMessage: OutMessage.None() }
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
          commands: [
            LoadModalBase64({ entryName: editState.originalName, subPath: context.subPath }),
          ],
          outMessage: OutMessage.None(),
        }
      }),

    SucceededLoadModalBase64: ({ base64Content }) =>
      whenBinaryEditor(modalState, (editState, binaryMode) => ({
        model: modifyFields(editState, {
          fileMode: () =>
            modifyFields(binaryMode, {
              edit: () => BinaryEdit.Editing({ content: base64Content }),
            }),
        }),
        outMessage: OutMessage.None(),
      })),

    FailedLoadModalBase64: ({ message: errorMessage }) =>
      whenBinaryEditor(modalState, (editState, binaryMode) => ({
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
          replaceUrl: false,
        }),
      })),

    UpdatedModalBase64Content: ({ base64Content }) =>
      whenBinaryEditor(modalState, (editState, binaryMode) => {
        const isEditing = BinaryEdit.match(binaryMode.edit, {
          Locked: () => false,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => true,
        })
        if (!isEditing) {
          return { model: modalState, outMessage: OutMessage.None() }
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

    ClickedSaveModal: () => {
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

      const existingNames = new Set(context.existingEntries.map((e) => e.name))

      return Match.value(modalState).pipe(
        Match.tag("CreateFolder", (createFolder) => {
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
            model: modalState,
            commands: [SaveModalChanges({ modalState: createFolder, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        }),
        Match.tag("EditFolder", (editFolder) => {
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
            model: modalState,
            commands: [SaveModalChanges({ modalState: editFolder, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        }),
        Match.tag("CreateFile", (createFile) => {
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
              model: ModalState.ConfirmOverwrite({
                targetName: trimmed,
                source: OverwriteSource.CreateFile({
                  content: createFile.content,
                }),
              }),
              outMessage: OutMessage.None(),
            }
          }
          return {
            model: modalState,
            commands: [SaveModalChanges({ modalState: createFile, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        }),
        Match.tag("EditFile", (editFile) => {
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
              model: ModalState.ConfirmOverwrite({
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
            model: modalState,
            commands: [SaveModalChanges({ modalState: editFile, subPath: context.subPath })],
            outMessage: OutMessage.None(),
          }
        }),
        Match.orElse((state) => ({
          model: modalState,
          commands: [SaveModalChanges({ modalState: state, subPath: context.subPath })],
          outMessage: OutMessage.None(),
        })),
      )
    },

    ClickedConfirmOverwrite: () => ({
      model: modalState,
      commands: [SaveModalChanges({ modalState, subPath: context.subPath })],
      outMessage: OutMessage.None(),
    }),

    ClickedCancelOverwrite: () =>
      Match.value(modalState).pipe(
        Match.tag("ConfirmOverwrite", ({ targetName, source }) =>
          Match.value(source).pipe(
            Match.tag("CreateFile", ({ content }) => ({
              model: ModalState.CreateFile({
                name: targetName,
                content,
                maybeValidationError: Option.none(),
              }),
              outMessage: OutMessage.None(),
            })),
            Match.tag("EditFile", ({ originalName, fileMode }) => ({
              model: ModalState.EditFile({
                originalName,
                name: targetName,
                fileMode,
                maybeValidationError: Option.none(),
              }),
              outMessage: OutMessage.None(),
            })),
            Match.exhaustive,
          ),
        ),
        Match.orElse(() => ({ model: modalState, outMessage: OutMessage.None() })),
      ),

    ClickedDeleteModalEntry: () =>
      Match.value(modalState).pipe(
        Match.tag("EditFolder", ({ originalName }) => ({
          model: ModalState.ConfirmDelete({ entryName: originalName, entryKind: "directory" }),
          outMessage: OutMessage.None(),
        })),
        Match.tag("EditFile", ({ originalName }) => ({
          model: ModalState.ConfirmDelete({ entryName: originalName, entryKind: "file" }),
          outMessage: OutMessage.None(),
        })),
        Match.orElse(() => ({ model: modalState, outMessage: OutMessage.None() })),
      ),

    ConfirmedDeleteModalEntry: () =>
      Match.value(modalState).pipe(
        Match.tag("ConfirmDelete", ({ entryName, entryKind }) => ({
          model: ModalState.Closed(),
          commands: [DeleteModalEntry({ entryName, entryKind, subPath: context.subPath })],
          outMessage: OutMessage.None(),
        })),
        Match.orElse(() => ({ model: modalState, outMessage: OutMessage.None() })),
      ),

    ClickedCancelDeleteModal: () => ({
      model: ModalState.Closed(),
      commands: [RevokeActivePreviewUrl()],
      outMessage: OutMessage.ReplaceUrl({ url: buildFolderUrl(context.subPath) }),
    }),

    ClickedCloseModal: () => ({
      model: ModalState.Closed(),
      commands: [RevokeActivePreviewUrl()],
      outMessage: OutMessage.ReplaceUrl({ url: buildFolderUrl(context.subPath) }),
    }),

    SucceededSaveModalChanges: ({ entries }) => ({
      model: ModalState.Closed(),
      outMessage: OutMessage.EntriesUpdated({
        entries,
        maybeAlertBanner: Option.none(),
        replaceUrl: true,
      }),
    }),

    FailedSaveModalChanges: ({ message: errorMessage }) => ({
      model: modalState,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        replaceUrl: false,
      }),
    }),

    SucceededDeleteModalEntry: ({ entries }) => ({
      model: ModalState.Closed(),
      outMessage: OutMessage.EntriesUpdated({
        entries,
        maybeAlertBanner: Option.none(),
        replaceUrl: true,
      }),
    }),

    FailedDeleteModalEntry: ({ message: errorMessage }) => ({
      model: modalState,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        replaceUrl: false,
      }),
    }),

    CompletedSelectImportFiles: ({ files }) => {
      if (Array.isReadonlyArrayEmpty(files)) {
        return { model: modalState, outMessage: OutMessage.None() }
      }

      const existingByName = new Map<string, FileEntry>(
        context.existingEntries.map((e) => [e.name, e]),
      )
      const reservedNames = new Set<string>(existingByName.keys())

      const { collisions, resolved } = pipe(
        files,
        Array.reduce(
          {
            collisions: [] as ReadonlyArray<PendingImportFile>,
            resolved: [] as ReadonlyArray<ResolvedImportItem>,
          },
          (acc, file) => {
            const rawName = file.name.trim()
            if (!rawName) {
              return acc
            }

            if (existingByName.has(rawName)) {
              return {
                ...acc,
                collisions: [...acc.collisions, file],
              }
            }
            reservedNames.add(rawName)
            return {
              ...acc,
              resolved: [
                ...acc.resolved,
                {
                  sourceName: file.name,
                  targetName: file.name,
                  action: "replace" as const,
                },
              ],
            }
          },
        ),
      )

      return Array.match(collisions, {
        onEmpty: () => ({
          model: modalState,
          commands: [WritePendingImportFiles({ items: resolved, subPath: context.subPath })],
          outMessage: OutMessage.None(),
        }),
        onNonEmpty: ([firstCollision, ...remainingCollisions]) => {
          const suggestedName = findFreeFileName(firstCollision.name, reservedNames)
          return {
            model: ModalState.ImportConflict({
              current: firstCollision,
              suggestedName,
              queue: remainingCollisions,
              resolved,
              applyToAll: false,
            }),
            outMessage: OutMessage.None(),
          }
        },
      })
    },

    SelectedImportConflictAction: ({ action }) =>
      Match.value(modalState).pipe(
        Match.tag("ImportConflict", (conflictState) => {
          const { current, suggestedName, queue, resolved, applyToAll } = conflictState

          const targetName = action === "rename" ? suggestedName : current.name
          const updatedResolved: ReadonlyArray<ResolvedImportItem> = [
            ...resolved,
            {
              sourceName: current.name,
              targetName,
              action,
            },
          ]

          const reservedNames = new Set<string>([
            ...context.existingEntries.map((e) => e.name),
            ...updatedResolved.map((r) => r.targetName),
          ])

          if (applyToAll) {
            const batchResolved: ReadonlyArray<ResolvedImportItem> = [
              ...updatedResolved,
              ...queue.map((item) => {
                const itemTarget =
                  action === "rename" ? findFreeFileName(item.name, reservedNames) : item.name
                reservedNames.add(itemTarget)
                return {
                  sourceName: item.name,
                  targetName: itemTarget,
                  action,
                }
              }),
            ]

            return {
              model: ModalState.Closed(),
              commands: [
                WritePendingImportFiles({ items: batchResolved, subPath: context.subPath }),
              ],
              outMessage: OutMessage.None(),
            }
          }

          return Array.match(queue, {
            onEmpty: () => ({
              model: ModalState.Closed(),
              commands: [
                WritePendingImportFiles({ items: updatedResolved, subPath: context.subPath }),
              ],
              outMessage: OutMessage.None(),
            }),
            onNonEmpty: ([nextCurrent, ...nextQueue]) => {
              const nextSuggested = findFreeFileName(nextCurrent.name, reservedNames)
              return {
                model: ModalState.ImportConflict({
                  current: nextCurrent,
                  suggestedName: nextSuggested,
                  queue: nextQueue,
                  resolved: updatedResolved,
                  applyToAll: false,
                }),
                outMessage: OutMessage.None(),
              }
            },
          })
        }),
        Match.orElse(() => ({ model: modalState, outMessage: OutMessage.None() })),
      ),

    ToggledImportConflictApplyToAll: ({ applyToAll }) =>
      Match.value(modalState).pipe(
        Match.tag("ImportConflict", (conflictState) => ({
          model: modifyFields(conflictState, {
            applyToAll: () => applyToAll,
          }),
          outMessage: OutMessage.None(),
        })),
        Match.orElse(() => ({ model: modalState, outMessage: OutMessage.None() })),
      ),

    CancelledImportConflict: () => ({
      model: ModalState.Closed(),
      commands: [RevokeActivePreviewUrl()],
      outMessage: OutMessage.None(),
    }),

    CompletedWritePendingImportFiles: ({ entries, maybeAlertBanner }) => ({
      model: ModalState.Closed(),
      outMessage: OutMessage.EntriesUpdated({
        entries,
        maybeAlertBanner,
        replaceUrl: false,
      }),
    }),

    CompletedFocusModalNameInput: () => ({
      model: modalState,
      outMessage: OutMessage.None(),
    }),

    CompletedRevokeActivePreviewUrl: () => ({
      model: modalState,
      outMessage: OutMessage.None(),
    }),
  })

// VIEW

export const mapHtmlBuilder = <ChildMessage, ParentMessage>(
  h: Html.HtmlBuilder<ParentMessage>,
  toParent: (message: ChildMessage) => ParentMessage,
): Html.HtmlBuilder<ChildMessage> => {
  return new Proxy(h as unknown as Html.HtmlBuilder<ChildMessage>, {
    get(target, prop, receiver) {
      if (prop === "OnClick") {
        return (message: ChildMessage, options?: any) =>
          (target as any).OnClick(toParent(message), options)
      }
      if (prop === "OnSubmit") {
        return (message: ChildMessage) => (target as any).OnSubmit(toParent(message))
      }
      if (prop === "OnChange") {
        return (toMessage: (value: string) => ChildMessage) =>
          (target as any).OnChange((value: string) => toParent(toMessage(value)))
      }
      if (prop === "OnInput") {
        return (toMessage: (value: string) => ChildMessage) =>
          (target as any).OnInput((value: string) => toParent(toMessage(value)))
      }
      if (prop === "OnToggle") {
        return (toMessage: (isOpen: boolean) => ChildMessage) =>
          (target as any).OnToggle((isOpen: boolean) => toParent(toMessage(isOpen)))
      }
      return Reflect.get(target, prop, receiver)
    },
  })
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
            h.OnInput((text) => Message.UpdatedModalTextContent({ content: text })),
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
                        Message.ToggledModalBase64({
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
                        Message.UpdatedModalBase64Content({
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
                  h.OnClick(Message.ClickedCloseModal()),
                ],
                ["×"],
              ),
            ],
          ),
          h.form(
            [h.Id("modal-form"), h.OnSubmit(Message.ClickedSaveModal())],
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
                        h.OnInput((name) => Message.UpdatedModalName({ name })),
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
                              h.OnClick(Message.ClickedDeleteModalEntry()),
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
                          h.OnClick(Message.ClickedCloseModal()),
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
                          h.OnClick(Message.ClickedSaveModal(), { defaultAction: "Prevent" }),
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
                  h.OnClick(Message.ClickedCancelDeleteModal()),
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
                      h.OnClick(Message.ClickedCancelDeleteModal()),
                    ],
                    ["Abbrechen"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-danger"),
                      h.OnClick(Message.ConfirmedDeleteModalEntry()),
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

const viewImportConflictModal = (
  current: PendingImportFile,
  suggestedName: string,
  queue: ReadonlyArray<PendingImportFile>,
  applyToAll: boolean,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const queueCount = Array.length(queue)

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
              h.h3([h.Id("modal-title"), h.Class("modal-title")], ["Import-Konflikt"]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.CancelledImportConflict()),
                ],
                ["×"],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              h.p([], [`Die Datei „${current.name}“ existiert bereits in diesem Ordner.`]),
              Array.isReadonlyArrayNonEmpty(queue)
                ? h.div(
                    [h.Class("form-check mt-3")],
                    [
                      h.label(
                        [h.Class("checkbox-label")],
                        [
                          h.input([
                            h.Type("checkbox"),
                            h.Checked(applyToAll),
                            h.OnChange(() =>
                              Message.ToggledImportConflictApplyToAll({
                                applyToAll: !applyToAll,
                              }),
                            ),
                          ]),
                          ` Auswahl auf alle weiteren ${queueCount} ${
                            queueCount === 1 ? "Konflikt" : "Konflikte"
                          } anwenden`,
                        ],
                      ),
                    ],
                  )
                : h.empty,
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
                      h.OnClick(Message.SelectedImportConflictAction({ action: "skip" })),
                    ],
                    ["Überspringen"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-secondary"),
                      h.Title(suggestedName),
                      h.OnClick(Message.SelectedImportConflictAction({ action: "rename" })),
                    ],
                    ["Umbenennen"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-danger"),
                      h.OnClick(Message.SelectedImportConflictAction({ action: "replace" })),
                    ],
                    ["Ersetzen"],
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

export const view = (
  model: ModalState,
  context: {
    readonly origin: string
    readonly hasDirectoryPicker: boolean
    readonly hasOPFS: boolean
  },
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
  h.div(
    [h.Id("files-modal-container")],
    [
      ModalState.match(model, {
        Closed: () => h.empty,

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

        ConfirmDelete: ({ entryName, entryKind }) =>
          viewConfirmDeleteModal(entryName, entryKind, h),

        ConfirmOverwrite: ({ targetName }) => viewConfirmOverwriteModal(targetName, h),

        ImportConflict: ({ current, suggestedName, queue, applyToAll }) =>
          viewImportConflictModal(current, suggestedName, queue, applyToAll, h),

        Help: ({ help }) =>
          Help.view(
            help,
            context,
            mapHtmlBuilder(h, (msg) => Message.GotHelpMessage({ message: msg })),
          ),
      }),
    ],
  )
