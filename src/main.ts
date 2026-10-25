import { Array, Option, pipe } from "effect"
import { UrlRequest } from "foldkit/navigation"
import { modifyFields } from "foldkit/struct"
import type * as Update from "foldkit/update"
import { toString as urlToString, type Url } from "foldkit/url"
import {
  ActivateFsaBackend,
  ActivateOpfsBackend,
  CopyApiDtsToClipboard,
  DeleteModalEntry,
  DisconnectStorage,
  FocusModalNameInput,
  GrantDirectoryPermission,
  InitializeStorage,
  InspectFileForEditor,
  LoadFileInfoPreference,
  LoadModalBase64,
  LoadUrl,
  NavigateToSubfolder,
  OpenFileInBrowser,
  PickLocalDirectory,
  PushUrl,
  RefreshEntries,
  ReplaceUrl,
  SaveFileInfoPreference,
  SaveModalChanges,
  SelectImportFiles,
  TriggerInstallAppPrompt,
  WaitBeforeResetCopyDts,
  WritePendingImportFiles,
} from "./command"
import { base64ToUint8Array, findFreeFileName, revokeActivePreviewUrl } from "./files"
import { Message } from "./message"
import {
  AppRoute,
  BinaryEdit,
  CopyDtsState,
  EditorFileMode,
  EntriesState,
  type FileEntry,
  Flags,
  type HelpTopic,
  InstallPrompt,
  Model,
  ModalState,
  OPFS_APP_FOLDER,
  type PendingImportFile,
  PreviewContent,
  type ResolvedImportItem,
  SavedBackend,
  StorageState,
  buildEditUrl,
  buildFolderUrl,
  buildHelpUrl,
  buildNewUrl,
  currentSubPathFromStorageState,
  parseUrlToRoute,
} from "./model"
import { subscriptions } from "./subscription"
import { view } from "./view"

// INIT

export const init = (flags: Flags, url: Url): Update.Return<Model, Message> => {
  const isSupported = flags.hasDirectoryPicker || flags.hasOPFS
  const initialRoute = parseUrlToRoute(url)
  const maybeInitialModal: Option.Option<ModalState> = AppRoute.match(initialRoute, {
    Folder: () => Option.none(),
    New: ({ target }) =>
      Option.some(
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
    Edit: () => Option.none(),
    Help: ({ maybeTopic }) =>
      Option.some(
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
  })

  if (!isSupported) {
    return {
      model: {
        hasDirectoryPicker: false,
        hasOPFS: false,
        origin: flags.origin,
        storageState: StorageState.Unsupported(),
        showFileInfo: true,
        isSettingsOpen: false,
        installPrompt: InstallPrompt.Unavailable(),
        modalState: Option.getOrElse(maybeInitialModal, () => ModalState.Closed()),
        maybeAlertBanner: Option.some({
          message:
            "Browser wird nicht unterstützt: Weder die File System Access API noch OPFS sind in diesem Browser verfügbar. Bitte verwenden Sie einen aktuellen Browser (z. B. Chrome, Edge, Firefox oder Safari).",
          variant: "danger",
        }),
      },
    }
  }

  return {
    model: {
      hasDirectoryPicker: flags.hasDirectoryPicker,
      hasOPFS: flags.hasOPFS,
      origin: flags.origin,
      storageState: StorageState.Initializing(),
      showFileInfo: true,
      isSettingsOpen: false,
      installPrompt: InstallPrompt.Unavailable(),
      modalState: Option.getOrElse(maybeInitialModal, () => ModalState.Closed()),
      maybeAlertBanner: Option.none(),
    },
    commands: [
      LoadFileInfoPreference(),
      InitializeStorage({
        hasDirectoryPicker: flags.hasDirectoryPicker,
        hasOPFS: flags.hasOPFS,
        route: initialRoute,
      }),
    ],
  }
}

// UPDATE

const getOtherBackend = (storageState: StorageState): SavedBackend =>
  StorageState.match(storageState, {
    Initializing: () => SavedBackend.NoFolderSelected(),
    Unsupported: () => SavedBackend.Unsupported(),
    NoFolderSelected: (s) => s.otherBackend,
    PermissionRequired: (s) => s.otherBackend,
    Ready: (s) => s.otherBackend,
  })

const handleUseFsa = (model: Model): Update.Return<Model, Message> => {
  const opfsSavedBackend: SavedBackend = model.hasOPFS
    ? SavedBackend.Granted({ rootName: OPFS_APP_FOLDER })
    : SavedBackend.Unsupported()
  const other = getOtherBackend(model.storageState)

  return SavedBackend.match(other, {
    Unsupported: () => ({
      model: modifyFields(model, { isSettingsOpen: () => false }),
    }),
    NoFolderSelected: () => ({
      model: modifyFields(model, { isSettingsOpen: () => false }),
      commands: [
        PickLocalDirectory({
          otherBackend: opfsSavedBackend,
          route: AppRoute.Folder({ subPath: [] }),
        }),
      ],
    }),
    PermissionRequired: ({ folderName }) => ({
      model: modifyFields(model, {
        storageState: () =>
          StorageState.PermissionRequired({
            storageType: "fsa",
            folderName,
            otherBackend: opfsSavedBackend,
          }),
        isSettingsOpen: () => false,
      }),
      commands: [PushUrl({ url: buildFolderUrl([]) })],
    }),
    Granted: () => ({
      model: modifyFields(model, { isSettingsOpen: () => false }),
      commands: [
        ActivateFsaBackend({
          otherBackend: opfsSavedBackend,
          route: AppRoute.Folder({ subPath: [] }),
        }),
        PushUrl({ url: buildFolderUrl([]) }),
      ],
    }),
  })
}

const whenReady = (
  model: Model,
  fn: (
    readyState: typeof StorageState.Type & { readonly _tag: "Ready" },
  ) => Update.Return<Model, Message>,
): Update.Return<Model, Message> =>
  model.storageState._tag === "Ready" ? fn(model.storageState) : { model }

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    // Initialization & Storage Backend Lifecycle
    SucceededInitializeStorage: ({
      storageType,
      rootName,
      subPath,
      entries,
      otherBackend,
      maybeModalState,
      maybeAlertBanner,
    }) => {
      const nextModalState = Option.getOrElse(maybeModalState, () =>
        model.modalState._tag === "Help" ? model.modalState : ModalState.Closed(),
      )

      const shouldFocusModal =
        nextModalState._tag === "EditFile" ||
        nextModalState._tag === "EditFolder" ||
        nextModalState._tag === "CreateFile" ||
        nextModalState._tag === "CreateFolder"

      return {
        model: modifyFields(model, {
          storageState: () =>
            StorageState.Ready({
              storageType,
              rootName,
              subPath,
              entriesState: EntriesState.Loaded({ entries }),
              otherBackend,
            }),
          isSettingsOpen: () => false,
          modalState: () => nextModalState,
          maybeAlertBanner: () => maybeAlertBanner,
        }),
        ...(shouldFocusModal && { commands: [FocusModalNameInput()] }),
      }
    },

    DetectedPermissionRequired: ({ storageType, folderName, otherBackend }) => ({
      model: modifyFields(model, {
        storageState: () =>
          StorageState.PermissionRequired({ storageType, folderName, otherBackend }),
        isSettingsOpen: () => false,
      }),
    }),

    DetectedNoFolderSelected: ({ storageType, otherBackend }) => ({
      model: modifyFields(model, {
        storageState: () => StorageState.NoFolderSelected({ storageType, otherBackend }),
        isSettingsOpen: () => false,
        modalState: () =>
          model.modalState._tag === "Help" ? model.modalState : ModalState.Closed(),
        maybeAlertBanner: () => Option.none(),
      }),
    }),

    FailedInitializeStorage: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        storageState: () =>
          StorageState.NoFolderSelected({
            storageType: model.hasDirectoryPicker ? "fsa" : "opfs",
            otherBackend:
              model.hasOPFS && model.hasDirectoryPicker
                ? SavedBackend.Granted({ rootName: OPFS_APP_FOLDER })
                : SavedBackend.Unsupported(),
          }),
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    CompletedLoadFileInfoPreference: ({ visible }) => ({
      model: modifyFields(model, {
        showFileInfo: () => visible,
      }),
    }),

    CompletedSaveFileInfoPreference: () => ({ model }),

    // Directory Listing & Navigation
    SucceededListEntries: ({ subPath, entries }) =>
      whenReady(model, (readyState) => ({
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              subPath: () => subPath,
              entriesState: () => EntriesState.Loaded({ entries }),
            }),
          maybeAlertBanner: () => Option.none(),
        }),
      })),

    FailedListEntries: ({ message: errorMessage }) =>
      whenReady(model, (readyState) => ({
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              entriesState: () => EntriesState.Error({ message: errorMessage }),
            }),
        }),
      })),

    ClickedRetryList: () =>
      whenReady(model, (readyState) => ({
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              entriesState: () => EntriesState.Loading(),
            }),
        }),
        commands: [RefreshEntries({ subPath: readyState.subPath })],
      })),

    ClickedBreadcrumbRoot: () =>
      whenReady(model, () => ({
        model,
        commands: [PushUrl({ url: buildFolderUrl([]) })],
      })),

    ClickedBreadcrumbSegment: ({ index }) =>
      whenReady(model, (readyState) => {
        const targetSubPath = Array.take(readyState.subPath, index + 1)
        return {
          model,
          commands: [PushUrl({ url: buildFolderUrl(targetSubPath) })],
        }
      }),

    ClickedEntryRow: ({ entry }) =>
      whenReady(model, (readyState) => {
        const { subPath } = readyState
        if (entry.kind === "directory") {
          return {
            model,
            commands: [PushUrl({ url: buildFolderUrl([...subPath, entry.name]) })],
          }
        }
        return {
          model,
          commands: [
            OpenFileInBrowser({
              subPath,
              fileName: entry.name,
            }),
          ],
        }
      }),

    CompletedOpenFileInBrowser: () => ({ model }),

    RequestedUrl: ({ request }) =>
      UrlRequest.match(request, {
        Internal: ({ url }) => ({
          model,
          commands: [PushUrl({ url: urlToString(url) })],
        }),
        External: ({ href }) => ({
          model,
          commands: [LoadUrl({ url: href })],
        }),
      }),

    ChangedUrl: ({ url }) => {
      const route = parseUrlToRoute(url)
      return AppRoute.match(route, {
        Folder: ({ subPath }) => {
          revokeActivePreviewUrl()
          const nextModalState =
            model.modalState._tag !== "Closed" ? ModalState.Closed() : model.modalState
          if (model.storageState._tag !== "Ready") {
            return {
              model: modifyFields(model, {
                modalState: () => nextModalState,
              }),
            }
          }
          const readyState = model.storageState
          const isSamePath =
            readyState.subPath.length === subPath.length &&
            readyState.subPath.every((seg, idx) => seg === subPath[idx])

          if (isSamePath) {
            return {
              model: modifyFields(model, {
                modalState: () => nextModalState,
              }),
            }
          }
          return {
            model: modifyFields(model, {
              modalState: () => nextModalState,
            }),
            commands: [NavigateToSubfolder({ targetSubPath: subPath })],
          }
        },

        New: ({ subPath, target }) => {
          revokeActivePreviewUrl()
          const isAlreadyNew =
            (target === "folder" && model.modalState._tag === "CreateFolder") ||
            (target === "file" && model.modalState._tag === "CreateFile")

          const targetModalState =
            target === "folder"
              ? ModalState.CreateFolder({
                  name: "Neuer Ordner",
                  maybeValidationError: Option.none(),
                })
              : ModalState.CreateFile({
                  name: "Neu.html",
                  content: "",
                  maybeValidationError: Option.none(),
                })

          if (isAlreadyNew) {
            return { model }
          }

          if (model.storageState._tag !== "Ready") {
            return {
              model: modifyFields(model, {
                isSettingsOpen: () => false,
                modalState: () => targetModalState,
              }),
            }
          }

          const readyState = model.storageState
          const isSamePath =
            readyState.subPath.length === subPath.length &&
            readyState.subPath.every((seg, idx) => seg === subPath[idx])

          if (isSamePath) {
            return {
              model: modifyFields(model, {
                isSettingsOpen: () => false,
                modalState: () => targetModalState,
              }),
              commands: [FocusModalNameInput()],
            }
          }

          return {
            model: modifyFields(model, {
              isSettingsOpen: () => false,
              modalState: () => targetModalState,
            }),
            commands: [NavigateToSubfolder({ targetSubPath: subPath }), FocusModalNameInput()],
          }
        },

        Edit: ({ subPath, name }) => {
          const isAlreadyEditing =
            (model.modalState._tag === "EditFile" && model.modalState.originalName === name) ||
            (model.modalState._tag === "EditFolder" && model.modalState.originalName === name)

          if (isAlreadyEditing) {
            return { model }
          }

          if (model.storageState._tag !== "Ready") {
            return { model }
          }

          const readyState = model.storageState
          const isSamePath =
            readyState.subPath.length === subPath.length &&
            readyState.subPath.every((seg, idx) => seg === subPath[idx])

          const entry = isSamePath
            ? EntriesState.match(readyState.entriesState, {
                Loaded: ({ entries }) =>
                  pipe(
                    entries,
                    Array.findFirst((e) => e.name === name),
                    Option.getOrUndefined,
                  ),
                Loading: () => undefined,
                Error: () => undefined,
              })
            : undefined

          if (entry && entry.kind === "directory") {
            return {
              model: modifyFields(model, {
                isSettingsOpen: () => false,
                modalState: () =>
                  ModalState.EditFolder({
                    originalName: name,
                    name,
                    maybeValidationError: Option.none(),
                  }),
              }),
              commands: [FocusModalNameInput()],
            }
          }

          return {
            model: modifyFields(model, {
              isSettingsOpen: () => false,
            }),
            commands: [InspectFileForEditor({ entryName: name, subPath })],
          }
        },

        Help: ({ maybeTopic }) => {
          revokeActivePreviewUrl()
          const maybeExistingHelp =
            model.modalState._tag === "Help" ? Option.some(model.modalState) : Option.none()

          return {
            model: modifyFields(model, {
              isSettingsOpen: () => false,
              modalState: () =>
                ModalState.Help({
                  isApiOpen: Option.match(maybeTopic, {
                    onNone: () =>
                      Option.match(maybeExistingHelp, {
                        onNone: () => true,
                        onSome: (existing) => existing.isApiOpen,
                      }),
                    onSome: (topic) => topic === "api",
                  }),
                  isFsOpen: Option.match(maybeTopic, {
                    onNone: () =>
                      Option.match(maybeExistingHelp, {
                        onNone: () => false,
                        onSome: (existing) => existing.isFsOpen,
                      }),
                    onSome: (topic) => topic === "fs",
                  }),
                  copyDtsState: Option.match(maybeExistingHelp, {
                    onNone: () => CopyDtsState.Idle(),
                    onSome: (existing) => existing.copyDtsState,
                  }),
                }),
            }),
          }
        },
      })
    },

    CompletedPushUrl: () => ({ model }),
    CompletedReplaceUrl: () => ({ model }),
    CompletedLoadUrl: () => ({ model }),
    CompletedFocusModalNameInput: () => ({ model }),

    // Settings & Storage Actions
    ClickedToggleSettings: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => !model.isSettingsOpen,
      }),
    }),

    ClickedOutsideSettingsMenu: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
    }),

    ClickedToggleFileInfo: () => {
      const nextShowFileInfo = !model.showFileInfo
      return {
        model: modifyFields(model, {
          showFileInfo: () => nextShowFileInfo,
          isSettingsOpen: () => false,
        }),
        commands: [SaveFileInfoPreference({ visible: nextShowFileInfo })],
      }
    },

    ClickedSelectFolder: () => {
      if (model.storageState._tag === "Ready" && model.storageState.storageType === "opfs") {
        return handleUseFsa(model)
      }
      const otherBackend = getOtherBackend(model.storageState)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          PickLocalDirectory({
            otherBackend,
            route: AppRoute.Folder({ subPath: [] }),
          }),
        ],
      }
    },

    ClickedChangeFolder: () => {
      const otherBackend = getOtherBackend(model.storageState)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          PickLocalDirectory({
            otherBackend,
            route: AppRoute.Folder({ subPath: [] }),
          }),
        ],
      }
    },

    ClickedGrantPermission: () => {
      const otherBackend = getOtherBackend(model.storageState)
      return {
        model,
        commands: [
          GrantDirectoryPermission({
            otherBackend,
            route: AppRoute.Folder({ subPath: [] }),
          }),
        ],
      }
    },

    ClickedUseOpfs: () => {
      const savedFsa = StorageState.match(model.storageState, {
        Initializing: () => SavedBackend.NoFolderSelected(),
        Unsupported: () => SavedBackend.Unsupported(),
        NoFolderSelected: () => SavedBackend.NoFolderSelected(),
        PermissionRequired: ({ folderName }) => SavedBackend.PermissionRequired({ folderName }),
        Ready: (ready) =>
          ready.storageType === "fsa"
            ? SavedBackend.Granted({ rootName: ready.rootName })
            : ready.otherBackend,
      })

      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          ActivateOpfsBackend({
            otherBackend: savedFsa,
            route: AppRoute.Folder({ subPath: [] }),
          }),
          PushUrl({ url: buildFolderUrl([]) }),
        ],
      }
    },

    ClickedUseFsa: () => handleUseFsa(model),

    ClickedDisconnectFolder: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [
        DisconnectStorage({
          hasDirectoryPicker: model.hasDirectoryPicker,
          hasOPFS: model.hasOPFS,
          route: AppRoute.Folder({ subPath: [] }),
        }),
        PushUrl({ url: buildFolderUrl([]) }),
      ],
    }),

    CancelledFolderSelection: () => ({ model }),

    FailedPickLocalDirectory: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    FailedGrantDirectoryPermission: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "warning",
          }),
      }),
    }),

    FailedActivateOpfsBackend: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    FailedDisconnectStorage: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    FailedNavigateToSubfolder: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    // Toolbar & File/Folder Creation
    ClickedNewFile: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      revokeActivePreviewUrl()
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: () =>
            ModalState.CreateFile({
              name: "Neu.html",
              content: "",
              maybeValidationError: Option.none(),
            }),
        }),
        commands: [PushUrl({ url: buildNewUrl(subPath, "file") }), FocusModalNameInput()],
      }
    },

    ClickedNewFolder: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      revokeActivePreviewUrl()
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: () =>
            ModalState.CreateFolder({
              name: "Neuer Ordner",
              maybeValidationError: Option.none(),
            }),
        }),
        commands: [PushUrl({ url: buildNewUrl(subPath, "folder") }), FocusModalNameInput()],
      }
    },

    ClickedImportFiles: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [SelectImportFiles()],
    }),

    SelectedImportFiles: ({ files }) => {
      if (Array.isReadonlyArrayEmpty(files)) {
        return { model }
      }

      const existingEntries = StorageState.match(model.storageState, {
        Ready: ({ entriesState }) =>
          EntriesState.match(entriesState, {
            Loaded: ({ entries }) => entries,
            Loading: () => [],
            Error: () => [],
          }),
        Initializing: () => [],
        Unsupported: () => [],
        NoFolderSelected: () => [],
        PermissionRequired: () => [],
      })

      const existingByName = new Map<string, FileEntry>(existingEntries.map((e) => [e.name, e]))
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
            if (!rawName) return acc

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

      const subPath = currentSubPathFromStorageState(model.storageState)

      if (Array.isReadonlyArrayEmpty(collisions)) {
        return {
          model,
          commands: [WritePendingImportFiles({ items: resolved, subPath })],
        }
      }

      const [firstCollision, ...remainingCollisions] = collisions
      const suggestedName = findFreeFileName(firstCollision.name, reservedNames)

      return {
        model: modifyFields(model, {
          modalState: () =>
            ModalState.ImportConflict({
              current: firstCollision,
              suggestedName,
              queue: remainingCollisions,
              resolved,
              applyToAll: false,
            }),
        }),
      }
    },

    ToggledImportConflictApplyToAll: ({ applyToAll }) => {
      if (model.modalState._tag !== "ImportConflict") {
        return { model }
      }
      const conflictState = model.modalState
      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(conflictState, {
              applyToAll: () => applyToAll,
            }),
        }),
      }
    },

    SelectedImportConflictAction: ({ action }) => {
      if (model.modalState._tag !== "ImportConflict") {
        return { model }
      }
      const conflictState = model.modalState
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

      const existingEntries = StorageState.match(model.storageState, {
        Ready: ({ entriesState }) =>
          EntriesState.match(entriesState, {
            Loaded: ({ entries }) => entries,
            Loading: () => [],
            Error: () => [],
          }),
        Initializing: () => [],
        Unsupported: () => [],
        NoFolderSelected: () => [],
        PermissionRequired: () => [],
      })
      const reservedNames = new Set<string>([
        ...existingEntries.map((e) => e.name),
        ...updatedResolved.map((r) => r.targetName),
      ])

      const subPath = currentSubPathFromStorageState(model.storageState)

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
          model: modifyFields(model, {
            modalState: () => ModalState.Closed(),
          }),
          commands: [WritePendingImportFiles({ items: batchResolved, subPath })],
        }
      }

      if (Array.isReadonlyArrayEmpty(queue)) {
        return {
          model: modifyFields(model, {
            modalState: () => ModalState.Closed(),
          }),
          commands: [WritePendingImportFiles({ items: updatedResolved, subPath })],
        }
      }

      const [nextCurrent, ...nextQueue] = queue
      const nextSuggested = findFreeFileName(nextCurrent.name, reservedNames)

      return {
        model: modifyFields(model, {
          modalState: () =>
            ModalState.ImportConflict({
              current: nextCurrent,
              suggestedName: nextSuggested,
              queue: nextQueue,
              resolved: updatedResolved,
              applyToAll: false,
            }),
        }),
      }
    },

    CancelledImportConflict: () => ({
      model: modifyFields(model, {
        modalState: () => ModalState.Closed(),
      }),
    }),

    CompletedImportFiles: ({ entries, maybeAlertBanner }) => {
      if (model.storageState._tag !== "Ready") {
        return {
          model: modifyFields(model, {
            maybeAlertBanner: () => Option.orElse(maybeAlertBanner, () => model.maybeAlertBanner),
          }),
        }
      }
      const readyState = model.storageState
      const nextEntries = Array.isReadonlyArrayEmpty(entries)
        ? EntriesState.match(readyState.entriesState, {
            Loading: () => entries,
            Loaded: ({ entries: existing }) => existing,
            Error: () => entries,
          })
        : entries

      return {
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              entriesState: () => EntriesState.Loaded({ entries: nextEntries }),
            }),
          maybeAlertBanner: () => Option.orElse(maybeAlertBanner, () => model.maybeAlertBanner),
        }),
      }
    },

    // Editor Modal
    ClickedEditEntry: ({ entry }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      revokeActivePreviewUrl()
      if (entry.kind === "directory") {
        return {
          model: modifyFields(model, {
            isSettingsOpen: () => false,
            modalState: () =>
              ModalState.EditFolder({
                originalName: entry.name,
                name: entry.name,
                maybeValidationError: Option.none(),
              }),
          }),
          commands: [PushUrl({ url: buildEditUrl(subPath, entry.name) }), FocusModalNameInput()],
        }
      }

      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          PushUrl({ url: buildEditUrl(subPath, entry.name) }),
          InspectFileForEditor({
            entryName: entry.name,
            subPath,
          }),
        ],
      }
    },

    SucceededInspectFileForEditor: ({ originalName, fileMode }) => ({
      model: modifyFields(model, {
        modalState: () =>
          ModalState.EditFile({
            originalName,
            name: originalName,
            fileMode,
            maybeValidationError: Option.none(),
          }),
      }),
      commands: [FocusModalNameInput()],
    }),

    FailedInspectFileForEditor: ({ message: errorMessage }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          maybeAlertBanner: () =>
            Option.some({
              message: errorMessage,
              variant: "danger",
            }),
        }),
        commands: [ReplaceUrl({ url: buildFolderUrl(subPath) })],
      }
    },

    UpdatedModalName: ({ name }) => ({
      model: modifyFields(model, {
        modalState: () =>
          ModalState.match(model.modalState, {
            Closed: () => model.modalState,
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
            ConfirmDelete: () => model.modalState,
            ConfirmOverwrite: () => model.modalState,
            ImportConflict: () => model.modalState,
            Help: () => model.modalState,
          }),
      }),
    }),

    UpdatedModalTextContent: ({ content }) => ({
      model: modifyFields(model, {
        modalState: () =>
          ModalState.match(model.modalState, {
            Closed: () => model.modalState,
            CreateFile: (state) =>
              modifyFields(state, {
                content: () => content,
              }),
            CreateFolder: () => model.modalState,
            EditFolder: () => model.modalState,
            EditFile: (state) =>
              state.fileMode._tag === "Text"
                ? modifyFields(state, {
                    fileMode: () => EditorFileMode.Text({ content }),
                  })
                : state,
            ConfirmDelete: () => model.modalState,
            ConfirmOverwrite: () => model.modalState,
            ImportConflict: () => model.modalState,
            Help: () => model.modalState,
          }),
      }),
    }),

    ToggledModalBase64: ({ isChecked }) => {
      if (model.modalState._tag !== "EditFile") {
        return { model }
      }
      const editState = model.modalState
      if (editState.fileMode._tag !== "Binary") {
        return { model }
      }
      const binaryMode = editState.fileMode

      if (binaryMode.edit._tag === "Locked") {
        return { model }
      }

      if (!isChecked) {
        return {
          model: modifyFields(model, {
            modalState: () =>
              modifyFields(editState, {
                fileMode: () =>
                  modifyFields(binaryMode, {
                    edit: () => BinaryEdit.Disabled(),
                  }),
              }),
          }),
        }
      }

      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  edit: () => BinaryEdit.Loading(),
                }),
            }),
        }),
        commands: [LoadModalBase64({ entryName: editState.originalName, subPath })],
      }
    },

    SucceededLoadModalBase64: ({ base64Content }) => {
      if (model.modalState._tag !== "EditFile") {
        return { model }
      }
      const editState = model.modalState
      if (editState.fileMode._tag !== "Binary") {
        return { model }
      }
      const binaryMode = editState.fileMode

      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  edit: () => BinaryEdit.Editing({ content: base64Content }),
                }),
            }),
        }),
      }
    },

    FailedLoadModalBase64: ({ message: errorMessage }) => {
      if (model.modalState._tag !== "EditFile") {
        return { model }
      }
      const editState = model.modalState
      if (editState.fileMode._tag !== "Binary") {
        return { model }
      }
      const binaryMode = editState.fileMode

      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  edit: () => BinaryEdit.Disabled(),
                }),
            }),
          maybeAlertBanner: () =>
            Option.some({
              message: errorMessage,
              variant: "danger",
            }),
        }),
      }
    },

    UpdatedModalBase64Content: ({ base64Content }) => {
      if (model.modalState._tag !== "EditFile") {
        return { model }
      }
      const editState = model.modalState
      if (editState.fileMode._tag !== "Binary") {
        return { model }
      }
      const binaryMode = editState.fileMode
      if (binaryMode.edit._tag !== "Editing") {
        return { model }
      }

      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  edit: () => BinaryEdit.Editing({ content: base64Content }),
                }),
            }),
        }),
      }
    },

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

      const existingEntries = StorageState.match(model.storageState, {
        Ready: ({ entriesState }) =>
          EntriesState.match(entriesState, {
            Loaded: ({ entries }) => entries,
            Loading: () => [],
            Error: () => [],
          }),
        Initializing: () => [],
        Unsupported: () => [],
        NoFolderSelected: () => [],
        PermissionRequired: () => [],
      })
      const existingNames = new Set(existingEntries.map((e) => e.name))
      const subPath = currentSubPathFromStorageState(model.storageState)

      if (model.modalState._tag === "CreateFolder") {
        const createFolder = model.modalState
        const error = validateName(createFolder.name, true)
        if (Option.isSome(error)) {
          return {
            model: modifyFields(model, {
              modalState: () =>
                modifyFields(createFolder, {
                  maybeValidationError: () => error,
                }),
            }),
          }
        }
        const trimmed = createFolder.name.trim()
        if (existingNames.has(trimmed)) {
          return {
            model: modifyFields(model, {
              modalState: () =>
                modifyFields(createFolder, {
                  maybeValidationError: () =>
                    Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
                }),
            }),
          }
        }
        return {
          model,
          commands: [SaveModalChanges({ modalState: createFolder, subPath })],
        }
      }

      if (model.modalState._tag === "EditFolder") {
        const editFolder = model.modalState
        const error = validateName(editFolder.name, true)
        if (Option.isSome(error)) {
          return {
            model: modifyFields(model, {
              modalState: () =>
                modifyFields(editFolder, {
                  maybeValidationError: () => error,
                }),
            }),
          }
        }
        const trimmed = editFolder.name.trim()
        if (trimmed !== editFolder.originalName && existingNames.has(trimmed)) {
          return {
            model: modifyFields(model, {
              modalState: () =>
                modifyFields(editFolder, {
                  maybeValidationError: () =>
                    Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
                }),
            }),
          }
        }
        return {
          model,
          commands: [SaveModalChanges({ modalState: editFolder, subPath })],
        }
      }

      if (model.modalState._tag === "CreateFile") {
        const createFile = model.modalState
        const error = validateName(createFile.name, false)
        if (Option.isSome(error)) {
          return {
            model: modifyFields(model, {
              modalState: () =>
                modifyFields(createFile, {
                  maybeValidationError: () => error,
                }),
            }),
          }
        }
        const trimmed = createFile.name.trim()
        if (existingNames.has(trimmed)) {
          return {
            model: modifyFields(model, {
              modalState: () =>
                ModalState.ConfirmOverwrite({
                  targetName: trimmed,
                  originalName: trimmed,
                  content: createFile.content,
                  isBase64: false,
                  isEditing: false,
                }),
            }),
          }
        }
        return {
          model,
          commands: [SaveModalChanges({ modalState: createFile, subPath })],
        }
      }

      if (model.modalState._tag === "EditFile") {
        const editFile = model.modalState
        const error = validateName(editFile.name, false)
        if (Option.isSome(error)) {
          return {
            model: modifyFields(model, {
              modalState: () =>
                modifyFields(editFile, {
                  maybeValidationError: () => error,
                }),
            }),
          }
        }

        const trimmed = editFile.name.trim()

        if (editFile.fileMode._tag === "Binary" && editFile.fileMode.edit._tag === "Editing") {
          try {
            base64ToUint8Array(editFile.fileMode.edit.content)
          } catch {
            return {
              model: modifyFields(model, {
                modalState: () =>
                  modifyFields(editFile, {
                    maybeValidationError: () =>
                      Option.some("Ungültige Base64-Kodierung. Bitte überprüfen Sie die Eingabe."),
                  }),
              }),
            }
          }
        }

        if (trimmed !== editFile.originalName && existingNames.has(trimmed)) {
          if (editFile.fileMode._tag === "Text") {
            const textMode = editFile.fileMode
            return {
              model: modifyFields(model, {
                modalState: () =>
                  ModalState.ConfirmOverwrite({
                    targetName: trimmed,
                    originalName: editFile.originalName,
                    content: textMode.content,
                    isBase64: false,
                    isEditing: true,
                  }),
              }),
            }
          }
          if (editFile.fileMode._tag === "Binary" && editFile.fileMode.edit._tag === "Editing") {
            const editing = editFile.fileMode.edit
            return {
              model: modifyFields(model, {
                modalState: () =>
                  ModalState.ConfirmOverwrite({
                    targetName: trimmed,
                    originalName: editFile.originalName,
                    content: editing.content,
                    isBase64: true,
                    isEditing: true,
                  }),
              }),
            }
          }
          return {
            model: modifyFields(model, {
              modalState: () =>
                modifyFields(editFile, {
                  maybeValidationError: () =>
                    Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
                }),
            }),
          }
        }

        return {
          model,
          commands: [SaveModalChanges({ modalState: editFile, subPath })],
        }
      }

      return {
        model,
        commands: [SaveModalChanges({ modalState: model.modalState, subPath })],
      }
    },

    ClickedConfirmOverwrite: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model,
        commands: [SaveModalChanges({ modalState: model.modalState, subPath })],
      }
    },

    ClickedCancelOverwrite: () => {
      if (model.modalState._tag !== "ConfirmOverwrite") {
        return { model }
      }
      const { targetName, originalName, content, isBase64, isEditing } = model.modalState
      if (!isEditing) {
        return {
          model: modifyFields(model, {
            modalState: () =>
              ModalState.CreateFile({
                name: targetName,
                content,
                maybeValidationError: Option.none(),
              }),
          }),
        }
      }
      return {
        model: modifyFields(model, {
          modalState: () =>
            ModalState.EditFile({
              originalName,
              name: targetName,
              fileMode: isBase64
                ? EditorFileMode.Binary({
                    preview: PreviewContent.None(),
                    edit: BinaryEdit.Editing({ content }),
                  })
                : EditorFileMode.Text({ content }),
              maybeValidationError: Option.none(),
            }),
        }),
      }
    },

    ClickedDeleteModalEntry: () => {
      if (model.modalState._tag === "EditFolder") {
        const folderState = model.modalState
        return {
          model: modifyFields(model, {
            modalState: () =>
              ModalState.ConfirmDelete({
                entryName: folderState.originalName,
                isFolder: true,
              }),
          }),
        }
      }
      if (model.modalState._tag === "EditFile") {
        const fileState = model.modalState
        return {
          model: modifyFields(model, {
            modalState: () =>
              ModalState.ConfirmDelete({
                entryName: fileState.originalName,
                isFolder: false,
              }),
          }),
        }
      }
      return { model }
    },

    ConfirmedDeleteModalEntry: () => {
      if (model.modalState._tag !== "ConfirmDelete") {
        return { model }
      }
      const { entryName, isFolder } = model.modalState
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          modalState: () => ModalState.Closed(),
        }),
        commands: [DeleteModalEntry({ entryName, isFolder, subPath })],
      }
    },

    ClickedCancelDeleteModal: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      revokeActivePreviewUrl()
      return {
        model: modifyFields(model, {
          modalState: () => ModalState.Closed(),
        }),
        commands: [ReplaceUrl({ url: buildFolderUrl(subPath) })],
      }
    },

    ClickedCloseModal: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      revokeActivePreviewUrl()
      return {
        model: modifyFields(model, {
          modalState: () => ModalState.Closed(),
        }),
        commands: [ReplaceUrl({ url: buildFolderUrl(subPath) })],
      }
    },

    PressedEscape: () => {
      if (model.modalState._tag !== "Closed") {
        const subPath = currentSubPathFromStorageState(model.storageState)
        revokeActivePreviewUrl()
        return {
          model: modifyFields(model, {
            isSettingsOpen: () => false,
            modalState: () => ModalState.Closed(),
          }),
          commands: [ReplaceUrl({ url: buildFolderUrl(subPath) })],
        }
      }
      if (model.isSettingsOpen) {
        return {
          model: modifyFields(model, {
            isSettingsOpen: () => false,
          }),
        }
      }
      return { model }
    },

    SucceededModalMutation: ({ entries }) => {
      if (model.storageState._tag !== "Ready") {
        return {
          model: modifyFields(model, {
            modalState: () => ModalState.Closed(),
          }),
        }
      }
      const readyState = model.storageState
      return {
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              entriesState: () => EntriesState.Loaded({ entries }),
            }),
          modalState: () => ModalState.Closed(),
        }),
        commands: [ReplaceUrl({ url: buildFolderUrl(readyState.subPath) })],
      }
    },

    CancelledModalMutation: () => ({ model }),

    FailedModalMutation: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    // Help Modal
    ClickedOpenHelp: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      revokeActivePreviewUrl()
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: () =>
            ModalState.Help({
              isApiOpen: true,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Idle(),
            }),
        }),
        commands: [PushUrl({ url: buildHelpUrl(subPath, Option.some("api")) })],
      }
    },

    ToggledHelpTopic: ({ topic, isOpen }) => {
      if (model.modalState._tag !== "Help") {
        return { model }
      }
      const helpState = model.modalState
      const nextIsApiOpen = topic === "api" ? isOpen : isOpen ? false : helpState.isApiOpen
      const nextIsFsOpen = topic === "fs" ? isOpen : isOpen ? false : helpState.isFsOpen

      if (nextIsApiOpen === helpState.isApiOpen && nextIsFsOpen === helpState.isFsOpen) {
        return { model }
      }

      const subPath = currentSubPathFromStorageState(model.storageState)
      const maybeActiveTopic =
        nextIsApiOpen && !nextIsFsOpen
          ? Option.some<HelpTopic>("api")
          : nextIsFsOpen && !nextIsApiOpen
            ? Option.some<HelpTopic>("fs")
            : Option.none()

      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(helpState, {
              isApiOpen: () => nextIsApiOpen,
              isFsOpen: () => nextIsFsOpen,
            }),
        }),
        commands: [ReplaceUrl({ url: buildHelpUrl(subPath, maybeActiveTopic) })],
      }
    },

    ClickedCopyDts: () => {
      if (model.modalState._tag !== "Help") {
        return { model }
      }
      const helpState = model.modalState
      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(helpState, {
              copyDtsState: () => CopyDtsState.Copying(),
            }),
        }),
        commands: [CopyApiDtsToClipboard()],
      }
    },

    SucceededCopyDts: () => {
      if (model.modalState._tag !== "Help") {
        return { model }
      }
      const helpState = model.modalState
      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(helpState, {
              copyDtsState: () => CopyDtsState.Copied(),
            }),
        }),
        commands: [WaitBeforeResetCopyDts()],
      }
    },

    CompletedWaitBeforeResetCopyDts: () => {
      if (model.modalState._tag !== "Help") {
        return { model }
      }
      const helpState = model.modalState
      if (helpState.copyDtsState._tag !== "Copied") {
        return { model }
      }
      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(helpState, {
              copyDtsState: () => CopyDtsState.Idle(),
            }),
        }),
      }
    },

    FailedCopyDts: ({ message: errorMessage }) => {
      if (model.modalState._tag !== "Help") {
        return { model }
      }
      const helpState = model.modalState
      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(helpState, {
              copyDtsState: () => CopyDtsState.Error({ message: errorMessage }),
            }),
        }),
      }
    },

    // PWA Install & Service Worker Toast
    CapturedInstallPrompt: () => ({
      model: modifyFields(model, {
        installPrompt: () => InstallPrompt.Available(),
      }),
    }),

    InstalledApp: () => ({
      model: modifyFields(model, {
        installPrompt: () => InstallPrompt.Unavailable(),
      }),
    }),

    ClickedInstallApp: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
        installPrompt: () => InstallPrompt.Prompting(),
      }),
      commands: [TriggerInstallAppPrompt()],
    }),

    CompletedTriggerInstallAppPrompt: ({ didAccept }) => ({
      model: modifyFields(model, {
        installPrompt: () => (didAccept ? InstallPrompt.Unavailable() : InstallPrompt.Available()),
      }),
    }),
  })

export { Flags, Message, Model, subscriptions, view }
