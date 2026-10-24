import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { AlertBanner, EditorFileMode, FileEntry, HelpTopic, ModalState, StorageType } from "./model"

export const Message = defineMessageUnion({
  // Initialization & Storage Backend Lifecycle
  CompletedStorageInit: {
    storageType: Schema.Option(StorageType),
    rootName: Schema.String,
    subPath: Schema.Array(Schema.String),
    isFallback: Schema.Boolean,
    entries: Schema.Array(FileEntry),
    maybeModalState: Schema.Option(ModalState),
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
  DetectedPermissionRequired: {
    folderName: Schema.String,
  },
  DetectedNoFolderSelected: {},
  FailedStorageInit: {
    message: Schema.String,
  },
  LoadedFileInfoPreference: {
    visible: Schema.Boolean,
  },
  SavedFileInfoPreference: {},

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
  CompletedOpenFile: {},
  NavigatedPopState: {
    pathname: Schema.String,
    search: Schema.String,
  },
  CompletedHistorySync: {},

  // Settings & Storage Actions
  ClickedToggleSettings: {},
  ClosedSettingsMenu: {},
  ClickedToggleFileInfo: {},
  ClickedSelectFolder: {},
  ClickedChangeFolder: {},
  ClickedGrantPermission: {},
  ClickedUseOpfs: {},
  ClickedDisconnectFolder: {},
  CancelledFolderSelection: {},

  // Alerts
  ShownAlertBanner: {
    banner: AlertBanner,
  },

  // Toolbar & File/Folder Creation
  ClickedNewFile: {},
  ClickedNewFolder: {},
  ClickedImportFiles: {},
  CompletedImportFiles: {
    entries: Schema.Array(FileEntry),
    maybeAlertBanner: Schema.Option(AlertBanner),
  },

  // Editor Modal
  ClickedEditEntry: {
    entry: FileEntry,
  },
  OpenedEditFileModal: {
    originalName: Schema.String,
    fileMode: EditorFileMode,
  },
  FailedOpenEditModal: {
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
  LoadedModalBase64Content: {
    base64Content: Schema.String,
  },
  FailedLoadModalBase64Content: {
    message: Schema.String,
  },
  UpdatedModalBase64Content: {
    base64Content: Schema.String,
  },
  ClickedSaveModal: {},
  ClickedDeleteModalEntry: {},
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
  ResetCopyDtsStatus: {},
  FailedCopyDts: {
    message: Schema.String,
  },

  // PWA Install Prompt
  CapturedInstallPrompt: {},
  InstalledApp: {},
  ClickedInstallApp: {},
  CompletedInstallApp: {
    didAccept: Schema.Boolean,
  },
})

export type Message = typeof Message.Type
