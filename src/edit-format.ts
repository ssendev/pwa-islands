import { Array, Match, Option, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { type LineEditBlock, applyLineEditBlocks, previewLine } from "./edit-match"
import {
  HashlineApplyResult,
  applyHashlineEdits,
  formatApiDtsMessage,
  formatFencedHashlineFile,
  formatHashedFileMessage,
  formatHashlineSystemPrompt,
  formatLlmContext as formatHashlineContext,
  formatUpdatedHashlines,
  hashLine,
} from "./hashline"
import { parseJsonObjectLenient } from "./tool-format"

export const EditFormat = Schema.Literals(["hashline", "search-replace", "unified-diff"])
export type EditFormat = typeof EditFormat.Type

export const DEFAULT_EDIT_FORMAT: EditFormat = "unified-diff"

export const parseEditFormat = (value: string): EditFormat =>
  Match.value(value).pipe(
    Match.when("hashline", () => "hashline" as const),
    Match.when("search-replace", () => "search-replace" as const),
    Match.when("unified-diff", () => "unified-diff" as const),
    Match.orElse(() => DEFAULT_EDIT_FORMAT),
  )

export const EDIT_FORMAT_OPTIONS: ReadonlyArray<{
  readonly value: EditFormat
  readonly label: string
}> = [
  { value: "hashline", label: "Hash-Anchored Edits" },
  { value: "search-replace", label: "Search & Replace" },
  { value: "unified-diff", label: "Vereinfachter Unified Diff" },
]

export const EditApplyResult = defineTaggedUnion({
  Ok: {
    content: Schema.String,
    appliedCount: Schema.Number,
    updatedSnippet: Schema.String,
  },
  Error: {
    message: Schema.String,
  },
})
export type EditApplyResult = typeof EditApplyResult.Type

const stripOuterMarkdownFence = (raw: string): string => {
  const lines = raw.replace(/\r\n/g, "\n").split("\n")
  const firstNonBlank = lines.findIndex((line) => line.trim() !== "")
  if (firstNonBlank === -1) {
    return ""
  }
  const lastNonBlank =
    lines.length - 1 - [...lines].reverse().findIndex((line) => line.trim() !== "")
  const trimmedLines = lines.slice(firstNonBlank, lastNonBlank + 1)
  if (
    trimmedLines.length >= 2 &&
    trimmedLines[0]?.trim().startsWith("```") &&
    trimmedLines[trimmedLines.length - 1]?.trim() === "```"
  ) {
    return trimmedLines.slice(1, -1).join("\n")
  }
  return trimmedLines.join("\n")
}

const formatPlainFencedFile = (content: string): string =>
  ["```", content.replace(/\r\n/g, "\n"), "```"].join("\n") + "\n\n"

export const formatFencedFileForFormat = (
  format: EditFormat,
  fileName: string,
  content: string,
): string =>
  Match.value(format).pipe(
    Match.when("hashline", () => formatFencedHashlineFile(fileName, content)),
    Match.when("search-replace", () => formatPlainFencedFile(content)),
    Match.when("unified-diff", () => formatPlainFencedFile(content)),
    Match.exhaustive,
  )

export const formatFileMessageForFormat = (
  format: EditFormat,
  fileName: string,
  content: string,
): string =>
  Match.value(format).pipe(
    Match.when("hashline", () => formatHashedFileMessage(fileName, content)),
    Match.when("search-replace", () =>
      [`## Datei: \`${fileName}\``, "", formatPlainFencedFile(content)].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [`## Datei: \`${fileName}\``, "", formatPlainFencedFile(content)].join("\n"),
    ),
    Match.exhaustive,
  )

const SEARCH_REPLACE_RULES = [
  "- Gib Änderungen als `SEARCH`/`REPLACE`-Blöcke an.",
  "- Der `SEARCH`-Teil muss exakt (inkl. Einrückung) in der Datei vorkommen und eindeutig sein.",
  "- Gib nur die geänderten Stellen aus, nicht die ganze Datei.",
]

const formatSearchReplaceInstructions = (fenceLang: string): ReadonlyArray<string> => [
  ...SEARCH_REPLACE_RULES,
  "",
  "Beispiel:",
  `\`\`\`${fenceLang}`,
  "<<<<<<< SEARCH",
  "  <p>Alter Text</p>",
  "=======",
  "  <p>Neuer Text</p>",
  ">>>>>>> REPLACE",
  "```",
]

const UNIFIED_DIFF_RULES = [
  "- Jeder Block beginnt mit `@@` (Zeilennummern sind optional).",
  "- Unveränderte Kontextzeilen beginnen mit einem Leerzeichen (` `).",
  "- Entfernte Zeilen beginnen mit `-`, hinzugefügte Zeilen mit `+`.",
  "- Gib nur die geänderten Stellen mit genug Kontextzeilen aus, nicht die ganze Datei.",
]

const formatUnifiedDiffInstructions = (fenceLang: string): ReadonlyArray<string> => [
  ...UNIFIED_DIFF_RULES,
  "",
  "Beispiel:",
  `\`\`\`${fenceLang}`,
  "@@",
  " <main>",
  "-  <p>Alter Text</p>",
  "+  <p>Neuer Text</p>",
  " </main>",
  "```",
]

const ADDITIONAL_TOOLS_INSTRUCTIONS = [
  "",
  "Weitere verfügbare Werkzeuge:",
  "- `search`: Durchsucht die aktuelle Datei nach Text oder regulären Ausdrücken (`query`, optional `isRegex`, `caseSensitive`, `before`, `after` für Kontextzeilen vor/nach Treffern).",
  "- `read`: Liest die aktuelle Datei oder einen Zeilenbereich (`startLine`, `endLine`).",
  "- `write`: Schreibt die gesamte aktuelle Datei komplett neu (`content`) – nur verwenden, wenn umfangreiche Änderungen nötig sind.",
]

const ADDITIONAL_TEXT_TOOLS_INSTRUCTIONS = [
  "",
  "Weitere verfügbare Werkzeuge (als Markdown-Codeblock):",
  "- `search`: Durchsucht die aktuelle Datei nach Text oder regulären Ausdrücken (`query`, optional `isRegex`, `caseSensitive`, `before`, `after`):",
  "```search",
  '{"query": "Suchbegriff"}',
  "```",
  "- `read`: Liest die aktuelle Datei oder einen Zeilenbereich (optional `startLine`, `endLine`):",
  "```read",
  '{"startLine": 1, "endLine": 100}',
  "```",
  "- `write`: Schreibt die gesamte aktuelle Datei komplett neu – nur verwenden, wenn umfangreiche Änderungen nötig sind:",
  "```write",
  "<vollständiger neuer Dateiinhalt>",
  "```",
]

export const formatSystemPromptForFormat = (format: EditFormat, useToolCalls = true): string => {
  const basePrompt = Match.value(format).pipe(
    Match.when("hashline", () => formatHashlineSystemPrompt(useToolCalls)),
    Match.when("search-replace", () =>
      [
        "## Anleitung für die Antwort (Search & Replace)",
        "",
        useToolCalls
          ? "Verwende für Änderungen an der Datei das Werkzeug `edit` mit `SEARCH`/`REPLACE`-Blöcken:"
          : "Verwende für Änderungen an der Datei einen Markdown-Codeblock (` ```edit `) mit folgenden `SEARCH`/`REPLACE`-Blöcken:",
        "",
        ...formatSearchReplaceInstructions(useToolCalls ? "" : "edit"),
      ].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [
        "## Anleitung für die Antwort (Vereinfachter Unified Diff)",
        "",
        useToolCalls
          ? "Verwende für Änderungen an der Datei das Werkzeug `edit` mit einem vereinfachten Unified Diff:"
          : "Verwende für Änderungen an der Datei einen Markdown-Codeblock (` ```edit `) im vereinfachten Unified-Diff-Format:",
        "",
        ...formatUnifiedDiffInstructions(useToolCalls ? "diff" : "edit"),
      ].join("\n"),
    ),
    Match.exhaustive,
  )
  return [
    basePrompt,
    ...(useToolCalls ? ADDITIONAL_TOOLS_INSTRUCTIONS : ADDITIONAL_TEXT_TOOLS_INSTRUCTIONS),
  ].join("\n")
}

export const formatLlmContextForFormat = (
  format: EditFormat,
  fileName: string,
  content: string,
  apiDts: string,
): string =>
  Match.value(format).pipe(
    Match.when("hashline", () => formatHashlineContext(fileName, content, apiDts)),
    Match.when("search-replace", () =>
      [
        "## Anleitung für die Antwort (Search & Replace)",
        "",
        "Antworte **nur** mit einem Markdown-Codeblock mit folgenden `SEARCH`/`REPLACE`-Blöcken:",
        "",
        ...formatSearchReplaceInstructions(""),
        "",
        formatApiDtsMessage(apiDts),
        "",
        formatFileMessageForFormat("search-replace", fileName, content),
      ].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [
        "## Anleitung für die Antwort (Vereinfachter Unified Diff)",
        "",
        "Antworte **nur** mit einem Markdown-Codeblock (` ```diff `) im vereinfachten Unified-Diff-Format:",
        "",
        ...formatUnifiedDiffInstructions("diff"),
        "",
        formatApiDtsMessage(apiDts),
        "",
        formatFileMessageForFormat("unified-diff", fileName, content),
      ].join("\n"),
    ),
    Match.exhaustive,
  )

export const getEditorEditToolForFormat = (format: EditFormat) => {
  const description = Match.value(format).pipe(
    Match.when(
      "hashline",
      () =>
        "Wendet Hash-Anchored Line Edits (REPLACE, INSERT_AFTER, INSERT_BEFORE, DELETE) auf die aktuell geöffnete Datei an.",
    ),
    Match.when(
      "search-replace",
      () =>
        "Wendet Search-&-Replace-Blöcke (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE) auf die aktuell geöffnete Datei an.",
    ),
    Match.when(
      "unified-diff",
      () =>
        "Wendet einen vereinfachten Unified Diff (@@, Kontext, -, +) auf die aktuell geöffnete Datei an.",
    ),
    Match.exhaustive,
  )

  const paramDescription = Match.value(format).pipe(
    Match.when("hashline", () => "Die Hashline-Bearbeitungsbefehle für die Datei."),
    Match.when("search-replace", () => "Die SEARCH/REPLACE-Blöcke für die Datei."),
    Match.when("unified-diff", () => "Der vereinfachte Unified Diff für die Datei."),
    Match.exhaustive,
  )

  return {
    type: "function",
    function: {
      name: "edit",
      description,
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "string",
            description: paramDescription,
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
  } as const
}

export const EDITOR_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description:
      "Liest den Inhalt der aktuell geöffneten Datei oder einen angegebenen Zeilenbereich.",
    parameters: {
      type: "object",
      properties: {
        startLine: {
          type: "integer",
          description: "Optionale 1-basierte Startzeile (Standard: 1).",
        },
        endLine: {
          type: "integer",
          description: "Optionale 1-basierte Endzeile (Standard: bis Dateiende).",
        },
      },
      additionalProperties: false,
    },
  },
} as const

export const EDITOR_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search",
    description:
      "Durchsucht die aktuell geöffnete Datei zeilenweise nach einem Suchbegriff oder regulären Ausdruck.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Der Suchbegriff oder reguläre Ausdruck.",
        },
        isRegex: {
          type: "boolean",
          description:
            "Wenn true, wird query als regulärer Ausdruck interpretiert (Standard: false).",
        },
        caseSensitive: {
          type: "boolean",
          description: "Wenn true, wird Groß-/Kleinschreibung beachtet (Standard: false).",
        },
        before: {
          type: "integer",
          description: "Optionale Anzahl an Kontextzeilen vor jedem Treffer (Standard: 0).",
        },
        after: {
          type: "integer",
          description: "Optionale Anzahl an Kontextzeilen nach jedem Treffer (Standard: 0).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
} as const

export const EDITOR_WRITE_TOOL = {
  type: "function",
  function: {
    name: "write",
    description:
      "Schreibt die aktuell geöffnete Datei komplett neu. Nur verwenden, wenn ein vollständiges Neuschreiben sinnvoller ist als gezielte Edits.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Der vollständige neue Inhalt der Datei.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
} as const

export const getEditorToolsForFormat = (format: EditFormat) =>
  [
    getEditorEditToolForFormat(format),
    EDITOR_READ_TOOL,
    EDITOR_SEARCH_TOOL,
    EDITOR_WRITE_TOOL,
  ] as const

export const EditorToolTextResult = defineTaggedUnion({
  Ok: {
    text: Schema.String,
  },
  Error: {
    message: Schema.String,
  },
})
export type EditorToolTextResult = typeof EditorToolTextResult.Type

export const EditorWriteToolResult = defineTaggedUnion({
  Ok: {
    content: Schema.String,
    message: Schema.String,
  },
  Error: {
    message: Schema.String,
  },
})
export type EditorWriteToolResult = typeof EditorWriteToolResult.Type

const MAX_READ_LINES = 400
const MAX_SEARCH_MATCHES = 50

const parseToolJsonObject = (rawArgs: string): Record<string, unknown> => {
  const trimmed = rawArgs.trim()
  if (trimmed === "") {
    return {}
  }
  const parsed = parseJsonObjectLenient(trimmed)
  if (parsed._tag === "Valid" || parsed._tag === "Repaired") {
    return parsed.record
  }
  if (parsed._tag === "Truncated") {
    throw new Error(
      "Die Werkzeug-Argumente wurden abgeschnitten (unvollständiges JSON) – bitte den Aufruf vollständig wiederholen oder in kleinere Schritte aufteilen.",
    )
  }
  if (parsed._tag === "NotAnObject") {
    throw new Error("Werkzeug-Argumente müssen ein JSON-Objekt sein.")
  }
  throw new Error(
    `Ungültiges JSON in den Werkzeug-Argumenten (${parsed.detail}). Erwartet wird ein gültiges JSON-Objekt.`,
  )
}

export type EditToolArgsResult =
  | { readonly _tag: "Ok"; readonly editsText: string }
  | { readonly _tag: "Error"; readonly message: string }

const EDIT_ARG_KEYS = ["edits", "patch", "diff", "text", "changes"] as const

const extractEditsFromRecord = (record: Record<string, unknown>): Option.Option<string> =>
  Array.findFirst(EDIT_ARG_KEYS, (key) => {
    const value = record[key]
    if (typeof value === "string") {
      return Option.some(value)
    }
    if (globalThis.Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return Option.some(value.join("\n"))
    }
    return Option.none()
  })

export const parseEditToolArguments = (rawArgs: string, depth = 0): EditToolArgsResult => {
  const trimmed = rawArgs.trim()
  if (trimmed === "") {
    return {
      _tag: "Error",
      message:
        'Argumente für `edit` sind leer. Erwartet wird ein JSON-Objekt wie `{"edits": "..."}`.',
    }
  }

  const parsed = parseJsonObjectLenient(trimmed)
  if (parsed._tag === "Valid" || parsed._tag === "Repaired") {
    return Option.match(extractEditsFromRecord(parsed.record), {
      onSome: (editsText) => ({ _tag: "Ok", editsText }),
      onNone: () => {
        const keys = Object.keys(parsed.record)
        const presentHint = keys.length > 0 ? ` Vorhandene Parameter: ${keys.join(", ")}.` : ""
        return {
          _tag: "Error",
          message: `Parameter "edits" fehlt oder ist kein Text.${presentHint} Erwartet wird \`{"edits": "..."}\`.`,
        }
      },
    })
  }

  if (parsed._tag === "Truncated") {
    return {
      _tag: "Error",
      message:
        "Die Argumente für `edit` wurden abgeschnitten (unvollständiges JSON) – bitte kürzere Blöcke senden oder mehrere kleinere `edit`-Aufrufe verwenden.",
    }
  }

  if (parsed._tag === "NotAnObject") {
    if (typeof parsed.value === "string") {
      const inner = parsed.value.trim()
      if (depth < 2 && (inner.startsWith("{") || inner.startsWith('"'))) {
        return parseEditToolArguments(parsed.value, depth + 1)
      }
      return { _tag: "Ok", editsText: parsed.value }
    }
    if (
      globalThis.Array.isArray(parsed.value) &&
      parsed.value.every((item) => typeof item === "string")
    ) {
      return { _tag: "Ok", editsText: parsed.value.join("\n") }
    }
    return {
      _tag: "Error",
      message: 'Werkzeug-Argumente für `edit` müssen ein JSON-Objekt wie `{"edits": "..."}` sein.',
    }
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { _tag: "Ok", editsText: rawArgs }
  }

  return {
    _tag: "Error",
    message: `Ungültiges JSON in den Argumenten für \`edit\` (${parsed.detail}). Erwartet wird \`{"edits": "..."}\`.`,
  }
}

export const executeEditTool = (
  format: EditFormat,
  originalContent: string,
  rawArgs: string,
): EditApplyResult => {
  const args = parseEditToolArguments(rawArgs)
  if (args._tag === "Error") {
    return EditApplyResult.Error({ message: args.message })
  }
  return applyEditsForFormat(format, originalContent, args.editsText)
}

const formatNumberedLine = (format: EditFormat, lineNumber: number, line: string): string =>
  format === "hashline" ? `${lineNumber}:${hashLine(line)}|${line}` : `${lineNumber}: ${line}`

export const executeReadTool = (
  format: EditFormat,
  fileName: string,
  content: string,
  rawArgs: string,
): EditorToolTextResult => {
  let args: Record<string, unknown>
  try {
    args = parseToolJsonObject(rawArgs)
  } catch (err) {
    return EditorToolTextResult.Error({
      message: err instanceof Error ? err.message : "Ungültige JSON-Argumente.",
    })
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const totalLines = lines.length

  const rawStart = args.startLine
  if (rawStart !== undefined && (typeof rawStart !== "number" || !Number.isFinite(rawStart))) {
    return EditorToolTextResult.Error({ message: 'Parameter "startLine" muss eine Zahl sein.' })
  }
  const rawEnd = args.endLine
  if (rawEnd !== undefined && (typeof rawEnd !== "number" || !Number.isFinite(rawEnd))) {
    return EditorToolTextResult.Error({ message: 'Parameter "endLine" muss eine Zahl sein.' })
  }

  const start = rawStart !== undefined ? Math.max(1, Math.floor(rawStart)) : 1
  if (start > totalLines) {
    return EditorToolTextResult.Error({
      message: `Startzeile ${start} liegt hinter dem Dateiende (${totalLines} Zeilen).`,
    })
  }

  const end =
    rawEnd !== undefined
      ? Math.min(totalLines, Math.floor(rawEnd))
      : Math.min(totalLines, start + MAX_READ_LINES - 1)
  if (end < start) {
    return EditorToolTextResult.Error({
      message: `Endzeile (${end}) darf nicht vor der Startzeile (${start}) liegen.`,
    })
  }

  const slice = lines.slice(start - 1, end)
  const formatted = Array.map(slice, (line, idx) =>
    formatNumberedLine(format, start + idx, line),
  ).join("\n")
  const continuationHint =
    rawEnd === undefined && end < totalLines
      ? `\n\n(Weitere Zeilen vorhanden – nutze \`read\` mit \`startLine: ${end + 1}\`.)`
      : ""

  return EditorToolTextResult.Ok({
    text:
      [
        `Datei \`${fileName}\` (Zeilen ${start}–${end} von ${totalLines}):`,
        "",
        "```",
        formatted,
        "```",
      ].join("\n") + continuationHint,
  })
}

export const executeSearchTool = (
  format: EditFormat,
  fileName: string,
  content: string,
  rawArgs: string,
): EditorToolTextResult => {
  let args: Record<string, unknown>
  try {
    args = parseToolJsonObject(rawArgs)
  } catch (err) {
    return EditorToolTextResult.Error({
      message: err instanceof Error ? err.message : "Ungültige JSON-Argumente.",
    })
  }

  const query = args.query
  if (typeof query !== "string" || query === "") {
    return EditorToolTextResult.Error({ message: 'Suchbegriff ("query") darf nicht leer sein.' })
  }
  const isRegex = args.isRegex === true
  const caseSensitive = args.caseSensitive === true
  const rawBefore = args.before
  if (
    rawBefore !== undefined &&
    (typeof rawBefore !== "number" || !Number.isFinite(rawBefore) || rawBefore < 0)
  ) {
    return EditorToolTextResult.Error({
      message: 'Parameter "before" muss eine nicht-negative Zahl sein.',
    })
  }
  const rawAfter = args.after
  if (
    rawAfter !== undefined &&
    (typeof rawAfter !== "number" || !Number.isFinite(rawAfter) || rawAfter < 0)
  ) {
    return EditorToolTextResult.Error({
      message: 'Parameter "after" muss eine nicht-negative Zahl sein.',
    })
  }
  const beforeCount = rawBefore !== undefined ? Math.floor(rawBefore) : 0
  const afterCount = rawAfter !== undefined ? Math.floor(rawAfter) : 0

  let matcher: (line: string) => boolean
  if (isRegex) {
    try {
      const regex = new RegExp(query, caseSensitive ? "" : "i")
      matcher = (line) => regex.test(line)
    } catch (err) {
      return EditorToolTextResult.Error({
        message: `Ungültiger regulärer Ausdruck: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else {
    const needle = caseSensitive ? query : query.toLowerCase()
    matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle)
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const matchIndices = lines.flatMap((line, idx) => (matcher(line) ? [idx] : []))

  if (Array.isReadonlyArrayEmpty(matchIndices)) {
    return EditorToolTextResult.Ok({
      text: `Keine Treffer für „${query}“ in \`${fileName}\` gefunden.`,
    })
  }

  const shownMatchIndices = matchIndices.slice(0, MAX_SEARCH_MATCHES)
  const hasContext = beforeCount > 0 || afterCount > 0
  const ranges = Array.reduce(
    shownMatchIndices,
    [] as ReadonlyArray<{ readonly start: number; readonly end: number }>,
    (acc, matchIdx) => {
      const start = Math.max(0, matchIdx - beforeCount)
      const end = Math.min(lines.length - 1, matchIdx + afterCount)
      const prev = acc[acc.length - 1]
      if (prev && start <= prev.end + 1) {
        return [...acc.slice(0, -1), { start: prev.start, end: Math.max(prev.end, end) }]
      }
      return [...acc, { start, end }]
    },
  )

  const shown = ranges
    .map((range) =>
      Array.makeBy(range.end - range.start + 1, (offset) => {
        const lineIdx = range.start + offset
        return formatNumberedLine(format, lineIdx + 1, lines[lineIdx] ?? "")
      }).join("\n"),
    )
    .join(hasContext ? "\n...\n" : "\n")

  const moreHint =
    matchIndices.length > MAX_SEARCH_MATCHES
      ? `\n\n(… und ${matchIndices.length - MAX_SEARCH_MATCHES} weitere Treffer.)`
      : ""

  return EditorToolTextResult.Ok({
    text:
      [
        `Treffer für „${query}“ in \`${fileName}\` (${matchIndices.length}):`,
        "",
        "```",
        shown,
        "```",
      ].join("\n") + moreHint,
  })
}

export const executeWriteTool = (fileName: string, rawArgs: string): EditorWriteToolResult => {
  let args: Record<string, unknown>
  try {
    args = parseToolJsonObject(rawArgs)
  } catch (err) {
    return EditorWriteToolResult.Error({
      message: err instanceof Error ? err.message : "Ungültige JSON-Argumente.",
    })
  }

  const newContent = args.content
  if (typeof newContent !== "string") {
    return EditorWriteToolResult.Error({
      message: 'Parameter "content" fehlt oder ist kein Text.',
    })
  }

  const normalized = newContent.replace(/\r\n/g, "\n")
  const lineCount = normalized.split("\n").length
  return EditorWriteToolResult.Ok({
    content: normalized,
    message: `Datei \`${fileName}\` wurde neu geschrieben (${lineCount} Zeilen).`,
  })
}

export interface ParsedTextToolCall {
  readonly id: string
  readonly name: "edit" | "read" | "search" | "write"
  readonly arguments: string
}

interface FencedCodeBlock {
  readonly lang: string
  readonly body: string
}

const OPENING_FENCE_PATTERN = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/

const parseFencedCodeBlocks = (text: string): ReadonlyArray<FencedCodeBlock> => {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const blocks: FencedCodeBlock[] = []
  let activeFence:
    | {
        readonly char: string
        readonly len: number
        readonly lang: string
        readonly lines: string[]
      }
    | undefined

  for (const line of lines) {
    if (!activeFence) {
      const openMatch = OPENING_FENCE_PATTERN.exec(line)
      if (openMatch && openMatch[1]) {
        activeFence = {
          char: openMatch[1][0] ?? "`",
          len: openMatch[1].length,
          lang: (openMatch[2] ?? "").trim().toLowerCase(),
          lines: [],
        }
      }
      continue
    }

    const trimmed = line.trim()
    const isClosing =
      trimmed.length >= activeFence.len && [...trimmed].every((ch) => ch === activeFence?.char)
    if (isClosing) {
      blocks.push({ lang: activeFence.lang, body: activeFence.lines.join("\n") })
      activeFence = undefined
    } else {
      activeFence.lines.push(line)
    }
  }

  return blocks
}

const normalizeReadTextArgs = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed === "") {
    return "{}"
  }
  if (trimmed.startsWith("{")) {
    return trimmed
  }
  const rangeMatch = /^(\d+)\s*[-–:]\s*(\d+)$/.exec(trimmed)
  if (rangeMatch) {
    return JSON.stringify({
      startLine: Number(rangeMatch[1]),
      endLine: Number(rangeMatch[2]),
    })
  }
  return trimmed
}

const normalizeSearchTextArgs = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) {
    return trimmed
  }
  return JSON.stringify({ query: trimmed })
}

const normalizeEditTextArgs = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) {
    return trimmed
  }
  return JSON.stringify({ edits: body })
}

export const extractTextToolCalls = (text: string): ReadonlyArray<ParsedTextToolCall> =>
  parseFencedCodeBlocks(text).flatMap<ParsedTextToolCall>((block, index) => {
    const id = `text_call_${index}`
    if (block.lang === "write") {
      return [{ id, name: "write" as const, arguments: JSON.stringify({ content: block.body }) }]
    }
    if (block.lang === "read") {
      return [{ id, name: "read" as const, arguments: normalizeReadTextArgs(block.body) }]
    }
    if (block.lang === "search") {
      return [{ id, name: "search" as const, arguments: normalizeSearchTextArgs(block.body) }]
    }
    if (block.lang === "edit") {
      return [{ id, name: "edit" as const, arguments: normalizeEditTextArgs(block.body) }]
    }
    return []
  })

export const formatToolResultForFormat = (
  format: EditFormat,
  fileName: string,
  updatedSnippet: string,
): string =>
  Match.value(format).pipe(
    Match.when("hashline", () => formatUpdatedHashlines(fileName, updatedSnippet)),
    Match.when("search-replace", () => `Änderungen in \`${fileName}\` angewendet.`),
    Match.when("unified-diff", () => `Änderungen in \`${fileName}\` angewendet.`),
    Match.exhaustive,
  )

// SEARCH & REPLACE

interface SearchReplaceBlock {
  readonly searchLines: ReadonlyArray<string>
  readonly replaceLines: ReadonlyArray<string>
}

const SEARCH_START_PATTERN = /^(?:<{3,}|<{2,}>{2,}|>{3,})\s*SEARCH\b/i
const SEPARATOR_PATTERN = /^={3,}\s*$/
const REPLACE_END_PATTERN = /^(?:>{3,}|<{2,}>{2,}|<{3,})\s*REPLACE\b/i

type SearchReplaceParseState =
  | {
      readonly _tag: "Outside"
      readonly blocks: ReadonlyArray<SearchReplaceBlock>
      readonly maybeError: Option.Option<string>
    }
  | {
      readonly _tag: "InSearch"
      readonly startLine: number
      readonly blocks: ReadonlyArray<SearchReplaceBlock>
      readonly searchLines: ReadonlyArray<string>
      readonly maybeError: Option.Option<string>
    }
  | {
      readonly _tag: "InReplace"
      readonly startLine: number
      readonly blocks: ReadonlyArray<SearchReplaceBlock>
      readonly searchLines: ReadonlyArray<string>
      readonly replaceLines: ReadonlyArray<string>
      readonly maybeError: Option.Option<string>
    }

const parseSearchReplaceBlocks = (
  raw: string,
):
  | { readonly _tag: "Ok"; readonly blocks: ReadonlyArray<SearchReplaceBlock> }
  | { readonly _tag: "Error"; readonly message: string } => {
  const cleaned = stripOuterMarkdownFence(raw)
  if (cleaned === "") {
    return {
      _tag: "Error",
      message: "Keine SEARCH/REPLACE-Blöcke gefunden – die Eingabe ist leer.",
    }
  }

  const lines = cleaned.split("\n")
  const indexedLines = Array.map(lines, (line, idx) => ({ line, lineNum: idx + 1 }))
  const initialState: SearchReplaceParseState = {
    _tag: "Outside",
    blocks: [],
    maybeError: Option.none(),
  }
  const finalState = Array.reduce(
    indexedLines,
    initialState,
    (state, { line, lineNum }): SearchReplaceParseState => {
      if (Option.isSome(state.maybeError)) {
        return state
      }
      const trimmed = line.trim()
      if (state._tag === "Outside") {
        if (SEARCH_START_PATTERN.test(trimmed)) {
          return {
            _tag: "InSearch",
            startLine: lineNum,
            blocks: state.blocks,
            searchLines: [],
            maybeError: Option.none(),
          }
        }
        if (SEPARATOR_PATTERN.test(trimmed)) {
          return {
            ...state,
            maybeError: Option.some(
              `Zeile ${lineNum}: Unerwartetes „=======“ außerhalb eines SEARCH/REPLACE-Blocks.`,
            ),
          }
        }
        if (REPLACE_END_PATTERN.test(trimmed)) {
          return {
            ...state,
            maybeError: Option.some(
              `Zeile ${lineNum}: Unerwartetes „>>>>>>> REPLACE“ ohne vorheriges „<<<<<<< SEARCH“ und „=======“.`,
            ),
          }
        }
        return state
      }
      if (state._tag === "InSearch") {
        if (SEPARATOR_PATTERN.test(trimmed)) {
          return {
            _tag: "InReplace",
            startLine: state.startLine,
            blocks: state.blocks,
            searchLines: state.searchLines,
            replaceLines: [],
            maybeError: Option.none(),
          }
        }
        if (SEARCH_START_PATTERN.test(trimmed)) {
          return {
            ...state,
            maybeError: Option.some(
              `Block ${state.blocks.length + 1} (ab Zeile ${state.startLine}): Unerwartetes „<<<<<<< SEARCH“ innerhalb des Suchteils – fehlt davor „=======“ und „>>>>>>> REPLACE“?`,
            ),
          }
        }
        if (REPLACE_END_PATTERN.test(trimmed)) {
          return {
            ...state,
            maybeError: Option.some(
              `Block ${state.blocks.length + 1} (ab Zeile ${state.startLine}): „>>>>>>> REPLACE“ vor „=======“ gefunden. Trenne Such- und Ersetzungsteil mit „=======“.`,
            ),
          }
        }
        return {
          ...state,
          searchLines: [...state.searchLines, line],
        }
      }
      if (REPLACE_END_PATTERN.test(trimmed)) {
        return {
          _tag: "Outside",
          blocks: [
            ...state.blocks,
            {
              searchLines: state.searchLines,
              replaceLines: state.replaceLines,
            },
          ],
          maybeError: Option.none(),
        }
      }
      if (SEARCH_START_PATTERN.test(trimmed)) {
        return {
          ...state,
          maybeError: Option.some(
            `Block ${state.blocks.length + 1} (ab Zeile ${state.startLine}): Unerwartetes „<<<<<<< SEARCH“ innerhalb eines offenen Blocks – fehlt davor „>>>>>>> REPLACE“?`,
          ),
        }
      }
      return {
        ...state,
        replaceLines: [...state.replaceLines, line],
      }
    },
  )

  if (Option.isSome(finalState.maybeError)) {
    return { _tag: "Error", message: finalState.maybeError.value }
  }
  if (finalState._tag === "InSearch") {
    return {
      _tag: "Error",
      message: `Unvollständiger SEARCH/REPLACE-Block ${finalState.blocks.length + 1} (ab Zeile ${finalState.startLine}): Trennlinie „=======“ und Endmarkierung „>>>>>>> REPLACE“ fehlen.`,
    }
  }
  if (finalState._tag === "InReplace") {
    return {
      _tag: "Error",
      message: `Unvollständiger SEARCH/REPLACE-Block ${finalState.blocks.length + 1} (ab Zeile ${finalState.startLine}): Endmarkierung „>>>>>>> REPLACE“ fehlt.`,
    }
  }
  if (Array.isReadonlyArrayEmpty(finalState.blocks)) {
    return {
      _tag: "Error",
      message: [
        "Keine SEARCH/REPLACE-Blöcke gefunden. Erwartetes Format:",
        "<<<<<<< SEARCH",
        "alter Code",
        "=======",
        "neuer Code",
        ">>>>>>> REPLACE",
      ].join("\n"),
    }
  }
  return { _tag: "Ok", blocks: finalState.blocks }
}

export const applySearchReplaceEdits = (
  originalContent: string,
  editsText: string,
): EditApplyResult => {
  const parsed = parseSearchReplaceBlocks(editsText)
  if (parsed._tag === "Error") {
    return EditApplyResult.Error({ message: parsed.message })
  }

  const initialLines = originalContent.replace(/\r\n/g, "\n").split("\n")
  const blocks: ReadonlyArray<LineEditBlock> = Array.map(parsed.blocks, (block, index) => ({
    label: `SEARCH-Block ${index + 1}`,
    searchLines: block.searchLines,
    replaceLines: block.replaceLines,
    maybeHintLine: Option.none(),
    maybeInsertIndex: Option.none(),
    maybeExactText: Option.some({
      search: block.searchLines.join("\n"),
      replace: block.replaceLines.join("\n"),
    }),
    notFoundText: "wurde in der Datei nicht gefunden.",
    missingContextText: "darf bei nicht-leerer Datei nicht leer sein.",
  }))

  const result = applyLineEditBlocks(initialLines, blocks)
  if (result._tag === "Error") {
    return EditApplyResult.Error({ message: result.errors.join("\n") })
  }
  return EditApplyResult.Ok({
    content: result.lines.join("\n"),
    appliedCount: result.appliedCount,
    updatedSnippet: "",
  })
}

// SIMPLIFIED UNIFIED DIFF

interface DiffHunk {
  readonly maybeHintLine: Option.Option<number>
  readonly searchLines: ReadonlyArray<string>
  readonly replaceLines: ReadonlyArray<string>
}

const parseHunkHeaderHint = (line: string): Option.Option<number> => {
  const match = /^@@(?:\s+-(\d+)(?:,\d+)?(?:\s+\+\d+(?:,\d+)?)?\s+@@|\s*@@)?/.exec(line.trim())
  if (!match) {
    return Option.none()
  }
  const numStr = match[1]
  if (!numStr) {
    return Option.none()
  }
  const parsed = Number.parseInt(numStr, 10)
  return Number.isNaN(parsed) ? Option.none() : Option.some(parsed)
}

const parseUnifiedDiffHunks = (
  raw: string,
):
  | { readonly _tag: "Ok"; readonly hunks: ReadonlyArray<DiffHunk> }
  | { readonly _tag: "Error"; readonly message: string } => {
  const cleaned = stripOuterMarkdownFence(raw)
  if (cleaned === "") {
    return { _tag: "Error", message: "Kein Unified Diff gefunden – die Eingabe ist leer." }
  }

  const lines = cleaned.split("\n")
  const indexedLines = Array.map(lines, (line, idx) => ({ line, lineNum: idx + 1 }))
  const parsedState = Array.reduce(
    indexedLines,
    {
      hunks: [] as ReadonlyArray<DiffHunk>,
      current: Option.none<DiffHunk>(),
      hasError: Option.none<string>(),
    },
    (state, { line, lineNum }) => {
      if (Option.isSome(state.hasError)) {
        return state
      }
      const trimmed = line.trim()
      if (
        Option.isNone(state.current) &&
        (line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("diff --git ") ||
          line.startsWith("index ") ||
          trimmed.startsWith("```"))
      ) {
        return state
      }
      if (trimmed.startsWith("@@")) {
        const nextHunks = Option.match(state.current, {
          onNone: () => state.hunks,
          onSome: (hunk) => [...state.hunks, hunk],
        })
        return {
          ...state,
          hunks: nextHunks,
          current: Option.some({
            maybeHintLine: parseHunkHeaderHint(line),
            searchLines: [],
            replaceLines: [],
          }),
        }
      }
      if (line === "\\ No newline at end of file") {
        return state
      }

      const appendToHunk = (hunk: DiffHunk) => {
        if (line.startsWith("-")) {
          return {
            ...state,
            current: Option.some({
              ...hunk,
              searchLines: [...hunk.searchLines, line.slice(1)],
            }),
          }
        }
        if (line.startsWith("+")) {
          return {
            ...state,
            current: Option.some({
              ...hunk,
              replaceLines: [...hunk.replaceLines, line.slice(1)],
            }),
          }
        }
        if (line.startsWith(" ")) {
          const ctx = line.slice(1)
          return {
            ...state,
            current: Option.some({
              ...hunk,
              searchLines: [...hunk.searchLines, ctx],
              replaceLines: [...hunk.replaceLines, ctx],
            }),
          }
        }
        if (line === "") {
          return {
            ...state,
            current: Option.some({
              ...hunk,
              searchLines: [...hunk.searchLines, ""],
              replaceLines: [...hunk.replaceLines, ""],
            }),
          }
        }
        if (trimmed.startsWith("```")) {
          return {
            ...state,
            hunks: [...state.hunks, hunk],
            current: Option.none<DiffHunk>(),
          }
        }
        return {
          ...state,
          hasError: Option.some(
            `Diff-Hunk ${state.hunks.length + 1} (Zeile ${lineNum}): Ungültige Diff-Zeile „${previewLine(line)}“ – jede Zeile im Hunk muss mit ' ' (Kontext), '-' (entfernen) oder '+' (hinzufügen) beginnen.`,
          ),
        }
      }

      return Option.match(state.current, {
        onNone: () => {
          if (trimmed === "") {
            return state
          }
          if (line.startsWith("-") || line.startsWith("+") || line.startsWith(" ")) {
            return appendToHunk({
              maybeHintLine: Option.none(),
              searchLines: [],
              replaceLines: [],
            })
          }
          return state
        },
        onSome: appendToHunk,
      })
    },
  )

  if (Option.isSome(parsedState.hasError)) {
    return { _tag: "Error", message: parsedState.hasError.value }
  }

  const allHunks = Option.match(parsedState.current, {
    onNone: () => parsedState.hunks,
    onSome: (hunk) => [...parsedState.hunks, hunk],
  })

  if (Array.isReadonlyArrayEmpty(allHunks)) {
    return {
      _tag: "Error",
      message: [
        "Keine @@-Hunks im Unified Diff gefunden. Erwartetes Format:",
        "@@",
        " unveränderte Kontextzeile",
        "-entfernte Zeile",
        "+neue Zeile",
      ].join("\n"),
    }
  }

  return { _tag: "Ok", hunks: allHunks }
}

export const applyUnifiedDiffEdits = (
  originalContent: string,
  editsText: string,
): EditApplyResult => {
  const parsed = parseUnifiedDiffHunks(editsText)
  if (parsed._tag === "Error") {
    return EditApplyResult.Error({ message: parsed.message })
  }

  const initialLines = originalContent.replace(/\r\n/g, "\n").split("\n")
  const blocks: ReadonlyArray<LineEditBlock> = Array.map(parsed.hunks, (hunk, index) => ({
    label: `Diff-Hunk ${index + 1}`,
    searchLines: hunk.searchLines,
    replaceLines: hunk.replaceLines,
    maybeHintLine: hunk.maybeHintLine,
    maybeInsertIndex: Option.map(hunk.maybeHintLine, (line) => Math.max(0, line - 1)),
    maybeExactText: Option.none(),
    notFoundText: "konnte in der Datei nicht zugeordnet werden.",
    missingContextText:
      "hat keine Kontext- oder Löschzeilen zum Zuordnen. Gib mindestens eine unveränderte Nachbarzeile mit führendem Leerzeichen (' ') an.",
  }))

  const result = applyLineEditBlocks(initialLines, blocks)
  if (result._tag === "Error") {
    return EditApplyResult.Error({ message: result.errors.join("\n") })
  }
  return EditApplyResult.Ok({
    content: result.lines.join("\n"),
    appliedCount: result.appliedCount,
    updatedSnippet: "",
  })
}

export const applyEditsForFormat = (
  format: EditFormat,
  originalContent: string,
  editsText: string,
): EditApplyResult =>
  Match.value(format).pipe(
    Match.when("hashline", () =>
      HashlineApplyResult.match(applyHashlineEdits(originalContent, editsText), {
        Ok: ({ content, appliedCount, changedLines }) =>
          EditApplyResult.Ok({ content, appliedCount, updatedSnippet: changedLines }),
        Error: ({ message }) => EditApplyResult.Error({ message }),
      }),
    ),
    Match.when("search-replace", () => applySearchReplaceEdits(originalContent, editsText)),
    Match.when("unified-diff", () => applyUnifiedDiffEdits(originalContent, editsText)),
    Match.exhaustive,
  )
