import { Array, Duration, Effect, Match, Option, Schema, pipe } from "effect"
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
  BinaryEdit,
  CopyDtsState,
  EditorFileMode,
  type FileEntry,
  FileEntryKind,
  HelpTopic,
  ModalState,
  OPFS_APP_FOLDER,
  ResolvedImportItem,
  SavedBackend,
  encodeSubPath,
} from "./model"

const requireActiveStorage = (): FileSystemHandleStorage =>
  Option.match(getActiveStorage(), {
    onNone: () => {
      throw new Error("Kein aktiver Speicher verfügbar.")
    },
    onSome: (storage) => storage,
  })

const findCachedHandle = async ({
  includePending,
}: {
  readonly includePending: boolean
}): Promise<Option.Option<FileSystemDirectoryHandle>> => {
  const maybeCached = Option.orElse(
    includePending ? getPendingHandle() : Option.none(),
    getSavedFsaHandle,
  )
  return Option.isSome(maybeCached) ? maybeCached : await getSavedDirectoryHandle()
}

const listEntriesOrRoot = async (
  storage: FileSystemHandleStorage,
  subPath: ReadonlyArray<string>,
): Promise<{
  readonly resolvedSubPath: ReadonlyArray<string>
  readonly entries: ReadonlyArray<FileEntry>
  readonly didFallback: boolean
}> => {
  try {
    return {
      resolvedSubPath: subPath,
      entries: await storage.listEntries(subPath),
      didFallback: false,
    }
  } catch {
    return { resolvedSubPath: [], entries: await storage.listEntries([]), didFallback: true }
  }
}

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
      const { resolvedSubPath, entries } = await listEntriesOrRoot(storage, subPath)
      return {
        subPath: resolvedSubPath,
        entries,
        maybeModalState: Option.some(
          ModalState.Help({
            maybeOpenTopic: Option.orElse(maybeTopic, () => Option.some<HelpTopic>("api")),
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
      const { resolvedSubPath, entries, didFallback } = await listEntriesOrRoot(storage, subPath)
      const maybeAlertBanner = didFallback
        ? Option.some<AlertBanner>({
            message: `Pfad "/${subPath.join("/")}" wurde nicht gefunden.`,
            variant: "warning",
          })
        : Option.none<AlertBanner>()
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
      const { entries, didFallback } = await listEntriesOrRoot(storage, subPath)
      if (didFallback) {
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

      return await Option.match(
        pipe(
          entries,
          Array.findFirst((entry) => entry.name === name),
        ),
        {
          onNone: async () => {
            return {
              subPath,
              entries,
              maybeModalState: Option.none(),
              maybeAlertBanner: Option.some<AlertBanner>({
                message: `Eintrag "${name}" wurde in diesem Ordner nicht gefunden.`,
                variant: "warning",
              }),
            }
          },
          onSome: async (targetEntry) => {
            if (targetEntry.kind === "directory") {
              return {
                subPath: subPath,
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

            const fileMode = await loadEditorFileModeForEntry(storage, subPath, targetEntry.name)
            return {
              subPath: subPath,
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
        },
      )
    },
  })
}

const activateStorageBackend = async (
  handle: FileSystemDirectoryHandle,
  type: "fsa" | "opfs",
  route: AppRoute,
  otherBackend: SavedBackend,
): Promise<Omit<typeof Message.SucceededInitializeStorage.Type, "_tag">> => {
  await saveDirectoryHandle(handle, type)
  const storage = new FileSystemHandleStorage(handle, type)
  setActiveStorage(Option.some(storage))
  if (type === "fsa") {
    setSavedFsaHandle(Option.some(handle))
    setPendingHandle(Option.none())
  }

  const resolved = await resolveRouteDeepLink(storage, route)

  return {
    storageType: type,
    rootName: storage.name,
    subPath: resolved.subPath,
    entries: resolved.entries,
    otherBackend,
    maybeModalState: resolved.maybeModalState,
    maybeAlertBanner: resolved.maybeAlertBanner,
  }
}

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
    Message.CompletedInitializeStoragePermissionRequired,
    Message.CompletedInitializeStorageNoFolderSelected,
    Message.FailedInitializeStorage,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const maybeSavedType = await getSavedStorageType()

        const opfsSavedBackend: SavedBackend = args.hasOPFS
          ? SavedBackend.Granted({ rootName: OPFS_APP_FOLDER })
          : SavedBackend.Unsupported()

        const determineFsaSavedBackend = async (): Promise<SavedBackend> => {
          if (!args.hasDirectoryPicker) {
            return SavedBackend.Unsupported()
          }
          return await Option.match(await getSavedDirectoryHandle(), {
            onNone: async () => SavedBackend.NoFolderSelected(),
            onSome: async (savedHandle): Promise<SavedBackend> => {
              setSavedFsaHandle(Option.some(savedHandle))
              const perm = await queryDirectoryPermission(savedHandle, "readwrite")
              if (perm === "granted") {
                return SavedBackend.Granted({
                  rootName: savedHandle.name || "Gespeicherter Ordner",
                })
              }
              setPendingHandle(Option.some(savedHandle))
              return SavedBackend.PermissionRequired({
                folderName: savedHandle.name || "Gespeicherter Ordner",
              })
            },
          })
        }

        if (Option.exists(maybeSavedType, (savedType) => savedType === "opfs") && args.hasOPFS) {
          const fsaSavedBackend = await determineFsaSavedBackend()
          const opfsRoot = await getOPFSRootDirectory()
          return Message.SucceededInitializeStorage(
            await activateStorageBackend(opfsRoot, "opfs", args.route, fsaSavedBackend),
          )
        }

        if (args.hasDirectoryPicker) {
          return await Option.match(await getSavedDirectoryHandle(), {
            onNone: async () =>
              Message.CompletedInitializeStorageNoFolderSelected({
                storageType: "fsa",
                otherBackend: opfsSavedBackend,
              }),
            onSome: async (savedHandle) => {
              setSavedFsaHandle(Option.some(savedHandle))
              const perm = await queryDirectoryPermission(savedHandle, "readwrite")
              if (perm === "granted") {
                return Message.SucceededInitializeStorage(
                  await activateStorageBackend(savedHandle, "fsa", args.route, opfsSavedBackend),
                )
              }
              setPendingHandle(Option.some(savedHandle))
              return Message.CompletedInitializeStoragePermissionRequired({
                storageType: "fsa",
                folderName: savedHandle.name || "Gespeicherter Ordner",
                otherBackend: opfsSavedBackend,
              })
            },
          })
        }

        if (args.hasOPFS) {
          const opfsRoot = await getOPFSRootDirectory()
          return Message.SucceededInitializeStorage(
            await activateStorageBackend(opfsRoot, "opfs", args.route, SavedBackend.Unsupported()),
          )
        }

        return Message.CompletedInitializeStorageNoFolderSelected({
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
    Message.SucceededPickLocalDirectory,
    Message.CancelledPickLocalDirectory,
    Message.FailedPickLocalDirectory,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const handle = await showDirectoryPicker({ mode: "readwrite" })
          return Message.SucceededPickLocalDirectory(
            await activateStorageBackend(handle, "fsa", args.route, args.otherBackend),
          )
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return Message.CancelledPickLocalDirectory()
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
    Message.SucceededGrantDirectoryPermission,
    Message.CompletedGrantDirectoryPermissionNoFolderSelected,
    Message.FailedGrantDirectoryPermission,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        return await Option.match(await findCachedHandle({ includePending: true }), {
          onNone: async () => {
            return Message.CompletedGrantDirectoryPermissionNoFolderSelected({
              storageType: "fsa",
              otherBackend: args.otherBackend,
            })
          },
          onSome: async (pending) => {
            const state = await requestDirectoryPermission(pending, "readwrite")
            if (state === "granted") {
              return Message.SucceededGrantDirectoryPermission(
                await activateStorageBackend(pending, "fsa", args.route, args.otherBackend),
              )
            }
            return Message.FailedGrantDirectoryPermission({
              message:
                "Zugriff auf den Ordner wurde verweigert. Bitte wählen Sie den Ordner erneut aus.",
            })
          },
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
  messages: [Message.SucceededActivateOpfsBackend, Message.FailedActivateOpfsBackend],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const opfsRoot = await getOPFSRootDirectory()
        return Message.SucceededActivateOpfsBackend(
          await activateStorageBackend(opfsRoot, "opfs", args.route, args.otherBackend),
        )
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
    Message.SucceededActivateFsaBackend,
    Message.CompletedActivateFsaBackendPermissionRequired,
    Message.CompletedActivateFsaBackendNoFolderSelected,
    Message.FailedActivateFsaBackend,
  ],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        return await Option.match(await findCachedHandle({ includePending: false }), {
          onNone: async () => {
            return Message.CompletedActivateFsaBackendNoFolderSelected({
              storageType: "fsa",
              otherBackend: args.otherBackend,
            })
          },
          onSome: async (handle) => {
            const perm = await queryDirectoryPermission(handle, "readwrite")
            if (perm === "granted") {
              return Message.SucceededActivateFsaBackend(
                await activateStorageBackend(handle, "fsa", args.route, args.otherBackend),
              )
            }
            setPendingHandle(Option.some(handle))
            return Message.CompletedActivateFsaBackendPermissionRequired({
              storageType: "fsa",
              folderName: handle.name || "Gespeicherter Ordner",
              otherBackend: args.otherBackend,
            })
          },
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedActivateFsaBackend({
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
  messages: [Message.SucceededDisconnectStorage, Message.FailedDisconnectStorage],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        revokeActivePreviewUrl()
        await Option.match(getActiveStorage(), {
          onNone: () => Promise.resolve(),
          onSome: (active) => active.disconnect(),
        })
        await clearSavedDirectoryHandle()
        setActiveStorage(Option.none())
        setPendingHandle(Option.none())
        setSavedFsaHandle(Option.none())

        const opfsSavedBackend: SavedBackend = args.hasOPFS
          ? SavedBackend.Granted({ rootName: OPFS_APP_FOLDER })
          : SavedBackend.Unsupported()

        return Message.SucceededDisconnectStorage({
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
  messages: [Message.SucceededRefreshEntries, Message.FailedRefreshEntries],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        const entries = await storage.listEntries(args.subPath)
        return Message.SucceededRefreshEntries({
          subPath: args.subPath,
          entries,
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedRefreshEntries({
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
  messages: [Message.SucceededNavigateToSubfolder, Message.FailedNavigateToSubfolder],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        const entries = await storage.listEntries(args.targetSubPath)
        return Message.SucceededNavigateToSubfolder({
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

export const TriggerInstallAppPrompt = Command.define("TriggerInstallAppPrompt", {
  messages: [Message.CompletedTriggerInstallAppPrompt],
  execute: Effect.tryPromise({
    try: async () => {
      return await Option.match(getDeferredInstallPrompt(), {
        onNone: async () => Message.CompletedTriggerInstallAppPrompt({ didAccept: false }),
        onSome: async (promptEvent) => {
          setDeferredInstallPrompt(Option.none())
          await promptEvent.prompt()
          const choice = await promptEvent.userChoice
          return Message.CompletedTriggerInstallAppPrompt({
            didAccept: choice.outcome === "accepted",
          })
        },
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
