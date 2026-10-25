import { Array, Match, Option, pipe } from "effect"
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
  ScrollHelpTopicIntoView,
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
  OverwriteSource,
  type PendingImportFile,
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
          maybeOpenTopic: Option.orElse(maybeTopic, () => Option.some<HelpTopic>("api")),
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
        modalState: Option.match(maybeInitialModal, {
          onNone: () => ModalState.Closed(),
          onSome: (modalState) => modalState,
        }),
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
      modalState: Option.match(maybeInitialModal, {
        onNone: () => ModalState.Closed(),
        onSome: (modalState) => modalState,
      }),
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

const isSameSubPath = Array.makeEquivalence<string>((a, b) => a === b)

type ReadyStorageState = Extract<StorageState, { readonly _tag: "Ready" }>

const isReady = (storageState: StorageState): storageState is ReadyStorageState =>
  Match.value(storageState).pipe(
    Match.tag("Ready", () => true),
    Match.orElse(() => false),
  )

const isModal =
  <Tag extends ModalState["_tag"]>(tag: Tag) =>
  (modalState: ModalState): modalState is Extract<ModalState, { readonly _tag: Tag }> =>
    Match.value(modalState).pipe(
      Match.tag(tag, () => true),
      Match.orElse(() => false),
    )

const whenReady = (
  model: Model,
  fn: (readyState: ReadyStorageState) => Update.Return<Model, Message>,
): Update.Return<Model, Message> =>
  isReady(model.storageState) ? fn(model.storageState) : { model }

const handleEntriesListed = (
  model: Model,
  { subPath, entries }: Omit<typeof Message.SucceededRefreshEntries.Type, "_tag">,
): Update.Return<Model, Message> =>
  whenReady(model, (readyState) => ({
    model: modifyFields(model, {
      storageState: () =>
        modifyFields(readyState, {
          subPath: () => subPath,
          entriesState: () => EntriesState.Loaded({ entries }),
        }),
      maybeAlertBanner: () => Option.none(),
    }),
  }))

const handleStorageActivated = (
  model: Model,
  {
    storageType,
    rootName,
    subPath,
    entries,
    otherBackend,
    maybeModalState,
    maybeAlertBanner,
  }: Omit<typeof Message.SucceededInitializeStorage.Type, "_tag">,
): Update.Return<Model, Message> => {
  const nextModalState = Option.match(maybeModalState, {
    onNone: () => (isModal("Help")(model.modalState) ? model.modalState : ModalState.Closed()),
    onSome: (modalState) => modalState,
  })

  const shouldFocusModal = ModalState.match(nextModalState, {
    Closed: () => false,
    CreateFile: () => true,
    CreateFolder: () => true,
    EditFolder: () => true,
    EditFile: () => true,
    ConfirmDelete: () => false,
    ConfirmOverwrite: () => false,
    ImportConflict: () => false,
    Help: () => false,
  })

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
}

const handlePermissionRequired = (
  model: Model,
  {
    storageType,
    folderName,
    otherBackend,
  }: Omit<typeof Message.CompletedInitializeStoragePermissionRequired.Type, "_tag">,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    storageState: () => StorageState.PermissionRequired({ storageType, folderName, otherBackend }),
    isSettingsOpen: () => false,
  }),
})

const handleNoFolderSelected = (
  model: Model,
  {
    storageType,
    otherBackend,
  }: Omit<typeof Message.CompletedInitializeStorageNoFolderSelected.Type, "_tag">,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    storageState: () => StorageState.NoFolderSelected({ storageType, otherBackend }),
    isSettingsOpen: () => false,
    modalState: () => (isModal("Help")(model.modalState) ? model.modalState : ModalState.Closed()),
    maybeAlertBanner: () => Option.none(),
  }),
})

type HelpModalState = Extract<ModalState, { readonly _tag: "Help" }>
type EditFileModalState = Extract<ModalState, { readonly _tag: "EditFile" }>
type BinaryFileMode = Extract<EditFileModalState["fileMode"], { readonly _tag: "Binary" }>

const whenHelp = (
  model: Model,
  fn: (helpState: HelpModalState) => Update.Return<Model, Message>,
): Update.Return<Model, Message> =>
  Match.value(model.modalState).pipe(
    Match.tag("Help", fn),
    Match.orElse(() => ({ model })),
  )

const whenBinaryEditor = (
  model: Model,
  fn: (editState: EditFileModalState, binaryMode: BinaryFileMode) => Update.Return<Model, Message>,
): Update.Return<Model, Message> =>
  Match.value(model.modalState).pipe(
    Match.tag("EditFile", (editState) =>
      Match.value(editState.fileMode).pipe(
        Match.tag("Binary", (binaryMode) => fn(editState, binaryMode)),
        Match.orElse(() => ({ model })),
      ),
    ),
    Match.orElse(() => ({ model })),
  )

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    // Initialization & Storage Backend Lifecycle
    SucceededInitializeStorage: (payload) => handleStorageActivated(model, payload),
    CompletedInitializeStoragePermissionRequired: (payload) =>
      handlePermissionRequired(model, payload),
    CompletedInitializeStorageNoFolderSelected: (payload) => handleNoFolderSelected(model, payload),
    SucceededPickLocalDirectory: (payload) => handleStorageActivated(model, payload),
    SucceededGrantDirectoryPermission: (payload) => handleStorageActivated(model, payload),
    CompletedGrantDirectoryPermissionNoFolderSelected: (payload) =>
      handleNoFolderSelected(model, payload),
    SucceededActivateOpfsBackend: (payload) => handleStorageActivated(model, payload),
    SucceededActivateFsaBackend: (payload) => handleStorageActivated(model, payload),
    CompletedActivateFsaBackendPermissionRequired: (payload) =>
      handlePermissionRequired(model, payload),
    CompletedActivateFsaBackendNoFolderSelected: (payload) =>
      handleNoFolderSelected(model, payload),
    SucceededDisconnectStorage: (payload) => handleNoFolderSelected(model, payload),

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
    SucceededRefreshEntries: (payload) => handleEntriesListed(model, payload),
    SucceededNavigateToSubfolder: (payload) => handleEntriesListed(model, payload),

    FailedRefreshEntries: ({ message: errorMessage }) =>
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
          const nextModalState = !isModal("Closed")(model.modalState)
            ? ModalState.Closed()
            : model.modalState
          if (!isReady(model.storageState)) {
            return {
              model: modifyFields(model, {
                modalState: () => nextModalState,
              }),
            }
          }
          const readyState = model.storageState
          const isSamePath = isSameSubPath(readyState.subPath, subPath)

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
            (target === "folder" && isModal("CreateFolder")(model.modalState)) ||
            (target === "file" && isModal("CreateFile")(model.modalState))

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

          if (!isReady(model.storageState)) {
            return {
              model: modifyFields(model, {
                isSettingsOpen: () => false,
                modalState: () => targetModalState,
              }),
            }
          }

          const readyState = model.storageState
          const isSamePath = isSameSubPath(readyState.subPath, subPath)

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
            (isModal("EditFile")(model.modalState) && model.modalState.originalName === name) ||
            (isModal("EditFolder")(model.modalState) && model.modalState.originalName === name)

          if (isAlreadyEditing) {
            return { model }
          }

          if (!isReady(model.storageState)) {
            return { model }
          }

          const readyState = model.storageState
          const isSamePath = isSameSubPath(readyState.subPath, subPath)

          const maybeEntry = isSamePath
            ? EntriesState.match(readyState.entriesState, {
                Loaded: ({ entries }) => Array.findFirst(entries, (e) => e.name === name),
                Loading: () => Option.none(),
                Error: () => Option.none(),
              })
            : Option.none()

          if (Option.exists(maybeEntry, (entry) => entry.kind === "directory")) {
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
          const maybeExistingHelp = isModal("Help")(model.modalState)
            ? Option.some(model.modalState)
            : Option.none()

          return {
            model: modifyFields(model, {
              isSettingsOpen: () => false,
              modalState: () =>
                ModalState.Help({
                  maybeOpenTopic: Option.match(maybeTopic, {
                    onNone: () =>
                      Option.match(maybeExistingHelp, {
                        onNone: () => Option.some<HelpTopic>("api"),
                        onSome: (existing) => existing.maybeOpenTopic,
                      }),
                    onSome: (topic) => Option.some(topic),
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
    CompletedScrollHelpTopicIntoView: () => ({ model }),

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
      if (isReady(model.storageState) && model.storageState.storageType === "opfs") {
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

    CancelledPickLocalDirectory: () => ({ model }),

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

    FailedActivateFsaBackend: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
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

    CompletedSelectImportFiles: ({ files }) => {
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
      if (!isModal("ImportConflict")(model.modalState)) {
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
      if (!isModal("ImportConflict")(model.modalState)) {
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

    CompletedWritePendingImportFiles: ({ entries, maybeAlertBanner }) => {
      if (!isReady(model.storageState)) {
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
              EditorFileMode.match(state.fileMode, {
                Text: () =>
                  modifyFields(state, {
                    fileMode: () => EditorFileMode.Text({ content }),
                  }),
                Binary: () => state,
              }),
            ConfirmDelete: () => model.modalState,
            ConfirmOverwrite: () => model.modalState,
            ImportConflict: () => model.modalState,
            Help: () => model.modalState,
          }),
      }),
    }),

    ToggledModalBase64: ({ isChecked }) => {
      return whenBinaryEditor(model, (editState, binaryMode) => {
        const isLocked = BinaryEdit.match(binaryMode.edit, {
          Locked: () => true,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => false,
        })
        if (isLocked) {
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
      })
    },

    SucceededLoadModalBase64: ({ base64Content }) => {
      return whenBinaryEditor(model, (editState, binaryMode) => {
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
      })
    },

    FailedLoadModalBase64: ({ message: errorMessage }) => {
      return whenBinaryEditor(model, (editState, binaryMode) => {
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
      })
    },

    UpdatedModalBase64Content: ({ base64Content }) => {
      return whenBinaryEditor(model, (editState, binaryMode) => {
        const isEditing = BinaryEdit.match(binaryMode.edit, {
          Locked: () => false,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => true,
        })
        if (!isEditing) {
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
      })
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

      return Match.value(model.modalState).pipe(
        Match.tag("CreateFolder", (createFolder) => {
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
        }),
        Match.tag("EditFolder", (editFolder) => {
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
        }),
        Match.tag("CreateFile", (createFile) => {
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
                    source: OverwriteSource.CreateFile({
                      content: createFile.content,
                    }),
                  }),
              }),
            }
          }
          return {
            model,
            commands: [SaveModalChanges({ modalState: createFile, subPath })],
          }
        }),
        Match.tag("EditFile", (editFile) => {
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
                model: modifyFields(model, {
                  modalState: () =>
                    modifyFields(editFile, {
                      maybeValidationError: () =>
                        Option.some(
                          "Ungültige Base64-Kodierung. Bitte überprüfen Sie die Eingabe.",
                        ),
                    }),
                }),
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
              model: modifyFields(model, {
                modalState: () =>
                  ModalState.ConfirmOverwrite({
                    targetName: trimmed,
                    source: OverwriteSource.EditFile({
                      originalName: editFile.originalName,
                      fileMode: editFile.fileMode,
                    }),
                  }),
              }),
            }
          }

          return {
            model,
            commands: [SaveModalChanges({ modalState: editFile, subPath })],
          }
        }),
        Match.orElse((modalState) => ({
          model,
          commands: [SaveModalChanges({ modalState, subPath })],
        })),
      )
    },

    ClickedConfirmOverwrite: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model,
        commands: [SaveModalChanges({ modalState: model.modalState, subPath })],
      }
    },

    ClickedCancelOverwrite: () => {
      return Match.value(model.modalState).pipe(
        Match.tag("ConfirmOverwrite", ({ targetName, source }) =>
          Match.value(source).pipe(
            Match.tag("CreateFile", ({ content }) => ({
              model: modifyFields(model, {
                modalState: () =>
                  ModalState.CreateFile({
                    name: targetName,
                    content,
                    maybeValidationError: Option.none(),
                  }),
              }),
            })),
            Match.tag("EditFile", ({ originalName, fileMode }) => ({
              model: modifyFields(model, {
                modalState: () =>
                  ModalState.EditFile({
                    originalName,
                    name: targetName,
                    fileMode,
                    maybeValidationError: Option.none(),
                  }),
              }),
            })),
            Match.exhaustive,
          ),
        ),
        Match.orElse(() => ({ model })),
      )
    },

    ClickedDeleteModalEntry: () =>
      Match.value(model.modalState).pipe(
        Match.tag("EditFolder", ({ originalName }) => ({
          model: modifyFields(model, {
            modalState: () =>
              ModalState.ConfirmDelete({ entryName: originalName, entryKind: "directory" }),
          }),
        })),
        Match.tag("EditFile", ({ originalName }) => ({
          model: modifyFields(model, {
            modalState: () =>
              ModalState.ConfirmDelete({ entryName: originalName, entryKind: "file" }),
          }),
        })),
        Match.orElse(() => ({ model })),
      ),

    ConfirmedDeleteModalEntry: () => {
      return Match.value(model.modalState).pipe(
        Match.tag("ConfirmDelete", ({ entryName, entryKind }) => {
          const subPath = currentSubPathFromStorageState(model.storageState)
          return {
            model: modifyFields(model, {
              modalState: () => ModalState.Closed(),
            }),
            commands: [DeleteModalEntry({ entryName, entryKind, subPath })],
          }
        }),
        Match.orElse(() => ({ model })),
      )
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
      if (!isModal("Closed")(model.modalState)) {
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

    SucceededSaveModalChanges: ({ entries }) => {
      if (!isReady(model.storageState)) {
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

    SucceededDeleteModalEntry: ({ entries }) => {
      if (!isReady(model.storageState)) {
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

    FailedSaveModalChanges: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    FailedDeleteModalEntry: ({ message: errorMessage }) => ({
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
      const isFolderViewVisible = isReady(model.storageState)
      const activeTopic: HelpTopic = isFolderViewVisible ? "api" : "fs"
      revokeActivePreviewUrl()
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: () =>
            ModalState.Help({
              maybeOpenTopic: Option.some(activeTopic),
              copyDtsState: CopyDtsState.Idle(),
            }),
        }),
        commands: [
          PushUrl({
            url: buildHelpUrl(subPath, Option.some(activeTopic)),
          }),
        ],
      }
    },

    ToggledHelpTopic: ({ topic, isOpen }) => {
      return whenHelp(model, (helpState) => {
        const nextMaybeOpenTopic: Option.Option<HelpTopic> = isOpen
          ? Option.some(topic)
          : Option.exists(helpState.maybeOpenTopic, (t) => t === topic)
            ? Option.none()
            : helpState.maybeOpenTopic

        const isUnchanged = Option.match(helpState.maybeOpenTopic, {
          onNone: () => Option.isNone(nextMaybeOpenTopic),
          onSome: (current) => Option.exists(nextMaybeOpenTopic, (next) => next === current),
        })

        if (isUnchanged) {
          return { model }
        }

        const subPath = currentSubPathFromStorageState(model.storageState)
        const replaceUrlCommand = ReplaceUrl({ url: buildHelpUrl(subPath, nextMaybeOpenTopic) })
        const commands = isOpen
          ? [replaceUrlCommand, ScrollHelpTopicIntoView({ topic })]
          : [replaceUrlCommand]

        return {
          model: modifyFields(model, {
            modalState: () =>
              modifyFields(helpState, {
                maybeOpenTopic: () => nextMaybeOpenTopic,
              }),
          }),
          commands,
        }
      })
    },

    ClickedCopyDts: () => {
      return whenHelp(model, (helpState) => {
        return {
          model: modifyFields(model, {
            modalState: () =>
              modifyFields(helpState, {
                copyDtsState: () => CopyDtsState.Copying(),
              }),
          }),
          commands: [CopyApiDtsToClipboard()],
        }
      })
    },

    SucceededCopyApiDtsToClipboard: () => {
      return whenHelp(model, (helpState) => {
        return {
          model: modifyFields(model, {
            modalState: () =>
              modifyFields(helpState, {
                copyDtsState: () => CopyDtsState.Copied(),
              }),
          }),
          commands: [WaitBeforeResetCopyDts()],
        }
      })
    },

    CompletedWaitBeforeResetCopyDts: () => {
      return whenHelp(model, (helpState) => {
        if (
          !CopyDtsState.match(helpState.copyDtsState, {
            Idle: () => false,
            Copying: () => false,
            Copied: () => true,
            Error: () => false,
          })
        ) {
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
      })
    },

    FailedCopyApiDtsToClipboard: ({ message: errorMessage }) => {
      return whenHelp(model, (helpState) => {
        return {
          model: modifyFields(model, {
            modalState: () =>
              modifyFields(helpState, {
                copyDtsState: () => CopyDtsState.Error({ message: errorMessage }),
              }),
          }),
        }
      })
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
