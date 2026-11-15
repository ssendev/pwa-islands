import { Effect, Option } from "effect"
import {
  Command,
  CustomElement,
  Subscription,
  change,
  click,
  doubleClick,
  expect as sceneExpect,
  expectIgnored,
  given,
  keydown,
  scene,
  selector,
  text,
  type,
} from "foldkit/scene"
import { describe, expect, it } from "vitest"
import { hashLine } from "./hashline"
import { monacoEditorElement } from "./monaco-element"
import {
  ActivateOpfsBackend,
  ClearAllHistory,
  ClearAllHistoryState,
  EntriesState,
  InstallPrompt,
  LoadEditorLlmModels,
  Message,
  type Model,
  NavigateHistoryBack,
  PickLocalDirectory,
  PushUrl,
  RefreshEntries,
  ReplaceUrl,
  SavedBackend,
  SaveEditorPreferences,
  SaveApiHistoryEnabledPreference,
  SaveAppTheme,
  SaveHistoryEnabledPreference,
  SaveLlmSettings,
  SaveMonacoSettings,
  ScrollEditorLlmChatToBottomIfAtBottom,
  StorageState,
  TestLlm,
  ToggleFullscreenWindow,
  WaitBeforeDismissToast,
  CopyToastMessage,
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
  hasLanguageModel: false,
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
  isEditingLlmSettings: false,
  isConfirmingDeleteLlmProvider: false,
  editingLlmProviderId: Option.none(),
  llmProviders: [],
  llmActiveProviderId: "",
  llmDraftName: "",
  llmDraftProviderEnabled: true,
  llmDraftProviderEditFormat: "",
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
  apiHistoryEnabled: true,
  appTheme: "system",
  editorLineNumbers: true,
  editorFolding: true,
  editorWordWrap: true,
  editorScrollBeyondLastLine: false,
  editorTheme: "system",
  editorLineDecorationsWidth: 10,
  editorLineNumbersMinChars: 5,
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
      CustomElement.emit(monacoEditorElement, selector("#modal-file-content"), "content-changed", {
        value: "<h1>Hallo Welt</h1>",
      }),
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
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
      sceneExpect(selector("#modal-llm-mode-select")).toHaveAttr("data-mode", "Closed"),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveText("▾"),
      sceneExpect(selector("#modal-llm-mode-menu-list")).toHaveAttr("hidden", "true"),
      sceneExpect(selector("#modal-llm-mode-option-Chat")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      click(selector("#modal-llm-mode-select")),
      sceneExpect(selector("#modal-llm-mode-menu-list")).toBeVisible(),
      sceneExpect(selector("#modal-llm-mode-option-Closed")).toContainText("Bearbeiten"),
      sceneExpect(selector("#modal-llm-mode-option-Copy")).toContainText("Kopieren"),
      click(selector("#modal-llm-mode-option-Copy")),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-btn-copy-dts")).toExist(),
      sceneExpect(selector("#modal-btn-copy-dts")).toContainText("/app.d.ts"),
      sceneExpect(selector("#modal-btn-copy-llm")).toContainText("Mit Anleitung"),
      sceneExpect(selector("#modal-btn-copy-hashes")).toContainText("Datei"),
      sceneExpect(selector("#modal-btn-paste-llm")).toContainText("Einfügen"),
      sceneExpect(selector("#modal-btn-preview")).toContainText("Vorschau"),
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
      sceneExpect(selector("#modal-llm-mode-select")).toHaveAttr("data-mode", "Closed"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-preview")).toExist(),
      click(selector("#modal-llm-mode-select")),
      sceneExpect(selector("#modal-llm-mode-option-Chat")).toContainText("Chat"),
      click(selector("#modal-llm-mode-option-Chat")),
      Command.resolveAll(
        [SaveEditorPreferences, Message.CompletedSaveEditorPreferences()],
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
      ),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveAttr("data-mode", "Chat"),
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
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Copy")),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveAttr("data-mode", "Copy"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toExist(),
      sceneExpect(selector("#modal-btn-copy-llm")).toExist(),
      sceneExpect(selector("#modal-btn-copy-hashes")).toExist(),
      sceneExpect(selector("#modal-btn-paste-llm")).toExist(),
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Closed")),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-mode-select")).toHaveAttr("data-mode", "Closed"),
      sceneExpect(selector("#modal-llm-chat-input")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-copy-dts")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-preview")).toExist(),
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
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Chat")),
      Command.resolveAll(
        [SaveEditorPreferences, Message.CompletedSaveEditorPreferences()],
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
      ),
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
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Chat")),
      Command.resolveAll(
        [SaveEditorPreferences, Message.CompletedSaveEditorPreferences()],
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
      ),
      type(selector("#modal-llm-chat-input"), "Füge Titel hinzu"),
      keydown(selector("#modal-llm-chat-input"), "Enter", { shiftKey: true }),
      expectIgnored(),
      sceneExpect(selector("#modal-llm-chat-input")).toHaveValue("Füge Titel hinzu"),
      keydown(selector("#modal-llm-chat-input"), "Enter"),
      Command.resolveAll(
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
        [LoadEditorLlmModels, Message.SucceededLoadEditorLlmModels({ models: ["gpt-4o"] })],
      ),
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
      Command.resolve(
        ScrollEditorLlmChatToBottomIfAtBottom,
        Message.CompletedScrollEditorLlmChatToBottom(),
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
      Command.resolve(
        ScrollEditorLlmChatToBottomIfAtBottom,
        Message.CompletedScrollEditorLlmChatToBottom(),
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
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Chat")),
      Command.resolveAll(
        [SaveEditorPreferences, Message.CompletedSaveEditorPreferences()],
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
      ),
      type(selector("#modal-llm-chat-input"), "Erkläre kurz"),
      click(selector("#modal-btn-send-llm")),
      Command.resolveAll(
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
        [LoadEditorLlmModels, Message.SucceededLoadEditorLlmModels({ models: ["gpt-4o"] })],
      ),
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
      Command.resolve(
        ScrollEditorLlmChatToBottomIfAtBottom,
        Message.CompletedScrollEditorLlmChatToBottom(),
      ),
      sceneExpect(selector("#modal-llm-chat-history")).toContainText("Teilantwort"),
      click(selector("#modal-btn-send-llm")),
      Command.resolve(
        Editor.ScrollLlmChatToBottomIfAtBottom,
        Editor.Message.CompletedScrollLlmChatToBottom(),
      ),
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
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Chat")),
      Command.resolveAll(
        [SaveEditorPreferences, Message.CompletedSaveEditorPreferences()],
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
      ),
      type(selector("#modal-llm-chat-input"), "Erkläre Fehler"),
      click(selector("#modal-btn-send-llm")),
      Command.resolveAll(
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
        [LoadEditorLlmModels, Message.SucceededLoadEditorLlmModels({ models: ["gpt-4o"] })],
      ),
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
      Command.resolve(
        ScrollEditorLlmChatToBottomIfAtBottom,
        Message.CompletedScrollEditorLlmChatToBottom(),
      ),
      Subscription.emit(
        Message.FailedEditorLlmChat({
          message: "HTTP 500",
        }),
      ),
      Command.resolve(
        ScrollEditorLlmChatToBottomIfAtBottom,
        Message.CompletedScrollEditorLlmChatToBottom(),
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
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
      canUndo: false,
      canRedo: false,
      historyState: Editor.HistoryState.Closed(),
      isConfirmingDelete: false,
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
      sceneExpect(selector("#modal-btn-delete")).toBeAbsent(),
      sceneExpect(selector(".modal-footer #modal-btn-preview")).toExist(),
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Copy")),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-btn-delete")).toBeAbsent(),
      sceneExpect(selector(".modal-footer #modal-btn-preview")).toExist(),
      sceneExpect(selector("#editor-preview-overlay")).toBeAbsent(),
      click(selector("#modal-btn-preview")),
      Command.expectExact(PushUrl({ url: "/index.html?pwaislands=edit-preview" })),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#editor-preview-overlay")).toExist(),
      sceneExpect(selector("#editor-preview-iframe")).toExist(),
      sceneExpect(selector("#editor-preview-iframe")).toHaveAttr("srcdoc", "<p>Test</p>"),
      sceneExpect(selector("#editor-preview-close")).toExist(),
      sceneExpect(selector("#editor-preview-close")).toHaveAttr("aria-label", "Vorschau schließen"),
      click(selector("#editor-preview-close")),
      Command.expectExact(NavigateHistoryBack()),
      Command.resolve(NavigateHistoryBack, Message.CompletedNavigateHistoryBack()),
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(modelWithEditFile),
      sceneExpect(selector(".modal-title")).toHaveText("Datei bearbeiten: index.html"),
      sceneExpect(selector("#modal-file-name")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-delete")).toBeAbsent(),
      sceneExpect(text("Inhalt:")).toBeAbsent(),
      click(selector("#modal-btn-edit-name")),
      Command.resolve(Editor.FocusNameInput, Editor.Message.CompletedFocusNameInput()),
      sceneExpect(selector("#modal-file-name")).toExist(),
      sceneExpect(selector(".modal-name-row #modal-btn-delete")).toExist(),
      sceneExpect(selector(".modal-footer #modal-btn-delete")).toBeAbsent(),
      click(selector("#modal-btn-delete")),
      sceneExpect(selector("#modal-confirm-delete-title")).toHaveText("Eintrag löschen"),
      sceneExpect(selector("#modal-title")).toHaveText("Datei bearbeiten: index.html"),
      sceneExpect(selector("#modal-file-name")).toExist(),
      sceneExpect(text(/wirklich unwiderruflich löschen\?/)).toExist(),
      click(selector("#modal-btn-cancel-delete")),
      sceneExpect(selector("#modal-confirm-delete-title")).toBeAbsent(),
      sceneExpect(selector("#modal-title")).toHaveText("Datei bearbeiten: index.html"),
      sceneExpect(selector("#modal-file-name")).toExist(),
      click(selector("#modal-btn-delete")),
      sceneExpect(selector("#modal-confirm-delete-title")).toHaveText("Eintrag löschen"),
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
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
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
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
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
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
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
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
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
      hasDirectoryPicker: true,
      hasOPFS: true,
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
      sceneExpect(selector('[data-support="opfs"] .help-supported')).toHaveAttr(
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
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#llm-edit-format")).toExist(),
      sceneExpect(selector("#llm-edit-format")).toHaveValue("hashline"),
      sceneExpect(selector("#btn-add-llm-provider")).toExist(),
      sceneExpect(selector("#btn-edit-llm-settings")).toBeAbsent(),
      sceneExpect(selector("#llm-base-url")).toBeAbsent(),
      change(selector("#llm-edit-format"), "search-replace"),
      Command.resolve(SaveLlmSettings, Message.CompletedSaveLlmSettings()),
      sceneExpect(selector("#llm-edit-format")).toHaveValue("search-replace"),
      change(selector("#llm-edit-format"), "hashline"),
      Command.resolve(SaveLlmSettings, Message.CompletedSaveLlmSettings()),
      click(selector("#btn-add-llm-provider")),
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

  it("aktiviert Chat im Editor automatisch, wenn LanguageModel-API erkannt wurde, und bietet natives Modell neben API-Modellen an", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        hasLanguageModel: true,
        llmEnabled: false,
        editorLlmBarMode: "Chat",
        modalState: ModalState.Editor({
          editor: {
            ...Editor.makeCreateFile(),
            llmBarMode: "Chat",
          },
        }),
      }),
      sceneExpect(selector("#modal-llm-mode-option-Chat")).toExist(),
      sceneExpect(selector("#modal-llm-chat-input")).toExist(),
      sceneExpect(selector("#modal-llm-model-select")).toHaveValue("__language_model__"),
      sceneExpect(
        selector("#modal-llm-model-select option[value='__language_model__']"),
      ).toContainText("Browser-KI"),
    )

    scene(
      { update, view },
      given({
        ...readyModel,
        hasLanguageModel: true,
        llmEnabled: true,
        llmModels: "gpt-4o, qwen3",
        llmModel: "gpt-4o",
        editorLlmBarMode: "Chat",
        modalState: ModalState.Editor({
          editor: {
            ...Editor.makeCreateFile(),
            llmBarMode: "Chat",
          },
        }),
      }),
      sceneExpect(selector("#modal-llm-model-select option[value='gpt-4o']")).toExist(),
      sceneExpect(selector("#modal-llm-model-select option[value='qwen3']")).toExist(),
      sceneExpect(selector("#modal-llm-model-select option[value='__language_model__']")).toExist(),
      change(selector("#modal-llm-model-select"), "__language_model__"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-model-select")).toHaveValue("__language_model__"),
    )
  })

  it("zeigt bei aktivierter API in den Einstellungen sowohl API-Modelle als auch das native Modell zur Auswahl", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        hasLanguageModel: true,
        isSettingsDialogOpen: true,
        isEditingLlmSettings: true,
        llmDraftEnabled: true,
        llmDraftBaseUrl: "",
        llmDraftModels: "gpt-4o-mini",
      }),
      sceneExpect(selector("#llm-native-detected-hint")).toExist(),
      sceneExpect(selector("#llm-active-model option[value='gpt-4o-mini']")).toExist(),
      sceneExpect(selector("#llm-active-model option[value='__language_model__']")).toExist(),
      sceneExpect(selector("#btn-test-llm-chat")).toBeDisabled(),
      change(selector("#llm-active-model"), "__language_model__"),
      sceneExpect(selector("#btn-test-llm-chat")).toBeEnabled(),
      sceneExpect(selector("#btn-test-llm-models")).toBeDisabled(),
      sceneExpect(selector("#btn-test-llm-tools")).toBeDisabled(),
    )
  })

  it("zeigt Streaming-Chunks sofort während der laufenden Antwort an", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        isSettingsDialogOpen: true,
        isEditingLlmSettings: true,
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

  it("zeigt in den KI-Einstellungen zunächst Bearbeitungsformat, Chat-API aktivieren und URL und öffnet den Rest per Bearbeiten-Button", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        llmEnabled: true,
        llmBaseUrl: "https://api.example.com/v1",
        llmActiveProviderId: "provider-1",
        llmProviders: [
          {
            id: "provider-1",
            name: "OpenAI",
            enabled: true,
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            models: "",
            editFormat: "hashline",
            streaming: true,
            toolCalls: true,
            thinkingParam: "",
            thinkingLevels: "",
            extraArgs: "",
          },
        ],
      }),
      click(selector("#btn-settings")),
      click(selector("#btn-open-settings")),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#llm-edit-format")).toExist(),
      sceneExpect(selector(".llm-provider-toggle input")).toBeChecked(),
      sceneExpect(selector(".llm-provider-url")).toHaveText("https://api.example.com/v1"),
      sceneExpect(selector("#llm-base-url")).toBeAbsent(),
      sceneExpect(selector("#llm-api-key")).toBeAbsent(),
      sceneExpect(selector("#llm-models")).toBeAbsent(),
      click(selector(".llm-provider-actions button")),
      sceneExpect(selector("#llm-api-key")).toExist(),
      sceneExpect(selector("#llm-models")).toExist(),
      sceneExpect(selector("#llm-base-url")).toHaveValue("https://api.example.com/v1"),
    )
  })

  it("zeigt Human-Names für Modelle im Dropdown an und übergibt die Modell-ID als Wert", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        isSettingsDialogOpen: true,
        isEditingLlmSettings: true,
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(modelWithEditFile),
      sceneExpect(selector("#modal-btn-cancel")).toBeAbsent(),
      sceneExpect(selector("#modal-btn-undo")).toExist(),
      sceneExpect(selector("#modal-btn-undo")).toBeDisabled(),
      sceneExpect(selector("#modal-btn-history")).toExist(),
      sceneExpect(selector("#modal-btn-redo")).toExist(),
      sceneExpect(selector("#modal-btn-redo")).toBeDisabled(),
      CustomElement.emit(monacoEditorElement, selector("#modal-file-content"), "history-changed", {
        canUndo: true,
        canRedo: false,
      }),
      Command.expectNone(),
      sceneExpect(selector("#modal-btn-undo")).not.toBeDisabled(),
      sceneExpect(selector("#modal-btn-redo")).toBeDisabled(),
      click(selector("#modal-btn-undo")),
      Command.resolve(Editor.TriggerEditorUndo, Editor.Message.CompletedTriggerEditorUndo()),
      CustomElement.emit(monacoEditorElement, selector("#modal-file-content"), "history-changed", {
        canUndo: false,
        canRedo: true,
      }),
      Command.expectNone(),
      sceneExpect(selector("#modal-btn-undo")).toBeDisabled(),
      sceneExpect(selector("#modal-btn-redo")).not.toBeDisabled(),
      click(selector("#modal-btn-redo")),
      Command.resolve(Editor.TriggerEditorRedo, Editor.Message.CompletedTriggerEditorRedo()),
    )
  })

  it("lädt den Verlauf aus OPFS erst bei Klick auf History", () => {
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(modelWithEditFile),
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
              ...History.hashAndMeasureHistoryContent("<p>Aktuell</p>"),
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
          maybeContent: Option.some(
            Editor.HistoryPreview.Text({ content: "<h1>Alte Vorschau</h1>" }),
          ),
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
      Command.expectNone(),
      sceneExpect(selector("#editor-history-delete-latest-confirm")).toExist(),
      click(selector("#editor-history-delete-latest-confirm-btn")),
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

  it("zeigt Zurück und Vor als Monaco-Undo/Redo auch an, wenn Versionsspeichern aus ist", () => {
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isHistoryEnabled: false,
          hasHistoryEntries: false,
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(modelWithEmptyHistory),
      sceneExpect(selector("#modal-btn-undo")).toExist(),
      sceneExpect(selector("#modal-btn-undo")).toBeDisabled(),
      sceneExpect(selector("#modal-btn-redo")).toExist(),
      sceneExpect(selector("#modal-btn-redo")).toBeDisabled(),
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
      sceneExpect(selector("#modal-btn-undo")).toBeDisabled(),
      sceneExpect(selector("#modal-btn-redo")).toExist(),
      sceneExpect(selector("#modal-btn-redo")).toBeDisabled(),
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
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

  it("speichert die Datei bei save-requested aus dem Monaco-Editor (Strg+S)", () => {
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
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(modelWithMaximizedEditFile),
      CustomElement.emit(
        monacoEditorElement,
        selector("#modal-file-content"),
        "save-requested",
        {},
      ),
      Command.resolve(Editor.SaveChanges, Editor.Message.SucceededSaveChanges({ entries: [] })),
      sceneExpect(selector("#toast-container .toast.alert-info")).toContainText("Gespeichert."),
      Command.resolve(WaitBeforeDismissToast, Message.CompletedWaitBeforeDismissToast({ id: 1 })),
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
          count: 2,
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
      sceneExpect(selector("#toast-container .toast-actions .toast-repeat-count")).toHaveText("2×"),
      click(selector("#toast-container .toast-actions .toast-copy-btn")),
      Command.expectExact(CopyToastMessage({ message: "Speichern fehlgeschlagen" })),
      Command.resolve(CopyToastMessage, Message.CompletedCopyToast()),
      click(selector("#toast-container .toast-actions .alert-close-btn")),
      sceneExpect(selector("#toast-container .toast")).toBeAbsent(),
    )
  })

  it("erlaubt in den Einstellungen alle Versionen zu löschen", () => {
    scene(
      { update, view },
      given(readyModel),
      click(selector("#btn-settings")),
      click(selector("#btn-open-settings")),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#settings-history-enabled")).toBeChecked(),
      change(selector("#settings-history-enabled"), "false"),
      Command.resolve(
        SaveHistoryEnabledPreference,
        Message.CompletedSaveHistoryEnabledPreference(),
      ),
      sceneExpect(selector("#settings-history-enabled")).not.toBeChecked(),
      sceneExpect(selector("#settings-api-history-enabled")).toBeChecked(),
      change(selector("#settings-api-history-enabled"), "false"),
      Command.resolve(
        SaveApiHistoryEnabledPreference,
        Message.CompletedSaveApiHistoryEnabledPreference(),
      ),
      sceneExpect(selector("#settings-api-history-enabled")).not.toBeChecked(),
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

  it("öffnet den Versionsverlauf im Editor auch für Binärdateien", () => {
    const binaryEditorModel: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "logo.png",
          name: "logo.png",
          fileMode: EditorFileMode.Binary({
            preview: PreviewContent.None(),
            edit: BinaryEdit.Disabled(),
          }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Closed",
          isLlmModeMenuOpen: false,
          llmChatInput: "",
          llmChatMessages: [],
          llmChatDisplay: [],
          llmChatState: Editor.LlmChatState.Idle(),
          isMaximized: false,
          isEditingName: false,
          isPreviewOpen: false,
          editorSplitPercent: readyModel.editorSplitPercent,
          editorSplitDrag: Option.none(),
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isHistoryEnabled: true,
          hasHistoryEntries: true,
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(binaryEditorModel),
      sceneExpect(selector("#modal-btn-history")).toExist(),
      click(selector("#modal-btn-history")),
      Command.resolve(
        Editor.LoadFullHistory,
        Editor.Message.SucceededLoadFullHistory({
          entries: [
            {
              offset: 0,
              endOffset: 32,
              timestampMs: 1_700_000_000_000,
              byteLength: 16,
              contentHash: 0x1234abcd,
            },
          ],
          isHistoryEnabled: true,
        }),
      ),
      sceneExpect(selector("#editor-history-overlay")).toExist(),
      sceneExpect(selector(".editor-history-preview-btn")).toExist(),
      sceneExpect(selector(".editor-history-restore-btn")).toExist(),
      click(selector(".editor-history-preview-btn")),
      Command.resolve(
        Editor.LoadHistoryPreviewAt,
        Editor.Message.SucceededLoadHistoryPreviewAt({
          maybeContent: Option.some(
            Editor.HistoryPreview.Image({ objectUrl: "blob:history-logo" }),
          ),
        }),
      ),
      sceneExpect(selector("#editor-preview-overlay")).toExist(),
      sceneExpect(selector("#editor-preview-image")).toHaveAttr("src", "blob:history-logo"),
    )

    const nonPreviewableBinaryModel: Model = {
      ...readyModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "archive.bin",
          name: "archive.bin",
          fileMode: EditorFileMode.Binary({
            preview: PreviewContent.None(),
            edit: BinaryEdit.Disabled(),
          }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Closed",
          isLlmModeMenuOpen: false,
          llmChatInput: "",
          llmChatMessages: [],
          llmChatDisplay: [],
          llmChatState: Editor.LlmChatState.Idle(),
          isMaximized: false,
          isEditingName: false,
          isPreviewOpen: false,
          editorSplitPercent: readyModel.editorSplitPercent,
          editorSplitDrag: Option.none(),
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Closed(),
          isHistoryEnabled: true,
          hasHistoryEntries: true,
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(nonPreviewableBinaryModel),
      click(selector("#modal-btn-history")),
      Command.resolve(
        Editor.LoadFullHistory,
        Editor.Message.SucceededLoadFullHistory({
          entries: [
            {
              offset: 0,
              endOffset: 32,
              timestampMs: 1_700_000_000_000,
              byteLength: 16,
              contentHash: 0x1234abcd,
            },
          ],
          isHistoryEnabled: true,
        }),
      ),
      sceneExpect(selector("#editor-history-overlay")).toExist(),
      sceneExpect(selector(".editor-history-preview-btn")).toBeAbsent(),
      sceneExpect(selector(".editor-history-restore-btn")).toExist(),
    )
  })

  it("zeigt Versionen-Button in der Dateiliste und kennzeichnet gelöschte Dateien am Editor-Button", () => {
    const entriesWithHistoryModel: Model = {
      ...readyModel,
      storageState: StorageState.Ready({
        rootName: "Projekte",
        storageType: "opfs",
        subPath: [],
        entriesState: EntriesState.Loaded({
          entries: [
            {
              id: "file:index.html",
              name: "index.html",
              kind: "file",
              maybeSize: Option.some(100),
              maybeLastModified: Option.none(),
              hasHistory: true,
            },
            {
              id: "deleted:gone.html",
              name: "gone.html",
              kind: "file",
              maybeSize: Option.none(),
              maybeLastModified: Option.none(),
              hasHistory: true,
              isDeleted: true,
            },
          ],
        }),
        otherBackend: SavedBackend.Unsupported(),
      }),
    }

    scene(
      { update, view },
      given(entriesWithHistoryModel),
      sceneExpect(selector('.btn-entry-history[data-entry="index.html"]')).toExist(),
      sceneExpect(selector('.btn-edit-entry[data-entry="index.html"]')).toContainText("Bearbeiten"),
      sceneExpect(selector('.btn-entry-history[data-entry="gone.html"]')).toExist(),
      sceneExpect(selector('.btn-edit-entry.is-deleted[data-entry="gone.html"]')).toBeDisabled(),
      sceneExpect(selector('.btn-edit-entry[data-entry="gone.html"]')).toContainText("Gelöscht"),
      click(selector('.btn-entry-history[data-entry="gone.html"]')),
      Command.expectExact(PushUrl({ url: "/gone.html?pwaislands=history" })),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
    )

    const historyOnlyModel: Model = {
      ...entriesWithHistoryModel,
      modalState: ModalState.Editor({
        editor: Editor.Model.EditFile({
          originalName: "gone.html",
          name: "gone.html",
          fileMode: EditorFileMode.Binary({
            preview: PreviewContent.None(),
            edit: BinaryEdit.Disabled(),
          }),
          maybeValidationError: Option.none(),
          maybePasteError: Option.none(),
          llmBarMode: "Closed",
          isLlmModeMenuOpen: false,
          llmChatInput: "",
          llmChatMessages: [],
          llmChatDisplay: [],
          llmChatState: Editor.LlmChatState.Idle(),
          isMaximized: false,
          isEditingName: false,
          isPreviewOpen: false,
          editorSplitPercent: readyModel.editorSplitPercent,
          editorSplitDrag: Option.none(),
          canUndo: false,
          canRedo: false,
          historyState: Editor.HistoryState.Open({
            entries: [
              {
                offset: 0,
                endOffset: 32,
                timestampMs: 1_700_000_000_000,
                byteLength: 16,
                contentHash: 0x1234abcd,
              },
            ],
            isConfirmingClear: false,
            isHistoryEnabled: true,
            maybePreviewContent: Option.none(),
          }),
          isHistoryEnabled: true,
          hasHistoryEntries: true,
          isHistoryOnly: true,
          isDeletedHistory: true,
          isConfirmingDelete: false,
        }),
      }),
    }

    scene(
      { update, view },
      given(historyOnlyModel),
      sceneExpect(selector("#editor-history-overlay")).toExist(),
      sceneExpect(selector("#modal-form")).toBeAbsent(),
      sceneExpect(selector(".editor-history-preview-btn")).toExist(),
      click(selector(".editor-history-preview-btn")),
      Command.resolve(
        Editor.LoadHistoryPreviewAt,
        Editor.Message.SucceededLoadHistoryPreviewAt({
          maybeContent: Option.some(
            Editor.HistoryPreview.Text({ content: "<h1>Gelöschte Vorschau</h1>" }),
          ),
        }),
      ),
      sceneExpect(selector("#editor-preview-overlay")).toExist(),
      sceneExpect(selector("#editor-preview-iframe")).toHaveAttr(
        "srcdoc",
        "<h1>Gelöschte Vorschau</h1>",
      ),
      click(selector("#editor-preview-close")),
      sceneExpect(selector("#editor-preview-overlay")).toBeAbsent(),
      sceneExpect(selector("#editor-history-overlay")).toExist(),
      sceneExpect(selector('.btn-entry-history[data-entry="gone.html"]')).toExist(),
      click(selector("#editor-history-delete-latest-btn")),
      click(selector("#editor-history-delete-latest-confirm-btn")),
      Command.resolve(
        Editor.DeleteLatestFileHistoryEntry,
        Editor.Message.SucceededDeleteLatestHistoryEntry(),
      ),
      sceneExpect(selector('.btn-entry-history[data-entry="gone.html"]')).toBeAbsent(),
      sceneExpect(selector('.btn-edit-entry[data-entry="gone.html"]')).toBeAbsent(),
    )
  })
})

describe("LLM chat auto-scroll", () => {
  const createChatHistoryElement = ({
    scrollTop,
    clientHeight,
    scrollHeight,
  }: {
    readonly scrollTop: number
    readonly clientHeight: number
    readonly scrollHeight: number
  }): HTMLDivElement => {
    const el = document.createElement("div")
    el.id = "modal-llm-chat-history"
    let currentScrollTop = scrollTop
    let currentScrollHeight = scrollHeight
    Object.defineProperty(el, "scrollTop", {
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value
      },
      configurable: true,
    })
    Object.defineProperty(el, "clientHeight", {
      get: () => clientHeight,
      configurable: true,
    })
    Object.defineProperty(el, "scrollHeight", {
      get: () => currentScrollHeight,
      set: (value: number) => {
        currentScrollHeight = value
      },
      configurable: true,
    })
    document.body.appendChild(el)
    return el
  }

  it("scrollt automatisch mit, wenn der Chat bereits am unteren Rand ist", async () => {
    document.body.innerHTML = ""
    const el = createChatHistoryElement({
      scrollTop: 295,
      clientHeight: 200,
      scrollHeight: 500,
    })

    const runPromise = Effect.runPromise(Editor.scrollLlmChatToBottomIfAtBottom)
    Object.defineProperty(el, "scrollHeight", {
      get: () => 640,
      configurable: true,
    })
    await runPromise

    expect(el.scrollTop).toBe(640)
    document.body.innerHTML = ""
  })

  it("scrollt nicht mit, wenn der Chat nicht am unteren Rand ist", async () => {
    document.body.innerHTML = ""
    const el = createChatHistoryElement({
      scrollTop: 120,
      clientHeight: 200,
      scrollHeight: 500,
    })

    const runPromise = Effect.runPromise(Editor.scrollLlmChatToBottomIfAtBottom)
    Object.defineProperty(el, "scrollHeight", {
      get: () => 640,
      configurable: true,
    })
    await runPromise

    expect(el.scrollTop).toBe(120)
    document.body.innerHTML = ""
  })

  it("scrollt ans untere Ende, wenn der Chat-Verlauf neu eingeblendet wird", async () => {
    document.body.innerHTML = ""
    const runPromise = Effect.runPromise(Editor.scrollLlmChatToBottomIfAtBottom)
    const el = createChatHistoryElement({
      scrollTop: 0,
      clientHeight: 200,
      scrollHeight: 420,
    })
    await runPromise

    expect(el.scrollTop).toBe(420)
    document.body.innerHTML = ""
  })
})

describe("Editor-Einstellungen und Monaco-Kontextmenü", () => {
  it("speichert Zeilennummern, Folds, Zeilenumbruch, Scrollen über letzte Zeile und Theme in den Einstellungen", () => {
    scene(
      { update, view },
      given(readyModel),
      click(selector("#btn-settings")),
      click(selector("#btn-open-settings")),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#settings-group-editor")).toExist(),
      sceneExpect(selector("#settings-editor-line-numbers")).toBeChecked(),
      sceneExpect(selector("#settings-editor-folding")).toBeChecked(),
      sceneExpect(selector("#settings-editor-word-wrap")).toBeChecked(),
      sceneExpect(selector("#settings-editor-scroll-beyond-last-line")).not.toBeChecked(),
      sceneExpect(selector("#settings-app-theme")).toHaveValue("system"),
      sceneExpect(selector("#settings-editor-theme")).toHaveValue("system"),
      change(selector("#settings-app-theme"), "dark"),
      Command.expectExact(SaveAppTheme({ theme: "dark" })),
      Command.resolve(SaveAppTheme, Message.CompletedSaveAppTheme()),
      sceneExpect(selector("#settings-app-theme")).toHaveValue("dark"),
      change(selector("#settings-editor-line-numbers"), "false"),
      Command.expectExact(
        SaveMonacoSettings({
          lineNumbers: false,
          folding: true,
          wordWrap: true,
          scrollBeyondLastLine: false,
          theme: "system",
          lineDecorationsWidth: 10,
          lineNumbersMinChars: 5,
        }),
      ),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      sceneExpect(selector("#settings-editor-line-numbers")).not.toBeChecked(),
      change(selector("#settings-editor-folding"), "false"),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      sceneExpect(selector("#settings-editor-folding")).not.toBeChecked(),
      change(selector("#settings-editor-word-wrap"), "false"),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      sceneExpect(selector("#settings-editor-word-wrap")).not.toBeChecked(),
      change(selector("#settings-editor-scroll-beyond-last-line"), "true"),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      sceneExpect(selector("#settings-editor-scroll-beyond-last-line")).toBeChecked(),
      change(selector("#settings-editor-theme"), "vs-dark"),
      Command.expectExact(
        SaveMonacoSettings({
          lineNumbers: false,
          folding: false,
          wordWrap: false,
          scrollBeyondLastLine: true,
          theme: "vs-dark",
          lineDecorationsWidth: 10,
          lineNumbersMinChars: 5,
        }),
      ),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      sceneExpect(selector("#settings-editor-theme")).toHaveValue("vs-dark"),
      sceneExpect(selector("#settings-editor-line-decorations-width-value")).toHaveText("10 px"),
      type(selector("#settings-editor-line-decorations-width"), "0"),
      Command.expectExact(
        SaveMonacoSettings({
          lineNumbers: false,
          folding: false,
          wordWrap: false,
          scrollBeyondLastLine: true,
          theme: "vs-dark",
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 5,
        }),
      ),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      sceneExpect(selector("#settings-editor-line-decorations-width-value")).toHaveText("0 px"),
      sceneExpect(selector("#settings-editor-line-numbers-min-chars-value")).toHaveText(
        "5 Zeichen",
      ),
      type(selector("#settings-editor-line-numbers-min-chars"), "3"),
      Command.expectExact(
        SaveMonacoSettings({
          lineNumbers: false,
          folding: false,
          wordWrap: false,
          scrollBeyondLastLine: true,
          theme: "vs-dark",
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 3,
        }),
      ),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      sceneExpect(selector("#settings-editor-line-numbers-min-chars-value")).toHaveText(
        "3 Zeichen",
      ),
    )
  })

  it("öffnet die Einstellungen aus dem Monaco-Editor-Kontextmenü und behält den offenen Editor bei", () => {
    scene(
      { update, view },
      given(readyModel),
      click(selector("#btn-new-file")),
      Command.resolveAll(
        [PushUrl, Message.CompletedPushUrl()],
        [Modal.FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()],
        [Editor.LoadUserTemplates, Editor.Message.CompletedLoadUserTemplates({ templates: [] })],
      ),
      sceneExpect(selector("#modal-file-content")).toExist(),
      CustomElement.emit(
        monacoEditorElement,
        selector("#modal-file-content"),
        "settings-requested",
        {},
      ),
      sceneExpect(selector("#settings-dialog")).toExist(),
      change(selector("#settings-editor-theme"), "hc-black"),
      Command.resolve(SaveMonacoSettings, Message.CompletedSaveMonacoSettings()),
      click(selector("#btn-close-settings")),
      sceneExpect(selector("#settings-dialog")).toBeAbsent(),
      sceneExpect(selector("#modal-file-content")).toExist(),
    )
  })

  it("zeigt Provider-Edit im eigenen Modal und listet Modelle aller Provider mit providerabhängigem Thinking", () => {
    scene(
      { update, view },
      given({
        ...readyModel,
        llmEnabled: true,
        llmProviders: [
          {
            id: "p1",
            name: "OpenAI",
            enabled: true,
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-1",
            models: "gpt-4o, o3-mini",
            editFormat: "hashline",
            streaming: true,
            toolCalls: true,
            thinkingParam: "reasoning_effort",
            thinkingLevels: "Aus=none, Hoch=high",
            extraArgs: "",
          },
          {
            id: "p2",
            name: "Ollama",
            enabled: true,
            baseUrl: "http://localhost:11434/v1",
            apiKey: "",
            models: "qwen3",
            editFormat: "hashline",
            streaming: true,
            toolCalls: true,
            thinkingParam: "",
            thinkingLevels: "",
            extraArgs: "",
          },
        ],
      }),
      click(selector("#btn-settings")),
      click(selector("#btn-open-settings")),
      Command.resolve(PushUrl, Message.CompletedPushUrl()),
      sceneExpect(selector("#settings-dialog")).toExist(),
      sceneExpect(selector("#llm-provider-modal")).toBeAbsent(),
      sceneExpect(selector("#btn-save-settings")).toBeAbsent(),
      click(selector("#btn-add-llm-provider")),
      sceneExpect(selector("#llm-provider-modal")).toExist(),
      sceneExpect(selector("#btn-save-settings")).toExist(),
      click(selector("#btn-cancel-settings")),
      sceneExpect(selector("#llm-provider-modal")).toBeAbsent(),
      sceneExpect(selector("#settings-dialog")).toExist(),
      click(selector("#btn-close-settings")),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      click(selector("#btn-new-file")),
      Command.resolveAll(
        [PushUrl, Message.CompletedPushUrl()],
        [Modal.FocusModalNameInput, Modal.Message.CompletedFocusModalNameInput()],
        [Editor.LoadUserTemplates, Editor.Message.CompletedLoadUserTemplates({ templates: [] })],
      ),
      click(selector("#modal-llm-mode-select")),
      click(selector("#modal-llm-mode-option-Chat")),
      Command.resolveAll(
        [SaveEditorPreferences, Message.CompletedSaveEditorPreferences()],
        [Editor.ScrollLlmChatToBottomIfAtBottom, Editor.Message.CompletedScrollLlmChatToBottom()],
      ),
      sceneExpect(selector('#modal-llm-model-select optgroup[label="OpenAI"]')).toExist(),
      sceneExpect(selector('#modal-llm-model-select optgroup[label="Ollama"]')).toExist(),
      sceneExpect(selector('#modal-llm-model-select option[value="p1::gpt-4o"]')).toHaveText(
        "gpt-4o",
      ),
      sceneExpect(selector('#modal-llm-model-select option[value="p2::qwen3"]')).toHaveText(
        "qwen3",
      ),
      sceneExpect(selector("#modal-llm-thinking-select")).toExist(),
      change(selector("#modal-llm-model-select"), "p2::qwen3"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-thinking-select")).toBeAbsent(),
      change(selector("#modal-llm-model-select"), "p1::o3-mini"),
      Command.resolve(SaveEditorPreferences, Message.CompletedSaveEditorPreferences()),
      sceneExpect(selector("#modal-llm-thinking-select")).toExist(),
    )
  })
})
