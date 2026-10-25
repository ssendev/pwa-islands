import { Option } from "effect"
import { Command, given, message, model, story } from "foldkit/story"
import { fromString } from "foldkit/url"
import { describe, expect, it } from "vitest"
import {
  ActivateFsaBackend,
  ActivateOpfsBackend,
  CopyApiDtsToClipboard,
  DeleteModalEntry,
  DisconnectStorage,
  FocusModalNameInput,
  NavigateToSubfolder,
  PickLocalDirectory,
  PushUrl,
  ReplaceUrl,
  SaveFileInfoPreference,
  SaveModalChanges,
  ScrollHelpTopicIntoView,
  WaitBeforeResetCopyDts,
  WritePendingImportFiles,
} from "./command"
import { Message, init, update } from "./main"
import {
  AppRoute,
  CopyDtsState,
  EditorFileMode,
  EntriesState,
  type FileEntry,
  InstallPrompt,
  type Model,
  ModalState,
  OPFS_APP_FOLDER,
  SavedBackend,
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
    entriesState: EntriesState.Loaded({ entries: sampleEntries }),
    otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
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
        message(Message.ToggledHelpTopic({ topic: "fs", isOpen: true })),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              isApiOpen: false,
              isFsOpen: true,
              copyDtsState: CopyDtsState.Idle(),
            }),
          )
        }),
        Command.expectExact(
          ReplaceUrl({ url: "/?pwaislands=help-fs" }),
          ScrollHelpTopicIntoView({ topic: "fs" }),
        ),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
        Command.resolve(ScrollHelpTopicIntoView, Message.CompletedScrollHelpTopicIntoView()),
        message(Message.ToggledHelpTopic({ topic: "fs", isOpen: false })),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              isApiOpen: false,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Idle(),
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
              isApiOpen: false,
              isFsOpen: false,
              copyDtsState: CopyDtsState.Idle(),
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
        }),
      }

      story(
        update,
        given(noFolderModel),
        message(Message.ClickedOpenHelp()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.Help({
              isApiOpen: false,
              isFsOpen: true,
              copyDtsState: CopyDtsState.Idle(),
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
                name: "file1.html",
                kind: "file" as const,
                maybeSize: Option.some(100),
                maybeLastModified: Option.some(1000),
              },
              {
                name: "file2.html",
                kind: "file" as const,
                maybeSize: Option.some(100),
                maybeLastModified: Option.some(1000),
              },
              {
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
          Message.SelectedImportFiles({
            files: [
              { name: "file1.html", size: 100, lastModified: 1000 },
              { name: "file2.html", size: 100, lastModified: 1000 },
              { name: "file3.html", size: 100, lastModified: 1000 },
            ],
          }),
        ),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState._tag).toBe("ImportConflict")
          if (m.modalState._tag === "ImportConflict") {
            expect(m.modalState.current.name).toBe("file1.html")
            expect(m.modalState.queue).toHaveLength(2)
          }
        }),
        message(Message.SelectedImportConflictAction({ action: "skip" })),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState._tag).toBe("ImportConflict")
          if (m.modalState._tag === "ImportConflict") {
            expect(m.modalState.current.name).toBe("file2.html")
            expect(m.modalState.queue).toHaveLength(1)
          }
        }),
        message(Message.ToggledImportConflictApplyToAll({ applyToAll: true })),
        Command.expectNone(),
        model((m) => {
          expect(m.modalState._tag).toBe("ImportConflict")
          if (m.modalState._tag === "ImportConflict") {
            expect(m.modalState.applyToAll).toBe(true)
          }
        }),
        message(Message.SelectedImportConflictAction({ action: "replace" })),
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

    it("opens CreateFile modal and updates URL to ?pwaislands=new when ClickedNewFile", () => {
      story(
        update,
        given(readyModel),
        message(Message.ClickedNewFile()),
        Command.expectExact(PushUrl({ url: "/?pwaislands=new" }), FocusModalNameInput()),
        Command.resolve(PushUrl, Message.CompletedPushUrl()),
        Command.resolve(FocusModalNameInput, Message.CompletedFocusModalNameInput()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.CreateFile({
              name: "Neu.html",
              content: "",
              maybeValidationError: Option.none(),
            }),
          )
        }),
        message(Message.ClickedCloseModal()),
        Command.expectExact(ReplaceUrl({ url: "/?pwaislands" })),
        Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
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
        Command.resolve(FocusModalNameInput, Message.CompletedFocusModalNameInput()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.CreateFolder({
              name: "Neuer Ordner",
              maybeValidationError: Option.none(),
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
        Command.expectExact(FocusModalNameInput()),
        Command.resolve(FocusModalNameInput, Message.CompletedFocusModalNameInput()),
        model((m) => {
          expect(m.modalState).toEqual(
            ModalState.CreateFile({
              name: "Neu.html",
              content: "",
              maybeValidationError: Option.none(),
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
            Message.SucceededInitializeStorage({
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
            Message.SucceededInitializeStorage({
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
          Command.expectExact(PushUrl({ url: "/?pwaislands" })),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.PermissionRequired({
                storageType: "fsa",
                folderName: "Gespeicherter Ordner",
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
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
            Message.SucceededInitializeStorage({
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
              hasDirectoryPicker: true,
              hasOPFS: true,
              route: AppRoute.Folder({ subPath: [] }),
            }),
            PushUrl({ url: "/?pwaislands" }),
          ),
          Command.resolve(
            DisconnectStorage,
            Message.DetectedNoFolderSelected({
              storageType: "fsa",
              otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
            }),
          ),
          Command.resolve(PushUrl, Message.CompletedPushUrl()),
          model((m) => {
            expect(m.storageState).toEqual(
              StorageState.NoFolderSelected({
                storageType: "fsa",
                otherBackend: SavedBackend.Granted({ rootName: OPFS_APP_FOLDER }),
              }),
            )
          }),
        )
      })
    })
  })
})
