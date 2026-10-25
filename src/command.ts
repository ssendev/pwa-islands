import { Array, Duration, Effect, Option, Schema, pipe } from "effect"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import * as File from "foldkit/file"
import * as Navigation from "foldkit/navigation"
import {
  FileSystemHandleStorage,
  arrayBufferToBase64,
  base64ToUint8Array,
  clearSavedDirectoryHandle,
  getActiveStorage,
  getDeferredInstallPrompt,
  getOPFSRootDirectory,
  getPendingHandle,
  getPendingImportFiles,
  getSavedDirectoryHandle,
  getSavedFileInfoVisible,
  getSavedFsaHandle,
  getSavedStorageType,
  loadEditorFileModeForEntry,
  queryDirectoryPermission,
  requestDirectoryPermission,
  revokeActivePreviewUrl,
  saveDirectoryHandle,
  saveFileInfoVisible,
  setActiveStorage,
  setDeferredInstallPrompt,
  setPendingHandle,
  setPendingImportFiles,
  setSavedFsaHandle,
  showDirectoryPicker,
} from "./files"
import { Message } from "./message"
import {
  type AlertBanner,
  AppRoute,
  CopyDtsState,
  type FileEntry,
  ModalState,
  OPFS_APP_FOLDER,
  ResolvedImportItem,
  SavedBackend,
  encodeSubPath,
} from "./model"

const resolveRouteDeepLink = async (
  storage: FileSystemHandleStorage,
  route: AppRoute,
): Promise<{
  readonly subPath: ReadonlyArray<string>
  readonly entries: ReadonlyArray<FileEntry>
  readonly maybeModalState: Option.Option<ModalState>
  readonly maybeAlertBanner: Option.Option<AlertBanner>
}> => {
  return await AppRoute.match(route, {
    Help: async ({ subPath, maybeTopic }) => {
      let resolvedSubPath = subPath
      let entries: ReadonlyArray<FileEntry>
      try {
        entries = await storage.listEntries(subPath)
      } catch {
        resolvedSubPath = []
        entries = await storage.listEntries([])
      }
      return {
        subPath: resolvedSubPath,
        entries,
        maybeModalState: Option.some(
          ModalState.Help({
            isApiOpen: Option.match(maybeTopic, {
              onNone: () => true,
              onSome: (topic) => topic === "api",
            }),
            isFsOpen: Option.match(maybeTopic, {
              onNone: () => false,
              onSome: (topic) => topic === "fs",
            }),
            copyDtsState: CopyDtsState.Idle(),
          }),
        ),
        maybeAlertBanner: Option.none(),
      }
    },

    Folder: async ({ subPath }) => {
      try {
        const entries = await storage.listEntries(subPath)
        return {
          subPath,
          entries,
          maybeModalState: Option.none(),
          maybeAlertBanner: Option.none(),
        }
      } catch {
        const entries = await storage.listEntries([])
        return {
          subPath: [],
          entries,
          maybeModalState: Option.none(),
          maybeAlertBanner: Option.some<AlertBanner>({
            message: `Pfad "/${subPath.join("/")}" wurde nicht gefunden.`,
            variant: "warning",
          }),
        }
      }
    },

    New: async ({ subPath, target }) => {
      let resolvedSubPath = subPath
      let entries: ReadonlyArray<FileEntry>
      let maybeAlertBanner = Option.none<AlertBanner>()
      try {
        entries = await storage.listEntries(subPath)
      } catch {
        resolvedSubPath = []
        entries = await storage.listEntries([])
        maybeAlertBanner = Option.some<AlertBanner>({
          message: `Pfad "/${subPath.join("/")}" wurde nicht gefunden.`,
          variant: "warning",
        })
      }
      return {
        subPath: resolvedSubPath,
        entries,
        maybeModalState: Option.some(
          target === "folder"
            ? ModalState.CreateFolder({
                name: "Neuer Ordner",
                maybeValidationError: Option.none(),
              })
            : ModalState.CreateFile({
                name: "Neu.html",
                content: "",
                maybeValidationError: Option.none(),
              }),
        ),
        maybeAlertBanner,
      }
    },

    Edit: async ({ subPath, name }) => {
      let entries: ReadonlyArray<FileEntry>
      let currentSubPath = subPath
      try {
        entries = await storage.listEntries(subPath)
      } catch {
        currentSubPath = []
        entries = await storage.listEntries([])
        return {
          subPath: [],
          entries,
          maybeModalState: Option.none(),
          maybeAlertBanner: Option.some<AlertBanner>({
            message: `Pfad "/${subPath.join("/")}" wurde nicht gefunden.`,
            variant: "warning",
          }),
        }
      }

      const targetEntry = pipe(
        entries,
        Array.findFirst((entry) => entry.name === name),
        Option.getOrUndefined,
      )

      if (!targetEntry) {
        return {
          subPath: currentSubPath,
          entries,
          maybeModalState: Option.none(),
          maybeAlertBanner: Option.some<AlertBanner>({
            message: `Eintrag "${name}" wurde in diesem Ordner nicht gefunden.`,
            variant: "warning",
          }),
        }
      }

      if (targetEntry.kind === "directory") {
        return {
          subPath: currentSubPath,
          entries,
          maybeModalState: Option.some(
            ModalState.EditFolder({
              originalName: targetEntry.name,
              name: targetEntry.name,
              maybeValidationError: Option.none(),
            }),
          ),
          maybeAlertBanner: Option.none(),
        }
      }

      const fileMode = await loadEditorFileModeForEntry(storage, currentSubPath, targetEntry.name)
      return {
        subPath: currentSubPath,
        entries,
        maybeModalState: Option.some(
          ModalState.EditFile({
            originalName: targetEntry.name,
            name: targetEntry.name,
            fileMode,
            maybeValidationError: Option.none(),
          }),
        ),
        maybeAlertBanner: Option.none(),
      }
    },
  })
}

const activateStorageBackend = async (
  handle: FileSystemDirectoryHandle,
  type: "fsa" | "opfs",
  route: AppRoute,
  otherBackend: SavedBackend,
): Promise<typeof Message.SucceededInitializeStorage.Type> => {
  await saveDirectoryHandle(handle, type)
  const storage = new FileSystemHandleStorage(handle, type)
  setActiveStorage(storage)
  if (type === "fsa") {
    setSavedFsaHandle(handle)
    setPendingHandle(null)
  }

  const resolved = await resolveRouteDeepLink(storage, route)

  return Message.SucceededInitializeStorage({
    storageType: type,
    rootName: storage.name,
    subPath: resolved.subPath,
    entries: resolved.entries,
    otherBackend,
    maybeModalState: resolved.maybeModalState,
    maybeAlertBanner: resolved.maybeAlertBanner,
  })
}

// COMMAND

export const LoadFileInfoPreference = Command.define("LoadFileInfoPreference", {
  messages: [Message.CompletedLoadFileInfoPreference],
  execute: Effect.tryPromise({
    try: () => getSavedFileInfoVisible(),
    catch: () => new Error("Failed to load preference"),
  }).pipe(
    Effect.map((visible) => Message.CompletedLoadFileInfoPreference({ visible })),
    Effect.catch(() => Effect.succeed(Message.CompletedLoadFileInfoPreference({ visible: true }))),
  ),
})

export const SaveFileInfoPreference = Command.define("SaveFileInfoPreference", {
  args: {
    visible: Schema.Boolean,
  },
  messages: [Message.CompletedSaveFileInfoPreference],
  execute: (args) =>
    Effect.tryPromise({
      try: () => saveFileInfoVisible(args.visible),
      catch: () => new Error("Failed to save preference"),
    }).pipe(
      Effect.map(() => Message.CompletedSaveFileInfoPreference()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveFileInfoPreference())),
    ),
})

export const InitializeStorage = Command.define("InitializeStorage", {
  args: {
    hasDirectoryPicker: Schema.Boolean,
    hasOPFS: Schema.Boolean,
    route: AppRoute,
  },
  messages: [
    Message.SucceededInitializeStorage,
    Message.DetectedPermissionRequired,
    Message.DetectedNoFolderSelected,
    Message.FailedInitializeStorage,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const savedType = await getSavedStorageType()

        const opfsSavedBackend: SavedBackend = args.hasOPFS
          ? SavedBackend.Granted({ rootName: OPFS_APP_FOLDER })
          : SavedBackend.Unsupported()

        const determineFsaSavedBackend = async (): Promise<SavedBackend> => {
          if (!args.hasDirectoryPicker) return SavedBackend.Unsupported()
          const savedHandle = await getSavedDirectoryHandle()
          if (!savedHandle) return SavedBackend.NoFolderSelected()
          setSavedFsaHandle(savedHandle)
          const perm = await queryDirectoryPermission(savedHandle, "readwrite")
          if (perm === "granted") {
            return SavedBackend.Granted({ rootName: savedHandle.name || "Gespeicherter Ordner" })
          }
          setPendingHandle(savedHandle)
          return SavedBackend.PermissionRequired({
            folderName: savedHandle.name || "Gespeicherter Ordner",
          })
        }

        if (savedType === "opfs" && args.hasOPFS) {
          const fsaSavedBackend = await determineFsaSavedBackend()
          const opfsRoot = await getOPFSRootDirectory()
          return await activateStorageBackend(opfsRoot, "opfs", args.route, fsaSavedBackend)
        }

        if (args.hasDirectoryPicker) {
          const savedHandle = await getSavedDirectoryHandle()
          if (savedHandle) {
            setSavedFsaHandle(savedHandle)
            const perm = await queryDirectoryPermission(savedHandle, "readwrite")
            if (perm === "granted") {
              return await activateStorageBackend(savedHandle, "fsa", args.route, opfsSavedBackend)
            }
            setPendingHandle(savedHandle)
            return Message.DetectedPermissionRequired({
              storageType: "fsa",
              folderName: savedHandle.name || "Gespeicherter Ordner",
              otherBackend: opfsSavedBackend,
            })
          }
          return Message.DetectedNoFolderSelected({
            storageType: "fsa",
            otherBackend: opfsSavedBackend,
          })
        }

        if (args.hasOPFS) {
          const opfsRoot = await getOPFSRootDirectory()
          return await activateStorageBackend(
            opfsRoot,
            "opfs",
            args.route,
            SavedBackend.Unsupported(),
          )
        }

        return Message.DetectedNoFolderSelected({
          storageType: "fsa",
          otherBackend: SavedBackend.Unsupported(),
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedInitializeStorage({
            message: error.message || "Unbekannter Fehler beim Initialisieren des Speichers",
          }),
        ),
      ),
    ),
})

export const PickLocalDirectory = Command.define("PickLocalDirectory", {
  args: {
    otherBackend: SavedBackend,
    route: AppRoute,
  },
  messages: [
    Message.SucceededInitializeStorage,
    Message.CancelledFolderSelection,
    Message.FailedPickLocalDirectory,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const handle = await showDirectoryPicker({ mode: "readwrite" })
          return await activateStorageBackend(handle, "fsa", args.route, args.otherBackend)
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return Message.CancelledFolderSelection()
          }
          throw error
        }
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedPickLocalDirectory({
            message: `Ordner konnte nicht geöffnet werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const GrantDirectoryPermission = Command.define("GrantDirectoryPermission", {
  args: {
    otherBackend: SavedBackend,
    route: AppRoute,
  },
  messages: [
    Message.SucceededInitializeStorage,
    Message.DetectedNoFolderSelected,
    Message.FailedGrantDirectoryPermission,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const pending =
          getPendingHandle() ?? getSavedFsaHandle() ?? (await getSavedDirectoryHandle())
        if (!pending) {
          return Message.DetectedNoFolderSelected({
            storageType: "fsa",
            otherBackend: args.otherBackend,
          })
        }
        const state = await requestDirectoryPermission(pending, "readwrite")
        if (state === "granted") {
          return await activateStorageBackend(pending, "fsa", args.route, args.otherBackend)
        }
        return Message.FailedGrantDirectoryPermission({
          message:
            "Zugriff auf den Ordner wurde verweigert. Bitte wählen Sie den Ordner erneut aus.",
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedGrantDirectoryPermission({
            message: `Fehler bei der Berechtigungsanfrage: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const ActivateOpfsBackend = Command.define("ActivateOpfsBackend", {
  args: {
    otherBackend: SavedBackend,
    route: AppRoute,
  },
  messages: [Message.SucceededInitializeStorage, Message.FailedActivateOpfsBackend],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const opfsRoot = await getOPFSRootDirectory()
        return await activateStorageBackend(opfsRoot, "opfs", args.route, args.otherBackend)
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedActivateOpfsBackend({
            message: `Interner Speicher (OPFS) konnte nicht geöffnet werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const ActivateFsaBackend = Command.define("ActivateFsaBackend", {
  args: {
    otherBackend: SavedBackend,
    route: AppRoute,
  },
  messages: [
    Message.SucceededInitializeStorage,
    Message.DetectedPermissionRequired,
    Message.DetectedNoFolderSelected,
    Message.FailedPickLocalDirectory,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const handle = getSavedFsaHandle() ?? (await getSavedDirectoryHandle())
        if (!handle) {
          return Message.DetectedNoFolderSelected({
            storageType: "fsa",
            otherBackend: args.otherBackend,
          })
        }
        const perm = await queryDirectoryPermission(handle, "readwrite")
        if (perm === "granted") {
          return await activateStorageBackend(handle, "fsa", args.route, args.otherBackend)
        }
        setPendingHandle(handle)
        return Message.DetectedPermissionRequired({
          storageType: "fsa",
          folderName: handle.name || "Gespeicherter Ordner",
          otherBackend: args.otherBackend,
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedPickLocalDirectory({
            message: `Ordner konnte nicht geöffnet werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const DisconnectStorage = Command.define("DisconnectStorage", {
  args: {
    hasDirectoryPicker: Schema.Boolean,
    hasOPFS: Schema.Boolean,
    route: AppRoute,
  },
  messages: [
    Message.DetectedNoFolderSelected,
    Message.SucceededInitializeStorage,
    Message.FailedDisconnectStorage,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        revokeActivePreviewUrl()
        const active = getActiveStorage()
        if (active) {
          await active.disconnect()
        }
        await clearSavedDirectoryHandle()
        setActiveStorage(null)
        setPendingHandle(null)
        setSavedFsaHandle(null)

        const opfsSavedBackend: SavedBackend = args.hasOPFS
          ? SavedBackend.Granted({ rootName: OPFS_APP_FOLDER })
          : SavedBackend.Unsupported()

        return Message.DetectedNoFolderSelected({
          storageType: "fsa",
          otherBackend: opfsSavedBackend,
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDisconnectStorage({
            message: `Fehler beim Trennen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const RefreshEntries = Command.define("RefreshEntries", {
  args: {
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededListEntries, Message.FailedListEntries],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
        const entries = await storage.listEntries(args.subPath)
        return Message.SucceededListEntries({
          subPath: args.subPath,
          entries,
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedListEntries({
            message: error.message,
          }),
        ),
      ),
    ),
})

export const NavigateToSubfolder = Command.define("NavigateToSubfolder", {
  args: {
    targetSubPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededListEntries, Message.FailedNavigateToSubfolder],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
        const entries = await storage.listEntries(args.targetSubPath)
        return Message.SucceededListEntries({
          subPath: args.targetSubPath,
          entries,
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedNavigateToSubfolder({
            message: `Ordner konnte nicht geöffnet werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const OpenFileInBrowser = Command.define("OpenFileInBrowser", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
  },
  messages: [Message.CompletedOpenFileInBrowser],
  execute: (args) => {
    const encodedPath = encodeSubPath([...args.subPath, args.fileName])
    return Navigation.load(`/${encodedPath}`).pipe(Effect.as(Message.CompletedOpenFileInBrowser()))
  },
})

export const PushUrl = Command.define("PushUrl", {
  args: {
    url: Schema.String,
  },
  messages: [Message.CompletedPushUrl],
  execute: (args) => Navigation.pushUrl(args.url).pipe(Effect.as(Message.CompletedPushUrl())),
})

export const ReplaceUrl = Command.define("ReplaceUrl", {
  args: {
    url: Schema.String,
  },
  messages: [Message.CompletedReplaceUrl],
  execute: (args) => Navigation.replaceUrl(args.url).pipe(Effect.as(Message.CompletedReplaceUrl())),
})

export const LoadUrl = Command.define("LoadUrl", {
  args: {
    url: Schema.String,
  },
  messages: [Message.CompletedLoadUrl],
  execute: (args) => Navigation.load(args.url).pipe(Effect.as(Message.CompletedLoadUrl())),
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
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
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
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
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
  messages: [
    Message.SucceededModalMutation,
    Message.CancelledModalMutation,
    Message.FailedModalMutation,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }

        if (args.modalState._tag === "CreateFolder") {
          await storage.createDirectory(args.subPath, args.modalState.name.trim())
        } else if (args.modalState._tag === "EditFolder") {
          const newName = args.modalState.name.trim()
          const { originalName } = args.modalState
          if (newName !== originalName) {
            await storage.renameDirectory(args.subPath, originalName, newName)
          }
        } else if (args.modalState._tag === "CreateFile") {
          await storage.writeFile(
            args.subPath,
            args.modalState.name.trim(),
            args.modalState.content,
          )
        } else if (args.modalState._tag === "EditFile") {
          const newName = args.modalState.name.trim()
          const { originalName, fileMode } = args.modalState

          if (fileMode._tag === "Text") {
            await storage.writeFile(args.subPath, newName, fileMode.content)
            if (originalName !== newName) {
              await storage.deleteEntry(args.subPath, originalName, "file")
            }
          } else if (fileMode.edit._tag === "Editing") {
            const decodedBytes = base64ToUint8Array(fileMode.edit.content)
            await storage.writeFileBuffer(args.subPath, newName, decodedBytes)
            if (originalName !== newName) {
              await storage.deleteEntry(args.subPath, originalName, "file")
            }
          } else {
            await storage.renameBinaryFile(args.subPath, originalName, newName)
          }
        } else if (args.modalState._tag === "ConfirmOverwrite") {
          const { targetName, originalName, content, isBase64, isEditing } = args.modalState
          if (isBase64) {
            const decodedBytes = base64ToUint8Array(content)
            await storage.writeFileBuffer(args.subPath, targetName, decodedBytes)
          } else {
            await storage.writeFile(args.subPath, targetName, content)
          }
          if (isEditing && originalName !== targetName) {
            await storage.deleteEntry(args.subPath, originalName, "file")
          }
        }

        revokeActivePreviewUrl()
        const updatedEntries = await storage.listEntries(args.subPath)
        return Message.SucceededModalMutation({ entries: updatedEntries })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedModalMutation({
            message: `Speichern fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const DeleteModalEntry = Command.define("DeleteModalEntry", {
  args: {
    entryName: Schema.String,
    isFolder: Schema.Boolean,
    subPath: Schema.Array(Schema.String),
  },
  messages: [
    Message.SucceededModalMutation,
    Message.CancelledModalMutation,
    Message.FailedModalMutation,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }

        await storage.deleteEntry(
          args.subPath,
          args.entryName,
          args.isFolder ? "directory" : "file",
        )
        revokeActivePreviewUrl()
        const updatedEntries = await storage.listEntries(args.subPath)
        return Message.SucceededModalMutation({ entries: updatedEntries })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedModalMutation({
            message: `Löschen fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const SelectImportFiles = Command.define("SelectImportFiles", {
  messages: [Message.SelectedImportFiles],
  execute: File.selectMultiple([]).pipe(
    Effect.map((selectedFiles) => {
      setPendingImportFiles(selectedFiles)
      const pendingFiles = selectedFiles.map((file) => ({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      }))
      return Message.SelectedImportFiles({ files: pendingFiles })
    }),
  ),
})

export const WritePendingImportFiles = Command.define("WritePendingImportFiles", {
  args: {
    items: Schema.Array(ResolvedImportItem),
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.CompletedImportFiles],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }

        const pendingFiles = getPendingImportFiles()
        setPendingImportFiles([])

        const fileMap = new Map<string, globalThis.File>(pendingFiles.map((f) => [f.name, f]))

        const importResults = await args.items.reduce(
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
          Promise.resolve({
            importedCount: 0,
            errors: [] as ReadonlyArray<string>,
          }),
        )

        const entries = await storage.listEntries(args.subPath)
        if (Array.isReadonlyArrayNonEmpty(importResults.errors)) {
          return Message.CompletedImportFiles({
            entries,
            maybeAlertBanner: Option.some({
              message: `Fehler beim Importieren (${importResults.importedCount} erfolgreich): ${Array.join(importResults.errors, "; ")}`,
              variant: "danger",
            }),
          })
        }

        return Message.CompletedImportFiles({
          entries,
          maybeAlertBanner: Option.none(),
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.CompletedImportFiles({
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

export const CopyApiDtsToClipboard = Command.define("CopyApiDtsToClipboard", {
  messages: [Message.SucceededCopyDts, Message.FailedCopyDts],
  execute: Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api.d.ts", { cache: "no-cache" })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} beim Laden von /api.d.ts`)
      }
      const dtsText = await res.text()
      await navigator.clipboard.writeText(dtsText)
      return Message.SucceededCopyDts()
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.FailedCopyDts({
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

export const TriggerInstallAppPrompt = Command.define("TriggerInstallAppPrompt", {
  messages: [Message.CompletedTriggerInstallAppPrompt],
  execute: Effect.tryPromise({
    try: async () => {
      const promptEvent = getDeferredInstallPrompt()
      if (!promptEvent) {
        return Message.CompletedTriggerInstallAppPrompt({ didAccept: false })
      }
      setDeferredInstallPrompt(null)
      await promptEvent.prompt()
      const choice = await promptEvent.userChoice
      return Message.CompletedTriggerInstallAppPrompt({
        didAccept: choice.outcome === "accepted",
      })
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(Message.CompletedTriggerInstallAppPrompt({ didAccept: false })),
    ),
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
