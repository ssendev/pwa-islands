import { Option } from "effect"
import * as Scene from "foldkit/scene"
import * as Story from "foldkit/story"
import { describe, expect, it } from "vitest"
import {
  CopyApiDtsToClipboard,
  DelayResetCopyDtsStatus,
  FocusModalNameInput,
  LoadFileInfoPreference,
  LoadModalBase64,
  NavigateToSubfolder,
  SaveFileInfoPreference,
  SaveModalChanges,
  SyncHistoryUrl,
} from "./command"
import { Message, init, update, view } from "./main"
import {
  CopyDtsState,
  EditorFileMode,
  EntriesState,
  type FileEntry,
  type Model,
  ModalState,
  PreviewContent,
  StorageState,
} from "./model"

const sampleEntries: ReadonlyArray<FileEntry> = [
  {
    name: "projekte",
    kind: "directory",
    maybeSize: Option.none(),
    maybeLastModified: Option.none(),
  },
  {
    name: "index.html",
    kind: "file",
    maybeSize: Option.some(512),
    maybeLastModified: Option.some(1_700_000_000_000),
  },
]

const readyModel: Model = {
  hasDirectoryPicker: true,
  hasOPFS: true,
  storageState: StorageState.Ready({
    storageType: "fsa",
    rootName: "Meine Islands",
    subPath: [],
    isFallback: false,
    entriesState: EntriesState.Loaded({ entries: sampleEntries }),
  }),
  showFileInfo: true,
  isSettingsOpen: false,
  canInstallApp: false,
  modalState: ModalState.Closed(),
  maybeAlertBanner: Option.none(),
}

describe("PWA Islands Foldkit App", () => {
  describe("init", () => {
    it("transitions to Unsupported when neither FSA nor OPFS is supported", () => {
      const result = init({
        hasDirectoryPicker: false,
        hasOPFS: false,
        initialPathname: "/",
        initialSearch: "",
      })

      expect(result.model.storageState._tag).toBe("Unsupported")
      expect(Option.isSome(result.model.maybeAlertBanner)).toBe(true)
      expect(result.commands).toBeUndefined()
    })

    it("starts Initializing and opens Help modal when ?pwaislands=help-fs is present", () => {
      const result = init({
        hasDirectoryPicker: true,
        hasOPFS: true,
        initialPathname: "/",
        initialSearch: "?pwaislands=help-fs",
      })

      expect(result.model.storageState._tag).toBe("Initializing")
      expect(result.model.modalState).toEqual(
        ModalState.Help({
          isApiOpen: false,
          isFsOpen: true,
          copyDtsState: CopyDtsState.Idle(),
        }),
      )
      expect(result.commands).toHaveLength(2)
    })
  })

  describe("update (Story)", () => {
    it("loads file info preference and completes storage initialization", () => {
      const initial = init({
        hasDirectoryPicker: true,
        hasOPFS: true,
        initialPathname: "/",
        initialSearch: "",
      })

      Story.story(
        update,
        Story.given(initial.model),
        Story.message(Message.LoadedFileInfoPreference({ visible: false })),
        Story.model((model) => {
          expect(model.showFileInfo).toBe(false)
        }),
        Story.message(
          Message.CompletedStorageInit({
            storageType: Option.some("fsa"),
            rootName: "TestOrdner",
            subPath: [],
            isFallback: false,
            entries: sampleEntries,
            maybeModalState: Option.none(),
            maybeAlertBanner: Option.none(),
          }),
        ),
        Story.Command.expectNone(),
        Story.model((model) => {
          expect(model.storageState).toEqual(
            StorageState.Ready({
              storageType: "fsa",
              rootName: "TestOrdner",
              subPath: [],
              isFallback: false,
              entriesState: EntriesState.Loaded({ entries: sampleEntries }),
            }),
          )
        }),
      )
    })

    it("navigates into a directory when a directory row is clicked", () => {
      const subEntries: ReadonlyArray<FileEntry> = [
        {
          name: "app.html",
          kind: "file",
          maybeSize: Option.some(128),
          maybeLastModified: Option.none(),
        },
      ]

      Story.story(
        update,
        Story.given(readyModel),
        Story.message(Message.ClickedEntryRow({ entry: sampleEntries[0] })),
        Story.Command.expectExact(NavigateToSubfolder({ targetSubPath: ["projekte"] })),
        Story.Command.resolve(
          NavigateToSubfolder,
          Message.SucceededListEntries({
            subPath: ["projekte"],
            entries: subEntries,
          }),
        ),
        Story.model((model) => {
          expect(model.storageState).toEqual(
            StorageState.Ready({
              storageType: "fsa",
              rootName: "Meine Islands",
              subPath: ["projekte"],
              isFallback: false,
              entriesState: EntriesState.Loaded({ entries: subEntries }),
            }),
          )
        }),
      )
    })

    it("toggles file info visibility and persists preference", () => {
      Story.story(
        update,
        Story.given(readyModel),
        Story.message(Message.ClickedToggleFileInfo()),
        Story.Command.expectExact(SaveFileInfoPreference({ visible: false })),
        Story.Command.resolve(SaveFileInfoPreference, Message.SavedFileInfoPreference()),
        Story.model((model) => {
          expect(model.showFileInfo).toBe(false)
          expect(model.isSettingsOpen).toBe(false)
        }),
      )
    })

    it("handles copying /api.d.ts in the Help modal", () => {
      Story.story(
        update,
        Story.given(readyModel),
        Story.message(Message.ClickedOpenHelp()),
        Story.Command.expectExact(
          SyncHistoryUrl({
            mode: "push",
            url: "/?pwaislands=help-api",
            revokePreview: true,
          }),
        ),
        Story.Command.resolve(SyncHistoryUrl, Message.CompletedHistorySync()),
        Story.message(Message.ClickedCopyDts()),
        Story.model((model) => {
          expect(model.modalState).toEqual(
            ModalState.Help({
              isApiOpen: true,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Copying(),
            }),
          )
        }),
        Story.Command.expectExact(CopyApiDtsToClipboard()),
        Story.Command.resolve(CopyApiDtsToClipboard, Message.SucceededCopyDts()),
        Story.model((model) => {
          expect(model.modalState).toEqual(
            ModalState.Help({
              isApiOpen: true,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Copied(),
            }),
          )
        }),
        Story.Command.expectExact(DelayResetCopyDtsStatus()),
        Story.Command.resolve(DelayResetCopyDtsStatus, Message.ResetCopyDtsStatus()),
        Story.model((model) => {
          expect(model.modalState).toEqual(
            ModalState.Help({
              isApiOpen: true,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Idle(),
            }),
          )
        }),
      )
    })
  })

  describe("view & interactions (Scene)", () => {
    it("creates a new file through the modal UI and updates the table", () => {
      const updatedEntries: ReadonlyArray<FileEntry> = [
        ...sampleEntries,
        {
          name: "hallo.html",
          kind: "file",
          maybeSize: Option.some(24),
          maybeLastModified: Option.none(),
        },
      ]

      Scene.scene(
        { update, view },
        Scene.given(readyModel),
        Scene.expect(Scene.selector("#folder-name-display")).toContainText("PWA Islands"),
        Scene.expect(Scene.text("index.html")).toExist(),
        Scene.click(Scene.selector("#btn-new-file")),
        Scene.Command.resolveAll(
          [SyncHistoryUrl, Message.CompletedHistorySync()],
          [FocusModalNameInput, Message.CompletedHistorySync()],
        ),
        Scene.expect(Scene.selector(".modal-title")).toHaveText("Neue Datei erstellen"),
        Scene.type(Scene.selector("#modal-file-name"), "hallo.html"),
        Scene.type(Scene.selector("#modal-file-content"), "<h1>Hallo Welt</h1>"),
        Scene.click(Scene.selector("#modal-btn-save")),
        Scene.Command.resolve(
          SaveModalChanges,
          Message.SucceededModalMutation({ entries: updatedEntries }),
        ),
        Scene.expect(Scene.selector(".modal-overlay")).toBeAbsent(),
        Scene.expect(Scene.text("hallo.html")).toExist(),
      )
    })

    it("hides binary preview when checking Binärdatei bearbeiten", () => {
      const binaryModel: Model = {
        ...readyModel,
        modalState: ModalState.EditFile({
          originalName: "bild.png",
          name: "bild.png",
          fileMode: EditorFileMode.Binary({
            lockReason: "Binärdatei",
            canEditBase64: true,
            isBase64Enabled: false,
            base64Content: "",
            isLoadingBase64: false,
            preview: PreviewContent.Image({ objectUrl: "blob:preview-url", name: "bild.png" }),
          }),
        }),
      }

      Scene.scene(
        { update, view },
        Scene.given(binaryModel),
        Scene.expect(Scene.selector("#modal-file-preview")).toExist(),
        Scene.expect(Scene.selector("#modal-base64-editor")).toBeAbsent(),
        Scene.change(Scene.selector("#modal-use-base64"), "true"),
        Scene.Command.expectExact(LoadModalBase64({ entryName: "bild.png" })),
        Scene.Command.resolve(
          LoadModalBase64,
          Message.LoadedModalBase64Content({ base64Content: "iVBORw0KGgo=" }),
        ),
        Scene.expect(Scene.selector("#modal-base64-editor")).toExist(),
        Scene.expect(Scene.selector("#modal-file-preview")).toBeAbsent(),
        Scene.change(Scene.selector("#modal-use-base64"), "false"),
        Scene.expect(Scene.selector("#modal-base64-editor")).toBeAbsent(),
        Scene.expect(Scene.selector("#modal-file-preview")).toExist(),
      )
    })
  })

  // Keep LoadFileInfoPreference referenced so unused import never triggers if refactored
  it("exposes LoadFileInfoPreference command definition", () => {
    expect(LoadFileInfoPreference.name).toBe("LoadFileInfoPreference")
  })
})
