import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import {
  AlertBanner,
  EditorFileMode,
  FileEntry,
  HelpTopic,
  ImportCollisionAction,
  ModalState,
  PendingImportFile,
  SavedBackend,
  StorageType,
} from "./route"

// MESSAGE

const StorageActivatedFields = {
  storageType: StorageType,
  rootName: Schema.String,
  subPath: Schema.Array(Schema.String),
  entries: Schema.Array(FileEntry),
  otherBackend: SavedBackend,
  maybeModalState: Schema.Option(ModalState),
  maybeAlertBanner: Schema.Option(AlertBanner),
}

const PermissionRequiredFields = {
  storageType: StorageType,
  folderName: Schema.String,
  otherBackend: SavedBackend,
}

const NoFolderSelectedFields = {
  storageType: StorageType,
  otherBackend: SavedBackend,
}

export const Message = defineMessageUnion({
  // Initialization & Storage Backend Lifecycle
  SucceededInitializeStorage: StorageActivatedFields,
  CompletedInitializeStoragePermissionRequired: PermissionRequiredFields,
  CompletedInitializeStorageNoFolderSelected: NoFolderSelectedFields,
  FailedInitializeStorage: {
    message: Schema.String,
  },
  CompletedLoadFileInfoPreference: {
    visible: Schema.Boolean,
  },
  CompletedSaveFileInfoPreference: {},
  CompletedSaveStorageTypePreference: {},

  // Directory Listing & Navigation
  SucceededRefreshEntries: {
    subPath: Schema.Array(Schema.String),
    entries: Schema.Array(FileEntry),
  },
  FailedRefreshEntries: {
    message: Schema.String,
  },
  SucceededNavigateToSubfolder: {
    subPath: Schema.Array(Schema.String),
    entries: Schema.Array(FileEntry),
  },
  ClickedRetryList: {},
  ClickedBreadcrumbRoot: {},
  ClickedBreadcrumbSegment: {
    index: Schema.Number,
  },
  ClickedEntryRow: {
    entry: FileEntry,
  },
  CompletedOpenFileInBrowser: {},
  RequestedUrl: {
    request: UrlRequest,
  },
  ChangedUrl: {
    url: Url,
  },
  CompletedPushUrl: {},
  CompletedReplaceUrl: {},
  CompletedLoadUrl: {},
  CompletedFocusModalNameInput: {},
  CompletedScrollHelpTopicIntoView: {},
  CompletedRevokeActivePreviewUrl: {},

  // Settings & Storage Actions
  ClickedToggleSettings: {},
  ClickedOutsideSettingsMenu: {},
  ClickedToggleFileInfo: {},
  ClickedSelectFolder: {},
  ClickedChangeFolder: {},
  ClickedGrantPermission: {},
  ClickedUseOpfs: {},
  ClickedUseFsa: {},
  ClickedDisconnectFolder: {},
  SucceededPickLocalDirectory: StorageActivatedFields,
  CancelledPickLocalDirectory: {},
  FailedPickLocalDirectory: {
    message: Schema.String,
  },
  SucceededGrantDirectoryPermission: StorageActivatedFields,
  CompletedGrantDirectoryPermissionNoFolderSelected: NoFolderSelectedFields,
  FailedGrantDirectoryPermission: {
    message: Schema.String,
  },
  SucceededActivateOpfsBackend: StorageActivatedFields,
  FailedActivateOpfsBackend: {
    message: Schema.String,
  },
  SucceededActivateFsaBackend: StorageActivatedFields,
  CompletedActivateFsaBackendPermissionRequired: PermissionRequiredFields,
  CompletedActivateFsaBackendNoFolderSelected: NoFolderSelectedFields,
  FailedActivateFsaBackend: {
    message: Schema.String,
  },
  SucceededDisconnectStorage: NoFolderSelectedFields,
  FailedDisconnectStorage: {
    message: Schema.String,
  },
  FailedNavigateToSubfolder: {
    message: Schema.String,
  },

  // Toolbar & File/Folder Creation
  ClickedNewFile: {},
  ClickedNewFolder: {},
  ClickedImportFiles: {},
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

  // Editor Modal
  ClickedEditEntry: {
    entry: FileEntry,
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
  PressedEscape: {},
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

  // Help Modal
  ClickedOpenHelp: {},
  ToggledHelpTopic: {
    topic: HelpTopic,
    isOpen: Schema.Boolean,
  },
  ClickedCopyDts: {},
  SucceededCopyApiDtsToClipboard: {},
  CompletedWaitBeforeResetCopyDts: {},
  FailedCopyApiDtsToClipboard: {
    message: Schema.String,
  },

  // PWA Install Prompt
  CapturedInstallPrompt: {},
  InstalledApp: {},
  ClickedInstallApp: {},
  CompletedTriggerInstallAppPrompt: {
    didAccept: Schema.Boolean,
  },
})

export type Message = typeof Message.Type
