import { Option, Schema } from "effect"
import { CustomElement } from "foldkit"
import type * as Monaco from "monaco-editor"
import { getDocumentLanguage, t } from "./i18n"
import {
  type AppTheme,
  AppThemeSchema,
  defaultMonacoSettings,
  type MonacoTheme,
  MonacoThemeSchema,
} from "./storage"

export const MONACO_EDITOR_TAG = "monaco-editor"

export const monacoEditorElement = CustomElement.define({
  tag: MONACO_EDITOR_TAG,
  properties: {
    value: Schema.String,
    filename: Schema.String,
    lineNumbers: Schema.Boolean,
    folding: Schema.Boolean,
    wordWrap: Schema.Boolean,
    scrollBeyondLastLine: Schema.Boolean,
    theme: MonacoThemeSchema,
    appTheme: AppThemeSchema,
    lineDecorationsWidth: Schema.Number,
    lineNumbersMinChars: Schema.Number,
  },
  events: {
    "content-changed": Schema.Struct({ value: Schema.String }),
    "history-changed": Schema.Struct({ canUndo: Schema.Boolean, canRedo: Schema.Boolean }),
    "save-requested": Schema.Struct({}),
    "settings-requested": Schema.Struct({}),
  },
})

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  py: "python",
  rs: "rust",
}

export const languageFromFilename = (filename: string): string => {
  const trimmed = filename.trim().toLowerCase()
  const lastDot = trimmed.lastIndexOf(".")
  if (lastDot < 0 || lastDot === trimmed.length - 1) {
    return "plaintext"
  }
  const ext = trimmed.slice(lastDot + 1)
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext"
}

export const resolveMonacoTheme = (
  theme: MonacoTheme,
  appTheme: AppTheme,
  isSystemDark: boolean,
): string => {
  if (theme !== "system") {
    return theme
  }
  if (appTheme === "dark") {
    return "vs-dark"
  }
  if (appTheme === "light") {
    return "vs"
  }
  return isSystemDark ? "vs-dark" : "vs"
}

export const computeGutterOptions = (
  lineNumbers: boolean,
  folding: boolean,
  lineDecorationsWidth: number,
  lineNumbersMinChars: number,
): {
  readonly lineNumbers: "on" | "off"
  readonly folding: boolean
  readonly glyphMargin: false
  readonly lineDecorationsWidth: number
  readonly lineNumbersMinChars: number
} => ({
  lineNumbers: lineNumbers ? "on" : "off",
  folding,
  glyphMargin: false,
  lineDecorationsWidth,
  lineNumbersMinChars: lineNumbers ? lineNumbersMinChars : 0,
})

export const computeChangedSpan = (
  oldText: string,
  newText: string,
): { readonly startOffset: number; readonly endOffset: number; readonly text: string } => {
  const maxPrefix = Math.min(oldText.length, newText.length)
  let prefixLength = 0
  while (
    prefixLength < maxPrefix &&
    oldText.charCodeAt(prefixLength) === newText.charCodeAt(prefixLength)
  ) {
    prefixLength += 1
  }

  const maxSuffix = Math.min(oldText.length - prefixLength, newText.length - prefixLength)
  let suffixLength = 0
  while (
    suffixLength < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffixLength) ===
      newText.charCodeAt(newText.length - 1 - suffixLength)
  ) {
    suffixLength += 1
  }

  return {
    startOffset: prefixLength,
    endOffset: oldText.length - suffixLength,
    text: newText.slice(prefixLength, newText.length - suffixLength),
  }
}

export const applyExternalValueToEditor = (
  editor: Monaco.editor.IStandaloneCodeEditor,
  maybeMonaco: Option.Option<typeof Monaco>,
  currentEditorValue: string,
  nextValue: string,
): void => {
  const model = editor.getModel()
  if (model === null) {
    editor.setValue(nextValue)
    return
  }

  Option.match(maybeMonaco, {
    onNone: () => {
      editor.setValue(nextValue)
    },
    onSome: (monacoApi) => {
      const span = computeChangedSpan(currentEditorValue, nextValue)
      const startPos = model.getPositionAt(span.startOffset)
      const endPos = model.getPositionAt(span.endOffset)
      const range = new monacoApi.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column,
      )
      editor.pushUndoStop()
      const applied = editor.executeEdits("external-value", [
        {
          range,
          text: span.text,
          forceMoveMarkers: true,
        },
      ])
      editor.pushUndoStop()
      if (!applied) {
        editor.setValue(nextValue)
      }
    },
  })
}

export const triggerMonacoHistoryAction = (elementId: string, action: "undo" | "redo"): void => {
  if (typeof document === "undefined") {
    return
  }
  const element = document.getElementById(elementId)
  if (element === null) {
    return
  }
  const host = element as HTMLElement & { undo?: () => void; redo?: () => void }
  if (action === "undo" && typeof host.undo === "function") {
    host.undo()
  } else if (action === "redo" && typeof host.redo === "function") {
    host.redo()
  }
}

export const registerMonacoEditorElement = (): void => {
  if (
    typeof customElements === "undefined" ||
    customElements.get(MONACO_EDITOR_TAG) !== undefined
  ) {
    return
  }

  class MonacoEditorHost extends HTMLElement {
    private currentValue = ""
    private currentFilename = ""
    private currentLineNumbers = defaultMonacoSettings.lineNumbers
    private currentFolding = defaultMonacoSettings.folding
    private currentWordWrap = defaultMonacoSettings.wordWrap
    private currentScrollBeyondLastLine = defaultMonacoSettings.scrollBeyondLastLine
    private currentTheme: MonacoTheme = defaultMonacoSettings.theme
    private currentAppTheme: AppTheme = "system"
    private currentLineDecorationsWidth = defaultMonacoSettings.lineDecorationsWidth
    private currentLineNumbersMinChars = defaultMonacoSettings.lineNumbersMinChars
    private isApplyingExternalValue = false
    private isDisconnected = false
    private lastCanUndo = false
    private lastCanRedo = false
    private maybeEditor: Option.Option<Monaco.editor.IStandaloneCodeEditor> = Option.none()
    private maybeMonaco: Option.Option<typeof Monaco> = Option.none()
    private maybeContentDisposable: Option.Option<Monaco.IDisposable> = Option.none()
    private maybeContainer: Option.Option<HTMLDivElement> = Option.none()
    private maybeMediaQuery: Option.Option<MediaQueryList> = Option.none()
    private isSystemDark(): boolean {
      return Option.match(this.maybeMediaQuery, {
        onNone: () => false,
        onSome: (mediaQuery) => mediaQuery.matches,
      })
    }
    private readonly handleThemeChange = (event: MediaQueryListEvent): void => {
      if (this.currentTheme !== "system" || this.currentAppTheme !== "system") {
        return
      }
      Option.match(this.maybeMonaco, {
        onNone: () => {},
        onSome: (monacoApi) => {
          monacoApi.editor.setTheme(
            resolveMonacoTheme(this.currentTheme, this.currentAppTheme, event.matches),
          )
        },
      })
    }

    get value(): string {
      return this.currentValue
    }

    set value(nextValue: string) {
      this.currentValue = nextValue
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          const currentEditorValue = editor.getValue()
          if (currentEditorValue !== nextValue) {
            this.isApplyingExternalValue = true
            try {
              applyExternalValueToEditor(editor, this.maybeMonaco, currentEditorValue, nextValue)
            } finally {
              this.isApplyingExternalValue = false
            }
            this.syncHistoryState(editor)
          }
        },
      })
    }

    undo(): void {
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.trigger("toolbar", "undo", null)
          editor.focus()
        },
      })
    }

    redo(): void {
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.trigger("toolbar", "redo", null)
          editor.focus()
        },
      })
    }

    private syncHistoryState(editor: Monaco.editor.IStandaloneCodeEditor): void {
      const model = editor.getModel()
      if (model === null) {
        return
      }
      const canUndo = model.canUndo()
      const canRedo = model.canRedo()
      if (canUndo !== this.lastCanUndo || canRedo !== this.lastCanRedo) {
        this.lastCanUndo = canUndo
        this.lastCanRedo = canRedo
        this.dispatchEvent(
          new CustomEvent("history-changed", {
            detail: { canUndo, canRedo },
            bubbles: true,
          }),
        )
      }
    }

    get filename(): string {
      return this.currentFilename
    }

    set filename(nextFilename: string) {
      if (this.currentFilename === nextFilename) {
        return
      }
      this.currentFilename = nextFilename
      Option.match(this.maybeMonaco, {
        onNone: () => {},
        onSome: (monacoApi) => {
          Option.match(this.maybeEditor, {
            onNone: () => {},
            onSome: (editor) => {
              const model = editor.getModel()
              if (model !== null) {
                monacoApi.editor.setModelLanguage(model, languageFromFilename(nextFilename))
              }
            },
          })
        },
      })
    }

    get lineNumbers(): boolean {
      return this.currentLineNumbers
    }

    set lineNumbers(nextLineNumbers: boolean) {
      if (this.currentLineNumbers === nextLineNumbers) {
        return
      }
      this.currentLineNumbers = nextLineNumbers
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.updateOptions(
            computeGutterOptions(
              nextLineNumbers,
              this.currentFolding,
              this.currentLineDecorationsWidth,
              this.currentLineNumbersMinChars,
            ),
          )
        },
      })
    }

    get folding(): boolean {
      return this.currentFolding
    }

    set folding(nextFolding: boolean) {
      if (this.currentFolding === nextFolding) {
        return
      }
      this.currentFolding = nextFolding
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.updateOptions(
            computeGutterOptions(
              this.currentLineNumbers,
              nextFolding,
              this.currentLineDecorationsWidth,
              this.currentLineNumbersMinChars,
            ),
          )
        },
      })
    }

    get lineDecorationsWidth(): number {
      return this.currentLineDecorationsWidth
    }

    set lineDecorationsWidth(nextWidth: number) {
      if (this.currentLineDecorationsWidth === nextWidth) {
        return
      }
      this.currentLineDecorationsWidth = nextWidth
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.updateOptions(
            computeGutterOptions(
              this.currentLineNumbers,
              this.currentFolding,
              nextWidth,
              this.currentLineNumbersMinChars,
            ),
          )
        },
      })
    }

    get lineNumbersMinChars(): number {
      return this.currentLineNumbersMinChars
    }

    set lineNumbersMinChars(nextMinChars: number) {
      if (this.currentLineNumbersMinChars === nextMinChars) {
        return
      }
      this.currentLineNumbersMinChars = nextMinChars
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.updateOptions(
            computeGutterOptions(
              this.currentLineNumbers,
              this.currentFolding,
              this.currentLineDecorationsWidth,
              nextMinChars,
            ),
          )
        },
      })
    }

    get wordWrap(): boolean {
      return this.currentWordWrap
    }

    set wordWrap(nextWordWrap: boolean) {
      if (this.currentWordWrap === nextWordWrap) {
        return
      }
      this.currentWordWrap = nextWordWrap
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.updateOptions({ wordWrap: nextWordWrap ? "on" : "off" })
        },
      })
    }

    get scrollBeyondLastLine(): boolean {
      return this.currentScrollBeyondLastLine
    }

    set scrollBeyondLastLine(nextScrollBeyondLastLine: boolean) {
      if (this.currentScrollBeyondLastLine === nextScrollBeyondLastLine) {
        return
      }
      this.currentScrollBeyondLastLine = nextScrollBeyondLastLine
      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => {
          editor.updateOptions({ scrollBeyondLastLine: nextScrollBeyondLastLine })
        },
      })
    }

    get theme(): MonacoTheme {
      return this.currentTheme
    }

    set theme(nextTheme: MonacoTheme) {
      if (this.currentTheme === nextTheme) {
        return
      }
      this.currentTheme = nextTheme
      Option.match(this.maybeMonaco, {
        onNone: () => {},
        onSome: (monacoApi) => {
          monacoApi.editor.setTheme(
            resolveMonacoTheme(nextTheme, this.currentAppTheme, this.isSystemDark()),
          )
        },
      })
    }

    get appTheme(): AppTheme {
      return this.currentAppTheme
    }

    set appTheme(nextAppTheme: AppTheme) {
      if (this.currentAppTheme === nextAppTheme) {
        return
      }
      this.currentAppTheme = nextAppTheme
      Option.match(this.maybeMonaco, {
        onNone: () => {},
        onSome: (monacoApi) => {
          monacoApi.editor.setTheme(
            resolveMonacoTheme(this.currentTheme, nextAppTheme, this.isSystemDark()),
          )
        },
      })
    }

    connectedCallback(): void {
      this.isDisconnected = false
      const container = document.createElement("div")
      container.className = "monaco-editor-container"
      this.replaceChildren(container)
      this.maybeContainer = Option.some(container)

      const mediaQuery =
        typeof window !== "undefined" && typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-color-scheme: dark)")
          : undefined
      if (mediaQuery !== undefined) {
        this.maybeMediaQuery = Option.some(mediaQuery)
        mediaQuery.addEventListener("change", this.handleThemeChange)
      }

      void this.mountEditor(container)
    }

    disconnectedCallback(): void {
      this.isDisconnected = true
      this.lastCanUndo = false
      this.lastCanRedo = false
      Option.match(this.maybeMediaQuery, {
        onNone: () => {},
        onSome: (mediaQuery) => {
          mediaQuery.removeEventListener("change", this.handleThemeChange)
        },
      })
      this.maybeMediaQuery = Option.none()

      Option.match(this.maybeContentDisposable, {
        onNone: () => {},
        onSome: (disposable) => disposable.dispose(),
      })
      this.maybeContentDisposable = Option.none()

      Option.match(this.maybeEditor, {
        onNone: () => {},
        onSome: (editor) => editor.dispose(),
      })
      this.maybeEditor = Option.none()
      this.maybeMonaco = Option.none()

      Option.match(this.maybeContainer, {
        onNone: () => {},
        onSome: (container) => container.remove(),
      })
      this.maybeContainer = Option.none()
    }

    private async mountEditor(container: HTMLDivElement): Promise<void> {
      const { loadMonaco } = await import("./monaco-runtime")
      const monacoApi = await loadMonaco()
      if (this.isDisconnected || !this.isConnected) {
        return
      }

      this.maybeMonaco = Option.some(monacoApi)
      const editor = monacoApi.editor.create(container, {
        value: this.currentValue,
        language: languageFromFilename(this.currentFilename),
        theme: resolveMonacoTheme(this.currentTheme, this.currentAppTheme, this.isSystemDark()),
        automaticLayout: true,
        minimap: { enabled: false },
        ...computeGutterOptions(
          this.currentLineNumbers,
          this.currentFolding,
          this.currentLineDecorationsWidth,
          this.currentLineNumbersMinChars,
        ),
        wordWrap: this.currentWordWrap ? "on" : "off",
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: this.currentScrollBeyondLastLine,
        padding: { top: 8, bottom: 8 },
      })
      this.maybeEditor = Option.some(editor)

      const disposable = editor.onDidChangeModelContent(() => {
        if (this.isApplyingExternalValue) {
          return
        }
        const nextValue = editor.getValue()
        this.currentValue = nextValue
        this.dispatchEvent(
          new CustomEvent("content-changed", {
            detail: { value: nextValue },
            bubbles: true,
          }),
        )
        this.syncHistoryState(editor)
      })
      this.maybeContentDisposable = Option.some(disposable)

      editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
        this.dispatchEvent(
          new CustomEvent("save-requested", {
            detail: {},
            bubbles: true,
          }),
        )
      })

      editor.addAction({
        id: "pwa-islands-open-settings",
        label: t(getDocumentLanguage()).common.settings,
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.5,
        run: () => {
          this.dispatchEvent(
            new CustomEvent("settings-requested", {
              detail: {},
              bubbles: true,
            }),
          )
        },
      })
    }
  }

  customElements.define(MONACO_EDITOR_TAG, MonacoEditorHost)
}
