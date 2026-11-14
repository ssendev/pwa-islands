import { Option } from "effect"
import {
  Command,
  Subscription,
  change,
  click,
  doubleClick,
  expect as sceneExpect,
  given,
  keydown,
  scene,
  selector,
  text,
  type,
} from "foldkit/scene"
import { describe, it } from "vitest"
import { hashLine } from "./hashline"
import {
  ActivateOpfsBackend,
  ClearAllHistory,
  ClearAllHistoryState,
  EntriesState,
  InstallPrompt,
  Message,
  type Model,
  PickLocalDirectory,
  PushUrl,
  RefreshEntries,
  ReplaceUrl,
  SavedBackend,
  SaveEditorPreferences,
  SaveHistoryEnabledPreference,
  StorageState,
  TestLlm,
  ToggleFullscreenWindow,
  WaitBeforeDismissToast,
  update,
  view,
  LlmTestState,
} from "./main"
import * as History from "./history"
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
  historyEnabled: true,
  clearAllHistoryState: ClearAllHistoryState.Idle(),
  installPrompt: InstallPrompt.Unavailable(),
  modalState: ModalState.Closed(),
  toasts: [],
  nextToastId: 1,
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

    scene(
      { update, view },
      given(binaryModel),
      sceneExpect(selector("#modal-file-preview")).toExist(),
      sceneExpect(selector("#modal-base64-editor")).toBeAbsent(),
      sceneExpect(selector("#modal-llm-mode-select")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
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

  it("toggles LLM toolbar and copies /app.d.ts, full LLM context, or hashes only", () => {
    const modelWithEditor: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }

    scene(
      { update, view },
      given(modelWithEditor),
      sceneExpect(selector("#modal-llm-mode-select")).toExist(),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveValue("Closed"),
      sceneExpect(selector("#modal-llm-mode-select option[value='Chat']")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      change(selector("#modal-llm-mode-select"), "Copy"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-btn-copy-dts")).toExist(),
      sceneExpect(selector("#modal-btn-copy-dts")).toContainText("/app.d.ts"),
      sceneExpect(selector("#modal-btn-copy-llm")).toContainText("Mit Anleitung"),
      sceneExpect(selector("#modal-btn-copy-hashes")).toContainText("Datei"),
      sceneExpect(selector("#modal-btn-paste-llm")).toContainText("Einfügen"),
      sceneExpect(selector("#modal-btn-preview")).toContainText("Anzeigen"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeAbsent(),
      click(selector("#modal-btn-copy-dts")),
      Command.expectExact(Editor.CopyApiDtsToClipboard()),
      Command.resolve(
        Editor.CopyApiDtsToClipboard,
        Editor.Message.SucceededCopyApiDtsToClipboard(),
      ),
      sceneExpect(text("/api.d.ts in die Zwischenablage kopiert")).toExist(),
      Command.resolve(WaitBeforeDismissToast, Message.CompletedWaitBeforeDismissToast({ id: 1 })),
      click(selector("#modal-btn-copy-hashes")),
      Command.expectExact(
        Editor.CopyFileHashesToClipboard({
          fileName: "Neu.html",
          content: "",
          editFormat: "hashline",
        }),
      ),
      Command.resolve(Editor.CopyFileHashesToClipboard, Editor.Message.SucceededCopyFileHashes()),
      sceneExpect(text("Datei mit Hashes in die Zwischenablage kopiert")).toExist(),
      Command.resolve(WaitBeforeDismissToast, Message.CompletedWaitBeforeDismissToast({ id: 2 })),
      click(selector("#modal-btn-copy-llm")),
      Command.expectExact(
        Editor.CopyLlmContextToClipboard({
          fileName: "Neu.html",
          content: "",
          editFormat: "hashline",
        }),
      ),
      Command.resolve(Editor.CopyLlmContextToClipboard, Editor.Message.SucceededCopyLlmContext()),
      sceneExpect(selector("#toast-container .toast.alert-info")).toContainText(
        "Datei und /api.d.ts für KI in die Zwischenablage kopiert",
      ),
      Command.resolve(WaitBeforeDismissToast, Message.CompletedWaitBeforeDismissToast({ id: 3 })),
      sceneExpect(selector("#toast-container .toast")).toBeAbsent(),
    )
  })

  it("switches LLM bar between Closed, Chat, and Copy when LLM is enabled in settings", () => {
    const modelWithLlmEnabled: Model = {
      ...readyModel,
      llmEnabled: true,
      llmModels: "gpt-4o, qwen3",
      llmModel: "gpt-4o",
      llmThinkingParam: "chat_template_kwargs.enable_thinking",
      llmThinkingLevels: "Aus=false, An=true",
      llmThinkingLevel: "false",
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }

    scene(
      { update, view },
      given(modelWithLlmEnabled),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveValue("Closed"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      change(selector("#modal-llm-mode-select"), "Chat"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveValue("Chat"),
      sceneExpect(selector("#modal-llm-chat-input")).toExist(),
      sceneExpect(selector("#modal-llm-model-select")).toExist(),
      sceneExpect(selector("#modal-llm-model-select")).toHaveValue("gpt-4o"),
      sceneExpect(selector("#modal-llm-thinking-select")).toExist(),
      sceneExpect(selector("#modal-llm-thinking-select")).toHaveValue("false"),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-preview")).toExist(),
      type(selector("#modal-llm-chat-input"), "Mach einen Button"),
      sceneExpect(selector("#modal-llm-chat-input")).toHaveValue("Mach einen Button"),
      change(selector("#modal-llm-model-select"), "qwen3"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-model-select")).toHaveValue("qwen3"),
      change(selector("#modal-llm-thinking-select"), "true"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-thinking-select")).toHaveValue("true"),
      change(selector("#modal-llm-mode-select"), "Copy"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveValue("Copy"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toExist(),
      sceneExpect(selector("#modal-btn-copy-llm")).toExist(),
      sceneExpect(selector("#modal-btn-copy-hashes")).toExist(),
      sceneExpect(selector("#modal-btn-paste-llm")).toExist(),
      change(selector("#modal-llm-mode-select"), "Closed"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveValue("Closed"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-preview")).toBeAbsent(),
    )
  })

  it("hides thinking select in editor chat bar when fewer than two thinking options exist", () => {
    const modelWithSingleThinking: Model = {
      ...readyModel,
      llmEnabled: true,
      llmModels: "gpt-4o",
      llmModel: "gpt-4o",
      llmThinkingParam: "reasoning_effort",
      llmThinkingLevels: "low",
      llmThinkingLevel: "low",
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }

    scene(
      { update, view },
      given(modelWithSingleThinking),
      change(selector("#modal-llm-mode-select"), "Chat"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-chat-input")).toExist(),
      sceneExpect(selector("#modal-llm-model-select")).toExist(),
      sceneExpect(selector("#modal-llm-thinking-select")).toBeAbsent(),
    )
  })

  it("streams LLM chat response, shows questions and answers, and switches send button to Stopp", () => {
    const modelWithLlmEnabled: Model = {
      ...readyModel,
      llmEnabled: true,
      llmBaseUrl: "https://api.example.com/v1",
      llmModels: "gpt-4o",
      llmModel: "gpt-4o",
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }

    scene(
      { update, view },
      given(modelWithLlmEnabled),
      change(selector("#modal-llm-mode-select"), "Chat"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      type(selector("#modal-llm-chat-input"), "Füge Titel hinzu"),
      keydown(selector("#modal-llm-chat-input"), "Enter"),
      sceneExpect(selector(".modal-overlay")).toExist(),
      sceneExpect(selector("#modal-llm-chat-input")).toHaveValue(""),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Füge Titel hinzu"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Schreibt …"),
      sceneExpect(selector("#modal-btn-send-llm")).toHaveAttr("aria-label", "Stopp"),
      sceneExpect(selector("#modal-btn-send-llm")).toBeEnabled(),
      sceneExpect(selector("#modal-btn-send-llm.btn-danger")).toExist(),
      Subscription.emit(
        Message.UpdatedEditorLlmChatStream({
          completedTurns: [
            {
              content: "Tool-Aufruf: edit",
              reasoning: "Erster Gedanke",
              isError: false,
            },
            {
              content: "Fehler beim Anwenden der Änderungen: Hash stimmt nicht überein",
              reasoning: "",
              isError: true,
            },
          ],
          activeTurn: {
            content: "Ich füge den Titel hinzu.",
            reasoning: "Plane die Änderung",
          },
        }),
      ),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Erster Gedanke"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Tool-Aufruf: edit"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText(
        "Fehler beim Anwenden der Änderungen",
      ),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Plane die Änderung"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Ich füge den Titel hinzu."),
      Subscription.emit(
        Message.SucceededEditorLlmChat({
          messages: [
            Editor.LlmChatMessage.System({ content: "sys" }),
            Editor.LlmChatMessage.User({ content: "dts" }),
            Editor.LlmChatMessage.User({ content: "file" }),
            Editor.LlmChatMessage.User({ content: "Füge Titel hinzu" }),
            Editor.LlmChatMessage.Assistant({
              content: "Ich füge den Titel hinzu.",
              toolCalls: [],
            }),
            Editor.LlmChatMessage.Tool({ toolCallId: "call_1", content: "ok" }),
          ],
          maybeUpdatedContent: Option.some("<h1>Hallo</h1>"),
          appliedCount: 1,
          turns: [
            {
              content: "Tool-Aufruf: edit",
              reasoning: "Erster Gedanke",
              isError: false,
            },
            {
              content: "Fehler beim Anwenden der Änderungen: Hash stimmt nicht überein",
              reasoning: "",
              isError: true,
            },
            {
              content: "Ich füge den Titel hinzu.",
              reasoning: "Plane die Änderung",
              isError: false,
            },
          ],
        }),
      ),
      sceneExpect(selector("#modal-file-content")).toHaveValue("<h1>Hallo</h1>"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText(
        "1 Bearbeitung(en) angewendet",
      ),
      sceneExpect(selector("#modal-btn-send-llm")).toHaveAttr("aria-label", "Senden"),
    )
  })

  it("stops an active LLM chat request when clicking Stopp and preserves partial output", () => {
    const modelWithLlmEnabled: Model = {
      ...readyModel,
      llmEnabled: true,
      llmBaseUrl: "https://api.example.com/v1",
      llmModels: "gpt-4o",
      llmModel: "gpt-4o",
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }

    scene(
      { update, view },
      given(modelWithLlmEnabled),
      change(selector("#modal-llm-mode-select"), "Chat"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      type(selector("#modal-llm-chat-input"), "Erkläre kurz"),
      click(selector("#modal-btn-send-llm")),
      sceneExpect(selector("#modal-btn-send-llm")).toHaveAttr("aria-label", "Stopp"),
      Subscription.emit(
        Message.UpdatedEditorLlmChatStream({
          completedTurns: [],
          activeTurn: {
            content: "Teilantwort",
            reasoning: "",
          },
        }),
      ),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Teilantwort"),
      click(selector("#modal-btn-send-llm")),
      sceneExpect(selector("#modal-btn-send-llm")).toHaveAttr("aria-label", "Senden"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Erkläre kurz"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Teilantwort"),
      sceneExpect(selector("#modal-llm-chat-history .llm-response-streaming")).toBeAbsent(),
    )
  })

  it("re-enables send button and restores prompt when LLM chat fails", () => {
    const modelWithLlmEnabled: Model = {
      ...readyModel,
      llmEnabled: true,
      llmBaseUrl: "https://api.example.com/v1",
      llmModels: "gpt-4o",
      llmModel: "gpt-4o",
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }

    scene(
      { update, view },
      given(modelWithLlmEnabled),
      change(selector("#modal-llm-mode-select"), "Chat"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      type(selector("#modal-llm-chat-input"), "Erkläre Fehler"),
      click(selector("#modal-btn-send-llm")),
      sceneExpect(selector("#modal-btn-send-llm")).toHaveAttr("aria-label", "Stopp"),
      Subscription.emit(
        Message.UpdatedEditorLlmChatStream({
          completedTurns: [],
          activeTurn: {
            content: "Erster Versuch",
            reasoning: "",
          },
        }),
      ),
      Subscription.emit(
        Message.FailedEditorLlmChat({
          message: "HTTP 500",
        }),
      ),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Erster Versuch"),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("HTTP 500"),
      sceneExpect(selector("#modal-llm-chat-input")).toHaveValue("Erkläre Fehler"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeEnabled(),
      sceneExpect(selector("#modal-btn-send-llm")).toHaveAttr("aria-label", "Senden"),
      sceneExpect(selector("#modal-btn-send-llm")).toBeEnabled(),
    )
  })

  it("pastes valid LLM edits and updates editor content", () => {
    const original = "<p>Alt</p>"
    const lineHash = hashLine(original)
    const modelWithEditFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: original }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Copy",
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

    scene(
      { update, view },
      given(modelWithEditFile),
      click(selector("#modal-btn-paste-llm")),
      Command.expectExact(Editor.ReadClipboardForLlmEdits()),
      Command.resolve(
        Editor.ReadClipboardForLlmEdits,
        Editor.Message.SucceededReadClipboardForLlmEdits({
          text: `\`\`\`hashline\nREPLACE 1:${lineHash}\n<p>Neu</p>\nEND\n\`\`\``,
        }),
      ),
      Command.expectExact(
        Editor.CopyUpdatedHashesToClipboard({
          fileName: "index.html",
          changedLines: `1:${hashLine("<p>Neu</p>")}|<p>Neu</p>`,
        }),
        WaitBeforeDismissToast({ id: 1 }),
      ),
      Command.resolveAll(
        [Editor.CopyUpdatedHashesToClipboard, Editor.Message.SucceededCopyUpdatedHashes()],
        [WaitBeforeDismissToast, Message.CompletedWaitBeforeDismissToast({ id: 1 })],
      ),
      sceneExpect(selector("#modal-btn-paste-llm")).toContainText("Einfügen"),
    )
  })

  it("clears clipboard after pasting search-replace edits", () => {
    const modelWithEditFile: Model = {
      ...readyModel,
      llmEditFormat: "search-replace",
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: "<p>Alt</p>" }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Copy",
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

    scene(
      { update, view },
      given(modelWithEditFile),
      click(selector("#modal-btn-paste-llm")),
      Command.expectExact(Editor.ReadClipboardForLlmEdits()),
      Command.resolve(
        Editor.ReadClipboardForLlmEdits,
        Editor.Message.SucceededReadClipboardForLlmEdits({
          text: "<<<<<<< SEARCH\n<p>Alt</p>\n=======\n<p>Neu</p>\n>>>>>>> REPLACE",
        }),
      ),
      Command.expectExact(Editor.ClearClipboardAfterPaste(), WaitBeforeDismissToast({ id: 1 })),
      Command.resolveAll(
        [Editor.ClearClipboardAfterPaste, Editor.Message.CompletedClearClipboardAfterPaste()],
        [WaitBeforeDismissToast, Message.CompletedWaitBeforeDismissToast({ id: 1 })],
      ),
    )
  })

  it("shows error on paste button and copies error to clipboard when LLM edits fail", () => {
    const modelWithEditFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: "<p>Alt</p>" }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Copy",
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
    const expectedError =
      "Zeile 1: Hash stimmt nicht überein (erwartet " + hashLine("<p>Alt</p>") + ", angegeben 000)."

    scene(
      { update, view },
      given(modelWithEditFile),
      click(selector("#modal-btn-paste-llm")),
      Command.expectExact(Editor.ReadClipboardForLlmEdits()),
      Command.resolve(
        Editor.ReadClipboardForLlmEdits,
        Editor.Message.SucceededReadClipboardForLlmEdits({
          text: "REPLACE 1:000\n<p>Neu</p>\nEND",
        }),
      ),
      Command.expectExact(Editor.CopyPasteErrorToClipboard({ errorText: expectedError })),
      Command.resolve(
        Editor.CopyPasteErrorToClipboard,
        Editor.Message.CompletedCopyPasteErrorToClipboard(),
      ),
      sceneExpect(selector("#modal-btn-paste-llm")).toContainText("Fehler"),
      sceneExpect(selector("#modal-btn-paste-llm.btn-danger")).toExist(),
      sceneExpect(text(expectedError)).toExist(),
    )
  })

  it("hides delete button in LLM mode and opens full-window iframe without saving on Anzeigen click", () => {
    const editModel = Editor.Model.EditFile({
      originalName: "index.html",
      name: "index.html",
      fileMode: EditorFileMode.Text({ content: "<p>Test</p>" }),
      maybeValidationError: Option.none(),
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
    })
    const modelWithEditFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: editModel,
      }),
    }

    scene(
      { update, view },
      given(modelWithEditFile),
      sceneExpect(selector("#modal-btn-delete")).toExist(),
      change(selector("#modal-llm-mode-select"), "Copy"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-btn-delete")).toBeAbsent(),
      sceneExpect(selector(".modal-footer #modal-btn-preview")).toExist(),
      sceneExpect(selector("#editor-preview-overlay")).toBeAbsent(),
      click(selector("#modal-btn-preview")),
      Command.expectNone(),
      sceneExpect(selector("#editor-preview-overlay")).toExist(),
      sceneExpect(selector("#editor-preview-iframe")).toExist(),
      sceneExpect(selector("#editor-preview-iframe")).toHaveAttr("srcdoc", "<p>Test</p>"),
      sceneExpect(selector("#editor-preview-close")).toExist(),
      sceneExpect(selector("#editor-preview-close")).toHaveAttr("aria-label", "Vorschau schließen"),
      click(selector("#editor-preview-close")),
      Command.expectNone(),
      sceneExpect(selector("#editor-preview-overlay")).toBeAbsent(),
      sceneExpect(selector(".modal-overlay")).toExist(),
    )
  })

  it("does not show LLM button in folder modal", () => {
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
      sceneExpect(selector("#modal-llm-mode-select")).toBeAbsent(),
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

    scene(
      { update, view },
      given(modelWithEditFile),
      sceneExpect(selector(".modal-title")).toHaveText("Datei bearbeiten: index.html"),
      sceneExpect(selector("#modal-file-name")).toBeAbsent(),
      sceneExpect(text("Inhalt:")).toBeAbsent(),
      click(selector("#modal-btn-delete")),
      sceneExpect(selector(".modal-title")).toHaveText("Eintrag löschen"),
      sceneExpect(text(/wirklich unwiderruflich löschen\?/)).toExist(),
    )

    if (
      modelWithEditFile.modalState._tag === "Editor" &&
      modelWithEditFile.modalState.editor._tag === "EditFile"
    ) {
      const modelWithEditFileNameOpen: Model = {
        ...modelWithEditFile,
        modalState: ModalState.Editor({
          editor: Editor.Model.EditFile({
            ...modelWithEditFile.modalState.editor,
            isEditingName: true,
          }),
        }),
      }
      scene(
        { update, view },
        given(modelWithEditFileNameOpen),
        sceneExpect(selector("#modal-file-name")).toExist(),
      )
    }
  })

  it("toggles maximize state in file editor modal and hides maximize button in folder modal", () => {
    const modelWithCreateFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.makeCreateFile(),
      }),
    }
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
      given(modelWithCreateFile),
      sceneExpect(selector("#modal-btn-maximize")).toHaveAttr("aria-label", "Maximieren"),
      sceneExpect(selector(".modal-content.is-maximized")).toBeAbsent(),
      sceneExpect(selector(".modal-overlay.modal-overlay-maximized")).toBeAbsent(),
      click(selector("#modal-btn-maximize")),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-btn-maximize")).toHaveAttr("aria-label", "Wiederherstellen"),
      sceneExpect(selector(".modal-content.is-maximized")).toExist(),
      sceneExpect(selector(".modal-overlay.modal-overlay-maximized")).toExist(),
      click(selector("#modal-btn-maximize")),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-btn-maximize")).toHaveAttr("aria-label", "Maximieren"),
      sceneExpect(selector(".modal-content.is-maximized")).toBeAbsent(),
      sceneExpect(selector(".modal-overlay.modal-overlay-maximized")).toBeAbsent(),
    )

    scene(
      { update, view },
      given(modelWithFolderModal),
      sceneExpect(selector("#modal-btn-maximize")).toBeAbsent(),
    )
  })

  it("toggles settings menu and switches to OPFS", () => {
    scene(
      { update, view },
      given(readyModel),
      click(selector("#btn-settings")),
      click(selector("#btn-open-settings")),
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
      click(selector("#btn-open-settings")),
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
      click(selector("#btn-open-settings")),
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
      sceneExpect(selector("#btn-return-pwaislands")).toExist(),
      sceneExpect(selector("#btn-return-pwaislands")).toContainText("←"),
      click(text("index.html")),
      Command.expectExact(PushUrl({ url: "/unterordner/index.html" })),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#island-iframe")).toExist(),
      sceneExpect(selector("#island-iframe")).toHaveClass("has-top-border"),
      sceneExpect(selector("#window-top-border")).toExist(),
      sceneExpect(selector("#btn-return-pwaislands")).toExist(),
      sceneExpect(selector("#btn-return-pwaislands")).toContainText("←"),
      sceneExpect(selector("#fullscreen-btn")).toExist(),
      sceneExpect(selector("#min-btn")).toExist(),
      sceneExpect(selector("#max-btn")).toExist(),
      sceneExpect(selector("#close-btn")).toExist(),
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
      sceneExpect(selector("#btn-return-pwaislands")).toExist(),
      doubleClick(selector("#btn-return-pwaislands")),
      Command.expectExact(PushUrl({ url: "/?pwaislands" }), RefreshEntries({ subPath: [] })),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      Command.resolve(
        RefreshEntries,
        Message.SucceededRefreshEntries({
          subPath: [],
          entries: sampleEntries,
        }),
      ),
      sceneExpect(selector("#btn-return-pwaislands")).toBeAbsent(),
    )
  })

  it("renders fullscreen button in window controls when in fullscreen mode", () => {
    const tauriWindowsFullscreenModel: Model = {
      ...readyModel,
      hasTauri: true,
      isWindowsOrLinux: true,
      isWindows: true,
      isWindowFullscreen: true,
      maybeActiveIslandUrl: Option.some("pwaislands://localhost/unterordner/index.html"),
      maybeActiveIslandPath: Option.some("/unterordner/index.html"),
    }

    scene(
      { update, view },
      given(tauriWindowsFullscreenModel),
      sceneExpect(selector("#island-iframe")).toExist(),
      sceneExpect(selector("#island-iframe")).toHaveClass("has-top-border"),
      sceneExpect(selector("#fullscreen-btn")).toExist(),
      click(selector("#fullscreen-btn")),
      Command.expectExact(ToggleFullscreenWindow()),
      Command.resolve(ToggleFullscreenWindow, Message.CompletedToggleFullscreen()),
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
      sceneExpect(selector("#fullscreen-btn")).toBeAbsent(),
      sceneExpect(selector("#min-btn")).toBeAbsent(),
      sceneExpect(selector("#max-btn")).toBeAbsent(),
      sceneExpect(selector("#close-btn")).toBeAbsent(),
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
      click(selector("#btn-open-settings")),
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

  it("toggles streaming checkbox in settings dialog and runs LLM test", () => {
    scene(
      { update, view },
      given(readyModel),
      click(selector("#btn-settings")),
      click(selector("#btn-open-settings")),
      sceneExpect(selector("#llm-edit-format")).toExist(),
      sceneExpect(selector("#llm-edit-format")).toHaveValue("hashline"),
      sceneExpect(selector("#llm-enabled")).toExist(),
      sceneExpect(selector("#llm-base-url")).toBeAbsent(),
      change(selector("#llm-edit-format"), "search-replace"),
      sceneExpect(selector("#llm-edit-format")).toHaveValue("search-replace"),
      change(selector("#llm-edit-format"), "hashline"),
      change(selector("#llm-enabled"), "true"),
      sceneExpect(selector("#llm-streaming")).toExist(),
      sceneExpect(selector("#llm-tool-calls")).toExist(),
      sceneExpect(selector("#llm-models")).toExist(),
      sceneExpect(selector("#llm-thinking-preset")).toExist(),
      sceneExpect(selector("#llm-thinking-param")).toExist(),
      sceneExpect(selector("#llm-thinking-levels")).toExist(),
      sceneExpect(selector("#llm-active-model")).toExist(),
      sceneExpect(selector("#llm-thinking-level")).toExist(),
      sceneExpect(selector("#llm-thinking-level")).toBeDisabled(),
      sceneExpect(selector("#llm-extra-args")).toExist(),
      type(selector("#llm-base-url"), "https://api.example.com/v1"),
      type(selector("#llm-models"), "gpt-4o-mini"),
      change(selector("#llm-streaming"), "false"),
      change(selector("#llm-tool-calls"), "false"),
      change(selector("#llm-thinking-preset"), "enable-thinking"),
      sceneExpect(selector("#llm-thinking-level")).toBeEnabled(),
      type(selector("#llm-extra-args"), '{"temperature": 0.2}'),
      change(selector("#llm-active-model"), "gpt-4o-mini"),
      change(selector("#llm-thinking-level"), "true"),
      sceneExpect(selector("#btn-test-llm-models")).toExist(),
      sceneExpect(selector("#btn-test-llm-chat")).toExist(),
      sceneExpect(selector("#btn-test-llm-tools")).toExist(),
      click(selector("#btn-test-llm-chat")),
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
          thinkingParam: "enable_thinking",
          thinkingLevels: "Aus=false, An=true",
          extraArgs: '{"temperature": 0.2}',
          model: "gpt-4o-mini",
          thinkingLevel: "true",
        }),
      ),
      Command.resolve(
        TestLlm,
        Message.SucceededTestLlm({ content: "ok", reasoning: "Kurzer Gedanke", models: [] }),
      ),
      sceneExpect(selector("#llm-test-status.is-ok")).toExist(),
      sceneExpect(selector("#llm-test-result .llm-response-thinking")).toContainText(
        "Kurzer Gedanke",
      ),
      sceneExpect(selector("#llm-test-result .llm-response-content")).toContainText("ok"),
    )
  })

  it("zeigt Streaming-Chunks sofort während der laufenden Antwort an", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        isSettingsDialogOpen: true,
        llmDraftEnabled: true,
        llmDraftBaseUrl: "https://api.example.com/v1",
        llmDraftModels: "gpt-4o-mini",
        llmTestState: LlmTestState.Streaming({ mode: "chat", content: "Hal", reasoning: "Denke" }),
      }),
      sceneExpect(selector("#llm-test-result .llm-response-thinking")).toContainText("Denke"),
      sceneExpect(selector("#llm-test-result .llm-response-content")).toContainText("Hal"),
      sceneExpect(selector("#llm-test-result .llm-response-streaming")).toContainText("Schreibt …"),
    )
  })

  it("zeigt Human-Names für Modelle im Dropdown an und übergibt die Modell-ID als Wert", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        isSettingsDialogOpen: true,
        llmDraftEnabled: true,
        llmDraftBaseUrl: "https://api.example.com/v1",
        llmDraftModels: "Schnell=gpt-4o-mini, Lokal=qwen3",
      }),
      sceneExpect(selector('#llm-active-model option[value="gpt-4o-mini"]')).toHaveText("Schnell"),
      sceneExpect(selector('#llm-active-model option[value="qwen3"]')).toHaveText("Lokal"),
    )
  })

  it("ersetzt Abbrechen im Text-Editor durch Zurück/History/Vor und unterstützt Undo/Redo", () => {
    const modelWithEditFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: "<p>Original</p>" }),
          maybeValidationError: Option.none(),
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

    scene(
      { update, view },
      given(modelWithEditFile),
      sceneExpect(selector("#modal-btn-cancel")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-undo")).toExist(),
      sceneExpect(selector("#modal-btn-history")).toExist(),
      sceneExpect(selector("#modal-btn-redo")).toExist(),
      sceneExpect(selector("#modal-btn-redo")).toBeDisabled(),
      type(selector("#modal-file-content"), "<p>Bearbeitet</p>"),
      Command.expectNone(),
      sceneExpect(selector("#modal-file-content")).toHaveValue("<p>Bearbeitet</p>"),
      click(selector("#modal-btn-undo")),
      Command.expectNone(),
      sceneExpect(selector("#modal-file-content")).toHaveValue("<p>Original</p>"),
      sceneExpect(selector("#modal-btn-redo")).not.toBeDisabled(),
      click(selector("#modal-btn-redo")),
      Command.expectNone(),
      sceneExpect(selector("#modal-file-content")).toHaveValue("<p>Bearbeitet</p>"),
    )
  })

  it("lädt ältere Versionen aus OPFS erst bei Klick auf Zurück und Verlauf erst bei Klick auf History", () => {
    const modelWithEditFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: "<p>Aktuell</p>" }),
          maybeValidationError: Option.none(),
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

    scene(
      { update, view },
      given(modelWithEditFile),
      click(selector("#modal-btn-undo")),
      Command.resolve(
        Editor.LoadPreviousHistoryEntry,
        Editor.Message.SucceededLoadPreviousHistoryEntry({
          maybeEntry: Option.some({ content: "<p>Vorher</p>", startOffset: 10 }),
        }),
      ),
      sceneExpect(selector("#modal-file-content")).toHaveValue("<p>Vorher</p>"),
      click(selector("#modal-btn-history")),
      Command.resolve(
        Editor.LoadFullHistory,
        Editor.Message.SucceededLoadFullHistory({
          isHistoryEnabled: true,
          entries: [
            {
              offset: 10,
              endOffset: 35,
              timestampMs: 1731580000000,
              ...History.hashAndMeasureHistoryContent("<p>Vorher</p>"),
            },
            {
              offset: 0,
              endOffset: 10,
              timestampMs: 1731570000000,
              byteLength: 10,
              contentHash: 222,
            },
          ],
        }),
      ),
      sceneExpect(selector("#editor-history-overlay")).toExist(),
      sceneExpect(selector(".editor-history-item.is-current")).toExist(),
      sceneExpect(selector("#editor-history-enabled-checkbox")).toBeChecked(),
      change(selector("#editor-history-enabled-checkbox"), "false"),
      Command.resolve(Editor.SaveHistoryEnabled, Editor.Message.CompletedSaveHistoryEnabled()),
      sceneExpect(selector("#editor-history-enabled-checkbox")).not.toBeChecked(),
      change(selector("#editor-history-enabled-checkbox"), "true"),
      Command.resolve(Editor.SaveHistoryEnabled, Editor.Message.CompletedSaveHistoryEnabled()),
      sceneExpect(selector("#editor-history-enabled-checkbox")).toBeChecked(),
      click(selector(".editor-history-preview-btn")),
      Command.resolve(
        Editor.LoadHistoryPreviewAt,
        Editor.Message.SucceededLoadHistoryPreviewAt({
          maybeContent: Option.some("<h1>Alte Vorschau</h1>"),
        }),
      ),
      sceneExpect(selector("#editor-preview-overlay")).toExist(),
      sceneExpect(selector("#editor-preview-iframe")).toHaveAttr(
        "srcdoc",
        "<h1>Alte Vorschau</h1>",
      ),
      click(selector("#editor-preview-close")),
      sceneExpect(selector("#editor-preview-overlay")).toBeAbsent(),
      sceneExpect(selector("#editor-history-overlay")).toExist(),
      click(selector(".editor-history-restore-btn")),
      Command.resolve(
        Editor.LoadHistoryEntryAt,
        Editor.Message.SucceededLoadHistoryEntryAt({
          maybeContent: Option.some("<p>Wiederhergestellt</p>"),
        }),
      ),
      sceneExpect(selector("#editor-history-overlay")).toBeAbsent(),
      sceneExpect(selector("#modal-file-content")).toHaveValue("<p>Wiederhergestellt</p>"),
      click(selector("#modal-btn-history")),
      Command.resolve(
        Editor.LoadFullHistory,
        Editor.Message.SucceededLoadFullHistory({
          isHistoryEnabled: true,
          entries: [
            {
              offset: 10,
              endOffset: 35,
              timestampMs: 1731580000000,
              byteLength: 13,
              contentHash: 111,
            },
            {
              offset: 0,
              endOffset: 10,
              timestampMs: 1731570000000,
              byteLength: 10,
              contentHash: 222,
            },
          ],
        }),
      ),
      click(selector("#editor-history-delete-latest-btn")),
      Command.resolve(
        Editor.DeleteLatestFileHistoryEntry,
        Editor.Message.SucceededDeleteLatestHistoryEntry(),
      ),
      sceneExpect(selector(".editor-history-item .editor-history-hash")).toHaveText("000000de"),
      click(selector("#editor-history-clear-btn")),
      Command.expectNone(),
      sceneExpect(selector("#editor-history-clear-confirm")).toExist(),
      click(selector("#editor-history-clear-confirm-btn")),
      Command.resolve(Editor.ClearFileHistory, Editor.Message.SucceededClearHistory()),
      sceneExpect(selector(".editor-history-empty")).toContainText(
        "Noch keine gespeicherten Versionen vorhanden.",
      ),
    )
  })

  it("blendet Zurück und Vor aus, wenn Versionsspeichern aus und kein Verlauf vorhanden ist", () => {
    const modelWithEmptyHistory: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "app.html",
          name: "app.html",
          fileMode: EditorFileMode.Text({ content: "<p>Hallo</p>" }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Closed",
          llmChatInput: "",
          llmChatMessages: [],
          llmChatDisplay: [],
          llmChatState: Editor.LlmChatState.Idle(),
          isMaximized: false,
          isEditingName: false,
          isPreviewOpen: false,
          editorSplitPercent: 42,
          editorSplitDrag: Option.none(),
          undoStack: [],
          redoStack: [],
          maybeOpfsHistoryCursor: Option.none(),
          historyState: Editor.HistoryState.Closed(),
          isHistoryEnabled: false,
          hasHistoryEntries: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(modelWithEmptyHistory),
      sceneExpect(selector("#modal-btn-undo")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-redo")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-history")).toExist(),
      click(selector("#modal-btn-history")),
      Command.resolve(
        Editor.LoadFullHistory,
        Editor.Message.SucceededLoadFullHistory({
          isHistoryEnabled: false,
          entries: [],
        }),
      ),
      change(selector("#editor-history-enabled-checkbox"), "true"),
      Command.resolve(Editor.SaveHistoryEnabled, Editor.Message.CompletedSaveHistoryEnabled()),
      sceneExpect(selector("#modal-btn-undo")).toExist(),
      sceneExpect(selector("#modal-btn-redo")).toExist(),
    )
  })

  it("schließt den Editor beim Speichern nicht, wenn er maximiert ist", () => {
    const modelWithMaximizedEditFile: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "index.html",
          name: "index.html",
          fileMode: EditorFileMode.Text({ content: "<p>Original</p>" }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Closed",
          llmChatInput: "",
          llmChatMessages: [],
          llmChatDisplay: [],
          llmChatState: Editor.LlmChatState.Idle(),
          isMaximized: true,
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

    scene(
      { update, view },
      given(modelWithMaximizedEditFile),
      click(selector("#modal-btn-save")),
      Command.resolve(Editor.SaveChanges, Editor.Message.SucceededSaveChanges({ entries: [] })),
      sceneExpect(selector(".modal-overlay")).toExist(),
      sceneExpect(selector("#modal-file-content")).toHaveValue("<p>Original</p>"),
      sceneExpect(selector("#toast-container .toast.alert-info")).toContainText("Gespeichert."),
      Command.resolve(WaitBeforeDismissToast, Message.CompletedWaitBeforeDismissToast({ id: 1 })),
      sceneExpect(selector("#toast-container .toast")).toBeAbsent(),
    )
  })

  it("schließt einen Fehler-Toast beim Klick auf den Schließen-Button", () => {
    const modelWithDangerToast: Model = {
      ...readyModel,
      toasts: [
        {
          id: 1,
          message: "Speichern fehlgeschlagen",
          variant: "danger",
        },
      ],
      nextToastId: 2,
    }

    scene(
      { update, view },
      given(modelWithDangerToast),
      sceneExpect(selector("#toast-container .toast.alert-danger")).toContainText(
        "Speichern fehlgeschlagen",
      ),
      click(selector("#toast-container .alert-close-btn")),
      sceneExpect(selector("#toast-container .toast")).toBeAbsent(),
    )
  })

  it("erlaubt in den Einstellungen alle Versionen zu löschen", () => {
    scene(
      { update, view },
      given(readyModel),
      click(selector("#btn-settings")),
      click(selector("#btn-open-settings")),
      sceneExpect(selector("#settings-history-enabled")).toBeChecked(),
      change(selector("#settings-history-enabled"), "false"),
      Command.resolve(
        SaveHistoryEnabledPreference,
        Message.CompletedSaveHistoryEnabledPreference(),
      ),
      sceneExpect(selector("#settings-history-enabled")).not.toBeChecked(),
      sceneExpect(selector("#btn-clear-all-history")).toExist(),
      click(selector("#btn-clear-all-history")),
      sceneExpect(selector("#clear-all-history-confirm")).toExist(),
      click(selector("#btn-clear-all-history-confirm")),
      Command.resolve(ClearAllHistory, Message.SucceededClearAllHistory()),
      sceneExpect(selector("#clear-all-history-done")).toContainText(
        "Alle Versionen wurden gelöscht.",
      ),
    )
  })
})
