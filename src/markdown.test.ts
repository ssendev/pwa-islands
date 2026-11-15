import type { HtmlBuilder } from "foldkit/html"
import { click, expect as sceneExpect, given, scene, selector } from "foldkit/scene"
import { beforeAll, describe, expect, it } from "vitest"
import * as LlmResponse from "./llm-response"
import { formatUserMessageMarkdown, initMarkdown, viewUserMarkdown } from "./markdown"

type TestMessage =
  | { readonly _tag: "ToggleThinking" }
  | { readonly _tag: "ToggleContent" }
  | { readonly _tag: "CopyCode"; readonly code: string }

type TestModel = {
  readonly content: string
  readonly reasoning: string
  readonly isStreaming: boolean
  readonly isThinkingMarkdown?: boolean
  readonly isContentMarkdown?: boolean
  readonly copiedCode?: string
  readonly assistantContent?: string
  readonly toolDetails?: ReadonlyArray<LlmResponse.LlmToolDetail>
}

const testUpdate = (model: TestModel, message: TestMessage) => {
  if (message._tag === "ToggleThinking") {
    return { model: { ...model, isThinkingMarkdown: !(model.isThinkingMarkdown ?? true) } }
  }
  if (message._tag === "ToggleContent") {
    return { model: { ...model, isContentMarkdown: !(model.isContentMarkdown ?? true) } }
  }
  return { model: { ...model, copiedCode: message.code } }
}

const testView = (model: TestModel, h: HtmlBuilder<TestMessage>) =>
  h.div(
    [],
    [
      LlmResponse.view(
        {
          ...model,
          onToggleThinkingMarkdown: { _tag: "ToggleThinking" },
          onToggleContentMarkdown: { _tag: "ToggleContent" },
          onCopyCode: (code): TestMessage => ({ _tag: "CopyCode", code }),
        },
        h,
      ),
      h.div([h.Class("user-msg-preview")], [viewUserMarkdown(model.content, {}, h)]),
    ],
  )

describe("llm-response markdown", () => {
  beforeAll(async () => {
    await initMarkdown()
  })

  it("rendert Überschriften, Formatierungen, Listen und Codeblöcke als HTML", () => {
    scene(
      { update: testUpdate, view: testView },
      given({
        content: [
          "# Überschrift",
          "",
          "Ein **fetter** und *kursiver* Text mit `inline-code`.",
          "",
          "- Punkt A",
          "- [x] Erledigt",
          "",
          "```ts",
          "const x = 42",
          "```",
        ].join("\n"),
        reasoning: "",
        isStreaming: false,
      }),
      sceneExpect(selector(".llm-markdown h1")).toContainText("Überschrift"),
      sceneExpect(selector(".llm-markdown strong")).toContainText("fetter"),
      sceneExpect(selector(".llm-markdown em")).toContainText("kursiver"),
      sceneExpect(selector(".llm-markdown p code")).toContainText("inline-code"),
      sceneExpect(selector(".llm-markdown ul li")).toContainText("Punkt A"),
      sceneExpect(selector('.llm-markdown .llm-markdown-task input[type="checkbox"]')).toExist(),
      sceneExpect(selector(".llm-markdown pre code.language-ts")).toContainText("const x = 42"),
    )
  })

  it("rendert sichere Links mit target=_blank und blockiert unsichere javascript:-Links sowie rohes HTML", () => {
    scene(
      { update: testUpdate, view: testView },
      given({
        content: [
          "[Doku](https://example.com) und [XSS](javascript:alert(1))",
          "",
          "<script>alert(1)</script>",
        ].join("\n"),
        reasoning: "",
        isStreaming: false,
      }),
      sceneExpect(selector('.llm-markdown a[href="https://example.com"]')).toContainText("Doku"),
      sceneExpect(selector('.llm-markdown a[href="https://example.com"]')).toHaveAttr(
        "target",
        "_blank",
      ),
      sceneExpect(selector('.llm-markdown a[href^="javascript:"]')).toBeAbsent(),
      sceneExpect(selector(".llm-markdown script")).toBeAbsent(),
      sceneExpect(selector(".llm-markdown")).toContainText("XSS"),
      sceneExpect(selector(".llm-markdown")).toContainText("<script>alert(1)</script>"),
    )
  })

  it("heilt unvollständiges Markdown während des Streamings", () => {
    scene(
      { update: testUpdate, view: testView },
      given({
        content: "Hallo **Welt",
        reasoning: "",
        isStreaming: true,
      }),
      sceneExpect(selector(".llm-markdown strong")).toContainText("Welt"),
      sceneExpect(selector(".llm-response-streaming")).toContainText("Schreibt …"),
    )
  })

  it("rendert Thinking ebenfalls als Markdown und Tool-Aufrufe aufklappbar", () => {
    scene(
      { update: testUpdate, view: testView },
      given({
        content: 'Tool-Aufruf: search ("Titel")',
        reasoning: "Ich prüfe **zuerst** `<h1>`.",
        isStreaming: false,
        assistantContent: "",
        toolDetails: [
          {
            summary: 'Tool-Aufruf: search ("Titel")',
            name: "search",
            arguments: '{"query":"Titel"}',
            result: "1:ab|<h1>Titel</h1>",
          },
        ],
      }),
      sceneExpect(selector(".llm-response-thinking .llm-markdown strong")).toContainText("zuerst"),
      sceneExpect(selector(".llm-response-thinking .llm-markdown code")).toContainText("<h1>"),
      sceneExpect(selector(".llm-tool-details .llm-tool-summary")).toContainText(
        'Tool-Aufruf: search ("Titel")',
      ),
      sceneExpect(selector(".llm-tool-details")).toContainText('"query": "Titel"'),
      sceneExpect(selector(".llm-tool-details")).toContainText("1:ab|<h1>Titel</h1>"),
    )
  })

  it("erlaubt das Umschalten von Markdown/Rohtext bei Thinking und Antwort sowie das Kopieren von Codeblöcken", () => {
    scene(
      { update: testUpdate, view: testView },
      given({
        content: "Antwort **fett**\n\n```js\nconsole.log(1)\n```",
        reasoning: "Denke **klar**",
        isStreaming: false,
      }),
      sceneExpect(selector(".llm-response-thinking .llm-markdown strong")).toContainText("klar"),
      sceneExpect(selector(".llm-response-content .llm-response-label")).toContainText("Antwort"),
      sceneExpect(selector(".llm-response-content .llm-markdown strong")).toContainText("fett"),
      sceneExpect(selector(".llm-markdown-copy-btn")).toExist(),
      click(selector(".llm-markdown-copy-btn")),
      click(selector('.llm-response-thinking button[aria-label="Thinking-Markdown umschalten"]')),
      sceneExpect(selector(".llm-response-thinking .llm-response-text")).toContainText(
        "Denke **klar**",
      ),
      click(selector('.llm-response-content button[aria-label="Antwort-Markdown umschalten"]')),
      sceneExpect(selector(".llm-response-content .llm-response-text")).toContainText(
        "Antwort **fett**",
      ),
    )
  })

  it("erkennt Dateien in User-Nachrichten und umrahmt sie automatisch mit Code-Fences", () => {
    const htmlFile = "<!DOCTYPE html>\n<html>\n  <body>Hallo</body>\n</html>"
    expect(formatUserMessageMarkdown(htmlFile)).toBe(`\`\`\`html\n${htmlFile}\n\`\`\``)
    expect(formatUserMessageMarkdown("Bitte **fett**")).toBe("Bitte **fett**")
  })
})
