import { Option, Schema } from "effect"
import { CustomElement } from "foldkit"
import type * as Monaco from "monaco-editor"

export const MONACO_EDITOR_TAG = "monaco-editor"

export const monacoEditorElement = CustomElement.define({
  tag: MONACO_EDITOR_TAG,
  properties: {
    value: Schema.String,
    filename: Schema.String,
  },
  events: {
    "content-changed": Schema.Struct({ value: Schema.String }),
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

const getMonacoTheme = (isDark: boolean): string => (isDark ? "vs-dark" : "vs")

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
    private isApplyingExternalValue = false
    private isDisconnected = false
    private maybeEditor: Option.Option<Monaco.editor.IStandaloneCodeEditor> = Option.none()
    private maybeMonaco: Option.Option<typeof Monaco> = Option.none()
    private maybeContentDisposable: Option.Option<Monaco.IDisposable> = Option.none()
    private maybeContainer: Option.Option<HTMLDivElement> = Option.none()
    private maybeMediaQuery: Option.Option<MediaQueryList> = Option.none()
    private readonly handleThemeChange = (event: MediaQueryListEvent): void => {
      Option.match(this.maybeMonaco, {
        onNone: () => {},
        onSome: (monacoApi) => {
          monacoApi.editor.setTheme(getMonacoTheme(event.matches))
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
          }
        },
      })
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

      void this.mountEditor(container, mediaQuery?.matches ?? false)
    }

    disconnectedCallback(): void {
      this.isDisconnected = true
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

    private async mountEditor(container: HTMLDivElement, isDark: boolean): Promise<void> {
      const { monaco: monacoApi } = await import("./monaco-runtime")
      if (this.isDisconnected || !this.isConnected) {
        return
      }

      this.maybeMonaco = Option.some(monacoApi)
      const editor = monacoApi.editor.create(container, {
        value: this.currentValue,
        language: languageFromFilename(this.currentFilename),
        theme: getMonacoTheme(isDark),
        automaticLayout: true,
        minimap: { enabled: false },
        wordWrap: "on",
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: false,
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
      })
      this.maybeContentDisposable = Option.some(disposable)
    }
  }

  customElements.define(MONACO_EDITOR_TAG, MonacoEditorHost)
}
