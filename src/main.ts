import { Array, Option } from "effect"
import { modifyFields } from "foldkit/struct"
import type * as Update from "foldkit/update"
import {
  ActivateOpfsBackend,
  CopyApiDtsToClipboard,
  DelayResetCopyDtsStatus,
  DeleteModalEntry,
  DisconnectStorage,
  FocusModalNameInput,
  GrantDirectoryPermission,
  HandlePopStateNavigation,
  ImportExternalFiles,
  InitializeStorage,
  InspectFileForEditor,
  LoadFileInfoPreference,
  LoadModalBase64,
  NavigateToSubfolder,
  OpenFileInBrowser,
  PickLocalDirectory,
  RefreshEntries,
  SaveFileInfoPreference,
  SaveModalChanges,
  SyncHistoryUrl,
  TriggerInstallAppPrompt,
} from "./command"
import { Message } from "./message"
import {
  CopyDtsState,
  EditorFileMode,
  EntriesState,
  Flags,
  Model,
  ModalState,
  StorageState,
  buildEditUrl,
  buildFolderUrl,
  buildHelpUrl,
  parseHelpParam,
} from "./model"
import { subscriptions } from "./subscription"
import { view } from "./view"

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const currentSubPathFromStorageState = (storageState: StorageState): ReadonlyArray<string> =>
  StorageState.match(storageState, {
    Initializing: () => [],
    Unsupported: () => [],
    NoFolderSelected: () => [],
    PermissionRequired: () => [],
    Ready: ({ subPath }) => subPath,
  })

const initialHelpModalFromSearch = (initialSearch: string): Option.Option<ModalState> => {
  const params = new URLSearchParams(
    initialSearch.startsWith("?") ? initialSearch : `?${initialSearch}`,
  )
  const maybeHelp = parseHelpParam(params.get("pwaislands"))
  return Option.map(maybeHelp, ({ maybeTopic }) =>
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
  )
}

export const init = (flags: Flags): Update.Return<Model, Message> => {
  const isSupported = flags.hasDirectoryPicker || flags.hasOPFS
  const maybeInitialHelpModal = initialHelpModalFromSearch(flags.initialSearch)

  if (!isSupported) {
    return {
      model: {
        hasDirectoryPicker: false,
        hasOPFS: false,
        storageState: StorageState.Unsupported(),
        showFileInfo: true,
        isSettingsOpen: false,
        canInstallApp: false,
        modalState: Option.getOrElse(maybeInitialHelpModal, () => ModalState.Closed()),
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
      storageState: StorageState.Initializing(),
      showFileInfo: true,
      isSettingsOpen: false,
      canInstallApp: false,
      modalState: Option.getOrElse(maybeInitialHelpModal, () => ModalState.Closed()),
      maybeAlertBanner: Option.none(),
    },
    commands: [
      LoadFileInfoPreference(),
      InitializeStorage({
        hasDirectoryPicker: flags.hasDirectoryPicker,
        hasOPFS: flags.hasOPFS,
        initialPathname: flags.initialPathname,
        initialSearch: flags.initialSearch,
      }),
    ],
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    // Initialization & Storage Backend Lifecycle
    CompletedStorageInit: ({
      storageType,
      rootName,
      subPath,
      isFallback,
      entries,
      maybeModalState,
      maybeAlertBanner,
    }) => {
      if (Option.isNone(storageType)) {
        return {
          model: modifyFields(model, {
            storageState: () => StorageState.NoFolderSelected(),
            maybeAlertBanner: () => maybeAlertBanner,
          }),
        }
      }

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
              storageType: storageType.value,
              rootName,
              subPath,
              isFallback,
              entriesState: EntriesState.Loaded({ entries }),
            }),
          isSettingsOpen: () => false,
          modalState: () => nextModalState,
          maybeAlertBanner: () => maybeAlertBanner,
        }),
        ...(shouldFocusModal && { commands: [FocusModalNameInput()] }),
      }
    },

    DetectedPermissionRequired: ({ folderName }) => ({
      model: modifyFields(model, {
        storageState: () => StorageState.PermissionRequired({ folderName }),
        isSettingsOpen: () => false,
      }),
    }),

    DetectedNoFolderSelected: () => ({
      model: modifyFields(model, {
        storageState: () => StorageState.NoFolderSelected(),
        isSettingsOpen: () => false,
        modalState: () =>
          model.modalState._tag === "Help" ? model.modalState : ModalState.Closed(),
        maybeAlertBanner: () => Option.none(),
      }),
    }),

    FailedStorageInit: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        storageState: () => StorageState.NoFolderSelected(),
        maybeAlertBanner: () =>
          Option.some({
            message: errorMessage,
            variant: "danger",
          }),
      }),
    }),

    LoadedFileInfoPreference: ({ visible }) => ({
      model: modifyFields(model, {
        showFileInfo: () => visible,
      }),
    }),

    SavedFileInfoPreference: () => ({ model }),

    // Directory Listing & Navigation
    SucceededListEntries: ({ subPath, entries }) => {
      if (model.storageState._tag !== "Ready") {
        return { model }
      }
      const readyState = model.storageState
      return {
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              subPath: () => subPath,
              entriesState: () => EntriesState.Loaded({ entries }),
            }),
          maybeAlertBanner: () => Option.none(),
        }),
      }
    },

    FailedListEntries: ({ message: errorMessage }) => {
      if (model.storageState._tag !== "Ready") {
        return { model }
      }
      const readyState = model.storageState
      return {
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              entriesState: () => EntriesState.Error({ message: errorMessage }),
            }),
        }),
      }
    },

    ClickedRetryList: () => {
      if (model.storageState._tag !== "Ready") {
        return { model }
      }
      const readyState = model.storageState
      return {
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              entriesState: () => EntriesState.Loading(),
            }),
        }),
        commands: [RefreshEntries()],
      }
    },

    ClickedBreadcrumbRoot: () => {
      if (model.storageState._tag !== "Ready") {
        return { model }
      }
      return {
        model,
        commands: [NavigateToSubfolder({ targetSubPath: [] })],
      }
    },

    ClickedBreadcrumbSegment: ({ index }) => {
      if (model.storageState._tag !== "Ready") {
        return { model }
      }
      const targetSubPath = Array.take(model.storageState.subPath, index + 1)
      return {
        model,
        commands: [NavigateToSubfolder({ targetSubPath })],
      }
    },

    ClickedEntryRow: ({ entry }) => {
      if (model.storageState._tag !== "Ready") {
        return { model }
      }
      const { subPath } = model.storageState
      if (entry.kind === "directory") {
        return {
          model,
          commands: [
            NavigateToSubfolder({
              targetSubPath: [...subPath, entry.name],
            }),
          ],
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
    },

    CompletedOpenFile: () => ({ model }),

    NavigatedPopState: ({ pathname, search }) => {
      const maybeHelpModal = initialHelpModalFromSearch(search)
      if (model.storageState._tag !== "Ready") {
        return {
          model: modifyFields(model, {
            modalState: () => Option.getOrElse(maybeHelpModal, () => ModalState.Closed()),
          }),
        }
      }
      return {
        model,
        commands: [
          HandlePopStateNavigation({
            pathname,
            search,
            isFallback: model.storageState.isFallback,
          }),
        ],
      }
    },

    CompletedHistorySync: () => ({ model }),

    // Settings & Storage Actions
    ClickedToggleSettings: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => !model.isSettingsOpen,
      }),
    }),

    ClosedSettingsMenu: () => ({
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

    ClickedSelectFolder: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [PickLocalDirectory()],
    }),

    ClickedChangeFolder: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [PickLocalDirectory()],
    }),

    ClickedGrantPermission: () => ({
      model,
      commands: [GrantDirectoryPermission()],
    }),

    ClickedUseOpfs: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [
        ActivateOpfsBackend({
          isFallback: !model.hasDirectoryPicker,
        }),
      ],
    }),

    ClickedDisconnectFolder: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [
        DisconnectStorage({
          hasDirectoryPicker: model.hasDirectoryPicker,
          hasOPFS: model.hasOPFS,
        }),
      ],
    }),

    CancelledFolderSelection: () => ({ model }),

    // Alerts
    ShownAlertBanner: ({ banner }) => ({
      model: modifyFields(model, {
        maybeAlertBanner: () => Option.some(banner),
      }),
    }),

    // Toolbar & File/Folder Creation
    ClickedNewFile: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: () =>
            ModalState.CreateFile({
              name: "Neu.html",
              content: "",
            }),
        }),
        commands: [
          SyncHistoryUrl({
            mode: "replace",
            url: buildFolderUrl(subPath),
            revokePreview: true,
          }),
          FocusModalNameInput(),
        ],
      }
    },

    ClickedNewFolder: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: () =>
            ModalState.CreateFolder({
              name: "Neuer Ordner",
            }),
        }),
        commands: [
          SyncHistoryUrl({
            mode: "replace",
            url: buildFolderUrl(subPath),
            revokePreview: true,
          }),
          FocusModalNameInput(),
        ],
      }
    },

    ClickedImportFiles: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [ImportExternalFiles()],
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
      if (entry.kind === "directory") {
        return {
          model: modifyFields(model, {
            isSettingsOpen: () => false,
            modalState: () =>
              ModalState.EditFolder({
                originalName: entry.name,
                name: entry.name,
              }),
          }),
          commands: [
            SyncHistoryUrl({
              mode: "push",
              url: buildEditUrl(subPath, entry.name),
              revokePreview: true,
            }),
            FocusModalNameInput(),
          ],
        }
      }

      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          InspectFileForEditor({
            entryName: entry.name,
            subPath,
            pushHistory: true,
          }),
        ],
      }
    },

    OpenedEditFileModal: ({ originalName, fileMode }) => ({
      model: modifyFields(model, {
        modalState: () =>
          ModalState.EditFile({
            originalName,
            name: originalName,
            fileMode,
          }),
      }),
      commands: [FocusModalNameInput()],
    }),

    FailedOpenEditModal: ({ message: errorMessage }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          maybeAlertBanner: () =>
            Option.some({
              message: errorMessage,
              variant: "danger",
            }),
        }),
        commands: [
          SyncHistoryUrl({
            mode: "replace",
            url: buildFolderUrl(subPath),
            revokePreview: true,
          }),
        ],
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
              }),
            CreateFolder: (state) =>
              modifyFields(state, {
                name: () => name,
              }),
            EditFolder: (state) =>
              modifyFields(state, {
                name: () => name,
              }),
            EditFile: (state) =>
              modifyFields(state, {
                name: () => name,
              }),
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

      if (!isChecked) {
        return {
          model: modifyFields(model, {
            modalState: () =>
              modifyFields(editState, {
                fileMode: () =>
                  modifyFields(binaryMode, {
                    isBase64Enabled: () => false,
                  }),
              }),
          }),
        }
      }

      if (binaryMode.base64Content !== "") {
        return {
          model: modifyFields(model, {
            modalState: () =>
              modifyFields(editState, {
                fileMode: () =>
                  modifyFields(binaryMode, {
                    isBase64Enabled: () => true,
                  }),
              }),
          }),
        }
      }

      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  isBase64Enabled: () => true,
                  isLoadingBase64: () => true,
                }),
            }),
        }),
        commands: [LoadModalBase64({ entryName: editState.originalName })],
      }
    },

    LoadedModalBase64Content: ({ base64Content }) => {
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
                  base64Content: () => base64Content,
                  isLoadingBase64: () => false,
                }),
            }),
        }),
      }
    },

    FailedLoadModalBase64Content: ({ message: errorMessage }) => {
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
                  isBase64Enabled: () => false,
                  isLoadingBase64: () => false,
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

      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  base64Content: () => base64Content,
                }),
            }),
        }),
      }
    },

    ClickedSaveModal: () => ({
      model,
      commands: [SaveModalChanges({ modalState: model.modalState })],
    }),

    ClickedDeleteModalEntry: () => {
      if (model.modalState._tag === "EditFolder") {
        return {
          model,
          commands: [
            DeleteModalEntry({
              entryName: model.modalState.originalName,
              isFolder: true,
            }),
          ],
        }
      }
      if (model.modalState._tag === "EditFile") {
        return {
          model,
          commands: [
            DeleteModalEntry({
              entryName: model.modalState.originalName,
              isFolder: false,
            }),
          ],
        }
      }
      return { model }
    },

    ClickedCloseModal: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          modalState: () => ModalState.Closed(),
        }),
        commands: [
          SyncHistoryUrl({
            mode: "replace",
            url: buildFolderUrl(subPath),
            revokePreview: true,
          }),
        ],
      }
    },

    PressedEscape: () => {
      if (model.modalState._tag !== "Closed") {
        const subPath = currentSubPathFromStorageState(model.storageState)
        return {
          model: modifyFields(model, {
            isSettingsOpen: () => false,
            modalState: () => ModalState.Closed(),
          }),
          commands: [
            SyncHistoryUrl({
              mode: "replace",
              url: buildFolderUrl(subPath),
              revokePreview: true,
            }),
          ],
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
        commands: [
          SyncHistoryUrl({
            mode: "push",
            url: buildHelpUrl(subPath, Option.some("api")),
            revokePreview: true,
          }),
        ],
      }
    },

    ToggledHelpTopic: ({ topic, isOpen }) => {
      if (model.modalState._tag !== "Help") {
        return { model }
      }
      const helpState = model.modalState
      const nextIsApiOpen = topic === "api" ? isOpen : helpState.isApiOpen
      const nextIsFsOpen = topic === "fs" ? isOpen : helpState.isFsOpen

      if (nextIsApiOpen === helpState.isApiOpen && nextIsFsOpen === helpState.isFsOpen) {
        return { model }
      }

      const subPath = currentSubPathFromStorageState(model.storageState)
      const maybeActiveTopic =
        nextIsApiOpen && !nextIsFsOpen
          ? Option.some("api" as const)
          : nextIsFsOpen && !nextIsApiOpen
            ? Option.some("fs" as const)
            : Option.none()

      return {
        model: modifyFields(model, {
          modalState: () =>
            modifyFields(helpState, {
              isApiOpen: () => nextIsApiOpen,
              isFsOpen: () => nextIsFsOpen,
            }),
        }),
        commands: [
          SyncHistoryUrl({
            mode: "replace",
            url: buildHelpUrl(subPath, maybeActiveTopic),
          }),
        ],
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
        commands: [DelayResetCopyDtsStatus()],
      }
    },

    ResetCopyDtsStatus: () => {
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
        canInstallApp: () => true,
      }),
    }),

    InstalledApp: () => ({
      model: modifyFields(model, {
        canInstallApp: () => false,
      }),
    }),

    ClickedInstallApp: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
      commands: [TriggerInstallAppPrompt()],
    }),

    CompletedInstallApp: ({ didAccept }) => ({
      model: modifyFields(model, {
        canInstallApp: () => !didAccept && model.canInstallApp,
      }),
    }),
  })

export { Flags, Message, Model, subscriptions, view }
