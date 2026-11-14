import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { Array, Duration, Effect, Match, Option, Queue, Schema, Stream, pipe } from "effect"
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
import { clearAllFileHistory } from "./history"
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
  buildFolderUrl,
  buildHelpUrl,
  buildNewUrl,
  decodeUrlPathnameSegments,
  encodeSubPath,
  parseIslandPath,
  parseUrlToRoute,
} from "./route"
import {
  type EditorChatMessage,
  LANGUAGE_MODEL_OPTION_VALUE,
  THINKING_PRESETS,
  detectLanguageModelAvailability,
  emptyLlmSettings,
  isLanguageModelSelection,
  listModels,
  parseModelList,
  parseThinkingLevels,
  resolveModelOptions,
  resolveTestModel,
  runEditorChatTurn,
  streamChatParts,
  streamToolCallParts,
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
import * as Editor from "./editor"
import * as LlmResponse from "./llm-response"
import {
  DEFAULT_EDITOR_SPLIT_PERCENT,
  OPFS_APP_FOLDER,
  getFileExtension,
  getStoredEditorPreferences,
  getStoredHistoryEnabled,
  getStoredLlmSettings,
  storeEditorPreferences,
  storeHistoryEnabled,
  storeLlmSettings,
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

const formatSummaryText = (entries: ReadonlyArray<FileEntry>): string => {
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
    ...(fileCount > 0 ? [`${fileCount} ${fileCount === 1 ? "Datei" : "Dateien"}`] : []),
    ...(dirCount > 0 ? [`${dirCount} ${dirCount === 1 ? "Ordner" : "Ordner"}`] : []),
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
  llmDiscoveredModels: Schema.Array(Schema.String),
  hasLoadedEditorLlmModels: Schema.Boolean,
  editorIsMaximized: Schema.Boolean,
  editorLlmBarMode: Editor.LlmBarMode,
  editorSplitPercent: Schema.Number,
  llmDraftEnabled: Schema.Boolean,
  llmDraftEditFormat: EditFormat,
  llmDraftBaseUrl: Schema.String,
  llmDraftApiKey: Schema.String,
  llmDraftModels: Schema.String,
  llmDraftStreaming: Schema.Boolean,
  llmDraftToolCalls: Schema.Boolean,
  llmDraftThinkingParam: Schema.String,
  llmDraftThinkingLevels: Schema.String,
  llmDraftExtraArgs: Schema.String,
  llmDraftModel: Schema.String,
  llmDraftThinkingLevel: Schema.String,
  llmTestState: LlmTestState,
  historyEnabled: Schema.Boolean,
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
  ClickedOpenSettingsDialog: {},
  ClickedCloseSettingsDialog: {},
  ClickedSaveSettingsDialog: {},
  ClickedRequestClearAllHistory: {},
  ClickedCancelClearAllHistory: {},
  ClickedConfirmClearAllHistory: {},
  SucceededClearAllHistory: {},
  FailedClearAllHistory: { message: Schema.String },
  ToggledSettingsHistoryEnabled: { isEnabled: Schema.Boolean },
  CompletedSaveHistoryEnabledPreference: {},
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
  ToggledLlmEnabled: { isChecked: Schema.Boolean },
  UpdatedLlmEditFormat: { value: Schema.String },
  UpdatedLlmBaseUrl: { value: Schema.String },
  UpdatedLlmApiKey: { value: Schema.String },
  UpdatedLlmModels: { value: Schema.String },
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
    editFormat: EditFormat,
    baseUrl: Schema.String,
    apiKey: Schema.String,
    models: Schema.String,
    streaming: Schema.Boolean,
    toolCalls: Schema.Boolean,
    thinkingParam: Schema.String,
    thinkingLevels: Schema.String,
    extraArgs: Schema.String,
  },
  CompletedSaveLlmSettings: {},
  CompletedLoadEditorPreferences: {
    isMaximized: Schema.Boolean,
    llmBarMode: Editor.LlmBarMode,
    llmModel: Schema.String,
    llmThinkingLevel: Schema.String,
    editorSplitPercent: Schema.Number,
    historyEnabled: Schema.optionalKey(Schema.Boolean),
  },
  CompletedSaveEditorPreferences: {},
  SucceededLoadEditorLlmModels: {
    models: Schema.Array(Schema.String),
  },
  FailedLoadEditorLlmModels: {},
  UpdatedEditorLlmChatStream: {
    completedTurns: Schema.Array(Editor.LlmChatTurnBlock),
    activeTurn: Schema.Struct({
      content: Schema.String,
      reasoning: Schema.String,
    }),
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
    Folder: ({ subPath }) => subPath,
    New: ({ subPath }) => subPath,
    Edit: ({ subPath }) => subPath,
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

export const LoadLlmSettings = Command.define("LoadLlmSettings", {
  messages: [Message.CompletedLoadLlmSettings],
  execute: Effect.promise(() => getStoredLlmSettings()).pipe(
    Effect.map((settings) =>
      Message.CompletedLoadLlmSettings({
        enabled: settings.enabled,
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
    editFormat: EditFormat,
    baseUrl: Schema.String,
    apiKey: Schema.String,
    models: Schema.String,
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

export const LoadEditorPreferences = Command.define("LoadEditorPreferences", {
  messages: [Message.CompletedLoadEditorPreferences],
  execute: Effect.promise(() =>
    Promise.all([getStoredEditorPreferences(), getStoredHistoryEnabled()]),
  ).pipe(
    Effect.map(([prefs, historyEnabled]) =>
      Message.CompletedLoadEditorPreferences({
        isMaximized: prefs.isMaximized,
        llmBarMode: prefs.llmBarMode,
        llmModel: prefs.llmModel,
        llmThinkingLevel: prefs.llmThinkingLevel,
        editorSplitPercent: prefs.editorSplitPercent,
        historyEnabled,
      }),
    ),
  ),
})

export const SaveEditorPreferences = Command.define("SaveEditorPreferences", {
  args: {
    isMaximized: Schema.Boolean,
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
          isMaximized: args.isMaximized,
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
  },
  messages: [Message.SucceededLoadEditorLlmModels, Message.FailedLoadEditorLlmModels],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const models = await listModels(args)
        return Message.SucceededLoadEditorLlmModels({ models })
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
    Effect.tryPromise({
      try: async () => {
        await IslandIpcAction.match(args.action, {
          Write: ({ subPath, data }) =>
            invoke("tauri_fs_write_file", {
              subPath,
              data: [...data],
            }),
          MakeDir: ({ subPath }) =>
            invoke("tauri_fs_create_dir", {
              subPath,
            }),
          Rename: ({ from, to }) =>
            invoke("tauri_fs_rename", {
              fromSubPath: from,
              toSubPath: to,
            }),
          Remove: ({ subPath, recursive }) =>
            invoke("tauri_fs_remove_entry", {
              subPath,
              isDirectory: recursive,
            }),
          Copy: ({ from, to }) =>
            invoke("tauri_fs_copy", {
              fromSubPath: from,
              toSubPath: to,
            }),
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
    ),
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
        isSettingsDialogOpen: false,
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
        llmDiscoveredModels: [],
        hasLoadedEditorLlmModels: false,
        editorIsMaximized: false,
        editorLlmBarMode: "Closed",
        editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
        llmDraftEnabled: false,
        llmDraftEditFormat: DEFAULT_EDIT_FORMAT,
        llmDraftBaseUrl: "",
        llmDraftApiKey: "",
        llmDraftModels: "",
        llmDraftStreaming: true,
        llmDraftToolCalls: true,
        llmDraftThinkingParam: emptyLlmSettings.thinkingParam,
        llmDraftThinkingLevels: emptyLlmSettings.thinkingLevels,
        llmDraftExtraArgs: "",
        llmDraftModel: "",
        llmDraftThinkingLevel: "",
        llmTestState: LlmTestState.Idle(),
        historyEnabled: true,
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
      isSettingsDialogOpen: false,
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
      llmDiscoveredModels: [],
      hasLoadedEditorLlmModels: false,
      editorIsMaximized: false,
      editorLlmBarMode: "Closed",
      editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
      llmDraftEnabled: false,
      llmDraftEditFormat: DEFAULT_EDIT_FORMAT,
      llmDraftBaseUrl: "",
      llmDraftApiKey: "",
      llmDraftModels: "",
      llmDraftStreaming: true,
      llmDraftToolCalls: true,
      llmDraftThinkingParam: emptyLlmSettings.thinkingParam,
      llmDraftThinkingLevels: emptyLlmSettings.thinkingLevels,
      llmDraftExtraArgs: "",
      llmDraftModel: "",
      llmDraftThinkingLevel: "",
      llmTestState: LlmTestState.Idle(),
      historyEnabled: true,
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

  const editorModelsLoad = maybeLoadEditorLlmModels(model)
  const commands = [...extraCommands, ...(editorModelsLoad.commands ?? [])]
  return Array.isReadonlyArrayNonEmpty(commands)
    ? { model: editorModelsLoad.model, commands }
    : { model: editorModelsLoad.model }
}

const enqueueToast = (
  model: Model,
  banner: AlertBanner,
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
  if (banner.variant === "info") {
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
            isMaximized: model.editorIsMaximized,
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

const resolveEffectiveLlmModel = (model: Model): string => {
  const modelOptions = resolveModelOptions(
    model.llmEnabled ? model.llmModels : "",
    model.llmEnabled ? model.llmDiscoveredModels : [],
    model.llmEnabled ? model.llmModel : "",
    model.hasLanguageModel,
  )
  if (model.llmEnabled && model.llmModel.trim() !== "") {
    return model.llmModel.trim()
  }
  return modelOptions[0]?.value ?? ""
}

const maybeLoadEditorLlmModels = (
  model: Model,
): { readonly model: Model; readonly commands?: ReadonlyArray<Command.Command<Message>> } => {
  const shouldLoad =
    model.llmEnabled &&
    !model.hasLoadedEditorLlmModels &&
    model.llmBaseUrl.trim() !== "" &&
    Array.isReadonlyArrayEmpty(parseModelList(model.llmModels)) &&
    Array.isReadonlyArrayEmpty(model.llmDiscoveredModels)

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
              maybeActiveIslandUrl: () => Option.some(buildTauriIslandUrl(folderSubPath, fileName)),
              maybeActiveIslandPath: () => Option.some(url.pathname),
            }),
          }
        }
      }

      const route = parseUrlToRoute(url)
      const modelWithRoute = modifyFields(model, {
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
            isMaximized: modelWithRoute.editorIsMaximized,
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

            const editorModelsLoad = maybeLoadEditorLlmModels(modelWithRoute)
            return {
              model: modifyFields(editorModelsLoad.model, {
                isSettingsOpen: () => false,
              }),
              commands: [
                toModalCommand(Modal.InspectFileForEditor({ entryName: name, subPath })),
                ...(editorModelsLoad.commands ?? []),
              ],
            }
          })
        },

        Help: ({ maybeTopic }) => ({
          model: modifyFields(modelWithRoute, {
            isSettingsOpen: () => false,
            modalState: () => Modal.openHelp(maybeTopic, modelWithRoute.modalState),
          }),
        }),
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

    ClickedOpenSettingsDialog: () => ({
      model: modifyFields(model, {
        isSettingsOpen: () => false,
        isSettingsDialogOpen: () => true,
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
      }),
    }),

    ClickedCloseSettingsDialog: () => ({
      model: modifyFields(model, {
        isSettingsDialogOpen: () => false,
        llmTestState: () => LlmTestState.Idle(),
        clearAllHistoryState: () => ClearAllHistoryState.Idle(),
      }),
    }),

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

    ClickedSaveSettingsDialog: () => ({
      model: modifyFields(model, {
        isSettingsDialogOpen: () => false,
        llmEnabled: () => model.llmDraftEnabled,
        llmEditFormat: () => model.llmDraftEditFormat,
        llmBaseUrl: () => model.llmDraftBaseUrl,
        llmApiKey: () => model.llmDraftApiKey,
        llmModels: () => model.llmDraftModels,
        llmStreaming: () => model.llmDraftStreaming,
        llmToolCalls: () => model.llmDraftToolCalls,
        llmThinkingParam: () => model.llmDraftThinkingParam,
        llmThinkingLevels: () => model.llmDraftThinkingLevels,
        llmExtraArgs: () => model.llmDraftExtraArgs,
        llmModel: () => model.llmDraftModel,
        llmThinkingLevel: () => model.llmDraftThinkingLevel,
        hasLoadedEditorLlmModels: () => false,
      }),
      commands: [
        SaveLlmSettings({
          enabled: model.llmDraftEnabled,
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
        SaveEditorPreferences({
          isMaximized: model.editorIsMaximized,
          llmBarMode: model.editorLlmBarMode,
          llmModel: model.llmDraftModel,
          llmThinkingLevel: model.llmDraftThinkingLevel,
          editorSplitPercent: model.editorSplitPercent,
        }),
      ],
    }),

    ToggledLlmEnabled: ({ isChecked }) => ({
      model: modifyFields(model, {
        llmDraftEnabled: () => isChecked,
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

    UpdatedLlmEditFormat: ({ value }) => ({
      model: modifyFields(model, {
        llmDraftEditFormat: () => parseEditFormat(value),
        llmTestState: () => LlmTestState.Idle(),
      }),
    }),

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
        enabled: model.llmDraftEnabled,
        editFormat: model.llmDraftEditFormat,
        baseUrl: model.llmDraftBaseUrl,
        apiKey: model.llmDraftApiKey,
        models: model.llmDraftModels,
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

    SucceededTestLlm: ({ content, reasoning, models }) => ({
      model: modifyFields(model, {
        llmTestState: () => LlmTestState.Succeeded({ content, reasoning, models }),
        llmDiscoveredModels: (current) => (models.length > 0 ? models : current),
        llmDraftModel: (current) =>
          current.trim() === "" && models.length > 0 ? (models[0] ?? current) : current,
      }),
    }),

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
      isMaximized,
      llmBarMode,
      llmModel,
      llmThinkingLevel,
      editorSplitPercent,
      historyEnabled,
    }) => ({
      model: modifyFields(model, {
        editorIsMaximized: () => isMaximized,
        editorLlmBarMode: () => llmBarMode,
        editorSplitPercent: () => editorSplitPercent,
        historyEnabled: () => historyEnabled ?? model.historyEnabled,
        llmModel: (current) => (current === "" ? llmModel : current),
        llmDraftModel: (current) => (current === "" ? llmModel : current),
        llmThinkingLevel: (current) => (current === "" ? llmThinkingLevel : current),
        llmDraftThinkingLevel: (current) => (current === "" ? llmThinkingLevel : current),
        modalState: (current) =>
          Modal.applyEditorPreferences(current, {
            isMaximized,
            llmBarMode,
            editorSplitPercent,
          }),
      }),
    }),

    CompletedSaveEditorPreferences: () => ({ model }),

    SucceededLoadEditorLlmModels: ({ models }) => ({
      model: modifyFields(model, {
        llmDiscoveredModels: (current) => (models.length > 0 ? models : current),
        llmModel: (current) => (current.trim() === "" && models[0] ? models[0] : current),
        llmDraftModel: (current) => (current.trim() === "" && models[0] ? models[0] : current),
      }),
    }),

    FailedLoadEditorLlmModels: () => ({ model }),

    UpdatedEditorLlmChatStream: ({ completedTurns, activeTurn }) => ({
      model: modifyFields(model, {
        modalState: (current) =>
          Modal.applyEditorLlmChatStream(current, { completedTurns, activeTurn }),
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
              isMaximized: model.editorIsMaximized,
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
        return {
          model: modifyFields(model, {
            isSettingsDialogOpen: () => false,
          }),
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
      if (Modal.isPreviewOpen(model.modalState)) {
        const shouldNavigateBack = Modal.isEditorPreviewOpen(model.modalState)
        return {
          model: modifyFields(model, {
            modalState: Modal.closePreview,
          }),
          ...(shouldNavigateBack ? { commands: [NavigateHistoryBack()] } : {}),
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
          isMaximized: model.editorIsMaximized,
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
        None: () =>
          syncOpenEditor(
            modifyFields(model, {
              modalState: () => modalResult.model,
              historyEnabled: () => nextHistoryEnabled,
            }),
            mappedCommands,
          ),

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

        EntriesUpdated: ({ entries, maybeAlertBanner, replaceUrl: shouldReplaceUrl }) => {
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

        SelectedLlmModel: ({ value }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
            llmModel: () => value,
            llmDraftModel: () => value,
          }),
          commands: [
            ...mappedCommands,
            SaveEditorPreferences({
              isMaximized: model.editorIsMaximized,
              llmBarMode: model.editorLlmBarMode,
              llmModel: value,
              llmThinkingLevel: model.llmThinkingLevel,
              editorSplitPercent: model.editorSplitPercent,
            }),
          ],
        }),

        SelectedLlmThinkingLevel: ({ value }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
            llmThinkingLevel: () => value,
            llmDraftThinkingLevel: () => value,
          }),
          commands: [
            ...mappedCommands,
            SaveEditorPreferences({
              isMaximized: model.editorIsMaximized,
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
              isMaximized: model.editorIsMaximized,
              llmBarMode,
              llmModel: model.llmModel,
              llmThinkingLevel: model.llmThinkingLevel,
              editorSplitPercent: model.editorSplitPercent,
            }),
          ],
        }),

        ChangedMaximize: ({ isMaximized }) => ({
          model: modifyFields(model, {
            modalState: () => modalResult.model,
            editorIsMaximized: () => isMaximized,
          }),
          commands: [
            ...mappedCommands,
            SaveEditorPreferences({
              isMaximized,
              llmBarMode: model.editorLlmBarMode,
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
              isMaximized: model.editorIsMaximized,
              llmBarMode: model.editorLlmBarMode,
              llmModel: model.llmModel,
              llmThinkingLevel: model.llmThinkingLevel,
              editorSplitPercent,
            }),
          ],
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

        return {
          isSending: sending !== undefined,
          prompt: sending?.prompt ?? "",
          fileName: sending?.fileName ?? "",
          content: sending?.content ?? "",
          messages: sending?.messages ?? [],
          enabled: isChatAvailable(model),
          editFormat: model.llmEditFormat,
          baseUrl: model.llmBaseUrl,
          apiKey: model.llmApiKey,
          models: model.llmModels,
          streaming: model.llmStreaming,
          toolCalls: model.llmToolCalls,
          thinkingParam: model.llmThinkingParam,
          thinkingLevels: model.llmThinkingLevels,
          extraArgs: model.llmExtraArgs,
          model: effectiveModel,
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
                              !isLanguageModelSelection(deps.model),
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
        [h.span([h.Class("breadcrumb-current")], ["Dateisystem-APIs nicht unterstützt"])],
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

  return h.div(
    [h.Class("settings-menu"), h.Id("settings-menu")],
    [
      h.button(
        [
          h.Type("button"),
          h.Id("btn-settings"),
          h.Class("btn btn-secondary btn-icon"),
          h.Title("Einstellungen"),
          h.AriaLabel("Einstellungen"),
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
            [viewIcon("help", h), " Hilfe"],
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
                  model.showFileInfo ? " Datei-Infos ausblenden" : " Datei-Infos einblenden",
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
            [viewIcon("settings", h), " Einstellungen"],
          ),
          isInstallAvailable
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-install-app"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.Title("PWA Islands als App installieren"),
                  h.OnClick(Message.ClickedInstallApp()),
                ],
                [viewIcon("install", h), " App installieren"],
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
  const { isFsaReady, isFsaNoFolder, isFsaPermissionRequired, canSwitchToOpfs, canSwitchToFsa } =
    getStorageCapabilities(model)
  const currentStorageLabel = Option.map(
    currentStorageTypeFromStorageState(model.storageState),
    (storageType) =>
      storageType === "opfs"
        ? "App-Speicher"
        : storageType === "tauri"
          ? "Lokaler Ordner (App)"
          : "Lokaler Ordner",
  )

  return h.div(
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
              h.h3([h.Id("settings-dialog-title"), h.Class("modal-title")], ["Einstellungen"]),
              h.button(
                [
                  h.Type("button"),
                  h.Id("btn-close-settings"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
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
                [h.Class("settings-group"), h.Id("settings-group-fs")],
                [
                  h.h4(
                    [h.Id("current-storage"), h.Class("settings-group-title")],
                    [
                      Option.match(currentStorageLabel, {
                        onNone: () => "Dateisystem",
                        onSome: (label) =>
                          model.hasTauri ? "Dateisystem" : `Dateisystem: ${label}`,
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
                              h.Title("Internen Browser-Speicher (OPFS) verwenden"),
                              h.OnClick(Message.ClickedUseOpfs()),
                            ],
                            [viewIcon("package", h), " Zu App-Speicher wechseln"],
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
                            [viewIcon("folder", h), " Zu lokalem Ordner wechseln"],
                          )
                        : h.empty,
                      isFsaNoFolder
                        ? h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-change-folder"),
                              h.Class("btn btn-secondary"),
                              h.Role("menuitem"),
                              h.Title("Ordner wählen"),
                              h.OnClick(Message.ClickedSelectFolder()),
                            ],
                            [viewIcon("folder-open", h), " Ordner wählen"],
                          )
                        : h.empty,
                      isFsaReady || isFsaPermissionRequired
                        ? h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-change-folder"),
                              h.Class("btn btn-secondary"),
                              h.Role("menuitem"),
                              h.Title("Anderen Ordner wählen"),
                              h.OnClick(Message.ClickedChangeFolder()),
                            ],
                            [viewIcon("folder-open", h), " Ordner wechseln"],
                          )
                        : h.empty,
                      isFsaReady
                        ? h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-disconnect-folder"),
                              h.Class("btn btn-secondary is-danger"),
                              h.Role("menuitem"),
                              h.Title("Ordner trennen"),
                              h.OnClick(Message.ClickedDisconnectFolder()),
                            ],
                            [viewIcon("plug", h), " Trennen"],
                          )
                        : h.empty,
                    ],
                  ),
                ],
              ),
              h.section(
                [h.Class("settings-group"), h.Id("settings-group-history")],
                [
                  h.h4([h.Class("settings-group-title")], ["Versionsverlauf"]),
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
                          h.span([], ["Versionen automatisch speichern"]),
                        ],
                      ),
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
                            [viewIcon("trash", h), " Alle Versionen löschen"],
                          ),
                        ],
                      ),
                    Confirming: () =>
                      h.div(
                        [h.Id("clear-all-history-confirm"), h.Class("template-save-row")],
                        [
                          h.span(
                            [h.Class("template-delete-prompt")],
                            ["Alle gespeicherten Versionen aller Dateien löschen?"],
                          ),
                          h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-clear-all-history-cancel"),
                              h.Class("btn btn-secondary"),
                              h.OnClick(Message.ClickedCancelClearAllHistory()),
                            ],
                            ["Abbrechen"],
                          ),
                          h.button(
                            [
                              h.Type("button"),
                              h.Id("btn-clear-all-history-confirm"),
                              h.Class("btn btn-danger"),
                              h.OnClick(Message.ClickedConfirmClearAllHistory()),
                            ],
                            ["Endgültig löschen"],
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
                            ["Lösche…"],
                          ),
                        ],
                      ),
                    Done: () =>
                      h.div(
                        [h.Class("settings-group-actions")],
                        [
                          h.span(
                            [h.Id("clear-all-history-done"), h.Class("form-hint")],
                            ["Alle Versionen wurden gelöscht."],
                          ),
                        ],
                      ),
                  }),
                ],
              ),
              h.section(
                [h.Class("settings-group"), h.Id("settings-group-llm")],
                [
                  h.h4([h.Class("settings-group-title")], ["KI"]),
                  h.div(
                    [h.Class("form-group")],
                    [
                      h.label([h.For("llm-edit-format")], ["Bearbeitungsformat"]),
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
                            h.Id("llm-enabled"),
                            h.Checked(model.llmDraftEnabled),
                            h.OnChange(() =>
                              Message.ToggledLlmEnabled({
                                isChecked: !model.llmDraftEnabled,
                              }),
                            ),
                          ]),
                          h.span([], ["Chat-API aktivieren"]),
                        ],
                      ),
                      model.hasLanguageModel
                        ? h.p(
                            [h.Id("llm-native-detected-hint"), h.Class("form-hint")],
                            [
                              "Browser-KI (LanguageModel-API) erkannt – Chat im Editor ist automatisch aktiv.",
                            ],
                          )
                        : h.empty,
                    ],
                  ),
                  ...(model.llmDraftEnabled
                    ? [
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
                            h.label(
                              [h.For("llm-models")],
                              ["Modellliste (optional, kommagetrennt)"],
                            ),
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
                                      [
                                        h.Value(preset.id),
                                        h.Selected(matchedPresetId === preset.id),
                                      ],
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
                            h.p(
                              [h.Id("llm-test-result"), h.Class("form-hint is-danger")],
                              [message],
                            ),
                        }),
                      ]
                    : []),
                ],
              ),
            ],
          ),
          h.footer(
            [h.Class("modal-footer")],
            [
              h.div([h.Class("modal-footer-left")]),
              h.div(
                [h.Class("modal-footer-right")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-cancel-settings"),
                      h.Class("btn btn-secondary"),
                      h.OnClick(Message.ClickedCloseSettingsDialog()),
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
}

const viewToolbar = (model: Model, h: HtmlBuilder): Html.Html => {
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
                  h.Title("Neue Datei erstellen"),
                  h.AriaLabel("Neue Datei erstellen"),
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
                  h.span([h.Class("btn-label")], ["Datei"]),
                ],
              )
            : h.empty,
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-new-folder"),
                  h.Class("btn btn-primary"),
                  h.Title("Neuen Ordner erstellen"),
                  h.AriaLabel("Neuen Ordner erstellen"),
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
                  h.span([h.Class("btn-label")], ["Ordner"]),
                ],
              )
            : h.empty,
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-import-file"),
                  h.Class("btn btn-secondary"),
                  h.Title("Externe Dateien hochladen"),
                  h.AriaLabel("Externe Dateien hochladen"),
                  h.OnClick(Message.ClickedImportFiles()),
                ],
                [
                  h.span([h.Class("btn-icon-only"), h.AriaHidden(true)], [viewIcon("upload", h)]),
                  h.span([h.Class("btn-label")], ["Hochladen"]),
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

const viewEntryRow = (entry: FileEntry, showFileInfo: boolean, h: HtmlBuilder): Html.Html => {
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

  return h.keyed("tr")(
    entry.id,
    [
      h.Class(`file-row ${isDir ? "is-directory" : "is-file"}`),
      h.DataAttribute("entry", entry.name),
      h.DataAttribute("kind", entry.kind),
      h.Title(isDir ? "Ordner öffnen" : "Datei öffnen"),
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
        ? h.td([h.Class("file-size-cell"), h.DataAttribute("label", "Größe")], [sizeDisplay])
        : h.empty,
      showFileInfo
        ? h.td(
            [
              h.Class("file-date-cell"),
              h.DataAttribute("label", "Zuletzt geändert"),
              h.DataAttribute("label-short", "Geändert"),
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
              h.button(
                [
                  h.Type("button"),
                  h.Class("btn btn-secondary btn-sm btn-edit-entry"),
                  h.DataAttribute("entry", entry.name),
                  h.Title(isDir ? "Ordner bearbeiten" : "Datei bearbeiten"),
                  h.AriaLabel(isDir ? "Ordner bearbeiten" : "Datei bearbeiten"),
                  h.OnClick(Message.ClickedEditEntry({ entry }), {
                    propagation: "Stop",
                  }),
                ],
                [viewIcon("edit", h), h.span([h.Class("btn-label")], ["Bearbeiten"])],
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
  h: HtmlBuilder,
): Html.Html => {
  return Array.match(entries, {
    onEmpty: () =>
      h.div(
        [h.Class("empty-state")],
        [
          h.div([h.Class("empty-icon"), h.AriaHidden(true)], [viewIcon("folder", h)]),
          h.h3([], ["Ordner ist leer"]),
        ],
      ),
    onNonEmpty: (entries) => viewFilesTableContent(entries, showFileInfo, h),
  })
}

const viewFilesTableContent = (
  entries: ReadonlyArray<FileEntry>,
  showFileInfo: boolean,
  h: HtmlBuilder,
): Html.Html =>
  h.div(
    [],
    [
      h.div([h.Class("files-summary")], [h.span([], [formatSummaryText(entries)])]),
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
                      h.th([h.Scope("col"), h.Class("th-name")], ["Name"]),
                      showFileInfo
                        ? h.th([h.Scope("col"), h.Class("th-size")], ["Größe"])
                        : h.empty,
                      showFileInfo
                        ? h.th([h.Scope("col"), h.Class("th-date")], ["Zuletzt geändert"])
                        : h.empty,
                      h.th(
                        [h.Scope("col"), h.Class("th-actions")],
                        [h.span([h.Class("visually-hidden")], ["Aktion"])],
                      ),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                pipe(
                  entries,
                  Array.map((entry) => viewEntryRow(entry, showFileInfo, h)),
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  )

const viewContentSection = (model: Model, h: HtmlBuilder): Html.Html =>
  h.div(
    [h.Id("files-content"), h.Class("files-content")],
    [
      StorageState.match(model.storageState, {
        Initializing: () =>
          h.div(
            [h.Class("loading-state")],
            [
              h.div([h.Class("spinner"), h.AriaHidden(true)]),
              h.p([], ["Dateien werden geladen..."]),
            ],
          ),

        Unsupported: () =>
          h.div(
            [h.Class("empty-state")],
            [
              h.p(
                [],
                ["In dieser Umgebung ist keine kompatible lokale Dateisystem-API verfügbar."],
              ),
            ],
          ),

        NoFolderSelected: () =>
          h.div(
            [h.Class("empty-state")],
            [
              h.div([h.Class("empty-icon"), h.AriaHidden(true)], [viewIcon("folder-open", h)]),
              h.h3([], ["Kein Ordner ausgewählt"]),
              h.p([], ["Wähle einen lokalen Ordner, in dem deine Projekte gespeichert werden."]),
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
                    [viewIcon("folder-open", h), " Ordner wählen"],
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
              h.h3([], ["Zugriff erforderlich"]),
              h.p(
                [],
                [
                  "Um Ihre Dateien zu laden, bestätigen Sie bitte den dauerhaften Zugriff auf den Ordner ",
                  h.strong([], [folderName]),
                  ".",
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("btn-grant-permission-hero"),
                  h.Class("btn btn-primary"),
                  h.OnClick(Message.ClickedGrantPermission()),
                ],
                [`Zugriff auf "${folderName}" erlauben`],
              ),
            ],
          ),

        Ready: ({ entriesState }) =>
          EntriesState.match(entriesState, {
            Loading: () =>
              h.div(
                [h.Class("loading-state")],
                [
                  h.div([h.Class("spinner"), h.AriaHidden(true)]),
                  h.p([], ["Dateien werden geladen..."]),
                ],
              ),
            Loaded: ({ entries }) => viewFilesTable(entries, model.showFileInfo, h),
            Error: ({ message }) =>
              h.div(
                [h.Class("empty-state")],
                [
                  h.div([h.Class("empty-icon"), h.AriaHidden(true)], [viewIcon("warning", h)]),
                  h.h3([], ["Fehler beim Lesen der Dateien"]),
                  h.p([], [message]),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-retry-list"),
                      h.Class("btn btn-primary"),
                      h.OnClick(Message.ClickedRetryList()),
                    ],
                    ["Erneut versuchen"],
                  ),
                ],
              ),
          }),
      }),
    ],
  )

// VIEW MODALS

const viewModalContainer = (model: Model, h: HtmlBuilder): Html.Html => {
  const llmModelOptions = resolveModelOptions(
    model.llmEnabled ? model.llmModels : "",
    model.llmEnabled ? model.llmDiscoveredModels : [],
    model.llmEnabled ? model.llmModel : "",
    model.hasLanguageModel,
  )
  const llmSelectedModel = resolveEffectiveLlmModel(model)
  const llmThinkingLevels =
    model.llmEnabled && model.llmThinkingParam.trim() !== ""
      ? parseThinkingLevels(model.llmThinkingLevels)
      : []

  return h.submodel({
    slotId: "modal",
    model: model.modalState,
    viewInputs: {
      origin: model.origin,
      hasDirectoryPicker: model.hasDirectoryPicker,
      hasOPFS: model.hasOPFS,
      hasTauri: model.hasTauri,
      llm: {
        llmEnabled: isChatAvailable(model),
        llmModelOptions,
        llmSelectedModel,
        llmThinkingLevels,
        llmSelectedThinkingLevel: model.llmThinkingLevel,
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
  h: HtmlBuilder,
): Html.Html =>
  h.div(
    [h.Class("window-controls")],
    [
      h.button(
        [
          h.Type("button"),
          h.Id("fullscreen-btn"),
          h.Class("win-btn"),
          h.Title(isFullscreen ? "Vollbild beenden (F11)" : "Vollbild (F11)"),
          h.AriaLabel(isFullscreen ? "Vollbild beenden" : "Vollbild"),
          h.OnClick(Message.ClickedToggleFullscreen()),
        ],
        [isFullscreen ? "\uE73F" : "\uE740"],
      ),
      h.button(
        [
          h.Type("button"),
          h.Id("min-btn"),
          h.Class("win-btn"),
          h.Title("Minimieren"),
          h.AriaLabel("Minimieren"),
          h.OnClick(Message.ClickedMinimizeWindow()),
        ],
        ["\uE921"],
      ),
      h.button(
        [
          h.Type("button"),
          h.Id("max-btn"),
          h.Class("win-btn"),
          h.Title(isMaximized ? "Wiederherstellen" : "Maximieren"),
          h.AriaLabel(isMaximized ? "Wiederherstellen" : "Maximieren"),
          h.OnClick(Message.ClickedToggleMaximizeWindow()),
        ],
        [isMaximized ? "\uE923" : "\uE922"],
      ),
      h.button(
        [
          h.Type("button"),
          h.Id("close-btn"),
          h.Class("win-btn close-btn"),
          h.Title("Schließen"),
          h.AriaLabel("Schließen"),
          h.OnClick(Message.ClickedCloseWindow()),
        ],
        ["\uE8BB"],
      ),
    ],
  )

const viewWindowTopBorder = (
  title: string,
  isFocused: boolean,
  isMaximized: boolean,
  isFullscreen: boolean,
  h: HtmlBuilder,
): Html.Html =>
  h.header(
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
          h.Title("Zurück (Doppelklick: Bearbeitungsmodus)"),
          h.AriaLabel("Zurück"),
          h.OnClick(Message.ClickedReturnArrow()),
          h.OnDoubleClick(Message.DoubleClickedReturnArrow()),
        ],
        [
          h.span([h.Class("window-top-border-arrow"), h.AriaHidden(true)], ["←"]),
          h.span([h.Class("window-top-border-title")], [title]),
        ],
      ),
      h.div([h.Class("titlebar-drag-spacer"), h.DataAttribute("tauri-drag-region", "true")], []),
      viewWindowControls(isMaximized, isFullscreen, h),
    ],
  )

const viewManagerTitlebar = (
  title: string,
  canNavigateBack: boolean,
  isFocused: boolean,
  isMaximized: boolean,
  isFullscreen: boolean,
  h: HtmlBuilder,
): Html.Html =>
  h.header(
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
              h.Title("Zurück"),
              h.AriaLabel("Zurück"),
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
      viewWindowControls(isMaximized, isFullscreen, h),
    ],
  )

const viewIslandContainer = (
  islandUrl: string,
  showTopBorder: boolean,
  title: string,
  isFocused: boolean,
  isMaximized: boolean,
  isFullscreen: boolean,
  h: HtmlBuilder,
): Html.Html =>
  h.div(
    [h.Class(isFullscreen ? "island-container is-fullscreen" : "island-container")],
    [
      showTopBorder ? viewWindowTopBorder(title, isFocused, isMaximized, isFullscreen, h) : h.empty,
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
              h,
            ),
        }),
        viewToasts(
          model.toasts,
          (id) => Message.ClickedDismissToast({ id }),
          (message) => Message.ClickedCopyToast({ message }),
          h,
        ),
      ],
    ),
  }
}
