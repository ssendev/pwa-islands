import { Duration, Effect, Option, Schema } from "effect"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import {
  FileSystemHandleStorage,
  arrayBufferToBase64,
  base64ToUint8Array,
  clearSavedDirectoryHandle,
  decodeUrlPathnameSegments,
  findFreeFileName,
  getActiveStorage,
  getDeferredInstallPrompt,
  getOPFSRootDirectory,
  getPendingHandle,
  getSavedDirectoryHandle,
  getSavedFileInfoVisible,
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
  showDirectoryPicker,
} from "./files"
import { Message } from "./message"
import {
  type AlertBanner,
  CopyDtsState,
  type FileEntry,
  ModalState,
  buildEditUrl,
  buildFolderUrl,
  isEditActionParam,
  parseHelpParam,
} from "./model"

// ---------------------------------------------------------------------------
// Internal Promise Helpers for Commands
// ---------------------------------------------------------------------------

const resolveUrlDeepLink = async (
  storage: FileSystemHandleStorage,
  pathname: string,
  search: string,
  syncHistoryMode: "replace" | "none",
): Promise<{
  readonly subPath: ReadonlyArray<string>
  readonly entries: ReadonlyArray<FileEntry>
  readonly maybeModalState: Option.Option<ModalState>
  readonly maybeAlertBanner: Option.Option<AlertBanner>
}> => {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`)
  const pwaislandsVal = params.get("pwaislands")
  const maybeHelp = parseHelpParam(pwaislandsVal)

  if (Option.isSome(maybeHelp)) {
    const maybeTopic = maybeHelp.value.maybeTopic
    const entries = await storage.listEntries()
    return {
      subPath: storage.subPath,
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
  }

  const isEditRequested = isEditActionParam(pwaislandsVal)
  const segments = decodeUrlPathnameSegments(pathname)

  if (segments.length === 0) {
    await storage.navigateToSubPath([])
    const entries = await storage.listEntries()
    return {
      subPath: [],
      entries,
      maybeModalState: Option.none(),
      maybeAlertBanner: Option.none(),
    }
  }

  if (isEditRequested) {
    const parentSegments = segments.slice(0, -1)
    const targetName = segments[segments.length - 1]

    try {
      await storage.navigateToSubPath(parentSegments)
    } catch {
      await storage.navigateToSubPath([])
      if (syncHistoryMode === "replace") {
        window.history.replaceState(null, "", buildFolderUrl([]))
      }
      const entries = await storage.listEntries()
      return {
        subPath: [],
        entries,
        maybeModalState: Option.none(),
        maybeAlertBanner: Option.some({
          message: `Pfad "/${parentSegments.join("/")}" wurde nicht gefunden.`,
          variant: "warning",
        }),
      }
    }

    const entries = await storage.listEntries()
    const targetEntry = entries.find((entry) => entry.name === targetName)

    if (!targetEntry) {
      if (syncHistoryMode === "replace") {
        window.history.replaceState(null, "", buildFolderUrl(storage.subPath))
      }
      return {
        subPath: storage.subPath,
        entries,
        maybeModalState: Option.none(),
        maybeAlertBanner: Option.some({
          message: `Eintrag "${targetName}" wurde in diesem Ordner nicht gefunden.`,
          variant: "warning",
        }),
      }
    }

    if (targetEntry.kind === "directory") {
      return {
        subPath: storage.subPath,
        entries,
        maybeModalState: Option.some(
          ModalState.EditFolder({
            originalName: targetEntry.name,
            name: targetEntry.name,
          }),
        ),
        maybeAlertBanner: Option.none(),
      }
    }

    const fileMode = await loadEditorFileModeForEntry(storage, targetEntry.name)
    return {
      subPath: storage.subPath,
      entries,
      maybeModalState: Option.some(
        ModalState.EditFile({
          originalName: targetEntry.name,
          name: targetEntry.name,
          fileMode,
        }),
      ),
      maybeAlertBanner: Option.none(),
    }
  }

  // Navigating to a folder path
  try {
    await storage.navigateToSubPath(segments)
    const entries = await storage.listEntries()
    return {
      subPath: storage.subPath,
      entries,
      maybeModalState: Option.none(),
      maybeAlertBanner: Option.none(),
    }
  } catch {
    const parentSegments = segments.slice(0, -1)
    const targetName = segments[segments.length - 1]
    try {
      await storage.navigateToSubPath(parentSegments)
      const entries = await storage.listEntries()
      const targetEntry = entries.find((entry) => entry.name === targetName)
      if (targetEntry && targetEntry.kind === "file") {
        const fileMode = await loadEditorFileModeForEntry(storage, targetEntry.name)
        if (syncHistoryMode === "replace") {
          window.history.replaceState(null, "", buildEditUrl(storage.subPath, targetEntry.name))
        }
        return {
          subPath: storage.subPath,
          entries,
          maybeModalState: Option.some(
            ModalState.EditFile({
              originalName: targetEntry.name,
              name: targetEntry.name,
              fileMode,
            }),
          ),
          maybeAlertBanner: Option.none(),
        }
      }
    } catch {
      // Fallback to root below
    }

    await storage.navigateToSubPath([])
    if (syncHistoryMode === "replace") {
      window.history.replaceState(null, "", buildFolderUrl([]))
    }
    const entries = await storage.listEntries()
    return {
      subPath: [],
      entries,
      maybeModalState: Option.none(),
      maybeAlertBanner: Option.some({
        message: `Ordner "/${segments.join("/")}" wurde nicht gefunden.`,
        variant: "warning",
      }),
    }
  }
}

const activateStorageBackend = async (
  handle: FileSystemDirectoryHandle,
  type: "fsa" | "opfs",
  isFallback: boolean,
  pathname: string,
  search: string,
): Promise<typeof Message.CompletedStorageInit.Type> => {
  await saveDirectoryHandle(handle, type)
  const storage = new FileSystemHandleStorage(handle, type)
  setActiveStorage(storage)
  setPendingHandle(null)

  const resolved = await resolveUrlDeepLink(storage, pathname, search, "replace")

  return Message.CompletedStorageInit({
    storageType: Option.some(type),
    rootName: storage.name,
    subPath: resolved.subPath,
    isFallback,
    entries: resolved.entries,
    maybeModalState: resolved.maybeModalState,
    maybeAlertBanner: resolved.maybeAlertBanner,
  })
}

// ---------------------------------------------------------------------------
// Foldkit Commands
// ---------------------------------------------------------------------------

export const LoadFileInfoPreference = Command.define("LoadFileInfoPreference", {
  messages: [Message.LoadedFileInfoPreference],
  execute: Effect.promise(async () => {
    const visible = await getSavedFileInfoVisible()
    return Message.LoadedFileInfoPreference({ visible })
  }),
})

export const SaveFileInfoPreference = Command.define("SaveFileInfoPreference", {
  args: {
    visible: Schema.Boolean,
  },
  messages: [Message.SavedFileInfoPreference],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        await saveFileInfoVisible(args.visible)
      } catch {
        // Ignore IndexedDB persistence errors
      }
      return Message.SavedFileInfoPreference()
    }),
})

export const InitializeStorage = Command.define("InitializeStorage", {
  args: {
    hasDirectoryPicker: Schema.Boolean,
    hasOPFS: Schema.Boolean,
    initialPathname: Schema.String,
    initialSearch: Schema.String,
  },
  messages: [
    Message.CompletedStorageInit,
    Message.DetectedPermissionRequired,
    Message.DetectedNoFolderSelected,
    Message.FailedStorageInit,
  ],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        const savedType = await getSavedStorageType()

        if (savedType === "opfs" && args.hasOPFS) {
          const opfsRoot = await getOPFSRootDirectory()
          return await activateStorageBackend(
            opfsRoot,
            "opfs",
            !args.hasDirectoryPicker,
            args.initialPathname,
            args.initialSearch,
          )
        }

        if (args.hasDirectoryPicker) {
          const savedHandle = await getSavedDirectoryHandle()
          if (savedHandle) {
            const perm = await queryDirectoryPermission(savedHandle, "readwrite")
            if (perm === "granted") {
              return await activateStorageBackend(
                savedHandle,
                "fsa",
                false,
                args.initialPathname,
                args.initialSearch,
              )
            }
            setPendingHandle(savedHandle)
            return Message.DetectedPermissionRequired({
              folderName: savedHandle.name || "Gespeicherter Ordner",
            })
          }
          return Message.DetectedNoFolderSelected()
        }

        if (args.hasOPFS) {
          const opfsRoot = await getOPFSRootDirectory()
          return await activateStorageBackend(
            opfsRoot,
            "opfs",
            true,
            args.initialPathname,
            args.initialSearch,
          )
        }

        return Message.DetectedNoFolderSelected()
      } catch (error) {
        return Message.FailedStorageInit({
          message:
            error instanceof Error
              ? error.message
              : "Unbekannter Fehler beim Initialisieren des Speichers",
        })
      }
    }),
})

export const PickLocalDirectory = Command.define("PickLocalDirectory", {
  messages: [
    Message.CompletedStorageInit,
    Message.CancelledFolderSelection,
    Message.ShownAlertBanner,
  ],
  execute: Effect.promise(async () => {
    try {
      const handle = await showDirectoryPicker({ mode: "readwrite" })
      return await activateStorageBackend(handle, "fsa", false, "/", "")
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") {
        return Message.CancelledFolderSelection()
      }
      return Message.ShownAlertBanner({
        banner: {
          message: `Ordner konnte nicht geöffnet werden: ${error instanceof Error ? error.message : String(error)}`,
          variant: "danger",
        },
      })
    }
  }),
})

export const GrantDirectoryPermission = Command.define("GrantDirectoryPermission", {
  messages: [
    Message.CompletedStorageInit,
    Message.DetectedNoFolderSelected,
    Message.ShownAlertBanner,
  ],
  execute: Effect.promise(async () => {
    try {
      const pending = getPendingHandle()
      if (!pending) {
        return Message.DetectedNoFolderSelected()
      }
      const state = await requestDirectoryPermission(pending, "readwrite")
      if (state === "granted") {
        return await activateStorageBackend(
          pending,
          "fsa",
          false,
          window.location.pathname,
          window.location.search,
        )
      }
      return Message.ShownAlertBanner({
        banner: {
          message:
            "Zugriff auf den Ordner wurde verweigert. Bitte wählen Sie den Ordner erneut aus.",
          variant: "warning",
        },
      })
    } catch (error) {
      return Message.ShownAlertBanner({
        banner: {
          message: `Fehler bei der Berechtigungsanfrage: ${error instanceof Error ? error.message : String(error)}`,
          variant: "danger",
        },
      })
    }
  }),
})

export const ActivateOpfsBackend = Command.define("ActivateOpfsBackend", {
  args: {
    isFallback: Schema.Boolean,
  },
  messages: [Message.CompletedStorageInit, Message.ShownAlertBanner],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        const opfsRoot = await getOPFSRootDirectory()
        return await activateStorageBackend(opfsRoot, "opfs", args.isFallback, "/", "")
      } catch (error) {
        return Message.ShownAlertBanner({
          banner: {
            message: `Interner Speicher (OPFS) konnte nicht geöffnet werden: ${error instanceof Error ? error.message : String(error)}`,
            variant: "danger",
          },
        })
      }
    }),
})

export const DisconnectStorage = Command.define("DisconnectStorage", {
  args: {
    hasDirectoryPicker: Schema.Boolean,
    hasOPFS: Schema.Boolean,
  },
  messages: [
    Message.DetectedNoFolderSelected,
    Message.CompletedStorageInit,
    Message.ShownAlertBanner,
  ],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        revokeActivePreviewUrl()
        const active = getActiveStorage()
        if (active) {
          await active.disconnect()
        } else {
          await clearSavedDirectoryHandle()
        }
        setActiveStorage(null)
        setPendingHandle(null)
        window.history.replaceState(null, "", buildFolderUrl([]))

        if (!args.hasDirectoryPicker && args.hasOPFS) {
          const opfsRoot = await getOPFSRootDirectory()
          return await activateStorageBackend(opfsRoot, "opfs", true, "/", "")
        }
        return Message.DetectedNoFolderSelected()
      } catch (error) {
        return Message.ShownAlertBanner({
          banner: {
            message: `Fehler beim Trennen: ${error instanceof Error ? error.message : String(error)}`,
            variant: "danger",
          },
        })
      }
    }),
})

export const RefreshEntries = Command.define("RefreshEntries", {
  messages: [Message.SucceededListEntries, Message.FailedListEntries],
  execute: Effect.promise(async () => {
    try {
      const storage = getActiveStorage()
      if (!storage) {
        throw new Error("Kein aktiver Speicher verfügbar.")
      }
      const entries = await storage.listEntries()
      return Message.SucceededListEntries({
        subPath: storage.subPath,
        entries,
      })
    } catch (error) {
      return Message.FailedListEntries({
        message: error instanceof Error ? error.message : "Unbekannter Lesefehler",
      })
    }
  }),
})

export const NavigateToSubfolder = Command.define("NavigateToSubfolder", {
  args: {
    targetSubPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededListEntries, Message.ShownAlertBanner],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
        await storage.navigateToSubPath(args.targetSubPath)
        window.history.pushState(null, "", buildFolderUrl(storage.subPath))
        const entries = await storage.listEntries()
        return Message.SucceededListEntries({
          subPath: storage.subPath,
          entries,
        })
      } catch (error) {
        return Message.ShownAlertBanner({
          banner: {
            message: `Ordner konnte nicht geöffnet werden: ${error instanceof Error ? error.message : String(error)}`,
            variant: "danger",
          },
        })
      }
    }),
})

export const OpenFileInBrowser = Command.define("OpenFileInBrowser", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
  },
  messages: [Message.CompletedOpenFile],
  execute: (args) =>
    Effect.sync(() => {
      const encodedPath = [...args.subPath, args.fileName].map(encodeURIComponent).join("/")
      window.location.assign(`/${encodedPath}`)
      return Message.CompletedOpenFile()
    }),
})

export const SyncHistoryUrl = Command.define("SyncHistoryUrl", {
  args: {
    mode: Schema.Literals(["push", "replace"]),
    url: Schema.String,
    revokePreview: Schema.optional(Schema.Boolean),
  },
  messages: [Message.CompletedHistorySync, Message.CompletedStorageInit],
  execute: (args) =>
    Effect.sync(() => {
      if (args.revokePreview === true) {
        revokeActivePreviewUrl()
      }
      if (args.mode === "push") {
        window.history.pushState(null, "", args.url)
      } else {
        window.history.replaceState(null, "", args.url)
      }
      return Message.CompletedHistorySync()
    }),
})

export const HandlePopStateNavigation = Command.define("HandlePopStateNavigation", {
  args: {
    pathname: Schema.String,
    search: Schema.String,
    isFallback: Schema.Boolean,
  },
  messages: [Message.CompletedStorageInit, Message.ShownAlertBanner],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        revokeActivePreviewUrl()
        const storage = getActiveStorage()
        if (!storage) {
          return Message.ShownAlertBanner({
            banner: {
              message: "Kein aktiver Speicher verfügbar.",
              variant: "warning",
            },
          })
        }
        const resolved = await resolveUrlDeepLink(storage, args.pathname, args.search, "none")
        return Message.CompletedStorageInit({
          storageType: Option.some(storage.type),
          rootName: storage.name,
          subPath: resolved.subPath,
          isFallback: args.isFallback,
          entries: resolved.entries,
          maybeModalState: resolved.maybeModalState,
          maybeAlertBanner: resolved.maybeAlertBanner,
        })
      } catch (error) {
        return Message.ShownAlertBanner({
          banner: {
            message: `Navigationsfehler: ${error instanceof Error ? error.message : String(error)}`,
            variant: "danger",
          },
        })
      }
    }),
})

export const InspectFileForEditor = Command.define("InspectFileForEditor", {
  args: {
    entryName: Schema.String,
    subPath: Schema.Array(Schema.String),
    pushHistory: Schema.Boolean,
  },
  messages: [Message.OpenedEditFileModal, Message.FailedOpenEditModal],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
        const fileMode = await loadEditorFileModeForEntry(storage, args.entryName)
        if (args.pushHistory) {
          window.history.pushState(null, "", buildEditUrl(args.subPath, args.entryName))
        }
        return Message.OpenedEditFileModal({
          originalName: args.entryName,
          fileMode,
        })
      } catch (error) {
        return Message.FailedOpenEditModal({
          message: `Datei "${args.entryName}" konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }),
})

export const FocusModalNameInput = Command.define("FocusModalNameInput", {
  messages: [Message.CompletedHistorySync],
  execute: Dom.focus("#modal-file-name").pipe(
    Effect.as(Message.CompletedHistorySync()),
    Effect.catch(() => Effect.succeed(Message.CompletedHistorySync())),
  ),
})

export const LoadModalBase64 = Command.define("LoadModalBase64", {
  args: {
    entryName: Schema.String,
  },
  messages: [Message.LoadedModalBase64Content, Message.FailedLoadModalBase64Content],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
        const buffer = await storage.readFileBuffer(args.entryName)
        const base64Content = arrayBufferToBase64(buffer)
        return Message.LoadedModalBase64Content({ base64Content })
      } catch (error) {
        return Message.FailedLoadModalBase64Content({
          message: `Dateiinhalt konnte nicht als Base64 geladen werden: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }),
})

export const SaveModalChanges = Command.define("SaveModalChanges", {
  args: {
    modalState: ModalState,
  },
  messages: [
    Message.SucceededModalMutation,
    Message.CancelledModalMutation,
    Message.FailedModalMutation,
  ],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }

        const validateName = (rawName: string, isFolder: boolean): string | null => {
          const trimmed = rawName.trim()
          if (!trimmed) {
            window.alert(
              isFolder
                ? "Bitte geben Sie einen Ordnernamen ein."
                : "Bitte geben Sie einen Dateinamen ein.",
            )
            return null
          }
          if (trimmed.includes("/") || trimmed.includes("\\")) {
            window.alert(
              `Der ${isFolder ? "Ordnername" : "Dateiname"} darf keine Schrägstriche enthalten.`,
            )
            return null
          }
          return trimmed
        }

        const existingEntries = await storage.listEntries()
        const existingNames = new Set(existingEntries.map((entry) => entry.name))

        if (args.modalState._tag === "CreateFolder") {
          const newName = validateName(args.modalState.name, true)
          if (newName === null) {
            return Message.CancelledModalMutation()
          }
          if (existingNames.has(newName)) {
            window.alert(`Ein Eintrag mit dem Namen "${newName}" existiert bereits.`)
            return Message.CancelledModalMutation()
          }
          await storage.createDirectory(newName)
        } else if (args.modalState._tag === "EditFolder") {
          const newName = validateName(args.modalState.name, false)
          if (newName === null) {
            return Message.CancelledModalMutation()
          }
          const { originalName } = args.modalState
          if (newName !== originalName && existingNames.has(newName)) {
            window.alert(`Ein Eintrag mit dem Namen "${newName}" existiert bereits.`)
            return Message.CancelledModalMutation()
          }
          if (newName !== originalName) {
            await storage.renameDirectory(originalName, newName)
          }
        } else if (args.modalState._tag === "CreateFile") {
          const newName = validateName(args.modalState.name, false)
          if (newName === null) {
            return Message.CancelledModalMutation()
          }
          if (existingNames.has(newName)) {
            const overwrite = window.confirm(
              `Ein Eintrag mit dem Namen "${newName}" existiert bereits. Möchten Sie ihn überschreiben?`,
            )
            if (!overwrite) {
              return Message.CancelledModalMutation()
            }
          }
          await storage.writeFile(newName, args.modalState.content)
        } else if (args.modalState._tag === "EditFile") {
          const newName = validateName(args.modalState.name, false)
          if (newName === null) {
            return Message.CancelledModalMutation()
          }
          const { originalName, fileMode } = args.modalState
          if (newName !== originalName && existingNames.has(newName)) {
            const overwrite = window.confirm(
              `Ein Eintrag mit dem Namen "${newName}" existiert bereits. Möchten Sie ihn überschreiben?`,
            )
            if (!overwrite) {
              return Message.CancelledModalMutation()
            }
          }

          if (fileMode._tag === "Text") {
            await storage.writeFile(newName, fileMode.content)
            if (originalName !== newName) {
              await storage.deleteEntry(originalName, "file")
            }
          } else if (fileMode.isBase64Enabled) {
            let decodedBytes: Uint8Array<ArrayBuffer>
            try {
              decodedBytes = base64ToUint8Array(fileMode.base64Content)
            } catch {
              window.alert("Ungültige Base64-Kodierung. Bitte überprüfen Sie die Eingabe.")
              return Message.CancelledModalMutation()
            }
            await storage.writeFileBuffer(newName, decodedBytes)
            if (originalName !== newName) {
              await storage.deleteEntry(originalName, "file")
            }
          } else {
            await storage.renameBinaryFile(originalName, newName)
          }
        }

        revokeActivePreviewUrl()
        window.history.replaceState(null, "", buildFolderUrl(storage.subPath))
        const updatedEntries = await storage.listEntries()
        return Message.SucceededModalMutation({ entries: updatedEntries })
      } catch (error) {
        return Message.FailedModalMutation({
          message: `Speichern fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }),
})

export const DeleteModalEntry = Command.define("DeleteModalEntry", {
  args: {
    entryName: Schema.String,
    isFolder: Schema.Boolean,
  },
  messages: [
    Message.SucceededModalMutation,
    Message.CancelledModalMutation,
    Message.FailedModalMutation,
  ],
  execute: (args) =>
    Effect.promise(async () => {
      try {
        const storage = getActiveStorage()
        if (!storage) {
          throw new Error("Kein aktiver Speicher verfügbar.")
        }
        const confirmMsg = args.isFolder
          ? `Möchten Sie den Ordner "${args.entryName}" und dessen gesamten Inhalt wirklich unwiderruflich löschen?`
          : `Möchten Sie die Datei "${args.entryName}" wirklich unwiderruflich löschen?`
        if (!window.confirm(confirmMsg)) {
          return Message.CancelledModalMutation()
        }

        await storage.deleteEntry(args.entryName, args.isFolder ? "directory" : "file")
        revokeActivePreviewUrl()
        window.history.replaceState(null, "", buildFolderUrl(storage.subPath))
        const updatedEntries = await storage.listEntries()
        return Message.SucceededModalMutation({ entries: updatedEntries })
      } catch (error) {
        return Message.FailedModalMutation({
          message: `Löschen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }),
})

export const ImportExternalFiles = Command.define("ImportExternalFiles", {
  messages: [Message.CompletedImportFiles],
  execute: Effect.promise(async () => {
    try {
      const storage = getActiveStorage()
      if (!storage) {
        throw new Error("Kein aktiver Speicher verfügbar.")
      }

      const selectedFiles = await new Promise<ReadonlyArray<globalThis.File>>((resolve) => {
        const input = document.createElement("input")
        input.type = "file"
        input.multiple = true
        input.style.display = "none"
        document.body.appendChild(input)

        let settled = false
        const finish = (files: ReadonlyArray<globalThis.File>) => {
          if (settled) {
            return
          }
          settled = true
          input.remove()
          resolve(files)
        }

        input.addEventListener("change", () => {
          finish(input.files ? Array.from(input.files) : [])
        })
        input.addEventListener("cancel", () => {
          finish([])
        })
        input.click()
      })

      if (selectedFiles.length === 0) {
        const entries = await storage.listEntries()
        return Message.CompletedImportFiles({
          entries,
          maybeAlertBanner: Option.none(),
        })
      }

      const existingEntries = await storage.listEntries()
      const existingByName = new Map<string, FileEntry>(
        existingEntries.map((entry) => [entry.name, entry]),
      )
      const reservedNames = new Set<string>(existingByName.keys())

      const askImportCollision = (
        fileName: string,
        suggestedNewName: string,
      ): "replace" | "rename" | "skip" => {
        const replace = window.confirm(
          `Die Datei "${fileName}" existiert bereits in diesem Ordner.\n\n` +
            `Klicken Sie auf „OK“, um die bestehende Datei zu ersetzen.\n` +
            `Klicken Sie auf „Abbrechen“ für weitere Optionen (Beide behalten / Überspringen).`,
        )
        if (replace) {
          return "replace"
        }
        const keepBoth = window.confirm(
          `Möchten Sie beide Dateien behalten?\n\n` +
            `• „OK“: Neue Datei als "${suggestedNewName}" speichern\n` +
            `• „Abbrechen“: "${fileName}" überspringen`,
        )
        return keepBoth ? "rename" : "skip"
      }

      const collidingCount = selectedFiles.filter((file) => {
        const existing = existingByName.get(file.name)
        return existing !== undefined && existing.kind === "file"
      }).length

      let batchAction: "replace" | "rename" | "skip" | null = null
      let remainingCollisions = collidingCount
      let importedCount = 0
      const errors: Array<string> = []

      for (const file of selectedFiles) {
        const rawName = file.name.trim()
        if (!rawName) {
          continue
        }

        const existing = existingByName.get(rawName)
        let targetName = rawName

        if (existing && existing.kind === "directory") {
          const suggested = findFreeFileName(rawName, reservedNames)
          const rename = window.confirm(
            `Ein Ordner mit dem Namen "${rawName}" existiert bereits.\n\n` +
              `Möchten Sie die Datei stattdessen als "${suggested}" importieren?`,
          )
          if (!rename) {
            continue
          }
          targetName = suggested
        } else if (existing || reservedNames.has(rawName)) {
          remainingCollisions--
          const suggested = findFreeFileName(rawName, reservedNames)

          let action: "replace" | "rename" | "skip"
          if (batchAction !== null) {
            action = batchAction
          } else {
            action = askImportCollision(rawName, suggested)
            if (remainingCollisions > 0) {
              const actionLabels: Record<"replace" | "rename" | "skip", string> = {
                replace: "Ersetzen",
                rename: "Beide behalten (umbenennen)",
                skip: "Überspringen",
              }
              const applyAll = window.confirm(
                `Es gibt noch ${remainingCollisions} weitere ${
                  remainingCollisions === 1 ? "Datei" : "Dateien"
                } mit gleichem Namen.\n\n` +
                  `Möchten Sie die Auswahl „${actionLabels[action]}“ auf alle weiteren Konflikte anwenden?`,
              )
              if (applyAll) {
                batchAction = action
              }
            }
          }

          if (action === "skip") {
            continue
          }
          if (action === "rename") {
            targetName = suggested
          }
        }

        try {
          const buffer = await file.arrayBuffer()
          await storage.writeFileBuffer(targetName, buffer)
          reservedNames.add(targetName)
          existingByName.set(targetName, {
            name: targetName,
            kind: "file",
            maybeSize: Option.some(file.size),
            maybeLastModified: Option.some(file.lastModified),
          })
          importedCount++
        } catch (err) {
          errors.push(`${targetName}: ${(err as Error).message}`)
        }
      }

      const entries = await storage.listEntries()
      if (errors.length > 0) {
        return Message.CompletedImportFiles({
          entries,
          maybeAlertBanner: Option.some({
            message: `Fehler beim Importieren (${importedCount} erfolgreich): ${errors.join("; ")}`,
            variant: "danger",
          }),
        })
      }

      return Message.CompletedImportFiles({
        entries,
        maybeAlertBanner: Option.none(),
      })
    } catch (error) {
      return Message.CompletedImportFiles({
        entries: [],
        maybeAlertBanner: Option.some({
          message: `Fehler beim Datei-Import: ${error instanceof Error ? error.message : String(error)}`,
          variant: "danger",
        }),
      })
    }
  }),
})

export const CopyApiDtsToClipboard = Command.define("CopyApiDtsToClipboard", {
  messages: [Message.SucceededCopyDts, Message.FailedCopyDts],
  execute: Effect.promise(async () => {
    try {
      const res = await fetch("/api.d.ts", { cache: "no-cache" })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} beim Laden von /api.d.ts`)
      }
      const dtsText = await res.text()
      await navigator.clipboard.writeText(dtsText)
      return Message.SucceededCopyDts()
    } catch (error) {
      return Message.FailedCopyDts({
        message: `Kopieren fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }),
})

export const DelayResetCopyDtsStatus = Command.define("DelayResetCopyDtsStatus", {
  messages: [Message.ResetCopyDtsStatus],
  execute: Effect.sleep(Duration.seconds(2)).pipe(Effect.as(Message.ResetCopyDtsStatus())),
})

export const TriggerInstallAppPrompt = Command.define("TriggerInstallAppPrompt", {
  messages: [Message.CompletedInstallApp],
  execute: Effect.promise(async () => {
    try {
      const promptEvent = getDeferredInstallPrompt()
      if (!promptEvent) {
        return Message.CompletedInstallApp({ didAccept: false })
      }
      setDeferredInstallPrompt(null)
      await promptEvent.prompt()
      const choice = await promptEvent.userChoice
      return Message.CompletedInstallApp({
        didAccept: choice.outcome === "accepted",
      })
    } catch {
      return Message.CompletedInstallApp({ didAccept: false })
    }
  }),
})
