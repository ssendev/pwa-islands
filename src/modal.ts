import { Array, Effect, Match, Option, Schema, pipe } from "effect"
import { Submodel } from "foldkit"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import * as File from "foldkit/file"
import type * as Html from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import * as Editor from "./editor"
import { AlertBanner } from "./editor"
import {
  BinaryEdit,
  EditorFileMode,
  FileEntry,
  PreviewContent,
  findFreeFileName,
  getPendingImportFiles,
  loadEditorFileModeForEntry,
  requireActiveStorage,
  revokeActivePreviewUrl,
  setPendingImportFiles,
} from "./files"
import * as Help from "./help"
import { viewIcon } from "./icons"
import { AppRoute, HelpTopic, NewTarget, buildFolderUrl } from "./route"
import { StarterTemplate } from "./templates"
import { getStoredUserTemplates } from "./storage"
import type { StorageBackend } from "./files"

export { BinaryEdit, EditorFileMode, PreviewContent }
export { AlertVariant, AlertBanner } from "./editor"

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

export const ModalState = defineTaggedUnion({
  Closed: {},
  Editor: {
    editor: Editor.Model,
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

export const isOpen = (state: ModalState): boolean =>
  ModalState.match(state, {
    Closed: () => false,
    Editor: () => true,
    ImportConflict: () => true,
    Help: () => true,
  })

export const close = (): ModalState => ModalState.Closed()

const HELP_TOPIC_TITLES: Readonly<Record<HelpTopic, string>> = {
  quickstart: "Quickstart: Mit KI bearbeiten",
  api: "PWA Islands bauen",
  fs: "Speicher: App (Tauri), FS API und OPFS",
}

export const formatDocumentTitle = (state: ModalState, folderTitle: string): string =>
  ModalState.match(state, {
    Closed: () => folderTitle,
    Editor: ({ editor }) =>
      Editor.Model.match(editor, {
        CreateFile: () => `Neue Datei — ${folderTitle}`,
        CreateFolder: () => `Neuer Ordner — ${folderTitle}`,
        EditFolder: ({ originalName }) => `${originalName} bearbeiten — ${folderTitle}`,
        EditFile: ({ originalName }) => `${originalName} bearbeiten — ${folderTitle}`,
        ConfirmDelete: ({ entryName }) => `${entryName} löschen — ${folderTitle}`,
        ConfirmOverwrite: ({ targetName }) => `${targetName} überschreiben — ${folderTitle}`,
      }),
    ImportConflict: () => `Import-Konflikt — ${folderTitle}`,
    Help: ({ help }) =>
      Option.match(help.maybeOpenTopic, {
        onNone: () => `Hilfe — ${folderTitle}`,
        onSome: (topic) => `${HELP_TOPIC_TITLES[topic]} — Hilfe — ${folderTitle}`,
      }),
  })

export const openCreate = (
  target: NewTarget | "file" | "folder",
  templates: ReadonlyArray<StarterTemplate> = [],
  defaults?: { readonly isMaximized?: boolean; readonly llmBarMode?: Editor.LlmBarMode },
): ModalState =>
  ModalState.Editor({
    editor:
      target === "folder"
        ? Editor.Model.CreateFolder({
            name: "Neuer Ordner",
            maybeValidationError: Option.none(),
            maybeAlertBanner: Option.none(),
          })
        : Editor.makeCreateFile(templates, defaults),
  })

export const LoadEditorUserTemplates = Command.mapMessage(Editor.LoadUserTemplates(), (message) =>
  Message.GotEditorMessage({ message }),
)

export const openEditFolder = (name: string): ModalState =>
  ModalState.Editor({
    editor: Editor.Model.EditFolder({
      originalName: name,
      name,
      maybeValidationError: Option.none(),
      maybeAlertBanner: Option.none(),
    }),
  })

export const isEditingEntry = (state: ModalState, name: string): boolean =>
  Match.value(state).pipe(
    Match.tag("Editor", ({ editor }) =>
      Editor.Model.match(editor, {
        EditFolder: (folder) => folder.originalName === name,
        EditFile: (file) => file.originalName === name,
        CreateFile: () => false,
        CreateFolder: () => false,
        ConfirmDelete: () => false,
        ConfirmOverwrite: () => false,
      }),
    ),
    Match.orElse(() => false),
  )

export const applyEditorPreferences = (
  modalState: ModalState,
  prefs: { readonly isMaximized: boolean; readonly llmBarMode: Editor.LlmBarMode },
): ModalState =>
  Match.value(modalState).pipe(
    Match.tag("Editor", ({ editor }) =>
      ModalState.Editor({
        editor: Editor.applyPreferences(editor, prefs),
      }),
    ),
    Match.orElse(() => modalState),
  )

export const applyEditorLlmChatStream = (
  modalState: ModalState,
  payload: {
    readonly completedTurns: ReadonlyArray<Editor.LlmChatTurnBlock>
    readonly activeTurn: { readonly content: string; readonly reasoning: string }
  },
): ModalState =>
  Match.value(modalState).pipe(
    Match.tag("Editor", ({ editor }) =>
      ModalState.Editor({
        editor: Editor.applyLlmChatStream(editor, payload),
      }),
    ),
    Match.orElse(() => modalState),
  )

export const applyEditorLlmChatSuccess = (
  modalState: ModalState,
  payload: {
    readonly messages: ReadonlyArray<Editor.LlmChatMessage>
    readonly maybeUpdatedContent: Option.Option<string>
    readonly appliedCount: number
    readonly turns: ReadonlyArray<Editor.LlmChatTurnBlock>
  },
): ModalState =>
  Match.value(modalState).pipe(
    Match.tag("Editor", ({ editor }) =>
      ModalState.Editor({
        editor: Editor.applyLlmChatSuccess(editor, payload),
      }),
    ),
    Match.orElse(() => modalState),
  )

export const applyEditorLlmChatFailure = (modalState: ModalState, message: string): ModalState =>
  Match.value(modalState).pipe(
    Match.tag("Editor", ({ editor }) =>
      ModalState.Editor({
        editor: Editor.applyLlmChatFailure(editor, message),
      }),
    ),
    Match.orElse(() => modalState),
  )

export const openHelp = (
  maybeTopic: Option.Option<HelpTopic>,
  currentState: ModalState = ModalState.Closed(),
): ModalState => {
  const maybeExistingHelp = Match.value(currentState).pipe(
    Match.tag("Help", (helpState) => Option.some(helpState.help)),
    Match.orElse(() => Option.none()),
  )

  const topicToUse = Option.match(maybeTopic, {
    onNone: () =>
      Option.match(maybeExistingHelp, {
        onNone: () => Option.some<HelpTopic>("quickstart"),
        onSome: (existing) => existing.maybeOpenTopic,
      }),
    onSome: (topic) => Option.some(topic),
  })

  const nextHelp: Help.Model = Option.match(maybeExistingHelp, {
    onNone: () => Help.init(topicToUse),
    onSome: (existing) =>
      modifyFields(existing, {
        maybeOpenTopic: () => topicToUse,
      }),
  })

  return ModalState.Help({ help: nextHelp })
}

export const initFromRoute = (route: AppRoute): Option.Option<ModalState> =>
  AppRoute.match(route, {
    Folder: () => Option.none(),
    New: () => Option.none(), // Wait for resolveModalForRoute!
    Edit: () => Option.none(),
    Help: ({ maybeTopic }) => Option.some(openHelp(maybeTopic)),
  })

export const resolveModalForRoute = async (
  storage: StorageBackend,
  route: AppRoute,
  entries: ReadonlyArray<FileEntry>,
  didFallback: boolean = false,
): Promise<{
  readonly maybeModalState: Option.Option<ModalState>
  readonly maybeAlertBanner: Option.Option<AlertBanner>
}> => {
  return await AppRoute.match(route, {
    Help: ({ maybeTopic }) =>
      Promise.resolve({
        maybeModalState: Option.some(openHelp(maybeTopic)),
        maybeAlertBanner: Option.none(),
      }),

    Folder: ({ subPath }) =>
      Promise.resolve({
        maybeModalState: Option.none(),
        maybeAlertBanner: didFallback
          ? Option.some<AlertBanner>({
              message: `Pfad "/${subPath.join("/")}" wurde nicht gefunden.`,
              variant: "warning",
            })
          : Option.none(),
      }),

    New: async ({ subPath, target }) => {
      const stored =
        target === "file" ? await getStoredUserTemplates(storage.type, storage.rootHandle) : []
      const templates: ReadonlyArray<StarterTemplate> = Array.map(stored, (t) => ({
        id: t.id,
        label: t.label,
        defaultFileName: t.defaultFileName,
        content: t.content,
        isBuiltin: false,
      }))
      return {
        maybeModalState: Option.some(openCreate(target, templates)),
        maybeAlertBanner: didFallback
          ? Option.some<AlertBanner>({
              message: `Pfad "/${subPath.join("/")}" wurde nicht gefunden.`,
              variant: "warning",
            })
          : Option.none(),
      }
    },

    Edit: async ({ subPath, name }) => {
      if (didFallback) {
        return {
          maybeModalState: Option.none(),
          maybeAlertBanner: Option.some<AlertBanner>({
            message: `Pfad "/${subPath.join("/")}" wurde nicht gefunden.`,
            variant: "warning",
          }),
        }
      }

      const maybeEntry = Array.findFirst(entries, (entry) => entry.name === name)
      return await Option.match(maybeEntry, {
        onNone: () =>
          Promise.resolve({
            maybeModalState: Option.none(),
            maybeAlertBanner: Option.some<AlertBanner>({
              message: `Eintrag "${name}" wurde in diesem Ordner nicht gefunden.`,
              variant: "warning",
            }),
          }),
        onSome: async (targetEntry) => {
          if (targetEntry.kind === "directory") {
            return {
              maybeModalState: Option.some(openEditFolder(targetEntry.name)),
              maybeAlertBanner: Option.none(),
            }
          }

          const fileMode = await loadEditorFileModeForEntry(storage, subPath, targetEntry.name)
          return {
            maybeModalState: Option.some(
              ModalState.Editor({
                editor: Editor.Model.EditFile({
                  originalName: targetEntry.name,
                  name: targetEntry.name,
                  fileMode,
                  maybeValidationError: Option.none(),
                  maybeAlertBanner: Option.none(),
                  maybePasteError: Option.none(),
                  llmBarMode: "Closed",
                  llmChatInput: "",
                  llmChatMessages: [],
                  llmChatDisplay: [],
                  llmChatState: Editor.LlmChatState.Idle(),
                  isMaximized: false,
                }),
              }),
            ),
            maybeAlertBanner: Option.none(),
          }
        },
      })
    },
  })
}

// MESSAGE

export const Message = defineMessageUnion({
  GotEditorMessage: {
    message: Editor.Message,
  },
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
  CompletedSelectImportFiles: {
    files: Schema.Array(PendingImportFile),
  },
  SelectedImportConflictAction: {
    action: ImportCollisionAction,
  },
  ToggledImportConflictApplyToAll: {
    applyToAll: Schema.Boolean,
  },
  ClickedCancelImportConflict: {},
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
  SelectedLlmModel: {
    value: Schema.String,
  },
  SelectedLlmThinkingLevel: {
    value: Schema.String,
  },
  ChangedLlmBarMode: {
    llmBarMode: Editor.LlmBarMode,
  },
  ChangedMaximize: {
    isMaximized: Schema.Boolean,
  },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

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

export const SelectImportFiles = Command.define("SelectImportFiles", {
  messages: [Message.CompletedSelectImportFiles],
  execute: File.selectMultiple([]).pipe(
    Effect.map((selectedFiles) => {
      setPendingImportFiles(selectedFiles)
      const pendingFiles = Array.map(selectedFiles, (file) => ({
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

        const fileMap = new Map<string, globalThis.File>(
          Array.map(pendingFiles, (f) => [f.name, f]),
        )

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

export const update = (
  modalState: ModalState,
  message: Message,
  context: {
    readonly subPath: ReadonlyArray<string>
    readonly existingEntries: ReadonlyArray<FileEntry>
    readonly llmEnabled: boolean
    readonly editorDefaults?: {
      readonly isMaximized: boolean
      readonly llmBarMode: Editor.LlmBarMode
    }
  },
): {
  readonly model: ModalState
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Message.match(message, {
    GotEditorMessage: ({ message: editorMessage }) =>
      Match.value(modalState).pipe(
        Match.tag("Editor", (editorState) => {
          const editorResult = Editor.update(editorState.editor, editorMessage, context)
          const mappedCommands = editorResult.commands
            ? Command.mapMessages(editorResult.commands, (msg) =>
                Message.GotEditorMessage({ message: msg }),
              )
            : []
          return Editor.OutMessage.match(editorResult.outMessage, {
            None: () =>
              Array.isReadonlyArrayNonEmpty(mappedCommands)
                ? {
                    model: ModalState.Editor({ editor: editorResult.model }),
                    commands: mappedCommands,
                    outMessage: OutMessage.None(),
                  }
                : {
                    model: ModalState.Editor({ editor: editorResult.model }),
                    outMessage: OutMessage.None(),
                  },
            CloseModal: ({ replaceUrl }) => ({
              model: ModalState.Closed(),
              commands: [...mappedCommands, RevokeActivePreviewUrl()],
              outMessage: replaceUrl
                ? OutMessage.ReplaceUrl({ url: buildFolderUrl(context.subPath) })
                : OutMessage.None(),
            }),
            EntriesUpdated: ({ entries, closeModal }) => ({
              model: closeModal
                ? ModalState.Closed()
                : ModalState.Editor({ editor: editorResult.model }),
              commands: mappedCommands,
              outMessage: OutMessage.EntriesUpdated({
                entries,
                maybeAlertBanner: Option.none(),
                replaceUrl: closeModal,
              }),
            }),
            ShowAlert: ({ banner, closeModal, replaceUrl }) => ({
              model: closeModal
                ? ModalState.Closed()
                : ModalState.Editor({ editor: editorResult.model }),
              commands: closeModal ? [...mappedCommands, RevokeActivePreviewUrl()] : mappedCommands,
              outMessage: OutMessage.ShowAlert({
                banner,
                replaceUrl,
              }),
            }),
            SelectedLlmModel: ({ value }) => ({
              model: ModalState.Editor({ editor: editorResult.model }),
              commands: mappedCommands,
              outMessage: OutMessage.SelectedLlmModel({ value }),
            }),
            SelectedLlmThinkingLevel: ({ value }) => ({
              model: ModalState.Editor({ editor: editorResult.model }),
              commands: mappedCommands,
              outMessage: OutMessage.SelectedLlmThinkingLevel({ value }),
            }),
            ChangedLlmBarMode: ({ llmBarMode }) => ({
              model: ModalState.Editor({ editor: editorResult.model }),
              commands: mappedCommands,
              outMessage: OutMessage.ChangedLlmBarMode({ llmBarMode }),
            }),
            ChangedMaximize: ({ isMaximized }) => ({
              model: ModalState.Editor({ editor: editorResult.model }),
              commands: mappedCommands,
              outMessage: OutMessage.ChangedMaximize({ isMaximized }),
            }),
          })
        }),
        Match.orElse(() => ({
          model: modalState,
          outMessage: OutMessage.None(),
        })),
      ),

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
              Array.isReadonlyArrayNonEmpty(mappedCommands)
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
              Array.isReadonlyArrayNonEmpty(mappedCommands)
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
      model: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName,
          name: originalName,
          fileMode,
          maybeValidationError: Option.none(),
          maybeAlertBanner: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: context.editorDefaults?.llmBarMode ?? "Closed",
          llmChatInput: "",
          llmChatMessages: [],
          llmChatDisplay: [],
          llmChatState: Editor.LlmChatState.Idle(),
          isMaximized: context.editorDefaults?.isMaximized ?? false,
        }),
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

    CompletedSelectImportFiles: ({ files }) => {
      if (Array.isReadonlyArrayEmpty(files)) {
        return { model: modalState, outMessage: OutMessage.None() }
      }

      const reservedNames = new Set<string>(Array.map(context.existingEntries, (e) => e.name))

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

            if (reservedNames.has(rawName)) {
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
            ...Array.map(context.existingEntries, (e) => e.name),
            ...Array.map(updatedResolved, (r) => r.targetName),
          ])

          if (applyToAll) {
            const batchResolved: ReadonlyArray<ResolvedImportItem> = [
              ...updatedResolved,
              ...Array.map(queue, (item) => {
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

    ClickedCancelImportConflict: () => ({
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

export type ViewInputs = {
  readonly origin: string
  readonly hasDirectoryPicker: boolean
  readonly hasOPFS: boolean
  readonly hasTauri: boolean
  readonly llm: Editor.ViewInputs
}

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
                  h.OnClick(Message.ClickedCancelImportConflict()),
                ],
                [viewIcon("close", h)],
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

export const view = Submodel.defineView<ModalState, Message, ViewInputs>(
  (model, context, h): Html.Html =>
    h.div(
      [h.Id("files-modal-container")],
      [
        ModalState.match(model, {
          Closed: () => h.empty,

          Editor: ({ editor }) =>
            h.submodel({
              slotId: "editor",
              model: editor,
              viewInputs: context.llm,
              view: Editor.view,
              toParentMessage: (msg) => Message.GotEditorMessage({ message: msg }),
            }),

          ImportConflict: ({ current, suggestedName, queue, applyToAll }) =>
            viewImportConflictModal(current, suggestedName, queue, applyToAll, h),

          Help: ({ help }) =>
            h.submodel({
              slotId: "help",
              model: help,
              viewInputs: context,
              view: Help.view,
              toParentMessage: (msg) => Message.GotHelpMessage({ message: msg }),
            }),
        }),
      ],
    ),
)
