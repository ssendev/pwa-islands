import { Match, Option } from "effect"
import { modifyFields } from "foldkit/struct"
import { Command, given, message, model, story } from "foldkit/story"
import { fromString } from "foldkit/url"
import { describe, expect, it } from "vitest"
import * as Editor from "./editor"
import { DeleteEntry, EditorFileMode, OverwriteSource, SaveChanges } from "./editor"
import * as Help from "./help"
import {
  CopyApiDtsToClipboard,
  CopyDtsState,
  ScrollHelpTopicIntoView,
  WaitBeforeResetCopyDts,
} from "./help"
import {
  ActivateFsaBackend,
  ActivateOpfsBackend,
  CloseWindow,
  DisconnectStorage,
  EntriesState,
  FocusIslandIframe,
  HandleIslandIpcRequest,
  InstallPrompt,
  IslandIpcAction,
  LoadEditorLlmModels,
  Message,
  MinimizeWindow,
  type Model,
  NavigateHistoryBack,
  NavigateHistoryForward,
  NavigateToSubfolder,
  OpenFileInBrowser,
  PickLocalDirectory,
  PushUrl,
  RefreshEntries,
  ReplaceUrl,
  ResolveIslandBackNavigation,
  SavedBackend,
  SaveEditorPreferences,
  SaveFileInfoPreference,
  SaveLlmSettings,
  SaveStorageTypePreference,
  ScheduleReturnArrowClick,
  StorageState,
  TestLlm,
  ToggleMaximizeWindow,
  ToggleFullscreenWindow,
  ExitFullscreenWindow,
  init,
  parseIslandWindowMessage,
  update,
  LlmTestState,
} from "./main"
import * as Modal from "./modal"
import {
  FocusModalNameInput,
  ModalState,
  RevokeActivePreviewUrl,
  WritePendingImportFiles,
} from "./modal"
import type { FileEntry } from "./files"
import { AppRoute } from "./route"
import { OPFS_APP_FOLDER } from "./storage"

const modalMsg = (m: Modal.Message) => Message.GotModalMessage({ message: m })
const editorMsg = (m: Editor.Message) =>
  Message.GotModalMessage({ message: Modal.Message.GotEditorMessage({ message: m }) })
const helpMsg = (m: Help.Message) =>
  Message.GotModalMessage({ message: Modal.Message.GotHelpMessage({ message: m }) })

const sampleEntries: ReadonlyArray<FileEntry> = [
  {
    id: "directory:projekte",
    name: "projekte",
    kind: "directory",
    maybeSize: Option.none(),
    maybeLastModified: Option.none(),
  },
  {
    id: "file:index.html",
    name: "index.html",
    kind: "file",
    maybeSize: Option.some(512),
    maybeLastModified: Option.some(1_700_000_000_000),
  },
]

const readyModel: Model = {
  hasDirectoryPicker: true,
  hasOPFS: true,
  hasTauri: false,
  isWindowsOrLinux: true,
  isWindows: false,
  isWindowFocused: true,
  isWindowMaximized: false,
  isWindowFullscreen: false,
  origin: "http://localhost:5173",
  storageState: StorageState.Ready({
    storageType: "fsa",
    rootName: "Meine Islands",
    subPath: [],
    entriesState: EntriesState.Loaded({ entries: sampleEntries }),
    otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
  }),
  showFileInfo: true,
  isSettingsOpen: false,
  isSettingsDialogOpen: false,
  llmEnabled: false,
  llmEditFormat: "hashline",
  llmBaseUrl: "",
  llmApiKey: "",
  llmModels: "",
  llmStreaming: true,
  llmToolCalls: true,
  llmThinkingParam: "",
  llmThinkingLevels: "",
  llmExtraArgs: "",
  llmModel: "",
  llmThinkingLevel: "",
  llmDiscoveredModels: [],
  hasLoadedEditorLlmModels: false,
  editorIsMaximized: false,
  editorLlmBarMode: "Closed",
  editorSplitPercent: 62,
  llmDraftEnabled: false,
  llmDraftEditFormat: "hashline",
  llmDraftBaseUrl: "",
  llmDraftApiKey: "",
  llmDraftModels: "",
  llmDraftStreaming: true,
  llmDraftToolCalls: true,
  llmDraftThinkingParam: "",
  llmDraftThinkingLevels: "",
  llmDraftExtraArgs: "",
  llmDraftModel: "",
  llmDraftThinkingLevel: "",
  llmTestState: LlmTestState.Idle(),
  installPrompt: InstallPrompt.Unavailable(),
  modalState: ModalState.Closed(),
  maybeAlertBanner: Option.none(),
  maybeActiveIslandUrl: Option.none(),
  maybeActiveIslandPath: Option.none(),
  returnClickId: 0,
}

const rootUrl = Option.getOrThrow(fromString("http://localhost:5173/"))
const helpFsUrl = Option.getOrThrow(fromString("http://localhost:5173/?pwaislands=help-fs"))

describe("PWA Islands Story Tests", () => {
  describe("init", () => {
    it("transitions to Unsupported when neither FSA nor OPFS is supported", () => {
      const result = init(
        {
          hasDirectoryPicker: false,
          hasOPFS: false,
          hasTauri: false,
          origin: "http://localhost:5173",
        },
        rootUrl,
      )

      expect(
        StorageState.match(result.model.storageState, {
          Unsupported: () => true,
          Initializing: () => false,
          NoFolderSelected: () => false,
          PermissionRequired: () => false,
          Ready: () => false,
        }),
      ).toBe(true)
      expect(Option.isSome(result.model.maybeAlertBanner)).toBe(true)
      expect(result.commands).toBeUndefined()
    })

    it("starts Initializing and opens Help modal when ?pwaislands=help-fs is present", () => {
      const result = init(
        {
          hasDirectoryPicker: true,
          hasOPFS: true,
          hasTauri: false,
          origin: "http://localhost:5173",
        },
        helpFsUrl,
      )

      expect(
        StorageState.match(result.model.storageState, {
          Initializing: () => true,
          Unsupported: () => false,
          NoFolderSelected: () => false,
          PermissionRequired: () => false,
          Ready: () => false,
        }),
      ).toBe(true)
      expect(result.model.modalState).toEqual(
        ModalState.Help({
          help: {
            maybeOpenTopic: Option.some("fs"),
            copyDtsState: CopyDtsState.Idle(),
          },
        }),
      )
      expect(result.commands).toHaveLength(4)
    })
  })

  describe("update flows", () => {
    it("loads file info preference and completes storage initialization", () => {
      const initial = init(
        {
          hasDirectoryPicker: true,
          hasOPFS: true,
          hasTauri: false,
          origin: "http://localhost:5173",
        },
        rootUrl,
      )

      story(
        update,
        given(initial.model),
        message(Message.CompletedLoadFileInfoPreference({ visible: false })),
        model((m) => {
          expect(m.showFileInfo).toBe(false)
        }),
        message(
          Message.SucceededInitializeStorage({
            storageType: "fsa",
            rootName: "TestOrdner",
            subPath: [],
            entries: sampleEntries,
            otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
            maybeModalState: Option.none(),
            maybeAlertBanner: Option.none(),
          }),
        ),
        Command.expectNone(),
        model((m) => {
          expect(m.storageState).toEqual(
            StorageState.Ready({
              storageType: "fsa",
              rootName: "TestOrdner",
              subPath: [],
              entriesState: EntriesState.Loaded({ entries: sampleEntries }),
              otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
            }),
          )
        }),
      )
    })

    it("navigates into directory via PushUrl and ChangedUrl", () => {
      const subEntries: ReadonlyArray<FileEntry> = [
        {
          id: "file:app.html",
          name: "app.html",
          kind: "file",
          maybeSize: Option.some(128),
          maybeLastModified: Option.none(),
        },
      ]
      const targetUrl = Option.getOrThrow(fromString("http://localhost:5173/projekte?pwaislands"))

      story(
        update,
        given(readyModel),
        message(Message.ClickedEntryRow({ entry: sampleEntries[0] })),
        Command.expectExact(PushUrl({ url: "/projekte?pwaislands" })),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        message(Message.ChangedUrl({ url: targetUrl })),
        Command.expectExact(NavigateToSubfolder({ targetSubPath: ["projekte"] })),
        Command.resolve(
          NavigateToSubfolder,
          Message.SucceededNavigateToSubfolder({
            subPath: ["projekte"],
            entries: subEntries,
          }),
        ),
        model((m) => {
          expect(m.storageState).toEqual(
            StorageState.Ready({
              storageType: "fsa",
              rootName: "Meine Islands",
              subPath: ["projekte"],
              entriesState: EntriesState.Loaded({ entries: subEntries }),
              otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
            }),
          )
        }),
      )
    })

    it("toggles file info visibility and persists preference", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedToggleFileInfo()),
        Command.expectExact(SaveFileInfoPreference({ visible: false })),
        Command.resolve(SaveFileInfoPreference, Message.CompletedSaveFileInfoPreference()),
        model((m) => {
          expect(m.showFileInfo).toBe(false)
          expect(m.isSettingsOpen).toBe(false)
        }),
      )
    })

    it("opens file with pwaislands:// protocol in iframe when storage is tauri", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: ["unterordner"],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      story(
        update,
        given(tauriReadyModel),
        message(Message.ClickedEntryRow({ entry: sampleEntries[1] })),
        Command.expectExact(PushUrl({ url: "/unterordner/index.html" })),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(
            Option.some("pwaislands://localhost/unterordner/index.html"),
          )
        }),
        message(Message.LoadedIslandIframe()),
        Command.expectExact(FocusIslandIframe()),
        Command.resolve(FocusIslandIframe, Message.CompletedFocusIslandIframe()),
        message(
          Message.ReceivedIslandIpcRequest({
            requestId: "req-1",
            action: IslandIpcAction.Write({
              subPath: "unterordner/notiz.txt",
              data: [65, 66, 67],
            }),
          }),
        ),
        Command.expectExact(
          HandleIslandIpcRequest({
            requestId: "req-1",
            action: IslandIpcAction.Write({
              subPath: "unterordner/notiz.txt",
              data: [65, 66, 67],
            }),
          }),
        ),
        Command.resolve(HandleIslandIpcRequest, Message.CompletedHandleIslandIpcRequest()),
        message(Message.ReceivedIslandNavigation({ url: "/?pwaislands" })),
        Command.expectExact(
          PushUrl({ url: "/?pwaislands" }),
          RefreshEntries({ subPath: ["unterordner"] }),
        ),
        Command.resolveAll(
          [PushUrl, Message.CompletedPushUrl()],
          [
            RefreshEntries,
            Message.SucceededRefreshEntries({
              subPath: ["unterordner"],
              entries: sampleEntries,
            }),
          ],
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.none())
        }),
      )
    })

    it("immediately navigates to /folder?pwaislands when DoubleClickedReturnArrow is dispatched", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: ["unterordner"],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      story(
        update,
        given({
          ...tauriReadyModel,
          maybeActiveIslandUrl: Option.some("pwaislands://localhost/unterordner/index.html"),
          maybeActiveIslandPath: Option.some("/unterordner/index.html"),
        }),
        message(Message.DoubleClickedReturnArrow()),
        Command.expectExact(
          PushUrl({ url: "/unterordner?pwaislands" }),
          RefreshEntries({ subPath: ["unterordner"] }),
        ),
        Command.resolveAll(
          [PushUrl, Message.CompletedPushUrl()],
          [
            RefreshEntries,
            Message.SucceededRefreshEntries({
              subPath: ["unterordner"],
              entries: sampleEntries,
            }),
          ],
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.none())
        }),
      )
    })

    it("handles single-click navigation check: goes to parent index.html if it exists", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: ["foo", "bar"],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      story(
        update,
        given({
          ...tauriReadyModel,
          maybeActiveIslandUrl: Option.some("pwaislands://localhost/foo/bar/index.html"),
          maybeActiveIslandPath: Option.some("/foo/bar"),
        }),
        message(Message.ClickedReturnArrow()),
        Command.expectExact(ScheduleReturnArrowClick({ clickId: 1 })),
        Command.resolve(
          ScheduleReturnArrowClick,
          Message.CompletedReturnArrowClickDelay({ clickId: 1 }),
        ),
        Command.expectExact(
          ResolveIslandBackNavigation({
            folderSubPath: ["foo", "bar"],
            fileName: "index.html",
          }),
        ),
        Command.resolve(
          ResolveIslandBackNavigation,
          Message.CompletedResolveIslandBackNavigation({
            targetUrl: "/foo",
            isIsland: true,
            subPath: ["foo"],
            shouldNavigate: true,
          }),
        ),
        Command.expectExact(PushUrl({ url: "/foo" })),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(
            Option.some("pwaislands://localhost/foo/index.html"),
          )
        }),
      )
    })

    it("handles single-click navigation check: falls back to ?pwaislands if index.html does not exist", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: ["foo", "bar"],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      story(
        update,
        given({
          ...tauriReadyModel,
          maybeActiveIslandUrl: Option.some("pwaislands://localhost/foo/bar/index.html"),
          maybeActiveIslandPath: Option.some("/foo/bar"),
        }),
        message(Message.ClickedReturnArrow()),
        Command.expectExact(ScheduleReturnArrowClick({ clickId: 1 })),
        Command.resolve(
          ScheduleReturnArrowClick,
          Message.CompletedReturnArrowClickDelay({ clickId: 1 }),
        ),
        Command.expectExact(
          ResolveIslandBackNavigation({
            folderSubPath: ["foo", "bar"],
            fileName: "index.html",
          }),
        ),
        Command.resolve(
          ResolveIslandBackNavigation,
          Message.CompletedResolveIslandBackNavigation({
            targetUrl: "/foo/bar?pwaislands",
            isIsland: false,
            subPath: ["foo", "bar"],
            shouldNavigate: true,
          }),
        ),
        Command.expectExact(
          PushUrl({ url: "/foo/bar?pwaislands" }),
          RefreshEntries({ subPath: ["foo", "bar"] }),
        ),
        Command.resolveAll(
          [PushUrl, Message.CompletedPushUrl()],
          [
            RefreshEntries,
            Message.SucceededRefreshEntries({
              subPath: ["foo", "bar"],
              entries: sampleEntries,
            }),
          ],
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.none())
        }),
      )
    })

    it("does not navigate away on single-click when root / (index.html) is open, only on double-click", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: [],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      // Single click on root / or /index.html: does not produce commands or change URL
      story(
        update,
        given({
          ...tauriReadyModel,
          maybeActiveIslandUrl: Option.some("pwaislands://localhost/index.html"),
          maybeActiveIslandPath: Option.some("/index.html"),
        }),
        message(Message.ClickedReturnArrow()),
        Command.expectExact(ScheduleReturnArrowClick({ clickId: 1 })),
        Command.resolve(
          ScheduleReturnArrowClick,
          Message.CompletedReturnArrowClickDelay({ clickId: 1 }),
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.some("pwaislands://localhost/index.html"))
        }),
      )

      // Double click on root / or /index.html: immediately goes to /?pwaislands
      story(
        update,
        given({
          ...tauriReadyModel,
          maybeActiveIslandUrl: Option.some("pwaislands://localhost/index.html"),
          maybeActiveIslandPath: Option.some("/index.html"),
        }),
        message(Message.DoubleClickedReturnArrow()),
        Command.expectExact(PushUrl({ url: "/?pwaislands" }), RefreshEntries({ subPath: [] })),
        Command.resolveAll(
          [PushUrl, Message.CompletedPushUrl()],
          [
            RefreshEntries,
            Message.SucceededRefreshEntries({
              subPath: [],
              entries: sampleEntries,
            }),
          ],
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.none())
        }),
      )
    })

    it("navigates from /foo?pwaislands to /?pwaislands on single-click", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: ["foo"],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      story(
        update,
        given({
          ...tauriReadyModel,
          maybeActiveIslandUrl: Option.none(),
          maybeActiveIslandPath: Option.none(),
        }),
        message(Message.ClickedReturnArrow()),
        Command.expectExact(ScheduleReturnArrowClick({ clickId: 1 })),
        Command.resolve(
          ScheduleReturnArrowClick,
          Message.CompletedReturnArrowClickDelay({ clickId: 1 }),
        ),
        Command.expectExact(PushUrl({ url: "/?pwaislands" }), RefreshEntries({ subPath: [] })),
        Command.resolveAll(
          [PushUrl, Message.CompletedPushUrl()],
          [
            RefreshEntries,
            Message.SucceededRefreshEntries({
              subPath: [],
              entries: sampleEntries,
            }),
          ],
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.none())
        }),
      )
    })

    it("navigates from /foo/bar?pwaislands to /foo?pwaislands on single-click", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: ["foo", "bar"],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      story(
        update,
        given({
          ...tauriReadyModel,
          maybeActiveIslandUrl: Option.none(),
          maybeActiveIslandPath: Option.none(),
        }),
        message(Message.ClickedReturnArrow()),
        Command.expectExact(ScheduleReturnArrowClick({ clickId: 1 })),
        Command.resolve(
          ScheduleReturnArrowClick,
          Message.CompletedReturnArrowClickDelay({ clickId: 1 }),
        ),
        Command.expectExact(
          PushUrl({ url: "/foo?pwaislands" }),
          RefreshEntries({ subPath: ["foo"] }),
        ),
        Command.resolveAll(
          [PushUrl, Message.CompletedPushUrl()],
          [
            RefreshEntries,
            Message.SucceededRefreshEntries({
              subPath: ["foo"],
              entries: sampleEntries,
            }),
          ],
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.none())
        }),
      )
    })

    it("supports browser history back/forward and URL sync for Tauri island iframe", () => {
      const tauriReadyModel: Model = {
        ...readyModel,
        hasTauri: true,
        storageState: StorageState.Ready({
          storageType: "tauri",
          rootName: "PWA Islands",
          subPath: ["unterordner"],
          entriesState: EntriesState.Loaded({ entries: sampleEntries }),
          otherBackend: SavedBackend.Unsupported(),
        }),
      }

      story(
        update,
        given(tauriReadyModel),
        message(Message.PressedNavigateBack()),
        Command.expectExact(NavigateHistoryBack()),
        Command.resolve(NavigateHistoryBack, Message.CompletedNavigateHistoryBack()),
        message(Message.PressedNavigateForward()),
        Command.expectExact(NavigateHistoryForward()),
        Command.resolve(NavigateHistoryForward, Message.CompletedNavigateHistoryForward()),
        message(
          Message.ChangedUrl({
            url: Option.getOrThrow(fromString("http://localhost:5173/unterordner/index.html")),
          }),
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(
            Option.some("pwaislands://localhost/unterordner/index.html"),
          )
        }),
        message(
          Message.ChangedUrl({
            url: Option.getOrThrow(fromString("http://localhost:5173/unterordner?pwaislands")),
          }),
        ),
        Command.expectExact(RefreshEntries({ subPath: ["unterordner"] })),
        Command.resolve(
          RefreshEntries,
          Message.SucceededRefreshEntries({
            subPath: ["unterordner"],
            entries: sampleEntries,
          }),
        ),
        model((m) => {
          expect(m.maybeActiveIslandUrl).toEqual(Option.none())
        }),
      )
    })

    it("opens file with relative path when storage is not tauri", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedEntryRow({ entry: sampleEntries[1] })),
        Command.expectExact(
          OpenFileInBrowser({
            subPath: [],
            fileName: "index.html",
          }),
        ),
        Command.resolve(OpenFileInBrowser, Message.CompletedOpenFileInBrowser()),
      )
    })

    it("parses island window postMessage events for navigation and IPC mutations", () => {
      const writeEvent = new MessageEvent("message", {
        data: {
          type: "pwaislands:ipc",
          requestId: "123",
          action: "write",
          subPath: "ordner/test.txt",
          data: [104, 105],
        },
      })
      expect(parseIslandWindowMessage(writeEvent)).toEqual(
        Option.some(
          Message.ReceivedIslandIpcRequest({
            requestId: "123",
            action: IslandIpcAction.Write({
              subPath: "ordner/test.txt",
              data: [104, 105],
            }),
          }),
        ),
      )

      const mkdirEvent = new MessageEvent("message", {
        data: {
          type: "pwaislands:ipc",
          requestId: "124",
          action: "mkdir",
          subPath: "neuer-ordner",
        },
      })
      expect(parseIslandWindowMessage(mkdirEvent)).toEqual(
        Option.some(
          Message.ReceivedIslandIpcRequest({
            requestId: "124",
            action: IslandIpcAction.MakeDir({
              subPath: "neuer-ordner",
            }),
          }),
        ),
      )

      const renameEvent = new MessageEvent("message", {
        data: {
          type: "pwaislands:ipc",
          requestId: "125",
          action: "rename",
          from: "alt.txt",
          to: "neu.txt",
        },
      })
      expect(parseIslandWindowMessage(renameEvent)).toEqual(
        Option.some(
          Message.ReceivedIslandIpcRequest({
            requestId: "125",
            action: IslandIpcAction.Rename({
              from: "alt.txt",
              to: "neu.txt",
            }),
          }),
        ),
      )

      const removeEvent = new MessageEvent("message", {
        data: {
          type: "pwaislands:ipc",
          requestId: "126",
          action: "remove",
          subPath: "alt.txt",
          recursive: false,
        },
      })
      expect(parseIslandWindowMessage(removeEvent)).toEqual(
        Option.some(
          Message.ReceivedIslandIpcRequest({
            requestId: "126",
            action: IslandIpcAction.Remove({
              subPath: "alt.txt",
              recursive: false,
            }),
          }),
        ),
      )

      const copyEvent = new MessageEvent("message", {
        data: {
          type: "pwaislands:ipc",
          requestId: "127",
          action: "copy",
          from: "quelle.txt",
          to: "ziel.txt",
        },
      })
      expect(parseIslandWindowMessage(copyEvent)).toEqual(
        Option.some(
          Message.ReceivedIslandIpcRequest({
            requestId: "127",
            action: IslandIpcAction.Copy({
              from: "quelle.txt",
              to: "ziel.txt",
            }),
          }),
        ),
      )

      const titlebarClickEvent = new MessageEvent("message", {
        data: {
          type: "pwaislands:titlebar-click",
        },
      })
      expect(parseIslandWindowMessage(titlebarClickEvent)).toEqual(
        Option.some(Message.ClickedReturnArrow()),
      )

      const titlebarDoubleClickEvent = new MessageEvent("message", {
        data: {
          type: "pwaislands:titlebar-double-click",
        },
      })
      expect(parseIslandWindowMessage(titlebarDoubleClickEvent)).toEqual(
        Option.some(Message.DoubleClickedReturnArrow()),
      )
    })

    it("handles copying /api.d.ts in the Help modal", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedOpenHelp()),
        Command.expectExact(PushUrl({ url: "/?pwaislands=help-quickstart" })),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        message(helpMsg(Help.Message.ClickedCopyDts())),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              help: {
                maybeOpenTopic: Option.some("quickstart"),
                copyDtsState: CopyDtsState.Copying(),
              },
            }),
          )
        }),
        Command.expectExact(CopyApiDtsToClipboard()),
        Command.resolve(CopyApiDtsToClipboard, Help.Message.SucceededCopyApiDtsToClipboard()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              help: {
                maybeOpenTopic: Option.some("quickstart"),
                copyDtsState: CopyDtsState.Copied(),
              },
            }),
          )
        }),
        Command.expectExact(WaitBeforeResetCopyDts()),
        Command.resolve(WaitBeforeResetCopyDts, Help.Message.CompletedWaitBeforeResetCopyDts()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              help: {
                maybeOpenTopic: Option.some("quickstart"),
                copyDtsState: CopyDtsState.Idle(),
              },
            }),
          )
        }),
        message(helpMsg(Help.Message.ToggledTopic({ topic: "fs", isOpen: true }))),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              help: {
                maybeOpenTopic: Option.some("fs"),
                copyDtsState: CopyDtsState.Idle(),
              },
            }),
          )
        }),
        Command.expectExact(
          ReplaceUrl({ url: "/?pwaislands=help-fs" }),
          ScrollHelpTopicIntoView({ topic: "fs" }),
        ),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        Command.resolve(ScrollHelpTopicIntoView, Help.Message.CompletedScrollHelpTopicIntoView()),
        message(helpMsg(Help.Message.ToggledTopic({ topic: "fs", isOpen: false }))),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              help: {
                maybeOpenTopic: Option.none(),
                copyDtsState: CopyDtsState.Idle(),
              },
            }),
          )
        }),
        Command.expectExact(ReplaceUrl({ url: "/?pwaislands=help" })),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        message(
          Message.ChangedUrl({
            url: Option.getOrThrow(fromString("http://localhost:5173/?pwaislands=help")),
          }),
        ),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              help: {
                maybeOpenTopic: Option.none(),
                copyDtsState: CopyDtsState.Idle(),
              },
            }),
          )
        }),
      )
    })

    it("opens FS help when the folder view is not visible", () => {
      const noFolderModel: Model = {
        ...readyModel,
        storageState: StorageState.NoFolderSelected({
          storageType: "fsa",
          otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
          pendingRoute: AppRoute.Folder({ subPath: [] }),
        }),
      }

      story(
        update,
        given(noFolderModel),
        message(Message.ClickedOpenHelp()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              help: {
                maybeOpenTopic: Option.some("fs"),
                copyDtsState: CopyDtsState.Idle(),
              },
            }),
          )
        }),
        Command.expectExact(PushUrl({ url: "/?pwaislands=help-fs" })),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
      )
    })

    it("validates empty name and slash in folder name", () => {
      const modelWithNewFolder: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: Editor.Model.CreateFolder({
            name: "",
            maybeValidationError: Option.none(),
            maybeAlertBanner: Option.none(),
          }),
        }),
      }

      story(
        update,
        given(modelWithNewFolder),
        message(editorMsg(Editor.Message.ClickedSave())),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.Model.CreateFolder({
                name: "",
                maybeValidationError: Option.some("Bitte geben Sie einen Ordnernamen ein."),
                maybeAlertBanner: Option.none(),
              }),
            }),
          )
        }),
        message(editorMsg(Editor.Message.UpdatedName({ name: "sub/folder" }))),
        message(editorMsg(Editor.Message.ClickedSave())),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.Model.CreateFolder({
                name: "sub/folder",
                maybeValidationError: Option.some(
                  "Der Ordnername darf keine Schrägstriche enthalten.",
                ),
                maybeAlertBanner: Option.none(),
              }),
            }),
          )
        }),
      )
    })

    it("validates duplicate folder name", () => {
      const modelWithDuplicateFolder: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: Editor.Model.CreateFolder({
            name: "projekte",
            maybeValidationError: Option.none(),
            maybeAlertBanner: Option.none(),
          }),
        }),
      }

      story(
        update,
        given(modelWithDuplicateFolder),
        message(editorMsg(Editor.Message.ClickedSave())),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.Model.CreateFolder({
                name: "projekte",
                maybeValidationError: Option.some(
                  'Ein Eintrag mit dem Namen "projekte" existiert bereits.',
                ),
                maybeAlertBanner: Option.none(),
              }),
            }),
          )
        }),
      )
    })

    it("prompts overwrite confirmation when creating a file with existing name", () => {
      const modelWithDuplicateFile: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: {
            ...Editor.makeCreateFile(),
            name: "index.html",
            content: "<p>New</p>",
          },
        }),
      }

      story(
        update,
        given(modelWithDuplicateFile),
        message(editorMsg(Editor.Message.ClickedSave())),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.Model.ConfirmOverwrite({
                targetName: "index.html",
                source: OverwriteSource.CreateFile({
                  content: "<p>New</p>",
                  selectedTemplateId: "builtin:empty",
                  userTemplates: [],
                }),
                maybeAlertBanner: Option.none(),
              }),
            }),
          )
        }),
        message(editorMsg(Editor.Message.ClickedConfirmOverwrite())),
        Command.expectExact(
          SaveChanges({
            model: Editor.Model.ConfirmOverwrite({
              targetName: "index.html",
              source: OverwriteSource.CreateFile({
                content: "<p>New</p>",
                selectedTemplateId: "builtin:empty",
                userTemplates: [],
              }),
              maybeAlertBanner: Option.none(),
            }),
            subPath: [],
          }),
        ),
        Command.resolve(
          SaveChanges,
          Editor.Message.SucceededSaveChanges({ entries: sampleEntries }),
        ),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("opens and closes full-window preview without saving and closes preview on Escape", () => {
      const modelWithCreate: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: modifyFields(Editor.makeCreateFile(), {
            content: () => "<h1>Hallo</h1>",
          }),
        }),
      }

      story(
        update,
        given(modelWithCreate),
        message(editorMsg(Editor.Message.ClickedOpenPreview())),
        Command.expectNone(),
        model((m) => {
          expect(Modal.isOpen(m.modalState)).toBe(true)
          expect(Modal.isPreviewOpen(m.modalState)).toBe(true)
        }),
        message(Message.PressedEscape()),
        Command.expectNone(),
        model((m) => {
          expect(Modal.isOpen(m.modalState)).toBe(true)
          expect(Modal.isPreviewOpen(m.modalState)).toBe(false)
        }),
      )
    })

    it("prompts delete confirmation and deletes modal entry", () => {
      const modelWithEditFile: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: Editor.Model.EditFile({
            originalName: "index.html",
            name: "index.html",
            fileMode: EditorFileMode.Text({ content: "<p>Hello</p>" }),
            maybeValidationError: Option.none(),
            maybeAlertBanner: Option.none(),
            maybePasteError: Option.none(),
            llmBarMode: "Closed",
            llmChatInput: "",
            llmChatMessages: [],
            llmChatDisplay: [],
            llmChatState: Editor.LlmChatState.Idle(),
            isMaximized: false,
            isEditingName: false,
            isPreviewOpen: false,
            editorSplitPercent: 62,
            editorSplitDrag: Option.none(),
            undoStack: [],
            redoStack: [],
            maybeOpfsHistoryCursor: Option.none(),
            historyState: Editor.HistoryState.Closed(),
          }),
        }),
      }

      story(
        update,
        given(modelWithEditFile),
        message(editorMsg(Editor.Message.ClickedDelete())),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.Model.ConfirmDelete({
                entryName: "index.html",
                entryKind: "file",
                maybeAlertBanner: Option.none(),
              }),
            }),
          )
        }),
        message(editorMsg(Editor.Message.ClickedConfirmDelete())),
        Command.expectExact(
          DeleteEntry({
            entryName: "index.html",
            entryKind: "file",
            subPath: [],
          }),
        ),
        Command.resolve(DeleteEntry, Editor.Message.SucceededDeleteEntry({ entries: [] })),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("handles copying LLM context in the Editor modal and keeps the alert inside the modal", () => {
      const modelWithEditor: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: Editor.makeCreateFile(),
        }),
      }

      story(
        update,
        given(modelWithEditor),
        message(editorMsg(Editor.Message.ClickedCopyLlmContext())),
        Command.expectExact(
          Editor.CopyLlmContextToClipboard({
            fileName: "Neu.html",
            content: "",
            editFormat: "hashline",
          }),
        ),
        Command.resolve(Editor.CopyLlmContextToClipboard, Editor.Message.SucceededCopyLlmContext()),
        model((m) => {
          expect(m.maybeAlertBanner).toEqual(Option.none())
          expect(
            Match.value(m.modalState).pipe(
              Match.tag("Editor", ({ editor }) =>
                Match.value(editor).pipe(
                  Match.tag("CreateFile", (createFile) => createFile.maybeAlertBanner),
                  Match.orElse(() => Option.none()),
                ),
              ),
              Match.orElse(() => Option.none()),
            ),
          ).toEqual(
            Option.some({
              message: "Datei und /api.d.ts für KI in die Zwischenablage kopiert",
              variant: "info",
            }),
          )
        }),
      )
    })

    it("displays save failure alert inside the modal and not in the main app", () => {
      const modelWithEditor: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: Editor.makeCreateFile(),
        }),
      }

      story(
        update,
        given(modelWithEditor),
        message(
          editorMsg(
            Editor.Message.FailedSaveChanges({
              message: "Konnte Datei nicht speichern: Speicher voll",
            }),
          ),
        ),
        Command.expectNone(),
        model((m) => {
          expect(m.maybeAlertBanner).toEqual(Option.none())
          expect(
            Match.value(m.modalState).pipe(
              Match.tag("Editor", ({ editor }) =>
                Match.value(editor).pipe(
                  Match.tag("CreateFile", (createFile) => createFile.maybeAlertBanner),
                  Match.orElse(() => Option.none()),
                ),
              ),
              Match.orElse(() => Option.none()),
            ),
          ).toEqual(
            Option.some({
              message: "Konnte Datei nicht speichern: Speicher voll",
              variant: "danger",
            }),
          )
        }),
      )
    })

    it("clears the modal alert banner when user clicks Save again in the Editor", () => {
      const baseCreate = modifyFields(Editor.makeCreateFile(), {
        name: () => "test.html",
        content: () => "hello",
      })
      const modelWithAlert: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: modifyFields(baseCreate, {
            maybeAlertBanner: () =>
              Option.some({
                message: "Ein Fehler ist aufgetreten",
                variant: "danger",
              }),
          }),
        }),
      }

      story(
        update,
        given(modelWithAlert),
        message(editorMsg(Editor.Message.ClickedSave())),
        Command.expectExact(
          SaveChanges({
            model: baseCreate,
            subPath: [],
          }),
        ),
        Command.resolve(
          SaveChanges,
          Editor.Message.SucceededSaveChanges({ entries: sampleEntries }),
        ),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("clears the modal alert banner when user clicks dismiss in the Editor", () => {
      const modelWithAlert: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: modifyFields(Editor.makeCreateFile(), {
            maybeAlertBanner: () =>
              Option.some({
                message: "/api.d.ts in die Zwischenablage kopiert",
                variant: "info",
              }),
          }),
        }),
      }

      story(
        update,
        given(modelWithAlert),
        message(editorMsg(Editor.Message.ClickedDismissAlert())),
        Command.expectNone(),
        model((m) => {
          expect(
            Match.value(m.modalState).pipe(
              Match.tag("Editor", ({ editor }) =>
                Match.value(editor).pipe(
                  Match.tag("CreateFile", (createFile) => createFile.maybeAlertBanner),
                  Match.orElse(() => Option.some({ message: "wrong", variant: "danger" })),
                ),
              ),
              Match.orElse(() => Option.some({ message: "wrong", variant: "danger" })),
            ),
          ).toEqual(Option.none())
        }),
      )
    })

    it("clears the main app alert banner when navigating into a folder, opening/closing editor, or clicking dismiss", () => {
      const modelWithMainAlert: Model = {
        ...readyModel,
        maybeAlertBanner: Option.some({
          message: "Vorheriger Fehler",
          variant: "danger",
        }),
      }

      // Dismissing via ClickedDismissAlert
      story(
        update,
        given(modelWithMainAlert),
        message(Message.ClickedDismissAlert()),
        Command.expectNone(),
        model((m) => {
          expect(m.maybeAlertBanner).toEqual(Option.none())
        }),
      )

      // Clicking folder row clears main alert
      story(
        update,
        given(modelWithMainAlert),
        message(Message.ClickedEntryRow({ entry: sampleEntries[0] })),
        Command.expectExact(PushUrl({ url: "/projekte?pwaislands" })),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        model((m) => {
          expect(m.maybeAlertBanner).toEqual(Option.none())
        }),
      )

      // Opening editor clears main alert
      story(
        update,
        given(modelWithMainAlert),
        message(Message.ClickedNewFile()),
        Command.expectExact(
          PushUrl({ url: "/?pwaislands=new" }),
          FocusModalNameInput(),
          Editor.LoadUserTemplates(),
        ),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        Command.resolve(
          Editor.LoadUserTemplates,
          Editor.Message.CompletedLoadUserTemplates({ templates: [] }),
        ),
        Command.resolve(FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()),
        model((m) => {
          expect(m.maybeAlertBanner).toEqual(Option.none())
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.makeCreateFile(),
            }),
          )
        }),
      )

      // Closing editor via Escape clears main alert
      story(
        update,
        given({
          ...modelWithMainAlert,
          modalState: ModalState.Editor({
            editor: Editor.makeCreateFile(),
          }),
        }),
        message(Message.PressedEscape()),
        Command.expectExact(ReplaceUrl({ url: "/?pwaislands" }), RevokeActivePreviewUrl()),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        Command.resolve(RevokeActivePreviewUrl, Modal.Message.CompletedRevokeActivePreviewUrl()),
        model((m) => {
          expect(m.maybeAlertBanner).toEqual(Option.none())
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("handles import collision conflict flow and resolution", () => {
      story(
        update,
        given(readyModel),
        message(
          modalMsg(
            Modal.Message.CompletedSelectImportFiles({
              files: [
                { name: "index.html", size: 100, lastModified: 1000 },
                { name: "neu.html", size: 200, lastModified: 1000 },
              ],
            }),
          ),
        ),
        Command.expectNone(),
        model((m) => {
          ModalState.match(m.modalState, {
            ImportConflict: ({ current, suggestedName, resolved }) => {
              expect(current.name).toBe("index.html")
              expect(suggestedName).toBe("index (1).html")
              expect(resolved).toHaveLength(1)
              expect(resolved[0].targetName).toBe("neu.html")
            },
            Closed: () => expect.fail("Expected ImportConflict"),
            Editor: () => expect.fail("Expected ImportConflict"),
            Help: () => expect.fail("Expected ImportConflict"),
          })
        }),
        message(modalMsg(Modal.Message.SelectedImportConflictAction({ action: "rename" }))),
        Command.expectExact(
          WritePendingImportFiles({
            items: [
              { sourceName: "neu.html", targetName: "neu.html", action: "replace" },
              { sourceName: "index.html", targetName: "index (1).html", action: "rename" },
            ],
            subPath: [],
          }),
        ),
        Command.resolve(
          WritePendingImportFiles,
          Modal.Message.CompletedWritePendingImportFiles({
            entries: sampleEntries,
            maybeAlertBanner: Option.none(),
          }),
        ),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("steps through multiple import conflicts and shows remaining queue count", () => {
      const modelWithFiles = {
        ...readyModel,
        storageState: StorageState.Ready({
          storageType: "opfs" as const,
          rootName: "App-Speicher",
          subPath: [],
          entriesState: EntriesState.Loaded({
            entries: [
              {
                id: "file:file1.html",
                name: "file1.html",
                kind: "file" as const,
                maybeSize: Option.some(100),
                maybeLastModified: Option.some(1000),
              },
              {
                id: "file:file2.html",
                name: "file2.html",
                kind: "file" as const,
                maybeSize: Option.some(100),
                maybeLastModified: Option.some(1000),
              },
              {
                id: "file:file3.html",
                name: "file3.html",
                kind: "file" as const,
                maybeSize: Option.some(100),
                maybeLastModified: Option.some(1000),
              },
            ],
          }),
          otherBackend: SavedBackend.Granted({ rootName: "Meine Islands" }),
        }),
      }

      story(
        update,
        given(modelWithFiles),
        message(
          modalMsg(
            Modal.Message.CompletedSelectImportFiles({
              files: [
                { name: "file1.html", size: 100, lastModified: 1000 },
                { name: "file2.html", size: 100, lastModified: 1000 },
                { name: "file3.html", size: 100, lastModified: 1000 },
              ],
            }),
          ),
        ),
        Command.expectNone(),
        model((m) => {
          ModalState.match(m.modalState, {
            ImportConflict: ({ current, queue }) => {
              expect(current.name).toBe("file1.html")
              expect(queue).toHaveLength(2)
            },
            Closed: () => expect.fail("Expected ImportConflict"),
            Editor: () => expect.fail("Expected ImportConflict"),
            Help: () => expect.fail("Expected ImportConflict"),
          })
        }),
        message(modalMsg(Modal.Message.SelectedImportConflictAction({ action: "skip" }))),
        Command.expectNone(),
        model((m) => {
          ModalState.match(m.modalState, {
            ImportConflict: ({ current, queue }) => {
              expect(current.name).toBe("file2.html")
              expect(queue).toHaveLength(1)
            },
            Closed: () => expect.fail("Expected ImportConflict"),
            Editor: () => expect.fail("Expected ImportConflict"),
            Help: () => expect.fail("Expected ImportConflict"),
          })
        }),
        message(modalMsg(Modal.Message.ToggledImportConflictApplyToAll({ applyToAll: true }))),
        Command.expectNone(),
        model((m) => {
          ModalState.match(m.modalState, {
            ImportConflict: ({ applyToAll }) => {
              expect(applyToAll).toBe(true)
            },
            Closed: () => expect.fail("Expected ImportConflict"),
            Editor: () => expect.fail("Expected ImportConflict"),
            Help: () => expect.fail("Expected ImportConflict"),
          })
        }),
        message(modalMsg(Modal.Message.SelectedImportConflictAction({ action: "replace" }))),
        Command.expectExact(
          WritePendingImportFiles({
            items: [
              { sourceName: "file1.html", targetName: "file1.html", action: "skip" },
              { sourceName: "file2.html", targetName: "file2.html", action: "replace" },
              { sourceName: "file3.html", targetName: "file3.html", action: "replace" },
            ],
            subPath: [],
          }),
        ),
        Command.resolve(
          WritePendingImportFiles,
          Modal.Message.CompletedWritePendingImportFiles({
            entries: sampleEntries,
            maybeAlertBanner: Option.none(),
          }),
        ),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("updates only file extension when selecting a template with different extension", () => {
      const modelWithCustomName: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: {
            ...Editor.makeCreateFile(),
            name: "mein-dokument.html",
            content: "",
          },
        }),
      }

      story(
        update,
        given(modelWithCustomName),
        message(editorMsg(Editor.Message.SelectedTemplate({ templateId: "builtin:markdown" }))),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: {
                ...Editor.makeCreateFile(),
                selectedTemplateId: "builtin:markdown",
                name: "mein-dokument.md",
                content: "# Notiz\n\n",
              },
            }),
          )
        }),
      )
    })

    it("opens CreateFile modal and updates URL to ?pwaislands=new when ClickedNewFile", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedNewFile()),
        Command.expectExact(
          PushUrl({ url: "/?pwaislands=new" }),
          FocusModalNameInput(),
          Editor.LoadUserTemplates(),
        ),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        Command.resolve(
          Editor.LoadUserTemplates,
          Editor.Message.CompletedLoadUserTemplates({ templates: [] }),
        ),
        Command.resolve(FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.makeCreateFile(),
            }),
          )
        }),
        message(editorMsg(Editor.Message.ClickedClose())),
        Command.expectExact(ReplaceUrl({ url: "/?pwaislands" }), RevokeActivePreviewUrl()),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        Command.resolve(RevokeActivePreviewUrl, Modal.Message.CompletedRevokeActivePreviewUrl()),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("opens CreateFolder modal and updates URL to ?pwaislands=new-folder when ClickedNewFolder", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedNewFolder()),
        Command.expectExact(PushUrl({ url: "/?pwaislands=new-folder" }), FocusModalNameInput()),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        Command.resolve(FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.Model.CreateFolder({
                name: "Neuer Ordner",
                maybeValidationError: Option.none(),
                maybeAlertBanner: Option.none(),
              }),
            }),
          )
        }),
      )
    })

    it("handles URL change to ?pwaislands=new without clearing loaded entries", () => {
      const newUrl = Option.getOrThrow(fromString("http://localhost:5173/?pwaislands=new"))
      story(
        update,
        given(readyModel),
        message(Message.ChangedUrl({ url: newUrl })),
        Command.expectExact(FocusModalNameInput(), Editor.LoadUserTemplates()),
        Command.resolve(
          Editor.LoadUserTemplates,
          Editor.Message.CompletedLoadUserTemplates({ templates: [] }),
        ),
        Command.resolve(FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Editor({
              editor: Editor.makeCreateFile(),
            }),
          )
          expect(m.storageState).toEqual(readyModel.storageState)
        }),
      )
    })

    describe("storage backend switching", () => {
      it("switches from FSA to OPFS remembering FSA state in otherBackend", () => {
        const opfsEntries: ReadonlyArray<FileEntry> = [
          {
            id: "file:opfs-app.html",
            name: "opfs-app.html",
            kind: "file",
            maybeSize: Option.some(256),
            maybeLastModified: Option.none(),
          },
        ]

        story(
          update,
          given(readyModel),
          message(Message.ClickedUseOpfs()),
          Command.expectExact(
            ActivateOpfsBackend({
              otherBackend: SavedBackend.Granted({ rootName: "Meine Islands" }),
              route: AppRoute.Folder({ subPath: [] }),
            }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(
            ActivateOpfsBackend,
            Message.SucceededActivateOpfsBackend({
              storageType: "opfs",
              rootName: OPFS_APP_FOLDER,
              subPath: [],
              entries: opfsEntries,
              otherBackend: SavedBackend.Granted({ rootName: "Meine Islands" }),
              maybeModalState: Option.none(),
              maybeAlertBanner: Option.none(),
            }),
          ),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.Ready({
                storageType: "opfs",
                rootName: OPFS_APP_FOLDER,
                subPath: [],
                entriesState: EntriesState.Loaded({ entries: opfsEntries }),
                otherBackend: SavedBackend.Granted({ rootName: "Meine Islands" }),
              }),
            )
          }),
        )
      })

      it("switches from OPFS back to FSA directly without file picker when otherBackend is Granted", () => {
        const opfsModel: Model = {
          ...readyModel,
          storageState: StorageState.Ready({
            storageType: "opfs",
            rootName: OPFS_APP_FOLDER,
            subPath: [],
            entriesState: EntriesState.Loaded({ entries: [] }),
            otherBackend: SavedBackend.Granted({ rootName: "Meine Islands" }),
          }),
        }

        story(
          update,
          given(opfsModel),
          message(Message.ClickedUseFsa()),
          Command.expectExact(
            ActivateFsaBackend({
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              route: AppRoute.Folder({ subPath: [] }),
            }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(
            ActivateFsaBackend,
            Message.SucceededActivateFsaBackend({
              storageType: "fsa",
              rootName: "Meine Islands",
              subPath: [],
              entries: sampleEntries,
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              maybeModalState: Option.none(),
              maybeAlertBanner: Option.none(),
            }),
          ),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.Ready({
                storageType: "fsa",
                rootName: "Meine Islands",
                subPath: [],
                entriesState: EntriesState.Loaded({ entries: sampleEntries }),
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              }),
            )
          }),
        )
      })

      it("switches from OPFS to FSA in PermissionRequired when otherBackend requires permission", () => {
        const opfsModel: Model = {
          ...readyModel,
          storageState: StorageState.Ready({
            storageType: "opfs",
            rootName: OPFS_APP_FOLDER,
            subPath: [],
            entriesState: EntriesState.Loaded({ entries: [] }),
            otherBackend: SavedBackend.PermissionRequired({ folderName: "Gespeicherter Ordner" }),
          }),
        }

        story(
          update,
          given(opfsModel),
          message(Message.ClickedUseFsa()),
          Command.expectExact(
            SaveStorageTypePreference({ storageType: "fsa" }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(SaveStorageTypePreference, Message.CompletedSaveStorageTypePreference()),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.PermissionRequired({
                storageType: "fsa",
                folderName: "Gespeicherter Ordner",
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
                pendingRoute: AppRoute.Folder({ subPath: [] }),
              }),
            )
          }),
        )
      })

      it("prompts directory picker when switching to FSA and otherBackend is NoFolderSelected", () => {
        const opfsModel: Model = {
          ...readyModel,
          storageState: StorageState.Ready({
            storageType: "opfs",
            rootName: OPFS_APP_FOLDER,
            subPath: [],
            entriesState: EntriesState.Loaded({ entries: [] }),
            otherBackend: SavedBackend.NoFolderSelected(),
          }),
        }

        story(
          update,
          given(opfsModel),
          message(Message.ClickedUseFsa()),
          Command.expectExact(
            PickLocalDirectory({
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              route: AppRoute.Folder({ subPath: [] }),
            }),
          ),
          Command.resolve(
            PickLocalDirectory,
            Message.SucceededPickLocalDirectory({
              storageType: "fsa",
              rootName: "Neuer Ordner",
              subPath: [],
              entries: sampleEntries,
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              maybeModalState: Option.none(),
              maybeAlertBanner: Option.none(),
            }),
          ),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.Ready({
                storageType: "fsa",
                rootName: "Neuer Ordner",
                subPath: [],
                entriesState: EntriesState.Loaded({ entries: sampleEntries }),
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              }),
            )
          }),
        )
      })

      it("disconnects FSA and sets NoFolderSelected while remembering OPFS Granted", () => {
        story(
          update,
          given(readyModel),
          message(Message.ClickedDisconnectFolder()),
          Command.expectExact(
            DisconnectStorage({
              hasOPFS: true,
            }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(
            DisconnectStorage,
            Message.SucceededDisconnectStorage({
              storageType: "fsa",
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              pendingRoute: AppRoute.Folder({ subPath: [] }),
            }),
          ),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.NoFolderSelected({
                storageType: "fsa",
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
                pendingRoute: AppRoute.Folder({ subPath: [] }),
              }),
            )
          }),
        )
      })

      it("picks, switches, and disconnects folder in Tauri mode similar to FSA", () => {
        const tauriNoFolderModel: Model = {
          ...readyModel,
          hasDirectoryPicker: false,
          hasTauri: true,
          storageState: StorageState.NoFolderSelected({
            storageType: "tauri",
            otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
            pendingRoute: AppRoute.Folder({ subPath: [] }),
          }),
        }

        story(
          update,
          given(tauriNoFolderModel),
          message(Message.ClickedSelectFolder()),
          Command.expectExact(
            PickLocalDirectory({
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              route: AppRoute.Folder({ subPath: [] }),
            }),
          ),
          Command.resolve(
            PickLocalDirectory,
            Message.SucceededPickLocalDirectory({
              storageType: "tauri",
              rootName: "Tauri-Projekte",
              subPath: [],
              entries: sampleEntries,
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              maybeModalState: Option.none(),
              maybeAlertBanner: Option.none(),
            }),
          ),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.Ready({
                storageType: "tauri",
                rootName: "Tauri-Projekte",
                subPath: [],
                entriesState: EntriesState.Loaded({ entries: sampleEntries }),
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              }),
            )
          }),
          message(Message.ClickedUseOpfs()),
          Command.expectExact(
            ActivateOpfsBackend({
              otherBackend: SavedBackend.Granted({ rootName: "Tauri-Projekte" }),
              route: AppRoute.Folder({ subPath: [] }),
            }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(
            ActivateOpfsBackend,
            Message.SucceededActivateOpfsBackend({
              storageType: "opfs",
              rootName: OPFS_APP_FOLDER,
              subPath: [],
              entries: [],
              otherBackend: SavedBackend.Granted({ rootName: "Tauri-Projekte" }),
              maybeModalState: Option.none(),
              maybeAlertBanner: Option.none(),
            }),
          ),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          message(Message.ClickedUseFsa()),
          Command.expectExact(
            ActivateFsaBackend({
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              route: AppRoute.Folder({ subPath: [] }),
            }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(
            ActivateFsaBackend,
            Message.SucceededActivateFsaBackend({
              storageType: "tauri",
              rootName: "Tauri-Projekte",
              subPath: [],
              entries: sampleEntries,
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              maybeModalState: Option.none(),
              maybeAlertBanner: Option.none(),
            }),
          ),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          message(Message.ClickedDisconnectFolder()),
          Command.expectExact(
            DisconnectStorage({
              hasOPFS: true,
            }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(
            DisconnectStorage,
            Message.SucceededDisconnectStorage({
              storageType: "tauri",
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              pendingRoute: AppRoute.Folder({ subPath: [] }),
            }),
          ),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.NoFolderSelected({
                storageType: "tauri",
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
                pendingRoute: AppRoute.Folder({ subPath: [] }),
              }),
            )
          }),
        )
      })
      it("updates isWindowFocused when window focus changes", () => {
        story(
          update,
          given(readyModel),
          message(Message.ChangedWindowFocus({ isFocused: false })),
          model((m) => {
            expect(m.isWindowFocused).toBe(false)
          }),
          message(Message.ChangedWindowFocus({ isFocused: true })),
          model((m) => {
            expect(m.isWindowFocused).toBe(true)
          }),
        )
      })
      it("updates isWindowMaximized and handles window control messages", () => {
        story(
          update,
          given(readyModel),
          message(Message.ChangedWindowMaximized({ isMaximized: true })),
          model((m) => {
            expect(m.isWindowMaximized).toBe(true)
          }),
          message(Message.ChangedWindowMaximized({ isMaximized: false })),
          model((m) => {
            expect(m.isWindowMaximized).toBe(false)
          }),
          message(Message.ClickedMinimizeWindow()),
          Command.expectExact(MinimizeWindow()),
          Command.resolve(MinimizeWindow, Message.CompletedMinimizeWindow()),
          message(Message.ClickedToggleMaximizeWindow()),
          Command.expectExact(ToggleMaximizeWindow()),
          Command.resolve(ToggleMaximizeWindow, Message.CompletedToggleMaximizeWindow()),
          message(Message.ClickedToggleFullscreen()),
          Command.expectExact(ToggleFullscreenWindow()),
          Command.resolve(ToggleFullscreenWindow, Message.CompletedToggleFullscreen()),
          message(Message.ChangedWindowFullscreen({ isFullscreen: true })),
          model((m) => {
            expect(m.isWindowFullscreen).toBe(true)
          }),
          message(Message.PressedEscape()),
          Command.expectExact(ExitFullscreenWindow()),
          Command.resolve(ExitFullscreenWindow, Message.CompletedToggleFullscreen()),
          message(Message.ChangedWindowFullscreen({ isFullscreen: false })),
          model((m) => {
            expect(m.isWindowFullscreen).toBe(false)
          }),
          message(Message.ClickedCloseWindow()),
          Command.expectExact(CloseWindow()),
          Command.resolve(CloseWindow, Message.CompletedCloseWindow()),
        )
      })
    })
  })

  describe("LLM-Einstellungen", () => {
    it("toggles streaming, tests LLM connection with streaming flag, and saves settings", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedOpenSettingsDialog()),
        Command.expectNone(),
        message(Message.ToggledLlmEnabled({ isChecked: true })),
        Command.expectNone(),
        message(Message.UpdatedLlmBaseUrl({ value: "https://api.example.com/v1" })),
        Command.expectNone(),
        message(Message.UpdatedLlmModels({ value: "gpt-4o-mini" })),
        Command.expectNone(),
        message(Message.SelectedLlmModel({ value: "gpt-4o-mini" })),
        Command.expectNone(),
        message(Message.ToggledLlmStreaming({ isChecked: false })),
        Command.expectNone(),
        message(Message.ToggledLlmToolCalls({ isChecked: false })),
        Command.expectNone(),
        message(Message.SelectedLlmThinkingPreset({ presetId: "qwen-template" })),
        Command.expectNone(),
        message(Message.UpdatedLlmThinkingLevel({ value: "false" })),
        Command.expectNone(),
        message(Message.UpdatedLlmExtraArgs({ value: '{"temperature": 0.2}' })),
        Command.expectNone(),
        model((m) => {
          expect(m.llmDraftModels).toBe("gpt-4o-mini")
          expect(m.llmDraftModel).toBe("gpt-4o-mini")
          expect(m.llmDraftStreaming).toBe(false)
          expect(m.llmDraftToolCalls).toBe(false)
          expect(m.llmDraftThinkingParam).toBe("chat_template_kwargs.enable_thinking")
          expect(m.llmDraftThinkingLevels).toBe("Aus=false, An=true")
          expect(m.llmDraftThinkingLevel).toBe("false")
          expect(m.llmDraftExtraArgs).toBe('{"temperature": 0.2}')
          expect(m.llmTestState).toEqual(LlmTestState.Idle())
        }),
        message(Message.ClickedTestLlm({ mode: "chat" })),
        Command.expectExact(
          TestLlm({
            mode: "chat",
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "gpt-4o-mini",
            streaming: false,
            toolCalls: false,
            thinkingParam: "chat_template_kwargs.enable_thinking",
            thinkingLevels: "Aus=false, An=true",
            extraArgs: '{"temperature": 0.2}',
            model: "gpt-4o-mini",
            thinkingLevel: "false",
          }),
        ),
        Command.resolve(
          TestLlm,
          Message.SucceededTestLlm({ content: "ok", reasoning: "Denke...", models: [] }),
        ),
        model((m) => {
          expect(m.llmTestState).toEqual(
            LlmTestState.Succeeded({ content: "ok", reasoning: "Denke...", models: [] }),
          )
        }),
        message(Message.ClickedSaveSettingsDialog()),
        Command.expectExact(
          SaveLlmSettings({
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "gpt-4o-mini",
            streaming: false,
            toolCalls: false,
            thinkingParam: "chat_template_kwargs.enable_thinking",
            thinkingLevels: "Aus=false, An=true",
            extraArgs: '{"temperature": 0.2}',
          }),
          SaveEditorPreferences({
            isMaximized: false,
            llmBarMode: "Closed",
            llmModel: "gpt-4o-mini",
            llmThinkingLevel: "false",
            editorSplitPercent: 62,
          }),
        ),
        Command.resolve(SaveLlmSettings, Message.CompletedSaveLlmSettings()),
        Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
        model((m) => {
          expect(m.llmStreaming).toBe(false)
          expect(m.llmToolCalls).toBe(false)
          expect(m.llmModels).toBe("gpt-4o-mini")
          expect(m.llmModel).toBe("gpt-4o-mini")
          expect(m.llmThinkingParam).toBe("chat_template_kwargs.enable_thinking")
          expect(m.llmThinkingLevels).toBe("Aus=false, An=true")
          expect(m.llmThinkingLevel).toBe("false")
          expect(m.llmExtraArgs).toBe('{"temperature": 0.2}')
          expect(m.isSettingsDialogOpen).toBe(false)
        }),
      )
    })

    it("aktualisiert LlmTestState.Streaming schrittweise bei aktiviertem Streaming", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedOpenSettingsDialog()),
        Command.expectNone(),
        message(Message.ToggledLlmEnabled({ isChecked: true })),
        Command.expectNone(),
        message(Message.UpdatedLlmBaseUrl({ value: "https://api.example.com/v1" })),
        Command.expectNone(),
        message(Message.UpdatedLlmModels({ value: "gpt-4o-mini" })),
        Command.expectNone(),
        message(Message.ClickedTestLlm({ mode: "chat" })),
        Command.expectNone(),
        model((m) => {
          expect(m.llmTestState).toEqual(
            LlmTestState.Streaming({ mode: "chat", content: "", reasoning: "" }),
          )
        }),
        message(Message.UpdatedTestLlmStream({ content: "", reasoning: "Denke " })),
        Command.expectNone(),
        message(Message.UpdatedTestLlmStream({ content: "ok", reasoning: "Denke " })),
        Command.expectNone(),
        model((m) => {
          expect(m.llmTestState).toEqual(
            LlmTestState.Streaming({ mode: "chat", content: "ok", reasoning: "Denke " }),
          )
        }),
        message(Message.SucceededTestLlm({ content: "ok", reasoning: "Denke", models: [] })),
        Command.expectNone(),
        model((m) => {
          expect(m.llmTestState).toEqual(
            LlmTestState.Succeeded({ content: "ok", reasoning: "Denke", models: [] }),
          )
        }),
      )
    })

    it("übernimmt nach Liste testen automatisch das erste gefundene Modell für Chat und Tools", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedOpenSettingsDialog()),
        Command.expectNone(),
        message(Message.ToggledLlmEnabled({ isChecked: true })),
        Command.expectNone(),
        message(Message.UpdatedLlmBaseUrl({ value: "https://api.example.com/v1" })),
        Command.expectNone(),
        message(Message.ClickedTestLlm({ mode: "models" })),
        Command.expectExact(
          TestLlm({
            mode: "models",
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "",
            streaming: true,
            toolCalls: true,
            thinkingParam: "",
            thinkingLevels: "",
            extraArgs: "",
            model: "",
            thinkingLevel: "",
          }),
        ),
        Command.resolve(
          TestLlm,
          Message.SucceededTestLlm({ content: "", reasoning: "", models: ["qwen3", "gpt-4o"] }),
        ),
        model((m) => {
          expect(m.llmDiscoveredModels).toEqual(["qwen3", "gpt-4o"])
          expect(m.llmDraftModel).toBe("qwen3")
        }),
        message(Message.ClickedTestLlm({ mode: "chat" })),
        Command.expectNone(),
        model((m) => {
          expect(m.llmTestState).toEqual(
            LlmTestState.Streaming({ mode: "chat", content: "", reasoning: "" }),
          )
        }),
        message(Message.ClickedTestLlm({ mode: "tools" })),
        Command.expectNone(),
        model((m) => {
          expect(m.llmTestState).toEqual(
            LlmTestState.Streaming({ mode: "tools", content: "", reasoning: "" }),
          )
        }),
      )
    })

    it("lädt Modelle einmalig beim ersten Öffnen des Editors, wenn keine fest eingetragen sind", () => {
      const modelWithoutFixedModels: Model = {
        ...readyModel,
        llmEnabled: true,
        llmBaseUrl: "https://api.example.com/v1",
        llmModels: "",
        llmDiscoveredModels: [],
      }

      story(
        update,
        given(modelWithoutFixedModels),
        message(Message.ClickedNewFile()),
        Command.expectExact(
          PushUrl({ url: "/?pwaislands=new" }),
          Modal.FocusModalNameInput(),
          Modal.LoadEditorUserTemplates,
          LoadEditorLlmModels({
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "",
            streaming: true,
            toolCalls: true,
            thinkingParam: "",
            thinkingLevels: "",
            extraArgs: "",
          }),
        ),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        Command.resolve(Modal.FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()),
        Command.resolve(
          Editor.LoadUserTemplates,
          Editor.Message.CompletedLoadUserTemplates({ templates: [] }),
        ),
        Command.resolve(
          LoadEditorLlmModels,
          Message.SucceededLoadEditorLlmModels({ models: ["qwen3", "gpt-4o"] }),
        ),
        model((m) => {
          expect(m.hasLoadedEditorLlmModels).toBe(true)
          expect(m.llmDiscoveredModels).toEqual(["qwen3", "gpt-4o"])
          expect(m.llmModel).toBe("qwen3")
        }),
        message(Message.ClickedNewFile()),
        Command.expectExact(
          PushUrl({ url: "/?pwaislands=new" }),
          Modal.FocusModalNameInput(),
          Modal.LoadEditorUserTemplates,
        ),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        Command.resolve(Modal.FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()),
        Command.resolve(
          Editor.LoadUserTemplates,
          Editor.Message.CompletedLoadUserTemplates({ templates: [] }),
        ),
      )
    })

    it("lädt Modelle auch wenn CompletedLoadLlmSettings erst nach Öffnen des Editors eintrifft, und übernimmt gespeicherte Editor-Präferenzen", () => {
      const modelWithOpenEditor: Model = {
        ...readyModel,
        modalState: ModalState.Editor({
          editor: Editor.makeCreateFile(),
        }),
      }

      story(
        update,
        given(modelWithOpenEditor),
        message(
          Message.CompletedLoadEditorPreferences({
            isMaximized: true,
            llmBarMode: "Chat",
            llmModel: "qwen3",
            llmThinkingLevel: "high",
            editorSplitPercent: 55,
          }),
        ),
        model((m) => {
          expect(m.editorIsMaximized).toBe(true)
          expect(m.editorLlmBarMode).toBe("Chat")
          expect(m.llmModel).toBe("qwen3")
          expect(m.llmThinkingLevel).toBe("high")
        }),
        message(
          Message.CompletedLoadLlmSettings({
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "",
            streaming: true,
            toolCalls: true,
            thinkingParam: "reasoning_effort",
            thinkingLevels: "low, high",
            extraArgs: "",
          }),
        ),
        Command.expectExact(
          LoadEditorLlmModels({
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "",
            streaming: true,
            toolCalls: true,
            thinkingParam: "reasoning_effort",
            thinkingLevels: "low, high",
            extraArgs: "",
          }),
        ),
        Command.resolve(
          LoadEditorLlmModels,
          Message.SucceededLoadEditorLlmModels({ models: ["qwen3", "gpt-4o"] }),
        ),
      )
    })

    it("übernimmt gespeichertes isMaximized und llmBarMode und lädt Modelle auch wenn SucceededInitializeStorage nach CompletedLoadEditorPreferences und CompletedLoadLlmSettings eintrifft", () => {
      story(
        update,
        given(readyModel),
        message(
          Message.CompletedLoadLlmSettings({
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "",
            streaming: true,
            toolCalls: true,
            thinkingParam: "reasoning_effort",
            thinkingLevels: "low, high",
            extraArgs: "",
          }),
        ),
        message(
          Message.CompletedLoadEditorPreferences({
            isMaximized: true,
            llmBarMode: "Copy",
            llmModel: "",
            llmThinkingLevel: "",
            editorSplitPercent: 70,
          }),
        ),
        message(
          Message.SucceededInitializeStorage({
            storageType: "opfs",
            rootName: "Browser-Speicher",
            subPath: [],
            entries: [],
            otherBackend: SavedBackend.NoFolderSelected(),
            maybeModalState: Option.some(
              ModalState.Editor({
                editor: Editor.Model.EditFile({
                  originalName: "index.html",
                  name: "index.html",
                  fileMode: Editor.EditorFileMode.Text({ content: "<h1>Hi</h1>" }),
                  maybeValidationError: Option.none(),
                  maybeAlertBanner: Option.none(),
                  maybePasteError: Option.none(),
                  llmBarMode: "Closed",
                  llmChatInput: "",
                  llmChatMessages: [],
                  llmChatDisplay: [],
                  llmChatState: Editor.LlmChatState.Idle(),
                  isMaximized: false,
                  isEditingName: false,
                  isPreviewOpen: false,
                  editorSplitPercent: 62,
                  editorSplitDrag: Option.none(),
                  undoStack: [],
                  redoStack: [],
                  maybeOpfsHistoryCursor: Option.none(),
                  historyState: Editor.HistoryState.Closed(),
                }),
              }),
            ),
            maybeAlertBanner: Option.none(),
          }),
        ),
        Command.resolve(Modal.FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()),
        Command.expectExact(
          LoadEditorLlmModels({
            enabled: true,
            editFormat: "hashline",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "",
            streaming: true,
            toolCalls: true,
            thinkingParam: "reasoning_effort",
            thinkingLevels: "low, high",
            extraArgs: "",
          }),
        ),
        Command.resolve(
          LoadEditorLlmModels,
          Message.SucceededLoadEditorLlmModels({ models: ["qwen3", "gpt-4o"] }),
        ),
        model((m) => {
          expect(m.modalState._tag).toBe("Editor")
          if (m.modalState._tag === "Editor") {
            expect(m.modalState.editor._tag).toBe("EditFile")
            if (m.modalState.editor._tag === "EditFile") {
              expect(m.modalState.editor.isMaximized).toBe(true)
              expect(m.modalState.editor.llmBarMode).toBe("Copy")
              expect(m.modalState.editor.editorSplitPercent).toBe(70)
            }
          }
          expect(m.llmDiscoveredModels).toEqual(["qwen3", "gpt-4o"])
        }),
      )
    })

    it("merkt sich die angepasste Editor-Breite beim Ziehen des Trennbalkens", () => {
      const editorModel = Editor.makeCreateFile([], {
        isMaximized: true,
        llmBarMode: "Chat",
        editorSplitPercent: 62,
      })

      story(
        (m: Editor.Model, msg: Editor.Message) =>
          Editor.update(m, msg, {
            subPath: [],
            existingEntries: [],
            llmEnabled: true,
            llmEditFormat: "hashline",
          }),
        given(editorModel),
        message(Editor.Message.StartedResizeEditorSplit({ startScreenX: 620, pointerId: 1 })),
        Command.resolve(
          Editor.StartEditorSplitDrag,
          Editor.Message.MeasuredEditorSplitDrag({ startWidthPx: 620, containerWidthPx: 1000 }),
        ),
        message(Editor.Message.MovedResizeEditorSplit({ screenX: 500 })),
        model((m) => {
          expect(m._tag).toBe("CreateFile")
          if (m._tag === "CreateFile") {
            expect(m.editorSplitPercent).toBe(50)
          }
        }),
        message(Editor.Message.EndedResizeEditorSplit()),
      )

      const modelWithResizedEditor = modifyFields(readyModel, {
        modalState: () =>
          ModalState.Editor({
            editor: Editor.makeCreateFile([], {
              isMaximized: true,
              llmBarMode: "Chat",
              editorSplitPercent: 50,
            }),
          }),
        editorIsMaximized: () => true,
        editorLlmBarMode: () => "Chat",
      })

      story(
        update,
        given(modelWithResizedEditor),
        message(
          Message.GotModalMessage({
            message: Modal.Message.GotEditorMessage({
              message: Editor.Message.EndedResizeEditorSplit(),
            }),
          }),
        ),
        Command.expectExact(
          SaveEditorPreferences({
            isMaximized: true,
            llmBarMode: "Chat",
            llmModel: "",
            llmThinkingLevel: "",
            editorSplitPercent: 50,
          }),
        ),
        Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
        model((m) => {
          expect(m.editorSplitPercent).toBe(50)
        }),
      )
    })
  })
})
