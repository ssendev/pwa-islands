import { Option } from "effect"
import {
  Command,
  change,
  click,
  expect as sceneExpect,
  given,
  scene,
  selector,
  text,
  type,
} from "foldkit/scene"
import { describe, it } from "vitest"
import {
  ActivateOpfsBackend,
  FocusModalNameInput,
  LoadModalBase64,
  PickLocalDirectory,
  PushUrl,
  ReplaceUrl,
  SaveModalChanges,
} from "./command"
import { Message, update, view } from "./main"
import {
  BinaryEdit,
  EditorFileMode,
  EntriesState,
  type FileEntry,
  InstallPrompt,
  type Model,
  ModalState,
  PreviewContent,
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

describe("PWA Islands Scene Tests", () => {
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

    scene(
      { update, view },
      given(readyModel),
      sceneExpect(selector("#folder-name-display")).toContainText("PWA Islands"),
      sceneExpect(text("index.html")).toExist(),
      click(selector("#btn-new-file")),
      Command.resolveAll(
        [PushUrl, Message.CompletedPushUrl()],
        [FocusModalNameInput, Message.CompletedFocusModalNameInput()],
      ),
      sceneExpect(selector(".modal-title")).toHaveText("Neue Datei erstellen"),
      type(selector("#modal-file-name"), "hallo.html"),
      type(selector("#modal-file-content"), "<h1>Hallo Welt</h1>"),
      click(selector("#modal-btn-save")),
      Command.resolveAll(
        [SaveModalChanges, Message.SucceededModalMutation({ entries: updatedEntries })],
        [ReplaceUrl, Message.CompletedReplaceUrl()],
      ),
      sceneExpect(selector(".modal-overlay")).toBeAbsent(),
      sceneExpect(text("hallo.html")).toExist(),
    )
  })

  it("hides binary preview when checking Binärdatei bearbeiten", () => {
    const binaryModel: Model = {
      ...readyModel,
      modalState: ModalState.EditFile({
        originalName: "bild.png",
        name: "bild.png",
        fileMode: EditorFileMode.Binary({
          preview: PreviewContent.Image({ objectUrl: "blob:preview-url" }),
          edit: BinaryEdit.Disabled(),
        }),
        maybeValidationError: Option.none(),
      }),
    }

    scene(
      { update, view },
      given(binaryModel),
      sceneExpect(selector("#modal-file-preview")).toExist(),
      sceneExpect(selector("#modal-base64-editor")).toBeAbsent(),
      change(selector("#modal-use-base64"), "true"),
      Command.expectExact(LoadModalBase64({ entryName: "bild.png", subPath: [] })),
      Command.resolve(
        LoadModalBase64,
        Message.SucceededLoadModalBase64({ base64Content: "iVBORw0KGgo=" }),
      ),
      sceneExpect(selector("#modal-base64-editor")).toExist(),
      sceneExpect(selector("#modal-file-preview")).toBeAbsent(),
      change(selector("#modal-use-base64"), "false"),
      sceneExpect(selector("#modal-base64-editor")).toBeAbsent(),
      sceneExpect(selector("#modal-file-preview")).toExist(),
    )
  })

  it("shows overwrite confirmation dialog when saving file with existing name", () => {
    const modelWithDuplicateFile: Model = {
      ...readyModel,
      modalState: ModalState.CreateFile({
        name: "index.html",
        content: "<h1>Duplicate</h1>",
        maybeValidationError: Option.none(),
      }),
    }

    scene(
      { update, view },
      given(modelWithDuplicateFile),
      sceneExpect(selector(".modal-title")).toHaveText("Neue Datei erstellen"),
      click(selector("#modal-btn-save")),
      sceneExpect(selector(".modal-title")).toHaveText("Datei überschreiben?"),
      sceneExpect(text(/Möchten Sie ihn überschreiben\?/)).toExist(),
    )
  })

  it("shows delete confirmation dialog when clicking delete button in file edit modal", () => {
    const modelWithEditFile: Model = {
      ...readyModel,
      modalState: ModalState.EditFile({
        originalName: "index.html",
        name: "index.html",
        fileMode: EditorFileMode.Text({ content: "<p>Original</p>" }),
        maybeValidationError: Option.none(),
      }),
    }

    scene(
      { update, view },
      given(modelWithEditFile),
      sceneExpect(selector(".modal-title")).toHaveText("Datei bearbeiten: index.html"),
      click(selector("#modal-btn-delete")),
      sceneExpect(selector(".modal-title")).toHaveText("Eintrag löschen"),
      sceneExpect(text(/wirklich unwiderruflich löschen\?/)).toExist(),
    )
  })

  it("toggles settings menu and switches to OPFS", () => {
    scene(
      { update, view },
      given(readyModel),
      click(selector("#btn-settings")),
      sceneExpect(selector("#btn-use-opfs")).toExist(),
      sceneExpect(selector("#btn-select-folder")).toBeAbsent(),
      click(selector("#btn-use-opfs")),
      Command.resolveAll(
        [
          ActivateOpfsBackend,
          Message.SucceededInitializeStorage({
            storageType: "opfs",
            rootName: "PWA Islands",
            subPath: [],
            entries: [],
            otherBackend: SavedBackend.Granted({ rootName: "Meine Islands" }),
            maybeModalState: Option.none(),
            maybeAlertBanner: Option.none(),
          }),
        ],
        [PushUrl, Message.CompletedPushUrl()],
      ),
      click(selector("#btn-settings")),
      sceneExpect(selector("#btn-select-folder")).toExist(),
      sceneExpect(selector("#btn-use-opfs")).toBeAbsent(),
    )
  })

  it("shows 'Ordner wählen' in settings menu when FSA has no folder selected", () => {
    const fsaNoFolderModel: Model = {
      ...readyModel,
      storageState: StorageState.NoFolderSelected({
        storageType: "fsa",
        otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
      }),
    }

    scene(
      { update, view },
      given(fsaNoFolderModel),
      click(selector("#btn-settings")),
      sceneExpect(selector("#btn-change-folder")).toExist(),
      sceneExpect(selector("#btn-change-folder")).toContainText("Ordner wählen"),
      sceneExpect(selector("#btn-use-opfs")).toExist(),
      sceneExpect(selector("#btn-select-folder")).toBeAbsent(),
      click(selector("#btn-change-folder")),
      Command.resolveAll([
        PickLocalDirectory,
        Message.SucceededInitializeStorage({
          storageType: "fsa",
          rootName: "Meine Islands",
          subPath: [],
          entries: sampleEntries,
          otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
          maybeModalState: Option.none(),
          maybeAlertBanner: Option.none(),
        }),
      ]),
      sceneExpect(selector("#folder-name-display")).toContainText("PWA Islands"),
      sceneExpect(text("index.html")).toExist(),
    )
  })
})
