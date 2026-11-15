import { Option } from "effect"
import type * as Monaco from "monaco-editor"
import { describe, expect, it, vi } from "vitest"
import {
  MONACO_EDITOR_TAG,
  applyExternalValueToEditor,
  computeChangedSpan,
  languageFromFilename,
  resolveMonacoTheme,
} from "./monaco-element"

describe("monaco-element", () => {
  it("verwendet das erwartete Custom-Element-Tag", () => {
    expect(MONACO_EDITOR_TAG).toBe("monaco-editor")
  })

  it("ermittelt die Monaco-Sprache anhand der Dateiendung", () => {
    expect(languageFromFilename("index.html")).toBe("html")
    expect(languageFromFilename("STYLE.CSS")).toBe("css")
    expect(languageFromFilename("app.js")).toBe("javascript")
    expect(languageFromFilename("main.ts")).toBe("typescript")
    expect(languageFromFilename("daten.json")).toBe("json")
    expect(languageFromFilename("README.md")).toBe("markdown")
    expect(languageFromFilename("icon.svg")).toBe("xml")
    expect(languageFromFilename("notizen.txt")).toBe("plaintext")
    expect(languageFromFilename("ohne-endung")).toBe("plaintext")
  })

  it("berechnet den minimalen Änderungsbereich für externe Edits", () => {
    expect(computeChangedSpan("hallo welt!", "hallo monaco welt!")).toEqual({
      startOffset: 6,
      endOffset: 6,
      text: "monaco ",
    })
    expect(computeChangedSpan("zeile 1\nzeile 2\nzeile 3", "zeile 1\nzeile X\nzeile 3")).toEqual({
      startOffset: 14,
      endOffset: 15,
      text: "X",
    })
    expect(computeChangedSpan("abc", "")).toEqual({
      startOffset: 0,
      endOffset: 3,
      text: "",
    })
    expect(computeChangedSpan("aaa", "aaaaa")).toEqual({
      startOffset: 3,
      endOffset: 3,
      text: "aa",
    })
  })

  it("wendet externe Edits über pushUndoStop und executeEdits statt setValue an", () => {
    const calls: Array<string> = []
    const setValue = vi.fn(() => {
      calls.push("setValue")
    })
    const pushUndoStop = vi.fn(() => {
      calls.push("pushUndoStop")
      return true
    })
    const executeEdits = vi.fn(() => {
      calls.push("executeEdits")
      return true
    })
    const fakeModel = {
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    }
    const fakeEditor = {
      getModel: () => fakeModel,
      pushUndoStop,
      executeEdits,
      setValue,
    } as unknown as Monaco.editor.IStandaloneCodeEditor
    class FakeRange {
      readonly startLineNumber: number
      readonly startColumn: number
      readonly endLineNumber: number
      readonly endColumn: number
      constructor(
        startLineNumber: number,
        startColumn: number,
        endLineNumber: number,
        endColumn: number,
      ) {
        this.startLineNumber = startLineNumber
        this.startColumn = startColumn
        this.endLineNumber = endLineNumber
        this.endColumn = endColumn
      }
    }
    const fakeMonaco = { Range: FakeRange } as unknown as typeof Monaco

    applyExternalValueToEditor(fakeEditor, Option.some(fakeMonaco), "hallo welt", "hallo test welt")

    expect(calls).toEqual(["pushUndoStop", "executeEdits", "pushUndoStop"])
    expect(setValue).not.toHaveBeenCalled()
    expect(executeEdits).toHaveBeenCalledWith("external-value", [
      {
        range: new FakeRange(1, 7, 1, 7),
        text: "test ",
        forceMoveMarkers: true,
      },
    ])
  })

  it("fällt auf setValue zurück, wenn kein Modell vorhanden ist", () => {
    const setValue = vi.fn()
    const fakeEditor = {
      getModel: () => null,
      setValue,
    } as unknown as Monaco.editor.IStandaloneCodeEditor

    applyExternalValueToEditor(fakeEditor, Option.none(), "alt", "neu")

    expect(setValue).toHaveBeenCalledWith("neu")
  })

  it("löst das Monaco-Theme anhand von Einstellung und Systemmodus auf", () => {
    expect(resolveMonacoTheme("system", false)).toBe("vs")
    expect(resolveMonacoTheme("system", true)).toBe("vs-dark")
    expect(resolveMonacoTheme("vs", true)).toBe("vs")
    expect(resolveMonacoTheme("vs-dark", false)).toBe("vs-dark")
    expect(resolveMonacoTheme("hc-black", false)).toBe("hc-black")
    expect(resolveMonacoTheme("hc-light", true)).toBe("hc-light")
  })
})
