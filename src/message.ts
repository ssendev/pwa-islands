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
} from "./model"

// MESSAGE

export const Message = defineMessageUnion({
  // Initialization & Storage Backend Lifecycle
  SucceededInitializeStorage: {
    storageType: StorageType,
    rootName: Schema.String,
    subPath: Schema.Array(Schema.String),
    entries: Schema.Array(FileEntry),
    otherBackend: SavedBackend,
    maybeModalState: Schema.Option(ModalState),
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
  DetectedPermissionRequired: {
    storageType: StorageType,
    folderName: Schema.String,
    otherBackend: SavedBackend,
  },
  DetectedNoFolderSelected: {
    storageType: StorageType,
    otherBackend: SavedBackend,
  },
  FailedInitializeStorage: {
    message: Schema.String,
  },
  CompletedLoadFileInfoPreference: {
    visible: Schema.Boolean,
  },
  CompletedSaveFileInfoPreference: {},

  // Directory Listing & Navigation
  SucceededListEntries: {
    subPath: Schema.Array(Schema.String),
    entries: Schema.Array(FileEntry),
  },
  FailedListEntries: {
    message: Schema.String,
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
  CancelledFolderSelection: {},
  FailedPickLocalDirectory: {
    message: Schema.String,
  },
  FailedGrantDirectoryPermission: {
    message: Schema.String,
  },
  FailedActivateOpfsBackend: {
    message: Schema.String,
  },
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
  SelectedImportFiles: {
    files: Schema.Array(PendingImportFile),
  },
  SelectedImportConflictAction: {
    action: ImportCollisionAction,
  },
  ToggledImportConflictApplyToAll: {
    applyToAll: Schema.Boolean,
  },
  CancelledImportConflict: {},
  CompletedImportFiles: {
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
  SucceededModalMutation: {
    entries: Schema.Array(FileEntry),
  },
  CancelledModalMutation: {},
  FailedModalMutation: {
    message: Schema.String,
  },

  // Help Modal
  ClickedOpenHelp: {},
  ToggledHelpTopic: {
    topic: HelpTopic,
    isOpen: Schema.Boolean,
  },
  ClickedCopyDts: {},
  SucceededCopyDts: {},
  CompletedWaitBeforeResetCopyDts: {},
  FailedCopyDts: {
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
