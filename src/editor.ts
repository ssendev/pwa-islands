import { Array, Clock, Effect, Match, Option, Schema, pipe } from "effect"
import { Submodel } from "foldkit"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import type * as Html from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Render from "foldkit/render"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { type ModelOption, type ThinkingLevelOption, isLanguageModelSelection } from "./agent"
import {
  BinaryEdit,
  EditorFileMode,
  FileEntry,
  FileEntryKind,
  PreviewContent,
  arrayBufferToBase64,
  base64ToUint8Array,
  getPreviewType,
  loadEditorFileModeForEntry,
  requireActiveStorage,
  revokeActiveHistoryPreviewUrl,
  revokeActivePreviewUrl,
  setActiveHistoryPreviewUrl,
} from "./files"
import {
  EditApplyResult,
  EditFormat,
  applyEditsForFormat,
  formatFencedFileForFormat,
  formatLlmContextForFormat,
} from "./edit-format"
import { formatUpdatedHashlines } from "./hashline"
import {
  appendFileHistory,
  appendFileHistoryBytes,
  clearFileHistory,
  hashAndMeasureHistoryContent,
  hashContentBytes,
  loadFileHistoryBytesAt,
  loadFileHistoryEntryAt,
  loadFileHistoryIndex,
  truncateLatestFileHistoryEntry,
} from "./history"
import { type IconId, viewIcon } from "./icons"
import * as LlmResponse from "./llm-response"
import { viewMarkdown, viewUserMarkdown } from "./markdown"
import { monacoEditorElement, triggerMonacoHistoryAction } from "./monaco-element"
import { buildEditUrl, buildNewUrl } from "./route"
import { checkTextBytes, getMimeType } from "./storage"
import {
  type AppTheme,
  DEFAULT_EDITOR_SPLIT_PERCENT,
  type MonacoSettings,
  clampEditorSplitPercent,
  deleteUserTemplate,
  getStoredHistoryEnabled,
  getStoredUserTemplates,
  sanitizeTemplateName,
  storeHistoryEnabled,
  saveUserTemplate,
} from "./storage"
import { BUILTIN_TEMPLATES, replaceFileExtension, StarterTemplate } from "./templates"
import { AlertBanner, AlertVariant } from "./toast"

export { BinaryEdit, EditorFileMode, PreviewContent }
export { BUILTIN_TEMPLATES, replaceFileExtension, StarterTemplate }
export { AlertBanner, AlertVariant }

// MODEL

export const LlmBarMode = Schema.Literals(["Closed", "Chat", "Copy"])
export type LlmBarMode = typeof LlmBarMode.Type

export const LlmToolCallSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
})
export type LlmToolCallSchema = typeof LlmToolCallSchema.Type

export const LlmChatMessage = defineTaggedUnion({
  System: { content: Schema.String },
  User: { content: Schema.String },
  Assistant: {
    content: Schema.String,
    toolCalls: Schema.Array(LlmToolCallSchema),
  },
  Tool: {
    toolCallId: Schema.String,
    content: Schema.String,
  },
})
export type LlmChatMessage = typeof LlmChatMessage.Type

export const LlmChatToolDetailSchema = Schema.Struct({
  summary: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  result: Schema.String,
})
export type LlmChatToolDetail = typeof LlmChatToolDetailSchema.Type

export const LlmChatTurnBlock = Schema.Struct({
  content: Schema.String,
  reasoning: Schema.String,
  isError: Schema.Boolean,
  assistantContent: Schema.optionalKey(Schema.String),
  toolDetails: Schema.optionalKey(Schema.Array(LlmChatToolDetailSchema)),
})
export type LlmChatTurnBlock = typeof LlmChatTurnBlock.Type

export const LlmChatDisplayEntry = defineTaggedUnion({
  Question: { content: Schema.String },
  Answer: {
    content: Schema.String,
    reasoning: Schema.String,
    isError: Schema.Boolean,
    assistantContent: Schema.optionalKey(Schema.String),
    toolDetails: Schema.optionalKey(Schema.Array(LlmChatToolDetailSchema)),
  },
})
export type LlmChatDisplayEntry = typeof LlmChatDisplayEntry.Type

export const LlmChatState = defineTaggedUnion({
  Idle: {},
  Sending: {
    prompt: Schema.String,
    fileName: Schema.String,
    content: Schema.String,
    messages: Schema.Array(LlmChatMessage),
    streamTurns: Schema.Array(LlmChatTurnBlock),
    streamContent: Schema.String,
    streamReasoning: Schema.String,
  },
})
export type LlmChatState = typeof LlmChatState.Type

export const OverwriteSource = defineTaggedUnion({
  CreateFile: {
    content: Schema.String,
    selectedTemplateId: Schema.String,
    userTemplates: Schema.Array(StarterTemplate),
  },
  EditFile: {
    originalName: Schema.String,
    fileMode: EditorFileMode,
  },
})
export type OverwriteSource = typeof OverwriteSource.Type

export const EditorSplitDrag = Schema.Struct({
  axis: Schema.Literals(["horizontal", "vertical"]),
  startScreenX: Schema.Number,
  startScreenY: Schema.Number,
  startWidthPx: Schema.Number,
  containerWidthPx: Schema.Number,
})
export type EditorSplitDrag = typeof EditorSplitDrag.Type

export const HistoryEntry = Schema.Struct({
  offset: Schema.Number,
  endOffset: Schema.Number,
  timestampMs: Schema.Number,
  byteLength: Schema.Number,
  contentHash: Schema.Number,
})
export type HistoryEntry = typeof HistoryEntry.Type

export const HistoryPreview = defineTaggedUnion({
  Text: {
    content: Schema.String,
  },
  Image: {
    objectUrl: Schema.String,
  },
  Pdf: {
    objectUrl: Schema.String,
  },
})
export type HistoryPreview = typeof HistoryPreview.Type

export const HistoryState = defineTaggedUnion({
  Closed: {},
  Loading: {},
  Open: {
    entries: Schema.Array(HistoryEntry),
    isConfirmingClear: Schema.Boolean,
    isConfirmingDeleteLatest: Schema.optionalKey(Schema.Boolean),
    isHistoryEnabled: Schema.Boolean,
    maybePreviewContent: Schema.Option(HistoryPreview),
  },
})
export type HistoryState = typeof HistoryState.Type

export const Model = defineTaggedUnion({
  CreateFile: {
    name: Schema.String,
    content: Schema.String,
    selectedTemplateId: Schema.String,
    userTemplates: Schema.Array(StarterTemplate),
    isSavingTemplate: Schema.Boolean,
    isDeletingTemplate: Schema.Boolean,
    newTemplateLabel: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
    maybePasteError: Schema.Option(Schema.String),
    llmBarMode: LlmBarMode,
    isLlmModeMenuOpen: Schema.optionalKey(Schema.Boolean),
    llmChatInput: Schema.String,
    llmChatMessages: Schema.Array(LlmChatMessage),
    llmChatDisplay: Schema.Array(LlmChatDisplayEntry),
    llmChatState: LlmChatState,
    isLlmThinkingMarkdown: Schema.optionalKey(Schema.Boolean),
    isLlmContentMarkdown: Schema.optionalKey(Schema.Boolean),
    isLlmUserMarkdown: Schema.optionalKey(Schema.Boolean),
    isMaximized: Schema.Boolean,
    isPreviewOpen: Schema.Boolean,
    editorSplitPercent: Schema.Number,
    editorSplitDrag: Schema.Option(EditorSplitDrag),
  },
  CreateFolder: {
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
  },
  EditFolder: {
    originalName: Schema.String,
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
    isConfirmingDelete: Schema.Boolean,
  },
  EditFile: {
    originalName: Schema.String,
    name: Schema.String,
    fileMode: EditorFileMode,
    maybeValidationError: Schema.Option(Schema.String),
    maybePasteError: Schema.Option(Schema.String),
    llmBarMode: LlmBarMode,
    isLlmModeMenuOpen: Schema.optionalKey(Schema.Boolean),
    llmChatInput: Schema.String,
    llmChatMessages: Schema.Array(LlmChatMessage),
    llmChatDisplay: Schema.Array(LlmChatDisplayEntry),
    llmChatState: LlmChatState,
    isLlmThinkingMarkdown: Schema.optionalKey(Schema.Boolean),
    isLlmContentMarkdown: Schema.optionalKey(Schema.Boolean),
    isLlmUserMarkdown: Schema.optionalKey(Schema.Boolean),
    isMaximized: Schema.Boolean,
    isEditingName: Schema.Boolean,
    isPreviewOpen: Schema.Boolean,
    editorSplitPercent: Schema.Number,
    editorSplitDrag: Schema.Option(EditorSplitDrag),
    canUndo: Schema.Boolean,
    canRedo: Schema.Boolean,
    historyState: HistoryState,
    isHistoryEnabled: Schema.optionalKey(Schema.Boolean),
    hasHistoryEntries: Schema.optionalKey(Schema.Boolean),
    isHistoryOnly: Schema.optionalKey(Schema.Boolean),
    isDeletedHistory: Schema.optionalKey(Schema.Boolean),
    isConfirmingDelete: Schema.Boolean,
  },
  ConfirmOverwrite: {
    targetName: Schema.String,
    source: OverwriteSource,
  },
})
export type Model = typeof Model.Type

type CreateFileModel = Extract<Model, { readonly _tag: "CreateFile" }>
type EditFileModel = Extract<Model, { readonly _tag: "EditFile" }>
type BinaryFileMode = Extract<EditorFileMode, { readonly _tag: "Binary" }>

export const makeCreateFile = (
  userTemplates: ReadonlyArray<StarterTemplate> = [],
  defaults?: {
    readonly isMaximized?: boolean
    readonly llmBarMode?: LlmBarMode
    readonly editorSplitPercent?: number
  },
): CreateFileModel => ({
  _tag: "CreateFile",
  name: "Neu.html",
  content: "",
  selectedTemplateId: "builtin:empty",
  userTemplates,
  isSavingTemplate: false,
  isDeletingTemplate: false,
  newTemplateLabel: "",
  maybeValidationError: Option.none(),
  maybePasteError: Option.none(),
  llmBarMode: defaults?.llmBarMode ?? "Closed",
  isLlmModeMenuOpen: false,
  llmChatInput: "",
  llmChatMessages: [],
  llmChatDisplay: [],
  llmChatState: LlmChatState.Idle(),
  isLlmThinkingMarkdown: true,
  isLlmContentMarkdown: true,
  isLlmUserMarkdown: true,
  isMaximized: defaults?.isMaximized ?? false,
  isPreviewOpen: false,
  editorSplitPercent: defaults?.editorSplitPercent ?? DEFAULT_EDITOR_SPLIT_PERCENT,
  editorSplitDrag: Option.none(),
})

export const applyPreferences = (
  model: Model,
  prefs: {
    readonly isMaximized: boolean
    readonly llmBarMode: LlmBarMode
    readonly editorSplitPercent: number
  },
): Model =>
  Model.match(model, {
    CreateFile: (state) =>
      modifyFields(state, {
        isMaximized: () => prefs.isMaximized,
        llmBarMode: () => prefs.llmBarMode,
        editorSplitPercent: () => prefs.editorSplitPercent,
      }),
    EditFile: (state) =>
      modifyFields(state, {
        isMaximized: () => prefs.isMaximized,
        llmBarMode: () => prefs.llmBarMode,
        editorSplitPercent: () => prefs.editorSplitPercent,
      }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

const sendingEntriesToDisplay = (chatState: LlmChatState): ReadonlyArray<LlmChatDisplayEntry> => {
  if (chatState._tag !== "Sending") {
    return []
  }
  const completed = Array.map(chatState.streamTurns, (turn) =>
    LlmChatDisplayEntry.Answer({
      content: turn.content,
      reasoning: turn.reasoning,
      isError: turn.isError,
      ...(turn.assistantContent !== undefined ? { assistantContent: turn.assistantContent } : {}),
      ...(turn.toolDetails !== undefined ? { toolDetails: turn.toolDetails } : {}),
    }),
  )
  const hasActive = chatState.streamContent !== "" || chatState.streamReasoning !== ""
  return hasActive
    ? [
        ...completed,
        LlmChatDisplayEntry.Answer({
          content: chatState.streamContent,
          reasoning: chatState.streamReasoning,
          isError: false,
        }),
      ]
    : completed
}

export const applyLlmChatStream = (
  model: Model,
  {
    completedTurns,
    activeTurn,
  }: {
    readonly completedTurns: ReadonlyArray<LlmChatTurnBlock>
    readonly activeTurn: { readonly content: string; readonly reasoning: string }
  },
): Model =>
  Model.match(model, {
    CreateFile: (state) =>
      LlmChatState.match(state.llmChatState, {
        Idle: () => state,
        Sending: (sending) =>
          modifyFields(state, {
            llmChatState: () =>
              modifyFields(sending, {
                streamTurns: () => completedTurns,
                streamContent: () => activeTurn.content,
                streamReasoning: () => activeTurn.reasoning,
              }),
          }),
      }),
    EditFile: (state) =>
      LlmChatState.match(state.llmChatState, {
        Idle: () => state,
        Sending: (sending) =>
          modifyFields(state, {
            llmChatState: () =>
              modifyFields(sending, {
                streamTurns: () => completedTurns,
                streamContent: () => activeTurn.content,
                streamReasoning: () => activeTurn.reasoning,
              }),
          }),
      }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

export const applyLlmChatSuccess = (
  model: Model,
  {
    messages,
    maybeUpdatedContent,
    appliedCount,
    turns,
  }: {
    readonly messages: ReadonlyArray<LlmChatMessage>
    readonly maybeUpdatedContent: Option.Option<string>
    readonly appliedCount: number
    readonly turns: ReadonlyArray<LlmChatTurnBlock>
  },
): Model => {
  const turnEntries = Array.map(turns, (turn) =>
    LlmChatDisplayEntry.Answer({
      content: turn.content,
      reasoning: turn.reasoning,
      isError: turn.isError,
      ...(turn.assistantContent !== undefined ? { assistantContent: turn.assistantContent } : {}),
      ...(turn.toolDetails !== undefined ? { toolDetails: turn.toolDetails } : {}),
    }),
  )
  const appliedEntries: ReadonlyArray<LlmChatDisplayEntry> = Option.match(maybeUpdatedContent, {
    onSome: () => [
      LlmChatDisplayEntry.Answer({
        content: `${appliedCount} Bearbeitung(en) angewendet`,
        reasoning: "",
        isError: false,
      }),
    ],
    onNone: () => [],
  })
  const newDisplayEntries = [...turnEntries, ...appliedEntries]

  return Model.match(model, {
    CreateFile: (state) =>
      modifyFields(state, {
        content: (current) => Option.getOrElse(maybeUpdatedContent, () => current),
        llmChatMessages: () => messages,
        llmChatDisplay: (current) => [...current, ...newDisplayEntries],
        llmChatState: () => LlmChatState.Idle(),
      }),
    EditFile: (state) =>
      modifyFields(state, {
        fileMode: (current) =>
          Option.match(maybeUpdatedContent, {
            onSome: (nextContent) => EditorFileMode.Text({ content: nextContent }),
            onNone: () => current,
          }),
        llmChatMessages: () => messages,
        llmChatDisplay: (current) => [...current, ...newDisplayEntries],
        llmChatState: () => LlmChatState.Idle(),
      }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })
}

export const applyLlmChatFailure = (model: Model, message: string): Model => {
  const errorEntry = LlmChatDisplayEntry.Answer({
    content: message,
    reasoning: "",
    isError: true,
  })

  const restorePromptIfEmpty = (currentInput: string, chatState: LlmChatState): string =>
    currentInput.trim() === "" && chatState._tag === "Sending" ? chatState.prompt : currentInput

  return Model.match(model, {
    CreateFile: (state) =>
      modifyFields(state, {
        llmChatInput: (current) => restorePromptIfEmpty(current, state.llmChatState),
        llmChatDisplay: (current) => [
          ...current,
          ...sendingEntriesToDisplay(state.llmChatState),
          errorEntry,
        ],
        llmChatState: () => LlmChatState.Idle(),
      }),
    EditFile: (state) =>
      modifyFields(state, {
        llmChatInput: (current) => restorePromptIfEmpty(current, state.llmChatState),
        llmChatDisplay: (current) => [
          ...current,
          ...sendingEntriesToDisplay(state.llmChatState),
          errorEntry,
        ],
        llmChatState: () => LlmChatState.Idle(),
      }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })
}

const hasHistoryPreviewObjectUrl = (model: Model): boolean =>
  model._tag === "EditFile" &&
  model.historyState._tag === "Open" &&
  Option.exists(
    model.historyState.maybePreviewContent,
    (preview) => preview._tag === "Image" || preview._tag === "Pdf",
  )

export const isPreviewOpen = (model: Model): boolean =>
  Model.match(model, {
    CreateFile: (state) => state.isPreviewOpen,
    EditFile: (state) =>
      state.fileMode._tag === "Text" &&
      (state.isPreviewOpen ||
        (state.historyState._tag === "Open" &&
          Option.isSome(state.historyState.maybePreviewContent))),
    CreateFolder: () => false,
    EditFolder: () => false,
    ConfirmOverwrite: () => false,
  })

export const isEditorPreviewOpen = (model: Model): boolean =>
  Model.match(model, {
    CreateFile: (state) => state.isPreviewOpen,
    EditFile: (state) =>
      state.fileMode._tag === "Text" &&
      state.isPreviewOpen &&
      !(
        state.historyState._tag === "Open" && Option.isSome(state.historyState.maybePreviewContent)
      ),
    CreateFolder: () => false,
    EditFolder: () => false,
    ConfirmOverwrite: () => false,
  })

export const setPreviewOpen = (model: Model, isOpen: boolean): Model =>
  Model.match(model, {
    CreateFile: (state) => modifyFields(state, { isPreviewOpen: () => isOpen }),
    EditFile: (state) =>
      state.fileMode._tag === "Text" ? modifyFields(state, { isPreviewOpen: () => isOpen }) : state,
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

export const closePreview = (model: Model): Model =>
  Model.match(model, {
    CreateFile: (state) => modifyFields(state, { isPreviewOpen: () => false }),
    EditFile: (state) =>
      state.historyState._tag === "Open" && Option.isSome(state.historyState.maybePreviewContent)
        ? modifyFields(state, {
            historyState: (historyState) =>
              historyState._tag === "Open"
                ? HistoryState.Open({
                    entries: historyState.entries,
                    isConfirmingClear: historyState.isConfirmingClear,
                    isHistoryEnabled: historyState.isHistoryEnabled,
                    maybePreviewContent: Option.none(),
                  })
                : historyState,
          })
        : modifyFields(state, { isPreviewOpen: () => false }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

export const isConfirmingDelete = (model: Model): boolean =>
  Model.match(model, {
    EditFolder: (folder) => folder.isConfirmingDelete,
    EditFile: (file) =>
      file.isConfirmingDelete ||
      (file.historyState._tag === "Open" &&
        (file.historyState.isConfirmingClear ||
          file.historyState.isConfirmingDeleteLatest === true)),
    CreateFile: (file) => file.isDeletingTemplate,
    CreateFolder: () => false,
    ConfirmOverwrite: () => false,
  })

export const cancelDelete = (model: Model): Model =>
  Model.match(model, {
    EditFolder: (folder) => modifyFields(folder, { isConfirmingDelete: () => false }),
    EditFile: (file) =>
      modifyFields(file, {
        isConfirmingDelete: () => false,
        historyState: (historyState) =>
          historyState._tag === "Open"
            ? modifyFields(historyState, {
                isConfirmingClear: () => false,
                isConfirmingDeleteLatest: () => false,
              })
            : historyState,
      }),
    CreateFile: (file) => modifyFields(file, { isDeletingTemplate: () => false }),
    CreateFolder: () => model,
    ConfirmOverwrite: () => model,
  })

export const isHistoryOpen = (model: Model): boolean =>
  Model.match(model, {
    EditFile: (file) => file.historyState._tag !== "Closed",
    CreateFile: () => false,
    CreateFolder: () => false,
    EditFolder: () => false,
    ConfirmOverwrite: () => false,
  })

export const closeHistory = (model: Model): Model =>
  Model.match(model, {
    EditFile: (file) => modifyFields(file, { historyState: () => HistoryState.Closed() }),
    CreateFile: () => model,
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

export const isConfirmingOverwrite = (model: Model): boolean => model._tag === "ConfirmOverwrite"

export const cancelOverwrite = (model: Model): Model =>
  Model.match(model, {
    ConfirmOverwrite: ({ targetName, source }) =>
      OverwriteSource.match(source, {
        CreateFile: ({ content, selectedTemplateId, userTemplates }) =>
          Model.CreateFile({
            name: targetName,
            content,
            selectedTemplateId,
            userTemplates,
            isSavingTemplate: false,
            isDeletingTemplate: false,
            newTemplateLabel: "",
            maybeValidationError: Option.none(),
            maybePasteError: Option.none(),
            llmBarMode: "Closed",
            isLlmModeMenuOpen: false,
            llmChatInput: "",
            llmChatMessages: [],
            llmChatDisplay: [],
            llmChatState: LlmChatState.Idle(),
            isLlmThinkingMarkdown: true,
            isLlmContentMarkdown: true,
            isLlmUserMarkdown: true,
            isMaximized: false,
            isPreviewOpen: false,
            editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
            editorSplitDrag: Option.none(),
          }),
        EditFile: ({ originalName, fileMode }) =>
          Model.EditFile({
            originalName,
            name: targetName,
            fileMode,
            maybeValidationError: Option.none(),
            maybePasteError: Option.none(),
            llmBarMode: "Closed",
            isLlmModeMenuOpen: false,
            llmChatInput: "",
            llmChatMessages: [],
            llmChatDisplay: [],
            llmChatState: LlmChatState.Idle(),
            isLlmThinkingMarkdown: true,
            isLlmContentMarkdown: true,
            isLlmUserMarkdown: true,
            isMaximized: false,
            isEditingName: false,
            isPreviewOpen: false,
            editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
            editorSplitDrag: Option.none(),
            canUndo: false,
            canRedo: false,
            historyState: HistoryState.Closed(),
            isConfirmingDelete: false,
          }),
      }),
    CreateFile: () => model,
    CreateFolder: () => model,
    EditFolder: () => model,
    EditFile: () => model,
  })

const getTextFileContext = (
  model: Model,
): Option.Option<{ readonly fileName: string; readonly content: string }> =>
  Model.match(model, {
    CreateFile: (state) => Option.some({ fileName: state.name, content: state.content }),
    EditFile: (state) =>
      EditorFileMode.match(state.fileMode, {
        Text: ({ content }) => Option.some({ fileName: state.name, content }),
        Binary: () => Option.none(),
      }),
    CreateFolder: () => Option.none(),
    EditFolder: () => Option.none(),
    ConfirmOverwrite: () => Option.none(),
  })

const parseLlmBarMode = (value: string, llmEnabled: boolean): LlmBarMode => {
  if (value === "Chat" && llmEnabled) {
    return "Chat"
  }
  if (value === "Copy") {
    return "Copy"
  }
  return "Closed"
}

const setLlmBarMode = (model: Model, llmBarMode: LlmBarMode): Model =>
  Model.match(model, {
    CreateFile: (state) =>
      modifyFields(state, {
        llmBarMode: () => llmBarMode,
        isLlmModeMenuOpen: () => false,
      }),
    EditFile: (state) =>
      modifyFields(state, {
        llmBarMode: () => llmBarMode,
        isLlmModeMenuOpen: () => false,
      }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

export const isLlmModeMenuOpen = (model: Model): boolean =>
  Model.match(model, {
    CreateFile: (state) => state.isLlmModeMenuOpen ?? false,
    EditFile: (state) => state.isLlmModeMenuOpen ?? false,
    CreateFolder: () => false,
    EditFolder: () => false,
    ConfirmOverwrite: () => false,
  })

export const setLlmModeMenuOpen = (model: Model, isOpen: boolean): Model =>
  Model.match(model, {
    CreateFile: (state) => modifyFields(state, { isLlmModeMenuOpen: () => isOpen }),
    EditFile: (state) => modifyFields(state, { isLlmModeMenuOpen: () => isOpen }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

const toggleLlmModeMenu = (model: Model): Model =>
  setLlmModeMenuOpen(model, !isLlmModeMenuOpen(model))

const setPasteError = (model: Model, maybePasteError: Option.Option<string>): Model =>
  Model.match(model, {
    CreateFile: (state) => modifyFields(state, { maybePasteError: () => maybePasteError }),
    EditFile: (state) => modifyFields(state, { maybePasteError: () => maybePasteError }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

const applyTextContentUpdate = (model: Model, content: string): Model =>
  Model.match(model, {
    CreateFile: (state) =>
      modifyFields(state, {
        content: () => content,
        maybePasteError: () => Option.none(),
      }),
    EditFile: (state) =>
      EditorFileMode.match(state.fileMode, {
        Text: () =>
          modifyFields(state, {
            fileMode: () => EditorFileMode.Text({ content }),
            maybePasteError: () => Option.none(),
          }),
        Binary: () => state,
      }),
    CreateFolder: () => model,
    EditFolder: () => model,
    ConfirmOverwrite: () => model,
  })

// MESSAGE & OUTMESSAGE

export const Message = defineMessageUnion({
  UpdatedName: {
    name: Schema.String,
  },
  UpdatedTextContent: {
    content: Schema.String,
  },
  SelectedTemplate: {
    templateId: Schema.String,
  },
  ClickedOpenSaveTemplate: {},
  ClickedCancelSaveTemplate: {},
  UpdatedNewTemplateLabel: {
    label: Schema.String,
  },
  ClickedConfirmSaveTemplate: {},
  GeneratedTemplateTimestamp: {
    timestamp: Schema.Number,
  },
  ClickedOpenDeleteTemplate: {},
  ClickedCancelDeleteTemplate: {},
  ClickedConfirmDeleteTemplate: {},
  CompletedLoadUserTemplates: {
    templates: Schema.Array(StarterTemplate),
  },
  CompletedSaveUserTemplate: {
    template: StarterTemplate,
  },
  CompletedDeleteUserTemplate: {
    templateId: Schema.String,
  },
  ToggledBase64: {
    isChecked: Schema.Boolean,
  },
  SucceededLoadBase64: {
    base64Content: Schema.String,
  },
  FailedLoadBase64: {
    message: Schema.String,
  },
  UpdatedBase64Content: {
    base64Content: Schema.String,
  },
  SelectedLlmBarMode: {
    value: Schema.String,
  },
  ClickedToggleLlmModeMenu: {},
  ClickedOutsideLlmModeMenu: {},
  UpdatedLlmChatInput: {
    value: Schema.String,
  },
  SubmittedLlmChat: {},
  ClickedStopLlmChat: {},
  SucceededLlmChat: {
    messages: Schema.Array(LlmChatMessage),
    maybeUpdatedContent: Schema.Option(Schema.String),
    appliedCount: Schema.Number,
    turns: Schema.Array(LlmChatTurnBlock),
  },
  FailedLlmChat: {
    message: Schema.String,
  },
  CompletedScrollLlmChatToBottom: {},
  SelectedLlmModel: {
    value: Schema.String,
  },
  SelectedLlmThinkingLevel: {
    value: Schema.String,
  },
  ClickedToggleMaximize: {},
  ClickedCopyDts: {},
  SucceededCopyApiDtsToClipboard: {},
  FailedCopyApiDtsToClipboard: {
    message: Schema.String,
  },
  ClickedCopyLlmContext: {},
  SucceededCopyLlmContext: {},
  FailedCopyLlmContext: {
    message: Schema.String,
  },
  ClickedCopyFileHashes: {},
  SucceededCopyFileHashes: {},
  FailedCopyFileHashes: {
    message: Schema.String,
  },
  ClickedPasteLlmEdits: {},
  SucceededReadClipboardForLlmEdits: {
    text: Schema.String,
  },
  FailedReadClipboardForLlmEdits: {
    message: Schema.String,
  },
  SucceededCopyUpdatedHashes: {},
  FailedCopyUpdatedHashes: {
    message: Schema.String,
  },
  CompletedCopyPasteErrorToClipboard: {},
  ToggledLlmThinkingMarkdown: {},
  ToggledLlmContentMarkdown: {},
  ToggledLlmUserMarkdown: {},
  ClickedCopyLlmCode: {
    code: Schema.String,
  },
  CompletedCopyLlmCode: {},
  RequestedSettings: {},
  ClickedSave: {},
  ClickedOpenPreview: {},
  ClickedClosePreview: {},
  ClickedConfirmOverwrite: {},
  ClickedCancelOverwrite: {},
  ClickedDelete: {},
  ClickedConfirmDelete: {},
  ClickedCancelDelete: {},
  ClickedClose: {},
  SucceededSaveChanges: {
    entries: Schema.Array(FileEntry),
  },
  FailedSaveChanges: {
    message: Schema.String,
  },
  SucceededDeleteEntry: {
    entries: Schema.Array(FileEntry),
  },
  FailedDeleteEntry: {
    message: Schema.String,
  },
  CompletedFocusNameInput: {},
  CompletedClearClipboardAfterPaste: {},
  StartedResizeEditorSplit: {
    startScreenX: Schema.Number,
    startScreenY: Schema.optionalKey(Schema.Number),
    pointerId: Schema.Number,
  },
  MeasuredEditorSplitDrag: {
    axis: Schema.optionalKey(Schema.Literals(["horizontal", "vertical"])),
    startWidthPx: Schema.Number,
    containerWidthPx: Schema.Number,
  },
  MovedResizeEditorSplit: {
    screenX: Schema.Number,
    screenY: Schema.optionalKey(Schema.Number),
  },
  EndedResizeEditorSplit: {},
  ClickedToggleEditName: {},
  ClickedUndo: {},
  ClickedRedo: {},
  CompletedTriggerEditorUndo: {},
  CompletedTriggerEditorRedo: {},
  ChangedEditorHistoryState: {
    canUndo: Schema.Boolean,
    canRedo: Schema.Boolean,
  },
  ClickedOpenHistory: {},
  ClickedCloseHistory: {},
  SucceededLoadFullHistory: {
    entries: Schema.Array(HistoryEntry),
    isHistoryEnabled: Schema.Boolean,
  },
  ToggledHistoryEnabled: {
    isEnabled: Schema.Boolean,
  },
  CompletedSaveHistoryEnabled: {},
  FailedLoadFullHistory: {
    message: Schema.String,
  },
  ClickedRestoreHistoryEntry: {
    endOffset: Schema.Number,
  },
  SucceededLoadHistoryEntryAt: {
    maybeContent: Schema.Option(Schema.String),
  },
  FailedLoadHistoryEntryAt: {
    message: Schema.String,
  },
  SucceededRestoreBinaryHistoryEntry: {
    maybeFileMode: Schema.Option(EditorFileMode),
    entries: Schema.Array(FileEntry),
  },
  FailedRestoreBinaryHistoryEntry: {
    message: Schema.String,
  },
  ClickedPreviewHistoryEntry: {
    endOffset: Schema.Number,
  },
  SucceededLoadHistoryPreviewAt: {
    maybeContent: Schema.Option(HistoryPreview),
  },
  FailedLoadHistoryPreviewAt: {
    message: Schema.String,
  },
  CompletedRevokeActiveHistoryPreviewUrl: {},
  ClickedRequestClearHistory: {},
  ClickedCancelClearHistory: {},
  ClickedConfirmClearHistory: {},
  SucceededClearHistory: {},
  FailedClearHistory: {
    message: Schema.String,
  },
  ClickedDeleteLatestHistoryEntry: {},
  ClickedCancelDeleteLatestHistoryEntry: {},
  ClickedConfirmDeleteLatestHistoryEntry: {},
  SucceededDeleteLatestHistoryEntry: {},
  FailedDeleteLatestHistoryEntry: {
    message: Schema.String,
  },
})
export type Message = typeof Message.Type

export const OutMessage = defineTaggedUnion({
  None: {},
  CloseModal: { replaceUrl: Schema.Boolean },
  PushUrl: { url: Schema.String },
  NavigateBack: {},
  EntriesUpdated: {
    entries: Schema.Array(FileEntry),
    closeModal: Schema.Boolean,
    maybeAlertBanner: Schema.Option(AlertBanner),
  },
  FileHistoryCleared: {
    fileName: Schema.String,
  },
  ShowAlert: {
    banner: AlertBanner,
    closeModal: Schema.Boolean,
    replaceUrl: Schema.Boolean,
  },
  SelectedLlmModel: { value: Schema.String },
  SelectedLlmThinkingLevel: { value: Schema.String },
  ChangedLlmBarMode: { llmBarMode: LlmBarMode },
  ChangedMaximize: { isMaximized: Schema.Boolean },
  ChangedEditorSplitPercent: { editorSplitPercent: Schema.Number },
  RequestedSettings: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

const BinaryOrText = (
  fileMode: EditorFileMode,
  handlers: {
    readonly text: (content: string) => Promise<void>
    readonly binaryEditing: (content: string) => Promise<void>
    readonly binaryRename: () => Promise<void>
  },
): Promise<void> =>
  EditorFileMode.match(fileMode, {
    Text: ({ content }) => handlers.text(content),
    Binary: ({ edit }) =>
      BinaryEdit.match(edit, {
        Locked: handlers.binaryRename,
        Disabled: handlers.binaryRename,
        Loading: handlers.binaryRename,
        Editing: ({ content }) => handlers.binaryEditing(content),
      }),
  })

export const GenerateTemplateTimestamp = Command.define("GenerateTemplateTimestamp", {
  messages: [Message.GeneratedTemplateTimestamp],
  execute: Clock.currentTimeMillis.pipe(
    Effect.map((timestamp) => Message.GeneratedTemplateTimestamp({ timestamp })),
  ),
})

export const FocusNameInput = Command.define("FocusNameInput", {
  messages: [Message.CompletedFocusNameInput],
  execute: Dom.focus("#modal-file-name").pipe(
    Effect.as(Message.CompletedFocusNameInput()),
    Effect.catch(() => Effect.succeed(Message.CompletedFocusNameInput())),
  ),
})

const LLM_CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 16

const isElementAtBottom = (element: HTMLElement): boolean =>
  element.scrollTop + element.clientHeight >=
  element.scrollHeight - LLM_CHAT_SCROLL_BOTTOM_THRESHOLD_PX

export const scrollLlmChatToBottomIfAtBottom: Effect.Effect<void> = Effect.gen(function* () {
  const beforeElement = document.getElementById("modal-llm-chat-history")
  const wasAtBottom = beforeElement === null || isElementAtBottom(beforeElement)
  if (!wasAtBottom) {
    return
  }
  yield* Render.afterCommit
  const afterElement = document.getElementById("modal-llm-chat-history")
  if (afterElement !== null) {
    afterElement.scrollTop = afterElement.scrollHeight
  }
})

export const ScrollLlmChatToBottomIfAtBottom = Command.define("ScrollLlmChatToBottomIfAtBottom", {
  messages: [Message.CompletedScrollLlmChatToBottom],
  execute: scrollLlmChatToBottomIfAtBottom.pipe(
    Effect.as(Message.CompletedScrollLlmChatToBottom()),
  ),
})

export const LoadUserTemplates = Command.define("LoadUserTemplates", {
  messages: [Message.CompletedLoadUserTemplates],
  execute: Effect.tryPromise({
    try: async () => {
      const stored = await getStoredUserTemplates(
        requireActiveStorage().type,
        requireActiveStorage().rootHandle,
      )
      const templates: ReadonlyArray<StarterTemplate> = Array.map(stored, (t) => ({
        id: t.id,
        label: t.label,
        defaultFileName: t.defaultFileName,
        content: t.content,
        isBuiltin: false,
      }))
      return Message.CompletedLoadUserTemplates({ templates })
    },
    catch: () => new Error("Failed to load user templates"),
  }).pipe(
    Effect.catch(() => Effect.succeed(Message.CompletedLoadUserTemplates({ templates: [] }))),
  ),
})

export const SaveUserTemplate = Command.define("SaveUserTemplate", {
  args: {
    template: StarterTemplate,
  },
  messages: [Message.CompletedSaveUserTemplate],
  execute: ({ template }) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        await saveUserTemplate(storage.type, storage.rootHandle, template.label, template.content)
        return Message.CompletedSaveUserTemplate({ template })
      },
      catch: () => new Error("Failed to save user template"),
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedSaveUserTemplate({ template })))),
})

export const DeleteUserTemplate = Command.define("DeleteUserTemplate", {
  args: {
    name: Schema.String,
    templateId: Schema.String,
  },
  messages: [Message.CompletedDeleteUserTemplate],
  execute: ({ name, templateId }) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        await deleteUserTemplate(storage.type, storage.rootHandle, name)
        return Message.CompletedDeleteUserTemplate({ templateId })
      },
      catch: () => new Error("Failed to delete user template"),
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.CompletedDeleteUserTemplate({ templateId }))),
    ),
})

export const LoadBase64 = Command.define("LoadBase64", {
  args: {
    entryName: Schema.String,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededLoadBase64, Message.FailedLoadBase64],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const storage = requireActiveStorage()
        const buffer = await storage.readFileBuffer(args.subPath, args.entryName)
        const base64Content = arrayBufferToBase64(buffer)
        return Message.SucceededLoadBase64({ base64Content })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadBase64({
            message: `Dateiinhalt konnte nicht als Base64 geladen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

const recordPreviousFileVersion = async (
  storage: ReturnType<typeof requireActiveStorage>,
  subPath: ReadonlyArray<string>,
  readFromName: string,
  historyTargetName: string,
  timestampMs: number,
): Promise<void> => {
  try {
    if (!(await getStoredHistoryEnabled())) {
      return
    }
    const buffer = await storage.readFileBuffer(subPath, readFromName)
    await appendFileHistoryBytes(subPath, historyTargetName, new Uint8Array(buffer), timestampMs)
  } catch {
    // NOTE: Fehlende Quelldatei oder nicht verfügbares OPFS darf das Speichern nicht blockieren
  }
}

const recordDirectoryFileVersions = async (
  storage: ReturnType<typeof requireActiveStorage>,
  subPath: ReadonlyArray<string>,
  timestampMs: number,
): Promise<void> => {
  try {
    if (!(await getStoredHistoryEnabled())) {
      return
    }
    const entries = await storage.listEntries(subPath)
    await entries.reduce<Promise<void>>(async (acc, entry) => {
      await acc
      if (entry.isDeleted) {
        return
      }
      if (entry.kind === "file") {
        await recordPreviousFileVersion(storage, subPath, entry.name, entry.name, timestampMs)
      } else {
        await recordDirectoryFileVersions(storage, [...subPath, entry.name], timestampMs)
      }
    }, Promise.resolve())
  } catch {
    // NOTE: Nicht verfügbares OPFS darf das Löschen nicht blockieren
  }
}

const executeSaveChanges = async (
  model: Model,
  subPath: ReadonlyArray<string>,
  timestampMs: number,
): Promise<{ readonly entries: ReadonlyArray<FileEntry>; readonly savedFileName: string }> => {
  const storage = requireActiveStorage()

  const saveEditedFile = (originalName: string, targetName: string, fileMode: EditorFileMode) =>
    BinaryOrText(fileMode, {
      text: async (content) => {
        await recordPreviousFileVersion(storage, subPath, originalName, targetName, timestampMs)
        await storage.writeFile(subPath, targetName, content)
        if (originalName !== targetName) {
          await storage.deleteEntry(subPath, originalName, "file")
        }
      },
      binaryEditing: async (content) => {
        await recordPreviousFileVersion(storage, subPath, originalName, targetName, timestampMs)
        await storage.writeFileBuffer(subPath, targetName, base64ToUint8Array(content))
        if (originalName !== targetName) {
          await storage.deleteEntry(subPath, originalName, "file")
        }
      },
      binaryRename: () => storage.renameBinaryFile(subPath, originalName, targetName),
    })

  const savedFileName = await Match.value(model).pipe(
    Match.tag("CreateFolder", async ({ name }) => {
      const targetName = name.trim()
      await storage.createDirectory(subPath, targetName)
      return targetName
    }),
    Match.tag("EditFolder", async ({ name, originalName }) => {
      const newName = name.trim()
      if (newName !== originalName) {
        await storage.renameDirectory(subPath, originalName, newName)
      }
      return newName
    }),
    Match.tag("CreateFile", async ({ name, content }) => {
      const targetName = name.trim()
      await storage.writeFile(subPath, targetName, content)
      return targetName
    }),
    Match.tag("EditFile", async ({ name, originalName, fileMode }) => {
      const targetName = name.trim()
      await saveEditedFile(originalName, targetName, fileMode)
      return targetName
    }),
    Match.tag("ConfirmOverwrite", async ({ targetName, source }) => {
      await Match.value(source).pipe(
        Match.tag("CreateFile", async ({ content }) => {
          await recordPreviousFileVersion(storage, subPath, targetName, targetName, timestampMs)
          await storage.writeFile(subPath, targetName, content)
        }),
        Match.tag("EditFile", async ({ originalName, fileMode }) => {
          await saveEditedFile(originalName, targetName, fileMode)
        }),
        Match.exhaustive,
      )
      return targetName
    }),
    Match.exhaustive,
  )

  revokeActivePreviewUrl()
  const updatedEntries = await storage.listEntries(subPath)
  return { entries: updatedEntries, savedFileName }
}

export const SaveChanges = Command.define("SaveChanges", {
  args: {
    model: Model,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededSaveChanges, Message.FailedSaveChanges],
  execute: (args) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((timestampMs) =>
        Effect.tryPromise({
          try: async () => {
            const { entries } = await executeSaveChanges(args.model, args.subPath, timestampMs)
            return Message.SucceededSaveChanges({ entries })
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedSaveChanges({
            message: `Speichern fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const DeleteEntry = Command.define("DeleteEntry", {
  args: {
    entryName: Schema.String,
    entryKind: FileEntryKind,
    subPath: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededDeleteEntry, Message.FailedDeleteEntry],
  execute: (args) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((timestampMs) =>
        Effect.tryPromise({
          try: async () => {
            const storage = requireActiveStorage()

            if (args.entryKind === "file") {
              await recordPreviousFileVersion(
                storage,
                args.subPath,
                args.entryName,
                args.entryName,
                timestampMs,
              )
            } else {
              await recordDirectoryFileVersions(
                storage,
                [...args.subPath, args.entryName],
                timestampMs,
              )
            }

            await storage.deleteEntry(args.subPath, args.entryName, args.entryKind)
            revokeActivePreviewUrl()
            const updatedEntries = await storage.listEntries(args.subPath)
            return Message.SucceededDeleteEntry({ entries: updatedEntries })
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDeleteEntry({
            message: `Löschen fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const CopyApiDtsToClipboard = Command.define("CopyApiDtsToClipboard", {
  messages: [Message.SucceededCopyApiDtsToClipboard, Message.FailedCopyApiDtsToClipboard],
  execute: Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api.d.ts", { cache: "no-cache" })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} beim Laden von /api.d.ts`)
      }
      const dtsText = await res.text()
      await navigator.clipboard.writeText(dtsText)
      return Message.SucceededCopyApiDtsToClipboard()
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.FailedCopyApiDtsToClipboard({
          message: `Kopieren fehlgeschlagen: ${error.message}`,
        }),
      ),
    ),
  ),
})

export const CopyFileHashesToClipboard = Command.define("CopyFileHashesToClipboard", {
  args: {
    fileName: Schema.String,
    content: Schema.String,
    editFormat: EditFormat,
  },
  messages: [Message.SucceededCopyFileHashes, Message.FailedCopyFileHashes],
  execute: ({ fileName, content, editFormat }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(
          formatFencedFileForFormat(editFormat, fileName, content),
        )
        return Message.SucceededCopyFileHashes()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedCopyFileHashes({
            message: `Kopieren fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const CopyLlmContextToClipboard = Command.define("CopyLlmContextToClipboard", {
  args: {
    fileName: Schema.String,
    content: Schema.String,
    editFormat: EditFormat,
  },
  messages: [Message.SucceededCopyLlmContext, Message.FailedCopyLlmContext],
  execute: ({ fileName, content, editFormat }) =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch("/api.d.ts", { cache: "no-cache" })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} beim Laden von /api.d.ts`)
        }
        const dtsText = await res.text()
        const promptText = formatLlmContextForFormat(editFormat, fileName, content, dtsText)
        await navigator.clipboard.writeText(promptText)
        return Message.SucceededCopyLlmContext()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedCopyLlmContext({
            message: `Kopieren fehlgeschlagen: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const ReadClipboardForLlmEdits = Command.define("ReadClipboardForLlmEdits", {
  messages: [Message.SucceededReadClipboardForLlmEdits, Message.FailedReadClipboardForLlmEdits],
  execute: Effect.tryPromise({
    try: async () => {
      const text = await navigator.clipboard.readText()
      return Message.SucceededReadClipboardForLlmEdits({ text })
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.FailedReadClipboardForLlmEdits({
          message: `Zwischenablage konnte nicht gelesen werden: ${error.message}`,
        }),
      ),
    ),
  ),
})

export const CopyUpdatedHashesToClipboard = Command.define("CopyUpdatedHashesToClipboard", {
  args: {
    fileName: Schema.String,
    changedLines: Schema.String,
  },
  messages: [Message.SucceededCopyUpdatedHashes, Message.FailedCopyUpdatedHashes],
  execute: ({ fileName, changedLines }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(formatUpdatedHashlines(fileName, changedLines))
        return Message.SucceededCopyUpdatedHashes()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedCopyUpdatedHashes({
            message: `Neue Hashes konnten nicht kopiert werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const CopyPasteErrorToClipboard = Command.define("CopyPasteErrorToClipboard", {
  args: {
    errorText: Schema.String,
  },
  messages: [Message.CompletedCopyPasteErrorToClipboard],
  execute: ({ errorText }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(errorText)
        return Message.CompletedCopyPasteErrorToClipboard()
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedCopyPasteErrorToClipboard()))),
})

export const CopyLlmCodeToClipboard = Command.define("CopyLlmCodeToClipboard", {
  args: {
    code: Schema.String,
  },
  messages: [Message.CompletedCopyLlmCode],
  execute: ({ code }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(code)
        return Message.CompletedCopyLlmCode()
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedCopyLlmCode()))),
})

export const ClearClipboardAfterPaste = Command.define("ClearClipboardAfterPaste", {
  messages: [Message.CompletedClearClipboardAfterPaste],
  execute: Effect.tryPromise({
    try: async () => {
      await navigator.clipboard.writeText("")
      return Message.CompletedClearClipboardAfterPaste()
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedClearClipboardAfterPaste()))),
})

export const StartEditorSplitDrag = Command.define("StartEditorSplitDrag", {
  args: { pointerId: Schema.Number },
  messages: [Message.MeasuredEditorSplitDrag],
  execute: ({ pointerId }) =>
    Effect.sync(() => {
      const splitter = document.getElementById("modal-editor-splitter")
      if (splitter && typeof splitter.setPointerCapture === "function") {
        try {
          splitter.setPointerCapture(pointerId)
        } catch {
          // Ignore if pointerId is not active (e.g., synthetic test event)
        }
      }
      const form = document.getElementById("modal-form")
      const body = form?.querySelector(".modal-body")
      const axis =
        splitter && getComputedStyle(splitter).cursor === "row-resize" ? "vertical" : "horizontal"
      const containerWidthPx = form
        ? axis === "vertical"
          ? form.getBoundingClientRect().height
          : form.getBoundingClientRect().width
        : 0
      const startWidthPx = body
        ? axis === "vertical"
          ? body.getBoundingClientRect().height
          : body.getBoundingClientRect().width
        : 0
      return Message.MeasuredEditorSplitDrag({ axis, startWidthPx, containerWidthPx })
    }),
})

export const TriggerEditorUndo = Command.define("TriggerEditorUndo", {
  messages: [Message.CompletedTriggerEditorUndo],
  execute: Effect.sync(() => {
    triggerMonacoHistoryAction("modal-file-content", "undo")
    return Message.CompletedTriggerEditorUndo()
  }),
})

export const TriggerEditorRedo = Command.define("TriggerEditorRedo", {
  messages: [Message.CompletedTriggerEditorRedo],
  execute: Effect.sync(() => {
    triggerMonacoHistoryAction("modal-file-content", "redo")
    return Message.CompletedTriggerEditorRedo()
  }),
})

export const LoadFullHistory = Command.define("LoadFullHistory", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
  },
  messages: [Message.SucceededLoadFullHistory, Message.FailedLoadFullHistory],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const [entries, isHistoryEnabled] = await Promise.all([
          loadFileHistoryIndex(args.subPath, args.fileName),
          getStoredHistoryEnabled(),
        ])
        return Message.SucceededLoadFullHistory({ entries, isHistoryEnabled })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadFullHistory({
            message: `Verlauf konnte nicht geladen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const SaveHistoryEnabled = Command.define("SaveHistoryEnabled", {
  args: {
    isEnabled: Schema.Boolean,
  },
  messages: [Message.CompletedSaveHistoryEnabled],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        await storeHistoryEnabled(args.isEnabled)
        return Message.CompletedSaveHistoryEnabled()
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedSaveHistoryEnabled()))),
})

export const LoadHistoryEntryAt = Command.define("LoadHistoryEntryAt", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
    endOffset: Schema.Number,
    maybeSaveCurrentContent: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededLoadHistoryEntryAt, Message.FailedLoadHistoryEntryAt],
  execute: (args) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((timestampMs) =>
        Effect.tryPromise({
          try: async () => {
            const maybeRecord = await loadFileHistoryEntryAt(
              args.subPath,
              args.fileName,
              args.endOffset,
            )
            if (Option.isSome(maybeRecord) && Option.isSome(args.maybeSaveCurrentContent)) {
              try {
                await appendFileHistory(
                  args.subPath,
                  args.fileName,
                  args.maybeSaveCurrentContent.value,
                  timestampMs,
                )
              } catch {
                // NOTE: Nicht verfügbares OPFS darf die Wiederherstellung nicht blockieren
              }
            }
            return Message.SucceededLoadHistoryEntryAt({
              maybeContent: Option.map(maybeRecord, (record) => record.content),
            })
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadHistoryEntryAt({
            message: `Version konnte nicht geladen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const RestoreBinaryHistoryEntryAt = Command.define("RestoreBinaryHistoryEntryAt", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
    endOffset: Schema.Number,
    saveCurrentIfMissing: Schema.Boolean,
  },
  messages: [Message.SucceededRestoreBinaryHistoryEntry, Message.FailedRestoreBinaryHistoryEntry],
  execute: (args) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((timestampMs) =>
        Effect.tryPromise({
          try: async () => {
            const storage = requireActiveStorage()
            const maybeRecord = await loadFileHistoryBytesAt(
              args.subPath,
              args.fileName,
              args.endOffset,
            )
            if (Option.isNone(maybeRecord)) {
              const entries = await storage.listEntries(args.subPath)
              return Message.SucceededRestoreBinaryHistoryEntry({
                maybeFileMode: Option.none(),
                entries,
              })
            }
            if (args.saveCurrentIfMissing) {
              try {
                const currentBuffer = await storage.readFileBuffer(args.subPath, args.fileName)
                const currentBytes = new Uint8Array(currentBuffer)
                const currentHash = hashContentBytes(currentBytes)
                const existingIndex = await loadFileHistoryIndex(args.subPath, args.fileName)
                const isAlreadySaved = Array.some(
                  existingIndex,
                  (entry) =>
                    entry.contentHash === currentHash &&
                    entry.byteLength === currentBytes.byteLength,
                )
                if (!isAlreadySaved) {
                  await appendFileHistoryBytes(
                    args.subPath,
                    args.fileName,
                    currentBytes,
                    timestampMs,
                  )
                }
              } catch {
                // NOTE: Nicht verfügbares OPFS darf die Wiederherstellung nicht blockieren
              }
            }
            await storage.writeFileBuffer(
              args.subPath,
              args.fileName,
              new Uint8Array(maybeRecord.value.bytes),
            )
            revokeActivePreviewUrl()
            const [nextFileMode, entries] = await Promise.all([
              loadEditorFileModeForEntry(storage, args.subPath, args.fileName),
              storage.listEntries(args.subPath),
            ])
            return Message.SucceededRestoreBinaryHistoryEntry({
              maybeFileMode: Option.some(nextFileMode),
              entries,
            })
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedRestoreBinaryHistoryEntry({
            message: `Version konnte nicht geladen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const LoadHistoryPreviewAt = Command.define("LoadHistoryPreviewAt", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
    endOffset: Schema.Number,
  },
  messages: [Message.SucceededLoadHistoryPreviewAt, Message.FailedLoadHistoryPreviewAt],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const maybeRecord = await loadFileHistoryBytesAt(
          args.subPath,
          args.fileName,
          args.endOffset,
        )
        if (Option.isNone(maybeRecord)) {
          return Message.SucceededLoadHistoryPreviewAt({
            maybeContent: Option.none(),
          })
        }
        const check = checkTextBytes(maybeRecord.value.bytes)
        if (check.kind === "binary") {
          return Option.match(getPreviewType(args.fileName), {
            onNone: () =>
              Message.FailedLoadHistoryPreviewAt({
                message: "Für Binärdateien ist keine Vorschau verfügbar.",
              }),
            onSome: (previewKind) => {
              const mimeType =
                previewKind === "pdf" ? "application/pdf" : getMimeType(args.fileName)
              const blob = new Blob([new Uint8Array(maybeRecord.value.bytes)], {
                type: mimeType,
              })
              const objectUrl = URL.createObjectURL(blob)
              setActiveHistoryPreviewUrl(objectUrl)
              return Message.SucceededLoadHistoryPreviewAt({
                maybeContent: Option.some(
                  previewKind === "image"
                    ? HistoryPreview.Image({ objectUrl })
                    : HistoryPreview.Pdf({ objectUrl }),
                ),
              })
            },
          })
        }
        return Message.SucceededLoadHistoryPreviewAt({
          maybeContent: Option.some(
            HistoryPreview.Text({
              content: check.kind === "text" ? check.text : "",
            }),
          ),
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadHistoryPreviewAt({
            message: `Vorschau konnte nicht geladen werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const RevokeActiveHistoryPreviewUrl = Command.define("RevokeActiveHistoryPreviewUrl", {
  messages: [Message.CompletedRevokeActiveHistoryPreviewUrl],
  execute: Effect.sync(() => {
    revokeActiveHistoryPreviewUrl()
    return Message.CompletedRevokeActiveHistoryPreviewUrl()
  }),
})

export const DeleteLatestFileHistoryEntry = Command.define("DeleteLatestFileHistoryEntry", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
  },
  messages: [Message.SucceededDeleteLatestHistoryEntry, Message.FailedDeleteLatestHistoryEntry],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        await truncateLatestFileHistoryEntry(args.subPath, args.fileName)
        return Message.SucceededDeleteLatestHistoryEntry()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedDeleteLatestHistoryEntry({
            message: `Neueste Version konnte nicht gelöscht werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

export const ClearFileHistory = Command.define("ClearFileHistory", {
  args: {
    subPath: Schema.Array(Schema.String),
    fileName: Schema.String,
  },
  messages: [Message.SucceededClearHistory, Message.FailedClearHistory],
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        await clearFileHistory(args.subPath, args.fileName)
        return Message.SucceededClearHistory()
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedClearHistory({
            message: `Verlauf konnte nicht gelöscht werden: ${error.message}`,
          }),
        ),
      ),
    ),
})

// UPDATE

const whenCreateFile = (
  model: Model,
  fn: (state: CreateFileModel) => {
    readonly model: Model
    readonly commands?: ReadonlyArray<Command.Command<Message>>
    readonly outMessage: OutMessage
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Match.value(model).pipe(
    Match.tag("CreateFile", fn),
    Match.orElse(() => ({ model, outMessage: OutMessage.None() })),
  )

const whenBinaryEditor = (
  model: Model,
  fn: (
    editState: EditFileModel,
    binaryMode: BinaryFileMode,
  ) => {
    readonly model: Model
    readonly commands?: ReadonlyArray<Command.Command<Message>>
    readonly outMessage: OutMessage
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Match.value(model).pipe(
    Match.tag("EditFile", (editState) =>
      Match.value(editState.fileMode).pipe(
        Match.tag("Binary", (binaryMode) => fn(editState, binaryMode)),
        Match.orElse(() => ({ model, outMessage: OutMessage.None() })),
      ),
    ),
    Match.orElse(() => ({ model, outMessage: OutMessage.None() })),
  )

const handleSaveAction = (
  model: Model,
  context: {
    readonly subPath: ReadonlyArray<string>
    readonly existingEntries: ReadonlyArray<FileEntry>
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} => {
  const makeSaveCommand = (nextModel: Model) =>
    SaveChanges({ model: nextModel, subPath: context.subPath })

  const validateName = (rawName: string, isFolder: boolean): Option.Option<string> => {
    const trimmed = rawName.trim()
    if (!trimmed) {
      return Option.some(
        isFolder
          ? "Bitte geben Sie einen Ordnernamen ein."
          : "Bitte geben Sie einen Dateinamen ein.",
      )
    }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      return Option.some(
        `Der ${isFolder ? "Ordnername" : "Dateiname"} darf keine Schrägstriche enthalten.`,
      )
    }
    return Option.none()
  }

  const existingNames = new Set(
    Array.map(
      Array.filter(context.existingEntries, (e) => e.isDeleted !== true),
      (e) => e.name,
    ),
  )

  return Model.match(model, {
    CreateFolder: (createFolder) => {
      const error = validateName(createFolder.name, true)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(createFolder, {
            maybeValidationError: () => error,
          }),
          outMessage: OutMessage.None(),
        }
      }
      const trimmed = createFolder.name.trim()
      if (existingNames.has(trimmed)) {
        return {
          model: modifyFields(createFolder, {
            maybeValidationError: () =>
              Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const nextModel = modifyFields(createFolder, {})
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    EditFolder: (editFolder) => {
      const error = validateName(editFolder.name, true)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(editFolder, {
            maybeValidationError: () => error,
          }),
          outMessage: OutMessage.None(),
        }
      }
      const trimmed = editFolder.name.trim()
      if (trimmed !== editFolder.originalName && existingNames.has(trimmed)) {
        return {
          model: modifyFields(editFolder, {
            maybeValidationError: () =>
              Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const nextModel = modifyFields(editFolder, {})
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    CreateFile: (createFile) => {
      const error = validateName(createFile.name, false)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(createFile, {
            maybeValidationError: () => error,
          }),
          outMessage: OutMessage.None(),
        }
      }
      const trimmed = createFile.name.trim()
      if (existingNames.has(trimmed)) {
        return {
          model: Model.ConfirmOverwrite({
            targetName: trimmed,
            source: OverwriteSource.CreateFile({
              content: createFile.content,
              selectedTemplateId: createFile.selectedTemplateId,
              userTemplates: createFile.userTemplates,
            }),
          }),
          outMessage: OutMessage.None(),
        }
      }
      const nextModel = modifyFields(createFile, {})
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    EditFile: (editFile) => {
      const error = validateName(editFile.name, false)
      if (Option.isSome(error)) {
        return {
          model: modifyFields(editFile, {
            maybeValidationError: () => error,
          }),
          outMessage: OutMessage.None(),
        }
      }

      const trimmed = editFile.name.trim()

      const maybeBase64Content = EditorFileMode.match(editFile.fileMode, {
        Text: () => Option.none<string>(),
        Binary: ({ edit }) =>
          BinaryEdit.match(edit, {
            Locked: () => Option.none<string>(),
            Disabled: () => Option.none<string>(),
            Loading: () => Option.none<string>(),
            Editing: ({ content }) => Option.some(content),
          }),
      })

      if (Option.isSome(maybeBase64Content)) {
        try {
          base64ToUint8Array(maybeBase64Content.value)
        } catch {
          return {
            model: modifyFields(editFile, {
              maybeValidationError: () =>
                Option.some("Ungültige Base64-Kodierung. Bitte überprüfen Sie die Eingabe."),
            }),
            outMessage: OutMessage.None(),
          }
        }
      }

      if (trimmed !== editFile.originalName && existingNames.has(trimmed)) {
        const isText = EditorFileMode.match(editFile.fileMode, {
          Text: () => true,
          Binary: () => false,
        })
        if (!isText && Option.isNone(maybeBase64Content)) {
          return {
            model: modifyFields(editFile, {
              maybeValidationError: () =>
                Option.some(`Ein Eintrag mit dem Namen "${trimmed}" existiert bereits.`),
            }),
            outMessage: OutMessage.None(),
          }
        }
        return {
          model: Model.ConfirmOverwrite({
            targetName: trimmed,
            source: OverwriteSource.EditFile({
              originalName: editFile.originalName,
              fileMode: editFile.fileMode,
            }),
          }),
          outMessage: OutMessage.None(),
        }
      }

      const nextModel = modifyFields(editFile, {})
      return {
        model: nextModel,
        commands: [makeSaveCommand(nextModel)],
        outMessage: OutMessage.None(),
      }
    },
    ConfirmOverwrite: () => ({
      model: modifyFields(model, {}),
      commands: [makeSaveCommand(model)],
      outMessage: OutMessage.None(),
    }),
  })
}

export const update = (
  model: Model,
  message: Message,
  context: {
    readonly subPath: ReadonlyArray<string>
    readonly existingEntries: ReadonlyArray<FileEntry>
    readonly llmEnabled: boolean
    readonly llmEditFormat: EditFormat
  },
): {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command.Command<Message>>
  readonly outMessage: OutMessage
} =>
  Message.match(message, {
    UpdatedName: ({ name }) => ({
      model: Model.match(model, {
        CreateFile: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
          }),
        CreateFolder: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
          }),
        EditFolder: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
          }),
        EditFile: (state) =>
          modifyFields(state, {
            name: () => name,
            maybeValidationError: () => Option.none(),
          }),
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    UpdatedTextContent: ({ content }) => ({
      model: Model.match(model, {
        CreateFile: (state) =>
          modifyFields(state, {
            content: () => content,
            maybePasteError: () => Option.none(),
          }),
        CreateFolder: () => model,
        EditFolder: () => model,
        EditFile: (state) =>
          EditorFileMode.match(state.fileMode, {
            Text: () =>
              modifyFields(state, {
                fileMode: () => EditorFileMode.Text({ content }),
                maybePasteError: () => Option.none(),
              }),
            Binary: () => state,
          }),
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    SelectedTemplate: ({ templateId }) =>
      whenCreateFile(model, (state) => {
        const allTemplates = [...BUILTIN_TEMPLATES, ...state.userTemplates]
        return Option.match(
          Array.findFirst(allTemplates, (t) => t.id === templateId),
          {
            onNone: () => ({ model: state, outMessage: OutMessage.None() }),
            onSome: (template) => ({
              model: modifyFields(state, {
                selectedTemplateId: () => template.id,
                content: () => template.content,
                name: () => replaceFileExtension(state.name, template.defaultFileName),
                isDeletingTemplate: () => false,
              }),
              outMessage: OutMessage.None(),
            }),
          },
        )
      }),

    ClickedOpenSaveTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isSavingTemplate: () => true,
          isDeletingTemplate: () => false,
          newTemplateLabel: () => state.name.trim() || "Meine Vorlage",
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedCancelSaveTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isSavingTemplate: () => false,
          newTemplateLabel: () => "",
        }),
        outMessage: OutMessage.None(),
      })),

    UpdatedNewTemplateLabel: ({ label }) =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          newTemplateLabel: () => label,
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedConfirmSaveTemplate: () =>
      whenCreateFile(model, (state) => {
        const trimmedLabel = state.newTemplateLabel.trim()
        if (!trimmedLabel) {
          return { model: state, outMessage: OutMessage.None() }
        }
        return {
          model: modifyFields(state, {}),
          commands: [GenerateTemplateTimestamp()],
          outMessage: OutMessage.None(),
        }
      }),

    GeneratedTemplateTimestamp: ({ timestamp }) =>
      whenCreateFile(model, (state) => {
        const trimmedLabel = state.newTemplateLabel.trim()
        if (!trimmedLabel) {
          return { model: state, outMessage: OutMessage.None() }
        }
        // NOTE: name, id and file name must match what storage reloads from disk
        const takenNames = new Set(Array.map(state.userTemplates, (t) => t.label.toLowerCase()))
        const baseName = sanitizeTemplateName(trimmedLabel)
        const dot = baseName.lastIndexOf(".")
        const stem = dot > 0 ? baseName.slice(0, dot) : baseName
        const ext = dot > 0 ? baseName.slice(dot) : ""
        // NOTE: never overwrite an existing template; append a counter instead
        const name =
          Array.makeBy(1000, (i) => (i === 0 ? baseName : `${stem} (${i + 1})${ext}`)).find(
            (candidate) => !takenNames.has(candidate.toLowerCase()),
          ) ?? `${stem}-${timestamp}${ext}`
        const id = `user:${name}`
        const newTemplate: StarterTemplate = {
          id,
          label: name,
          defaultFileName: name,
          content: state.content,
          isBuiltin: false,
        }
        const nextTemplates = [...state.userTemplates, newTemplate]
        return {
          model: modifyFields(state, {
            userTemplates: () => nextTemplates,
            selectedTemplateId: () => id,
            isSavingTemplate: () => false,
            newTemplateLabel: () => "",
          }),
          commands: [
            SaveUserTemplate({
              template: newTemplate,
            }),
          ],
          outMessage: OutMessage.None(),
        }
      }),

    ClickedOpenDeleteTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isDeletingTemplate: () => true,
          isSavingTemplate: () => false,
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedCancelDeleteTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          isDeletingTemplate: () => false,
        }),
        outMessage: OutMessage.None(),
      })),

    ClickedConfirmDeleteTemplate: () =>
      whenCreateFile(model, (state) => {
        const templateToDelete = Array.findFirst(
          state.userTemplates,
          (t) => t.id === state.selectedTemplateId,
        )
        if (Option.isNone(templateToDelete)) {
          return {
            model: modifyFields(state, {
              isDeletingTemplate: () => false,
            }),
            outMessage: OutMessage.None(),
          }
        }
        const nextTemplates = Array.filter(
          state.userTemplates,
          (t) => t.id !== state.selectedTemplateId,
        )
        return {
          model: modifyFields(state, {
            userTemplates: () => nextTemplates,
            selectedTemplateId: () => "builtin:empty",
            isDeletingTemplate: () => false,
          }),
          commands: [
            DeleteUserTemplate({
              name: templateToDelete.value.label,
              templateId: templateToDelete.value.id,
            }),
          ],
          outMessage: OutMessage.None(),
        }
      }),

    CompletedLoadUserTemplates: ({ templates }) =>
      whenCreateFile(model, (state) => ({
        model: modifyFields(state, {
          userTemplates: () => templates,
        }),
        outMessage: OutMessage.None(),
      })),

    CompletedSaveUserTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: state,
        outMessage: OutMessage.None(),
      })),

    CompletedDeleteUserTemplate: () =>
      whenCreateFile(model, (state) => ({
        model: state,
        outMessage: OutMessage.None(),
      })),

    ToggledBase64: ({ isChecked }) =>
      whenBinaryEditor(model, (editState, binaryMode) => {
        const isLocked = BinaryEdit.match(binaryMode.edit, {
          Locked: () => true,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => false,
        })
        if (isLocked) {
          return { model, outMessage: OutMessage.None() }
        }

        if (!isChecked) {
          return {
            model: modifyFields(editState, {
              fileMode: () =>
                modifyFields(binaryMode, {
                  edit: () => BinaryEdit.Disabled(),
                }),
            }),
            outMessage: OutMessage.None(),
          }
        }

        return {
          model: modifyFields(editState, {
            fileMode: () =>
              modifyFields(binaryMode, {
                edit: () => BinaryEdit.Loading(),
              }),
          }),
          commands: [LoadBase64({ entryName: editState.originalName, subPath: context.subPath })],
          outMessage: OutMessage.None(),
        }
      }),

    SucceededLoadBase64: ({ base64Content }) =>
      whenBinaryEditor(model, (editState, binaryMode) => ({
        model: modifyFields(editState, {
          fileMode: () =>
            modifyFields(binaryMode, {
              edit: () => BinaryEdit.Editing({ content: base64Content }),
            }),
        }),
        outMessage: OutMessage.None(),
      })),

    FailedLoadBase64: ({ message: errorMessage }) =>
      whenBinaryEditor(model, (editState, binaryMode) => ({
        model: modifyFields(editState, {
          fileMode: () =>
            modifyFields(binaryMode, {
              edit: () => BinaryEdit.Disabled(),
            }),
        }),
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
      })),

    UpdatedBase64Content: ({ base64Content }) =>
      whenBinaryEditor(model, (editState, binaryMode) => {
        const isEditing = BinaryEdit.match(binaryMode.edit, {
          Locked: () => false,
          Disabled: () => false,
          Loading: () => false,
          Editing: () => true,
        })
        if (!isEditing) {
          return { model, outMessage: OutMessage.None() }
        }

        return {
          model: modifyFields(editState, {
            fileMode: () =>
              modifyFields(binaryMode, {
                edit: () => BinaryEdit.Editing({ content: base64Content }),
              }),
          }),
          outMessage: OutMessage.None(),
        }
      }),

    SelectedLlmBarMode: ({ value }) => {
      const nextMode = parseLlmBarMode(value, context.llmEnabled)
      const nextModel = setLlmBarMode(model, nextMode)
      const maybeNextMode = Model.match(nextModel, {
        CreateFile: (state) => Option.some(state.llmBarMode),
        EditFile: (state) => Option.some(state.llmBarMode),
        CreateFolder: () => Option.none(),
        EditFolder: () => Option.none(),
        ConfirmOverwrite: () => Option.none(),
      })
      const outMessage = Option.match(maybeNextMode, {
        onNone: () => OutMessage.None(),
        onSome: (llmBarMode) => OutMessage.ChangedLlmBarMode({ llmBarMode }),
      })
      return nextMode === "Chat"
        ? {
            model: nextModel,
            commands: [ScrollLlmChatToBottomIfAtBottom()],
            outMessage,
          }
        : {
            model: nextModel,
            outMessage,
          }
    },

    ClickedToggleLlmModeMenu: () => ({
      model: toggleLlmModeMenu(model),
      outMessage: OutMessage.None(),
    }),

    ClickedOutsideLlmModeMenu: () => ({
      model: setLlmModeMenuOpen(model, false),
      outMessage: OutMessage.None(),
    }),

    UpdatedLlmChatInput: ({ value }) => ({
      model: Model.match(model, {
        CreateFile: (state) => modifyFields(state, { llmChatInput: () => value }),
        EditFile: (state) => modifyFields(state, { llmChatInput: () => value }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    SubmittedLlmChat: () =>
      Model.match(model, {
        CreateFile: (state) => {
          const prompt = state.llmChatInput.trim()
          if (prompt === "" || state.llmChatState._tag === "Sending") {
            return { model, outMessage: OutMessage.None() }
          }
          return {
            model: modifyFields(state, {
              llmChatInput: () => "",
              llmChatState: () =>
                LlmChatState.Sending({
                  prompt,
                  fileName: state.name,
                  content: state.content,
                  messages: state.llmChatMessages,
                  streamTurns: [],
                  streamContent: "",
                  streamReasoning: "",
                }),
              llmChatDisplay: (current) => [
                ...current,
                LlmChatDisplayEntry.Question({ content: prompt }),
              ],
            }),
            commands: [ScrollLlmChatToBottomIfAtBottom()],
            outMessage: OutMessage.None(),
          }
        },
        EditFile: (state) => {
          const prompt = state.llmChatInput.trim()
          if (prompt === "" || state.llmChatState._tag === "Sending") {
            return { model, outMessage: OutMessage.None() }
          }
          return EditorFileMode.match(state.fileMode, {
            Text: ({ content }) => ({
              model: modifyFields(state, {
                llmChatInput: () => "",
                llmChatState: () =>
                  LlmChatState.Sending({
                    prompt,
                    fileName: state.name,
                    content,
                    messages: state.llmChatMessages,
                    streamTurns: [],
                    streamContent: "",
                    streamReasoning: "",
                  }),
                llmChatDisplay: (current) => [
                  ...current,
                  LlmChatDisplayEntry.Question({ content: prompt }),
                ],
              }),
              commands: [ScrollLlmChatToBottomIfAtBottom()],
              outMessage: OutMessage.None(),
            }),
            Binary: () => ({ model, outMessage: OutMessage.None() }),
          })
        },
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        EditFolder: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmOverwrite: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedStopLlmChat: () => {
      const wasSending = Model.match(model, {
        CreateFile: (state) => state.llmChatState._tag === "Sending",
        EditFile: (state) => state.llmChatState._tag === "Sending",
        CreateFolder: () => false,
        EditFolder: () => false,
        ConfirmOverwrite: () => false,
      })
      const nextModel = Model.match(model, {
        CreateFile: (state) =>
          state.llmChatState._tag === "Sending"
            ? modifyFields(state, {
                llmChatDisplay: (current) => [
                  ...current,
                  ...sendingEntriesToDisplay(state.llmChatState),
                ],
                llmChatState: () => LlmChatState.Idle(),
              })
            : state,
        EditFile: (state) =>
          state.llmChatState._tag === "Sending"
            ? modifyFields(state, {
                llmChatDisplay: (current) => [
                  ...current,
                  ...sendingEntriesToDisplay(state.llmChatState),
                ],
                llmChatState: () => LlmChatState.Idle(),
              })
            : state,
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      })
      return wasSending
        ? {
            model: nextModel,
            commands: [ScrollLlmChatToBottomIfAtBottom()],
            outMessage: OutMessage.None(),
          }
        : {
            model: nextModel,
            outMessage: OutMessage.None(),
          }
    },

    SucceededLlmChat: (payload) => ({
      model: applyLlmChatSuccess(model, payload),
      commands: [ScrollLlmChatToBottomIfAtBottom()],
      outMessage: OutMessage.None(),
    }),

    FailedLlmChat: ({ message }) => ({
      model: applyLlmChatFailure(model, message),
      commands: [ScrollLlmChatToBottomIfAtBottom()],
      outMessage: OutMessage.None(),
    }),

    SelectedLlmModel: ({ value }) => ({
      model,
      outMessage: OutMessage.SelectedLlmModel({ value }),
    }),

    SelectedLlmThinkingLevel: ({ value }) => ({
      model,
      outMessage: OutMessage.SelectedLlmThinkingLevel({ value }),
    }),

    ClickedToggleMaximize: () => {
      const nextModel = Model.match(model, {
        CreateFile: (state) => modifyFields(state, { isMaximized: (max) => !max }),
        EditFile: (state) => modifyFields(state, { isMaximized: (max) => !max }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      })
      const maybeMax = Model.match(nextModel, {
        CreateFile: (state) => Option.some(state.isMaximized),
        EditFile: (state) => Option.some(state.isMaximized),
        CreateFolder: () => Option.none(),
        EditFolder: () => Option.none(),
        ConfirmOverwrite: () => Option.none(),
      })
      const isChatOpen = Model.match(nextModel, {
        CreateFile: (state) => state.llmBarMode === "Chat",
        EditFile: (state) => state.llmBarMode === "Chat",
        CreateFolder: () => false,
        EditFolder: () => false,
        ConfirmOverwrite: () => false,
      })
      const outMessage = Option.match(maybeMax, {
        onNone: () => OutMessage.None(),
        onSome: (isMaximized) => OutMessage.ChangedMaximize({ isMaximized }),
      })
      return isChatOpen
        ? {
            model: nextModel,
            commands: [ScrollLlmChatToBottomIfAtBottom()],
            outMessage,
          }
        : {
            model: nextModel,
            outMessage,
          }
    },

    StartedResizeEditorSplit: ({ startScreenX, startScreenY, pointerId }) => {
      const drag = Option.some({
        axis: "horizontal" as const,
        startScreenX,
        startScreenY: startScreenY ?? startScreenX,
        startWidthPx: 0,
        containerWidthPx: 0,
      })
      const nextModel = Model.match(model, {
        CreateFile: (state) => modifyFields(state, { editorSplitDrag: () => drag }),
        EditFile: (state) => modifyFields(state, { editorSplitDrag: () => drag }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      })
      return {
        model: nextModel,
        commands: [StartEditorSplitDrag({ pointerId })],
        outMessage: OutMessage.None(),
      }
    },

    MeasuredEditorSplitDrag: ({ axis, startWidthPx, containerWidthPx }) => {
      const updateDrag = (drag: EditorSplitDrag) => ({
        axis: axis ?? "horizontal",
        startScreenX: drag.startScreenX,
        startScreenY: drag.startScreenY,
        startWidthPx,
        containerWidthPx,
      })
      const nextModel = Model.match(model, {
        CreateFile: (state) => modifyFields(state, { editorSplitDrag: Option.map(updateDrag) }),
        EditFile: (state) => modifyFields(state, { editorSplitDrag: Option.map(updateDrag) }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      })
      return {
        model: nextModel,
        outMessage: OutMessage.None(),
      }
    },

    MovedResizeEditorSplit: ({ screenX, screenY }) => {
      const computeNextPercent = (
        currentPercent: number,
        maybeDrag: Option.Option<EditorSplitDrag>,
      ): number =>
        Option.match(maybeDrag, {
          onNone: () => currentPercent,
          onSome: (drag) => {
            if (drag.containerWidthPx <= 0) {
              return currentPercent
            }
            const isVertical = drag.axis === "vertical"
            const minSizePx = isVertical ? 180 : 280
            const minOtherPanePx = isVertical ? 220 : 268
            const maxSizePx = Math.max(minSizePx, drag.containerWidthPx - minOtherPanePx)
            const deltaPx = isVertical
              ? (screenY ?? drag.startScreenY) - drag.startScreenY
              : screenX - drag.startScreenX
            const targetSizePx = drag.startWidthPx + deltaPx
            const clampedSizePx = Math.min(maxSizePx, Math.max(minSizePx, targetSizePx))
            return clampEditorSplitPercent((clampedSizePx / drag.containerWidthPx) * 100)
          },
        })
      const nextModel = Model.match(model, {
        CreateFile: (state) =>
          modifyFields(state, {
            editorSplitPercent: (percent) => computeNextPercent(percent, state.editorSplitDrag),
          }),
        EditFile: (state) =>
          modifyFields(state, {
            editorSplitPercent: (percent) => computeNextPercent(percent, state.editorSplitDrag),
          }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      })
      return {
        model: nextModel,
        outMessage: OutMessage.None(),
      }
    },

    EndedResizeEditorSplit: () => {
      const nextModel = Model.match(model, {
        CreateFile: (state) => modifyFields(state, { editorSplitDrag: () => Option.none() }),
        EditFile: (state) => modifyFields(state, { editorSplitDrag: () => Option.none() }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      })
      const maybePercent = Model.match(nextModel, {
        CreateFile: (state) => Option.some(state.editorSplitPercent),
        EditFile: (state) => Option.some(state.editorSplitPercent),
        CreateFolder: () => Option.none(),
        EditFolder: () => Option.none(),
        ConfirmOverwrite: () => Option.none(),
      })
      return {
        model: nextModel,
        outMessage: Option.match(maybePercent, {
          onNone: () => OutMessage.None(),
          onSome: (editorSplitPercent) =>
            OutMessage.ChangedEditorSplitPercent({ editorSplitPercent }),
        }),
      }
    },

    ClickedToggleEditName: () =>
      Model.match(model, {
        EditFile: (state) => {
          const nextIsEditingName = !state.isEditingName
          const nextModel = modifyFields(state, { isEditingName: () => nextIsEditingName })
          return nextIsEditingName
            ? {
                model: nextModel,
                commands: [FocusNameInput()],
                outMessage: OutMessage.None(),
              }
            : {
                model: nextModel,
                outMessage: OutMessage.None(),
              }
        },
        CreateFile: () => ({ model, outMessage: OutMessage.None() }),
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        EditFolder: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmOverwrite: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedCopyDts: () => ({
      model,
      commands: [CopyApiDtsToClipboard()],
      outMessage: OutMessage.None(),
    }),

    SucceededCopyApiDtsToClipboard: () => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: "/api.d.ts in die Zwischenablage kopiert",
          variant: "info",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    FailedCopyApiDtsToClipboard: ({ message: errorMessage }) => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    ClickedCopyLlmContext: () =>
      Option.match(getTextFileContext(model), {
        onNone: () => ({ model, outMessage: OutMessage.None() }),
        onSome: ({ fileName, content }) => ({
          model: setPasteError(model, Option.none()),
          commands: [
            CopyLlmContextToClipboard({ fileName, content, editFormat: context.llmEditFormat }),
          ],
          outMessage: OutMessage.None(),
        }),
      }),

    SucceededCopyLlmContext: () => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: "Datei und /api.d.ts für KI in die Zwischenablage kopiert",
          variant: "info",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    FailedCopyLlmContext: ({ message: errorMessage }) => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    ClickedCopyFileHashes: () =>
      Option.match(getTextFileContext(model), {
        onNone: () => ({ model, outMessage: OutMessage.None() }),
        onSome: ({ fileName, content }) => ({
          model: setPasteError(model, Option.none()),
          commands: [
            CopyFileHashesToClipboard({ fileName, content, editFormat: context.llmEditFormat }),
          ],
          outMessage: OutMessage.None(),
        }),
      }),

    SucceededCopyFileHashes: () => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message:
            context.llmEditFormat === "hashline"
              ? "Datei mit Hashes in die Zwischenablage kopiert"
              : "Datei in die Zwischenablage kopiert",
          variant: "info",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    FailedCopyFileHashes: ({ message: errorMessage }) => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    ClickedPasteLlmEdits: () => ({
      model: setPasteError(model, Option.none()),
      commands: [ReadClipboardForLlmEdits()],
      outMessage: OutMessage.None(),
    }),

    SucceededReadClipboardForLlmEdits: ({ text }) =>
      Option.match(getTextFileContext(model), {
        onNone: () => ({ model, outMessage: OutMessage.None() }),
        onSome: ({ fileName, content: currentContent }) =>
          EditApplyResult.match(applyEditsForFormat(context.llmEditFormat, currentContent, text), {
            Ok: ({ content: nextContent, appliedCount, updatedSnippet }) =>
              context.llmEditFormat === "hashline"
                ? {
                    model: applyTextContentUpdate(model, nextContent),
                    commands: [
                      CopyUpdatedHashesToClipboard({ fileName, changedLines: updatedSnippet }),
                    ],
                    outMessage: OutMessage.ShowAlert({
                      banner: {
                        message: `${appliedCount} Bearbeitung(en) angewendet – neue Hashes in die Zwischenablage kopiert`,
                        variant: "info",
                      },
                      closeModal: false,
                      replaceUrl: false,
                    }),
                  }
                : {
                    model: applyTextContentUpdate(model, nextContent),
                    commands: [ClearClipboardAfterPaste()],
                    outMessage: OutMessage.ShowAlert({
                      banner: {
                        message: `${appliedCount} Bearbeitung(en) angewendet – Zwischenablage geleert`,
                        variant: "info",
                      },
                      closeModal: false,
                      replaceUrl: false,
                    }),
                  },
            Error: ({ message: errorMessage }) => ({
              model: setPasteError(model, Option.some(errorMessage)),
              commands: [CopyPasteErrorToClipboard({ errorText: errorMessage })],
              outMessage: OutMessage.ShowAlert({
                banner: {
                  message: errorMessage,
                  variant: "danger",
                },
                closeModal: false,
                replaceUrl: false,
              }),
            }),
          }),
      }),

    SucceededCopyUpdatedHashes: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    CompletedClearClipboardAfterPaste: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    FailedCopyUpdatedHashes: ({ message: errorMessage }) => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    FailedReadClipboardForLlmEdits: ({ message: errorMessage }) => ({
      model: setPasteError(model, Option.some(errorMessage)),
      commands: [CopyPasteErrorToClipboard({ errorText: errorMessage })],
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    CompletedCopyPasteErrorToClipboard: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    ToggledLlmThinkingMarkdown: () => ({
      model: Model.match(model, {
        CreateFile: (state) =>
          state.isLlmThinkingMarkdown !== undefined
            ? modifyFields(state, {
                isLlmThinkingMarkdown: (current) => !(current ?? true),
              })
            : Model.CreateFile({ ...state, isLlmThinkingMarkdown: false }),
        EditFile: (state) =>
          state.isLlmThinkingMarkdown !== undefined
            ? modifyFields(state, {
                isLlmThinkingMarkdown: (current) => !(current ?? true),
              })
            : Model.EditFile({ ...state, isLlmThinkingMarkdown: false }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    ToggledLlmContentMarkdown: () => ({
      model: Model.match(model, {
        CreateFile: (state) =>
          state.isLlmContentMarkdown !== undefined
            ? modifyFields(state, {
                isLlmContentMarkdown: (current) => !(current ?? true),
              })
            : Model.CreateFile({ ...state, isLlmContentMarkdown: false }),
        EditFile: (state) =>
          state.isLlmContentMarkdown !== undefined
            ? modifyFields(state, {
                isLlmContentMarkdown: (current) => !(current ?? true),
              })
            : Model.EditFile({ ...state, isLlmContentMarkdown: false }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    ToggledLlmUserMarkdown: () => ({
      model: Model.match(model, {
        CreateFile: (state) =>
          state.isLlmUserMarkdown !== undefined
            ? modifyFields(state, {
                isLlmUserMarkdown: (current) => !(current ?? true),
              })
            : Model.CreateFile({ ...state, isLlmUserMarkdown: false }),
        EditFile: (state) =>
          state.isLlmUserMarkdown !== undefined
            ? modifyFields(state, {
                isLlmUserMarkdown: (current) => !(current ?? true),
              })
            : Model.EditFile({ ...state, isLlmUserMarkdown: false }),
        CreateFolder: () => model,
        EditFolder: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.None(),
    }),

    ClickedCopyLlmCode: ({ code }) => ({
      model,
      commands: [CopyLlmCodeToClipboard({ code })],
      outMessage: OutMessage.None(),
    }),

    CompletedCopyLlmCode: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    RequestedSettings: () => ({
      model,
      outMessage: OutMessage.RequestedSettings(),
    }),

    ClickedSave: () => handleSaveAction(model, context),

    ClickedOpenPreview: () =>
      Model.match(model, {
        CreateFile: (state) => ({
          model: modifyFields(state, { isPreviewOpen: () => true }),
          outMessage: OutMessage.PushUrl({ url: buildNewUrl(context.subPath, "file", true) }),
        }),
        EditFile: (state) =>
          state.fileMode._tag === "Text"
            ? {
                model: modifyFields(state, { isPreviewOpen: () => true }),
                outMessage: OutMessage.PushUrl({
                  url: buildEditUrl(context.subPath, state.originalName, true),
                }),
              }
            : {
                model,
                outMessage: OutMessage.None(),
              },
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        EditFolder: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmOverwrite: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedClosePreview: () => ({
      model: closePreview(model),
      ...(hasHistoryPreviewObjectUrl(model) ? { commands: [RevokeActiveHistoryPreviewUrl()] } : {}),
      outMessage: isEditorPreviewOpen(model) ? OutMessage.NavigateBack() : OutMessage.None(),
    }),

    ClickedConfirmOverwrite: () => ({
      model: modifyFields(model, {}),
      commands: [SaveChanges({ model, subPath: context.subPath })],
      outMessage: OutMessage.None(),
    }),

    ClickedCancelOverwrite: () => ({
      model: cancelOverwrite(model),
      outMessage: OutMessage.None(),
    }),

    ClickedDelete: () =>
      Model.match(model, {
        EditFolder: (folder) => ({
          model: modifyFields(folder, { isConfirmingDelete: () => true }),
          outMessage: OutMessage.None(),
        }),
        EditFile: (file) => ({
          model: modifyFields(file, { isConfirmingDelete: () => true }),
          outMessage: OutMessage.None(),
        }),
        CreateFile: () => ({ model, outMessage: OutMessage.None() }),
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmOverwrite: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedConfirmDelete: () =>
      Model.match(model, {
        EditFolder: ({ originalName, isConfirmingDelete }) =>
          isConfirmingDelete
            ? {
                model,
                commands: [
                  DeleteEntry({
                    entryName: originalName,
                    entryKind: "directory",
                    subPath: context.subPath,
                  }),
                ],
                outMessage: OutMessage.None(),
              }
            : { model, outMessage: OutMessage.None() },
        EditFile: ({ originalName, isConfirmingDelete }) =>
          isConfirmingDelete
            ? {
                model,
                commands: [
                  DeleteEntry({
                    entryName: originalName,
                    entryKind: "file",
                    subPath: context.subPath,
                  }),
                ],
                outMessage: OutMessage.None(),
              }
            : { model, outMessage: OutMessage.None() },
        CreateFile: () => ({ model, outMessage: OutMessage.None() }),
        CreateFolder: () => ({ model, outMessage: OutMessage.None() }),
        ConfirmOverwrite: () => ({ model, outMessage: OutMessage.None() }),
      }),

    ClickedCancelDelete: () => ({
      model: cancelDelete(model),
      outMessage: OutMessage.None(),
    }),

    ClickedClose: () => ({
      model,
      outMessage: OutMessage.CloseModal({ replaceUrl: true }),
    }),

    SucceededSaveChanges: ({ entries }) => {
      if (model._tag === "EditFile" && model.isMaximized) {
        const savedName = model.name.trim()
        return {
          model: modifyFields(model, {
            originalName: () => savedName,
            name: () => savedName,
            hasHistoryEntries: (current) => (model.isHistoryEnabled !== false ? true : current),
          }),
          outMessage: OutMessage.EntriesUpdated({
            entries,
            closeModal: false,
            maybeAlertBanner: Option.some({
              message: "Gespeichert.",
              variant: "info",
            }),
          }),
        }
      }
      if (model._tag === "CreateFile" && model.isMaximized) {
        const savedName = model.name.trim()
        return {
          model: Model.EditFile({
            originalName: savedName,
            name: savedName,
            fileMode: EditorFileMode.Text({ content: model.content }),
            maybeValidationError: Option.none(),
            maybePasteError: Option.none(),
            llmBarMode: model.llmBarMode,
            isLlmModeMenuOpen: false,
            llmChatInput: model.llmChatInput,
            llmChatMessages: model.llmChatMessages,
            llmChatDisplay: model.llmChatDisplay,
            llmChatState: model.llmChatState,
            isLlmThinkingMarkdown: model.isLlmThinkingMarkdown ?? true,
            isLlmContentMarkdown: model.isLlmContentMarkdown ?? true,
            isLlmUserMarkdown: model.isLlmUserMarkdown ?? true,
            isMaximized: true,
            isEditingName: false,
            isPreviewOpen: model.isPreviewOpen,
            editorSplitPercent: model.editorSplitPercent,
            editorSplitDrag: Option.none(),
            canUndo: false,
            canRedo: false,
            historyState: HistoryState.Closed(),
            isConfirmingDelete: false,
          }),
          outMessage: OutMessage.EntriesUpdated({
            entries,
            closeModal: false,
            maybeAlertBanner: Option.some({
              message: "Gespeichert.",
              variant: "info",
            }),
          }),
        }
      }
      return {
        model,
        outMessage: OutMessage.EntriesUpdated({
          entries,
          closeModal: true,
          maybeAlertBanner: Option.none(),
        }),
      }
    },

    FailedSaveChanges: ({ message: errorMessage }) => ({
      model,
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    SucceededDeleteEntry: ({ entries }) => ({
      model,
      outMessage: OutMessage.EntriesUpdated({
        entries,
        closeModal: true,
        maybeAlertBanner: Option.none(),
      }),
    }),

    FailedDeleteEntry: ({ message: errorMessage }) => ({
      model: Model.match(model, {
        EditFolder: (folder) => modifyFields(folder, { isConfirmingDelete: () => false }),
        EditFile: (file) => modifyFields(file, { isConfirmingDelete: () => false }),
        CreateFile: () => model,
        CreateFolder: () => model,
        ConfirmOverwrite: () => model,
      }),
      outMessage: OutMessage.ShowAlert({
        banner: {
          message: errorMessage,
          variant: "danger",
        },
        closeModal: false,
        replaceUrl: false,
      }),
    }),

    CompletedFocusNameInput: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    CompletedScrollLlmChatToBottom: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    ClickedUndo: () => {
      if (model._tag !== "EditFile" || model.fileMode._tag !== "Text") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        commands: [TriggerEditorUndo()],
        outMessage: OutMessage.None(),
      }
    },

    ClickedRedo: () => {
      if (model._tag !== "EditFile" || model.fileMode._tag !== "Text") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        commands: [TriggerEditorRedo()],
        outMessage: OutMessage.None(),
      }
    },

    CompletedTriggerEditorUndo: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    CompletedTriggerEditorRedo: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    ChangedEditorHistoryState: ({ canUndo, canRedo }) => {
      if (model._tag !== "EditFile" || model.fileMode._tag !== "Text") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model: modifyFields(model, {
          canUndo: () => canUndo,
          canRedo: () => canRedo,
        }),
        outMessage: OutMessage.None(),
      }
    },

    ClickedOpenHistory: () => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model: modifyFields(model, {
          historyState: () => HistoryState.Loading(),
        }),
        commands: [
          LoadFullHistory({
            subPath: context.subPath,
            fileName: model.originalName,
          }),
        ],
        outMessage: OutMessage.None(),
      }
    },

    ClickedCloseHistory: () => {
      const revokeCommands = hasHistoryPreviewObjectUrl(model)
        ? { commands: [RevokeActiveHistoryPreviewUrl()] }
        : {}
      if (model._tag === "EditFile" && model.isHistoryOnly) {
        return {
          model: closeHistory(model),
          ...revokeCommands,
          outMessage: OutMessage.CloseModal({ replaceUrl: true }),
        }
      }
      return {
        model: closeHistory(model),
        ...revokeCommands,
        outMessage: OutMessage.None(),
      }
    },

    SucceededLoadFullHistory: ({ entries, isHistoryEnabled }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model: modifyFields(model, {
          isHistoryEnabled: () => isHistoryEnabled,
          hasHistoryEntries: () => entries.length > 0,
          historyState: () =>
            HistoryState.Open({
              entries,
              isConfirmingClear: false,
              isHistoryEnabled,
              maybePreviewContent: Option.none(),
            }),
        }),
        outMessage: OutMessage.None(),
      }
    },

    ToggledHistoryEnabled: ({ isEnabled }) => {
      if (model._tag !== "EditFile" || model.historyState._tag !== "Open") {
        return { model, outMessage: OutMessage.None() }
      }
      const openState = model.historyState
      return {
        model: modifyFields(model, {
          isHistoryEnabled: () => isEnabled,
          historyState: () =>
            HistoryState.Open({
              entries: openState.entries,
              isConfirmingClear: openState.isConfirmingClear,
              isHistoryEnabled: isEnabled,
              maybePreviewContent: openState.maybePreviewContent,
            }),
        }),
        commands: [SaveHistoryEnabled({ isEnabled })],
        outMessage: OutMessage.None(),
      }
    },

    CompletedSaveHistoryEnabled: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    FailedLoadFullHistory: ({ message: errorMessage }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model: modifyFields(model, {
          historyState: () => HistoryState.Closed(),
        }),
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
      }
    },

    ClickedRestoreHistoryEntry: ({ endOffset }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      const isHistoryEnabled =
        model.historyState._tag === "Open" ? model.historyState.isHistoryEnabled : true
      if (model.fileMode._tag === "Binary" || model.isHistoryOnly === true) {
        return {
          model: modifyFields(model, {
            historyState: () => HistoryState.Loading(),
          }),
          commands: [
            RestoreBinaryHistoryEntryAt({
              subPath: context.subPath,
              fileName: model.originalName,
              endOffset,
              saveCurrentIfMissing: isHistoryEnabled,
            }),
          ],
          outMessage: OutMessage.None(),
        }
      }
      const currentContent = model.fileMode.content
      const { contentHash: currentHash, byteLength: currentByteLength } =
        hashAndMeasureHistoryContent(currentContent)
      const isCurrentInHistory =
        model.historyState._tag === "Open" &&
        Array.some(
          model.historyState.entries,
          (entry) => entry.contentHash === currentHash && entry.byteLength === currentByteLength,
        )
      return {
        model: modifyFields(model, {
          historyState: () => HistoryState.Loading(),
        }),
        commands: [
          LoadHistoryEntryAt({
            subPath: context.subPath,
            fileName: model.originalName,
            endOffset,
            maybeSaveCurrentContent:
              !isHistoryEnabled || isCurrentInHistory ? Option.none() : Option.some(currentContent),
          }),
        ],
        outMessage: OutMessage.None(),
      }
    },

    SucceededLoadHistoryEntryAt: ({ maybeContent }) => {
      if (model._tag !== "EditFile" || model.fileMode._tag !== "Text") {
        return { model, outMessage: OutMessage.None() }
      }
      return Option.match(maybeContent, {
        onNone: () => ({
          model: modifyFields(model, {
            historyState: () => HistoryState.Closed(),
          }),
          outMessage: OutMessage.ShowAlert({
            banner: {
              message: "Version konnte nicht geladen werden.",
              variant: "danger",
            },
            closeModal: false,
            replaceUrl: false,
          }),
        }),
        onSome: (content) => ({
          model: modifyFields(model, {
            fileMode: () => EditorFileMode.Text({ content }),
            historyState: () => HistoryState.Closed(),
          }),
          outMessage: OutMessage.None(),
        }),
      })
    },

    FailedLoadHistoryEntryAt: ({ message: errorMessage }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model: modifyFields(model, {
          historyState: () => HistoryState.Closed(),
        }),
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
      }
    },

    SucceededRestoreBinaryHistoryEntry: ({ maybeFileMode, entries }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return Option.match(maybeFileMode, {
        onNone: () => ({
          model: modifyFields(model, {
            historyState: () => HistoryState.Closed(),
          }),
          outMessage: OutMessage.ShowAlert({
            banner: {
              message: "Version konnte nicht geladen werden.",
              variant: "danger",
            },
            closeModal: false,
            replaceUrl: false,
          }),
        }),
        onSome: (nextFileMode) => ({
          model: modifyFields(model, {
            fileMode: () => nextFileMode,
            historyState: () => HistoryState.Closed(),
            hasHistoryEntries: () => true,
          }),
          outMessage: OutMessage.EntriesUpdated({
            entries,
            closeModal: model.isHistoryOnly === true,
            maybeAlertBanner: Option.some({
              message: "Version wiederhergestellt.",
              variant: "info",
            }),
          }),
        }),
      })
    },

    FailedRestoreBinaryHistoryEntry: ({ message: errorMessage }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model: modifyFields(model, {
          historyState: () => HistoryState.Closed(),
        }),
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
      }
    },

    ClickedPreviewHistoryEntry: ({ endOffset }) => {
      if (
        model._tag !== "EditFile" ||
        !canPreviewHistoryEntry(model.originalName, model.fileMode, model.isDeletedHistory)
      ) {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        commands: [
          LoadHistoryPreviewAt({
            subPath: context.subPath,
            fileName: model.originalName,
            endOffset,
          }),
        ],
        outMessage: OutMessage.None(),
      }
    },

    SucceededLoadHistoryPreviewAt: ({ maybeContent }) => {
      if (model._tag !== "EditFile" || model.historyState._tag !== "Open") {
        return { model, outMessage: OutMessage.None() }
      }
      const openState = model.historyState
      return Option.match(maybeContent, {
        onNone: () => ({
          model,
          outMessage: OutMessage.ShowAlert({
            banner: {
              message: "Version konnte nicht geladen werden.",
              variant: "danger",
            },
            closeModal: false,
            replaceUrl: false,
          }),
        }),
        onSome: (content) => ({
          model: modifyFields(model, {
            historyState: () =>
              HistoryState.Open({
                entries: openState.entries,
                isConfirmingClear: openState.isConfirmingClear,
                isHistoryEnabled: openState.isHistoryEnabled,
                maybePreviewContent: Option.some(content),
              }),
          }),
          outMessage: OutMessage.None(),
        }),
      })
    },

    FailedLoadHistoryPreviewAt: ({ message: errorMessage }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
      }
    },

    CompletedRevokeActiveHistoryPreviewUrl: () => ({
      model,
      outMessage: OutMessage.None(),
    }),

    ClickedRequestClearHistory: () => {
      if (model._tag !== "EditFile" || model.historyState._tag !== "Open") {
        return { model, outMessage: OutMessage.None() }
      }
      const openState = model.historyState
      return {
        model: modifyFields(model, {
          historyState: () =>
            HistoryState.Open({
              entries: openState.entries,
              isConfirmingClear: true,
              isHistoryEnabled: openState.isHistoryEnabled,
              maybePreviewContent: openState.maybePreviewContent,
            }),
        }),
        outMessage: OutMessage.None(),
      }
    },

    ClickedCancelClearHistory: () => {
      if (model._tag !== "EditFile" || model.historyState._tag !== "Open") {
        return { model, outMessage: OutMessage.None() }
      }
      const openState = model.historyState
      return {
        model: modifyFields(model, {
          historyState: () =>
            HistoryState.Open({
              entries: openState.entries,
              isConfirmingClear: false,
              isHistoryEnabled: openState.isHistoryEnabled,
              maybePreviewContent: openState.maybePreviewContent,
            }),
        }),
        outMessage: OutMessage.None(),
      }
    },

    ClickedConfirmClearHistory: () => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        commands: [
          ClearFileHistory({
            subPath: context.subPath,
            fileName: model.originalName,
          }),
        ],
        outMessage: OutMessage.None(),
      }
    },

    SucceededClearHistory: () => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      const isHistoryEnabled =
        model.historyState._tag === "Open" ? model.historyState.isHistoryEnabled : true
      return {
        model: modifyFields(model, {
          hasHistoryEntries: () => false,
          historyState: () =>
            HistoryState.Open({
              entries: [],
              isConfirmingClear: false,
              isHistoryEnabled,
              maybePreviewContent: Option.none(),
            }),
        }),
        outMessage: OutMessage.FileHistoryCleared({
          fileName: model.originalName,
        }),
      }
    },

    FailedClearHistory: ({ message: errorMessage }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
      }
    },

    ClickedDeleteLatestHistoryEntry: () => {
      if (model._tag !== "EditFile" || model.historyState._tag !== "Open") {
        return { model, outMessage: OutMessage.None() }
      }
      const openState = model.historyState
      return {
        model: modifyFields(model, {
          historyState: () =>
            HistoryState.Open({
              entries: openState.entries,
              isConfirmingClear: openState.isConfirmingClear,
              isConfirmingDeleteLatest: true,
              isHistoryEnabled: openState.isHistoryEnabled,
              maybePreviewContent: openState.maybePreviewContent,
            }),
        }),
        outMessage: OutMessage.None(),
      }
    },

    ClickedCancelDeleteLatestHistoryEntry: () => {
      if (model._tag !== "EditFile" || model.historyState._tag !== "Open") {
        return { model, outMessage: OutMessage.None() }
      }
      const openState = model.historyState
      return {
        model: modifyFields(model, {
          historyState: () =>
            HistoryState.Open({
              entries: openState.entries,
              isConfirmingClear: openState.isConfirmingClear,
              isConfirmingDeleteLatest: false,
              isHistoryEnabled: openState.isHistoryEnabled,
              maybePreviewContent: openState.maybePreviewContent,
            }),
        }),
        outMessage: OutMessage.None(),
      }
    },

    ClickedConfirmDeleteLatestHistoryEntry: () => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        commands: [
          DeleteLatestFileHistoryEntry({
            subPath: context.subPath,
            fileName: model.originalName,
          }),
        ],
        outMessage: OutMessage.None(),
      }
    },

    SucceededDeleteLatestHistoryEntry: () => {
      if (model._tag !== "EditFile" || model.historyState._tag !== "Open") {
        return { model, outMessage: OutMessage.None() }
      }
      const openState = model.historyState
      const nextEntries = openState.entries.slice(1)
      return {
        model: modifyFields(model, {
          hasHistoryEntries: () => nextEntries.length > 0,
          historyState: () =>
            HistoryState.Open({
              entries: nextEntries,
              isConfirmingClear: false,
              isConfirmingDeleteLatest: false,
              isHistoryEnabled: openState.isHistoryEnabled,
              maybePreviewContent: Option.none(),
            }),
        }),
        outMessage:
          nextEntries.length === 0
            ? OutMessage.FileHistoryCleared({
                fileName: model.originalName,
              })
            : OutMessage.None(),
      }
    },

    FailedDeleteLatestHistoryEntry: ({ message: errorMessage }) => {
      if (model._tag !== "EditFile") {
        return { model, outMessage: OutMessage.None() }
      }
      return {
        model,
        outMessage: OutMessage.ShowAlert({
          banner: {
            message: errorMessage,
            variant: "danger",
          },
          closeModal: false,
          replaceUrl: false,
        }),
      }
    },
  })

// VIEW

const viewTemplatePicker = (state: CreateFileModel, h: Html.HtmlBuilder<Message>): Html.Html => {
  const selectedTemplate = Array.findFirst(
    state.userTemplates,
    (t) => t.id === state.selectedTemplateId,
  )
  const isCustomSelected = Option.isSome(selectedTemplate)

  return h.div(
    [h.Class("form-group")],
    [
      h.label([h.For("modal-template-select")], ["Vorlage:"]),
      h.div(
        [h.Class("template-toolbar")],
        [
          h.select(
            [
              h.Id("modal-template-select"),
              h.Class("form-input"),
              h.Value(state.selectedTemplateId),
              h.OnChange((templateId) => Message.SelectedTemplate({ templateId })),
            ],
            [
              ...(Array.isReadonlyArrayNonEmpty(state.userTemplates)
                ? [
                    h.optgroup(
                      [h.LabelAttr("Eigene Vorlagen")],
                      pipe(
                        state.userTemplates,
                        Array.map((t) =>
                          h.option(
                            [h.Value(t.id), h.Selected(t.id === state.selectedTemplateId)],
                            [t.label],
                          ),
                        ),
                      ),
                    ),
                  ]
                : []),
              h.optgroup(
                [h.LabelAttr("Standard-Vorlagen")],
                pipe(
                  BUILTIN_TEMPLATES,
                  Array.map((t) =>
                    h.option(
                      [h.Value(t.id), h.Selected(t.id === state.selectedTemplateId)],
                      [t.label],
                    ),
                  ),
                ),
              ),
            ],
          ),
          !state.isSavingTemplate && !state.isDeletingTemplate
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-save-template"),
                  h.Class("btn btn-secondary btn-icon"),
                  h.Title("Aktuellen Inhalt als eigene Vorlage speichern"),
                  h.AriaLabel("Aktuellen Inhalt als eigene Vorlage speichern"),
                  h.OnClick(Message.ClickedOpenSaveTemplate()),
                ],
                [viewIcon("save", h)],
              )
            : h.empty,
          isCustomSelected && !state.isSavingTemplate && !state.isDeletingTemplate
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-delete-template"),
                  h.Class("btn btn-danger btn-icon"),
                  h.Title("Ausgewählte eigene Vorlage löschen"),
                  h.AriaLabel("Ausgewählte eigene Vorlage löschen"),
                  h.OnClick(Message.ClickedOpenDeleteTemplate()),
                ],
                [viewIcon("trash", h)],
              )
            : h.empty,
        ],
      ),
      state.isSavingTemplate
        ? h.div(
            [h.Id("modal-save-template-box"), h.Class("template-save-row")],
            [
              h.input([
                h.Type("text"),
                h.Id("modal-template-name"),
                h.Class("form-input"),
                h.Placeholder("Name der Vorlage (z. B. Mein Dashboard)"),
                h.Value(state.newTemplateLabel),
                h.OnInput((label) => Message.UpdatedNewTemplateLabel({ label })),
              ]),
              h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-cancel-save-template"),
                  h.Class("btn btn-secondary icon-label-btn"),
                  h.AriaLabel("Abbrechen"),
                  h.DataAttribute("tip", "Abbrechen"),
                  h.OnClick(Message.ClickedCancelSaveTemplate()),
                ],
                [
                  h.span(
                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                    [viewIcon("close", h)],
                  ),
                  h.span([h.Class("icon-label-btn-text")], ["Abbrechen"]),
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("modal-btn-confirm-save-template"),
                  h.Class("btn btn-primary icon-label-btn"),
                  h.AriaLabel("Speichern"),
                  h.DataAttribute("tip", "Speichern"),
                  h.OnClick(Message.ClickedConfirmSaveTemplate()),
                ],
                [
                  h.span(
                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                    [viewIcon("save", h)],
                  ),
                  h.span([h.Class("icon-label-btn-text")], ["Speichern"]),
                ],
              ),
            ],
          )
        : h.empty,
    ],
  )
}

const viewPreviewContent = (preview: PreviewContent, h: Html.HtmlBuilder<Message>): Html.Html =>
  PreviewContent.match(preview, {
    None: () => h.empty,
    Image: ({ objectUrl }) =>
      h.figure(
        [h.Id("modal-file-preview"), h.Class("file-preview")],
        [h.img([h.Src(objectUrl), h.Alt("Vorschau der Datei"), h.Class("file-preview-image")])],
      ),
    Pdf: ({ objectUrl }) =>
      h.figure(
        [h.Id("modal-file-preview"), h.Class("file-preview")],
        [h.iframe([h.Src(objectUrl), h.Title("Vorschau der Datei"), h.Class("file-preview-pdf")])],
      ),
  })

const viewEditorFileBody = (
  fileMode: EditorFileMode,
  filename: string,
  monacoSettings: MonacoSettings,
  appTheme: AppTheme,
  h: Html.HtmlBuilder<Message>,
): ReadonlyArray<Html.Html> =>
  EditorFileMode.match(fileMode, {
    Text: ({ content }) => {
      const monacoEditor = monacoEditorElement.withMessage(h)
      return [
        h.div(
          [h.Class("form-group")],
          [
            monacoEditor([
              monacoEditor.Value(content),
              monacoEditor.Filename(filename),
              monacoEditor.LineNumbers(monacoSettings.lineNumbers),
              monacoEditor.Folding(monacoSettings.folding),
              monacoEditor.WordWrap(monacoSettings.wordWrap),
              monacoEditor.ScrollBeyondLastLine(monacoSettings.scrollBeyondLastLine),
              monacoEditor.Theme(monacoSettings.theme),
              monacoEditor.AppTheme(appTheme),
              monacoEditor.LineDecorationsWidth(monacoSettings.lineDecorationsWidth),
              monacoEditor.LineNumbersMinChars(monacoSettings.lineNumbersMinChars),
              monacoEditor.OnContentChanged((detail) =>
                Message.UpdatedTextContent({ content: detail.value }),
              ),
              monacoEditor.OnHistoryChanged((detail) => Message.ChangedEditorHistoryState(detail)),
              monacoEditor.OnSaveRequested(() => Message.ClickedSave()),
              monacoEditor.OnSettingsRequested(() => Message.RequestedSettings()),
              h.Id("modal-file-content"),
              h.Class("monaco-editor-host"),
              h.AriaLabel("Inhalt"),
            ]),
          ],
        ),
      ]
    },

    Binary: ({ preview, edit }) => {
      const { isLocked, isChecked, isLoading, isEditing, lockReason, base64Content } =
        BinaryEdit.match(edit, {
          Locked: ({ reason }) => ({
            isLocked: true,
            isChecked: false,
            isLoading: false,
            isEditing: false,
            lockReason: reason,
            base64Content: "",
          }),
          Disabled: () => ({
            isLocked: false,
            isChecked: false,
            isLoading: false,
            isEditing: false,
            lockReason: "",
            base64Content: "",
          }),
          Loading: () => ({
            isLocked: false,
            isChecked: true,
            isLoading: true,
            isEditing: false,
            lockReason: "",
            base64Content: "",
          }),
          Editing: ({ content }) => ({
            isLocked: false,
            isChecked: true,
            isLoading: false,
            isEditing: true,
            lockReason: "",
            base64Content: content,
          }),
        })

      return [
        h.div(
          [h.Class("form-group")],
          [
            !isLocked
              ? h.label(
                  [h.Class("form-check")],
                  [
                    h.input([
                      h.Type("checkbox"),
                      h.Id("modal-use-base64"),
                      h.Checked(isChecked),
                      h.Disabled(isLoading),
                      h.OnChange(() =>
                        Message.ToggledBase64({
                          isChecked: !isChecked,
                        }),
                      ),
                    ]),
                    h.span([], ["Binärdatei bearbeiten"]),
                  ],
                )
              : h.p([h.Class("form-hint")], [lockReason]),
            isEditing
              ? h.div(
                  [h.Id("modal-base64-editor"), h.Class("form-group")],
                  [
                    h.label([h.For("modal-file-content-b64")], ["Base64-Inhalt:"]),
                    h.textarea([
                      h.Id("modal-file-content-b64"),
                      h.Class("form-textarea form-textarea-mono"),
                      h.Spellcheck(false),
                      h.Placeholder("Base64-Daten dieser Datei"),
                      h.Value(base64Content),
                      h.OnInput((value) =>
                        Message.UpdatedBase64Content({
                          base64Content: value,
                        }),
                      ),
                    ]),
                  ],
                )
              : h.empty,
            isChecked ? h.empty : viewPreviewContent(preview, h),
          ],
        ),
      ]
    },
  })

const viewLlmButtons = (
  maybePasteError: Option.Option<string>,
  h: Html.HtmlBuilder<Message>,
): ReadonlyArray<Html.Html> => [
  h.button(
    [
      h.Type("button"),
      h.Id("modal-btn-copy-dts"),
      h.Class("btn btn-secondary icon-label-btn"),
      h.AriaLabel("/app.d.ts kopieren"),
      h.DataAttribute("tip", "/app.d.ts kopieren"),
      h.OnClick(Message.ClickedCopyDts()),
    ],
    [
      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("clipboard", h)]),
      h.span([h.Class("icon-label-btn-text")], ["/app.d.ts"]),
    ],
  ),
  h.button(
    [
      h.Type("button"),
      h.Id("modal-btn-copy-llm"),
      h.Class("btn btn-secondary icon-label-btn"),
      h.AriaLabel("Datei, /api.d.ts und Anleitung für KI kopieren"),
      h.DataAttribute("tip", "Datei, /api.d.ts und Anleitung kopieren"),
      h.OnClick(Message.ClickedCopyLlmContext()),
    ],
    [
      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("clipboard", h)]),
      h.span([h.Class("icon-label-btn-text")], ["Mit Anleitung"]),
    ],
  ),
  h.button(
    [
      h.Type("button"),
      h.Id("modal-btn-copy-hashes"),
      h.Class("btn btn-secondary icon-label-btn"),
      h.AriaLabel("Nur Datei mit Hashes kopieren"),
      h.DataAttribute("tip", "Nur Datei mit Hashes kopieren"),
      h.OnClick(Message.ClickedCopyFileHashes()),
    ],
    [
      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("clipboard", h)]),
      h.span([h.Class("icon-label-btn-text")], ["Datei"]),
    ],
  ),
  Option.match(maybePasteError, {
    onNone: () =>
      h.button(
        [
          h.Type("button"),
          h.Id("modal-btn-paste-llm"),
          h.Class("btn btn-secondary icon-label-btn"),
          h.AriaLabel("KI-Änderungen einfügen"),
          h.DataAttribute("tip", "KI-Änderungen einfügen"),
          h.OnClick(Message.ClickedPasteLlmEdits()),
        ],
        [
          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("install", h)]),
          h.span([h.Class("icon-label-btn-text")], ["Einfügen"]),
        ],
      ),
    onSome: (pasteError) =>
      h.button(
        [
          h.Type("button"),
          h.Id("modal-btn-paste-llm"),
          h.Class("btn btn-danger icon-label-btn"),
          h.AriaLabel(`Fehler beim Einfügen: ${pasteError}`),
          h.DataAttribute("tip", "Fehler (in Zwischenablage kopiert)"),
          h.OnClick(Message.ClickedPasteLlmEdits()),
        ],
        [
          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], [viewIcon("warning", h)]),
          h.span([h.Class("icon-label-btn-text")], ["Fehler"]),
        ],
      ),
  }),
]

export type ViewInputs = {
  readonly llmEnabled: boolean
  readonly llmModelOptions: ReadonlyArray<ModelOption>
  readonly llmSelectedModel: string
  readonly llmThinkingLevels: ReadonlyArray<ThinkingLevelOption>
  readonly llmSelectedThinkingLevel: string
  readonly monacoSettings: MonacoSettings
  readonly appTheme: AppTheme
  readonly llmChatAiName?: string
  readonly llmChatUserName?: string
}

const viewLlmChatHistory = (
  llmChatMessages: ReadonlyArray<LlmChatMessage>,
  llmChatDisplay: ReadonlyArray<LlmChatDisplayEntry>,
  llmChatState: LlmChatState,
  isThinkingMarkdown: boolean,
  isContentMarkdown: boolean,
  isUserMarkdown: boolean,
  aiName: string,
  userName: string,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const isSending = llmChatState._tag === "Sending"
  const systemMessages = Array.filter(llmChatMessages, (msg) => msg._tag === "System")
  const autoUserMessages =
    llmChatMessages.length >= 4 &&
    llmChatMessages[0]?._tag === "System" &&
    llmChatMessages[1]?._tag === "User" &&
    llmChatMessages[2]?._tag === "User"
      ? [llmChatMessages[1], llmChatMessages[2]]
      : []

  if (
    Array.isReadonlyArrayEmpty(llmChatDisplay) &&
    Array.isReadonlyArrayEmpty(systemMessages) &&
    !isSending
  ) {
    return h.empty
  }

  const onCopyCode = (code: string) => Message.ClickedCopyLlmCode({ code })

  const systemNodes =
    Array.isReadonlyArrayNonEmpty(systemMessages) || Array.isReadonlyArrayNonEmpty(autoUserMessages)
      ? [
          h.details(
            [h.Class("modal-llm-chat-details is-system")],
            [
              h.summary(
                [h.Class("modal-llm-chat-details-summary")],
                [
                  Array.isReadonlyArrayNonEmpty(autoUserMessages)
                    ? "System-Nachricht & Kontext"
                    : "System-Nachricht",
                ],
              ),
              h.div(
                [h.Class("modal-llm-chat-details-body")],
                [
                  ...Array.map(systemMessages, (msg) =>
                    h.div(
                      [h.Class("modal-llm-chat-context-block")],
                      [
                        h.span([h.Class("llm-response-label")], ["System"]),
                        viewMarkdown(msg.content, { onCopyCode }, h),
                      ],
                    ),
                  ),
                  ...Array.map(autoUserMessages, (msg) =>
                    h.div(
                      [h.Class("modal-llm-chat-context-block")],
                      [
                        h.span([h.Class("llm-response-label")], ["Kontext (Auto-Nachricht)"]),
                        viewUserMarkdown(msg.content, { onCopyCode }, h),
                      ],
                    ),
                  ),
                ],
              ),
            ],
          ),
        ]
      : []

  const renderAnswerNode = (
    {
      content,
      reasoning,
      isError,
      isStreaming,
      assistantContent,
      toolDetails,
    }: {
      readonly content: string
      readonly reasoning: string
      readonly isError: boolean
      readonly isStreaming: boolean
      readonly assistantContent?: string
      readonly toolDetails?: ReadonlyArray<LlmChatToolDetail>
    },
    hBuilder: Html.HtmlBuilder<Message>,
  ): Html.Html =>
    hBuilder.div(
      [
        hBuilder.Class(
          isError
            ? "modal-llm-chat-msg is-assistant is-error"
            : isStreaming
              ? "modal-llm-chat-msg is-assistant is-streaming"
              : "modal-llm-chat-msg is-assistant",
        ),
      ],
      [
        hBuilder.span([hBuilder.Class("modal-llm-chat-role")], [isError ? "Fehler" : aiName]),
        LlmResponse.view(
          {
            content,
            reasoning,
            isStreaming,
            isThinkingMarkdown,
            isContentMarkdown,
            onToggleThinkingMarkdown: Message.ToggledLlmThinkingMarkdown(),
            onToggleContentMarkdown: Message.ToggledLlmContentMarkdown(),
            onCopyCode: (code) => Message.ClickedCopyLlmCode({ code }),
            ...(assistantContent !== undefined ? { assistantContent } : {}),
            ...(toolDetails !== undefined ? { toolDetails } : {}),
          },
          hBuilder,
        ),
      ],
    )

  const historyNodes = Array.map(llmChatDisplay, (entry) =>
    LlmChatDisplayEntry.match(entry, {
      Question: ({ content }) =>
        h.div(
          [h.Class("modal-llm-chat-msg is-user")],
          [
            h.div(
              [h.Class("llm-response-section-header modal-llm-chat-user-header")],
              [
                h.span([h.Class("modal-llm-chat-role")], [userName]),
                h.button(
                  [
                    h.Type("button"),
                    h.Class("llm-markdown-toggle-btn"),
                    h.AriaPressed(isUserMarkdown ? "true" : "false"),
                    h.AriaLabel("Nutzer-Markdown umschalten"),
                    h.OnClick(Message.ToggledLlmUserMarkdown()),
                  ],
                  [isUserMarkdown ? "md" : "txt"],
                ),
              ],
            ),
            h.div(
              [h.Class("modal-llm-chat-question")],
              [
                isUserMarkdown
                  ? viewUserMarkdown(content, { onCopyCode }, h)
                  : h.p([h.Class("llm-response-text")], [content]),
              ],
            ),
          ],
        ),
      Answer: ({ content, reasoning, isError, assistantContent, toolDetails }) =>
        renderAnswerNode(
          {
            content,
            reasoning,
            isError,
            isStreaming: false,
            ...(assistantContent !== undefined ? { assistantContent } : {}),
            ...(toolDetails !== undefined ? { toolDetails } : {}),
          },
          h,
        ),
    }),
  )

  const completedStreamNodes =
    llmChatState._tag === "Sending"
      ? Array.map(llmChatState.streamTurns, (turn) =>
          renderAnswerNode(
            {
              content: turn.content,
              reasoning: turn.reasoning,
              isError: turn.isError,
              isStreaming: false,
              ...(turn.assistantContent !== undefined
                ? { assistantContent: turn.assistantContent }
                : {}),
              ...(turn.toolDetails !== undefined ? { toolDetails: turn.toolDetails } : {}),
            },
            h,
          ),
        )
      : []

  const streamingNode =
    llmChatState._tag === "Sending"
      ? renderAnswerNode(
          {
            content: llmChatState.streamContent,
            reasoning: llmChatState.streamReasoning,
            isError: false,
            isStreaming: true,
          },
          h,
        )
      : h.empty

  return h.div(
    [h.Id("modal-llm-chat-history"), h.Class("modal-llm-chat-history")],
    [...systemNodes, ...historyNodes, ...completedStreamNodes, streamingNode],
  )
}

const renderModelOption = (
  item: ModelOption,
  llmSelectedModel: string,
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
  h.option([h.Value(item.value), h.Selected(llmSelectedModel === item.value)], [item.label])

const renderModelSelectChildren = (
  llmModelOptions: ReadonlyArray<ModelOption>,
  llmSelectedModel: string,
  h: Html.HtmlBuilder<Message>,
): ReadonlyArray<Html.Html> => {
  if (!Array.isReadonlyArrayNonEmpty(llmModelOptions)) {
    return [h.option([h.Value(""), h.Selected(true)], ["Noch keine Modelle"])]
  }
  const children: globalThis.Array<Html.Html> = []
  let currentGroupName: string | undefined = undefined
  let currentGroupItems: globalThis.Array<ModelOption> = []

  const flushGroup = () => {
    if (currentGroupName !== undefined && currentGroupItems.length > 0) {
      children.push(
        h.optgroup(
          [h.Attribute("label", currentGroupName)],
          currentGroupItems.map((item) => renderModelOption(item, llmSelectedModel, h)),
        ),
      )
    }
    currentGroupName = undefined
    currentGroupItems = []
  }

  for (const item of llmModelOptions) {
    if (item.providerName !== undefined) {
      if (currentGroupName === item.providerName) {
        currentGroupItems.push(item)
      } else {
        flushGroup()
        currentGroupName = item.providerName
        currentGroupItems = [item]
      }
    } else {
      flushGroup()
      children.push(renderModelOption(item, llmSelectedModel, h))
    }
  }
  flushGroup()
  return children
}

const viewLlmChatModelControls = (
  llmChatState: LlmChatState,
  viewInputs: ViewInputs,
  h: Html.HtmlBuilder<Message>,
): ReadonlyArray<Html.Html> => {
  const { llmModelOptions, llmSelectedModel, llmThinkingLevels, llmSelectedThinkingLevel } =
    viewInputs
  const hasMultipleThinkingLevels =
    Array.length(llmThinkingLevels) > 1 && !isLanguageModelSelection(llmSelectedModel)
  const isSending = llmChatState._tag === "Sending"

  return [
    h.select(
      [
        h.Id("modal-llm-model-select"),
        h.Class("form-input modal-llm-select"),
        h.AriaLabel("Modell"),
        h.Disabled(isSending || Array.isReadonlyArrayEmpty(llmModelOptions)),
        h.Value(llmSelectedModel),
        h.OnChange((value) => Message.SelectedLlmModel({ value })),
      ],
      renderModelSelectChildren(llmModelOptions, llmSelectedModel, h),
    ),
    hasMultipleThinkingLevels
      ? h.select(
          [
            h.Id("modal-llm-thinking-select"),
            h.Class("form-input modal-llm-select"),
            h.AriaLabel("Thinking-Level"),
            h.Disabled(isSending),
            h.Value(llmSelectedThinkingLevel),
            h.OnChange((value) => Message.SelectedLlmThinkingLevel({ value })),
          ],
          [
            h.option([h.Value(""), h.Selected(llmSelectedThinkingLevel === "")], ["Standard"]),
            ...Array.map(llmThinkingLevels, (item) =>
              h.option(
                [h.Value(item.value), h.Selected(llmSelectedThinkingLevel === item.value)],
                [item.label],
              ),
            ),
          ],
        )
      : h.empty,
  ]
}

const viewLlmChatBar = (
  llmChatInput: string,
  llmChatState: LlmChatState,
  llmChatMessages: ReadonlyArray<LlmChatMessage>,
  llmChatDisplay: ReadonlyArray<LlmChatDisplayEntry>,
  isThinkingMarkdown: boolean,
  isContentMarkdown: boolean,
  isUserMarkdown: boolean,
  aiName: string,
  userName: string,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const isSending = llmChatState._tag === "Sending"

  return h.div(
    [h.Id("modal-llm-chat-bar"), h.Class("modal-llm-chat-bar")],
    [
      viewLlmChatHistory(
        llmChatMessages,
        llmChatDisplay,
        llmChatState,
        isThinkingMarkdown,
        isContentMarkdown,
        isUserMarkdown,
        aiName,
        userName,
        h,
      ),
      h.div(
        [h.Class("modal-llm-chat-input-row")],
        [
          h.div(
            [h.Class("modal-llm-chat-input-wrap"), h.DataAttribute("value", llmChatInput)],
            [
              h.textarea([
                h.Id("modal-llm-chat-input"),
                h.Class("form-input modal-llm-chat-input"),
                h.Rows(1),
                h.Placeholder("Nachricht an die KI …"),
                h.AriaLabel("Nachricht an die KI"),
                h.Autocomplete("off"),
                h.Disabled(isSending),
                h.Value(llmChatInput),
                h.OnInput((value) => Message.UpdatedLlmChatInput({ value })),
                h.OnKeyDownPreventDefault((key, modifiers) =>
                  key === "Enter" && !modifiers.shiftKey
                    ? Option.some(Message.SubmittedLlmChat())
                    : Option.none(),
                ),
              ]),
            ],
          ),
          isSending
            ? h.button(
                [
                  h.Key("stop"),
                  h.Type("button"),
                  h.Id("modal-btn-send-llm"),
                  h.Class("btn btn-danger modal-llm-send-btn"),
                  h.AriaLabel("Stopp"),
                  h.Title("Stopp"),
                  h.Disabled(false),
                  h.OnClick(Message.ClickedStopLlmChat()),
                ],
                [viewIcon("stop", h)],
              )
            : h.button(
                [
                  h.Key("send"),
                  h.Type("button"),
                  h.Id("modal-btn-send-llm"),
                  h.Class("btn btn-primary modal-llm-send-btn"),
                  h.AriaLabel("Senden"),
                  h.Title("Senden"),
                  h.Disabled(llmChatInput.trim() === ""),
                  h.OnClick(Message.SubmittedLlmChat()),
                ],
                [viewIcon("ai", h)],
              ),
        ],
      ),
    ],
  )
}

const viewEditorSplitter = (isDragging: boolean, h: Html.HtmlBuilder<Message>): Html.Html =>
  h.div([
    h.Id("modal-editor-splitter"),
    h.Class(isDragging ? "modal-editor-splitter is-dragging" : "modal-editor-splitter"),
    h.Role("separator"),
    h.AriaOrientation("vertical"),
    h.AriaLabel("Editor-Größe anpassen"),
    h.OnPointerDown(
      (_pointerType, button, screenX, screenY, _timeStamp, _clientX, _clientY, pointerId) =>
        button === 0 || button === -1
          ? Option.some(
              Message.StartedResizeEditorSplit({
                startScreenX: screenX,
                startScreenY: screenY,
                pointerId,
              }),
            )
          : Option.none(),
    ),
    ...(isDragging
      ? [
          h.OnPointerMove((screenX, screenY) =>
            Option.some(Message.MovedResizeEditorSplit({ screenX, screenY })),
          ),
          h.OnPointerUp(() => Option.some(Message.EndedResizeEditorSplit())),
        ]
      : []),
  ])

const viewEditorModal = (
  {
    titleText,
    noun,
    isFolder,
    isTextFile,
    llmBarMode,
    isLlmModeMenuOpen: isLlmModeMenuOpenProp = false,
    llmChatInput,
    llmChatState,
    llmChatMessages,
    llmChatDisplay,
    isLlmThinkingMarkdown = true,
    isLlmContentMarkdown = true,
    isLlmUserMarkdown = true,
    llmViewInputs,
    isMaximized,
    isNameToggleable,
    isNameInputVisible,
    editorSplitPercent,
    isDraggingSplit,
    isEditingExisting,
    nameValue,
    maybeValidationError,
    maybePasteError,
    extraBodyNodes,
    historyControls,
  }: {
    readonly titleText: string
    readonly noun: "Datei" | "Ordner"
    readonly isFolder: boolean
    readonly isTextFile: boolean
    readonly llmBarMode: LlmBarMode
    readonly isLlmModeMenuOpen?: boolean
    readonly llmChatInput: string
    readonly llmChatState: LlmChatState
    readonly llmChatMessages: ReadonlyArray<LlmChatMessage>
    readonly llmChatDisplay: ReadonlyArray<LlmChatDisplayEntry>
    readonly isLlmThinkingMarkdown?: boolean
    readonly isLlmContentMarkdown?: boolean
    readonly isLlmUserMarkdown?: boolean
    readonly llmViewInputs: ViewInputs
    readonly isMaximized: boolean
    readonly isNameToggleable: boolean
    readonly isNameInputVisible: boolean
    readonly editorSplitPercent: number
    readonly isDraggingSplit: boolean
    readonly isEditingExisting: boolean
    readonly nameValue: string
    readonly maybeValidationError: Option.Option<string>
    readonly maybePasteError: Option.Option<string>
    readonly extraBodyNodes: ReadonlyArray<Html.Html>
    readonly historyControls?: {
      readonly canUndo: boolean
      readonly canRedo: boolean
      readonly showStepButtons: boolean
    }
  },
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const saveLabel = isEditingExisting ? "Speichern" : "Erstellen"
  const undoInTitlebar = llmViewInputs.monacoSettings.undoInTitlebar
  const showStepButtons = historyControls !== undefined && historyControls.showStepButtons
  const viewStepButton = (kind: "undo" | "redo", className: string, canStep: boolean): Html.Html =>
    h.button(
      [
        h.Type("button"),
        h.Id(kind === "undo" ? "modal-btn-undo" : "modal-btn-redo"),
        h.Class(className),
        h.AriaLabel(kind === "undo" ? "Rückgängig" : "Wiederholen"),
        h.Title(kind === "undo" ? "Rückgängig (Strg+Z)" : "Wiederholen (Strg+Y)"),
        h.Disabled(!canStep),
        h.OnClick(kind === "undo" ? Message.ClickedUndo() : Message.ClickedRedo()),
      ],
      [viewIcon(kind, h)],
    )
  const effectiveLlmBarMode: LlmBarMode =
    !isTextFile || (llmBarMode === "Chat" && !llmViewInputs.llmEnabled) ? "Closed" : llmBarMode
  const llmBarModeOptions: ReadonlyArray<{
    readonly value: LlmBarMode
    readonly label: string
    readonly icon: IconId
  }> = llmViewInputs.llmEnabled
    ? [
        { value: "Closed", label: "Bearbeiten", icon: "edit" },
        { value: "Chat", label: "Chat", icon: "ai" },
        { value: "Copy", label: "Kopieren", icon: "clipboard" },
      ]
    : [
        { value: "Closed", label: "Bearbeiten", icon: "edit" },
        { value: "Copy", label: "Kopieren", icon: "clipboard" },
      ]
  const activeLlmBarModeOption = Array.findFirst(
    llmBarModeOptions,
    (item) => item.value === effectiveLlmBarMode,
  ).pipe(Option.getOrElse(() => llmBarModeOptions[0]))

  return h.div(
    [
      h.Class(isMaximized ? "modal-overlay modal-overlay-maximized" : "modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy("modal-title"),
    ],
    [
      h.div(
        [h.Class(isMaximized ? "modal-content is-maximized" : "modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3(
                [h.Id("modal-title"), h.Class("modal-title")],
                isNameToggleable
                  ? [
                      h.span([h.Class("modal-title-prefix")], ["Datei bearbeiten: "]),
                      h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-edit-name"),
                          h.Class("modal-title-name-btn"),
                          h.AriaExpanded(isNameInputVisible || Option.isSome(maybeValidationError)),
                          h.OnClick(Message.ClickedToggleEditName()),
                        ],
                        [nameValue],
                      ),
                    ]
                  : [titleText],
              ),
              h.div(
                [h.Class("modal-header-actions")],
                [
                  ...(showStepButtons && undoInTitlebar && historyControls !== undefined
                    ? [
                        viewStepButton(
                          "undo",
                          "modal-close-btn modal-header-btn",
                          historyControls.canUndo,
                        ),
                        viewStepButton(
                          "redo",
                          "modal-close-btn modal-header-btn",
                          historyControls.canRedo,
                        ),
                      ]
                    : []),
                  !isFolder
                    ? h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-maximize"),
                          h.Class("modal-close-btn modal-header-btn"),
                          h.AriaLabel(isMaximized ? "Wiederherstellen" : "Maximieren"),
                          h.AriaPressed(isMaximized ? "true" : "false"),
                          h.Title(isMaximized ? "Wiederherstellen" : "Maximieren"),
                          h.OnClick(Message.ClickedToggleMaximize()),
                        ],
                        [viewIcon(isMaximized ? "restore" : "maximize", h)],
                      )
                    : h.empty,
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("modal-close-btn"),
                      h.AriaLabel("Schließen"),
                      h.OnClick(Message.ClickedClose()),
                    ],
                    [viewIcon("close", h)],
                  ),
                ],
              ),
            ],
          ),
          h.form(
            [
              h.Id("modal-form"),
              ...(effectiveLlmBarMode === "Chat"
                ? [
                    h.Class("has-llm-chat"),
                    h.Style({ "--editor-split-width": `${editorSplitPercent}%` }),
                  ]
                : []),
              h.OnSubmit(Message.ClickedSave()),
            ],
            [
              h.div(
                [h.Class("modal-body")],
                [
                  Option.match(maybeValidationError, {
                    onNone: () => h.empty,
                    onSome: (error) =>
                      h.div([h.Class("alert alert-danger mb-3"), h.Role("alert")], [error]),
                  }),
                  isNameInputVisible || Option.isSome(maybeValidationError)
                    ? h.div(
                        [h.Class("form-group")],
                        [
                          h.label([h.For("modal-file-name")], [`${noun}name:`]),
                          h.div(
                            [h.Class("modal-name-row")],
                            [
                              h.input([
                                h.Type("text"),
                                h.Id("modal-file-name"),
                                h.Class("form-input"),
                                h.Value(nameValue),
                                h.Required(true),
                                h.Placeholder(
                                  isFolder ? "z. B. projekte" : "z. B. index.html, daten.json",
                                ),
                                h.Autocomplete("off"),
                                h.OnInput((name) => Message.UpdatedName({ name })),
                              ]),
                              isEditingExisting
                                ? h.button(
                                    [
                                      h.Type("button"),
                                      h.Id("modal-btn-delete"),
                                      h.Class("btn btn-danger icon-label-btn"),
                                      h.AriaLabel("Löschen"),
                                      h.DataAttribute("tip", "Löschen"),
                                      h.OnClick(Message.ClickedDelete()),
                                    ],
                                    [
                                      h.span(
                                        [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                                        [viewIcon("trash", h)],
                                      ),
                                      h.span([h.Class("icon-label-btn-text")], ["Löschen"]),
                                    ],
                                  )
                                : h.empty,
                            ],
                          ),
                        ],
                      )
                    : h.empty,
                  ...extraBodyNodes,
                ],
              ),
              effectiveLlmBarMode === "Chat" ? viewEditorSplitter(isDraggingSplit, h) : h.empty,
              effectiveLlmBarMode === "Chat"
                ? viewLlmChatBar(
                    llmChatInput,
                    llmChatState,
                    llmChatMessages,
                    llmChatDisplay,
                    isLlmThinkingMarkdown,
                    isLlmContentMarkdown,
                    isLlmUserMarkdown,
                    llmViewInputs.llmChatAiName?.trim() || "KI",
                    llmViewInputs.llmChatUserName?.trim() || "Du",
                    h,
                  )
                : h.empty,
              h.footer(
                [h.Class("modal-footer")],
                [
                  ...(effectiveLlmBarMode === "Chat"
                    ? viewLlmChatModelControls(llmChatState, llmViewInputs, h)
                    : effectiveLlmBarMode === "Copy"
                      ? viewLlmButtons(maybePasteError, h)
                      : []),
                  isTextFile
                    ? h.div(
                        [
                          h.Id("modal-llm-mode-menu"),
                          h.Class("settings-menu modal-llm-mode-menu modal-footer-push-right"),
                        ],
                        [
                          h.button(
                            [
                              h.Type("button"),
                              h.Id("modal-llm-mode-select"),
                              h.Class("btn btn-secondary btn-icon modal-llm-mode-trigger"),
                              h.Title(`Modus: ${activeLlmBarModeOption.label}`),
                              h.AriaLabel(`Modus: ${activeLlmBarModeOption.label}`),
                              h.AriaHasPopup("true"),
                              h.AriaExpanded(isLlmModeMenuOpenProp),
                              h.Attribute("data-mode", effectiveLlmBarMode),
                              h.OnClick(Message.ClickedToggleLlmModeMenu(), {
                                propagation: "Stop",
                              }),
                            ],
                            [
                              viewIcon(activeLlmBarModeOption.icon, h),
                              h.span([h.Class("modal-llm-mode-caret"), h.AriaHidden(true)], ["▾"]),
                            ],
                          ),
                          h.div(
                            [
                              h.Id("modal-llm-mode-menu-list"),
                              h.Class("settings-menu-list modal-llm-mode-menu-list"),
                              h.Hidden(!isLlmModeMenuOpenProp),
                              h.Role("menu"),
                            ],
                            Array.map(llmBarModeOptions, (item) =>
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id(`modal-llm-mode-option-${item.value}`),
                                  h.Class(
                                    effectiveLlmBarMode === item.value
                                      ? "settings-menu-item is-active"
                                      : "settings-menu-item",
                                  ),
                                  h.Role("menuitem"),
                                  h.Attribute("data-mode", item.value),
                                  h.OnClick(Message.SelectedLlmBarMode({ value: item.value })),
                                ],
                                [viewIcon(item.icon, h), ` ${item.label}`],
                              ),
                            ),
                          ),
                        ],
                      )
                    : h.empty,
                  ...(historyControls !== undefined
                    ? [
                        h.div(
                          [h.Class("editor-history-nav"), h.Role("group"), h.AriaLabel("Verlauf")],
                          [
                            showStepButtons && !undoInTitlebar
                              ? viewStepButton(
                                  "undo",
                                  "btn btn-secondary btn-icon",
                                  historyControls.canUndo,
                                )
                              : h.empty,
                            h.button(
                              [
                                h.Type("button"),
                                h.Id("modal-btn-history"),
                                h.Class("btn btn-secondary btn-icon"),
                                h.AriaLabel("Versionsverlauf"),
                                h.Title("Versionsverlauf"),
                                h.OnClick(Message.ClickedOpenHistory()),
                              ],
                              [viewIcon("history", h)],
                            ),
                            showStepButtons && !undoInTitlebar
                              ? viewStepButton(
                                  "redo",
                                  "btn btn-secondary btn-icon",
                                  historyControls.canRedo,
                                )
                              : h.empty,
                          ],
                        ),
                      ]
                    : [
                        h.button(
                          [
                            h.Type("button"),
                            h.Id("modal-btn-cancel"),
                            h.Class(
                              isTextFile
                                ? "btn btn-secondary icon-label-btn"
                                : "btn btn-secondary icon-label-btn modal-footer-push-right",
                            ),
                            h.AriaLabel("Abbrechen"),
                            h.DataAttribute("tip", "Abbrechen"),
                            h.OnClick(Message.ClickedClose()),
                          ],
                          [
                            h.span(
                              [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                              [viewIcon("close", h)],
                            ),
                            h.span([h.Class("icon-label-btn-text")], ["Abbrechen"]),
                          ],
                        ),
                      ]),
                  h.button(
                    [
                      h.Type("submit"),
                      h.Id("modal-btn-save"),
                      h.Class("btn btn-primary icon-label-btn save-modal-btn"),
                      h.AriaLabel(saveLabel),
                      h.DataAttribute("tip", saveLabel),
                      h.OnClick(Message.ClickedSave(), { defaultAction: "Prevent" }),
                    ],
                    [
                      h.span(
                        [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                        [viewIcon("save", h)],
                      ),
                      h.span([h.Class("icon-label-btn-text")], [saveLabel]),
                    ],
                  ),
                  isTextFile
                    ? h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-preview"),
                          h.Class("btn btn-secondary icon-label-btn"),
                          h.AriaLabel("Im Vollfenster anzeigen"),
                          h.DataAttribute("tip", "Im Vollfenster anzeigen"),
                          h.OnClick(Message.ClickedOpenPreview()),
                        ],
                        [
                          h.span(
                            [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                            [viewIcon("desktop", h)],
                          ),
                          h.span([h.Class("icon-label-btn-text")], ["Vorschau"]),
                        ],
                      )
                    : h.empty,
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

export const viewConfirmDeleteDialog = <Msg>(
  {
    overlayId,
    titleId,
    title,
    prompt,
    cancelButtonId,
    onCancel,
    confirmButtonId,
    confirmLabel,
    onConfirm,
  }: {
    readonly overlayId?: string
    readonly titleId: string
    readonly title: string
    readonly prompt: string
    readonly cancelButtonId?: string
    readonly onCancel: Msg
    readonly confirmButtonId?: string
    readonly confirmLabel: string
    readonly onConfirm: Msg
  },
  h: Html.HtmlBuilder<Msg>,
): Html.Html =>
  h.div(
    [
      ...(overlayId ? [h.Id(overlayId)] : []),
      h.Class("modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy(titleId),
    ],
    [
      h.div(
        [h.Class("modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3([h.Id(titleId), h.Class("modal-title")], [title]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(onCancel),
                ],
                [viewIcon("close", h)],
              ),
            ],
          ),
          h.div([h.Class("modal-body")], [h.p([], [prompt])]),
          h.footer(
            [h.Class("modal-footer")],
            [
              h.div([h.Class("modal-footer-left")]),
              h.div(
                [h.Class("modal-footer-right")],
                [
                  h.button(
                    [
                      ...(cancelButtonId ? [h.Id(cancelButtonId)] : []),
                      h.Type("button"),
                      h.Class("btn btn-secondary"),
                      h.OnClick(onCancel),
                    ],
                    ["Abbrechen"],
                  ),
                  h.button(
                    [
                      ...(confirmButtonId ? [h.Id(confirmButtonId)] : []),
                      h.Type("button"),
                      h.Class("btn btn-danger"),
                      h.OnClick(onConfirm),
                    ],
                    [confirmLabel],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )

const viewConfirmDeleteModal = (
  entryName: string,
  entryKind: FileEntryKind,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const isFolder = entryKind === "directory"
  const noun = isFolder ? "den Ordner" : "die Datei"
  return viewConfirmDeleteDialog(
    {
      titleId: "modal-confirm-delete-title",
      title: "Eintrag löschen",
      prompt: isFolder
        ? `Möchten Sie ${noun} „${entryName}“ und dessen gesamten Inhalt wirklich unwiderruflich löschen?`
        : `Möchten Sie ${noun} „${entryName}“ wirklich unwiderruflich löschen?`,
      cancelButtonId: "modal-btn-cancel-delete",
      onCancel: Message.ClickedCancelDelete(),
      confirmLabel: "Löschen",
      onConfirm: Message.ClickedConfirmDelete(),
    },
    h,
  )
}

const viewConfirmOverwriteModal = (targetName: string, h: Html.HtmlBuilder<Message>): Html.Html =>
  h.div(
    [
      h.Class("modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy("modal-title"),
    ],
    [
      h.div(
        [h.Class("modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3([h.Id("modal-title"), h.Class("modal-title")], ["Datei überschreiben?"]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.ClickedCancelOverwrite()),
                ],
                [viewIcon("close", h)],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              h.p(
                [],
                [
                  `Ein Eintrag mit dem Namen „${targetName}“ existiert bereits. Möchten Sie ihn überschreiben?`,
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
                      h.Class("btn btn-secondary"),
                      h.OnClick(Message.ClickedCancelOverwrite()),
                    ],
                    ["Abbrechen"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Class("btn btn-danger"),
                      h.OnClick(Message.ClickedConfirmOverwrite()),
                    ],
                    ["Überschreiben"],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )

const PREVIEW_IFRAME_SANDBOX =
  "allow-scripts allow-forms allow-same-origin allow-modals allow-downloads"

const canPreviewHistoryEntry = (
  fileName: string,
  fileMode: EditorFileMode,
  isDeletedHistory: boolean | undefined,
): boolean =>
  fileMode._tag === "Text" || isDeletedHistory === true || Option.isSome(getPreviewType(fileName))

const viewHistoryPreviewOverlay = (
  preview: HistoryPreview,
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
  h.div(
    [h.Id("editor-preview-overlay"), h.Class("editor-preview-overlay")],
    [
      HistoryPreview.match(preview, {
        Text: ({ content }) =>
          h.iframe([
            h.Id("editor-preview-iframe"),
            h.Class("editor-preview-iframe"),
            h.Srcdoc(content),
            h.Sandbox(PREVIEW_IFRAME_SANDBOX),
            h.Title("Vorschau"),
          ]),
        Image: ({ objectUrl }) =>
          h.div(
            [h.Class("editor-preview-image-wrap")],
            [
              h.img([
                h.Id("editor-preview-image"),
                h.Class("editor-preview-image"),
                h.Src(objectUrl),
                h.Alt("Vorschau der Version"),
              ]),
            ],
          ),
        Pdf: ({ objectUrl }) =>
          h.iframe([
            h.Id("editor-preview-iframe"),
            h.Class("editor-preview-iframe"),
            h.Src(objectUrl),
            h.Title("Vorschau"),
          ]),
      }),
      h.button(
        [
          h.Type("button"),
          h.Id("editor-preview-close"),
          h.Class("editor-preview-close"),
          h.Title("Schließen (Esc)"),
          h.AriaLabel("Vorschau schließen"),
          h.OnClick(Message.ClickedClosePreview()),
        ],
        [viewIcon("close", h)],
      ),
    ],
  )

const viewPreviewOverlay = (content: string, h: Html.HtmlBuilder<Message>): Html.Html =>
  viewHistoryPreviewOverlay(HistoryPreview.Text({ content }), h)

const formatHistoryTimestamp = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleString("de-DE", {
    dateStyle: "medium",
    timeStyle: "medium",
  })

const formatHistorySize = (byteLength: number): string =>
  byteLength < 1024 ? `${byteLength} Bytes` : `${(byteLength / 1024).toFixed(1)} KB`

const formatHistoryHash = (contentHash: number): string =>
  (contentHash >>> 0).toString(16).padStart(8, "0")

const viewHistoryOverlay = (
  historyState: HistoryState,
  maybeCurrentVersion: Option.Option<{
    readonly contentHash: number
    readonly byteLength: number
  }>,
  isBinary: boolean,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  if (historyState._tag === "Closed") {
    return h.empty
  }

  return h.div(
    [
      h.Id("editor-history-overlay"),
      h.Class("modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabel("Versionsverlauf"),
    ],
    [
      h.div(
        [h.Class("modal-content editor-history-modal")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.div(
                [h.Class("editor-history-header-title")],
                [
                  h.h3([h.Class("modal-title")], ["Versionsverlauf"]),
                  historyState._tag === "Open"
                    ? h.label(
                        [h.Class("form-check editor-history-toggle")],
                        [
                          h.input([
                            h.Type("checkbox"),
                            h.Id("editor-history-enabled-checkbox"),
                            h.Checked(historyState.isHistoryEnabled),
                            h.OnChange(() =>
                              Message.ToggledHistoryEnabled({
                                isEnabled: !historyState.isHistoryEnabled,
                              }),
                            ),
                          ]),
                          h.span([], ["Speichern"]),
                        ],
                      )
                    : h.empty,
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("editor-history-close"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Verlauf schließen"),
                  h.OnClick(Message.ClickedCloseHistory()),
                ],
                [viewIcon("close", h)],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              HistoryState.match(historyState, {
                Closed: () => h.empty,
                Loading: () => h.p([h.Class("editor-history-empty")], ["Verlauf wird geladen..."]),
                Open: ({ entries, isConfirmingClear, isConfirmingDeleteLatest }) =>
                  Array.match(entries, {
                    onEmpty: () =>
                      h.p(
                        [h.Class("editor-history-empty")],
                        ["Noch keine gespeicherten Versionen vorhanden."],
                      ),
                    onNonEmpty: (nonEmptyEntries) =>
                      h.div(
                        [h.Class("editor-history-content")],
                        [
                          h.div(
                            [h.Class("editor-history-toolbar")],
                            [
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("editor-history-delete-latest-btn"),
                                  h.Class("btn btn-secondary icon-label-btn"),
                                  h.OnClick(Message.ClickedDeleteLatestHistoryEntry()),
                                ],
                                [
                                  h.span(
                                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                                    [viewIcon("trash", h)],
                                  ),
                                  h.span([h.Class("icon-label-btn-text")], ["Neueste löschen"]),
                                ],
                              ),
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("editor-history-clear-btn"),
                                  h.Class("btn btn-danger icon-label-btn"),
                                  h.OnClick(Message.ClickedRequestClearHistory()),
                                ],
                                [
                                  h.span(
                                    [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                                    [viewIcon("trash", h)],
                                  ),
                                  h.span([h.Class("icon-label-btn-text")], ["Verlauf löschen"]),
                                ],
                              ),
                            ],
                          ),
                          isConfirmingDeleteLatest === true
                            ? viewConfirmDeleteDialog(
                                {
                                  overlayId: "editor-history-delete-latest-confirm",
                                  titleId: "editor-history-delete-latest-title",
                                  title: "Neueste Version löschen",
                                  prompt:
                                    "Neueste gespeicherte Version wirklich unwiderruflich löschen?",
                                  cancelButtonId: "editor-history-delete-latest-cancel",
                                  onCancel: Message.ClickedCancelDeleteLatestHistoryEntry(),
                                  confirmButtonId: "editor-history-delete-latest-confirm-btn",
                                  confirmLabel: "Löschen",
                                  onConfirm: Message.ClickedConfirmDeleteLatestHistoryEntry(),
                                },
                                h,
                              )
                            : h.empty,
                          isConfirmingClear
                            ? viewConfirmDeleteDialog(
                                {
                                  overlayId: "editor-history-clear-confirm",
                                  titleId: "editor-history-clear-title",
                                  title: "Verlauf löschen",
                                  prompt: "Gesamten Verlauf wirklich löschen?",
                                  cancelButtonId: "editor-history-clear-cancel",
                                  onCancel: Message.ClickedCancelClearHistory(),
                                  confirmButtonId: "editor-history-clear-confirm-btn",
                                  confirmLabel: "Endgültig löschen",
                                  onConfirm: Message.ClickedConfirmClearHistory(),
                                },
                                h,
                              )
                            : h.empty,
                          h.ul(
                            [h.Class("editor-history-list")],
                            Array.map(nonEmptyEntries, (entry) => {
                              const isCurrentVersion = Option.exists(
                                maybeCurrentVersion,
                                (currentVersion) =>
                                  entry.contentHash === currentVersion.contentHash &&
                                  entry.byteLength === currentVersion.byteLength,
                              )
                              return h.keyed("li")(
                                String(entry.offset),
                                [
                                  h.Class(
                                    isCurrentVersion
                                      ? "editor-history-item is-current"
                                      : "editor-history-item",
                                  ),
                                ],
                                [
                                  h.div(
                                    [h.Class("editor-history-meta")],
                                    [
                                      h.span(
                                        [h.Class("editor-history-date")],
                                        [formatHistoryTimestamp(entry.timestampMs)],
                                      ),
                                      h.span(
                                        [h.Class("editor-history-lines")],
                                        [formatHistorySize(entry.byteLength)],
                                      ),
                                      h.code(
                                        [h.Class("editor-history-hash")],
                                        [formatHistoryHash(entry.contentHash)],
                                      ),
                                    ],
                                  ),
                                  h.div(
                                    [h.Class("editor-history-actions")],
                                    [
                                      !isBinary
                                        ? h.button(
                                            [
                                              h.Type("button"),
                                              h.Class(
                                                "btn btn-secondary editor-history-preview-btn",
                                              ),
                                              h.OnClick(
                                                Message.ClickedPreviewHistoryEntry({
                                                  endOffset: entry.endOffset,
                                                }),
                                              ),
                                            ],
                                            ["Vorschau"],
                                          )
                                        : h.empty,
                                      h.button(
                                        [
                                          h.Type("button"),
                                          h.Class("btn btn-secondary editor-history-restore-btn"),
                                          h.OnClick(
                                            Message.ClickedRestoreHistoryEntry({
                                              endOffset: entry.endOffset,
                                            }),
                                          ),
                                        ],
                                        ["Wiederherstellen"],
                                      ),
                                    ],
                                  ),
                                ],
                              )
                            }),
                          ),
                        ],
                      ),
                  }),
              }),
            ],
          ),
        ],
      ),
    ],
  )
}

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, context, h): Html.Html =>
    Model.match(model, {
      CreateFile: (state) =>
        h.div(
          [h.Class("editor-modal-host")],
          [
            viewEditorModal(
              {
                titleText: "Neue Datei erstellen",
                noun: "Datei",
                isFolder: false,
                isTextFile: true,
                llmBarMode: state.llmBarMode,
                isLlmModeMenuOpen: state.isLlmModeMenuOpen ?? false,
                llmChatInput: state.llmChatInput,
                llmChatState: state.llmChatState,
                llmChatMessages: state.llmChatMessages,
                llmChatDisplay: state.llmChatDisplay,
                isLlmThinkingMarkdown: state.isLlmThinkingMarkdown ?? true,
                isLlmContentMarkdown: state.isLlmContentMarkdown ?? true,
                isLlmUserMarkdown: state.isLlmUserMarkdown ?? true,
                llmViewInputs: context,
                isMaximized: state.isMaximized,
                isNameToggleable: false,
                isNameInputVisible: true,
                editorSplitPercent: state.editorSplitPercent,
                isDraggingSplit: Option.isSome(state.editorSplitDrag),
                isEditingExisting: false,
                nameValue: state.name,
                maybeValidationError: state.maybeValidationError,
                maybePasteError: state.maybePasteError,
                extraBodyNodes: [
                  viewTemplatePicker(state, h),
                  ...viewEditorFileBody(
                    EditorFileMode.Text({ content: state.content }),
                    state.name,
                    context.monacoSettings,
                    context.appTheme,
                    h,
                  ),
                ],
              },
              h,
            ),
            state.isPreviewOpen ? viewPreviewOverlay(state.content, h) : h.empty,
            state.isDeletingTemplate
              ? viewConfirmDeleteDialog(
                  {
                    overlayId: "modal-delete-template-box",
                    titleId: "modal-delete-template-title",
                    title: "Vorlage löschen",
                    prompt: `Vorlage „${pipe(
                      state.userTemplates,
                      Array.findFirst((t) => t.id === state.selectedTemplateId),
                      Option.match({
                        onNone: () => "",
                        onSome: (t) => t.label,
                      }),
                    )}“ wirklich löschen?`,
                    cancelButtonId: "modal-btn-cancel-delete-template",
                    onCancel: Message.ClickedCancelDeleteTemplate(),
                    confirmButtonId: "modal-btn-confirm-delete-template",
                    confirmLabel: "Löschen",
                    onConfirm: Message.ClickedConfirmDeleteTemplate(),
                  },
                  h,
                )
              : h.empty,
          ],
        ),

      CreateFolder: ({ name, maybeValidationError }) =>
        viewEditorModal(
          {
            titleText: "Neuen Ordner erstellen",
            noun: "Ordner",
            isFolder: true,
            isTextFile: false,
            llmBarMode: "Closed",
            llmChatInput: "",
            llmChatState: LlmChatState.Idle(),
            isLlmThinkingMarkdown: true,
            isLlmContentMarkdown: true,
            isLlmUserMarkdown: true,
            llmChatMessages: [],
            llmChatDisplay: [],
            llmViewInputs: context,
            isMaximized: false,
            isNameToggleable: false,
            isNameInputVisible: true,
            editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
            isDraggingSplit: false,
            isEditingExisting: false,
            nameValue: name,
            maybeValidationError,
            maybePasteError: Option.none(),
            extraBodyNodes: [],
          },
          h,
        ),

      EditFolder: ({ originalName, name, maybeValidationError, isConfirmingDelete }) =>
        h.div(
          [h.Class("editor-modal-host")],
          [
            viewEditorModal(
              {
                titleText: `Ordner bearbeiten: ${originalName}`,
                noun: "Ordner",
                isFolder: true,
                isTextFile: false,
                llmBarMode: "Closed",
                isLlmModeMenuOpen: false,
                llmChatInput: "",
                llmChatState: LlmChatState.Idle(),
                isLlmThinkingMarkdown: true,
                isLlmContentMarkdown: true,
                isLlmUserMarkdown: true,
                llmChatMessages: [],
                llmChatDisplay: [],
                llmViewInputs: context,
                isMaximized: false,
                isNameToggleable: false,
                isNameInputVisible: true,
                editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
                isDraggingSplit: false,
                isEditingExisting: true,
                nameValue: name,
                maybeValidationError,
                maybePasteError: Option.none(),
                extraBodyNodes: [],
              },
              h,
            ),
            isConfirmingDelete ? viewConfirmDeleteModal(originalName, "directory", h) : h.empty,
          ],
        ),

      EditFile: ({
        originalName,
        name,
        fileMode,
        maybeValidationError,
        maybePasteError,
        llmBarMode,
        isLlmModeMenuOpen: isLlmModeMenuOpenFlag,
        llmChatInput,
        llmChatState,
        llmChatMessages,
        llmChatDisplay,
        isLlmThinkingMarkdown,
        isLlmContentMarkdown,
        isLlmUserMarkdown,
        isMaximized,
        isEditingName,
        isPreviewOpen: previewOpen,
        editorSplitPercent,
        editorSplitDrag,
        canUndo,
        canRedo,
        historyState,
        isHistoryOnly,
        isDeletedHistory,
        isConfirmingDelete,
      }) => {
        const isBinaryHistory = !canPreviewHistoryEntry(originalName, fileMode, isDeletedHistory)
        if (isHistoryOnly) {
          return h.div(
            [h.Class("editor-modal-host")],
            [
              viewHistoryOverlay(
                historyState,
                fileMode._tag === "Text"
                  ? Option.some(hashAndMeasureHistoryContent(fileMode.content))
                  : Option.none(),
                isBinaryHistory,
                h,
              ),
              historyState._tag === "Open" && Option.isSome(historyState.maybePreviewContent)
                ? viewHistoryPreviewOverlay(historyState.maybePreviewContent.value, h)
                : h.empty,
            ],
          )
        }
        return h.div(
          [h.Class("editor-modal-host")],
          [
            viewEditorModal(
              {
                titleText: `Datei bearbeiten: ${originalName}`,
                noun: "Datei",
                isFolder: false,
                isTextFile: fileMode._tag === "Text",
                llmBarMode,
                isLlmModeMenuOpen: isLlmModeMenuOpenFlag ?? false,
                llmChatInput,
                llmChatState,
                llmChatMessages,
                llmChatDisplay,
                isLlmThinkingMarkdown: isLlmThinkingMarkdown ?? true,
                isLlmContentMarkdown: isLlmContentMarkdown ?? true,
                isLlmUserMarkdown: isLlmUserMarkdown ?? true,
                llmViewInputs: context,
                isMaximized,
                isNameToggleable: true,
                isNameInputVisible: isEditingName,
                editorSplitPercent,
                isDraggingSplit: Option.isSome(editorSplitDrag),
                isEditingExisting: true,
                nameValue: name,
                maybeValidationError,
                maybePasteError,
                extraBodyNodes: viewEditorFileBody(
                  fileMode,
                  name,
                  context.monacoSettings,
                  context.appTheme,
                  h,
                ),
                historyControls:
                  fileMode._tag === "Text"
                    ? {
                        canUndo,
                        canRedo,
                        showStepButtons: true,
                      }
                    : {
                        canUndo: false,
                        canRedo: false,
                        showStepButtons: false,
                      },
              },
              h,
            ),
            previewOpen && fileMode._tag === "Text"
              ? viewPreviewOverlay(fileMode.content, h)
              : h.empty,
            viewHistoryOverlay(
              historyState,
              fileMode._tag === "Text"
                ? Option.some(hashAndMeasureHistoryContent(fileMode.content))
                : Option.none(),
              isBinaryHistory,
              h,
            ),
            historyState._tag === "Open" && Option.isSome(historyState.maybePreviewContent)
              ? viewHistoryPreviewOverlay(historyState.maybePreviewContent.value, h)
              : h.empty,
            isConfirmingDelete ? viewConfirmDeleteModal(originalName, "file", h) : h.empty,
          ],
        )
      },

      ConfirmOverwrite: ({ targetName }) => viewConfirmOverwriteModal(targetName, h),
    }),
)
