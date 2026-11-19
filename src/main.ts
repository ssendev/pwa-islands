import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { Array, Clock, Duration, Effect, Match, Option, Queue, Schema, Stream, pipe } from "effect"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import type * as Html from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Navigation from "foldkit/navigation"
import { UrlRequest } from "foldkit/navigation"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import * as Subscription from "foldkit/subscription"
import { Url, toString as urlToString } from "foldkit/url"
import rootIconUrl from "./assets/pwa-islands.svg"
import { clearAllFileHistory, recordPreviousTauriApiFileVersion } from "./history"
import { type IconId, viewIcon } from "./icons"
import {
  FileSystemHandleStorage,
  TauriStorage,
  type StorageBackend,
  FileEntry,
  PREVIEWABLE_IMAGE_EXTENSIONS,
  StorageType,
  clearSavedDirectoryHandle,
  clearSavedTauriFolder,
  folderNameFromPath,
  getActiveStorage,
  getDeferredInstallPrompt,
  getOPFSRootDirectory,
  getPendingHandle,
  getSavedDirectoryHandle,
  getSavedFileInfoVisible,
  getSavedFsaHandle,
  getSavedStorageType,
  getSavedTauriFolder,
  getSavedTauriFolderCached,
  pickTauriDirectory,
  queryDirectoryPermission,
  requestDirectoryPermission,
  requireActiveStorage,
  revokeActivePreviewUrl,
  saveDirectoryHandle,
  saveFileInfoVisible,
  saveStorageType,
  saveTauriFolder,
  setActiveStorage,
  setDeferredInstallPrompt,
  setPendingHandle,
  setSavedFsaHandle,
  setSavedTauriFolder,
  setTauriRootDirectory,
  showDirectoryPicker,
  supportsTauri,
  isWindowsOrLinux,
  isWindows,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  toggleFullscreenWindow,
  exitFullscreenWindow,
  checkFileExists,
} from "./files"
import * as Modal from "./modal"
import { AlertBanner, Toast, view as viewToasts } from "./toast"
import {
  AppRoute,
  buildEditUrl,
  buildHistoryUrl,
  buildFolderUrl,
  buildHelpUrl,
  buildNewUrl,
  buildSettingsUrl,
  decodeUrlPathnameSegments,
  encodeSubPath,
  parseIslandPath,
  parseUrlToRoute,
} from "./route"
import {
  type EditorChatMessage,
  LANGUAGE_MODEL_OPTION_VALUE,
  OpenAiProviderConfig,
  ProviderEditFormat,
  THINKING_PRESETS,
  compileModelFilter,
  decodeProviderModelValue,
  detectLanguageModelAvailability,
  emptyLlmSettings,
  getProviderDisplayName,
  isLanguageModelSelection,
  listModels,
  parseModelList,
  parseThinkingLevels,
  resolveAllProviderModelOptions,
  resolveModelOptions,
  resolveProviderForModelSelection,
  resolveTestModel,
  runEditorChatTurn,
  streamChatParts,
  streamToolCallParts,
  stripProviderPrefixFromModelSelection,
  testLlmConnection,
} from "./agent"
import {
  DEFAULT_EDIT_FORMAT,
  EDIT_FORMAT_OPTIONS,
  EditFormat,
  formatFileMessageForFormat,
  formatSystemPromptForFormat,
  parseEditFormat,
} from "./edit-format"
import { formatApiDtsMessage } from "./hashline"
import { type Language, LanguageSchema, applyLanguageToDocument, isLanguage, t } from "./i18n"
import * as Editor from "./editor"
import * as LlmResponse from "./llm-response"
import {
  type AppTheme,
  AppThemeSchema,
  DEFAULT_EDITOR_SPLIT_PERCENT,
  DEFAULT_LLM_CHAT_AI_NAME,
  DEFAULT_LLM_CHAT_USER_NAME,
  type MonacoTheme,
  MonacoSettingsSchema,
  MonacoThemeSchema,
  OPFS_APP_FOLDER,
  defaultMonacoSettings,
  getFileExtension,
  getStoredApiHistoryEnabled,
  getStoredAppTheme,
  getStoredEditorPreferences,
  getStoredHistoryEnabled,
  getStoredLanguage,
  getStoredLlmChatNames,
  getStoredLlmSettings,
  getStoredMonacoSettings,
  storeApiHistoryEnabled,
  storeAppTheme,
  storeEditorPreferences,
  storeHistoryEnabled,
  storeLanguage,
  storeLlmChatNames,
  storeLlmSettings,
  storeMonacoSettings,
} from "./storage"

// FORMATTING

const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = (timestamp: number): string => {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)
}

const formatSummaryText = (entries: ReadonlyArray<FileEntry>, language: Language): string => {
  const tr = t(language).files
  const fileCount = pipe(
    entries,
    Array.filter((entry) => entry.kind === "file"),
    Array.length,
  )
  const dirCount = pipe(
    entries,
    Array.filter((entry) => entry.kind === "directory"),
    Array.length,
  )
  const parts: ReadonlyArray<string> = [
    ...(fileCount > 0 ? [tr.fileCount(fileCount)] : []),
    ...(dirCount > 0 ? [tr.folderCount(dirCount)] : []),
  ]
  return Array.join(parts, ", ")
}

// MODEL

export const EntriesState = defineTaggedUnion({
  Loading: {},
  Loaded: {
    entries: Schema.Array(FileEntry),
  },
  Error: {
    message: Schema.String,
  },
})
export type EntriesState = typeof EntriesState.Type

export const SavedBackend = defineTaggedUnion({
  Unsupported: {},
  NoFolderSelected: {},
  PermissionRequired: {
    folderName: Schema.String,
  },
  Granted: {
    rootName: Schema.String,
  },
})
export type SavedBackend = typeof SavedBackend.Type

export const StorageState = defineTaggedUnion({
  Initializing: {},
  Unsupported: {},

  NoFolderSelected: {
    storageType: StorageType,
    otherBackend: SavedBackend,
    pendingRoute: AppRoute,
  },

  PermissionRequired: {
    storageType: StorageType,
    folderName: Schema.String,
    otherBackend: SavedBackend,
    pendingRoute: AppRoute,
  },

  Ready: {
    storageType: StorageType,
    rootName: Schema.String,
    subPath: Schema.Array(Schema.String),
    entriesState: EntriesState,
    otherBackend: SavedBackend,
  },
})
export type StorageState = typeof StorageState.Type

export const currentSubPathFromStorageState = (storageState: StorageState): ReadonlyArray<string> =>
  StorageState.match(storageState, {
    Initializing: () => [],
    Unsupported: () => [],
    NoFolderSelected: () => [],
    PermissionRequired: () => [],
    Ready: ({ subPath }) => subPath,
  })

export const currentStorageTypeFromStorageState = (
  storageState: StorageState,
): Option.Option<StorageType> =>
  StorageState.match(storageState, {
    Initializing: () => Option.none(),
    Unsupported: () => Option.none(),
    NoFolderSelected: ({ storageType }) => Option.some(storageType),
    PermissionRequired: ({ storageType }) => Option.some(storageType),
    Ready: ({ storageType }) => Option.some(storageType),
  })

export const isTauriStorageState = (storageState: StorageState): boolean =>
  Option.exists(currentStorageTypeFromStorageState(storageState), (t) => t === "tauri")

export const buildTauriIslandUrl = (subPath: ReadonlyArray<string>, fileName: string): string => {
  const encodedPath = encodeSubPath([...subPath, fileName])
  try {
    const protocolRoot = convertFileSrc("", "pwaislands")
    return protocolRoot.endsWith("/")
      ? `${protocolRoot}${encodedPath}`
      : `${protocolRoot}/${encodedPath}`
  } catch {
    return `pwaislands://localhost/${encodedPath}`
  }
}

export const pendingRouteFromStorageState = (
  storageState: StorageState,
  fallbackSubPath: ReadonlyArray<string> = [],
): AppRoute =>
  StorageState.match(storageState, {
    Initializing: () => AppRoute.Folder({ subPath: fallbackSubPath }),
    Unsupported: () => AppRoute.Folder({ subPath: fallbackSubPath }),
    NoFolderSelected: ({ pendingRoute }) => pendingRoute,
    PermissionRequired: ({ pendingRoute }) => pendingRoute,
    Ready: ({ subPath }) => AppRoute.Folder({ subPath }),
  })

export const InstallPrompt = defineTaggedUnion({
  Unavailable: {},
  Available: {},
  Prompting: {},
})
export type InstallPrompt = typeof InstallPrompt.Type

export const LlmTestMode = Schema.Literals(["models", "chat", "tools"])
export type LlmTestMode = typeof LlmTestMode.Type

export const LlmTestState = defineTaggedUnion({
  Idle: {},
  Testing: {},
  Streaming: {
    mode: LlmTestMode,
    content: Schema.String,
    reasoning: Schema.String,
  },
  Succeeded: {
    content: Schema.String,
    reasoning: Schema.String,
    models: Schema.Array(Schema.String),
  },
  Failed: { message: Schema.String },
})
export type LlmTestState = typeof LlmTestState.Type

export const IslandIpcAction = defineTaggedUnion({
  Write: {
    subPath: Schema.String,
    data: Schema.Array(Schema.Number),
  },
  MakeDir: {
    subPath: Schema.String,
  },
  Rename: {
    from: Schema.String,
    to: Schema.String,
  },
  Remove: {
    subPath: Schema.String,
    recursive: Schema.Boolean,
  },
  Copy: {
    from: Schema.String,
    to: Schema.String,
  },
})
export type IslandIpcAction = typeof IslandIpcAction.Type

export const ClearAllHistoryState = defineTaggedUnion({
  Idle: {},
  Confirming: {},
  Clearing: {},
  Done: {},
})
export type ClearAllHistoryState = typeof ClearAllHistoryState.Type

export const Flags = Schema.Struct({
  hasDirectoryPicker: Schema.Boolean,
  hasOPFS: Schema.Boolean,
  hasTauri: Schema.Boolean,
  origin: Schema.String,
  language: Schema.optionalKey(LanguageSchema),
  isWindowsOrLinux: Schema.optionalKey(Schema.Boolean),
  isWindows: Schema.optionalKey(Schema.Boolean),
  isWindowMaximized: Schema.optionalKey(Schema.Boolean),
  isWindowFullscreen: Schema.optionalKey(Schema.Boolean),
})
export type Flags = typeof Flags.Type

export const Model = Schema.Struct({
  hasDirectoryPicker: Schema.Boolean,
  hasOPFS: Schema.Boolean,
  hasTauri: Schema.Boolean,
  hasLanguageModel: Schema.Boolean,
  isWindowsOrLinux: Schema.Boolean,
  isWindows: Schema.Boolean,
  isWindowFocused: Schema.Boolean,
  isWindowMaximized: Schema.Boolean,
  isWindowFullscreen: Schema.Boolean,
  origin: Schema.String,
  storageState: StorageState,
  showFileInfo: Schema.Boolean,
  isSettingsOpen: Schema.Boolean,
  isSettingsDialogOpen: Schema.Boolean,
  isEditingLlmSettings: Schema.Boolean,
  isConfirmingDeleteLlmProvider: Schema.Boolean,
  editingLlmProviderId: Schema.Option(Schema.String),
  llmProviders: Schema.Array(OpenAiProviderConfig),
  llmActiveProviderId: Schema.String,
  llmEnabled: Schema.Boolean,
  llmEditFormat: EditFormat,
  llmBaseUrl: Schema.String,
  llmApiKey: Schema.String,
  llmModels: Schema.String,
  llmStreaming: Schema.Boolean,
  llmToolCalls: Schema.Boolean,
  llmThinkingParam: Schema.String,
  llmThinkingLevels: Schema.String,
  llmExtraArgs: Schema.String,
  llmModel: Schema.String,
  llmThinkingLevel: Schema.String,
  llmChatAiName: Schema.String,
  llmChatUserName: Schema.String,
  llmDiscoveredModels: Schema.Array(Schema.String),
  hasLoadedEditorLlmModels: Schema.Boolean,
  editorLlmBarMode: Editor.LlmBarMode,
  editorSplitPercent: Schema.Number,
  llmDraftEnabled: Schema.Boolean,
  llmDraftName: Schema.String,
  llmDraftProviderEnabled: Schema.Boolean,
  llmDraftProviderEditFormat: ProviderEditFormat,
  llmDraftEditFormat: EditFormat,
  llmDraftBaseUrl: Schema.String,
  llmDraftApiKey: Schema.String,
  llmDraftModels: Schema.String,
  llmDraftModelFilter: Schema.String,
  llmDraftStreaming: Schema.Boolean,
  llmDraftToolCalls: Schema.Boolean,
  llmDraftThinkingParam: Schema.String,
  llmDraftThinkingLevels: Schema.String,
  llmDraftExtraArgs: Schema.String,
  llmDraftModel: Schema.String,
  llmDraftThinkingLevel: Schema.String,
  llmTestState: LlmTestState,
  historyEnabled: Schema.Boolean,
  apiHistoryEnabled: Schema.Boolean,
  appTheme: AppThemeSchema,
  language: LanguageSchema,
  editorLineNumbers: Schema.Boolean,
  editorFolding: Schema.Boolean,
  editorWordWrap: Schema.Boolean,
  editorScrollBeyondLastLine: Schema.Boolean,
  editorTheme: MonacoThemeSchema,
  editorLineDecorationsWidth: Schema.Number,
  editorLineNumbersMinChars: Schema.Number,
  editorUndoInTitlebar: Schema.Boolean,
  clearAllHistoryState: ClearAllHistoryState,
  installPrompt: InstallPrompt,
  modalState: Modal.ModalState,
  toasts: Schema.Array(Toast),
  nextToastId: Schema.Number,
  maybeActiveIslandUrl: Schema.Option(Schema.String),
  maybeActiveIslandPath: Schema.Option(Schema.String),
  returnClickId: Schema.Number,
})
export type Model = typeof Model.Type

type ReadyStorageState = Extract<StorageState, { readonly _tag: "Ready" }>

const APP_TITLE = OPFS_APP_FOLDER

export const computeDocumentTitle = (model: Model): string => {
  const subPath = currentSubPathFromStorageState(model.storageState)
  const folderParts = [...Array.reverse(subPath), APP_TITLE]
  const folderTitle = Array.join(folderParts, " — ")

  return Modal.formatDocumentTitle(model.modalState, folderTitle)
}

// MESSAGE

const StorageActivatedFields = {
  storageType: StorageType,
  rootName: Schema.String,
  subPath: Schema.Array(Schema.String),
  entries: Schema.Array(FileEntry),
  otherBackend: SavedBackend,
  maybeModalState: Schema.Option(Modal.ModalState),
  maybeAlertBanner: Schema.Option(AlertBanner),
}

const PermissionRequiredFields = {
  storageType: StorageType,
  folderName: Schema.String,
  otherBackend: SavedBackend,
  pendingRoute: AppRoute,
}

const NoFolderSelectedFields = {
  storageType: StorageType,
  otherBackend: SavedBackend,
  pendingRoute: AppRoute,
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
  ClickedDismissToast: {
    id: Schema.Number,
  },
  ClickedCopyToast: {
    message: Schema.String,
  },
  CompletedCopyToast: {},
  CompletedWaitBeforeDismissToast: {
    id: Schema.Number,
  },
  ClickedBreadcrumbRoot: {},
  ClickedBreadcrumbSegment: {
    index: Schema.Number,
  },
  ClickedEntryRow: {
    entry: FileEntry,
  },
  CompletedOpenFileInBrowser: {},
  LoadedIslandIframe: {},
  CompletedFocusIslandIframe: {},
  ClickedReturnArrow: {},
  DoubleClickedReturnArrow: {},
  CompletedReturnArrowClickDelay: {
    clickId: Schema.Number,
  },
  ChangedWindowFocus: {
    isFocused: Schema.Boolean,
  },
  ClickedMinimizeWindow: {},
  CompletedMinimizeWindow: {},
  ClickedToggleMaximizeWindow: {},
  CompletedToggleMaximizeWindow: {},
  ClickedToggleFullscreen: {},
  CompletedToggleFullscreen: {},
  ClickedCloseWindow: {},
  CompletedCloseWindow: {},
  ChangedWindowMaximized: {
    isMaximized: Schema.Boolean,
  },
  ChangedWindowFullscreen: {
    isFullscreen: Schema.Boolean,
  },
  ReceivedServiceWorkerToast: {
    banner: AlertBanner,
  },
  CompletedResolveIslandBackNavigation: {
    targetUrl: Schema.String,
    isIsland: Schema.Boolean,
    subPath: Schema.Array(Schema.String),
    shouldNavigate: Schema.Boolean,
  },
  ReceivedIslandNavigation: {
    url: Schema.String,
  },
  ReceivedIslandIpcRequest: {
    requestId: Schema.String,
    action: IslandIpcAction,
  },
  CompletedHandleIslandIpcRequest: {},
  RequestedUrl: {
    request: UrlRequest,
  },
  ChangedUrl: {
    url: Url,
  },
  CompletedPushUrl: {},
  CompletedReplaceUrl: {},
  CompletedLoadUrl: {},
  PressedNavigateBack: {},
  PressedNavigateForward: {},
  CompletedNavigateHistoryBack: {},
  CompletedNavigateHistoryForward: {},
  FailedNavigateToSubfolder: {
    message: Schema.String,
  },

  // Settings & Storage Actions
  ClickedToggleSettings: {},
  ClickedOutsideSettingsMenu: {},
  ClickedOutsideLlmModeMenu: {},
  ClickedOpenSettingsDialog: {},
  ClickedCloseSettingsDialog: {},
  ClickedSaveSettingsDialog: {},
  ClickedEditLlmSettings: {},
  ClickedRequestClearAllHistory: {},
  ClickedCancelClearAllHistory: {},
  ClickedConfirmClearAllHistory: {},
  SucceededClearAllHistory: {},
  FailedClearAllHistory: { message: Schema.String },
  ToggledSettingsHistoryEnabled: { isEnabled: Schema.Boolean },
  CompletedSaveHistoryEnabledPreference: {},
  ToggledSettingsApiHistoryEnabled: { isEnabled: Schema.Boolean },
  CompletedSaveApiHistoryEnabledPreference: {},
  ToggledSettingsEditorLineNumbers: { isEnabled: Schema.Boolean },
  ToggledSettingsEditorFolding: { isEnabled: Schema.Boolean },
  ToggledSettingsEditorWordWrap: { isEnabled: Schema.Boolean },
  ToggledSettingsEditorScrollBeyondLastLine: { isEnabled: Schema.Boolean },
  SelectedSettingsEditorTheme: { theme: MonacoThemeSchema },
  UpdatedSettingsEditorLineDecorationsWidth: { value: Schema.Number },
  UpdatedSettingsEditorLineNumbersMinChars: { value: Schema.Number },
  ToggledSettingsEditorUndoInTitlebar: { isEnabled: Schema.Boolean },
  CompletedSaveMonacoSettings: {},
  SelectedSettingsAppTheme: { theme: AppThemeSchema },
  CompletedSaveAppTheme: {},
  CompletedApplyAppTheme: {},
  SelectedSettingsLanguage: { language: LanguageSchema },
  CompletedSaveLanguage: {},
  CompletedApplyLanguage: {},
  ClickedTestLlm: { mode: LlmTestMode },
  UpdatedTestLlmStream: {
    content: Schema.String,
    reasoning: Schema.String,
  },
  SucceededTestLlm: {
    content: Schema.String,
    reasoning: Schema.String,
    models: Schema.Array(Schema.String),
  },
  FailedTestLlm: { message: Schema.String },
  ClickedAddLlmProvider: {},
  ClickedEditLlmProvider: { id: Schema.String },
  ClickedDeleteLlmProvider: { id: Schema.String },
  ClickedConfirmDeleteLlmProvider: {},
  ClickedCancelDeleteLlmProvider: {},
  ClickedCancelLlmProviderEdit: {},
  UpdatedLlmProviderName: { value: Schema.String },
  ToggledLlmProviderEnabled: { id: Schema.String, isChecked: Schema.Boolean },
  ToggledLlmDraftProviderEnabled: { isChecked: Schema.Boolean },
  UpdatedLlmDraftProviderEditFormat: { value: Schema.String },
  ToggledLlmEnabled: { isChecked: Schema.Boolean },
  UpdatedLlmEditFormat: { value: Schema.String },
  UpdatedLlmChatAiName: { value: Schema.String },
  UpdatedLlmChatUserName: { value: Schema.String },
  CompletedSaveLlmChatNames: {},
  UpdatedLlmBaseUrl: { value: Schema.String },
  UpdatedLlmApiKey: { value: Schema.String },
  UpdatedLlmModels: { value: Schema.String },
  UpdatedLlmModelFilter: { value: Schema.String },
  SelectedLlmModel: { value: Schema.String },
  ToggledLlmStreaming: { isChecked: Schema.Boolean },
  ToggledLlmToolCalls: { isChecked: Schema.Boolean },
  SelectedLlmThinkingPreset: { presetId: Schema.String },
  UpdatedLlmThinkingParam: { value: Schema.String },
  UpdatedLlmThinkingLevels: { value: Schema.String },
  UpdatedLlmThinkingLevel: { value: Schema.String },
  UpdatedLlmExtraArgs: { value: Schema.String },
  CompletedDetectLanguageModel: { isAvailable: Schema.Boolean },
  CompletedLoadLlmSettings: {
    enabled: Schema.Boolean,
    providers: Schema.Array(OpenAiProviderConfig),
    activeProviderId: Schema.String,
    editFormat: EditFormat,
    baseUrl: Schema.String,
    apiKey: Schema.String,
    models: Schema.String,
    modelFilter: Schema.optional(Schema.String),
    streaming: Schema.Boolean,
    toolCalls: Schema.Boolean,
    thinkingParam: Schema.String,
    thinkingLevels: Schema.String,
    extraArgs: Schema.String,
  },
  CompletedSaveLlmSettings: {},
  CompletedLoadEditorPreferences: {
    llmBarMode: Editor.LlmBarMode,
    llmModel: Schema.String,
    llmThinkingLevel: Schema.String,
    editorSplitPercent: Schema.Number,
    historyEnabled: Schema.optionalKey(Schema.Boolean),
    apiHistoryEnabled: Schema.optionalKey(Schema.Boolean),
    monacoSettings: Schema.optionalKey(MonacoSettingsSchema),
    appTheme: Schema.optionalKey(AppThemeSchema),
    language: Schema.optionalKey(LanguageSchema),
    llmChatNames: Schema.optionalKey(
      Schema.Struct({ aiName: Schema.String, userName: Schema.String }),
    ),
  },
  CompletedSaveEditorPreferences: {},
  SucceededLoadEditorLlmModels: {
    providerId: Schema.optional(Schema.String),
    models: Schema.Array(Schema.String),
  },
  FailedLoadEditorLlmModels: {},
  UpdatedEditorLlmChatStream: {
    completedTurns: Schema.Array(Editor.LlmChatTurnBlock),
    activeTurn: Schema.Struct({
      content: Schema.String,
      reasoning: Schema.String,
      assistantContent: Schema.optionalKey(Schema.String),
      toolDetails: Schema.optionalKey(Schema.Array(Editor.LlmChatToolDetailSchema)),
    }),
    initialMessages: Schema.optionalKey(Schema.Array(Editor.LlmChatMessage)),
  },
  SucceededEditorLlmChat: {
    messages: Schema.Array(Editor.LlmChatMessage),
    maybeUpdatedContent: Schema.Option(Schema.String),
    appliedCount: Schema.Number,
    turns: Schema.Array(Editor.LlmChatTurnBlock),
  },
  FailedEditorLlmChat: {
    message: Schema.String,
  },
  CompletedScrollEditorLlmChatToBottom: {},
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

  // Toolbar Triggers
  ClickedNewFile: {},
  ClickedNewFolder: {},
  ClickedImportFiles: {},
  ClickedEditEntry: {
    entry: FileEntry,
  },
  ClickedEntryHistory: {
    entry: FileEntry,
  },
  ClickedOpenHelp: {},
  PressedEscape: {},

  // PWA Install Prompt
  CapturedInstallPrompt: {},
  InstalledApp: {},
  ClickedInstallApp: {},
  CompletedTriggerInstallAppPrompt: {
    didAccept: Schema.Boolean,
  },

  // Submodel Wrapper
  GotModalMessage: {
    message: Modal.Message,
  },
})
export type Message = typeof Message.Type

type HtmlBuilder = Html.HtmlBuilder<Message>

// COMMAND

export const toModalCommand = (cmd: Command.Command<Modal.Message>): Command.Command<Message> =>
  Command.mapMessage(cmd, (msg) => Message.GotModalMessage({ message: msg }))

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
  storage: StorageBackend,
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
  storage: StorageBackend,
  route: AppRoute,
): Promise<{
  readonly subPath: ReadonlyArray<string>
  readonly entries: ReadonlyArray<FileEntry>
  readonly maybeModalState: Option.Option<Modal.ModalState>
  readonly maybeAlertBanner: Option.Option<AlertBanner>
}> => {
  const targetSubPath = AppRoute.match(route, {
    Help: ({ subPath }) => subPath,
    Settings: ({ subPath }) => subPath,
    Folder: ({ subPath }) => subPath,
    New: ({ subPath }) => subPath,
    Edit: ({ subPath }) => subPath,
    History: ({ subPath }) => subPath,
  })

  const { resolvedSubPath, entries, didFallback } = await listEntriesOrRoot(storage, targetSubPath)

  const { maybeModalState, maybeAlertBanner } = await Modal.resolveModalForRoute(
    storage,
    route,
    entries,
    didFallback,
  )

  return {
    subPath: resolvedSubPath,
    entries,
    maybeModalState,
    maybeAlertBanner,
  }
}

const activateStorageBackend = async (
  handle: FileSystemDirectoryHandle,
  type: StorageType,
  route: AppRoute,
  otherBackend: SavedBackend,
): Promise<Omit<typeof Message.SucceededInitializeStorage.Type, "_tag">> => {
  await saveDirectoryHandle(handle, type)
  const storage: StorageBackend = new FileSystemHandleStorage(handle, type)
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

const activateTauriStorageBackend = async (
  folderPath: string,
  route: AppRoute,
  otherBackend: SavedBackend,
): Promise<Omit<typeof Message.SucceededInitializeStorage.Type, "_tag">> => {
  await saveTauriFolder(folderPath)
  const storage: StorageBackend = new TauriStorage(folderPath)
  setActiveStorage(Option.some(storage))
  setSavedTauriFolder(Option.some(folderPath))

  const resolved = await resolveRouteDeepLink(storage, route)

  return {
    storageType: "tauri",
    rootName: storage.name,
    subPath: resolved.subPath,
    entries: resolved.entries,
    otherBackend,
    maybeModalState: resolved.maybeModalState,
    maybeAlertBanner: resolved.maybeAlertBanner,
  }
}

export const SaveHistoryEnabledPreference = Command.define("SaveHistoryEnabledPreference", {
  args: { isEnabled: Schema.Boolean },
  messages: [Message.CompletedSaveHistoryEnabledPreference],
  execute: (args) =>
    Effect.tryPromise({
      try: () => storeHistoryEnabled(args.isEnabled),
      catch: () => undefined,
    }).pipe(
      Effect.map(() => Message.CompletedSaveHistoryEnabledPreference()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveHistoryEnabledPreference())),
    ),
})

export const SaveApiHistoryEnabledPreference = Command.define("SaveApiHistoryEnabledPreference", {
  args: { isEnabled: Schema.Boolean },
  messages: [Message.CompletedSaveApiHistoryEnabledPreference],
  execute: (args) =>
    Effect.tryPromise({
      try: () => storeApiHistoryEnabled(args.isEnabled),
      catch: () => undefined,
    }).pipe(
      Effect.map(() => Message.CompletedSaveApiHistoryEnabledPreference()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveApiHistoryEnabledPreference())),
    ),
})

export const ClearAllHistory = Command.define("ClearAllHistory", {
  messages: [Message.SucceededClearAllHistory, Message.FailedClearAllHistory],
  execute: Effect.tryPromise({
    try: async () => {
      await clearAllFileHistory()
      return Message.SucceededClearAllHistory()
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.FailedClearAllHistory({
          message: `Alle Versionen konnten nicht gelöscht werden: ${error.message}`,
        }),
      ),
    ),
  ),
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

export const DetectLanguageModel = Command.define("DetectLanguageModel", {
  messages: [Message.CompletedDetectLanguageModel],
  execute: Effect.promise(() => detectLanguageModelAvailability()).pipe(
    Effect.map((isAvailable) => Message.CompletedDetectLanguageModel({ isAvailable })),
  ),
})

export const SaveLlmChatNames = Command.define("SaveLlmChatNames", {
  args: {
    aiName: Schema.String,
    userName: Schema.String,
  },
  messages: [Message.CompletedSaveLlmChatNames],
  execute: ({ aiName, userName }) =>
    Effect.tryPromise({
      try: () =>
        storeLlmChatNames({
          aiName: aiName.trim() || DEFAULT_LLM_CHAT_AI_NAME,
          userName: userName.trim() || DEFAULT_LLM_CHAT_USER_NAME,
        }),
      catch: () => new Error("Failed to save LLM chat names"),
    }).pipe(
      Effect.map(() => Message.CompletedSaveLlmChatNames()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveLlmChatNames())),
    ),
})

export const LoadLlmSettings = Command.define("LoadLlmSettings", {
  messages: [Message.CompletedLoadLlmSettings],
  execute: Effect.promise(() => getStoredLlmSettings()).pipe(
    Effect.map((settings) =>
      Message.CompletedLoadLlmSettings({
        enabled: settings.enabled,
        providers: [...(settings.providers ?? [])],
        activeProviderId: settings.activeProviderId ?? "",
        editFormat: settings.editFormat,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        models: settings.models,
        streaming: settings.streaming,
        toolCalls: settings.toolCalls,
        thinkingParam: settings.thinkingParam,
        thinkingLevels: settings.thinkingLevels,
        extraArgs: settings.extraArgs,
      }),
    ),
  ),
})

export const SaveLlmSettings = Command.define("SaveLlmSettings", {
  args: {
    enabled: Schema.Boolean,
    providers: Schema.Array(OpenAiProviderConfig),
    activeProviderId: Schema.String,
    editFormat: EditFormat,
    baseUrl: Schema.String,
    apiKey: Schema.String,
    models: Schema.String,
    modelFilter: Schema.optional(Schema.String),
    streaming: Schema.Boolean,
    toolCalls: Schema.Boolean,
    thinkingParam: Schema.String,
    thinkingLevels: Schema.String,
    extraArgs: Schema.String,
  },
  messages: [Message.CompletedSaveLlmSettings],
  execute: (args) =>
    Effect.tryPromise({
      try: () =>
        storeLlmSettings({
          enabled: args.enabled,
          providers: args.providers,
          activeProviderId: args.activeProviderId,
          editFormat: args.editFormat,
          baseUrl: args.baseUrl,
          apiKey: args.apiKey,
          models: args.models,
          streaming: args.streaming,
          toolCalls: args.toolCalls,
          thinkingParam: args.thinkingParam,
          thinkingLevels: args.thinkingLevels,
          extraArgs: args.extraArgs,
        }),
      catch: () => new Error("Failed to save LLM settings"),
    }).pipe(
      Effect.map(() => Message.CompletedSaveLlmSettings()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveLlmSettings())),
    ),
})

const applyAppThemeToDocument = (theme: AppTheme): void => {
  if (typeof document === "undefined") {
    return
  }
  if (theme === "system") {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

export const ApplyAppTheme = Command.define("ApplyAppTheme", {
  args: {
    theme: AppThemeSchema,
  },
  messages: [Message.CompletedApplyAppTheme],
  execute: ({ theme }) =>
    Effect.sync(() => {
      applyAppThemeToDocument(theme)
      return Message.CompletedApplyAppTheme()
    }),
})

export const SaveAppTheme = Command.define("SaveAppTheme", {
  args: {
    theme: AppThemeSchema,
  },
  messages: [Message.CompletedSaveAppTheme],
  execute: ({ theme }) =>
    Effect.tryPromise({
      try: async () => {
        applyAppThemeToDocument(theme)
        await storeAppTheme(theme)
      },
      catch: () => new Error("Failed to save app theme"),
    }).pipe(
      Effect.map(() => Message.CompletedSaveAppTheme()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveAppTheme())),
    ),
})

export const ApplyLanguage = Command.define("ApplyLanguage", {
  args: {
    language: LanguageSchema,
  },
  messages: [Message.CompletedApplyLanguage],
  execute: ({ language }) =>
    Effect.sync(() => {
      applyLanguageToDocument(language)
      return Message.CompletedApplyLanguage()
    }),
})

export const SaveLanguage = Command.define("SaveLanguage", {
  args: {
    language: LanguageSchema,
  },
  messages: [Message.CompletedSaveLanguage],
  execute: ({ language }) =>
    Effect.tryPromise({
      try: async () => {
        applyLanguageToDocument(language)
        await storeLanguage(language)
      },
      catch: () => new Error("Failed to save language"),
    }).pipe(
      Effect.map(() => Message.CompletedSaveLanguage()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveLanguage())),
    ),
})

export const SaveMonacoSettings = Command.define("SaveMonacoSettings", {
  args: {
    lineNumbers: Schema.Boolean,
    folding: Schema.Boolean,
    wordWrap: Schema.Boolean,
    scrollBeyondLastLine: Schema.Boolean,
    theme: MonacoThemeSchema,
    lineDecorationsWidth: Schema.Number,
    lineNumbersMinChars: Schema.Number,
    undoInTitlebar: Schema.Boolean,
  },
  messages: [Message.CompletedSaveMonacoSettings],
  execute: (args) =>
    Effect.tryPromise({
      try: () =>
        storeMonacoSettings({
          lineNumbers: args.lineNumbers,
          folding: args.folding,
          wordWrap: args.wordWrap,
          scrollBeyondLastLine: args.scrollBeyondLastLine,
          theme: args.theme,
          lineDecorationsWidth: args.lineDecorationsWidth,
          lineNumbersMinChars: args.lineNumbersMinChars,
          undoInTitlebar: args.undoInTitlebar,
        }),
      catch: () => new Error("Failed to save monaco settings"),
    }).pipe(
      Effect.map(() => Message.CompletedSaveMonacoSettings()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveMonacoSettings())),
    ),
})

export const LoadEditorPreferences = Command.define("LoadEditorPreferences", {
  messages: [Message.CompletedLoadEditorPreferences],
  execute: Effect.promise(() =>
    Promise.all([
      getStoredEditorPreferences(),
      getStoredHistoryEnabled(),
      getStoredApiHistoryEnabled(),
      getStoredMonacoSettings(),
      getStoredAppTheme(),
      getStoredLanguage(),
      getStoredLlmChatNames(),
    ]),
  ).pipe(
    Effect.map(
      ([
        prefs,
        historyEnabled,
        apiHistoryEnabled,
        monacoSettings,
        appTheme,
        maybeLanguage,
        llmChatNames,
      ]) =>
        Message.CompletedLoadEditorPreferences({
          llmBarMode: prefs.llmBarMode,
          llmModel: prefs.llmModel,
          llmThinkingLevel: prefs.llmThinkingLevel,
          editorSplitPercent: prefs.editorSplitPercent,
          historyEnabled,
          apiHistoryEnabled,
          monacoSettings,
          appTheme,
          ...(Option.isSome(maybeLanguage) ? { language: maybeLanguage.value } : {}),
          llmChatNames,
        }),
    ),
  ),
})

export const SaveEditorPreferences = Command.define("SaveEditorPreferences", {
  args: {
    llmBarMode: Editor.LlmBarMode,
    llmModel: Schema.String,
    llmThinkingLevel: Schema.String,
    editorSplitPercent: Schema.Number,
  },
  messages: [Message.CompletedSaveEditorPreferences],
  execute: (args) =>
    Effect.tryPromise({
      try: () =>
        storeEditorPreferences({
          llmBarMode: args.llmBarMode,
          llmModel: args.llmModel,
          llmThinkingLevel: args.llmThinkingLevel,
          editorSplitPercent: args.editorSplitPercent,
        }),
      catch: () => new Error("Failed to save editor preferences"),
    }).pipe(
      Effect.map(() => Message.CompletedSaveEditorPreferences()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveEditorPreferences())),
    ),
})

export const LoadEditorLlmModels = Command.define("LoadEditorLlmModels", {
  args: {
    providerId: Schema.optional(Schema.String),
    enabled: Schema.Boolean,
    editFormat: EditFormat,
    baseUrl: Schema.String,
    apiKey: Schema.String,
    models: Schema.String,
    modelFilter: Schema.optional(Schema.String),
    streaming: Schema.Boolean,
    toolCalls: Schema.Boolean,
    thinkingParam: Schema.String,
    thinkingLevels: Schema.String,
    extraArgs: Schema.String,
  },
  messages: [Message.SucceededLoadEditorLlmModels, Message.FailedLoadEditorLlmModels],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const models = await listModels(args)
        return Message.SucceededLoadEditorLlmModels({
          ...(args.providerId !== undefined ? { providerId: args.providerId } : {}),
          models,
        })
      },
      catch: () => new Error("Failed to load editor LLM models"),
    }).pipe(Effect.catch(() => Effect.succeed(Message.FailedLoadEditorLlmModels()))),
})

const toAgentEditorMessages = (
  messages: ReadonlyArray<Editor.LlmChatMessage>,
): ReadonlyArray<EditorChatMessage> =>
  Array.map(messages, (msg) =>
    Editor.LlmChatMessage.match(msg, {
      System: ({ content }) => ({ _tag: "System" as const, content }),
      User: ({ content }) => ({ _tag: "User" as const, content }),
      Assistant: ({ content, toolCalls }) => ({ _tag: "Assistant" as const, content, toolCalls }),
      Tool: ({ toolCallId, content }) => ({ _tag: "Tool" as const, toolCallId, content }),
    }),
  )

const toEditorSchemaMessages = (
  messages: ReadonlyArray<EditorChatMessage>,
): ReadonlyArray<Editor.LlmChatMessage> =>
  Array.map(messages, (msg) => {
    if (msg._tag === "System") {
      return Editor.LlmChatMessage.System({ content: msg.content })
    }
    if (msg._tag === "User") {
      return Editor.LlmChatMessage.User({ content: msg.content })
    }
    if (msg._tag === "Tool") {
      return Editor.LlmChatMessage.Tool({ toolCallId: msg.toolCallId, content: msg.content })
    }
    return Editor.LlmChatMessage.Assistant({
      content: msg.content,
      toolCalls: [...msg.toolCalls],
    })
  })

export const TestLlm = Command.define("TestLlm", {
  args: {
    mode: LlmTestMode,
    enabled: Schema.Boolean,
    editFormat: EditFormat,
    baseUrl: Schema.String,
    apiKey: Schema.String,
    models: Schema.String,
    modelFilter: Schema.optional(Schema.String),
    streaming: Schema.Boolean,
    toolCalls: Schema.Boolean,
    thinkingParam: Schema.String,
    thinkingLevels: Schema.String,
    extraArgs: Schema.String,
    model: Schema.String,
    thinkingLevel: Schema.String,
  },
  messages: [Message.SucceededTestLlm, Message.FailedTestLlm],
  execute: (args) =>
    Effect.tryPromise({
      try: () => testLlmConnection(args, args.mode),
      catch: (error) => (error instanceof Error ? error : new Error("Unbekannter Fehler")),
    }).pipe(
      Effect.map(({ content, reasoning, models }) =>
        Message.SucceededTestLlm({ content, reasoning, models }),
      ),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedTestLlm({ message: `Fehlgeschlagen: ${error.message}` })),
      ),
    ),
})

export const InitializeStorage = Command.define("InitializeStorage", {
  args: {
    hasDirectoryPicker: Schema.Boolean,
    hasOPFS: Schema.Boolean,
    hasTauri: Schema.Boolean,
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

        const determineTauriSavedBackend = async (): Promise<SavedBackend> => {
          if (!args.hasTauri) {
            return SavedBackend.Unsupported()
          }
          return await Option.match(await getSavedTauriFolder(), {
            onNone: async () => SavedBackend.NoFolderSelected(),
            onSome: async (savedFolderPath): Promise<SavedBackend> => {
              const isValid = await setTauriRootDirectory(savedFolderPath)
              if (isValid) {
                setSavedTauriFolder(Option.some(savedFolderPath))
                return SavedBackend.Granted({
                  rootName: folderNameFromPath(savedFolderPath),
                })
              }
              await clearSavedTauriFolder()
              return SavedBackend.NoFolderSelected()
            },
          })
        }

        if (Option.exists(maybeSavedType, (savedType) => savedType === "opfs") && args.hasOPFS) {
          const localSavedBackend = args.hasTauri
            ? await determineTauriSavedBackend()
            : await determineFsaSavedBackend()
          const opfsRoot = await getOPFSRootDirectory()
          return Message.SucceededInitializeStorage(
            await activateStorageBackend(opfsRoot, "opfs", args.route, localSavedBackend),
          )
        }

        if (args.hasTauri) {
          return await Option.match(await getSavedTauriFolder(), {
            onNone: async () =>
              Message.CompletedInitializeStorageNoFolderSelected({
                storageType: "tauri",
                otherBackend: opfsSavedBackend,
                pendingRoute: args.route,
              }),
            onSome: async (savedFolderPath) => {
              const isValid = await setTauriRootDirectory(savedFolderPath)
              if (isValid) {
                return Message.SucceededInitializeStorage(
                  await activateTauriStorageBackend(savedFolderPath, args.route, opfsSavedBackend),
                )
              }
              await clearSavedTauriFolder()
              return Message.CompletedInitializeStorageNoFolderSelected({
                storageType: "tauri",
                otherBackend: opfsSavedBackend,
                pendingRoute: args.route,
              })
            },
          })
        }

        if (args.hasDirectoryPicker) {
          return await Option.match(await getSavedDirectoryHandle(), {
            onNone: async () =>
              Message.CompletedInitializeStorageNoFolderSelected({
                storageType: "fsa",
                otherBackend: opfsSavedBackend,
                pendingRoute: args.route,
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
                pendingRoute: args.route,
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
          pendingRoute: args.route,
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

export const SaveStorageTypePreference = Command.define("SaveStorageTypePreference", {
  args: {
    storageType: StorageType,
  },
  messages: [Message.CompletedSaveStorageTypePreference],
  execute: ({ storageType }) =>
    Effect.tryPromise(() => saveStorageType(storageType)).pipe(
      Effect.map(() => Message.CompletedSaveStorageTypePreference()),
      Effect.catch(() => Effect.succeed(Message.CompletedSaveStorageTypePreference())),
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
        if (supportsTauri()) {
          const maybeFolderPath = await pickTauriDirectory()
          return await Option.match(maybeFolderPath, {
            onNone: () => Promise.resolve(Message.CancelledPickLocalDirectory()),
            onSome: async (folderPath) =>
              Message.SucceededPickLocalDirectory(
                await activateTauriStorageBackend(folderPath, args.route, args.otherBackend),
              ),
          })
        }
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
              pendingRoute: args.route,
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
        if (supportsTauri()) {
          const maybeCached = getSavedTauriFolderCached()
          const maybeFolderPath = Option.isSome(maybeCached)
            ? maybeCached
            : await getSavedTauriFolder()
          return await Option.match(maybeFolderPath, {
            onNone: async () =>
              Message.CompletedActivateFsaBackendNoFolderSelected({
                storageType: "tauri",
                otherBackend: args.otherBackend,
                pendingRoute: args.route,
              }),
            onSome: async (folderPath) => {
              const isValid = await setTauriRootDirectory(folderPath)
              if (isValid) {
                return Message.SucceededActivateFsaBackend(
                  await activateTauriStorageBackend(folderPath, args.route, args.otherBackend),
                )
              }
              await clearSavedTauriFolder()
              return Message.CompletedActivateFsaBackendNoFolderSelected({
                storageType: "tauri",
                otherBackend: args.otherBackend,
                pendingRoute: args.route,
              })
            },
          })
        }
        return await Option.match(await findCachedHandle({ includePending: false }), {
          onNone: async () => {
            return Message.CompletedActivateFsaBackendNoFolderSelected({
              storageType: "fsa",
              otherBackend: args.otherBackend,
              pendingRoute: args.route,
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
              pendingRoute: args.route,
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
    hasOPFS: Schema.Boolean,
  },
  messages: [Message.SucceededDisconnectStorage, Message.FailedDisconnectStorage],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const disconnectedStorageType: StorageType = Option.match(getActiveStorage(), {
          onNone: () => (supportsTauri() ? "tauri" : "fsa"),
          onSome: (active) => (active.type === "tauri" ? "tauri" : "fsa"),
        })
        revokeActivePreviewUrl()
        await Option.match(getActiveStorage(), {
          onNone: () => Promise.resolve(),
          onSome: (active) => active.disconnect(),
        })
        if (disconnectedStorageType === "tauri") {
          await clearSavedTauriFolder()
        } else {
          await clearSavedDirectoryHandle()
        }
        setActiveStorage(Option.none())
        setPendingHandle(Option.none())
        setSavedFsaHandle(Option.none())
        setSavedTauriFolder(Option.none())

        const opfsSavedBackend: SavedBackend = args.hasOPFS
          ? SavedBackend.Granted({ rootName: OPFS_APP_FOLDER })
          : SavedBackend.Unsupported()

        return Message.SucceededDisconnectStorage({
          storageType: disconnectedStorageType,
          otherBackend: opfsSavedBackend,
          pendingRoute: AppRoute.Folder({ subPath: [] }),
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

export const FocusIslandIframe = Command.define("FocusIslandIframe", {
  messages: [Message.CompletedFocusIslandIframe],
  execute: Dom.focus("#island-iframe").pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const el = document.getElementById("island-iframe")
        if (el instanceof HTMLIFrameElement) {
          el.contentWindow?.focus()
        }
      }),
    ),
    Effect.as(Message.CompletedFocusIslandIframe()),
    Effect.catch(() => Effect.succeed(Message.CompletedFocusIslandIframe())),
  ),
})

export const ScrollEditorLlmChatToBottomIfAtBottom = Command.define(
  "ScrollEditorLlmChatToBottomIfAtBottom",
  {
    messages: [Message.CompletedScrollEditorLlmChatToBottom],
    execute: Editor.scrollLlmChatToBottomIfAtBottom.pipe(
      Effect.as(Message.CompletedScrollEditorLlmChatToBottom()),
    ),
  },
)

export const MinimizeWindow = Command.define("MinimizeWindow", {
  messages: [Message.CompletedMinimizeWindow],
  execute: Effect.tryPromise({
    try: () => minimizeWindow(),
    catch: () => new Error("minimize failed"),
  }).pipe(
    Effect.as(Message.CompletedMinimizeWindow()),
    Effect.catch(() => Effect.succeed(Message.CompletedMinimizeWindow())),
  ),
})

export const ToggleMaximizeWindow = Command.define("ToggleMaximizeWindow", {
  messages: [Message.CompletedToggleMaximizeWindow],
  execute: Effect.tryPromise({
    try: () => toggleMaximizeWindow(),
    catch: () => new Error("toggleMaximize failed"),
  }).pipe(
    Effect.as(Message.CompletedToggleMaximizeWindow()),
    Effect.catch(() => Effect.succeed(Message.CompletedToggleMaximizeWindow())),
  ),
})

export const ToggleFullscreenWindow = Command.define("ToggleFullscreenWindow", {
  messages: [Message.CompletedToggleFullscreen],
  execute: Effect.tryPromise({
    try: () => toggleFullscreenWindow(),
    catch: () => new Error("toggleFullscreen failed"),
  }).pipe(
    Effect.as(Message.CompletedToggleFullscreen()),
    Effect.catch(() => Effect.succeed(Message.CompletedToggleFullscreen())),
  ),
})

export const ExitFullscreenWindow = Command.define("ExitFullscreenWindow", {
  messages: [Message.CompletedToggleFullscreen],
  execute: Effect.tryPromise({
    try: () => exitFullscreenWindow(),
    catch: () => new Error("exitFullscreen failed"),
  }).pipe(
    Effect.as(Message.CompletedToggleFullscreen()),
    Effect.catch(() => Effect.succeed(Message.CompletedToggleFullscreen())),
  ),
})

export const CloseWindow = Command.define("CloseWindow", {
  messages: [Message.CompletedCloseWindow],
  execute: Effect.tryPromise({
    try: () => closeWindow(),
    catch: () => new Error("close failed"),
  }).pipe(
    Effect.as(Message.CompletedCloseWindow()),
    Effect.catch(() => Effect.succeed(Message.CompletedCloseWindow())),
  ),
})

export const WaitBeforeDismissToast = Command.define("WaitBeforeDismissToast", {
  args: {
    id: Schema.Number,
  },
  messages: [Message.CompletedWaitBeforeDismissToast],
  execute: ({ id }) =>
    Effect.sleep(Duration.seconds(6)).pipe(
      Effect.as(Message.CompletedWaitBeforeDismissToast({ id })),
    ),
})

export const CopyToastMessage = Command.define("CopyToastMessage", {
  args: {
    message: Schema.String,
  },
  messages: [Message.CompletedCopyToast],
  execute: ({ message }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(message)
        return Message.CompletedCopyToast()
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedCopyToast()))),
})

export const ScheduleReturnArrowClick = Command.define("ScheduleReturnArrowClick", {
  args: {
    clickId: Schema.Number,
  },
  messages: [Message.CompletedReturnArrowClickDelay],
  execute: ({ clickId }) =>
    Effect.sleep("250 millis").pipe(
      Effect.map(() => Message.CompletedReturnArrowClickDelay({ clickId })),
    ),
})

export const ResolveIslandBackNavigation = Command.define("ResolveIslandBackNavigation", {
  args: {
    folderSubPath: Schema.Array(Schema.String),
    fileName: Schema.String,
  },
  messages: [Message.CompletedResolveIslandBackNavigation],
  execute: ({ folderSubPath, fileName }) =>
    Effect.tryPromise({
      try: async () => {
        let storage: StorageBackend | null = null
        try {
          storage = requireActiveStorage()
        } catch {
          storage = null
        }

        if (fileName === "index.html") {
          if (folderSubPath.length === 0) {
            return Message.CompletedResolveIslandBackNavigation({
              targetUrl: "",
              isIsland: false,
              subPath: [],
              shouldNavigate: false,
            })
          }
          const parentSubPath = Array.dropRight(folderSubPath, 1)
          const exists = storage
            ? await checkFileExists(storage, parentSubPath, "index.html")
            : false
          if (exists) {
            const parentPathPart = encodeSubPath(parentSubPath)
            const targetUrl = parentPathPart !== "" ? `/${parentPathPart}` : "/index.html"
            return Message.CompletedResolveIslandBackNavigation({
              targetUrl,
              isIsland: true,
              subPath: parentSubPath,
              shouldNavigate: true,
            })
          }
          return Message.CompletedResolveIslandBackNavigation({
            targetUrl: buildFolderUrl(folderSubPath),
            isIsland: false,
            subPath: folderSubPath,
            shouldNavigate: true,
          })
        }

        const exists = storage ? await checkFileExists(storage, folderSubPath, "index.html") : false
        if (exists) {
          const pathPart = encodeSubPath(folderSubPath)
          const targetUrl = pathPart !== "" ? `/${pathPart}` : "/index.html"
          return Message.CompletedResolveIslandBackNavigation({
            targetUrl,
            isIsland: true,
            subPath: folderSubPath,
            shouldNavigate: true,
          })
        }
        return Message.CompletedResolveIslandBackNavigation({
          targetUrl: buildFolderUrl(folderSubPath),
          isIsland: false,
          subPath: folderSubPath,
          shouldNavigate: true,
        })
      },
      catch: () => new Error("Fehler beim Prüfen der Island-Rücknavigation"),
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.CompletedResolveIslandBackNavigation({
            targetUrl: buildFolderUrl(folderSubPath),
            isIsland: false,
            subPath: folderSubPath,
            shouldNavigate: folderSubPath.length > 0 || fileName !== "index.html",
          }),
        ),
      ),
    ),
})

const postIslandIpcResponse = (payload: {
  readonly requestId: string
  readonly ok: boolean
  readonly error?: string
}): void => {
  const el = document.getElementById("island-iframe")
  if (el instanceof HTMLIFrameElement) {
    el.contentWindow?.postMessage(
      {
        type: "pwaislands:ipc-response",
        ...payload,
      },
      "*",
    )
  }
}

export const HandleIslandIpcRequest = Command.define("HandleIslandIpcRequest", {
  args: {
    requestId: Schema.String,
    action: IslandIpcAction,
  },
  messages: [Message.CompletedHandleIslandIpcRequest],
  execute: (args) =>
    Effect.gen(function* () {
      const timestampMs = yield* Clock.currentTimeMillis
      return yield* Effect.tryPromise({
        try: async () => {
          await IslandIpcAction.match(args.action, {
            Write: async ({ subPath, data }) => {
              await recordPreviousTauriApiFileVersion(subPath, timestampMs)
              await invoke("tauri_fs_write_file", {
                subPath,
                data: [...data],
              })
            },
            MakeDir: ({ subPath }) =>
              invoke("tauri_fs_create_dir", {
                subPath,
              }),
            Rename: async ({ from, to }) => {
              await recordPreviousTauriApiFileVersion(to, timestampMs)
              await invoke("tauri_fs_rename", {
                fromSubPath: from,
                toSubPath: to,
              })
            },
            Remove: async ({ subPath, recursive }) => {
              await recordPreviousTauriApiFileVersion(subPath, timestampMs)
              await invoke("tauri_fs_remove_entry", {
                subPath,
                isDirectory: recursive,
              })
            },
            Copy: async ({ from, to }) => {
              await recordPreviousTauriApiFileVersion(to, timestampMs)
              await invoke("tauri_fs_copy", {
                fromSubPath: from,
                toSubPath: to,
              })
            },
          })
          postIslandIpcResponse({
            requestId: args.requestId,
            ok: true,
          })
          return Message.CompletedHandleIslandIpcRequest()
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            postIslandIpcResponse({
              requestId: args.requestId,
              ok: false,
              error: error.message || String(error),
            })
            return Message.CompletedHandleIslandIpcRequest()
          }),
        ),
      )
    }),
})

export const NavigateHistoryBack = Command.define("NavigateHistoryBack", {
  messages: [Message.CompletedNavigateHistoryBack],
  execute: Navigation.back().pipe(Effect.as(Message.CompletedNavigateHistoryBack())),
})

export const NavigateHistoryForward = Command.define("NavigateHistoryForward", {
  messages: [Message.CompletedNavigateHistoryForward],
  execute: Navigation.forward().pipe(Effect.as(Message.CompletedNavigateHistoryForward())),
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

// INIT

export const init = (
  flags: Flags,
  url: Url,
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} => {
  const isSupported = flags.hasTauri || flags.hasDirectoryPicker || flags.hasOPFS
  const initialRoute = parseUrlToRoute(url)
  const isInitialSettingsOpen = initialRoute._tag === "Settings"
  const maybeInitialModal: Option.Option<Modal.ModalState> = Modal.initFromRoute(initialRoute)

  if (!isSupported) {
    return {
      model: {
        hasDirectoryPicker: false,
        hasOPFS: false,
        hasTauri: false,
        hasLanguageModel: false,
        isWindowsOrLinux: flags.isWindowsOrLinux ?? (flags.hasTauri && isWindowsOrLinux()),
        isWindows: flags.isWindows ?? (flags.hasTauri && isWindows()),
        isWindowFocused: true,
        isWindowMaximized: flags.isWindowMaximized ?? false,
        isWindowFullscreen: flags.isWindowFullscreen ?? false,
        origin: flags.origin,
        storageState: StorageState.Unsupported(),
        showFileInfo: true,
        isSettingsOpen: false,
        isSettingsDialogOpen: isInitialSettingsOpen,
        isEditingLlmSettings: false,
        isConfirmingDeleteLlmProvider: false,
        editingLlmProviderId: Option.none(),
        llmProviders: [],
        llmActiveProviderId: "",
        llmEnabled: false,
        llmEditFormat: DEFAULT_EDIT_FORMAT,
        llmBaseUrl: "",
        llmApiKey: "",
        llmModels: "",
        llmStreaming: true,
        llmToolCalls: true,
        llmThinkingParam: emptyLlmSettings.thinkingParam,
        llmThinkingLevels: emptyLlmSettings.thinkingLevels,
        llmExtraArgs: "",
        llmModel: "",
        llmThinkingLevel: "",
        llmChatAiName: DEFAULT_LLM_CHAT_AI_NAME,
        llmChatUserName: DEFAULT_LLM_CHAT_USER_NAME,
        llmDiscoveredModels: [],
        hasLoadedEditorLlmModels: false,
        editorLlmBarMode: "Closed",
        editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
        llmDraftEnabled: false,
        llmDraftName: "",
        llmDraftProviderEnabled: true,
        llmDraftProviderEditFormat: "",
        llmDraftEditFormat: DEFAULT_EDIT_FORMAT,
        llmDraftBaseUrl: "",
        llmDraftApiKey: "",
        llmDraftModels: "",
        llmDraftModelFilter: "",
        llmDraftStreaming: true,
        llmDraftToolCalls: true,
        llmDraftThinkingParam: emptyLlmSettings.thinkingParam,
        llmDraftThinkingLevels: emptyLlmSettings.thinkingLevels,
        llmDraftExtraArgs: "",
        llmDraftModel: "",
        llmDraftThinkingLevel: "",
        llmTestState: LlmTestState.Idle(),
        historyEnabled: true,
        apiHistoryEnabled: true,
        appTheme: "system",
        language: flags.language ?? "en",
        editorLineNumbers: defaultMonacoSettings.lineNumbers,
        editorFolding: defaultMonacoSettings.folding,
        editorWordWrap: defaultMonacoSettings.wordWrap,
        editorScrollBeyondLastLine: defaultMonacoSettings.scrollBeyondLastLine,
        editorTheme: defaultMonacoSettings.theme,
        editorLineDecorationsWidth: defaultMonacoSettings.lineDecorationsWidth,
        editorLineNumbersMinChars: defaultMonacoSettings.lineNumbersMinChars,
        editorUndoInTitlebar: defaultMonacoSettings.undoInTitlebar,
        clearAllHistoryState: ClearAllHistoryState.Idle(),
        installPrompt: InstallPrompt.Unavailable(),
        modalState: Option.getOrElse(maybeInitialModal, Modal.close),
        toasts: [
          {
            id: 1,
            message:
              "Ihr Browser unterstützt weder die File System Access API noch das Origin Private File System (OPFS).",
            variant: "warning",
          },
        ],
        nextToastId: 2,
        maybeActiveIslandUrl: Option.none(),
        maybeActiveIslandPath: Option.none(),
        returnClickId: 0,
      },
    }
  }

  return {
    model: {
      hasDirectoryPicker: flags.hasDirectoryPicker,
      hasOPFS: flags.hasOPFS,
      hasTauri: flags.hasTauri,
      hasLanguageModel: false,
      isWindowsOrLinux: flags.isWindowsOrLinux ?? (flags.hasTauri && isWindowsOrLinux()),
      isWindows: flags.isWindows ?? (flags.hasTauri && isWindows()),
      isWindowFocused: true,
      isWindowMaximized: flags.isWindowMaximized ?? false,
      isWindowFullscreen: flags.isWindowFullscreen ?? false,
      origin: flags.origin,
      storageState: StorageState.Initializing(),
      showFileInfo: true,
      isSettingsOpen: false,
      isSettingsDialogOpen: isInitialSettingsOpen,
      isEditingLlmSettings: false,
      isConfirmingDeleteLlmProvider: false,
      editingLlmProviderId: Option.none(),
      llmProviders: [],
      llmActiveProviderId: "",
      llmEnabled: false,
      llmEditFormat: DEFAULT_EDIT_FORMAT,
      llmBaseUrl: "",
      llmApiKey: "",
      llmModels: "",
      llmStreaming: true,
      llmToolCalls: true,
      llmThinkingParam: emptyLlmSettings.thinkingParam,
      llmThinkingLevels: emptyLlmSettings.thinkingLevels,
      llmExtraArgs: "",
      llmModel: "",
      llmThinkingLevel: "",
      llmChatAiName: DEFAULT_LLM_CHAT_AI_NAME,
      llmChatUserName: DEFAULT_LLM_CHAT_USER_NAME,
      llmDiscoveredModels: [],
      hasLoadedEditorLlmModels: false,
      editorLlmBarMode: "Closed",
      editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
      llmDraftEnabled: false,
      llmDraftName: "",
      llmDraftProviderEnabled: true,
      llmDraftProviderEditFormat: "",
      llmDraftEditFormat: DEFAULT_EDIT_FORMAT,
      llmDraftBaseUrl: "",
      llmDraftApiKey: "",
      llmDraftModels: "",
      llmDraftModelFilter: "",
      llmDraftStreaming: true,
      llmDraftToolCalls: true,
      llmDraftThinkingParam: emptyLlmSettings.thinkingParam,
      llmDraftThinkingLevels: emptyLlmSettings.thinkingLevels,
      llmDraftExtraArgs: "",
      llmDraftModel: "",
      llmDraftThinkingLevel: "",
      llmTestState: LlmTestState.Idle(),
      historyEnabled: true,
      apiHistoryEnabled: true,
      appTheme: "system",
      language: flags.language ?? "en",
      editorLineNumbers: defaultMonacoSettings.lineNumbers,
      editorFolding: defaultMonacoSettings.folding,
      editorWordWrap: defaultMonacoSettings.wordWrap,
      editorScrollBeyondLastLine: defaultMonacoSettings.scrollBeyondLastLine,
      editorTheme: defaultMonacoSettings.theme,
      editorLineDecorationsWidth: defaultMonacoSettings.lineDecorationsWidth,
      editorLineNumbersMinChars: defaultMonacoSettings.lineNumbersMinChars,
      editorUndoInTitlebar: defaultMonacoSettings.undoInTitlebar,
      clearAllHistoryState: ClearAllHistoryState.Idle(),
      installPrompt: InstallPrompt.Unavailable(),
      modalState: Option.getOrElse(maybeInitialModal, Modal.close),
      toasts: [],
      nextToastId: 1,
      maybeActiveIslandUrl: Option.none(),
      maybeActiveIslandPath: Option.none(),
      returnClickId: 0,
    },
    commands: [
      InitializeStorage({
        hasDirectoryPicker: flags.hasDirectoryPicker,
        hasOPFS: flags.hasOPFS,
        hasTauri: flags.hasTauri,
        route: initialRoute,
      }),
      LoadFileInfoPreference(),
      LoadLlmSettings(),
      LoadEditorPreferences(),
      DetectLanguageModel(),
    ],
  }
}

// UPDATE

const isFileEditorModal = (modalState: Modal.ModalState): boolean =>
  Match.value(modalState).pipe(
    Match.tag("Editor", ({ editor }) => editor._tag === "CreateFile" || editor._tag === "EditFile"),
    Match.orElse(() => false),
  )

const syncOpenEditor = (
  model: Model,
  extraCommands: ReadonlyArray<Command.Command<Message>> = [],
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} => {
  if (!isFileEditorModal(model.modalState)) {
    return Array.isReadonlyArrayNonEmpty(extraCommands)
      ? { model, commands: extraCommands }
      : { model }
  }

  return Array.isReadonlyArrayNonEmpty(extraCommands)
    ? { model, commands: extraCommands }
    : { model }
}

const enqueueToast = (
  model: Model,
  banner: AlertBanner,
  options?: { readonly autoDismiss?: boolean },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} => {
  const existingIndex = Array.findFirstIndex(
    model.toasts,
    (existing) => existing.message === banner.message && existing.variant === banner.variant,
  )
  if (Option.isSome(existingIndex)) {
    return {
      model: modifyFields(model, {
        toasts: (toasts) =>
          Array.map(toasts, (existing, index) =>
            index === existingIndex.value
              ? {
                  id: existing.id,
                  message: existing.message,
                  variant: existing.variant,
                  count: (existing.count ?? 1) + 1,
                }
              : existing,
          ),
      }),
    }
  }

  const toastId = model.nextToastId
  const toast: Toast = {
    id: toastId,
    message: banner.message,
    variant: banner.variant,
  }
  const nextModel = modifyFields(model, {
    toasts: (toasts) => [...toasts, toast],
    nextToastId: (id) => id + 1,
  })
  const shouldAutoDismiss = options?.autoDismiss ?? banner.variant === "info"
  if (shouldAutoDismiss) {
    return {
      model: nextModel,
      commands: [WaitBeforeDismissToast({ id: toastId })],
    }
  }
  return { model: nextModel }
}

const enqueueMaybeToast = (
  model: Model,
  maybeBanner: Option.Option<AlertBanner>,
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} =>
  Option.match(maybeBanner, {
    onNone: () => ({ model }),
    onSome: (banner) => enqueueToast(model, banner),
  })

const saveMonacoSettingsCommand = (model: Model) =>
  SaveMonacoSettings({
    lineNumbers: model.editorLineNumbers,
    folding: model.editorFolding,
    wordWrap: model.editorWordWrap,
    scrollBeyondLastLine: model.editorScrollBeyondLastLine,
    theme: model.editorTheme,
    lineDecorationsWidth: model.editorLineDecorationsWidth,
    lineNumbersMinChars: model.editorLineNumbersMinChars,
    undoInTitlebar: model.editorUndoInTitlebar,
  })

const parseRangeNumber = (raw: string, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(max, Math.max(min, parsed))
}

const openSettingsDialogModel = (model: Model): Model =>
  modifyFields(model, {
    isSettingsOpen: () => false,
    isSettingsDialogOpen: () => true,
    isEditingLlmSettings: () => false,
    llmDraftEnabled: () => model.llmEnabled,
    llmDraftEditFormat: () => model.llmEditFormat,
    llmDraftBaseUrl: () => model.llmBaseUrl,
    llmDraftApiKey: () => model.llmApiKey,
    llmDraftModels: () => model.llmModels,
    llmDraftStreaming: () => model.llmStreaming,
    llmDraftToolCalls: () => model.llmToolCalls,
    llmDraftThinkingParam: () => model.llmThinkingParam,
    llmDraftThinkingLevels: () => model.llmThinkingLevels,
    llmDraftExtraArgs: () => model.llmExtraArgs,
    llmDraftModel: () => model.llmModel,
    llmDraftThinkingLevel: () => model.llmThinkingLevel,
    llmTestState: () => LlmTestState.Idle(),
    clearAllHistoryState: () => ClearAllHistoryState.Idle(),
  })

const handleStorageActivated = (
  model: Model,
  payload: {
    readonly storageType: StorageType
    readonly rootName: string
    readonly subPath: ReadonlyArray<string>
    readonly entries: ReadonlyArray<FileEntry>
    readonly otherBackend: SavedBackend
    readonly maybeModalState: Option.Option<Modal.ModalState>
    readonly maybeAlertBanner: Option.Option<AlertBanner>
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} => {
  const readyStorage = StorageState.Ready({
    storageType: payload.storageType,
    rootName: payload.rootName,
    subPath: payload.subPath,
    entriesState: EntriesState.Loaded({ entries: payload.entries }),
    otherBackend: payload.otherBackend,
  })

  const baseModel = modifyFields(model, {
    storageState: () => readyStorage,
    modalState: () =>
      Option.match(payload.maybeModalState, {
        onNone: () => model.modalState,
        onSome: (modal) =>
          Modal.applyEditorPreferences(modal, {
            llmBarMode: model.editorLlmBarMode,
            editorSplitPercent: model.editorSplitPercent,
          }),
      }),
  })
  const toastResult = enqueueMaybeToast(baseModel, payload.maybeAlertBanner)

  const editorFocusCommands: ReadonlyArray<Command.Command<Message>> = Option.exists(
    payload.maybeModalState,
    (modal) => modal._tag === "Editor",
  )
    ? [toModalCommand(Modal.FocusModalNameInput())]
    : []

  return syncOpenEditor(toastResult.model, [
    ...editorFocusCommands,
    ...(toastResult.commands ?? []),
  ])
}

const handlePermissionRequired = (
  model: Model,
  payload: {
    readonly storageType: StorageType
    readonly folderName: string
    readonly otherBackend: SavedBackend
    readonly pendingRoute: AppRoute
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} => ({
  model: modifyFields(model, {
    storageState: () =>
      StorageState.PermissionRequired({
        storageType: payload.storageType,
        folderName: payload.folderName,
        otherBackend: payload.otherBackend,
        pendingRoute: payload.pendingRoute,
      }),
  }),
})

const handleNoFolderSelected = (
  model: Model,
  payload: {
    readonly storageType: StorageType
    readonly otherBackend: SavedBackend
    readonly pendingRoute: AppRoute
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} => ({
  model: modifyFields(model, {
    storageState: () =>
      StorageState.NoFolderSelected({
        storageType: payload.storageType,
        otherBackend: payload.otherBackend,
        pendingRoute: payload.pendingRoute,
      }),
  }),
})

const whenReady = (
  model: Model,
  fn: (readyState: ReadyStorageState) => {
    readonly model: Model
    readonly commands?: ReadonlyArray<Command.Command<Message>>
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} =>
  Match.value(model.storageState).pipe(
    Match.tag("Ready", (readyState) => {
      const res = fn(readyState)
      return { model: res.model, commands: res.commands ?? [] }
    }),
    Match.orElse(() => ({ model })),
  )

const isReadyStorage = (storageState: StorageState): boolean =>
  StorageState.match(storageState, {
    Initializing: () => false,
    Unsupported: () => false,
    NoFolderSelected: () => false,
    PermissionRequired: () => false,
    Ready: () => true,
  })

const isSameSubPath = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  Array.length(a) === Array.length(b) && Array.every(a, (segment, index) => segment === b[index])

const getOtherBackend = (storageState: StorageState): SavedBackend =>
  StorageState.match(storageState, {
    Initializing: () => SavedBackend.NoFolderSelected(),
    Unsupported: () => SavedBackend.Unsupported(),
    NoFolderSelected: (s) => s.otherBackend,
    PermissionRequired: (s) => s.otherBackend,
    Ready: (s) => s.otherBackend,
  })

const isLocalFolderStorage = (storageType: StorageType): boolean =>
  storageType === "fsa" || storageType === "tauri"

const handleUseFsa = (
  model: Model,
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} => {
  const localStorageType: StorageType = model.hasTauri ? "tauri" : "fsa"
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
            storageType: localStorageType,
            folderName,
            otherBackend: opfsSavedBackend,
            pendingRoute: AppRoute.Folder({ subPath: [] }),
          }),
        isSettingsOpen: () => false,
      }),
      commands: [
        SaveStorageTypePreference({ storageType: localStorageType }),
        PushUrl({ url: buildFolderUrl([]) }),
      ],
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

const isChatAvailable = (model: Model): boolean => model.llmEnabled || model.hasLanguageModel

const resolveModelOptionsForModel = (model: Model, activeModel: string) => {
  if (model.llmEnabled && model.llmProviders.length > 0) {
    const discoveredByProvider: Record<string, ReadonlyArray<string>> = model.llmDiscoveredModels
      .length > 0 && model.llmProviders[0] !== undefined
      ? { [model.llmProviders[0].id]: model.llmDiscoveredModels }
      : {}
    return resolveAllProviderModelOptions(
      model.llmProviders,
      discoveredByProvider,
      activeModel,
      model.hasLanguageModel,
    )
  }
  return resolveModelOptions(
    model.llmEnabled ? model.llmModels : "",
    model.llmEnabled ? model.llmDiscoveredModels : [],
    model.llmEnabled ? activeModel : "",
    model.hasLanguageModel,
  )
}

const resolveValidThinkingLevel = (
  model: Model,
  selectedModel: string,
  currentLevel: string,
): string => {
  if (isLanguageModelSelection(selectedModel) || currentLevel === "") {
    return ""
  }
  const provider =
    model.llmProviders.length > 0
      ? resolveProviderForModelSelection(model.llmProviders, selectedModel)
      : undefined
  const thinkingParam = provider?.thinkingParam ?? model.llmThinkingParam
  const thinkingLevelsRaw = provider?.thinkingLevels ?? model.llmThinkingLevels
  if (thinkingParam.trim() === "") {
    return ""
  }
  const validLevels = parseThinkingLevels(thinkingLevelsRaw)
  return validLevels.some((item) => item.value === currentLevel) ? currentLevel : ""
}

const resolveEffectiveLlmModel = (model: Model): string => {
  const modelOptions = resolveModelOptionsForModel(model, model.llmModel)
  if (model.llmEnabled && model.llmModel.trim() !== "") {
    return model.llmModel.trim()
  }
  return modelOptions[0]?.value ?? ""
}

const maybeLoadEditorLlmModels = (
  model: Model,
): { readonly model: Model; readonly commands?: ReadonlyArray<Command.Command<Message>> } => {
  if (!model.llmEnabled || model.hasLoadedEditorLlmModels) {
    return { model }
  }
  if (model.llmProviders.length > 0) {
    const targetProvider = resolveProviderForModelSelection(
      model.llmProviders,
      resolveEffectiveLlmModel(model),
    )
    if (
      targetProvider === undefined ||
      !targetProvider.enabled ||
      targetProvider.baseUrl.trim() === ""
    ) {
      return { model }
    }
    return {
      model: modifyFields(model, {
        hasLoadedEditorLlmModels: () => true,
      }),
      commands: [
        LoadEditorLlmModels({
          providerId: targetProvider.id,
          enabled: targetProvider.enabled,
          editFormat:
            targetProvider.editFormat !== "" ? targetProvider.editFormat : model.llmEditFormat,
          baseUrl: targetProvider.baseUrl,
          apiKey: targetProvider.apiKey,
          models: targetProvider.models,
          ...(targetProvider.modelFilter !== undefined && targetProvider.modelFilter !== ""
            ? { modelFilter: targetProvider.modelFilter }
            : {}),
          streaming: targetProvider.streaming,
          toolCalls: targetProvider.toolCalls,
          thinkingParam: targetProvider.thinkingParam,
          thinkingLevels: targetProvider.thinkingLevels,
          extraArgs: targetProvider.extraArgs,
        }),
      ],
    }
  }

  const shouldLoad = model.llmBaseUrl.trim() !== ""

  if (!shouldLoad) {
    return { model }
  }

  return {
    model: modifyFields(model, {
      hasLoadedEditorLlmModels: () => true,
    }),
    commands: [
      LoadEditorLlmModels({
        enabled: model.llmEnabled,
        editFormat: model.llmEditFormat,
        baseUrl: model.llmBaseUrl,
        apiKey: model.llmApiKey,
        models: model.llmModels,
        streaming: model.llmStreaming,
        toolCalls: model.llmToolCalls,
        thinkingParam: model.llmThinkingParam,
        thinkingLevels: model.llmThinkingLevels,
        extraArgs: model.llmExtraArgs,
      }),
    ],
  }
}

const mapLoadedEntries = (
  storageState: StorageState,
  transform: (entries: ReadonlyArray<FileEntry>) => ReadonlyArray<FileEntry>,
): StorageState =>
  Match.value(storageState).pipe(
    Match.tag("Ready", (readyState) =>
      EntriesState.match(readyState.entriesState, {
        Loading: () => readyState,
        Error: () => readyState,
        Loaded: ({ entries }) =>
          modifyFields(readyState, {
            entriesState: () => EntriesState.Loaded({ entries: transform(entries) }),
          }),
      }),
    ),
    Match.orElse(() => storageState),
  )

export const update = (
  model: Model,
  message: Message,
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
} =>
  Message.match(message, {
    // Initialization & Storage Backend Lifecycle
    SucceededInitializeStorage: (payload) => handleStorageActivated(model, payload),
    CompletedInitializeStoragePermissionRequired: (payload) =>
      handlePermissionRequired(model, payload),
    CompletedInitializeStorageNoFolderSelected: (payload) => handleNoFolderSelected(model, payload),
    FailedInitializeStorage: ({ message: errorMessage }) =>
      enqueueToast(model, {
        message: errorMessage,
        variant: "danger",
      }),
    CompletedLoadFileInfoPreference: ({ visible }) => ({
      model: modifyFields(model, {
        showFileInfo: () => visible,
      }),
    }),
    CompletedSaveFileInfoPreference: () => ({ model }),
    CompletedSaveStorageTypePreference: () => ({ model }),

    // Directory Listing & Navigation
    SucceededRefreshEntries: ({ subPath, entries }) =>
      whenReady(model, (readyState) => ({
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              subPath: () => subPath,
              entriesState: () => EntriesState.Loaded({ entries }),
            }),
        }),
      })),

    FailedRefreshEntries: ({ message: errorMessage }) =>
      whenReady(model, (readyState) => ({
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              entriesState: () => EntriesState.Error({ message: errorMessage }),
            }),
        }),
      })),

    SucceededNavigateToSubfolder: ({ subPath, entries }) =>
      whenReady(model, (readyState) => ({
        model: modifyFields(model, {
          storageState: () =>
            modifyFields(readyState, {
              subPath: () => subPath,
              entriesState: () => EntriesState.Loaded({ entries }),
            }),
        }),
      })),

    FailedNavigateToSubfolder: ({ message: errorMessage }) =>
      enqueueToast(model, {
        message: errorMessage,
        variant: "danger",
      }),

    ClickedRetryList: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model,
        commands: [RefreshEntries({ subPath })],
      }
    },

    ClickedDismissToast: ({ id }) => ({
      model: modifyFields(model, {
        toasts: (toasts) => Array.filter(toasts, (toast) => toast.id !== id),
      }),
    }),

    ClickedCopyToast: ({ message }) => ({
      model,
      commands: [CopyToastMessage({ message })],
    }),

    CompletedCopyToast: () => ({ model }),

    CompletedWaitBeforeDismissToast: ({ id }) => ({
      model: modifyFields(model, {
        toasts: (toasts) => Array.filter(toasts, (toast) => toast.id !== id),
      }),
    }),

    ClickedBreadcrumbRoot: () => ({
      model: modifyFields(model, {}),
      commands: [PushUrl({ url: buildFolderUrl([]) })],
    }),

    ClickedBreadcrumbSegment: ({ index }) => {
      const currentSubPath = currentSubPathFromStorageState(model.storageState)
      const targetSubPath = Array.take(currentSubPath, index + 1)
      return {
        model: modifyFields(model, {}),
        commands: [PushUrl({ url: buildFolderUrl(targetSubPath) })],
      }
    },

    ClickedEntryRow: ({ entry }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      if (entry.isDeleted) {
        return {
          model,
          commands: [PushUrl({ url: buildHistoryUrl(subPath, entry.name) })],
        }
      }
      if (entry.kind === "directory") {
        const targetSubPath = [...subPath, entry.name]
        return {
          model: modifyFields(model, {}),
          commands: [PushUrl({ url: buildFolderUrl(targetSubPath) })],
        }
      }
      if (isTauriStorageState(model.storageState)) {
        const islandUrl = buildTauriIslandUrl(subPath, entry.name)
        const fileUrl = `/${encodeSubPath([...subPath, entry.name])}`
        return {
          model: modifyFields(model, {
            maybeActiveIslandUrl: () => Option.some(islandUrl),
            maybeActiveIslandPath: () => Option.some(fileUrl),
          }),
          commands: [PushUrl({ url: fileUrl })],
        }
      }
      return {
        model: modifyFields(model, {}),
        commands: [
          OpenFileInBrowser({
            subPath,
            fileName: entry.name,
          }),
        ],
      }
    },

    CompletedOpenFileInBrowser: () => ({ model }),

    LoadedIslandIframe: () => ({
      model,
      commands: [FocusIslandIframe()],
    }),

    CompletedFocusIslandIframe: () => ({ model }),

    ClickedReturnArrow: () => {
      const nextClickId = model.returnClickId + 1
      return {
        model: modifyFields(model, {
          returnClickId: () => nextClickId,
        }),
        commands: [ScheduleReturnArrowClick({ clickId: nextClickId })],
      }
    },

    DoubleClickedReturnArrow: () => {
      const nextClickId = model.returnClickId + 1
      if (Option.isNone(model.maybeActiveIslandUrl)) {
        const currentSubPath = currentSubPathFromStorageState(model.storageState)
        if (currentSubPath.length === 0) {
          return {
            model: modifyFields(model, {
              returnClickId: () => nextClickId,
            }),
          }
        }
        const parentSubPath = Array.dropRight(currentSubPath, 1)
        const targetUrl = buildFolderUrl(parentSubPath)
        return {
          model: modifyFields(model, {
            returnClickId: () => nextClickId,
          }),
          commands: [PushUrl({ url: targetUrl }), RefreshEntries({ subPath: parentSubPath })],
        }
      }

      const activePath = Option.getOrElse(model.maybeActiveIslandPath, () => "")
      const { folderSubPath } = parseIslandPath(activePath)
      const targetUrl = buildFolderUrl(folderSubPath)
      return {
        model: modifyFields(model, {
          returnClickId: () => nextClickId,
          maybeActiveIslandUrl: () => Option.none(),
          maybeActiveIslandPath: () => Option.none(),
        }),
        commands: [PushUrl({ url: targetUrl }), RefreshEntries({ subPath: folderSubPath })],
      }
    },

    CompletedReturnArrowClickDelay: ({ clickId }) => {
      if (clickId !== model.returnClickId) {
        return { model }
      }
      if (Option.isNone(model.maybeActiveIslandUrl)) {
        const currentSubPath = currentSubPathFromStorageState(model.storageState)
        if (currentSubPath.length === 0) {
          return { model }
        }
        const parentSubPath = Array.dropRight(currentSubPath, 1)
        const targetUrl = buildFolderUrl(parentSubPath)
        return {
          model: modifyFields(model, {}),
          commands: [PushUrl({ url: targetUrl }), RefreshEntries({ subPath: parentSubPath })],
        }
      }
      const activePath = Option.getOrElse(model.maybeActiveIslandPath, () => "")
      const { folderSubPath, fileName } = parseIslandPath(activePath)
      if (fileName === "index.html" && folderSubPath.length === 0) {
        return { model }
      }
      return {
        model,
        commands: [
          ResolveIslandBackNavigation({
            folderSubPath,
            fileName,
          }),
        ],
      }
    },

    ChangedWindowFocus: ({ isFocused }) => ({
      model: modifyFields(model, {
        isWindowFocused: () => isFocused,
      }),
    }),

    ClickedMinimizeWindow: () => ({
      model,
      commands: [MinimizeWindow()],
    }),

    CompletedMinimizeWindow: () => ({
      model,
    }),

    ClickedToggleMaximizeWindow: () => ({
      model,
      commands: [ToggleMaximizeWindow()],
    }),

    CompletedToggleMaximizeWindow: () => ({
      model,
    }),

    ClickedToggleFullscreen: () => ({
      model,
      commands: [ToggleFullscreenWindow()],
    }),

    CompletedToggleFullscreen: () => ({
      model,
    }),

    ClickedCloseWindow: () => ({
      model,
      commands: [CloseWindow()],
    }),

    CompletedCloseWindow: () => ({
      model,
    }),

    ChangedWindowMaximized: ({ isMaximized }) => ({
      model: modifyFields(model, {
        isWindowMaximized: () => isMaximized,
      }),
    }),

    ChangedWindowFullscreen: ({ isFullscreen }) => ({
      model: modifyFields(model, {
        isWindowFullscreen: () => isFullscreen,
      }),
    }),

    ReceivedServiceWorkerToast: ({ banner }) => enqueueToast(model, banner, { autoDismiss: false }),

    CompletedResolveIslandBackNavigation: ({ targetUrl, isIsland, subPath, shouldNavigate }) => {
      if (!shouldNavigate) {
        return { model }
      }
      if (isIsland) {
        const islandUrl = buildTauriIslandUrl(subPath, "index.html")
        return {
          model: modifyFields(model, {
            maybeActiveIslandUrl: () => Option.some(islandUrl),
            maybeActiveIslandPath: () => Option.some(targetUrl),
          }),
          commands: [PushUrl({ url: targetUrl })],
        }
      }
      return {
        model: modifyFields(model, {
          maybeActiveIslandUrl: () => Option.none(),
          maybeActiveIslandPath: () => Option.none(),
        }),
        commands: [PushUrl({ url: targetUrl }), RefreshEntries({ subPath })],
      }
    },

    ReceivedIslandNavigation: ({ url }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          maybeActiveIslandUrl: () => Option.none(),
          maybeActiveIslandPath: () => Option.none(),
        }),
        commands: [PushUrl({ url }), RefreshEntries({ subPath })],
      }
    },

    ReceivedIslandIpcRequest: ({ requestId, action }) => ({
      model,
      commands: [HandleIslandIpcRequest({ requestId, action })],
    }),

    CompletedHandleIslandIpcRequest: () => ({ model }),

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
      const wasIslandOpen = Option.isSome(model.maybeActiveIslandUrl)
      const searchStr = Option.getOrElse(url.search, () => "")
      const searchParams = new URLSearchParams(
        searchStr.startsWith("?") ? searchStr : `?${searchStr}`,
      )
      if (isTauriStorageState(model.storageState) && !searchParams.has("pwaislands")) {
        const segments = decodeUrlPathnameSegments(url.pathname)
        if (Array.isReadonlyArrayNonEmpty(segments)) {
          const { folderSubPath, fileName } = parseIslandPath(url.pathname)
          return {
            model: modifyFields(model, {
              isSettingsDialogOpen: () => false,
              maybeActiveIslandUrl: () => Option.some(buildTauriIslandUrl(folderSubPath, fileName)),
              maybeActiveIslandPath: () => Option.some(url.pathname),
            }),
          }
        }
      }

      const route = parseUrlToRoute(url)
      const modelWithRoute: Model = modifyFields(model, {
        isSettingsDialogOpen: () => false,
        maybeActiveIslandUrl: () => Option.none(),
        maybeActiveIslandPath: () => Option.none(),
        storageState: (state) =>
          StorageState.match(state, {
            Initializing: () => state,
            Unsupported: () => state,
            Ready: () => state,
            NoFolderSelected: (s) => modifyFields(s, { pendingRoute: () => route }),
            PermissionRequired: (s) => modifyFields(s, { pendingRoute: () => route }),
          }),
      })
      return AppRoute.match(route, {
        Folder: ({ subPath }) => {
          const nextModalState = Modal.close()
          return Match.value(modelWithRoute.storageState).pipe(
            Match.tag("Ready", (readyState) => {
              const isSamePath = isSameSubPath(readyState.subPath, subPath)
              if (isSamePath) {
                return {
                  model: modifyFields(modelWithRoute, {
                    isSettingsOpen: () => false,
                    modalState: () => nextModalState,
                  }),
                  ...(wasIslandOpen ? { commands: [RefreshEntries({ subPath })] } : {}),
                }
              }
              return {
                model: modifyFields(modelWithRoute, {
                  isSettingsOpen: () => false,
                  modalState: () => nextModalState,
                  storageState: () =>
                    modifyFields(readyState, {
                      entriesState: () => EntriesState.Loading(),
                    }),
                }),
                commands: [NavigateToSubfolder({ targetSubPath: subPath })],
              }
            }),
            Match.orElse(() => ({
              model: modifyFields(modelWithRoute, {
                isSettingsOpen: () => false,
                modalState: () => nextModalState,
              }),
            })),
          )
        },

        New: ({ subPath, target, isPreview }) => {
          if (target === "file" && Modal.isCreatingFile(modelWithRoute.modalState)) {
            return {
              model: modifyFields(modelWithRoute, {
                isSettingsOpen: () => false,
                modalState: (modalState) => Modal.setPreviewOpen(modalState, isPreview),
              }),
            }
          }

          const baseModalState = Modal.openCreate(target, [], {
            llmBarMode: modelWithRoute.editorLlmBarMode,
            editorSplitPercent: modelWithRoute.editorSplitPercent,
          })
          const newModalState =
            target === "file" ? Modal.setPreviewOpen(baseModalState, isPreview) : baseModalState
          const templateLoadCommands =
            target === "file" ? [toModalCommand(Modal.LoadEditorUserTemplates)] : []

          return whenReady(modelWithRoute, (readyState) => {
            const isSamePath = isSameSubPath(readyState.subPath, subPath)
            const nextModel = modifyFields(modelWithRoute, {
              isSettingsOpen: () => false,
              modalState: () => newModalState,
              ...(isSamePath
                ? {}
                : {
                    storageState: () =>
                      modifyFields(readyState, {
                        entriesState: () => EntriesState.Loading(),
                      }),
                  }),
            })
            const baseCommands: ReadonlyArray<Command.Command<Message>> = [
              ...(isSamePath ? [] : [NavigateToSubfolder({ targetSubPath: subPath })]),
              toModalCommand(Modal.FocusModalNameInput()),
              ...templateLoadCommands,
            ]
            return syncOpenEditor(nextModel, baseCommands)
          })
        },

        History: ({ subPath, name }) =>
          whenReady(modelWithRoute, (readyState) => {
            const isSamePath = isSameSubPath(readyState.subPath, subPath)
            const maybeEntry = isSamePath
              ? EntriesState.match(readyState.entriesState, {
                  Loaded: ({ entries }) => Array.findFirst(entries, (e) => e.name === name),
                  Loading: () => Option.none(),
                  Error: () => Option.none(),
                })
              : Option.none()

            if (
              Option.isNone(maybeEntry) ||
              Option.exists(maybeEntry, (entry) => entry.isDeleted === true)
            ) {
              const deletedHistory = Modal.openDeletedEntryHistory(subPath, name)
              return {
                model: modifyFields(modelWithRoute, {
                  isSettingsOpen: () => false,
                  modalState: () => deletedHistory.model,
                }),
                commands: Array.map(deletedHistory.commands, toModalCommand),
              }
            }

            return {
              model: modifyFields(modelWithRoute, {
                isSettingsOpen: () => false,
              }),
              commands: [
                toModalCommand(
                  Modal.InspectFileForEditor({
                    entryName: name,
                    subPath,
                    openHistory: true,
                  }),
                ),
              ],
            }
          }),

        Edit: ({ subPath, name, isPreview }) => {
          if (Modal.isEditingEntry(modelWithRoute.modalState, name)) {
            return {
              model: modifyFields(modelWithRoute, {
                isSettingsOpen: () => false,
                modalState: (modalState) => Modal.setPreviewOpen(modalState, isPreview),
              }),
            }
          }

          return whenReady(modelWithRoute, (readyState) => {
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
                model: modifyFields(modelWithRoute, {
                  isSettingsOpen: () => false,
                  modalState: () => Modal.openEditFolder(name),
                }),
                commands: [toModalCommand(Modal.FocusModalNameInput())],
              }
            }

            return {
              model: modifyFields(modelWithRoute, {
                isSettingsOpen: () => false,
              }),
              commands: [toModalCommand(Modal.InspectFileForEditor({ entryName: name, subPath }))],
            }
          })
        },

        Help: ({ maybeTopic }) => ({
          model: modifyFields(modelWithRoute, {
            isSettingsOpen: () => false,
            modalState: () => Modal.openHelp(maybeTopic, modelWithRoute.modalState),
          }),
        }),

        Settings: ({ subPath }) => {
          const openedSettingsModel = model.isSettingsDialogOpen
            ? modifyFields(modelWithRoute, {
                isSettingsOpen: () => false,
                isSettingsDialogOpen: () => true,
              })
            : openSettingsDialogModel(modelWithRoute)

          return Match.value(openedSettingsModel.storageState).pipe(
            Match.tag("Ready", (readyState) => {
              const isSamePath = isSameSubPath(readyState.subPath, subPath)
              if (isSamePath) {
                return {
                  model: modifyFields(openedSettingsModel, {
                    modalState: Modal.close,
                  }),
                }
              }
              return {
                model: modifyFields(openedSettingsModel, {
                  modalState: Modal.close,
                  storageState: () =>
                    modifyFields(readyState, {
                      entriesState: () => EntriesState.Loading(),
                    }),
                }),
                commands: [NavigateToSubfolder({ targetSubPath: subPath })],
              }
            }),
            Match.orElse(() => ({
              model: modifyFields(openedSettingsModel, {
                modalState: Modal.close,
              }),
            })),
          )
        },
      })
    },

    CompletedPushUrl: () => ({ model }),
    CompletedReplaceUrl: () => ({ model }),
    CompletedLoadUrl: () => ({ model }),

    PressedNavigateBack: () => ({
      model,
      commands: [NavigateHistoryBack()],
    }),

    PressedNavigateForward: () => ({
      model,
      commands: [NavigateHistoryForward()],
    }),

    CompletedNavigateHistoryBack: () => ({ model }),
    CompletedNavigateHistoryForward: () => ({ model }),

    // Settings & Storage Actions
    ClickedToggleSettings: () => ({
      model: modifyFields(model, {
        isSettingsOpen: (isOpen) => !isOpen,
      }),
    }),

    ClickedOutsideSettingsMenu: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
      }),
    }),

    ClickedOutsideLlmModeMenu: () => ({
      model: modifyFields(model, {
        modalState: Modal.closeLlmModeMenu,
      }),
    }),

    ClickedOpenSettingsDialog: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: openSettingsDialogModel(model),
        commands: [PushUrl({ url: buildSettingsUrl(subPath) })],
      }
    },

    ClickedCloseSettingsDialog: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      const isModalOpen = model.modalState._tag !== "Closed"
      return {
        model: modifyFields(model, {
          isSettingsDialogOpen: () => false,
          isEditingLlmSettings: () => false,
          llmTestState: () => LlmTestState.Idle(),
          clearAllHistoryState: () => ClearAllHistoryState.Idle(),
        }),
        ...(isModalOpen ? {} : { commands: [ReplaceUrl({ url: buildFolderUrl(subPath) })] }),
      }
    },

    ClickedRequestClearAllHistory: () => ({
      model: modifyFields(model, {
        clearAllHistoryState: () => ClearAllHistoryState.Confirming(),
      }),
    }),

    ClickedCancelClearAllHistory: () => ({
      model: modifyFields(model, {
        clearAllHistoryState: () => ClearAllHistoryState.Idle(),
      }),
    }),

    ClickedConfirmClearAllHistory: () => ({
      model: modifyFields(model, {
        clearAllHistoryState: () => ClearAllHistoryState.Clearing(),
      }),
      commands: [ClearAllHistory()],
    }),

    SucceededClearAllHistory: () => ({
      model: modifyFields(model, {
        clearAllHistoryState: () => ClearAllHistoryState.Done(),
        storageState: (storageState) =>
          mapLoadedEntries(storageState, (entries) =>
            Array.map(
              Array.filter(entries, (entry) => entry.isDeleted !== true),
              (entry) => ({ ...entry, hasHistory: false }),
            ),
          ),
      }),
    }),

    FailedClearAllHistory: ({ message: errorMessage }) =>
      enqueueToast(
        modifyFields(model, {
          clearAllHistoryState: () => ClearAllHistoryState.Idle(),
        }),
        {
          message: errorMessage,
          variant: "danger",
        },
      ),

    ToggledSettingsHistoryEnabled: ({ isEnabled }) => ({
      model: modifyFields(model, {
        historyEnabled: () => isEnabled,
      }),
      commands: [SaveHistoryEnabledPreference({ isEnabled })],
    }),

    CompletedSaveHistoryEnabledPreference: () => ({
      model,
    }),

    ToggledSettingsApiHistoryEnabled: ({ isEnabled }) => ({
      model: modifyFields(model, {
        apiHistoryEnabled: () => isEnabled,
      }),
      commands: [SaveApiHistoryEnabledPreference({ isEnabled })],
    }),

    CompletedSaveApiHistoryEnabledPreference: () => ({
      model,
    }),

    ToggledSettingsEditorLineNumbers: ({ isEnabled }) => {
      const nextModel = modifyFields(model, {
        editorLineNumbers: () => isEnabled,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    ToggledSettingsEditorFolding: ({ isEnabled }) => {
      const nextModel = modifyFields(model, {
        editorFolding: () => isEnabled,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    ToggledSettingsEditorWordWrap: ({ isEnabled }) => {
      const nextModel = modifyFields(model, {
        editorWordWrap: () => isEnabled,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    ToggledSettingsEditorScrollBeyondLastLine: ({ isEnabled }) => {
      const nextModel = modifyFields(model, {
        editorScrollBeyondLastLine: () => isEnabled,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    SelectedSettingsEditorTheme: ({ theme }) => {
      const nextModel = modifyFields(model, {
        editorTheme: () => theme,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    UpdatedSettingsEditorLineDecorationsWidth: ({ value }) => {
      const nextModel = modifyFields(model, {
        editorLineDecorationsWidth: () => value,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    UpdatedSettingsEditorLineNumbersMinChars: ({ value }) => {
      const nextModel = modifyFields(model, {
        editorLineNumbersMinChars: () => value,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    ToggledSettingsEditorUndoInTitlebar: ({ isEnabled }) => {
      const nextModel = modifyFields(model, {
        editorUndoInTitlebar: () => isEnabled,
      })
      return {
        model: nextModel,
        commands: [saveMonacoSettingsCommand(nextModel)],
      }
    },

    CompletedSaveMonacoSettings: () => ({
      model,
    }),

    SelectedSettingsAppTheme: ({ theme }) => ({
      model: modifyFields(model, {
        appTheme: () => theme,
      }),
      commands: [SaveAppTheme({ theme })],
    }),

    CompletedSaveAppTheme: () => ({
      model,
    }),

    CompletedApplyAppTheme: () => ({
      model,
    }),

    SelectedSettingsLanguage: ({ language }) => ({
      model: modifyFields(model, {
        language: () => language,
      }),
      commands: [SaveLanguage({ language })],
    }),

    CompletedSaveLanguage: () => ({
      model,
    }),

    CompletedApplyLanguage: () => ({
      model,
    }),

    ClickedSaveSettingsDialog: () => {
      const activeId = Option.match(model.editingLlmProviderId, {
        onNone: () => {
          let index = model.llmProviders.length + 1
          while (model.llmProviders.some((p) => p.id === `provider-${index}`)) {
            index += 1
          }
          return `provider-${index}`
        },
        onSome: (id) => id,
      })
      const trimmedName = model.llmDraftName.trim()
      const savedProvider: OpenAiProviderConfig = {
        id: activeId,
        name:
          trimmedName !== ""
            ? trimmedName
            : model.llmDraftBaseUrl.trim() !== ""
              ? model.llmDraftBaseUrl.trim()
              : "Provider",
        enabled: model.llmDraftProviderEnabled,
        baseUrl: model.llmDraftBaseUrl,
        apiKey: model.llmDraftApiKey,
        models: model.llmDraftModels,
        ...(model.llmDraftModelFilter !== "" ? { modelFilter: model.llmDraftModelFilter } : {}),
        discoveredModels: model.llmDiscoveredModels,
        editFormat: model.llmDraftProviderEditFormat,
        streaming: model.llmDraftStreaming,
        toolCalls: model.llmDraftToolCalls,
        thinkingParam: model.llmDraftThinkingParam,
        thinkingLevels: model.llmDraftThinkingLevels,
        extraArgs: model.llmDraftExtraArgs,
      }
      const nextProviders = Option.match(model.editingLlmProviderId, {
        onNone: () => [...model.llmProviders, savedProvider],
        onSome: (id) =>
          model.llmProviders.map((provider) => (provider.id === id ? savedProvider : provider)),
      })
      const nextEnabled = nextProviders.some((p) => p.enabled)
      return {
        model: modifyFields(model, {
          isEditingLlmSettings: () => false,
          editingLlmProviderId: () => Option.none(),
          llmProviders: () => nextProviders,
          llmActiveProviderId: () => activeId,
          llmEnabled: () => nextEnabled,
          llmDraftEnabled: () => nextEnabled,
          llmEditFormat: () => model.llmDraftEditFormat,
          llmBaseUrl: () => model.llmDraftBaseUrl,
          llmApiKey: () => model.llmDraftApiKey,
          llmModels: () => model.llmDraftModels,
          llmStreaming: () => model.llmDraftStreaming,
          llmToolCalls: () => model.llmDraftToolCalls,
          llmThinkingParam: () => model.llmDraftThinkingParam,
          llmThinkingLevels: () => model.llmDraftThinkingLevels,
          llmExtraArgs: () => model.llmDraftExtraArgs,
          hasLoadedEditorLlmModels: () => false,
        }),
        commands: [
          SaveLlmSettings({
            enabled: nextEnabled,
            providers: nextProviders,
            activeProviderId: activeId,
            editFormat: model.llmDraftEditFormat,
            baseUrl: model.llmDraftBaseUrl,
            apiKey: model.llmDraftApiKey,
            models: model.llmDraftModels,
            streaming: model.llmDraftStreaming,
            toolCalls: model.llmDraftToolCalls,
            thinkingParam: model.llmDraftThinkingParam,
            thinkingLevels: model.llmDraftThinkingLevels,
            extraArgs: model.llmDraftExtraArgs,
          }),
        ],
      }
    },

    ClickedCancelLlmProviderEdit: () => ({
      model: modifyFields(model, {
        isEditingLlmSettings: () => false,
        editingLlmProviderId: () => Option.none(),
        llmDraftName: () => "",
        llmDraftEditFormat: () => model.llmEditFormat,
        llmDraftBaseUrl: () => model.llmBaseUrl,
        llmDraftApiKey: () => model.llmApiKey,
        llmDraftModels: () => model.llmModels,
        llmDraftModelFilter: () => "",
        llmDraftStreaming: () => model.llmStreaming,
        llmDraftToolCalls: () => model.llmToolCalls,
        llmDraftThinkingParam: () => model.llmThinkingParam,
        llmDraftThinkingLevels: () => model.llmThinkingLevels,
        llmDraftExtraArgs: () => model.llmExtraArgs,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    ClickedAddLlmProvider: () => ({
      model: modifyFields(model, {
        isEditingLlmSettings: () => true,
        editingLlmProviderId: () => Option.none(),
        llmDraftName: () => "",
        llmDraftProviderEnabled: () => true,
        llmDraftProviderEditFormat: () => "",
        llmDraftEditFormat: () => model.llmEditFormat,
        llmDraftBaseUrl: () => "",
        llmDraftApiKey: () => "",
        llmDraftModels: () => "",
        llmDraftModelFilter: () => "",
        llmDiscoveredModels: () => [],
        llmDraftModel: () => "",
        llmDraftStreaming: () => true,
        llmDraftToolCalls: () => true,
        llmDraftThinkingParam: () => emptyLlmSettings.thinkingParam,
        llmDraftThinkingLevels: () => emptyLlmSettings.thinkingLevels,
        llmDraftExtraArgs: () => "",
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    ClickedEditLlmProvider: ({ id }) => {
      const provider = model.llmProviders.find((p) => p.id === id)
      if (provider === undefined) {
        return { model }
      }
      const providerModelIds = [
        ...parseModelList(provider.models),
        ...(provider.discoveredModels ?? []),
      ]
      const decodedSelected = decodeProviderModelValue(model.llmModel)
      const matchingDraftModel =
        decodedSelected !== null && decodedSelected.providerId === id
          ? decodedSelected.modelId
          : providerModelIds.includes(model.llmModel.trim())
            ? model.llmModel.trim()
            : (providerModelIds[0] ?? "")
      return {
        model: modifyFields(model, {
          isEditingLlmSettings: () => true,
          editingLlmProviderId: () => Option.some(id),
          llmDraftName: () => provider.name,
          llmDraftProviderEnabled: () => provider.enabled,
          llmDraftProviderEditFormat: () => provider.editFormat,
          llmDraftEditFormat: () => model.llmEditFormat,
          llmDraftBaseUrl: () => provider.baseUrl,
          llmDraftApiKey: () => provider.apiKey,
          llmDraftModels: () => provider.models,
          llmDraftModelFilter: () => provider.modelFilter ?? "",
          llmDiscoveredModels: () => provider.discoveredModels ?? [],
          llmDraftModel: () => matchingDraftModel,
          llmDraftStreaming: () => provider.streaming,
          llmDraftToolCalls: () => provider.toolCalls,
          llmDraftThinkingParam: () => provider.thinkingParam,
          llmDraftThinkingLevels: () => provider.thinkingLevels,
          llmDraftExtraArgs: () => provider.extraArgs,
          llmTestState: () => LlmTestState.Idle(),
        }),
      }
    },

    ToggledLlmProviderEnabled: ({ id, isChecked }) => {
      const nextProviders = model.llmProviders.map((provider) =>
        provider.id === id ? { ...provider, enabled: isChecked } : provider,
      )
      const nextEnabled = nextProviders.some((p) => p.enabled)
      return {
        model: modifyFields(model, {
          llmProviders: () => nextProviders,
          llmEnabled: () => nextEnabled,
          llmDraftEnabled: () => nextEnabled,
          hasLoadedEditorLlmModels: () => false,
        }),
        commands: [
          SaveLlmSettings({
            enabled: nextEnabled,
            providers: nextProviders,
            activeProviderId: model.llmActiveProviderId,
            editFormat: model.llmEditFormat,
            baseUrl: model.llmBaseUrl,
            apiKey: model.llmApiKey,
            models: model.llmModels,
            streaming: model.llmStreaming,
            toolCalls: model.llmToolCalls,
            thinkingParam: model.llmThinkingParam,
            thinkingLevels: model.llmThinkingLevels,
            extraArgs: model.llmExtraArgs,
          }),
        ],
      }
    },

    ToggledLlmDraftProviderEnabled: ({ isChecked }) => ({
      model: modifyFields(model, {
        llmDraftProviderEnabled: () => isChecked,
      }),
    }),

    UpdatedLlmDraftProviderEditFormat: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftProviderEditFormat: () => (value === "" ? "" : parseEditFormat(value)),
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    ClickedDeleteLlmProvider: () => ({
      model: modifyFields(model, {
        isConfirmingDeleteLlmProvider: () => true,
      }),
    }),

    ClickedCancelDeleteLlmProvider: () => ({
      model: modifyFields(model, {
        isConfirmingDeleteLlmProvider: () => false,
      }),
    }),

    ClickedConfirmDeleteLlmProvider: () => {
      const id = Option.getOrElse(model.editingLlmProviderId, () => "")
      const remaining = model.llmProviders.filter((p) => p.id !== id)
      const nextActive =
        model.llmActiveProviderId === id
          ? (remaining[0] ?? undefined)
          : remaining.find((p) => p.id === model.llmActiveProviderId)
      const nextActiveId = nextActive?.id ?? ""
      const nextBaseUrl = nextActive?.baseUrl ?? ""
      const nextApiKey = nextActive?.apiKey ?? ""
      const nextModels = nextActive?.models ?? ""
      const nextStreaming = nextActive?.streaming ?? true
      const nextToolCalls = nextActive?.toolCalls ?? true
      const nextThinkingParam = nextActive?.thinkingParam ?? emptyLlmSettings.thinkingParam
      const nextThinkingLevels = nextActive?.thinkingLevels ?? emptyLlmSettings.thinkingLevels
      const nextExtraArgs = nextActive?.extraArgs ?? ""
      const nextEnabled = remaining.length > 0 ? remaining.some((p) => p.enabled) : model.llmEnabled
      return {
        model: modifyFields(model, {
          isConfirmingDeleteLlmProvider: () => false,
          isEditingLlmSettings: () => false,
          editingLlmProviderId: () => Option.none(),
          llmTestState: () => LlmTestState.Idle(),
          llmProviders: () => remaining,
          llmEnabled: () => nextEnabled,
          llmDraftEnabled: () => nextEnabled,
          llmActiveProviderId: () => nextActiveId,
          llmBaseUrl: () => nextBaseUrl,
          llmApiKey: () => nextApiKey,
          llmModels: () => nextModels,
          llmStreaming: () => nextStreaming,
          llmToolCalls: () => nextToolCalls,
          llmThinkingParam: () => nextThinkingParam,
          llmThinkingLevels: () => nextThinkingLevels,
          llmExtraArgs: () => nextExtraArgs,
          llmDraftBaseUrl: () => nextBaseUrl,
          llmDraftApiKey: () => nextApiKey,
          llmDraftModels: () => nextModels,
          llmDraftStreaming: () => nextStreaming,
          llmDraftToolCalls: () => nextToolCalls,
          llmDraftThinkingParam: () => nextThinkingParam,
          llmDraftThinkingLevels: () => nextThinkingLevels,
          llmDraftExtraArgs: () => nextExtraArgs,
          hasLoadedEditorLlmModels: () => false,
        }),
        commands: [
          SaveLlmSettings({
            enabled: nextEnabled,
            providers: remaining,
            activeProviderId: nextActiveId,
            editFormat: model.llmEditFormat,
            baseUrl: nextBaseUrl,
            apiKey: nextApiKey,
            models: nextModels,
            streaming: nextStreaming,
            toolCalls: nextToolCalls,
            thinkingParam: nextThinkingParam,
            thinkingLevels: nextThinkingLevels,
            extraArgs: nextExtraArgs,
          }),
        ],
      }
    },

    UpdatedLlmProviderName: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftName: () => value,
      }),
    }),

    ClickedEditLlmSettings: () => ({
      model: modifyFields(model, {
        isEditingLlmSettings: () => true,
      }),
    }),

    ToggledLlmEnabled: ({ isChecked }) => ({
      model: modifyFields(model, {
        llmEnabled: () => isChecked,
        llmDraftEnabled: () => isChecked,
        isEditingLlmSettings: (current) => (isChecked ? current : false),
        editingLlmProviderId: (current) => (isChecked ? current : Option.none()),
        llmTestState: () => LlmTestState.Idle(),
      }),
      commands: [
        SaveLlmSettings({
          enabled: isChecked,
          providers: model.llmProviders,
          activeProviderId: model.llmActiveProviderId,
          editFormat: model.llmEditFormat,
          baseUrl: model.llmBaseUrl,
          apiKey: model.llmApiKey,
          models: model.llmModels,
          streaming: model.llmStreaming,
          toolCalls: model.llmToolCalls,
          thinkingParam: model.llmThinkingParam,
          thinkingLevels: model.llmThinkingLevels,
          extraArgs: model.llmExtraArgs,
        }),
      ],
    }),

    UpdatedLlmEditFormat: ({ value }) => {
      const nextEditFormat = parseEditFormat(value)
      return {
        model: modifyFields(model, {
          llmEditFormat: () => nextEditFormat,
          llmDraftEditFormat: () => nextEditFormat,
          llmTestState: () => LlmTestState.Idle(),
        }),
        commands: [
          SaveLlmSettings({
            enabled: model.llmEnabled,
            providers: model.llmProviders,
            activeProviderId: model.llmActiveProviderId,
            editFormat: nextEditFormat,
            baseUrl: model.llmBaseUrl,
            apiKey: model.llmApiKey,
            models: model.llmModels,
            streaming: model.llmStreaming,
            toolCalls: model.llmToolCalls,
            thinkingParam: model.llmThinkingParam,
            thinkingLevels: model.llmThinkingLevels,
            extraArgs: model.llmExtraArgs,
          }),
        ],
      }
    },

    UpdatedLlmChatAiName: ({ value }) => ({
      model: modifyFields(model, { llmChatAiName: () => value }),
      commands: [
        SaveLlmChatNames({
          aiName: value,
          userName: model.llmChatUserName,
        }),
      ],
    }),

    UpdatedLlmChatUserName: ({ value }) => ({
      model: modifyFields(model, { llmChatUserName: () => value }),
      commands: [
        SaveLlmChatNames({
          aiName: model.llmChatAiName,
          userName: value,
        }),
      ],
    }),

    CompletedSaveLlmChatNames: () => ({ model }),

    UpdatedLlmBaseUrl: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftBaseUrl: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    UpdatedLlmApiKey: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftApiKey: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    UpdatedLlmModels: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftModels: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    UpdatedLlmModelFilter: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftModelFilter: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    SelectedLlmModel: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftModel: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    ToggledLlmStreaming: ({ isChecked }) => ({
      model: modifyFields(model, {
        llmDraftStreaming: () => isChecked,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    ToggledLlmToolCalls: ({ isChecked }) => ({
      model: modifyFields(model, {
        llmDraftToolCalls: () => isChecked,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    SelectedLlmThinkingPreset: ({ presetId }) => {
      const preset = THINKING_PRESETS.find((item) => item.id === presetId)
      if (!preset) {
        return { model }
      }
      const nextLevels = parseThinkingLevels(preset.levels)
      const keepSelected = nextLevels.some((item) => item.value === model.llmDraftThinkingLevel)
      return {
        model: modifyFields(model, {
          llmDraftThinkingParam: () => preset.param,
          llmDraftThinkingLevels: () => preset.levels,
          llmDraftThinkingLevel: (current) => (keepSelected ? current : ""),
          llmTestState: () => LlmTestState.Idle(),
        }),
      }
    },

    UpdatedLlmThinkingParam: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftThinkingParam: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    UpdatedLlmThinkingLevels: ({ value }) => {
      const nextLevels = parseThinkingLevels(value)
      const keepSelected =
        model.llmDraftThinkingLevel === "" ||
        nextLevels.some((item) => item.value === model.llmDraftThinkingLevel)
      return {
        model: modifyFields(model, {
          llmDraftThinkingLevels: () => value,
          llmDraftThinkingLevel: (current) => (keepSelected ? current : ""),
          llmTestState: () => LlmTestState.Idle(),
        }),
      }
    },

    UpdatedLlmThinkingLevel: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftThinkingLevel: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    UpdatedLlmExtraArgs: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftExtraArgs: () => value,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    ClickedTestLlm: ({ mode }) => {
      const effectiveModel =
        model.llmDraftModel.trim() !== ""
          ? model.llmDraftModel.trim()
          : (parseModelList(model.llmDraftModels)[0] ??
            model.llmDiscoveredModels[0] ??
            (model.hasLanguageModel ? LANGUAGE_MODEL_OPTION_VALUE : ""))
      const config = {
        enabled: model.llmDraftProviderEnabled,
        editFormat:
          model.llmDraftProviderEditFormat !== ""
            ? model.llmDraftProviderEditFormat
            : model.llmEditFormat,
        baseUrl: model.llmDraftBaseUrl,
        apiKey: model.llmDraftApiKey,
        models: model.llmDraftModels,
        ...(model.llmDraftModelFilter !== "" ? { modelFilter: model.llmDraftModelFilter } : {}),
        streaming: model.llmDraftStreaming,
        toolCalls: model.llmDraftToolCalls,
        thinkingParam: model.llmDraftThinkingParam,
        thinkingLevels: model.llmDraftThinkingLevels,
        extraArgs: model.llmDraftExtraArgs,
        model: effectiveModel,
        thinkingLevel: model.llmDraftThinkingLevel,
      }
      const isNativeModel = isLanguageModelSelection(effectiveModel)
      if (
        (mode === "chat" || mode === "tools") &&
        config.streaming &&
        ((isNativeModel && mode === "chat") || (!isNativeModel && resolveTestModel(config) !== ""))
      ) {
        return {
          model: modifyFields(model, {
            llmDraftModel: () => effectiveModel,
            llmTestState: () => LlmTestState.Streaming({ mode, content: "", reasoning: "" }),
          }),
        }
      }
      return {
        model: modifyFields(model, {
          llmDraftModel: (current) => (current.trim() === "" ? effectiveModel : current),
          llmTestState: () => LlmTestState.Testing(),
        }),
        commands: [TestLlm({ mode, ...config })],
      }
    },

    UpdatedTestLlmStream: ({ content, reasoning }) => ({
      model: modifyFields(model, {
        llmTestState: (current) =>
          current._tag === "Streaming"
            ? LlmTestState.Streaming({ mode: current.mode, content, reasoning })
            : current,
      }),
    }),

    SucceededTestLlm: ({ content, reasoning, models }) => {
      const editingId = Option.getOrElse(model.editingLlmProviderId, () => "")
      const nextProviders =
        models.length > 0 && editingId !== ""
          ? model.llmProviders.map((p) =>
              p.id === editingId ? { ...p, discoveredModels: models } : p,
            )
          : model.llmProviders
      const shouldPersist = models.length > 0 && editingId !== ""
      return {
        model: modifyFields(model, {
          llmTestState: () => LlmTestState.Succeeded({ content, reasoning, models }),
          llmDiscoveredModels: (current) => (models.length > 0 ? models : current),
          llmProviders: () => nextProviders,
          llmDraftModel: (current) =>
            current.trim() === "" && models.length > 0 ? (models[0] ?? current) : current,
        }),
        ...(shouldPersist
          ? {
              commands: [
                SaveLlmSettings({
                  enabled: model.llmEnabled,
                  providers: nextProviders,
                  activeProviderId: model.llmActiveProviderId,
                  editFormat: model.llmEditFormat,
                  baseUrl: model.llmBaseUrl,
                  apiKey: model.llmApiKey,
                  models: model.llmModels,
                  streaming: model.llmStreaming,
                  toolCalls: model.llmToolCalls,
                  thinkingParam: model.llmThinkingParam,
                  thinkingLevels: model.llmThinkingLevels,
                  extraArgs: model.llmExtraArgs,
                }),
              ],
            }
          : {}),
      }
    },

    FailedTestLlm: ({ message }) => ({
      model: modifyFields(model, { llmTestState: () => LlmTestState.Failed({ message }) }),
    }),

    CompletedDetectLanguageModel: ({ isAvailable }) => ({
      model: modifyFields(model, {
        hasLanguageModel: () => isAvailable,
      }),
    }),

    CompletedLoadLlmSettings: ({
      enabled,
      providers,
      activeProviderId,
      editFormat,
      baseUrl,
      apiKey,
      models,
      streaming,
      toolCalls,
      thinkingParam,
      thinkingLevels,
      extraArgs,
    }) => {
      const nextModel = modifyFields(model, {
        llmProviders: () => providers,
        llmActiveProviderId: () => activeProviderId,
        llmEnabled: () => enabled,
        llmDraftEnabled: () => enabled,
        llmEditFormat: () => editFormat,
        llmDraftEditFormat: () => editFormat,
        llmBaseUrl: () => baseUrl,
        llmApiKey: () => apiKey,
        llmDraftBaseUrl: () => baseUrl,
        llmDraftApiKey: () => apiKey,
        llmModels: () => models,
        llmDraftModels: () => models,
        llmStreaming: () => streaming,
        llmDraftStreaming: () => streaming,
        llmToolCalls: () => toolCalls,
        llmDraftToolCalls: () => toolCalls,
        llmThinkingParam: () => thinkingParam,
        llmDraftThinkingParam: () => thinkingParam,
        llmThinkingLevels: () => thinkingLevels,
        llmDraftThinkingLevels: () => thinkingLevels,
        llmExtraArgs: () => extraArgs,
        llmDraftExtraArgs: () => extraArgs,
      })

      return syncOpenEditor(nextModel)
    },

    CompletedSaveLlmSettings: () => ({ model }),

    CompletedLoadEditorPreferences: ({
      llmBarMode,
      llmModel,
      llmThinkingLevel,
      editorSplitPercent,
      historyEnabled,
      apiHistoryEnabled,
      monacoSettings,
      appTheme,
      language,
      llmChatNames,
    }) => {
      const nextAppTheme = appTheme ?? model.appTheme
      const nextLanguage = language ?? model.language
      const applyCommands = [
        ...(appTheme === undefined ? [] : [ApplyAppTheme({ theme: nextAppTheme })]),
        ...(language === undefined ? [] : [ApplyLanguage({ language: nextLanguage })]),
      ]
      return {
        model: modifyFields(model, {
          editorLlmBarMode: () => llmBarMode,
          editorSplitPercent: () => editorSplitPercent,
          historyEnabled: () => historyEnabled ?? model.historyEnabled,
          apiHistoryEnabled: () => apiHistoryEnabled ?? model.apiHistoryEnabled,
          appTheme: () => nextAppTheme,
          language: () => nextLanguage,
          llmChatAiName: () => llmChatNames?.aiName ?? model.llmChatAiName,
          llmChatUserName: () => llmChatNames?.userName ?? model.llmChatUserName,
          editorLineNumbers: () => monacoSettings?.lineNumbers ?? model.editorLineNumbers,
          editorFolding: () => monacoSettings?.folding ?? model.editorFolding,
          editorWordWrap: () => monacoSettings?.wordWrap ?? model.editorWordWrap,
          editorScrollBeyondLastLine: () =>
            monacoSettings?.scrollBeyondLastLine ?? model.editorScrollBeyondLastLine,
          editorTheme: () => monacoSettings?.theme ?? model.editorTheme,
          editorLineDecorationsWidth: () =>
            monacoSettings?.lineDecorationsWidth ?? model.editorLineDecorationsWidth,
          editorLineNumbersMinChars: () =>
            monacoSettings?.lineNumbersMinChars ?? model.editorLineNumbersMinChars,
          editorUndoInTitlebar: () => monacoSettings?.undoInTitlebar ?? model.editorUndoInTitlebar,
          llmModel: (current) => (current === "" ? llmModel : current),
          llmDraftModel: (current) => (current === "" ? llmModel : current),
          llmThinkingLevel: (current) => (current === "" ? llmThinkingLevel : current),
          llmDraftThinkingLevel: (current) => (current === "" ? llmThinkingLevel : current),
          modalState: (current) =>
            Modal.applyEditorPreferences(current, {
              llmBarMode,
              editorSplitPercent,
            }),
        }),
        ...(Array.isArrayNonEmpty(applyCommands) ? { commands: applyCommands } : {}),
      }
    },

    CompletedSaveEditorPreferences: () => ({ model }),

    SucceededLoadEditorLlmModels: ({ providerId, models }) => {
      const nextProviders =
        providerId !== undefined && providerId !== "" && models.length > 0
          ? model.llmProviders.map((p) =>
              p.id === providerId ? { ...p, discoveredModels: models } : p,
            )
          : model.llmProviders
      const shouldPersist = providerId !== undefined && providerId !== "" && models.length > 0
      return {
        model: modifyFields(model, {
          llmDiscoveredModels: (current) => (models.length > 0 ? models : current),
          llmProviders: () => nextProviders,
          llmModel: (current) => (current.trim() === "" && models[0] ? models[0] : current),
          llmDraftModel: (current) => (current.trim() === "" && models[0] ? models[0] : current),
        }),
        ...(shouldPersist
          ? {
              commands: [
                SaveLlmSettings({
                  enabled: model.llmEnabled,
                  providers: nextProviders,
                  activeProviderId: model.llmActiveProviderId,
                  editFormat: model.llmEditFormat,
                  baseUrl: model.llmBaseUrl,
                  apiKey: model.llmApiKey,
                  models: model.llmModels,
                  streaming: model.llmStreaming,
                  toolCalls: model.llmToolCalls,
                  thinkingParam: model.llmThinkingParam,
                  thinkingLevels: model.llmThinkingLevels,
                  extraArgs: model.llmExtraArgs,
                }),
              ],
            }
          : {}),
      }
    },

    FailedLoadEditorLlmModels: () => ({ model }),

    UpdatedEditorLlmChatStream: ({ completedTurns, activeTurn, initialMessages }) => ({
      model: modifyFields(model, {
        modalState: (current) =>
          Modal.applyEditorLlmChatStream(current, {
            completedTurns,
            activeTurn,
            ...(initialMessages !== undefined ? { initialMessages } : {}),
          }),
      }),
      commands: [ScrollEditorLlmChatToBottomIfAtBottom()],
    }),

    SucceededEditorLlmChat: ({ messages, maybeUpdatedContent, appliedCount, turns }) => ({
      model: modifyFields(model, {
        modalState: (current) =>
          Modal.applyEditorLlmChatSuccess(current, {
            messages,
            maybeUpdatedContent,
            appliedCount,
            turns,
          }),
      }),
      commands: [ScrollEditorLlmChatToBottomIfAtBottom()],
    }),

    FailedEditorLlmChat: ({ message: errorMessage }) => ({
      model: modifyFields(model, {
        modalState: (current) => Modal.applyEditorLlmChatFailure(current, errorMessage),
      }),
      commands: [ScrollEditorLlmChatToBottomIfAtBottom()],
    }),

    CompletedScrollEditorLlmChatToBottom: () => ({ model }),

    ClickedToggleFileInfo: () => {
      const nextVisible = !model.showFileInfo
      return {
        model: modifyFields(model, {
          showFileInfo: () => nextVisible,
        }),
        commands: [SaveFileInfoPreference({ visible: nextVisible })],
      }
    },

    ClickedSelectFolder: () => {
      const isOpfsReady = StorageState.match(model.storageState, {
        Ready: ({ storageType }) => storageType === "opfs",
        Initializing: () => false,
        Unsupported: () => false,
        NoFolderSelected: () => false,
        PermissionRequired: () => false,
      })
      if (isOpfsReady) {
        return handleUseFsa(model)
      }
      const otherBackend = getOtherBackend(model.storageState)
      const subPath = currentSubPathFromStorageState(model.storageState)
      const route = pendingRouteFromStorageState(model.storageState, subPath)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          PickLocalDirectory({
            otherBackend,
            route,
          }),
        ],
      }
    },

    ClickedChangeFolder: () => {
      const otherBackend = getOtherBackend(model.storageState)
      const subPath = currentSubPathFromStorageState(model.storageState)
      const route = pendingRouteFromStorageState(model.storageState, subPath)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          PickLocalDirectory({
            otherBackend,
            route,
          }),
        ],
      }
    },

    ClickedGrantPermission: () => {
      const otherBackend = getOtherBackend(model.storageState)
      const subPath = currentSubPathFromStorageState(model.storageState)
      const route = pendingRouteFromStorageState(model.storageState, subPath)
      return {
        model,
        commands: [
          GrantDirectoryPermission({
            otherBackend,
            route,
          }),
        ],
      }
    },

    ClickedUseOpfs: () => {
      const otherBackend = StorageState.match(model.storageState, {
        Ready: ({ storageType, rootName }) =>
          isLocalFolderStorage(storageType)
            ? SavedBackend.Granted({ rootName })
            : SavedBackend.Unsupported(),
        NoFolderSelected: ({ storageType }) =>
          isLocalFolderStorage(storageType)
            ? SavedBackend.NoFolderSelected()
            : SavedBackend.Unsupported(),
        PermissionRequired: ({ storageType, folderName }) =>
          isLocalFolderStorage(storageType)
            ? SavedBackend.PermissionRequired({ folderName })
            : SavedBackend.Unsupported(),
        Initializing: () => SavedBackend.Unsupported(),
        Unsupported: () => SavedBackend.Unsupported(),
      })

      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          ActivateOpfsBackend({
            otherBackend,
            route: AppRoute.Folder({ subPath: [] }),
          }),
          PushUrl({ url: buildFolderUrl([]) }),
        ],
      }
    },

    ClickedUseFsa: () => handleUseFsa(model),

    ClickedDisconnectFolder: () => {
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
        }),
        commands: [
          DisconnectStorage({
            hasOPFS: model.hasOPFS,
          }),
          PushUrl({ url: buildFolderUrl([]) }),
        ],
      }
    },

    SucceededPickLocalDirectory: (payload) => handleStorageActivated(model, payload),
    CancelledPickLocalDirectory: () => ({ model }),
    FailedPickLocalDirectory: ({ message: errorMessage }) =>
      enqueueToast(model, {
        message: errorMessage,
        variant: "danger",
      }),

    SucceededGrantDirectoryPermission: (payload) => handleStorageActivated(model, payload),
    CompletedGrantDirectoryPermissionNoFolderSelected: (payload) =>
      handleNoFolderSelected(model, payload),
    FailedGrantDirectoryPermission: ({ message: errorMessage }) =>
      enqueueToast(model, {
        message: errorMessage,
        variant: "danger",
      }),

    SucceededActivateOpfsBackend: (payload) => handleStorageActivated(model, payload),
    FailedActivateOpfsBackend: ({ message: errorMessage }) =>
      enqueueToast(model, {
        message: errorMessage,
        variant: "danger",
      }),

    SucceededActivateFsaBackend: (payload) => handleStorageActivated(model, payload),
    CompletedActivateFsaBackendPermissionRequired: (payload) =>
      handlePermissionRequired(model, payload),
    CompletedActivateFsaBackendNoFolderSelected: (payload) =>
      handleNoFolderSelected(model, payload),
    FailedActivateFsaBackend: ({ message: errorMessage }) =>
      enqueueToast(model, {
        message: errorMessage,
        variant: "danger",
      }),

    SucceededDisconnectStorage: (payload) => handleNoFolderSelected(model, payload),
    FailedDisconnectStorage: ({ message: errorMessage }) =>
      enqueueToast(model, {
        message: errorMessage,
        variant: "danger",
      }),

    // Toolbar & Triggers
    ClickedNewFile: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return syncOpenEditor(
        modifyFields(model, {
          modalState: () =>
            Modal.openCreate("file", [], {
              llmBarMode: model.editorLlmBarMode,
              editorSplitPercent: model.editorSplitPercent,
            }),
        }),
        [
          PushUrl({ url: buildNewUrl(subPath, "file") }),
          toModalCommand(Modal.FocusModalNameInput()),
          toModalCommand(Modal.LoadEditorUserTemplates),
        ],
      )
    },

    ClickedNewFolder: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          modalState: () => Modal.openCreate("folder"),
        }),
        commands: [
          PushUrl({ url: buildNewUrl(subPath, "folder") }),
          toModalCommand(Modal.FocusModalNameInput()),
        ],
      }
    },

    ClickedImportFiles: () => ({
      model: modifyFields(model, {}),
      commands: [toModalCommand(Modal.SelectImportFiles())],
    }),

    ClickedEditEntry: ({ entry }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      if (entry.kind === "directory") {
        return {
          model: modifyFields(model, {
            modalState: () => Modal.openEditFolder(entry.name),
          }),
          commands: [
            PushUrl({ url: buildEditUrl(subPath, entry.name) }),
            toModalCommand(Modal.FocusModalNameInput()),
          ],
        }
      }

      return {
        model,
        commands: [PushUrl({ url: buildEditUrl(subPath, entry.name) })],
      }
    },

    ClickedEntryHistory: ({ entry }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model,
        commands: [PushUrl({ url: buildHistoryUrl(subPath, entry.name) })],
      }
    },

    ClickedOpenHelp: () => {
      const subPath = currentSubPathFromStorageState(model.storageState)
      const isFolderViewVisible = isReadyStorage(model.storageState)
      const activeTopic = isFolderViewVisible ? ("quickstart" as const) : ("fs" as const)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: () => Modal.openHelp(Option.some(activeTopic)),
        }),
        commands: [
          PushUrl({
            url: buildHelpUrl(subPath, Option.some(activeTopic)),
          }),
        ],
      }
    },

    PressedEscape: () => {
      if (model.isWindowFullscreen) {
        return {
          model,
          commands: [ExitFullscreenWindow()],
        }
      }
      if (Option.isSome(model.maybeActiveIslandUrl)) {
        const activePath = Option.getOrElse(model.maybeActiveIslandPath, () => "")
        const { folderSubPath } = parseIslandPath(activePath)
        const targetUrl = buildFolderUrl(folderSubPath)
        return {
          model: modifyFields(model, {
            maybeActiveIslandUrl: () => Option.none(),
            maybeActiveIslandPath: () => Option.none(),
          }),
          commands: [ReplaceUrl({ url: targetUrl }), RefreshEntries({ subPath: folderSubPath })],
        }
      }
      if (model.isSettingsDialogOpen) {
        if (model.clearAllHistoryState._tag === "Confirming") {
          return {
            model: modifyFields(model, {
              clearAllHistoryState: () => ClearAllHistoryState.Idle(),
            }),
          }
        }
        if (model.isConfirmingDeleteLlmProvider) {
          return {
            model: modifyFields(model, {
              isConfirmingDeleteLlmProvider: () => false,
            }),
          }
        }
        if (model.isEditingLlmSettings) {
          return {
            model: modifyFields(model, {
              isEditingLlmSettings: () => false,
              editingLlmProviderId: () => Option.none(),
              llmTestState: () => LlmTestState.Idle(),
            }),
          }
        }
        const subPath = currentSubPathFromStorageState(model.storageState)
        return {
          model: modifyFields(model, {
            isSettingsDialogOpen: () => false,
            llmTestState: () => LlmTestState.Idle(),
            clearAllHistoryState: () => ClearAllHistoryState.Idle(),
          }),
          ...(Modal.isOpen(model.modalState)
            ? {}
            : { commands: [ReplaceUrl({ url: buildFolderUrl(subPath) })] }),
        }
      }
      if (!Modal.isOpen(model.modalState)) {
        if (model.isSettingsOpen) {
          return {
            model: modifyFields(model, {
              isSettingsOpen: () => false,
            }),
          }
        }
        return { model }
      }
      if (Modal.isLlmSlashMenuOpen(model.modalState)) {
        return {
          model: modifyFields(model, {
            modalState: Modal.dismissLlmSlashMenu,
          }),
        }
      }
      if (Modal.isPreviewOpen(model.modalState)) {
        const shouldNavigateBack = Modal.isEditorPreviewOpen(model.modalState)
        return {
          model: modifyFields(model, {
            modalState: Modal.closePreview,
          }),
          ...(shouldNavigateBack ? { commands: [NavigateHistoryBack()] } : {}),
        }
      }
      if (Modal.isConfirmingDelete(model.modalState)) {
        return {
          model: modifyFields(model, {
            modalState: Modal.cancelDelete,
          }),
        }
      }
      if (Modal.isHistoryOpen(model.modalState)) {
        return {
          model: modifyFields(model, {
            modalState: Modal.closeHistory,
          }),
        }
      }
      if (Modal.isConfirmingOverwrite(model.modalState)) {
        return {
          model: modifyFields(model, {
            modalState: Modal.cancelOverwrite,
          }),
        }
      }
      if (Modal.isLlmModeMenuOpen(model.modalState)) {
        return {
          model: modifyFields(model, {
            modalState: Modal.closeLlmModeMenu,
          }),
        }
      }
      const subPath = currentSubPathFromStorageState(model.storageState)
      return {
        model: modifyFields(model, {
          isSettingsOpen: () => false,
          modalState: Modal.close,
        }),
        commands: [
          ReplaceUrl({ url: buildFolderUrl(subPath) }),
          toModalCommand(Modal.RevokeActivePreviewUrl()),
        ],
      }
    },

    // PWA Install Prompt
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

    ClickedInstallApp: () =>
      InstallPrompt.match(model.installPrompt, {
        Available: () => ({
          model: modifyFields(model, {
            installPrompt: () => InstallPrompt.Prompting(),
          }),
          commands: [TriggerInstallAppPrompt()],
        }),
        Unavailable: () => ({ model }),
        Prompting: () => ({ model }),
      }),

    CompletedTriggerInstallAppPrompt: ({ didAccept }) => ({
      model: modifyFields(model, {
        installPrompt: () => (didAccept ? InstallPrompt.Unavailable() : InstallPrompt.Available()),
      }),
    }),

    // Submodel: Modal
    GotModalMessage: ({ message: modalMessage }) => {
      const subPath = currentSubPathFromStorageState(model.storageState)
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

      const modalResult = Modal.update(model.modalState, modalMessage, {
        subPath,
        existingEntries,
        llmEnabled: isChatAvailable(model),
        llmEditFormat: model.llmEditFormat,
        editorDefaults: {
          llmBarMode: model.editorLlmBarMode,
          editorSplitPercent: model.editorSplitPercent,
        },
      })

      const mappedCommands = modalResult.commands
        ? Command.mapMessages(modalResult.commands, (msg) =>
            Message.GotModalMessage({ message: msg }),
          )
        : []

      const nextHistoryEnabled =
        modalMessage._tag === "GotEditorMessage" &&
        modalMessage.message._tag === "ToggledHistoryEnabled"
          ? modalMessage.message.isEnabled
          : modalMessage._tag === "GotEditorMessage" &&
              modalMessage.message._tag === "SucceededLoadFullHistory"
            ? modalMessage.message.isHistoryEnabled
            : model.historyEnabled

      return Modal.OutMessage.match(modalResult.outMessage, {
        None: () => {
          const isModalChatSending = (state: Model["modalState"]): boolean =>
            state._tag === "Editor" &&
            (state.editor._tag === "CreateFile" || state.editor._tag === "EditFile") &&
            state.editor.llmChatState._tag === "Sending"
          const nextModel = modifyFields(model, {
            modalState: () => modalResult.model,
            historyEnabled: () => nextHistoryEnabled,
          })
          const startedChat =
            !isModalChatSending(model.modalState) && isModalChatSending(modalResult.model)
          if (startedChat) {
            const editorModelsLoad = maybeLoadEditorLlmModels(nextModel)
            const commands = [...mappedCommands, ...(editorModelsLoad.commands ?? [])]
            return Array.isReadonlyArrayNonEmpty(commands)
              ? { model: editorModelsLoad.model, commands }
              : { model: editorModelsLoad.model }
          }
          return syncOpenEditor(nextModel, mappedCommands)
        },

        PushUrl: ({ url }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
          }),
          commands: [...mappedCommands, PushUrl({ url })],
        }),

        NavigateBack: () => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
          }),
          commands: [...mappedCommands, NavigateHistoryBack()],
        }),

        ReplaceUrl: ({ url }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
          }),
          commands: [...mappedCommands, ReplaceUrl({ url })],
        }),

        EntriesUpdated: ({
          entries,
          maybeAlertBanner,
          replaceUrl: shouldReplaceUrl,
          maybeReplaceUrl,
        }) => {
          const nextStorageState = Match.value(model.storageState).pipe(
            Match.tag("Ready", (readyState) => {
              const nextEntries = Array.isReadonlyArrayEmpty(entries)
                ? EntriesState.match(readyState.entriesState, {
                    Loading: () => entries,
                    Loaded: ({ entries: existing }) => existing,
                    Error: () => entries,
                  })
                : entries

              return modifyFields(readyState, {
                entriesState: () => EntriesState.Loaded({ entries: nextEntries }),
              })
            }),
            Match.orElse(() => model.storageState),
          )

          const baseModel = modifyFields(model, {
            storageState: () => nextStorageState,
            modalState: () => modalResult.model,
          })
          const toastResult = enqueueMaybeToast(baseModel, maybeAlertBanner)
          const replaceUrlCommands: ReadonlyArray<Command.Command<Message>> = Option.match(
            maybeReplaceUrl,
            {
              onSome: (url) => [ReplaceUrl({ url })],
              onNone: () =>
                shouldReplaceUrl ? [ReplaceUrl({ url: buildFolderUrl(subPath) })] : [],
            },
          )
          const commands: ReadonlyArray<Command.Command<Message>> = [
            ...mappedCommands,
            ...replaceUrlCommands,
            ...(toastResult.commands ?? []),
          ]

          return {
            model: toastResult.model,
            commands,
          }
        },

        FileHistoryCleared: ({ fileName }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
            storageState: (storageState) =>
              mapLoadedEntries(storageState, (entries) =>
                Array.map(
                  Array.filter(
                    entries,
                    (entry) => !(entry.name === fileName && entry.isDeleted === true),
                  ),
                  (entry) => (entry.name === fileName ? { ...entry, hasHistory: false } : entry),
                ),
              ),
          }),
          commands: mappedCommands,
        }),

        ShowAlert: ({ banner, replaceUrl: shouldReplaceUrl }) => {
          const toastResult = enqueueToast(
            modifyFields(model, {
              modalState: () => modalResult.model,
            }),
            banner,
          )
          const commands: ReadonlyArray<Command.Command<Message>> = [
            ...mappedCommands,
            ...(shouldReplaceUrl ? [ReplaceUrl({ url: buildFolderUrl(subPath) })] : []),
            ...(toastResult.commands ?? []),
          ]
          return {
            model: toastResult.model,
            commands,
          }
        },

        SelectedLlmModel: ({ value }) => {
          const nextThinkingLevel = resolveValidThinkingLevel(model, value, model.llmThinkingLevel)
          return {
            model: modifyFields(model, {
              modalState: () => modalResult.model,
              llmModel: () => value,
              llmDraftModel: () => value,
              llmThinkingLevel: () => nextThinkingLevel,
              llmDraftThinkingLevel: () => nextThinkingLevel,
            }),
            commands: [
              ...mappedCommands,
              SaveEditorPreferences({
                llmBarMode: model.editorLlmBarMode,
                llmModel: value,
                llmThinkingLevel: nextThinkingLevel,
                editorSplitPercent: model.editorSplitPercent,
              }),
            ],
          }
        },

        SelectedLlmThinkingLevel: ({ value }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
            llmThinkingLevel: () => value,
            llmDraftThinkingLevel: () => value,
          }),
          commands: [
            ...mappedCommands,
            SaveEditorPreferences({
              llmBarMode: model.editorLlmBarMode,
              llmModel: model.llmModel,
              llmThinkingLevel: value,
              editorSplitPercent: model.editorSplitPercent,
            }),
          ],
        }),

        ChangedLlmBarMode: ({ llmBarMode }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
            editorLlmBarMode: () => llmBarMode,
          }),
          commands: [
            ...mappedCommands,
            SaveEditorPreferences({
              llmBarMode,
              llmModel: model.llmModel,
              llmThinkingLevel: model.llmThinkingLevel,
              editorSplitPercent: model.editorSplitPercent,
            }),
          ],
        }),

        ChangedEditorSplitPercent: ({ editorSplitPercent }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
            editorSplitPercent: () => editorSplitPercent,
          }),
          commands: [
            ...mappedCommands,
            SaveEditorPreferences({
              llmBarMode: model.editorLlmBarMode,
              llmModel: model.llmModel,
              llmThinkingLevel: model.llmThinkingLevel,
              editorSplitPercent,
            }),
          ],
        }),

        RequestedSettings: () => ({
          model: openSettingsDialogModel(
            modifyFields(model, {
              modalState: () => modalResult.model,
            }),
          ),
          commands: mappedCommands,
        }),
      })
    },
  })

// SUBSCRIPTION

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isNumberArray = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) && Array.every(value, (item): item is number => typeof item === "number")

const parseIslandIpcAction = (data: Record<string, unknown>): Option.Option<IslandIpcAction> => {
  const action = data.action
  if (action === "write" && typeof data.subPath === "string" && isNumberArray(data.data)) {
    return Option.some(
      IslandIpcAction.Write({
        subPath: data.subPath,
        data: data.data,
      }),
    )
  }
  if (action === "mkdir" && typeof data.subPath === "string") {
    return Option.some(IslandIpcAction.MakeDir({ subPath: data.subPath }))
  }
  if (action === "rename" && typeof data.from === "string" && typeof data.to === "string") {
    return Option.some(IslandIpcAction.Rename({ from: data.from, to: data.to }))
  }
  if (
    action === "remove" &&
    typeof data.subPath === "string" &&
    typeof data.recursive === "boolean"
  ) {
    return Option.some(
      IslandIpcAction.Remove({
        subPath: data.subPath,
        recursive: data.recursive,
      }),
    )
  }
  if (action === "copy" && typeof data.from === "string" && typeof data.to === "string") {
    return Option.some(IslandIpcAction.Copy({ from: data.from, to: data.to }))
  }
  return Option.none()
}

export const parseIslandWindowMessage = (event: Event): Option.Option<Message> => {
  if (!(event instanceof MessageEvent)) {
    return Option.none()
  }
  const data: unknown = event.data
  if (!isRecord(data)) {
    return Option.none()
  }
  if (data.type === "pwaislands:navigate" && typeof data.url === "string") {
    return Option.some(Message.ReceivedIslandNavigation({ url: data.url }))
  }
  if (data.type === "pwaislands:titlebar-double-click") {
    return Option.some(Message.DoubleClickedReturnArrow())
  }
  if (data.type === "pwaislands:titlebar-click") {
    return Option.some(Message.ClickedReturnArrow())
  }
  const requestId = data.requestId
  if (data.type === "pwaislands:ipc" && typeof requestId === "string") {
    return Option.map(parseIslandIpcAction(data), (action) =>
      Message.ReceivedIslandIpcRequest({
        requestId,
        action,
      }),
    )
  }
  return Option.none()
}
const isBeforeInstallPromptEvent = (event: Event): event is BeforeInstallPromptEvent =>
  "prompt" in event && typeof event.prompt === "function" && "userChoice" in event

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  escapeKey: entry(
    {
      isActive: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        isActive:
          model.isWindowFullscreen ||
          model.isSettingsOpen ||
          model.isSettingsDialogOpen ||
          Modal.isOpen(model.modalState) ||
          Option.isSome(model.maybeActiveIslandUrl),
      }),
      dependenciesToStream: ({ isActive }) =>
        Dom.streamFromKeyBindings<Message>({
          bindings: [
            {
              keys: "Escape",
              isEnabled: isActive,
              whileTyping: "Allow",
              mapEvent: () => Message.PressedEscape(),
            },
          ],
        }),
    },
  ),

  historyShortcuts: Subscription.persistentEntry(
    Dom.streamFromKeyBindings<Message>({
      bindings: [
        {
          keys: "Alt+ArrowLeft",
          mapEvent: () => Message.PressedNavigateBack(),
        },
        {
          keys: "Meta+[",
          mapEvent: () => Message.PressedNavigateBack(),
        },
        {
          keys: "Alt+ArrowRight",
          mapEvent: () => Message.PressedNavigateForward(),
        },
        {
          keys: "Meta+]",
          mapEvent: () => Message.PressedNavigateForward(),
        },
      ],
    }),
  ),

  islandNavigation: Subscription.persistentEntry(
    Dom.streamFromEventFilterMap({
      target: window,
      type: "message",
      filterMapEvent: parseIslandWindowMessage,
    }),
  ),

  outsideSettingsClick: entry(
    {
      isSettingsOpen: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        isSettingsOpen: model.isSettingsOpen,
      }),
      dependenciesToStream: ({ isSettingsOpen }) =>
        Stream.when(
          Dom.streamFromEventFilterMap({
            target: document,
            type: "click",
            filterMapEvent: (event) => {
              const target = event.target
              if (!(target instanceof Node)) {
                return Option.none()
              }
              const settingsRoot = document.getElementById("settings-menu")
              if (settingsRoot && !settingsRoot.contains(target)) {
                return Option.some(Message.ClickedOutsideSettingsMenu())
              }
              return Option.none()
            },
          }),
          Effect.sync(() => isSettingsOpen),
        ),
    },
  ),

  outsideLlmModeMenuClick: entry(
    {
      isLlmModeMenuOpen: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        isLlmModeMenuOpen: Modal.isLlmModeMenuOpen(model.modalState),
      }),
      dependenciesToStream: ({ isLlmModeMenuOpen }) =>
        Stream.when(
          Dom.streamFromEventFilterMap({
            target: document,
            type: "click",
            filterMapEvent: (event) => {
              const target = event.target
              if (!(target instanceof Node)) {
                return Option.none()
              }
              const menuRoot = document.getElementById("modal-llm-mode-menu")
              if (menuRoot && !menuRoot.contains(target)) {
                return Option.some(Message.ClickedOutsideLlmModeMenu())
              }
              return Option.none()
            },
          }),
          Effect.sync(() => isLlmModeMenuOpen),
        ),
    },
  ),

  beforeInstallPrompt: Subscription.persistentEntry(
    Dom.streamFromEventFilterMapPreventDefault({
      target: window,
      type: "beforeinstallprompt",
      filterMapEvent: (event) => {
        if (!isBeforeInstallPromptEvent(event)) {
          return Option.none()
        }
        setDeferredInstallPrompt(Option.some(event))
        return Option.some(Message.CapturedInstallPrompt())
      },
    }),
  ),

  appInstalled: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window,
      type: "appinstalled",
      mapEvent: () => {
        setDeferredInstallPrompt(Option.none())
        return Message.InstalledApp()
      },
    }),
  ),

  windowFocus: Subscription.persistentEntry(
    Stream.merge(
      Dom.streamFromEvent({
        target: window,
        type: "focus",
        mapEvent: () => Message.ChangedWindowFocus({ isFocused: true }),
      }),
      Dom.streamFromEvent({
        target: window,
        type: "blur",
        mapEvent: () => Message.ChangedWindowFocus({ isFocused: false }),
      }),
    ),
  ),

  windowMaximized: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window as Dom.TypedEventTarget<{
        "pwaislands:window-maximized": CustomEvent<boolean>
      }>,
      type: "pwaislands:window-maximized",
      mapEvent: (event) =>
        Message.ChangedWindowMaximized({
          isMaximized: Boolean(event.detail),
        }),
    }),
  ),

  windowFullscreen: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window as Dom.TypedEventTarget<{
        "pwaislands:window-fullscreen": CustomEvent<boolean>
      }>,
      type: "pwaislands:window-fullscreen",
      mapEvent: (event) =>
        Message.ChangedWindowFullscreen({
          isFullscreen: Boolean(event.detail),
        }),
    }),
  ),

  serviceWorkerToast: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window as Dom.TypedEventTarget<{
        "pwaislands:sw-toast": CustomEvent<AlertBanner>
      }>,
      type: "pwaislands:sw-toast",
      mapEvent: (event) =>
        Message.ReceivedServiceWorkerToast({
          banner: event.detail,
        }),
    }),
  ),

  fullscreenShortcut: entry(
    {
      isEnabled: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        isEnabled: model.hasTauri && model.isWindowsOrLinux,
      }),
      dependenciesToStream: ({ isEnabled }) =>
        Dom.streamFromKeyBindings<Message>({
          bindings: [
            {
              keys: "F11",
              isEnabled,
              whileTyping: "Allow",
              mapEvent: () => Message.ClickedToggleFullscreen(),
            },
          ],
        }),
    },
  ),

  llmTestStream: entry(
    {
      isStreaming: Schema.Boolean,
      mode: LlmTestMode,
      enabled: Schema.Boolean,
      editFormat: EditFormat,
      baseUrl: Schema.String,
      apiKey: Schema.String,
      models: Schema.String,
      streaming: Schema.Boolean,
      toolCalls: Schema.Boolean,
      thinkingParam: Schema.String,
      thinkingLevels: Schema.String,
      extraArgs: Schema.String,
      model: Schema.String,
      thinkingLevel: Schema.String,
    },
    {
      modelToDependencies: (model) => ({
        isStreaming: model.llmTestState._tag === "Streaming",
        mode: model.llmTestState._tag === "Streaming" ? model.llmTestState.mode : "chat",
        enabled: model.llmDraftEnabled,
        editFormat: model.llmDraftEditFormat,
        baseUrl: model.llmDraftBaseUrl,
        apiKey: model.llmDraftApiKey,
        models: model.llmDraftModels,
        ...(model.llmDraftModelFilter !== "" ? { modelFilter: model.llmDraftModelFilter } : {}),
        streaming: model.llmDraftStreaming,
        toolCalls: model.llmDraftToolCalls,
        thinkingParam: model.llmDraftThinkingParam,
        thinkingLevels: model.llmDraftThinkingLevels,
        extraArgs: model.llmDraftExtraArgs,
        model: model.llmDraftModel,
        thinkingLevel: model.llmDraftThinkingLevel,
      }),
      dependenciesToStream: (deps) => {
        if (!deps.isStreaming) {
          return Stream.empty
        }
        return Stream.callback<Message>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const controller = new AbortController()
              const activeModel = resolveTestModel(deps)
              const requestConfig = { ...deps, model: activeModel }
              const onChunk = ({ content, reasoning }: { content: string; reasoning: string }) => {
                Queue.offerUnsafe(queue, Message.UpdatedTestLlmStream({ content, reasoning }))
              }
              const runStream =
                deps.mode === "tools"
                  ? streamToolCallParts(requestConfig, onChunk, controller.signal)
                  : streamChatParts(
                      requestConfig,
                      "Antworte nur mit: ok",
                      onChunk,
                      controller.signal,
                    )
              void runStream
                .then((parts) => {
                  if (controller.signal.aborted) {
                    return
                  }
                  if (parts.content.trim() === "" && parts.reasoning.trim() === "") {
                    Queue.offerUnsafe(
                      queue,
                      Message.FailedTestLlm({
                        message: "Fehlgeschlagen: Unerwartete Antwort: leere Chat-Antwort",
                      }),
                    )
                  } else {
                    Queue.offerUnsafe(
                      queue,
                      Message.SucceededTestLlm({
                        content: parts.content.trim(),
                        reasoning: parts.reasoning.trim(),
                        models: [],
                      }),
                    )
                  }
                  Queue.endUnsafe(queue)
                })
                .catch((error: unknown) => {
                  if (controller.signal.aborted) {
                    return
                  }
                  const errMsg = error instanceof Error ? error.message : "Unbekannter Fehler"
                  Queue.offerUnsafe(
                    queue,
                    Message.FailedTestLlm({ message: `Fehlgeschlagen: ${errMsg}` }),
                  )
                  Queue.endUnsafe(queue)
                })
              return controller
            }),
            (controller) => Effect.sync(() => controller.abort()),
          ),
        )
      },
    },
  ),
  editorLlmChatStream: entry(
    {
      isSending: Schema.Boolean,
      prompt: Schema.String,
      fileName: Schema.String,
      content: Schema.String,
      messages: Schema.Array(Editor.LlmChatMessage),
      enabled: Schema.Boolean,
      editFormat: EditFormat,
      baseUrl: Schema.String,
      apiKey: Schema.String,
      models: Schema.String,
      streaming: Schema.Boolean,
      toolCalls: Schema.Boolean,
      thinkingParam: Schema.String,
      thinkingLevels: Schema.String,
      extraArgs: Schema.String,
      model: Schema.String,
      thinkingLevel: Schema.String,
    },
    {
      modelToDependencies: (model) => {
        const sending = (() => {
          if (model.modalState._tag !== "Editor") {
            return undefined
          }
          const editor = model.modalState.editor
          if (editor._tag !== "CreateFile" && editor._tag !== "EditFile") {
            return undefined
          }
          return editor.llmChatState._tag === "Sending" ? editor.llmChatState : undefined
        })()

        const effectiveModel = resolveEffectiveLlmModel(model)
        const selectedProvider =
          model.llmProviders.length > 0
            ? resolveProviderForModelSelection(model.llmProviders, effectiveModel)
            : undefined

        return {
          isSending: sending !== undefined,
          prompt: sending?.prompt ?? "",
          fileName: sending?.fileName ?? "",
          content: sending?.content ?? "",
          messages: sending?.messages ?? [],
          enabled: isChatAvailable(model),
          editFormat:
            selectedProvider !== undefined && selectedProvider.editFormat !== ""
              ? selectedProvider.editFormat
              : model.llmEditFormat,
          baseUrl: selectedProvider?.baseUrl ?? model.llmBaseUrl,
          apiKey: selectedProvider?.apiKey ?? model.llmApiKey,
          models: selectedProvider?.models ?? model.llmModels,
          streaming: selectedProvider?.streaming ?? model.llmStreaming,
          toolCalls: selectedProvider?.toolCalls ?? model.llmToolCalls,
          thinkingParam: selectedProvider?.thinkingParam ?? model.llmThinkingParam,
          thinkingLevels: selectedProvider?.thinkingLevels ?? model.llmThinkingLevels,
          extraArgs: selectedProvider?.extraArgs ?? model.llmExtraArgs,
          model: stripProviderPrefixFromModelSelection(effectiveModel),
          thinkingLevel: model.llmThinkingLevel,
        }
      },
      dependenciesToStream: (deps) => {
        if (!deps.isSending) {
          return Stream.empty
        }
        return Stream.callback<Message>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const controller = new AbortController()
              const runTurn = async () => {
                const initialMessages: ReadonlyArray<EditorChatMessage> =
                  Array.isReadonlyArrayEmpty(deps.messages)
                    ? await (async () => {
                        const res = await fetch("/api.d.ts", {
                          cache: "no-cache",
                          signal: controller.signal,
                        })
                        if (!res.ok) {
                          throw new Error(`HTTP ${res.status} beim Laden von /api.d.ts`)
                        }
                        const apiDts = await res.text()
                        return [
                          {
                            _tag: "System" as const,
                            content: formatSystemPromptForFormat(
                              deps.editFormat,
                              deps.toolCalls && !isLanguageModelSelection(deps.model),
                            ),
                          },
                          { _tag: "User" as const, content: formatApiDtsMessage(apiDts) },
                          {
                            _tag: "User" as const,
                            content: formatFileMessageForFormat(
                              deps.editFormat,
                              deps.fileName,
                              deps.content,
                            ),
                          },
                          { _tag: "User" as const, content: deps.prompt },
                        ]
                      })()
                    : [
                        ...toAgentEditorMessages(deps.messages),
                        { _tag: "User" as const, content: deps.prompt },
                      ]

                if (Array.isReadonlyArrayEmpty(deps.messages) && !controller.signal.aborted) {
                  Queue.offerUnsafe(
                    queue,
                    Message.UpdatedEditorLlmChatStream({
                      completedTurns: [],
                      activeTurn: { content: "", reasoning: "" },
                      initialMessages: toEditorSchemaMessages(initialMessages),
                    }),
                  )
                }

                return runEditorChatTurn({
                  config: {
                    enabled: deps.enabled,
                    editFormat: deps.editFormat,
                    baseUrl: deps.baseUrl,
                    apiKey: deps.apiKey,
                    models: deps.models,
                    streaming: deps.streaming,
                    toolCalls: deps.toolCalls,
                    thinkingParam: deps.thinkingParam,
                    thinkingLevels: deps.thinkingLevels,
                    extraArgs: deps.extraArgs,
                    model: deps.model,
                    thinkingLevel: deps.thinkingLevel,
                  },
                  fileName: deps.fileName,
                  initialContent: deps.content,
                  initialMessages,
                  onUpdate: ({ completedTurns, activeTurn }) => {
                    if (!controller.signal.aborted) {
                      Queue.offerUnsafe(
                        queue,
                        Message.UpdatedEditorLlmChatStream({
                          completedTurns: [...completedTurns],
                          activeTurn,
                        }),
                      )
                    }
                  },
                  signal: controller.signal,
                })
              }

              void runTurn()
                .then((result) => {
                  if (controller.signal.aborted) {
                    return
                  }
                  Queue.offerUnsafe(
                    queue,
                    Message.SucceededEditorLlmChat({
                      messages: toEditorSchemaMessages(result.messages),
                      maybeUpdatedContent:
                        result.updatedContent !== undefined
                          ? Option.some(result.updatedContent)
                          : Option.none(),
                      appliedCount: result.appliedCount,
                      turns: [...result.turns],
                    }),
                  )
                  Queue.endUnsafe(queue)
                })
                .catch((error: unknown) => {
                  if (controller.signal.aborted) {
                    return
                  }
                  const errMsg = error instanceof Error ? error.message : String(error)
                  Queue.offerUnsafe(queue, Message.FailedEditorLlmChat({ message: errMsg }))
                  Queue.endUnsafe(queue)
                })

              return controller
            }),
            (controller) => Effect.sync(() => controller.abort()),
          ),
        )
      },
    },
  ),
}))

// VIEW

const INSTALL_AVAILABLE = {
  Available: () => true,
  Unavailable: () => false,
  Prompting: () => false,
}

const PDF_EXTENSIONS = new Set(["pdf"])

const FILE_ICON_GROUPS: ReadonlyArray<{
  readonly extensions: ReadonlySet<string>
  readonly icon: IconId
}> = [
  { extensions: PREVIEWABLE_IMAGE_EXTENSIONS, icon: "file-image" },
  { extensions: PDF_EXTENSIONS, icon: "file-pdf" },
  {
    extensions: new Set(["html", "htm", "xhtml"]),
    icon: "file-html",
  },
  {
    extensions: new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx"]),
    icon: "file-code",
  },
  { extensions: new Set(["css"]), icon: "file-css" },
  {
    extensions: new Set(["json", "webmanifest", "yml", "yaml", "toml", "ini", "xml"]),
    icon: "file-config",
  },
  {
    extensions: new Set(["md", "txt"]),
    icon: "file-text",
  },
  {
    extensions: new Set(["csv"]),
    icon: "file-csv",
  },
  {
    extensions: new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]),
    icon: "file-audio",
  },
  {
    extensions: new Set(["mp4", "webm", "mov", "mkv", "avi"]),
    icon: "file-video",
  },
  {
    extensions: new Set(["zip", "gz", "tar", "rar", "7z", "bz2"]),
    icon: "file-archive",
  },
  {
    extensions: new Set(["ttf", "otf", "woff", "woff2"]),
    icon: "file-font",
  },
]

export const fileIconFor = (name: string, isDirectory: boolean): IconId => {
  if (isDirectory) {
    return "folder"
  }
  const ext = getFileExtension(name)
  return pipe(
    FILE_ICON_GROUPS,
    Array.findFirst((group) => group.extensions.has(ext)),
    Option.match({
      onNone: () => "file",
      onSome: (group) => group.icon,
    }),
  )
}

const viewBreadcrumbNav = (children: ReadonlyArray<Html.Html>, h: HtmlBuilder): Html.Html =>
  h.nav([h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfad")], children)

const viewBreadcrumbs = (model: Model, h: HtmlBuilder): Html.Html =>
  StorageState.match(model.storageState, {
    Initializing: () =>
      viewBreadcrumbNav([h.span([h.Class("breadcrumb-current")], ["PWA Islands"])], h),

    Unsupported: () =>
      viewBreadcrumbNav(
        [
          h.span(
            [h.Class("breadcrumb-current")],
            [t(model.language).settings.unsupportedFsBreadcrumb],
          ),
        ],
        h,
      ),

    NoFolderSelected: () =>
      viewBreadcrumbNav([h.span([h.Class("breadcrumb-current")], ["PWA Islands"])], h),

    PermissionRequired: () =>
      viewBreadcrumbNav([h.span([h.Class("breadcrumb-current")], ["PWA Islands"])], h),

    Ready: ({ subPath }) =>
      Array.match(subPath, {
        onEmpty: () =>
          viewBreadcrumbNav(
            [h.span([h.Class("breadcrumb-current"), h.Title("PWA Islands")], ["PWA Islands"])],
            h,
          ),
        onNonEmpty: (subPath) => {
          const segmentNodes = pipe(
            subPath,
            Array.flatMap((segment, i) => {
              const isLast = Array.isArrayEmpty(Array.drop(subPath, i + 1))
              const accumulatedPath = pipe(Array.take(subPath, i + 1), Array.join("/"))
              const separator = h.span([h.Class("breadcrumb-separator"), h.AriaHidden(true)], ["/"])
              const item = isLast
                ? h.span([h.Class("breadcrumb-current"), h.Title(segment)], [segment])
                : h.button(
                    [
                      h.Type("button"),
                      h.Class("breadcrumb-item"),
                      h.Title(segment),
                      h.DataAttribute("segment", accumulatedPath),
                      h.OnClick(Message.ClickedBreadcrumbSegment({ index: i })),
                    ],
                    [segment],
                  )
              return [separator, item]
            }),
          )

          return viewBreadcrumbNav(
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class("breadcrumb-item"),
                  h.Title("PWA Islands"),
                  h.DataAttribute("segment", ""),
                  h.OnClick(Message.ClickedBreadcrumbRoot()),
                ],
                ["PWA Islands"],
              ),
              ...segmentNodes,
            ],
            h,
          )
        },
      }),
  })

const getStorageCapabilities = (model: Model) => {
  const hasLocalFolderSupport = !model.hasTauri && model.hasDirectoryPicker
  const {
    isReady,
    isFsaReady,
    isFsaNoFolder,
    isFsaPermissionRequired,
    canSwitchToOpfs,
    canSwitchToFsa,
  } = StorageState.match(model.storageState, {
    Initializing: () => ({
      isReady: false,
      isFsaReady: false,
      isFsaNoFolder: false,
      isFsaPermissionRequired: false,
      canSwitchToOpfs: false,
      canSwitchToFsa: false,
    }),
    Unsupported: () => ({
      isReady: false,
      isFsaReady: false,
      isFsaNoFolder: false,
      isFsaPermissionRequired: false,
      canSwitchToOpfs: false,
      canSwitchToFsa: false,
    }),
    NoFolderSelected: ({ storageType }) => ({
      isReady: false,
      isFsaReady: false,
      isFsaNoFolder: isLocalFolderStorage(storageType),
      isFsaPermissionRequired: false,
      canSwitchToOpfs: !model.hasTauri && model.hasOPFS && storageType !== "opfs",
      canSwitchToFsa: hasLocalFolderSupport && !isLocalFolderStorage(storageType),
    }),
    PermissionRequired: ({ storageType }) => ({
      isReady: false,
      isFsaReady: false,
      isFsaNoFolder: false,
      isFsaPermissionRequired: isLocalFolderStorage(storageType),
      canSwitchToOpfs: !model.hasTauri && model.hasOPFS && storageType !== "opfs",
      canSwitchToFsa: hasLocalFolderSupport && !isLocalFolderStorage(storageType),
    }),
    Ready: ({ storageType }) => ({
      isReady: true,
      isFsaReady: isLocalFolderStorage(storageType),
      isFsaNoFolder: false,
      isFsaPermissionRequired: false,
      canSwitchToOpfs: !model.hasTauri && model.hasOPFS && storageType !== "opfs",
      canSwitchToFsa: hasLocalFolderSupport && !isLocalFolderStorage(storageType),
    }),
  })
  return {
    isReady,
    isFsaReady,
    isFsaNoFolder,
    isFsaPermissionRequired,
    canSwitchToOpfs,
    canSwitchToFsa,
  }
}

const viewSettingsMenu = (model: Model, h: HtmlBuilder): Html.Html => {
  const { isReady } = getStorageCapabilities(model)
  const isInstallAvailable = InstallPrompt.match(model.installPrompt, INSTALL_AVAILABLE)
  const tr = t(model.language)

  return h.div(
    [h.Class("settings-menu"), h.Id("settings-menu")],
    [
      h.button(
        [
          h.Type("button"),
          h.Id("btn-settings"),
          h.Class("btn btn-secondary btn-icon"),
          h.Title(tr.settings.title),
          h.AriaLabel(tr.settings.title),
          h.AriaHasPopup("true"),
          h.AriaExpanded(model.isSettingsOpen),
          h.OnClick(Message.ClickedToggleSettings(), {
            propagation: "Stop",
          }),
        ],
        [viewIcon("settings", h)],
      ),
      h.div(
        [
          h.Id("settings-menu-list"),
          h.Class("settings-menu-list"),
          h.Hidden(!model.isSettingsOpen),
          h.Role("menu"),
        ],
        [
          h.button(
            [
              h.Type("button"),
              h.Id("btn-open-help"),
              h.Class("settings-menu-item"),
              h.Role("menuitem"),
              h.OnClick(Message.ClickedOpenHelp()),
            ],
            [viewIcon("help", h), ` ${tr.common.help}`],
          ),
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-toggle-file-info"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.OnClick(Message.ClickedToggleFileInfo()),
                ],
                [
                  viewIcon("file-info", h),
                  model.showFileInfo
                    ? ` ${tr.settings.fileInfoHide}`
                    : ` ${tr.settings.fileInfoShow}`,
                ],
              )
            : h.empty,
          h.button(
            [
              h.Type("button"),
              h.Id("btn-open-settings"),
              h.Class("settings-menu-item"),
              h.Role("menuitem"),
              h.OnClick(Message.ClickedOpenSettingsDialog()),
            ],
            [viewIcon("settings", h), ` ${tr.settings.title}`],
          ),
          isInstallAvailable
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-install-app"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.Title(tr.settings.installAppTitle),
                  h.OnClick(Message.ClickedInstallApp()),
                ],
                [viewIcon("install", h), ` ${tr.settings.installApp}`],
              )
            : h.empty,
        ],
      ),
    ],
  )
}

const viewSettingsDialog = (model: Model, h: HtmlBuilder): Html.Html => {
  if (!model.isSettingsDialogOpen) {
    return h.empty
  }
  const tr = t(model.language)
  const { isFsaReady, isFsaNoFolder, isFsaPermissionRequired, canSwitchToOpfs, canSwitchToFsa } =
    getStorageCapabilities(model)
  const currentStorageLabel = Option.map(
    currentStorageTypeFromStorageState(model.storageState),
    (storageType) =>
      storageType === "opfs"
        ? tr.settings.storageOpfs
        : storageType === "tauri"
          ? tr.settings.storageTauri
          : tr.settings.storageFsa,
  )

  return h.div(
    [h.Class("settings-dialog-host")],
    [
      h.div(
        [
          h.Id("settings-dialog"),
          h.Class("modal-overlay"),
          h.Role("dialog"),
          h.AriaModal(true),
          h.AriaLabelledBy("settings-dialog-title"),
        ],
        [
          h.div(
            [h.Class("modal-content settings-dialog")],
            [
              h.header(
                [h.Class("modal-header")],
                [
                  h.h3(
                    [h.Id("settings-dialog-title"), h.Class("modal-title")],
                    [tr.settings.title],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-close-settings"),
                      h.Class("modal-close-btn"),
                      h.AriaLabel(tr.common.close),
                      h.OnClick(Message.ClickedCloseSettingsDialog()),
                    ],
                    [viewIcon("close", h)],
                  ),
                ],
              ),
              h.div(
                [h.Class("modal-body settings-groups")],
                [
                  h.section(
                    [h.Class("settings-group"), h.Id("settings-group-language")],
                    [
                      h.h4([h.Class("settings-group-title")], [tr.settings.language]),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.select(
                            [
                              h.Id("settings-language"),
                              h.Class("form-input"),
                              h.AriaLabel(tr.settings.language),
                              h.Value(model.language),
                              h.OnChange((value) =>
                                Message.SelectedSettingsLanguage({
                                  language: isLanguage(value) ? value : "en",
                                }),
                              ),
                            ],
                            [
                              h.option(
                                [h.Value("en"), h.Selected(model.language === "en")],
                                [tr.languageName.en],
                              ),
                              h.option(
                                [h.Value("de"), h.Selected(model.language === "de")],
                                [tr.languageName.de],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                  h.section(
                    [h.Class("settings-group"), h.Id("settings-group-fs")],
                    [
                      h.h4(
                        [h.Id("current-storage"), h.Class("settings-group-title")],
                        [
                          Option.match(currentStorageLabel, {
                            onNone: () => tr.settings.fsTitle,
                            onSome: (label) =>
                              model.hasTauri ? tr.settings.fsTitle : tr.settings.fsWithLabel(label),
                          }),
                        ],
                      ),
                      h.div(
                        [h.Class("settings-group-actions")],
                        [
                          canSwitchToOpfs
                            ? h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-use-opfs"),
                                  h.Class("btn btn-secondary"),
                                  h.Role("menuitem"),
                                  h.Title(tr.settings.switchToOpfsTitle),
                                  h.OnClick(Message.ClickedUseOpfs()),
                                ],
                                [viewIcon("package", h), ` ${tr.settings.switchToOpfs}`],
                              )
                            : h.empty,
                          canSwitchToFsa
                            ? h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-select-folder"),
                                  h.Class("btn btn-secondary"),
                                  h.Role("menuitem"),
                                  h.OnClick(Message.ClickedUseFsa()),
                                ],
                                [viewIcon("folder", h), ` ${tr.settings.switchToFsa}`],
                              )
                            : h.empty,
                          isFsaNoFolder
                            ? h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-change-folder"),
                                  h.Class("btn btn-secondary"),
                                  h.Role("menuitem"),
                                  h.Title(tr.settings.selectFolder),
                                  h.OnClick(Message.ClickedSelectFolder()),
                                ],
                                [viewIcon("folder-open", h), ` ${tr.settings.selectFolder}`],
                              )
                            : h.empty,
                          isFsaReady || isFsaPermissionRequired
                            ? h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-change-folder"),
                                  h.Class("btn btn-secondary"),
                                  h.Role("menuitem"),
                                  h.Title(tr.settings.changeFolderTitle),
                                  h.OnClick(Message.ClickedChangeFolder()),
                                ],
                                [viewIcon("folder-open", h), ` ${tr.settings.changeFolder}`],
                              )
                            : h.empty,
                          isFsaReady
                            ? h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-disconnect-folder"),
                                  h.Class("btn btn-secondary is-danger"),
                                  h.Role("menuitem"),
                                  h.Title(tr.settings.disconnectFolderTitle),
                                  h.OnClick(Message.ClickedDisconnectFolder()),
                                ],
                                [viewIcon("plug", h), ` ${tr.settings.disconnectFolder}`],
                              )
                            : h.empty,
                        ],
                      ),
                    ],
                  ),
                  h.section(
                    [h.Class("settings-group"), h.Id("settings-group-history")],
                    [
                      h.h4([h.Class("settings-group-title")], [tr.settings.historyTitle]),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("settings-history-enabled"),
                                h.Checked(model.historyEnabled),
                                h.OnChange(() =>
                                  Message.ToggledSettingsHistoryEnabled({
                                    isEnabled: !model.historyEnabled,
                                  }),
                                ),
                              ]),
                              h.span([], [tr.settings.historyAutoSave]),
                            ],
                          ),
                          h.p([h.Class("form-hint")], [tr.settings.historyAutoSaveHint]),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("settings-api-history-enabled"),
                                h.Checked(model.apiHistoryEnabled),
                                h.OnChange(() =>
                                  Message.ToggledSettingsApiHistoryEnabled({
                                    isEnabled: !model.apiHistoryEnabled,
                                  }),
                                ),
                              ]),
                              h.span([], [tr.settings.apiHistorySave]),
                            ],
                          ),
                          h.p([h.Class("form-hint")], [tr.settings.apiHistorySaveHint]),
                        ],
                      ),
                      ClearAllHistoryState.match(model.clearAllHistoryState, {
                        Idle: () =>
                          h.div(
                            [h.Class("settings-group-actions")],
                            [
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-clear-all-history"),
                                  h.Class("btn btn-danger"),
                                  h.OnClick(Message.ClickedRequestClearAllHistory()),
                                ],
                                [viewIcon("trash", h), ` ${tr.settings.clearAllHistory}`],
                              ),
                            ],
                          ),
                        Confirming: () =>
                          h.div(
                            [h.Class("settings-group-actions")],
                            [
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-clear-all-history"),
                                  h.Class("btn btn-danger"),
                                  h.OnClick(Message.ClickedRequestClearAllHistory()),
                                ],
                                [viewIcon("trash", h), ` ${tr.settings.clearAllHistory}`],
                              ),
                            ],
                          ),
                        Clearing: () =>
                          h.div(
                            [h.Class("settings-group-actions")],
                            [
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("btn-clear-all-history"),
                                  h.Class("btn btn-danger"),
                                  h.Disabled(true),
                                ],
                                [tr.settings.clearingHistory],
                              ),
                            ],
                          ),
                        Done: () =>
                          h.div(
                            [h.Class("settings-group-actions")],
                            [
                              h.span(
                                [h.Id("clear-all-history-done"), h.Class("form-hint")],
                                [tr.settings.clearedAllHistory],
                              ),
                            ],
                          ),
                      }),
                    ],
                  ),
                  h.section(
                    [h.Class("settings-group"), h.Id("settings-group-editor")],
                    [
                      h.h4([h.Class("settings-group-title")], [tr.settings.editorTitle]),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("settings-editor-line-numbers"),
                                h.Checked(model.editorLineNumbers),
                                h.OnChange(() =>
                                  Message.ToggledSettingsEditorLineNumbers({
                                    isEnabled: !model.editorLineNumbers,
                                  }),
                                ),
                              ]),
                              h.span([], [tr.settings.editorLineNumbers]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("settings-editor-folding"),
                                h.Checked(model.editorFolding),
                                h.OnChange(() =>
                                  Message.ToggledSettingsEditorFolding({
                                    isEnabled: !model.editorFolding,
                                  }),
                                ),
                              ]),
                              h.span([], [tr.settings.editorFoldingShort]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("settings-editor-word-wrap"),
                                h.Checked(model.editorWordWrap),
                                h.OnChange(() =>
                                  Message.ToggledSettingsEditorWordWrap({
                                    isEnabled: !model.editorWordWrap,
                                  }),
                                ),
                              ]),
                              h.span([], [tr.settings.editorWordWrapShort]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("settings-editor-scroll-beyond-last-line"),
                                h.Checked(model.editorScrollBeyondLastLine),
                                h.OnChange(() =>
                                  Message.ToggledSettingsEditorScrollBeyondLastLine({
                                    isEnabled: !model.editorScrollBeyondLastLine,
                                  }),
                                ),
                              ]),
                              h.span([], [tr.settings.editorScrollBeyondLastLine]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("settings-editor-undo-in-titlebar"),
                                h.Checked(model.editorUndoInTitlebar),
                                h.OnChange(() =>
                                  Message.ToggledSettingsEditorUndoInTitlebar({
                                    isEnabled: !model.editorUndoInTitlebar,
                                  }),
                                ),
                              ]),
                              h.span([], [tr.settings.editorUndoInTitlebarShort]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.For("settings-editor-line-decorations-width")],
                            [tr.settings.editorLineDecorationsWidthShort],
                          ),
                          h.div(
                            [h.Class("form-range-row")],
                            [
                              h.input([
                                h.Type("range"),
                                h.Id("settings-editor-line-decorations-width"),
                                h.Min("0"),
                                h.Max("32"),
                                h.Step("1"),
                                h.Value(String(model.editorLineDecorationsWidth)),
                                h.OnInput((value) =>
                                  Message.UpdatedSettingsEditorLineDecorationsWidth({
                                    value: parseRangeNumber(
                                      value,
                                      model.editorLineDecorationsWidth,
                                      0,
                                      32,
                                    ),
                                  }),
                                ),
                              ]),
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("settings-editor-line-decorations-width-value"),
                                  h.Class("form-range-value"),
                                  h.Title(tr.common.restoreDefault),
                                  h.OnClick(
                                    Message.UpdatedSettingsEditorLineDecorationsWidth({
                                      value: defaultMonacoSettings.lineDecorationsWidth,
                                    }),
                                  ),
                                ],
                                [`${model.editorLineDecorationsWidth} px`],
                              ),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.For("settings-editor-line-numbers-min-chars")],
                            [tr.settings.editorLineNumbersMinCharsShort],
                          ),
                          h.div(
                            [h.Class("form-range-row")],
                            [
                              h.input([
                                h.Type("range"),
                                h.Id("settings-editor-line-numbers-min-chars"),
                                h.Min("0"),
                                h.Max("10"),
                                h.Step("1"),
                                h.Value(String(model.editorLineNumbersMinChars)),
                                h.OnInput((value) =>
                                  Message.UpdatedSettingsEditorLineNumbersMinChars({
                                    value: parseRangeNumber(
                                      value,
                                      model.editorLineNumbersMinChars,
                                      0,
                                      10,
                                    ),
                                  }),
                                ),
                              ]),
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("settings-editor-line-numbers-min-chars-value"),
                                  h.Class("form-range-value"),
                                  h.Title(tr.common.restoreDefault),
                                  h.OnClick(
                                    Message.UpdatedSettingsEditorLineNumbersMinChars({
                                      value: defaultMonacoSettings.lineNumbersMinChars,
                                    }),
                                  ),
                                ],
                                [tr.common.characters(model.editorLineNumbersMinChars)],
                              ),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("settings-app-theme")], [tr.settings.appTheme]),
                          h.select(
                            [
                              h.Id("settings-app-theme"),
                              h.Class("form-input"),
                              h.Value(model.appTheme),
                              h.OnChange((value) =>
                                Message.SelectedSettingsAppTheme({
                                  theme: Schema.is(AppThemeSchema)(value)
                                    ? (value as AppTheme)
                                    : "system",
                                }),
                              ),
                            ],
                            [
                              h.option(
                                [h.Value("system")],
                                [t(model.language).settings.appThemeSystem],
                              ),
                              h.option(
                                [h.Value("light")],
                                [t(model.language).settings.appThemeLight],
                              ),
                              h.option(
                                [h.Value("dark")],
                                [t(model.language).settings.appThemeDark],
                              ),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.For("settings-editor-theme")],
                            [t(model.language).settings.editorTheme],
                          ),
                          h.select(
                            [
                              h.Id("settings-editor-theme"),
                              h.Class("form-input"),
                              h.Value(model.editorTheme),
                              h.OnChange((value) =>
                                Message.SelectedSettingsEditorTheme({
                                  theme: Schema.is(MonacoThemeSchema)(value)
                                    ? (value as MonacoTheme)
                                    : "system",
                                }),
                              ),
                            ],
                            [
                              h.option(
                                [h.Value("system")],
                                [t(model.language).settings.editorThemeSystem],
                              ),
                              h.option(
                                [h.Value("vs")],
                                [t(model.language).settings.editorThemeLight],
                              ),
                              h.option(
                                [h.Value("vs-dark")],
                                [t(model.language).settings.editorThemeDark],
                              ),
                              h.option(
                                [h.Value("hc-black")],
                                [t(model.language).settings.editorThemeHcDark],
                              ),
                              h.option(
                                [h.Value("hc-light")],
                                [t(model.language).settings.editorThemeHcLight],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                  h.section(
                    [h.Class("settings-group"), h.Id("settings-group-llm")],
                    [
                      h.h4([h.Class("settings-group-title")], [tr.settings.llmTitle]),
                      h.div(
                        [h.Class("form-row")],
                        [
                          h.div(
                            [h.Class("form-group")],
                            [
                              h.label([h.For("llm-chat-ai-name")], [tr.settings.llmAiName]),
                              h.input([
                                h.Type("text"),
                                h.Id("llm-chat-ai-name"),
                                h.Class("form-input"),
                                h.Value(model.llmChatAiName),
                                h.Placeholder(DEFAULT_LLM_CHAT_AI_NAME),
                                h.OnInput((value) => Message.UpdatedLlmChatAiName({ value })),
                              ]),
                            ],
                          ),
                          h.div(
                            [h.Class("form-group")],
                            [
                              h.label([h.For("llm-chat-user-name")], [tr.settings.llmUserName]),
                              h.input([
                                h.Type("text"),
                                h.Id("llm-chat-user-name"),
                                h.Class("form-input"),
                                h.Value(model.llmChatUserName),
                                h.Placeholder(DEFAULT_LLM_CHAT_USER_NAME),
                                h.OnInput((value) => Message.UpdatedLlmChatUserName({ value })),
                              ]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-edit-format")], [tr.settings.llmEditFormatDefault]),
                          h.select(
                            [
                              h.Id("llm-edit-format"),
                              h.Class("form-input"),
                              h.Value(model.llmDraftEditFormat),
                              h.OnChange((value) => Message.UpdatedLlmEditFormat({ value })),
                            ],
                            EDIT_FORMAT_OPTIONS.map((item) =>
                              h.option(
                                [
                                  h.Value(item.value),
                                  h.Selected(model.llmDraftEditFormat === item.value),
                                ],
                                [item.label],
                              ),
                            ),
                          ),
                          model.hasLanguageModel
                            ? h.p(
                                [h.Id("llm-native-detected-hint"), h.Class("form-hint")],
                                [tr.settings.llmNativeDetectedHint],
                              )
                            : h.empty,
                        ],
                      ),
                      model.llmProviders.length > 0
                        ? h.div(
                            [h.Class("llm-provider-list")],
                            model.llmProviders.map((provider) => {
                              const displayName = getProviderDisplayName(provider)
                              return h.keyed("div")(
                                provider.id,
                                [h.Class("llm-provider-item")],
                                [
                                  h.label(
                                    [h.Class("llm-provider-toggle")],
                                    [
                                      h.input([
                                        h.Type("checkbox"),
                                        h.Checked(provider.enabled),
                                        h.AriaLabel(tr.settings.llmEnableProvider(displayName)),
                                        h.OnChange(() =>
                                          Message.ToggledLlmProviderEnabled({
                                            id: provider.id,
                                            isChecked: !provider.enabled,
                                          }),
                                        ),
                                      ]),
                                    ],
                                  ),
                                  h.div(
                                    [h.Class("llm-provider-info")],
                                    [
                                      h.span([h.Class("llm-provider-name")], [displayName]),
                                      provider.baseUrl.trim() !== ""
                                        ? h.span(
                                            [h.Class("llm-provider-url")],
                                            [provider.baseUrl.trim()],
                                          )
                                        : h.empty,
                                    ],
                                  ),
                                  h.div(
                                    [h.Class("llm-provider-actions")],
                                    [
                                      h.button(
                                        [
                                          h.Type("button"),
                                          h.Class("btn btn-secondary btn-sm"),
                                          h.OnClick(
                                            Message.ClickedEditLlmProvider({
                                              id: provider.id,
                                            }),
                                          ),
                                        ],
                                        [viewIcon("edit", h), ` ${tr.common.edit}`],
                                      ),
                                    ],
                                  ),
                                ],
                              )
                            }),
                          )
                        : h.div(
                            [h.Class("llm-settings-summary")],
                            [
                              h.p(
                                [h.Id("llm-summary-url"), h.Class("llm-summary-item")],
                                [tr.settings.llmNoProviders],
                              ),
                            ],
                          ),
                      h.div(
                        [h.Class("settings-group-actions")],
                        [
                          h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-add-llm-provider"),
                              h.Class("btn btn-secondary"),
                              h.OnClick(Message.ClickedAddLlmProvider()),
                            ],
                            [tr.settings.llmAddProvider],
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      model.isEditingLlmSettings
        ? h.div(
            [
              h.Id("llm-provider-modal"),
              h.Class("modal-overlay"),
              h.Role("dialog"),
              h.AriaModal(true),
              h.AriaLabelledBy("llm-provider-modal-title"),
            ],
            [
              h.div(
                [h.Class("modal-content settings-dialog")],
                [
                  h.header(
                    [h.Class("modal-header")],
                    [
                      h.h3(
                        [h.Id("llm-provider-modal-title"), h.Class("modal-title")],
                        [
                          Option.isSome(model.editingLlmProviderId)
                            ? "Provider bearbeiten"
                            : "Provider hinzufügen",
                        ],
                      ),
                      h.button(
                        [
                          h.Type("button"),
                          h.Id("btn-close-llm-provider-modal"),
                          h.Class("modal-close-btn"),
                          h.AriaLabel("Schließen"),
                          h.OnClick(Message.ClickedCancelLlmProviderEdit()),
                        ],
                        [viewIcon("close", h)],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("modal-body settings-groups")],
                    [
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.Class("form-check")],
                            [
                              h.input([
                                h.Type("checkbox"),
                                h.Id("llm-provider-enabled"),
                                h.Checked(model.llmDraftProviderEnabled),
                                h.OnChange(() =>
                                  Message.ToggledLlmDraftProviderEnabled({
                                    isChecked: !model.llmDraftProviderEnabled,
                                  }),
                                ),
                              ]),
                              h.span([], ["Aktiviert"]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.For("llm-provider-edit-format")],
                            ["Bearbeitungsformat (optional überschreiben)"],
                          ),
                          h.select(
                            [
                              h.Id("llm-provider-edit-format"),
                              h.Class("form-input"),
                              h.Value(model.llmDraftProviderEditFormat),
                              h.OnChange((value) =>
                                Message.UpdatedLlmDraftProviderEditFormat({ value }),
                              ),
                            ],
                            [
                              h.option(
                                [h.Value(""), h.Selected(model.llmDraftProviderEditFormat === "")],
                                ["Standard (global)"],
                              ),
                              ...EDIT_FORMAT_OPTIONS.map((item) =>
                                h.option(
                                  [
                                    h.Value(item.value),
                                    h.Selected(model.llmDraftProviderEditFormat === item.value),
                                  ],
                                  [item.label],
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-provider-name")], ["Provider-Name"]),
                          h.input([
                            h.Id("llm-provider-name"),
                            h.Class("form-input"),
                            h.Type("text"),
                            h.Placeholder("z. B. OpenAI, Ollama, OpenRouter"),
                            h.Autocomplete("off"),
                            h.Value(model.llmDraftName),
                            h.OnInput((value) => Message.UpdatedLlmProviderName({ value })),
                          ]),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-base-url")], ["Base-URL (OpenAI-kompatibel)"]),
                          h.input([
                            h.Id("llm-base-url"),
                            h.Class("form-input"),
                            h.Type("url"),
                            h.Placeholder("https://api.openai.com/v1"),
                            h.Autocomplete("off"),
                            h.Value(model.llmDraftBaseUrl),
                            h.OnInput((value) => Message.UpdatedLlmBaseUrl({ value })),
                          ]),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-api-key")], ["API-Key"]),
                          h.input([
                            h.Id("llm-api-key"),
                            h.Class("form-input"),
                            h.Type("password"),
                            h.Placeholder("sk-..."),
                            h.Autocomplete("off"),
                            h.Value(model.llmDraftApiKey),
                            h.OnInput((value) => Message.UpdatedLlmApiKey({ value })),
                          ]),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-models")], ["Modellliste (optional, kommagetrennt)"]),
                          h.input([
                            h.Id("llm-models"),
                            h.Class("form-input"),
                            h.Type("text"),
                            h.Placeholder("z. B. gpt-4o, Schnell=gpt-4o-mini"),
                            h.Autocomplete("off"),
                            h.Value(model.llmDraftModels),
                            h.OnInput((value) => Message.UpdatedLlmModels({ value })),
                          ]),
                          h.p(
                            [h.Class("form-hint")],
                            [
                              "Wird genutzt, wenn die automatische Erkennung nicht funktioniert, um die Modellliste selbst festzulegen (optional Name=Modell-ID).",
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-model-filter")], ["Modellfilter (RegExp, optional)"]),
                          h.input([
                            h.Id("llm-model-filter"),
                            h.Class("form-input"),
                            h.Type("text"),
                            h.Placeholder("z. B. ^(gpt-4|claude)"),
                            h.Autocomplete("off"),
                            h.Spellcheck(false),
                            h.Value(model.llmDraftModelFilter),
                            h.OnInput((value) => Message.UpdatedLlmModelFilter({ value })),
                          ]),
                          h.p(
                            [h.Class("form-hint")],
                            [
                              model.llmDraftModelFilter.trim() !== "" &&
                              compileModelFilter(model.llmDraftModelFilter) === null
                                ? "Ungültiger regulärer Ausdruck – Filter ist aktuell inaktiv."
                                : "Filtert sowohl abgerufene als auch angezeigte Modelle per RegExp (Groß-/Kleinschreibung ignoriert).",
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-row")],
                        [
                          h.div(
                            [h.Class("form-group")],
                            [
                              h.label(
                                [h.Class("form-check")],
                                [
                                  h.input([
                                    h.Type("checkbox"),
                                    h.Id("llm-streaming"),
                                    h.Checked(model.llmDraftStreaming),
                                    h.OnChange(() =>
                                      Message.ToggledLlmStreaming({
                                        isChecked: !model.llmDraftStreaming,
                                      }),
                                    ),
                                  ]),
                                  h.span([], ["Streaming verwenden"]),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("form-group")],
                            [
                              h.label(
                                [h.Class("form-check")],
                                [
                                  h.input([
                                    h.Type("checkbox"),
                                    h.Id("llm-tool-calls"),
                                    h.Checked(model.llmDraftToolCalls),
                                    h.OnChange(() =>
                                      Message.ToggledLlmToolCalls({
                                        isChecked: !model.llmDraftToolCalls,
                                      }),
                                    ),
                                  ]),
                                  h.span([], ["Tool-Calls verwenden"]),
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-thinking-preset")], ["Thinking-Preset"]),
                          (() => {
                            const matchedPresetId =
                              THINKING_PRESETS.find(
                                (preset) =>
                                  preset.param === model.llmDraftThinkingParam.trim() &&
                                  preset.levels === model.llmDraftThinkingLevels.trim(),
                              )?.id ?? "custom"
                            return h.select(
                              [
                                h.Id("llm-thinking-preset"),
                                h.Class("form-input"),
                                h.Value(matchedPresetId),
                                h.OnChange((presetId) =>
                                  Message.SelectedLlmThinkingPreset({ presetId }),
                                ),
                              ],
                              [
                                ...THINKING_PRESETS.map((preset) =>
                                  h.option(
                                    [h.Value(preset.id), h.Selected(matchedPresetId === preset.id)],
                                    [preset.label],
                                  ),
                                ),
                                h.option(
                                  [h.Value("custom"), h.Selected(matchedPresetId === "custom")],
                                  ["Benutzerdefiniert"],
                                ),
                              ],
                            )
                          })(),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("llm-thinking-param")], ["Thinking-Parameter"]),
                          h.input([
                            h.Id("llm-thinking-param"),
                            h.Class("form-input"),
                            h.Type("text"),
                            h.Placeholder(
                              "z. B. reasoning_effort oder chat_template_kwargs.enable_thinking",
                            ),
                            h.Autocomplete("off"),
                            h.Value(model.llmDraftThinkingParam),
                            h.OnInput((value) => Message.UpdatedLlmThinkingParam({ value })),
                          ]),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.For("llm-thinking-levels")],
                            ["Verfügbare Thinking-Level (kommagetrennt)"],
                          ),
                          h.input([
                            h.Id("llm-thinking-levels"),
                            h.Class("form-input"),
                            h.Type("text"),
                            h.Placeholder(
                              "z. B. Aus=none, Niedrig=low, Hoch=high oder Aus=false, An=true",
                            ),
                            h.Autocomplete("off"),
                            h.Value(model.llmDraftThinkingLevels),
                            h.OnInput((value) => Message.UpdatedLlmThinkingLevels({ value })),
                          ]),
                        ],
                      ),
                      h.div(
                        [h.Class("form-group")],
                        [
                          h.label(
                            [h.For("llm-extra-args")],
                            ["Zusätzliche Parameter (JSON, optional)"],
                          ),
                          h.textarea([
                            h.Id("llm-extra-args"),
                            h.Class("form-input form-textarea-mono"),
                            h.Rows(2),
                            h.Placeholder('z. B. {"temperature": 0.2, "max_tokens": 64}'),
                            h.Spellcheck(false),
                            h.Value(model.llmDraftExtraArgs),
                            h.OnInput((value) => Message.UpdatedLlmExtraArgs({ value })),
                          ]),
                          h.p(
                            [h.Class("form-hint")],
                            ["Werden als JSON-Objekt an /chat/completions übergeben."],
                          ),
                        ],
                      ),
                      (() => {
                        const modelOptions = resolveModelOptions(
                          model.llmDraftModels,
                          model.llmDiscoveredModels,
                          model.llmDraftModel,
                          model.hasLanguageModel,
                          model.llmDraftModelFilter,
                        )
                        const availableLevels = parseThinkingLevels(model.llmDraftThinkingLevels)
                        const selectedModel =
                          model.llmDraftModel.trim() !== ""
                            ? model.llmDraftModel.trim()
                            : (modelOptions[0]?.value ?? "")
                        const hasThinking =
                          model.llmDraftThinkingParam.trim() !== "" &&
                          availableLevels.length > 0 &&
                          !isLanguageModelSelection(selectedModel)

                        return h.div(
                          [h.Class("form-row")],
                          [
                            h.div(
                              [h.Class("form-group")],
                              [
                                h.label([h.For("llm-active-model")], ["Modell"]),
                                h.select(
                                  [
                                    h.Id("llm-active-model"),
                                    h.Class("form-input"),
                                    h.Disabled(modelOptions.length === 0),
                                    h.Value(selectedModel),
                                    h.OnChange((value) => Message.SelectedLlmModel({ value })),
                                  ],
                                  modelOptions.length > 0
                                    ? modelOptions.map((item) =>
                                        h.option(
                                          [
                                            h.Value(item.value),
                                            h.Selected(selectedModel === item.value),
                                          ],
                                          [item.label],
                                        ),
                                      )
                                    : [
                                        h.option(
                                          [h.Value(""), h.Selected(true)],
                                          ["Noch keine Modelle"],
                                        ),
                                      ],
                                ),
                              ],
                            ),
                            h.div(
                              [h.Class("form-group")],
                              [
                                h.label([h.For("llm-thinking-level")], ["Thinking-Level"]),
                                h.select(
                                  [
                                    h.Id("llm-thinking-level"),
                                    h.Class("form-input"),
                                    h.Disabled(!hasThinking),
                                    h.Value(hasThinking ? model.llmDraftThinkingLevel : ""),
                                    h.OnChange((value) =>
                                      Message.UpdatedLlmThinkingLevel({ value }),
                                    ),
                                  ],
                                  hasThinking
                                    ? [
                                        h.option(
                                          [
                                            h.Value(""),
                                            h.Selected(model.llmDraftThinkingLevel === ""),
                                          ],
                                          ["Standard (nicht gesetzt)"],
                                        ),
                                        ...availableLevels.map((item) =>
                                          h.option(
                                            [
                                              h.Value(item.value),
                                              h.Selected(
                                                model.llmDraftThinkingLevel === item.value,
                                              ),
                                            ],
                                            [item.label],
                                          ),
                                        ),
                                      ]
                                    : [h.option([h.Value(""), h.Selected(true)], ["Standard"])],
                                ),
                              ],
                            ),
                          ],
                        )
                      })(),
                      h.div(
                        [h.Class("settings-group-actions llm-test-actions")],
                        [
                          ...(["models", "chat", "tools"] as const).map((mode) => {
                            const isRunning = LlmTestState.match(model.llmTestState, {
                              Idle: () => false,
                              Testing: () => true,
                              Streaming: () => true,
                              Succeeded: () => false,
                              Failed: () => false,
                            })
                            const label =
                              mode === "models"
                                ? "Liste testen"
                                : mode === "chat"
                                  ? "Chat testen"
                                  : "Tools testen"
                            const isNativeSelected = isLanguageModelSelection(model.llmDraftModel)
                            const isDisabled =
                              isRunning ||
                              (mode === "chat"
                                ? model.llmDraftBaseUrl.trim() === "" && !isNativeSelected
                                : model.llmDraftBaseUrl.trim() === "" || isNativeSelected)
                            return h.button(
                              [
                                h.Type("button"),
                                h.Id(`btn-test-llm-${mode}`),
                                h.Class("btn btn-secondary"),
                                h.Disabled(isDisabled),
                                h.OnClick(Message.ClickedTestLlm({ mode })),
                              ],
                              [label],
                            )
                          }),
                          LlmTestState.match(model.llmTestState, {
                            Idle: () => h.empty,
                            Testing: () => h.empty,
                            Streaming: () => h.empty,
                            Succeeded: () =>
                              h.span(
                                [
                                  h.Id("llm-test-status"),
                                  h.Class("llm-test-status is-ok"),
                                  h.AriaLabel("OK"),
                                ],
                                [viewIcon("check", h)],
                              ),
                            Failed: () =>
                              h.span(
                                [
                                  h.Id("llm-test-status"),
                                  h.Class("llm-test-status is-error"),
                                  h.AriaLabel("Nicht OK"),
                                ],
                                [viewIcon("cross", h)],
                              ),
                          }),
                        ],
                      ),
                      LlmTestState.match(model.llmTestState, {
                        Idle: () => h.empty,
                        Testing: () => h.empty,
                        Streaming: ({ content, reasoning }) =>
                          h.div(
                            [h.Id("llm-test-result")],
                            [LlmResponse.view({ content, reasoning, isStreaming: true }, h)],
                          ),
                        Succeeded: ({ content, reasoning, models }) => {
                          if (content.trim() === "" && reasoning.trim() === "") {
                            return h.p(
                              [h.Id("llm-test-result"), h.Class("form-hint")],
                              [models.length > 0 ? models.join(", ") : "Keine Modelle gefunden."],
                            )
                          }
                          return h.div(
                            [h.Id("llm-test-result")],
                            [LlmResponse.view({ content, reasoning, isStreaming: false }, h)],
                          )
                        },
                        Failed: ({ message }) =>
                          h.p([h.Id("llm-test-result"), h.Class("form-hint is-danger")], [message]),
                      }),
                    ],
                  ),
                  h.footer(
                    [h.Class("modal-footer")],
                    [
                      h.div(
                        [h.Class("modal-footer-left")],
                        Option.match(model.editingLlmProviderId, {
                          onNone: () => [],
                          onSome: (id) => [
                            h.button(
                              [
                                h.Type("button"),
                                h.Id("btn-delete-llm-provider"),
                                h.Class("btn btn-danger"),
                                h.OnClick(Message.ClickedDeleteLlmProvider({ id })),
                              ],
                              [viewIcon("trash", h), " Löschen"],
                            ),
                          ],
                        }),
                      ),
                      h.div(
                        [h.Class("modal-footer-right")],
                        [
                          h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-cancel-settings"),
                              h.Class("btn btn-secondary"),
                              h.OnClick(Message.ClickedCancelLlmProviderEdit()),
                            ],
                            ["Abbrechen"],
                          ),
                          h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-save-settings"),
                              h.Class("btn btn-primary"),
                              h.OnClick(Message.ClickedSaveSettingsDialog()),
                            ],
                            ["Speichern"],
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          )
        : h.empty,
      model.isConfirmingDeleteLlmProvider
        ? (() => {
            const editingId = Option.getOrElse(model.editingLlmProviderId, () => "")
            const provider = model.llmProviders.find((p) => p.id === editingId)
            const providerLabel =
              provider !== undefined ? getProviderDisplayName(provider) : "Provider"
            return Editor.viewConfirmDeleteDialog(
              {
                overlayId: "delete-llm-provider-confirm",
                titleId: "delete-llm-provider-confirm-title",
                title: tr.settings.llmDeleteProviderTitle,
                prompt: tr.settings.llmDeleteProviderPrompt(providerLabel),
                cancelButtonId: "btn-delete-llm-provider-cancel",
                onCancel: Message.ClickedCancelDeleteLlmProvider(),
                confirmButtonId: "btn-delete-llm-provider-confirm",
                confirmLabel: tr.common.delete,
                onConfirm: Message.ClickedConfirmDeleteLlmProvider(),
              },
              h,
            )
          })()
        : h.empty,
      model.clearAllHistoryState._tag === "Confirming"
        ? Editor.viewConfirmDeleteDialog(
            {
              overlayId: "clear-all-history-confirm",
              titleId: "clear-all-history-confirm-title",
              title: tr.settings.clearAllHistory,
              prompt: tr.settings.clearAllHistoryPrompt,
              cancelButtonId: "btn-clear-all-history-cancel",
              onCancel: Message.ClickedCancelClearAllHistory(),
              confirmButtonId: "btn-clear-all-history-confirm",
              confirmLabel: tr.settings.deletePermanently,
              onConfirm: Message.ClickedConfirmClearAllHistory(),
            },
            h,
          )
        : h.empty,
    ],
  )
}

const viewToolbar = (model: Model, h: HtmlBuilder): Html.Html => {
  const tr = t(model.language).toolbar
  const isReady = StorageState.match(model.storageState, {
    Initializing: () => false,
    Unsupported: () => false,
    NoFolderSelected: () => false,
    PermissionRequired: () => false,
    Ready: () => true,
  })

  return h.div(
    [h.Class("files-toolbar")],
    [
      h.div(
        [h.Class("folder-icon"), h.AriaHidden(true)],
        [h.img([h.Class("breadcrumb-root-icon"), h.Src(rootIconUrl), h.Alt("")])],
      ),
      h.div(
        [h.Id("folder-actions"), h.Class("folder-actions")],
        [
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-new-file"),
                  h.Class("btn btn-primary"),
                  h.Title(tr.newFileTitle),
                  h.AriaLabel(tr.newFileTitle),
                  h.OnClick(Message.ClickedNewFile()),
                ],
                [
                  h.span(
                    [h.Class("btn-icon-only"), h.AriaHidden(true)],
                    [
                      h.span([h.Class("btn-icon-sub")], [viewIcon("file", h)]),
                      h.span([h.Class("btn-icon-main")], [viewIcon("plus", h)]),
                    ],
                  ),
                  h.span([h.Class("btn-label")], [tr.newFileLabel]),
                ],
              )
            : h.empty,
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-new-folder"),
                  h.Class("btn btn-primary"),
                  h.Title(tr.newFolderTitle),
                  h.AriaLabel(tr.newFolderTitle),
                  h.OnClick(Message.ClickedNewFolder()),
                ],
                [
                  h.span(
                    [h.Class("btn-icon-only"), h.AriaHidden(true)],
                    [
                      h.span([h.Class("btn-icon-sub")], [viewIcon("folder", h)]),
                      h.span([h.Class("btn-icon-main")], [viewIcon("plus", h)]),
                    ],
                  ),
                  h.span([h.Class("btn-label")], [tr.newFolderLabel]),
                ],
              )
            : h.empty,
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-import-file"),
                  h.Class("btn btn-secondary"),
                  h.Title(tr.uploadTitle),
                  h.AriaLabel(tr.uploadTitle),
                  h.OnClick(Message.ClickedImportFiles()),
                ],
                [
                  h.span([h.Class("btn-icon-only"), h.AriaHidden(true)], [viewIcon("upload", h)]),
                  h.span([h.Class("btn-label")], [tr.uploadLabel]),
                ],
              )
            : h.empty,
          viewSettingsMenu(model, h),
        ],
      ),
      h.div([h.Id("folder-status"), h.Class("folder-status-box")], [viewBreadcrumbs(model, h)]),
    ],
  )
}

// VIEW CONTENT

const viewEntryRow = (
  entry: FileEntry,
  showFileInfo: boolean,
  language: Language,
  h: HtmlBuilder,
): Html.Html => {
  const tr = t(language).files
  const isDir = entry.kind === "directory"
  const icon = fileIconFor(entry.name, isDir)
  const sizeDisplay = isDir
    ? "—"
    : Option.match(entry.maybeSize, {
        onNone: () => "—",
        onSome: formatSize,
      })
  const dateDisplay = isDir
    ? "—"
    : Option.match(entry.maybeLastModified, {
        onNone: () => "—",
        onSome: formatDate,
      })

  const isDeleted = entry.isDeleted === true
  const hasHistory = entry.hasHistory === true || isDeleted

  return h.keyed("tr")(
    entry.id,
    [
      h.Class(`file-row ${isDir ? "is-directory" : "is-file"}${isDeleted ? " is-deleted" : ""}`),
      h.DataAttribute("entry", entry.name),
      h.DataAttribute("kind", entry.kind),
      h.Title(isDir ? tr.openFolder : isDeleted ? tr.deletedShowVersions : tr.openFile),
      h.OnClick(Message.ClickedEntryRow({ entry })),
    ],
    [
      h.td(
        [h.Class("file-name-cell")],
        [
          h.span(
            [h.Class("file-name-inner")],
            [
              h.span([h.Class("file-icon"), h.AriaHidden(true)], [viewIcon(icon, h)]),
              h.span([h.Class("file-name"), h.Title(entry.name)], [entry.name]),
            ],
          ),
        ],
      ),
      showFileInfo
        ? h.td([h.Class("file-size-cell"), h.DataAttribute("label", tr.size)], [sizeDisplay])
        : h.empty,
      showFileInfo
        ? h.td(
            [
              h.Class("file-date-cell"),
              h.DataAttribute("label", tr.lastModified),
              h.DataAttribute("label-short", tr.modifiedShort),
            ],
            [dateDisplay],
          )
        : h.empty,
      h.td(
        [h.Class("files-actions-cell")],
        [
          h.div(
            [h.Class("files-actions-inner")],
            [
              !isDir && hasHistory
                ? h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-secondary btn-sm btn-entry-history"),
                      h.DataAttribute("entry", entry.name),
                      h.Title(tr.versionHistory),
                      h.AriaLabel(tr.versionHistoryFor(entry.name)),
                      h.OnClick(Message.ClickedEntryHistory({ entry }), {
                        propagation: "Stop",
                      }),
                    ],
                    [viewIcon("history", h), h.span([h.Class("btn-label")], [tr.versions])],
                  )
                : h.empty,
              h.button(
                [
                  h.Type("button"),
                  h.Class(
                    `btn btn-secondary btn-sm btn-edit-entry${isDeleted ? " is-deleted" : ""}`,
                  ),
                  h.DataAttribute("entry", entry.name),
                  h.Disabled(isDeleted),
                  h.Title(isDeleted ? tr.fileDeleted : isDir ? tr.editFolder : tr.editFile),
                  h.AriaLabel(isDeleted ? tr.fileDeleted : isDir ? tr.editFolder : tr.editFile),
                  h.OnClick(Message.ClickedEditEntry({ entry }), {
                    propagation: "Stop",
                  }),
                ],
                [
                  viewIcon("edit", h),
                  h.span([h.Class("btn-label")], [isDeleted ? tr.deleted : tr.edit]),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewFilesTable = (
  entries: ReadonlyArray<FileEntry>,
  showFileInfo: boolean,
  language: Language,
  h: HtmlBuilder,
): Html.Html => {
  return Array.match(entries, {
    onEmpty: () =>
      h.div(
        [h.Class("empty-state")],
        [
          h.div([h.Class("empty-icon"), h.AriaHidden(true)], [viewIcon("folder", h)]),
          h.h3([], [t(language).files.folderIsEmpty]),
        ],
      ),
    onNonEmpty: (entries) => viewFilesTableContent(entries, showFileInfo, language, h),
  })
}

const viewFilesTableContent = (
  entries: ReadonlyArray<FileEntry>,
  showFileInfo: boolean,
  language: Language,
  h: HtmlBuilder,
): Html.Html => {
  const tr = t(language).files
  return h.div(
    [],
    [
      h.div([h.Class("files-summary")], [h.span([], [formatSummaryText(entries, language)])]),
      h.div(
        [h.Class("table-responsive")],
        [
          h.table(
            [h.Class("files-table")],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Scope("col"), h.Class("th-name")], [tr.name]),
                      showFileInfo
                        ? h.th([h.Scope("col"), h.Class("th-size")], [tr.size])
                        : h.empty,
                      showFileInfo
                        ? h.th([h.Scope("col"), h.Class("th-date")], [tr.lastModified])
                        : h.empty,
                      h.th(
                        [h.Scope("col"), h.Class("th-actions")],
                        [h.span([h.Class("visually-hidden")], [tr.action])],
                      ),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                pipe(
                  entries,
                  Array.map((entry) => viewEntryRow(entry, showFileInfo, language, h)),
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewContentSection = (model: Model, h: HtmlBuilder): Html.Html => {
  const tr = t(model.language)
  return h.div(
    [h.Id("files-content"), h.Class("files-content")],
    [
      StorageState.match(model.storageState, {
        Initializing: () =>
          h.div(
            [h.Class("loading-state")],
            [h.div([h.Class("spinner"), h.AriaHidden(true)]), h.p([], [tr.files.loadingFiles])],
          ),

        Unsupported: () => h.div([h.Class("empty-state")], [h.p([], [tr.files.unsupportedEnv])]),

        NoFolderSelected: () =>
          h.div(
            [h.Class("empty-state")],
            [
              h.div([h.Class("empty-icon"), h.AriaHidden(true)], [viewIcon("folder-open", h)]),
              h.h3([], [tr.files.noFolderSelectedTitle]),
              h.p([], [tr.files.noFolderSelectedDesc]),
              h.div(
                [h.Class("empty-actions")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-select-folder-hero"),
                      h.Class("btn btn-primary"),
                      h.OnClick(Message.ClickedSelectFolder()),
                    ],
                    [viewIcon("folder-open", h), ` ${tr.settings.selectFolder}`],
                  ),
                ],
              ),
            ],
          ),

        PermissionRequired: ({ folderName }) =>
          h.div(
            [h.Class("empty-state")],
            [
              h.div([h.Class("empty-icon"), h.AriaHidden(true)], [viewIcon("lock", h)]),
              h.h3([], [tr.files.permissionRequiredTitle]),
              h.p([], [tr.files.permissionRequiredPrefix, h.strong([], [folderName]), "."]),
              h.button(
                [
                  h.Type("button"),
                  h.Id("btn-grant-permission-hero"),
                  h.Class("btn btn-primary"),
                  h.OnClick(Message.ClickedGrantPermission()),
                ],
                [tr.files.grantAccessTo(folderName)],
              ),
            ],
          ),

        Ready: ({ entriesState }) =>
          EntriesState.match(entriesState, {
            Loading: () =>
              h.div(
                [h.Class("loading-state")],
                [h.div([h.Class("spinner"), h.AriaHidden(true)]), h.p([], [tr.files.loadingFiles])],
              ),
            Loaded: ({ entries }) => viewFilesTable(entries, model.showFileInfo, model.language, h),
            Error: ({ message }) =>
              h.div(
                [h.Class("empty-state")],
                [
                  h.div([h.Class("empty-icon"), h.AriaHidden(true)], [viewIcon("warning", h)]),
                  h.h3([], [tr.files.readErrorTitle]),
                  h.p([], [message]),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-retry-list"),
                      h.Class("btn btn-primary"),
                      h.OnClick(Message.ClickedRetryList()),
                    ],
                    [tr.files.retry],
                  ),
                ],
              ),
          }),
      }),
    ],
  )
}

// VIEW MODALS

const viewModalContainer = (model: Model, h: HtmlBuilder): Html.Html => {
  const llmSelectedModel = resolveEffectiveLlmModel(model)
  const llmModelOptions = resolveModelOptionsForModel(model, model.llmModel)
  const selectedProvider =
    model.llmProviders.length > 0
      ? resolveProviderForModelSelection(model.llmProviders, llmSelectedModel)
      : undefined
  const activeThinkingParam = selectedProvider?.thinkingParam ?? model.llmThinkingParam
  const activeThinkingLevels = selectedProvider?.thinkingLevels ?? model.llmThinkingLevels
  const llmThinkingLevels =
    model.llmEnabled && activeThinkingParam.trim() !== ""
      ? parseThinkingLevels(activeThinkingLevels)
      : []

  return h.submodel({
    slotId: "modal",
    model: model.modalState,
    viewInputs: {
      origin: model.origin,
      hasDirectoryPicker: model.hasDirectoryPicker,
      hasOPFS: model.hasOPFS,
      hasTauri: model.hasTauri,
      language: model.language,
      llm: {
        llmEnabled: isChatAvailable(model),
        llmModelOptions,
        llmSelectedModel,
        llmThinkingLevels,
        llmSelectedThinkingLevel: model.llmThinkingLevel,
        llmEditFormat: model.llmEditFormat,
        llmToolCalls:
          (selectedProvider?.toolCalls ?? model.llmToolCalls) &&
          !isLanguageModelSelection(stripProviderPrefixFromModelSelection(llmSelectedModel)),
        llmChatAiName: model.llmChatAiName,
        llmChatUserName: model.llmChatUserName,
        monacoSettings: {
          lineNumbers: model.editorLineNumbers,
          folding: model.editorFolding,
          wordWrap: model.editorWordWrap,
          scrollBeyondLastLine: model.editorScrollBeyondLastLine,
          theme: model.editorTheme,
          lineDecorationsWidth: model.editorLineDecorationsWidth,
          lineNumbersMinChars: model.editorLineNumbersMinChars,
          undoInTitlebar: model.editorUndoInTitlebar,
        },
        appTheme: model.appTheme,
        language: model.language,
      },
    },
    view: Modal.view,
    toParentMessage: (msg) => Message.GotModalMessage({ message: msg }),
  })
}

// VIEW DOCUMENT

const ISLAND_IFRAME_SANDBOX =
  "allow-scripts allow-forms allow-same-origin allow-modals allow-downloads"

/**
 * Tauri-Titelleisten-Buttons für Windows (`.win-btn`).
 * Verwendet bewusst Windows-System-Glyphen aus „Segoe Fluent Icons“ / „Segoe MDL2 Assets“
 * (\uE73F, \uE740, \uE921, \uE922, \uE923, \uE8BB) – NICHT durch Noto-Emoji (`viewIcon`) ersetzen.
 */
const viewWindowControls = (
  isMaximized: boolean,
  isFullscreen: boolean,
  language: Language,
  h: HtmlBuilder,
): Html.Html => {
  const tr = t(language)
  return h.div(
    [h.Class("window-controls")],
    [
      h.button(
        [
          h.Type("button"),
          h.Id("fullscreen-btn"),
          h.Class("win-btn"),
          h.Title(isFullscreen ? tr.files.fullscreenExitTitle : tr.files.fullscreenEnterTitle),
          h.AriaLabel(isFullscreen ? tr.files.fullscreenExitLabel : tr.files.fullscreenEnterLabel),
          h.OnClick(Message.ClickedToggleFullscreen()),
        ],
        [isFullscreen ? "\uE73F" : "\uE740"],
      ),
      h.button(
        [
          h.Type("button"),
          h.Id("min-btn"),
          h.Class("win-btn"),
          h.Title(tr.nav.minimize),
          h.AriaLabel(tr.nav.minimize),
          h.OnClick(Message.ClickedMinimizeWindow()),
        ],
        ["\uE921"],
      ),
      h.button(
        [
          h.Type("button"),
          h.Id("max-btn"),
          h.Class("win-btn"),
          h.Title(isMaximized ? tr.nav.restore : tr.nav.maximize),
          h.AriaLabel(isMaximized ? tr.nav.restore : tr.nav.maximize),
          h.OnClick(Message.ClickedToggleMaximizeWindow()),
        ],
        [isMaximized ? "\uE923" : "\uE922"],
      ),
      h.button(
        [
          h.Type("button"),
          h.Id("close-btn"),
          h.Class("win-btn close-btn"),
          h.Title(tr.common.close),
          h.AriaLabel(tr.common.close),
          h.OnClick(Message.ClickedCloseWindow()),
        ],
        ["\uE8BB"],
      ),
    ],
  )
}

const viewWindowTopBorder = (
  title: string,
  isFocused: boolean,
  isMaximized: boolean,
  isFullscreen: boolean,
  language: Language,
  h: HtmlBuilder,
): Html.Html => {
  const tr = t(language)
  return h.header(
    [
      h.Id("window-top-border"),
      h.Class(isFocused ? "window-top-border titlebar" : "window-top-border titlebar inactive"),
      h.DataAttribute("tauri-drag-region", "true"),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.Id("btn-return-pwaislands"),
          h.Class("window-top-border-btn"),
          h.Title(tr.files.backDoubleClickTitle),
          h.AriaLabel(tr.common.back),
          h.OnClick(Message.ClickedReturnArrow()),
          h.OnDoubleClick(Message.DoubleClickedReturnArrow()),
        ],
        [
          h.span([h.Class("window-top-border-arrow"), h.AriaHidden(true)], ["←"]),
          h.span([h.Class("window-top-border-title")], [title]),
        ],
      ),
      h.div([h.Class("titlebar-drag-spacer"), h.DataAttribute("tauri-drag-region", "true")], []),
      viewWindowControls(isMaximized, isFullscreen, language, h),
    ],
  )
}

const viewManagerTitlebar = (
  title: string,
  canNavigateBack: boolean,
  isFocused: boolean,
  isMaximized: boolean,
  isFullscreen: boolean,
  language: Language,
  h: HtmlBuilder,
): Html.Html => {
  const tr = t(language)
  return h.header(
    [
      h.Id("manager-titlebar"),
      h.Class(isFocused ? "window-top-border titlebar" : "window-top-border titlebar inactive"),
      h.DataAttribute("tauri-drag-region", "true"),
    ],
    [
      canNavigateBack
        ? h.button(
            [
              h.Type("button"),
              h.Id("btn-return-pwaislands"),
              h.Class("window-top-border-btn"),
              h.Title(tr.common.back),
              h.AriaLabel(tr.common.back),
              h.OnClick(Message.ClickedReturnArrow()),
              h.OnDoubleClick(Message.DoubleClickedReturnArrow()),
            ],
            [
              h.span([h.Class("window-top-border-arrow"), h.AriaHidden(true)], ["←"]),
              h.span([h.Class("window-top-border-title")], [title]),
            ],
          )
        : h.div([h.Class("titlebar-title"), h.DataAttribute("tauri-drag-region", "true")], [title]),
      h.div([h.Class("titlebar-drag-spacer"), h.DataAttribute("tauri-drag-region", "true")], []),
      viewWindowControls(isMaximized, isFullscreen, language, h),
    ],
  )
}

const viewIslandContainer = (
  islandUrl: string,
  showTopBorder: boolean,
  title: string,
  isFocused: boolean,
  isMaximized: boolean,
  isFullscreen: boolean,
  language: Language,
  h: HtmlBuilder,
): Html.Html =>
  h.div(
    [h.Class(isFullscreen ? "island-container is-fullscreen" : "island-container")],
    [
      showTopBorder
        ? viewWindowTopBorder(title, isFocused, isMaximized, isFullscreen, language, h)
        : h.empty,
      h.iframe([
        h.Id("island-iframe"),
        h.Class(showTopBorder ? "island-iframe has-top-border" : "island-iframe"),
        h.Src(islandUrl),
        h.Sandbox(ISLAND_IFRAME_SANDBOX),
        h.Title("PWA Island"),
        h.OnLoad(Message.LoadedIslandIframe()),
      ]),
    ],
  )

const viewManagerMain = (model: Model, title: string, h: HtmlBuilder): Html.Html => {
  const showWindowsTitlebar = model.hasTauri && model.isWindows
  const currentSubPath = currentSubPathFromStorageState(model.storageState)
  const canNavigateBack = currentSubPath.length > 0
  return h.main(
    [h.Id("router-view"), h.Class("router-view")],
    [
      showWindowsTitlebar
        ? viewManagerTitlebar(
            title,
            canNavigateBack,
            model.isWindowFocused,
            model.isWindowMaximized,
            model.isWindowFullscreen,
            model.language,
            h,
          )
        : h.empty,
      h.div(
        [h.Class(showWindowsTitlebar ? "files-page has-windows-titlebar" : "files-page")],
        [
          viewToolbar(model, h),
          viewContentSection(model, h),
          viewModalContainer(model, h),
          viewSettingsDialog(model, h),
        ],
      ),
    ],
  )
}

export const view = (model: Model, h: HtmlBuilder): Html.Document => {
  const docTitle = computeDocumentTitle(model)
  return {
    title: docTitle,
    body: h.div(
      [h.Id("app"), h.Class(model.isWindowFullscreen ? "is-fullscreen" : "")],
      [
        Option.match(model.maybeActiveIslandUrl, {
          onNone: () => viewManagerMain(model, docTitle, h),
          onSome: (islandUrl) =>
            viewIslandContainer(
              islandUrl,
              model.hasTauri && model.isWindows,
              docTitle,
              model.isWindowFocused,
              model.isWindowMaximized,
              model.isWindowFullscreen,
              model.language,
              h,
            ),
        }),
        viewToasts(
          model.toasts,
          (id) => Message.ClickedDismissToast({ id }),
          (message) => Message.ClickedCopyToast({ message }),
          model.language,
          h,
        ),
      ],
    ),
  }
}
