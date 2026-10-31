import { Option } from "effect"
import {
  Command,
  change,
  click,
  doubleClick,
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
  EntriesState,
  InstallPrompt,
  Message,
  type Model,
  PickLocalDirectory,
  PushUrl,
  RefreshEntries,
  ReplaceUrl,
  SavedBackend,
  StorageState,
  update,
  view,
} from "./main"
import * as Editor from "./editor"
import * as Help from "./help"
import * as Modal from "./modal"
import { BinaryEdit, EditorFileMode, ModalState, PreviewContent } from "./modal"
import { AppRoute } from "./route"
import type { FileEntry } from "./files"

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
  maybeActiveIslandUrl: Option.none(),
  maybeActiveIslandPath: Option.none(),
  returnClickId: 0,
}

describe("PWA Islands Scene Tests", () => {
  it("creates a new file through the modal UI and updates the table", () => {
    const updatedEntries: ReadonlyArray<FileEntry> = [
      ...sampleEntries,
      {
        id: "file:hallo.html",
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
        [Modal.FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()],
        [Editor.LoadUserTemplates, Editor.Message.CompletedLoadUserTemplates({ templates: [] })],
      ),
      sceneExpect(selector(".modal-title")).toHaveText("Neue Datei erstellen"),
      type(selector("#modal-file-name"), "hallo.html"),
      type(selector("#modal-file-content"), "<h1>Hallo Welt</h1>"),
      click(selector("#modal-btn-save")),
      Command.resolveAll(
        [Editor.SaveChanges, Editor.Message.SucceededSaveChanges({ entries: updatedEntries })],
        [ReplaceUrl, Message.CompletedReplaceUrl()],
      ),
      sceneExpect(selector(".modal-overlay")).toBeAbsent(),
      sceneExpect(text("hallo.html")).toExist(),
    )
  })

  it("hides binary preview when checking Binärdatei bearbeiten", () => {
    const binaryModel: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "bild.png",
          name: "bild.png",
          fileMode: EditorFileMode.Binary({
            preview: PreviewContent.Image({ objectUrl: "blob:preview-url" }),
            edit: BinaryEdit.Disabled(),
          }),
          maybeValidationError: Option.none(),
        }),
      }),
    }

    scene(
      { update, view },
      given(binaryModel),
      sceneExpect(selector("#modal-file-preview")).toExist(),
      sceneExpect(selector("#modal-base64-editor")).toBeAbsent(),
      change(selector("#modal-use-base64"), "true"),
      Command.expectExact(Editor.LoadBase64({ entryName: "bild.png", subPath: [] })),
      Command.resolve(
        Editor.LoadBase64,
        Editor.Message.SucceededLoadBase64({ base64Content: "iVBORw0KGgo=" }),
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
      modalState: ModalState.Editor({
        editor: {
          ...Editor.makeCreateFile(),
          name: "index.html",
          content: "<h1>Duplicate</h1>",
        },
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

  it("copies /app.d.ts from editor modal", () => {
    const modelWithEditor: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }

    scene(
      { update, view },
      given(modelWithEditor),
      sceneExpect(selector("#modal-btn-copy-dts")).toExist(),
      sceneExpect(selector("#modal-btn-copy-dts")).toContainText("/app.d.ts"),
      click(selector("#modal-btn-copy-dts")),
      Command.expectExact(Editor.CopyApiDtsToClipboard()),
      Command.resolve(
        Editor.CopyApiDtsToClipboard,
        Editor.Message.SucceededCopyApiDtsToClipboard(),
      ),
      sceneExpect(text("/api.d.ts in die Zwischenablage kopiert")).toExist(),
    )
  })

  it("does not show /app.d.ts copy button in folder modal", () => {
    const modelWithFolderModal: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.CreateFolder({
          name: "Neuer Ordner",
          maybeValidationError: Option.none(),
        }),
      }),
    }

    scene(
      { update, view },
      given(modelWithFolderModal),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-cancel")).toExist(),
    )
  })

  it("shows delete confirmation dialog when clicking delete button in file edit modal", () => {
    const modelWithEditFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: "<p>Original</p>" }),
          maybeValidationError: Option.none(),
        }),
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
          Message.SucceededActivateOpfsBackend({
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
        pendingRoute: AppRoute.Folder({ subPath: [] }),
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
        Message.SucceededPickLocalDirectory({
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

  it("renders full-window iframe for pwaislands:// with top border return button in Windows builds", () => {
    const tauriWindowsModel: Model = {
      ...readyModel,
      hasTauri: true,
      isWindowsOrLinux: true,
      isWindows: true,
      storageState: StorageState.Ready({
        storageType: "tauri",
        rootName: "PWA Islands",
        subPath: ["unterordner"],
        entriesState: EntriesState.Loaded({ entries: sampleEntries }),
        otherBackend: SavedBackend.Unsupported(),
      }),
    }

    scene(
      { update, view },
      given(tauriWindowsModel),
      sceneExpect(selector("#island-iframe")).toBeAbsent(),
      sceneExpect(selector("#btn-return-pwaislands")).toBeAbsent(),
      click(text("index.html")),
      Command.expectExact(PushUrl({ url: "/unterordner/index.html" })),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#island-iframe")).toExist(),
      sceneExpect(selector("#island-iframe")).toHaveClass("has-top-border"),
      sceneExpect(selector("#window-top-border")).toExist(),
      sceneExpect(selector("#btn-return-pwaislands")).toExist(),
      sceneExpect(selector("#btn-return-pwaislands")).toContainText("←"),
      doubleClick(selector("#btn-return-pwaislands")),
      Command.expectExact(
        PushUrl({ url: "/unterordner?pwaislands" }),
        RefreshEntries({ subPath: ["unterordner"] }),
      ),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      Command.resolve(
        RefreshEntries,
        Message.SucceededRefreshEntries({
          subPath: ["unterordner"],
          entries: sampleEntries,
        }),
      ),
      sceneExpect(selector("#island-iframe")).toBeAbsent(),
      sceneExpect(selector("#btn-return-pwaislands")).toBeAbsent(),
    )
  })

  it("does not render HTML top border return button in Linux/Android builds (Linux has it in native GTK title bar)", () => {
    const tauriLinuxModel: Model = {
      ...readyModel,
      hasTauri: true,
      isWindowsOrLinux: true,
      isWindows: false,
      storageState: StorageState.Ready({
        storageType: "tauri",
        rootName: "PWA Islands",
        subPath: ["unterordner"],
        entriesState: EntriesState.Loaded({ entries: sampleEntries }),
        otherBackend: SavedBackend.Unsupported(),
      }),
    }

    scene(
      { update, view },
      given(tauriLinuxModel),
      click(text("index.html")),
      Command.expectExact(PushUrl({ url: "/unterordner/index.html" })),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#island-iframe")).toExist(),
      sceneExpect(selector("#island-iframe")).not.toHaveClass("has-top-border"),
      sceneExpect(selector("#window-top-border")).toBeAbsent(),
      sceneExpect(selector("#btn-return-pwaislands")).toBeAbsent(),
    )
  })

  it("shows folder change and disconnect options in settings menu when Tauri folder is ready", () => {
    const tauriReadyModel: Model = {
      ...readyModel,
      hasDirectoryPicker: false,
      hasTauri: true,
      storageState: StorageState.Ready({
        storageType: "tauri",
        rootName: "Tauri-Projekte",
        subPath: [],
        entriesState: EntriesState.Loaded({ entries: sampleEntries }),
        otherBackend: SavedBackend.Granted({ rootName: "PWA Islands" }),
      }),
    }

    scene(
      { update, view },
      given(tauriReadyModel),
      click(selector("#btn-settings")),
      sceneExpect(selector("#btn-change-folder")).toExist(),
      sceneExpect(selector("#btn-change-folder")).toContainText("Ordner wechseln"),
      sceneExpect(selector("#btn-disconnect-folder")).toExist(),
      sceneExpect(selector("#btn-use-opfs")).toBeAbsent(),
      sceneExpect(selector("#btn-select-folder")).toBeAbsent(),
    )
  })

  it("renders help-fs with app (tauri native fs) option and shows support status depending on runtime", () => {
    const browserHelpModel: Model = {
      ...readyModel,
      modalState: ModalState.Help({ help: Help.init(Option.some("fs")) }),
    }

    scene(
      { update, view },
      given(browserHelpModel),
      sceneExpect(selector('.help-topic[data-topic="fs"]')).toExist(),
      sceneExpect(selector('.help-topic[data-topic="fs"]')).toContainText(
        "App (Tauri natives Dateisystem)",
      ),
      sceneExpect(selector('.help-topic[data-topic="fs"]')).toContainText("App (Tauri)"),
      sceneExpect(selector('[data-support="tauri"] .help-supported')).toHaveAttr(
        "data-supported",
        "no",
      ),
      sceneExpect(selector('[data-support="fsa"] .help-supported')).toHaveAttr(
        "data-supported",
        "yes",
      ),
      sceneExpect(selector('[data-support="opfs"] .help-supported')).toHaveAttr(
        "data-supported",
        "yes",
      ),
    )

    const tauriHelpModel: Model = {
      ...readyModel,
      hasDirectoryPicker: false,
      hasTauri: true,
      modalState: ModalState.Help({ help: Help.init(Option.some("fs")) }),
    }

    scene(
      { update, view },
      given(tauriHelpModel),
      sceneExpect(selector('[data-support="tauri"] .help-supported')).toHaveAttr(
        "data-supported",
        "yes",
      ),
      sceneExpect(selector('[data-support="fsa"] .help-supported')).toHaveAttr(
        "data-supported",
        "no",
      ),
    )
  })
})
