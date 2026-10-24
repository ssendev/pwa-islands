import { Option } from "effect"
import { Command, given, message, model, story } from "foldkit/story"
import { fromString } from "foldkit/url"
import { describe, expect, it } from "vitest"
import {
  CopyApiDtsToClipboard,
  DeleteModalEntry,
  NavigateToSubfolder,
  PushUrl,
  ReplaceUrl,
  SaveFileInfoPreference,
  SaveModalChanges,
  WaitBeforeResetCopyDts,
  WritePendingImportFiles,
} from "./command"
import { Message, init, update } from "./main"
import {
  CopyDtsState,
  EditorFileMode,
  EntriesState,
  type FileEntry,
  InstallPrompt,
  type Model,
  ModalState,
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
  origin: "http://localhost:5173",
  storageState: StorageState.Ready({
    storageType: "fsa",
    rootName: "Meine Islands",
    subPath: [],
    isFallback: false,
    entriesState: EntriesState.Loaded({ entries: sampleEntries }),
  }),
  showFileInfo: true,
  isSettingsOpen: false,
  installPrompt: InstallPrompt.Unavailable(),
  modalState: ModalState.Closed(),
  maybeAlertBanner: Option.none(),
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
          origin: "http://localhost:5173",
        },
        rootUrl,
      )

      expect(result.model.storageState._tag).toBe("Unsupported")
      expect(Option.isSome(result.model.maybeAlertBanner)).toBe(true)
      expect(result.commands).toBeUndefined()
    })

    it("starts Initializing and opens Help modal when ?pwaislands=help-fs is present", () => {
      const result = init(
        {
          hasDirectoryPicker: true,
          hasOPFS: true,
          origin: "http://localhost:5173",
        },
        helpFsUrl,
      )

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

  describe("update flows", () => {
    it("loads file info preference and completes storage initialization", () => {
      const initial = init(
        {
          hasDirectoryPicker: true,
          hasOPFS: true,
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
            isFallback: false,
            entries: sampleEntries,
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
              isFallback: false,
              entriesState: EntriesState.Loaded({ entries: sampleEntries }),
            }),
          )
        }),
      )
    })

    it("navigates into directory via PushUrl and ChangedUrl", () => {
      const subEntries: ReadonlyArray<FileEntry> = [
        {
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
          Message.SucceededListEntries({
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
              isFallback: false,
              entriesState: EntriesState.Loaded({ entries: subEntries }),
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

    it("handles copying /api.d.ts in the Help modal", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedOpenHelp()),
        Command.expectExact(PushUrl({ url: "/?pwaislands=help-api" })),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        message(Message.ClickedCopyDts()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              isApiOpen: true,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Copying(),
            }),
          )
        }),
        Command.expectExact(CopyApiDtsToClipboard()),
        Command.resolve(CopyApiDtsToClipboard, Message.SucceededCopyDts()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              isApiOpen: true,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Copied(),
            }),
          )
        }),
        Command.expectExact(WaitBeforeResetCopyDts()),
        Command.resolve(WaitBeforeResetCopyDts, Message.CompletedWaitBeforeResetCopyDts()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              isApiOpen: true,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Idle(),
            }),
          )
        }),
      )
    })

    it("validates empty name and slash in folder name", () => {
      const modelWithNewFolder: Model = {
        ...readyModel,
        modalState: ModalState.CreateFolder({
          name: "",
          maybeValidationError: Option.none(),
        }),
      }

      story(
        update,
        given(modelWithNewFolder),
        message(Message.ClickedSaveModal()),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.CreateFolder({
              name: "",
              maybeValidationError: Option.some("Bitte geben Sie einen Ordnernamen ein."),
            }),
          )
        }),
        message(Message.UpdatedModalName({ name: "sub/folder" })),
        message(Message.ClickedSaveModal()),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.CreateFolder({
              name: "sub/folder",
              maybeValidationError: Option.some(
                "Der Ordnername darf keine Schrägstriche enthalten.",
              ),
            }),
          )
        }),
      )
    })

    it("validates duplicate folder name", () => {
      const modelWithDuplicateFolder: Model = {
        ...readyModel,
        modalState: ModalState.CreateFolder({
          name: "projekte",
          maybeValidationError: Option.none(),
        }),
      }

      story(
        update,
        given(modelWithDuplicateFolder),
        message(Message.ClickedSaveModal()),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.CreateFolder({
              name: "projekte",
              maybeValidationError: Option.some(
                'Ein Eintrag mit dem Namen "projekte" existiert bereits.',
              ),
            }),
          )
        }),
      )
    })

    it("prompts overwrite confirmation when creating a file with existing name", () => {
      const modelWithDuplicateFile: Model = {
        ...readyModel,
        modalState: ModalState.CreateFile({
          name: "index.html",
          content: "<p>New</p>",
          maybeValidationError: Option.none(),
        }),
      }

      story(
        update,
        given(modelWithDuplicateFile),
        message(Message.ClickedSaveModal()),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.ConfirmOverwrite({
              targetName: "index.html",
              originalName: "index.html",
              content: "<p>New</p>",
              isBase64: false,
              isEditing: false,
            }),
          )
        }),
        message(Message.ClickedConfirmOverwrite()),
        Command.expectExact(
          SaveModalChanges({
            modalState: ModalState.ConfirmOverwrite({
              targetName: "index.html",
              originalName: "index.html",
              content: "<p>New</p>",
              isBase64: false,
              isEditing: false,
            }),
            subPath: [],
          }),
        ),
        Command.resolve(
          SaveModalChanges,
          Message.SucceededModalMutation({ entries: sampleEntries }),
        ),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("prompts delete confirmation and deletes modal entry", () => {
      const modelWithEditFile: Model = {
        ...readyModel,
        modalState: ModalState.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: "<p>Hello</p>" }),
          maybeValidationError: Option.none(),
        }),
      }

      story(
        update,
        given(modelWithEditFile),
        message(Message.ClickedDeleteModalEntry()),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.ConfirmDelete({
              entryName: "index.html",
              isFolder: false,
            }),
          )
        }),
        message(Message.ConfirmedDeleteModalEntry()),
        Command.expectExact(
          DeleteModalEntry({
            entryName: "index.html",
            isFolder: false,
            subPath: [],
          }),
        ),
        Command.resolve(DeleteModalEntry, Message.SucceededModalMutation({ entries: [] })),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })

    it("handles import collision conflict flow and resolution", () => {
      story(
        update,
        given(readyModel),
        message(
          Message.SelectedImportFiles({
            files: [
              { name: "index.html", size: 100, lastModified: 1000 },
              { name: "neu.html", size: 200, lastModified: 1000 },
            ],
          }),
        ),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState._tag).toBe("ImportConflict")
          if (m.modalState._tag === "ImportConflict") {
            expect(m.modalState.current.name).toBe("index.html")
            expect(m.modalState.suggestedName).toBe("index (1).html")
            expect(m.modalState.resolved).toHaveLength(1)
            expect(m.modalState.resolved[0].targetName).toBe("neu.html")
          }
        }),
        message(Message.SelectedImportConflictAction({ action: "rename" })),
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
          Message.CompletedImportFiles({
            entries: sampleEntries,
            maybeAlertBanner: Option.none(),
          }),
        ),
        model((m) => {
          expect(m.modalState).toEqual(ModalState.Closed())
        }),
      )
    })
  })
})
