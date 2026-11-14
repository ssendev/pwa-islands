import { describe, expect, it } from "vitest"
import { MONACO_EDITOR_TAG, languageFromFilename } from "./monaco-element"

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
})
