import { describe, expect, it } from "vitest"
import {
  EditApplyResult,
  applyEditsForFormat,
  applySearchReplaceEdits,
  applyUnifiedDiffEdits,
  formatFencedFileForFormat,
  formatLlmContextForFormat,
  formatSystemPromptForFormat,
} from "./edit-format"

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
        message: "SEARCH-Block 1 ist mehrdeutig (2 Treffer) – bitte mehr Kontextzeilen angeben.",
      }),
    )
    expect(applySearchReplaceEdits(original, missing)).toEqual(
      EditApplyResult.Error({
        message: "SEARCH-Block 1 nicht gefunden (<p>Fehlt</p>).",
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
        message: "Diff-Hunk 1 ist mehrdeutig (2 Treffer) – bitte mehr Kontextzeilen angeben.",
      }),
    )
    expect(applyUnifiedDiffEdits(original, missing)).toEqual(
      EditApplyResult.Error({
        message: "Diff-Hunk 1 konnte nicht zugeordnet werden.",
      }),
    )
  })
})
