import { describe, expect, it } from "vitest"
import {
  EditApplyResult,
  EditorToolTextResult,
  EditorWriteToolResult,
  applyEditsForFormat,
  applySearchReplaceEdits,
  applyUnifiedDiffEdits,
  executeEditTool,
  executeReadTool,
  executeSearchTool,
  executeWriteTool,
  formatFencedFileForFormat,
  formatLlmContextForFormat,
  formatSystemPromptForFormat,
  getEditorToolsForFormat,
} from "./edit-format"
import { hashLine } from "./hashline"

describe("edit-format", () => {
  it("formats plain file and instructions for search-replace", () => {
    const prompt = formatLlmContextForFormat(
      "search-replace",
      "index.html",
      "<div>alt</div>",
      "declare const islands: unknown",
    )
    expect(prompt).toContain("Search & Replace")
    expect(prompt).toContain("<<<<<<< SEARCH")
    expect(prompt).toContain("<div>alt</div>")
    expect(prompt).not.toContain("1:")
    expect(formatFencedFileForFormat("search-replace", "index.html", "<div>alt</div>")).toBe(
      "```\n<div>alt</div>\n```\n\n",
    )
  })

  it("applies single and multiple search-replace blocks including fenced responses", () => {
    const original = "<div>\n  <h1>Alt</h1>\n  <p>Text</p>\n</div>"
    const response = [
      "```",
      "<<<<<<< SEARCH",
      "  <h1>Alt</h1>",
      "=======",
      "  <h1>Neu</h1>",
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      "  <p>Text</p>",
      "=======",
      "  <p>Aktualisiert</p>",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n")

    const result = applySearchReplaceEdits(original, response)
    expect(result).toEqual(
      EditApplyResult.Ok({
        content: "<div>\n  <h1>Neu</h1>\n  <p>Aktualisiert</p>\n</div>",
        appliedCount: 2,
        updatedSnippet: "",
      }),
    )
  })

  it("reports missing or ambiguous search-replace blocks", () => {
    const original = "<p>Doppelt</p>\n<p>Doppelt</p>"
    const ambiguous = "<<<<<<< SEARCH\n<p>Doppelt</p>\n=======\n<p>Neu</p>\n>>>>>>> REPLACE"
    const missing = "<<<<<<< SEARCH\n<p>Fehlt</p>\n=======\n<p>Neu</p>\n>>>>>>> REPLACE"

    expect(applySearchReplaceEdits(original, ambiguous)).toEqual(
      EditApplyResult.Error({
        message:
          "SEARCH-Block 1 ist mehrdeutig (2 Treffer in Zeilen 1, 2) – bitte mehr Kontextzeilen angeben, damit genau eine Stelle passt.",
      }),
    )
    expect(applySearchReplaceEdits(original, missing)).toEqual(
      EditApplyResult.Error({
        message: expect.stringContaining("SEARCH-Block 1 wurde in der Datei nicht gefunden."),
      }),
    )
  })

  it("formats simplified unified diff context and system prompt", () => {
    const prompt = formatLlmContextForFormat(
      "unified-diff",
      "index.html",
      "<div>alt</div>",
      "declare const islands: unknown",
    )
    expect(prompt).toContain("Vereinfachter Unified Diff")
    expect(prompt).toContain("```diff")
    expect(formatSystemPromptForFormat("unified-diff")).toContain("Vereinfachter Unified Diff")
  })

  it("applies simplified unified diff without line numbers and with multiple hunks", () => {
    const original = [
      "<main>",
      "  <h1>Alt</h1>",
      "  <p>Mitte</p>",
      "  <footer>Ende</footer>",
      "</main>",
    ].join("\n")
    const diff = [
      "```diff",
      "--- a/index.html",
      "+++ b/index.html",
      "@@",
      " <main>",
      "-  <h1>Alt</h1>",
      "+  <h1>Neu</h1>",
      "   <p>Mitte</p>",
      "@@",
      "   <p>Mitte</p>",
      "-  <footer>Ende</footer>",
      "+  <footer>Fertig</footer>",
      " </main>",
      "```",
    ].join("\n")

    const result = applyUnifiedDiffEdits(original, diff)
    expect(result).toEqual(
      EditApplyResult.Ok({
        content: [
          "<main>",
          "  <h1>Neu</h1>",
          "  <p>Mitte</p>",
          "  <footer>Fertig</footer>",
          "</main>",
        ].join("\n"),
        appliedCount: 2,
        updatedSnippet: "",
      }),
    )
  })

  it("uses optional line hint to disambiguate unified diff hunks", () => {
    const original = ["<ul>", "  <li>Item</li>", "</ul>", "<ul>", "  <li>Item</li>", "</ul>"].join(
      "\n",
    )
    const diff = [
      "@@ -4,3 +4,3 @@",
      " <ul>",
      "-  <li>Item</li>",
      "+  <li>Zweiter</li>",
      " </ul>",
    ].join("\n")

    const result = applyEditsForFormat("unified-diff", original, diff)
    expect(result).toEqual(
      EditApplyResult.Ok({
        content: ["<ul>", "  <li>Item</li>", "</ul>", "<ul>", "  <li>Zweiter</li>", "</ul>"].join(
          "\n",
        ),
        appliedCount: 1,
        updatedSnippet: "",
      }),
    )
  })

  it("reports unmatched or ambiguous unified diff hunks", () => {
    const original = "<p>A</p>\n<p>A</p>"
    const ambiguous = "@@\n-<p>A</p>\n+<p>B</p>"
    const missing = "@@\n-<p>X</p>\n+<p>Y</p>"

    expect(applyUnifiedDiffEdits(original, ambiguous)).toEqual(
      EditApplyResult.Error({
        message:
          "Diff-Hunk 1 ist mehrdeutig (2 Treffer in Zeilen 1, 2) – bitte mehr Kontextzeilen angeben, damit genau eine Stelle passt.",
      }),
    )
    expect(applyUnifiedDiffEdits(original, missing)).toEqual(
      EditApplyResult.Error({
        message: expect.stringContaining(
          "Diff-Hunk 1 konnte in der Datei nicht zugeordnet werden.",
        ),
      }),
    )
  })

  it("provides edit, read, search, and write tools", () => {
    const tools = getEditorToolsForFormat("hashline")
    expect(tools.map((t) => t.function.name)).toEqual(["edit", "read", "search", "write"])
    expect(formatSystemPromptForFormat("hashline", true)).toContain("`search`")
    expect(formatSystemPromptForFormat("hashline", true)).toContain("`read`")
    expect(formatSystemPromptForFormat("hashline", true)).toContain("`write`")
  })

  it("executes read tool with optional line range and format-specific prefixes", () => {
    const content = "<h1>Titel</h1>\n<p>Eins</p>\n<p>Zwei</p>"
    const hashlineRead = executeReadTool(
      "hashline",
      "index.html",
      content,
      JSON.stringify({ startLine: 2, endLine: 3 }),
    )
    expect(hashlineRead).toEqual(
      EditorToolTextResult.Ok({
        text: [
          "Datei `index.html` (Zeilen 2–3 von 3):",
          "",
          "```",
          `2:${hashLine("<p>Eins</p>")}|<p>Eins</p>`,
          `3:${hashLine("<p>Zwei</p>")}|<p>Zwei</p>`,
          "```",
        ].join("\n"),
      }),
    )

    const plainRead = executeReadTool("unified-diff", "index.html", content, "{}")
    expect(plainRead).toEqual(
      EditorToolTextResult.Ok({
        text: [
          "Datei `index.html` (Zeilen 1–3 von 3):",
          "",
          "```",
          "1: <h1>Titel</h1>",
          "2: <p>Eins</p>",
          "3: <p>Zwei</p>",
          "```",
        ].join("\n"),
      }),
    )

    expect(
      executeReadTool("hashline", "index.html", content, JSON.stringify({ startLine: 10 })),
    ).toEqual(
      EditorToolTextResult.Error({
        message: "Startzeile 10 liegt hinter dem Dateiende (3 Zeilen).",
      }),
    )
  })

  it("executes search tool for plain text and regex queries", () => {
    const content = "<h1>Titel</h1>\n<p>Hallo Welt</p>\n<p>hallo welt 2</p>"
    const plainSearch = executeSearchTool(
      "hashline",
      "index.html",
      content,
      JSON.stringify({ query: "hallo" }),
    )
    expect(plainSearch).toEqual(
      EditorToolTextResult.Ok({
        text: [
          "Treffer für „hallo“ in `index.html` (2):",
          "",
          "```",
          `2:${hashLine("<p>Hallo Welt</p>")}|<p>Hallo Welt</p>`,
          `3:${hashLine("<p>hallo welt 2</p>")}|<p>hallo welt 2</p>`,
          "```",
        ].join("\n"),
      }),
    )

    const regexSearch = executeSearchTool(
      "unified-diff",
      "index.html",
      content,
      JSON.stringify({ query: "welt\\s+\\d+", isRegex: true, caseSensitive: true }),
    )
    expect(regexSearch).toEqual(
      EditorToolTextResult.Ok({
        text: [
          "Treffer für „welt\\s+\\d+“ in `index.html` (1):",
          "",
          "```",
          "3: <p>hallo welt 2</p>",
          "```",
        ].join("\n"),
      }),
    )

    expect(
      executeSearchTool("hashline", "index.html", content, JSON.stringify({ query: "fehlt" })),
    ).toEqual(
      EditorToolTextResult.Ok({
        text: "Keine Treffer für „fehlt“ in `index.html` gefunden.",
      }),
    )

    expect(
      executeSearchTool(
        "hashline",
        "index.html",
        content,
        JSON.stringify({ query: "[", isRegex: true }),
      ),
    ).toEqual(
      EditorToolTextResult.Error({
        message: expect.stringContaining("Ungültiger regulärer Ausdruck:"),
      }),
    )
  })

  it("executes search tool with before and after context lines and merges overlapping blocks", () => {
    const content = [
      "1-oben",
      "2-treffer-a",
      "3-mitte",
      "4-treffer-b",
      "5-abstand",
      "6-abstand",
      "7-vor",
      "8-treffer-c",
      "9-unten",
    ].join("\n")

    const withContext = executeSearchTool(
      "unified-diff",
      "index.html",
      content,
      JSON.stringify({ query: "treffer-[a-c]", isRegex: true, before: 1, after: 1 }),
    )
    expect(withContext).toEqual(
      EditorToolTextResult.Ok({
        text: [
          "Treffer für „treffer-[a-c]“ in `index.html` (3):",
          "",
          "```",
          "1: 1-oben",
          "2: 2-treffer-a",
          "3: 3-mitte",
          "4: 4-treffer-b",
          "5: 5-abstand",
          "...",
          "7: 7-vor",
          "8: 8-treffer-c",
          "9: 9-unten",
          "```",
        ].join("\n"),
      }),
    )

    expect(
      executeSearchTool(
        "unified-diff",
        "index.html",
        content,
        JSON.stringify({ query: "treffer", before: -1 }),
      ),
    ).toEqual(
      EditorToolTextResult.Error({
        message: 'Parameter "before" muss eine nicht-negative Zahl sein.',
      }),
    )
  })

  it("executes write tool to replace entire file content", () => {
    expect(
      executeWriteTool("index.html", JSON.stringify({ content: "<p>Neu</p>\r\n<p>Zwei</p>" })),
    ).toEqual(
      EditorWriteToolResult.Ok({
        content: "<p>Neu</p>\n<p>Zwei</p>",
        message: "Datei `index.html` wurde neu geschrieben (2 Zeilen).",
      }),
    )

    expect(executeWriteTool("index.html", "{}")).toEqual(
      EditorWriteToolResult.Error({
        message: 'Parameter "content" fehlt oder ist kein Text.',
      }),
    )
  })

  it("handles lenient JSON, truncated arguments, and helpful errors in executeEditTool", () => {
    const original = "<div>\n  <p>Alt</p>\n</div>"

    // Repariert nachgestelltes Komma im JSON-Objekt
    expect(
      executeEditTool(
        "search-replace",
        original,
        '{"edits": "<<<<<<< SEARCH\\n  <p>Alt</p>\\n=======\\n  <p>Neu</p>\\n>>>>>>> REPLACE", }',
      ),
    ).toEqual(
      EditApplyResult.Ok({
        content: "<div>\n  <p>Neu</p>\n</div>",
        appliedCount: 1,
        updatedSnippet: "",
      }),
    )

    // Akzeptiert Array von Zeilen/Befehlen sowie Alias-Parameter
    expect(
      executeEditTool(
        "unified-diff",
        original,
        JSON.stringify({ patch: ["@@", " <div>", "-  <p>Alt</p>", "+  <p>Neu</p>", " </div>"] }),
      ),
    ).toEqual(
      EditApplyResult.Ok({
        content: "<div>\n  <p>Neu</p>\n</div>",
        appliedCount: 1,
        updatedSnippet: "",
      }),
    )

    // Meldet abgeschnittene Argumente verständlich
    expect(
      executeEditTool("search-replace", original, '{"edits": "<<<<<<< SEARCH\\n  <p>Alt'),
    ).toEqual(
      EditApplyResult.Error({
        message: expect.stringContaining("abgeschnitten (unvollständiges JSON)"),
      }),
    )

    // Meldet fehlenden edits-Parameter mit Hinweis auf vorhandene Keys
    expect(
      executeEditTool("unified-diff", original, JSON.stringify({ file: "index.html" })),
    ).toEqual(
      EditApplyResult.Error({
        message: expect.stringContaining("Vorhandene Parameter: file."),
      }),
    )
  })

  it("tolerates indentation differences and reports closest region hints", () => {
    const original = ["<section>", "    <h2>Titel</h2>", "    <p>Text</p>", "</section>"].join("\n")

    // Search/Replace mit 2 statt 4 Leerzeichen Einrückung
    const srIndented = [
      "<<<<<<< SEARCH",
      "  <h2>Titel</h2>",
      "  <p>Text</p>",
      "=======",
      "  <h2>Neu</h2>",
      "  <p>Text</p>",
      ">>>>>>> REPLACE",
    ].join("\n")
    expect(applySearchReplaceEdits(original, srIndented)).toEqual(
      EditApplyResult.Ok({
        content: ["<section>", "    <h2>Neu</h2>", "    <p>Text</p>", "</section>"].join("\n"),
        appliedCount: 1,
        updatedSnippet: "",
      }),
    )

    // Headerloser Unified Diff ohne @@
    const headerlessDiff = [" <section>", "-    <h2>Titel</h2>", "+    <h2>Neu</h2>"].join("\n")
    expect(applyUnifiedDiffEdits(original, headerlessDiff)).toEqual(
      EditApplyResult.Ok({
        content: ["<section>", "    <h2>Neu</h2>", "    <p>Text</p>", "</section>"].join("\n"),
        appliedCount: 1,
        updatedSnippet: "",
      }),
    )

    // Nicht gefundener Block nennt ähnlichste Stelle und erste Abweichung
    const nearMiss = [
      "@@",
      " <section>",
      "-    <h2>Falsch</h2>",
      "+    <h2>Neu</h2>",
      "     <p>Text</p>",
    ].join("\n")
    const nearMissResult = applyUnifiedDiffEdits(original, nearMiss)
    expect(nearMissResult._tag).toBe("Error")
    if (nearMissResult._tag === "Error") {
      expect(nearMissResult.message).toContain("Ähnlichste Stelle: Zeilen 1–3")
      expect(nearMissResult.message).toContain("erwartet: `    <h2>Falsch</h2>`")
      expect(nearMissResult.message).toContain("Datei:    `    <h2>Titel</h2>` (Zeile 2)")
    }
  })
})
