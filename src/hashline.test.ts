import { describe, expect, it } from "vitest"
import {
  HashlineApplyResult,
  applyHashlineEdits,
  formatHashlineFile,
  formatLlmContext,
  formatUpdatedHashlines,
  hashLine,
} from "./hashline"

describe("hashline", () => {
  it("formats lines with 1-based line numbers and 3-char hex hashes", () => {
    const formatted = formatHashlineFile("<h1>Hi</h1>\n<p>Welt</p>")
    const lines = formatted.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`1:${hashLine("<h1>Hi</h1>")}|<h1>Hi</h1>`)
    expect(lines[1]).toBe(`2:${hashLine("<p>Welt</p>")}|<p>Welt</p>`)
  })

  it("formats LLM context with instructions, /api.d.ts fence, and plain ``` hashline file fence", () => {
    const prompt = formatLlmContext("index.html", "<div>ok</div>", "declare const islands: unknown")
    expect(prompt).toContain("Hash-Anchored Line Edits")
    expect(prompt).toContain("```ts\ndeclare const islands: unknown\n```")
    expect(prompt).toContain(`\`\`\`\n1:${hashLine("<div>ok</div>")}|<div>ok</div>\n\`\`\``)
    expect(prompt.endsWith("```\n\n")).toBe(true)
  })

  it("formats updated hashlines without /api.d.ts or full instructions", () => {
    const updated = formatUpdatedHashlines("index.html", `1:${hashLine("<p>Neu</p>")}|<p>Neu</p>`)
    expect(updated).toContain("Geänderte Zeilen in `index.html`")
    expect(updated).toContain(`\`\`\`\n1:${hashLine("<p>Neu</p>")}|<p>Neu</p>\n\`\`\``)
    expect(updated.endsWith("```\n\n")).toBe(true)
    expect(updated).not.toContain("/api.d.ts")
  })

  it("applies REPLACE, INSERT_AFTER, INSERT_BEFORE, and DELETE in one response", () => {
    const original = [
      "<!doctype html>",
      "<html>",
      "<body>",
      "<p>Alt</p>",
      "</body>",
      "</html>",
    ].join("\n")
    const h1 = hashLine("<!doctype html>")
    const h3 = hashLine("<body>")
    const h4 = hashLine("<p>Alt</p>")
    const h5 = hashLine("</body>")

    const response = [
      "Hier sind die Änderungen:",
      "```hashline",
      `INSERT_BEFORE 1:${h1}`,
      "<!-- Kopf -->",
      "END",
      `INSERT_AFTER 3:${h3}`,
      "  <h1>Titel</h1>",
      "END",
      `REPLACE 4:${h4}`,
      "  <p>Neu</p>",
      "END",
      `DELETE 5:${h5}`,
      "```",
    ].join("\n")

    const result = applyHashlineEdits(original, response)
    expect(result).toEqual(
      HashlineApplyResult.Ok({
        content: [
          "<!-- Kopf -->",
          "<!doctype html>",
          "<html>",
          "<body>",
          "  <h1>Titel</h1>",
          "  <p>Neu</p>",
          "</html>",
        ].join("\n"),
        appliedCount: 4,
        changedLines: [
          `1:${hashLine("<!-- Kopf -->")}|<!-- Kopf -->`,
          "...",
          `5:${hashLine("  <h1>Titel</h1>")}|  <h1>Titel</h1>`,
          "...",
          `6:${hashLine("  <p>Neu</p>")}|  <p>Neu</p>`,
          "...",
          "// ab Zeile 7 gelöscht",
        ].join("\n"),
      }),
    )
  })

  it("applies range REPLACE and range DELETE without markdown fence", () => {
    const original = ["a", "b", "c", "d", "e"].join("\n")
    const response = [
      `REPLACE 1:${hashLine("a")}..2:${hashLine("b")}`,
      "x",
      "y",
      "z",
      "END",
      `DELETE 4:${hashLine("d")}..5:${hashLine("e")}`,
    ].join("\n")

    const result = applyHashlineEdits(original, response)
    expect(result).toEqual(
      HashlineApplyResult.Ok({
        content: ["x", "y", "z", "c"].join("\n"),
        appliedCount: 2,
        changedLines: [
          `1:${hashLine("x")}|x`,
          `2:${hashLine("y")}|y`,
          `3:${hashLine("z")}|z`,
          "...",
          "// ab Zeile 5 gelöscht",
        ].join("\n"),
      }),
    )
  })

  it("reports hash mismatch errors", () => {
    const original = "line1\nline2"
    const response = `REPLACE 2:000\nupdated\nEND`
    const result = applyHashlineEdits(original, response)
    expect(result).toEqual(
      HashlineApplyResult.Error({
        message: `Zeile 2: Hash stimmt nicht überein (erwartet ${hashLine("line2")}, angegeben 000).`,
      }),
    )
  })

  it("reports overlapping edits", () => {
    const original = "a\nb\nc"
    const response = [
      `REPLACE 1:${hashLine("a")}..2:${hashLine("b")}`,
      "x",
      "END",
      `DELETE 2:${hashLine("b")}`,
    ].join("\n")

    const result = applyHashlineEdits(original, response)
    expect(result._tag).toBe("Error")
  })

  it("reports unclosed blocks and empty clipboard", () => {
    expect(applyHashlineEdits("a", "   ")).toEqual(
      HashlineApplyResult.Error({ message: "Die Zwischenablage ist leer." }),
    )
    expect(applyHashlineEdits("a", `REPLACE 1:${hashLine("a")}\nb`)).toEqual(
      HashlineApplyResult.Error({
        message: "Unvollständiger REPLACE-Block: fehlendes END.",
      }),
    )
  })
})
