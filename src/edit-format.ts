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
import { getDocumentLanguage, type Language, t } from "./i18n"
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

export const getEditFormatOptions = (
  language: Language = getDocumentLanguage(),
): ReadonlyArray<{
  readonly value: EditFormat
  readonly label: string
}> => [
  { value: "hashline", label: "Hash-Anchored Edits" },
  { value: "search-replace", label: "Search & Replace" },
  { value: "unified-diff", label: t(language).agent.editFormatUnifiedDiff },
]

export const EDIT_FORMAT_OPTIONS: ReadonlyArray<{
  readonly value: EditFormat
  readonly label: string
}> = getEditFormatOptions("de")

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
      [
        t(getDocumentLanguage()).hashline.fileHeading(fileName),
        "",
        formatPlainFencedFile(content),
      ].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [
        t(getDocumentLanguage()).hashline.fileHeading(fileName),
        "",
        formatPlainFencedFile(content),
      ].join("\n"),
    ),
    Match.exhaustive,
  )

const formatSearchReplaceInstructions = (wrapper: {
  readonly open: string
  readonly close: string
}): ReadonlyArray<string> => {
  const tr = t(getDocumentLanguage())
  return [
    ...tr.editFormat.searchReplaceRules,
    "",
    tr.hashline.exampleHeading,
    "",
    wrapper.open,
    "<<<<<<< SEARCH",
    tr.editFormat.exampleOldText,
    "=======",
    tr.hashline.exampleNewText,
    ">>>>>>> REPLACE",
    wrapper.close,
  ]
}

const formatUnifiedDiffInstructions = (wrapper: {
  readonly open: string
  readonly close: string
}): ReadonlyArray<string> => {
  const tr = t(getDocumentLanguage())
  return [
    ...tr.editFormat.unifiedDiffRules,
    "",
    tr.hashline.exampleHeading,
    "",
    wrapper.open,
    "@@",
    " <main>",
    `-${tr.editFormat.exampleOldText}`,
    `+${tr.hashline.exampleNewText}`,
    " </main>",
    wrapper.close,
  ]
}

export type FewShotChatMessage =
  | { readonly _tag: "User"; readonly content: string }
  | { readonly _tag: "Assistant"; readonly content: string }

export const getTextToolFewShotMessages = (
  format: EditFormat,
): ReadonlyArray<FewShotChatMessage> => {
  const tr = t(getDocumentLanguage())
  const ef = tr.editFormat
  const sampleFile = `<main>\n${ef.exampleOldText}\n</main>`
  const formattedSampleFile = formatFileMessageForFormat(format, "example.html", sampleFile)
  const editBody = Match.value(format).pipe(
    Match.when("hashline", () => [
      `REPLACE 2:${hashLine(ef.exampleOldText)}`,
      tr.hashline.exampleNewText,
      "END",
    ]),
    Match.when("search-replace", () => [
      "<<<<<<< SEARCH",
      ef.exampleOldText,
      "=======",
      tr.hashline.exampleNewText,
      ">>>>>>> REPLACE",
    ]),
    Match.when("unified-diff", () => [
      "@@",
      " <main>",
      `-${ef.exampleOldText}`,
      `+${tr.hashline.exampleNewText}`,
      " </main>",
    ]),
    Match.exhaustive,
  )
  return [
    {
      _tag: "User",
      content: `${formattedSampleFile.trimEnd()}\n\n${ef.textToolFewShotEditPrompt}`,
    },
    {
      _tag: "Assistant",
      content: ["<edit>", ...editBody, "</edit>"].join("\n"),
    },
    {
      _tag: "User",
      content: ef.textToolFewShotSearchUser,
    },
    {
      _tag: "Assistant",
      content: ef.textToolFewShotSearchAssistant,
    },
    {
      _tag: "User",
      content: ef.textToolFewShotWriteUser,
    },
    {
      _tag: "Assistant",
      content: ef.textToolFewShotWriteAssistant,
    },
  ]
}

export const formatSystemPromptForFormat = (format: EditFormat, useToolCalls = true): string => {
  const ef = t(getDocumentLanguage()).editFormat
  if (!useToolCalls) {
    return ef.textToolIntro
  }
  const basePrompt = Match.value(format).pipe(
    Match.when("hashline", () => formatHashlineSystemPrompt(true)),
    Match.when("search-replace", () =>
      [
        ef.srHeading,
        "",
        ef.srUseToolCalls,
        "",
        ...formatSearchReplaceInstructions({ open: "```", close: "```" }),
      ].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [
        ef.udHeading,
        "",
        ef.udUseToolCalls,
        "",
        ...formatUnifiedDiffInstructions({ open: "```diff", close: "```" }),
      ].join("\n"),
    ),
    Match.exhaustive,
  )
  return [basePrompt, ...ef.additionalToolsInstructions].join("\n")
}

export const formatLlmContextForFormat = (
  format: EditFormat,
  fileName: string,
  content: string,
  apiDts: string,
): string => {
  const ef = t(getDocumentLanguage()).editFormat
  return Match.value(format).pipe(
    Match.when("hashline", () => formatHashlineContext(fileName, content, apiDts)),
    Match.when("search-replace", () =>
      [
        ef.srHeading,
        "",
        ef.srContextReplyOnly,
        "",
        ...formatSearchReplaceInstructions({ open: "```", close: "```" }),
        "",
        formatApiDtsMessage(apiDts),
        "",
        formatFileMessageForFormat("search-replace", fileName, content),
      ].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [
        ef.udHeading,
        "",
        ef.udContextReplyOnly,
        "",
        ...formatUnifiedDiffInstructions({ open: "```diff", close: "```" }),
        "",
        formatApiDtsMessage(apiDts),
        "",
        formatFileMessageForFormat("unified-diff", fileName, content),
      ].join("\n"),
    ),
    Match.exhaustive,
  )
}

export const getEditorEditToolForFormat = (format: EditFormat) => {
  const ef = t(getDocumentLanguage()).editFormat
  const description = Match.value(format).pipe(
    Match.when("hashline", () => ef.toolEditDescHashline),
    Match.when("search-replace", () => ef.toolEditDescSr),
    Match.when("unified-diff", () => ef.toolEditDescUd),
    Match.exhaustive,
  )

  const paramDescription = Match.value(format).pipe(
    Match.when("hashline", () => ef.toolEditParamHashline),
    Match.when("search-replace", () => ef.toolEditParamSr),
    Match.when("unified-diff", () => ef.toolEditParamUd),
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

const getEditorReadTool = () => {
  const ef = t(getDocumentLanguage()).editFormat
  return {
    type: "function",
    function: {
      name: "read",
      description: ef.toolReadDesc,
      parameters: {
        type: "object",
        properties: {
          startLine: {
            type: "integer",
            description: ef.toolReadStartLine,
          },
          endLine: {
            type: "integer",
            description: ef.toolReadEndLine,
          },
        },
        additionalProperties: false,
      },
    },
  } as const
}

const getEditorSearchTool = () => {
  const ef = t(getDocumentLanguage()).editFormat
  return {
    type: "function",
    function: {
      name: "search",
      description: ef.toolSearchDesc,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: ef.toolSearchQuery,
          },
          isRegex: {
            type: "boolean",
            description: ef.toolSearchIsRegex,
          },
          caseSensitive: {
            type: "boolean",
            description: ef.toolSearchCaseSensitive,
          },
          before: {
            type: "integer",
            description: ef.toolSearchBefore,
          },
          after: {
            type: "integer",
            description: ef.toolSearchAfter,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  } as const
}

const getEditorWriteTool = () => {
  const ef = t(getDocumentLanguage()).editFormat
  return {
    type: "function",
    function: {
      name: "write",
      description: ef.toolWriteDesc,
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: ef.toolWriteContent,
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  } as const
}

export const EDITOR_READ_TOOL = getEditorReadTool()
export const EDITOR_SEARCH_TOOL = getEditorSearchTool()
export const EDITOR_WRITE_TOOL = getEditorWriteTool()

export const getEditorToolsForFormat = (format: EditFormat) =>
  [
    getEditorEditToolForFormat(format),
    getEditorReadTool(),
    getEditorSearchTool(),
    getEditorWriteTool(),
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
  const ef = t(getDocumentLanguage()).editFormat
  if (parsed._tag === "Truncated") {
    throw new Error(ef.errToolArgsTruncated)
  }
  if (parsed._tag === "NotAnObject") {
    throw new Error(ef.errToolArgsNotObject)
  }
  throw new Error(ef.errToolArgsInvalidJson(parsed.detail))
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
  const ef = t(getDocumentLanguage()).editFormat
  const trimmed = rawArgs.trim()
  if (trimmed === "") {
    return {
      _tag: "Error",
      message: ef.errEditArgsEmpty,
    }
  }

  const parsed = parseJsonObjectLenient(trimmed)
  if (parsed._tag === "Valid" || parsed._tag === "Repaired") {
    return Option.match(extractEditsFromRecord(parsed.record), {
      onSome: (editsText) => ({ _tag: "Ok", editsText }),
      onNone: () => {
        const keys = Object.keys(parsed.record)
        const presentHint = keys.length > 0 ? ef.errEditPresentKeysHint(keys.join(", ")) : ""
        return {
          _tag: "Error",
          message: ef.errEditMissingParam(presentHint),
        }
      },
    })
  }

  if (parsed._tag === "Truncated") {
    return {
      _tag: "Error",
      message: ef.errEditArgsTruncated,
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
      message: ef.errEditArgsNotObject,
    }
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { _tag: "Ok", editsText: rawArgs }
  }

  return {
    _tag: "Error",
    message: ef.errEditArgsInvalidJson(parsed.detail),
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
  const ef = t(getDocumentLanguage()).editFormat
  let args: Record<string, unknown>
  try {
    args = parseToolJsonObject(rawArgs)
  } catch (err) {
    return EditorToolTextResult.Error({
      message: err instanceof Error ? err.message : ef.errInvalidJsonArgs,
    })
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const totalLines = lines.length

  const rawStart = args.startLine
  if (rawStart !== undefined && (typeof rawStart !== "number" || !Number.isFinite(rawStart))) {
    return EditorToolTextResult.Error({ message: ef.errStartLineNotNumber })
  }
  const rawEnd = args.endLine
  if (rawEnd !== undefined && (typeof rawEnd !== "number" || !Number.isFinite(rawEnd))) {
    return EditorToolTextResult.Error({ message: ef.errEndLineNotNumber })
  }

  const start = rawStart !== undefined ? Math.max(1, Math.floor(rawStart)) : 1
  if (start > totalLines) {
    return EditorToolTextResult.Error({
      message: ef.errStartLinePastEof(start, totalLines),
    })
  }

  const end =
    rawEnd !== undefined
      ? Math.min(totalLines, Math.floor(rawEnd))
      : Math.min(totalLines, start + MAX_READ_LINES - 1)
  if (end < start) {
    return EditorToolTextResult.Error({
      message: ef.errEndBeforeStart(end, start),
    })
  }

  const slice = lines.slice(start - 1, end)
  const formatted = Array.map(slice, (line, idx) =>
    formatNumberedLine(format, start + idx, line),
  ).join("\n")
  const continuationHint =
    rawEnd === undefined && end < totalLines ? ef.readContinuationHint(end + 1) : ""

  return EditorToolTextResult.Ok({
    text:
      [ef.readHeader(fileName, start, end, totalLines), "", "```", formatted, "```"].join("\n") +
      continuationHint,
  })
}

export const executeSearchTool = (
  format: EditFormat,
  fileName: string,
  content: string,
  rawArgs: string,
): EditorToolTextResult => {
  const ef = t(getDocumentLanguage()).editFormat
  let args: Record<string, unknown>
  try {
    args = parseToolJsonObject(rawArgs)
  } catch (err) {
    return EditorToolTextResult.Error({
      message: err instanceof Error ? err.message : ef.errInvalidJsonArgs,
    })
  }

  const query = args.query
  if (typeof query !== "string" || query === "") {
    return EditorToolTextResult.Error({ message: ef.errSearchEmptyQuery })
  }
  const isRegex = args.isRegex === true
  const caseSensitive = args.caseSensitive === true
  const rawBefore = args.before
  if (
    rawBefore !== undefined &&
    (typeof rawBefore !== "number" || !Number.isFinite(rawBefore) || rawBefore < 0)
  ) {
    return EditorToolTextResult.Error({
      message: ef.errBeforeNotNonNeg,
    })
  }
  const rawAfter = args.after
  if (
    rawAfter !== undefined &&
    (typeof rawAfter !== "number" || !Number.isFinite(rawAfter) || rawAfter < 0)
  ) {
    return EditorToolTextResult.Error({
      message: ef.errAfterNotNonNeg,
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
        message: ef.errInvalidRegex(err instanceof Error ? err.message : String(err)),
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
      text: ef.searchNoMatches(query, fileName),
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
      ? ef.searchMoreMatches(matchIndices.length - MAX_SEARCH_MATCHES)
      : ""

  return EditorToolTextResult.Ok({
    text:
      [ef.searchHeader(query, fileName, matchIndices.length), "", "```", shown, "```"].join("\n") +
      moreHint,
  })
}

export const executeWriteTool = (fileName: string, rawArgs: string): EditorWriteToolResult => {
  const ef = t(getDocumentLanguage()).editFormat
  let args: Record<string, unknown>
  try {
    args = parseToolJsonObject(rawArgs)
  } catch (err) {
    return EditorWriteToolResult.Error({
      message: err instanceof Error ? err.message : ef.errInvalidJsonArgs,
    })
  }

  const newContent = args.content
  if (typeof newContent !== "string") {
    return EditorWriteToolResult.Error({
      message: ef.errWriteMissingContent,
    })
  }

  const normalized = newContent.replace(/\r\n/g, "\n")
  const lineCount = normalized.split("\n").length
  return EditorWriteToolResult.Ok({
    content: normalized,
    message: ef.writeSuccess(fileName, lineCount),
  })
}

export interface ParsedTextToolCall {
  readonly id: string
  readonly name: "edit" | "read" | "search" | "write"
  readonly arguments: string
}

const OPENING_FENCE_PATTERN = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/

const isTextToolName = (name: string): name is ParsedTextToolCall["name"] =>
  name === "edit" || name === "read" || name === "search" || name === "write"

const stripSingleEdgeNewlines = (body: string): string => body.replace(/^\n/, "").replace(/\n$/, "")

const parseXmlToolCallPayload = (
  rawBody: string,
): { readonly name: ParsedTextToolCall["name"]; readonly arguments: string } | undefined => {
  const parsed = parseJsonObjectLenient(rawBody)
  if (parsed._tag !== "Valid" && parsed._tag !== "Repaired") {
    return undefined
  }
  const record = parsed.record
  const rawName =
    typeof record.name === "string"
      ? record.name
      : typeof record.tool === "string"
        ? record.tool
        : ""
  const name = rawName.trim().toLowerCase()
  if (!isTextToolName(name)) {
    return undefined
  }
  const rawArgs = record.arguments ?? record.args ?? record.parameters
  if (typeof rawArgs === "string") {
    return { name, arguments: rawArgs }
  }
  if (typeof rawArgs === "object" && rawArgs !== null && !globalThis.Array.isArray(rawArgs)) {
    return { name, arguments: JSON.stringify(rawArgs) }
  }
  const restEntries = Object.entries(record).filter(
    ([key]) =>
      key !== "name" &&
      key !== "tool" &&
      key !== "arguments" &&
      key !== "args" &&
      key !== "parameters",
  )
  return {
    name,
    arguments: restEntries.length > 0 ? JSON.stringify(Object.fromEntries(restEntries)) : "{}",
  }
}

const normalizeXmlToolTag = (
  tag: string,
  rawBody: string,
): { readonly name: ParsedTextToolCall["name"]; readonly arguments: string } | undefined => {
  const lower = tag.toLowerCase()
  if (lower === "tool_call" || lower === "toolcall") {
    return parseXmlToolCallPayload(rawBody)
  }
  const body = stripSingleEdgeNewlines(rawBody)
  if (lower === "write") {
    return { name: "write", arguments: JSON.stringify({ content: body }) }
  }
  if (lower === "read") {
    return { name: "read", arguments: normalizeReadTextArgs(body) }
  }
  if (lower === "search") {
    return { name: "search", arguments: normalizeSearchTextArgs(body) }
  }
  if (lower === "edit") {
    return { name: "edit", arguments: normalizeEditTextArgs(body) }
  }
  return undefined
}

const XML_TOOL_OPEN_PATTERN = /<(tool[_-]?call|edit|read|search|write)\s*>/i

const scanXmlToolCalls = (
  text: string,
): {
  readonly calls: ReadonlyArray<{
    readonly name: ParsedTextToolCall["name"]
    readonly arguments: string
  }>
  readonly remainingText: string
} => {
  const normalized = text.replace(/\r\n/g, "\n")
  const calls: Array<{
    readonly name: ParsedTextToolCall["name"]
    readonly arguments: string
  }> = []
  let out = ""
  let pos = 0
  let activeFence: { readonly char: string; readonly len: number } | undefined

  while (pos < normalized.length) {
    const lineEnd = normalized.indexOf("\n", pos)
    const nextPos = lineEnd === -1 ? normalized.length : lineEnd + 1
    const line = lineEnd === -1 ? normalized.slice(pos) : normalized.slice(pos, lineEnd)

    if (activeFence) {
      out += normalized.slice(pos, nextPos)
      const trimmed = line.trim()
      if (
        trimmed.length >= activeFence.len &&
        [...trimmed].every((ch) => ch === activeFence?.char)
      ) {
        activeFence = undefined
      }
      pos = nextPos
      continue
    }

    const fenceMatch = OPENING_FENCE_PATTERN.exec(line)
    if (fenceMatch && fenceMatch[1]) {
      activeFence = {
        char: fenceMatch[1][0] ?? "`",
        len: fenceMatch[1].length,
      }
      out += normalized.slice(pos, nextPos)
      pos = nextPos
      continue
    }

    const openMatch = XML_TOOL_OPEN_PATTERN.exec(line)
    if (!openMatch || !openMatch[1]) {
      out += normalized.slice(pos, nextPos)
      pos = nextPos
      continue
    }

    const tagName = openMatch[1]
    const tagStart = pos + openMatch.index
    const bodyStart = tagStart + openMatch[0].length
    const closeRegex = new RegExp(`</${tagName}\\s*>`, "i")
    const closeMatch = closeRegex.exec(normalized.slice(bodyStart))
    if (!closeMatch) {
      out += normalized.slice(pos, nextPos)
      pos = nextPos
      continue
    }

    const body = normalized.slice(bodyStart, bodyStart + closeMatch.index)
    const afterClose = bodyStart + closeMatch.index + closeMatch[0].length
    const parsedCall = normalizeXmlToolTag(tagName, body)
    if (!parsedCall) {
      out += normalized.slice(pos, afterClose)
      pos = afterClose
      continue
    }

    calls.push(parsedCall)
    out += normalized.slice(pos, tagStart)
    pos = afterClose
  }

  return {
    calls,
    remainingText: out.replace(/\n{3,}/g, "\n\n").trim(),
  }
}

export const stripTextToolCalls = (text: string): string => scanXmlToolCalls(text).remainingText

const normalizeReadTextArgs = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed === "") {
    return "{}"
  }
  if (trimmed.startsWith("{")) {
    return trimmed
  }
  const rangeMatch = /^(\d+)\s*(?:[-–:]|\.\.)\s*(\d+)$/.exec(trimmed)
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
  scanXmlToolCalls(text).calls.map((call, index) => ({
    id: `xml_call_${index}`,
    name: call.name,
    arguments: call.arguments,
  }))

export const formatToolResultForFormat = (
  format: EditFormat,
  fileName: string,
  updatedSnippet: string,
): string =>
  Match.value(format).pipe(
    Match.when("hashline", () => formatUpdatedHashlines(fileName, updatedSnippet)),
    Match.when("search-replace", () =>
      t(getDocumentLanguage()).editFormat.toolResultApplied(fileName),
    ),
    Match.when("unified-diff", () =>
      t(getDocumentLanguage()).editFormat.toolResultApplied(fileName),
    ),
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
  const ef = t(getDocumentLanguage()).editFormat
  const cleaned = stripOuterMarkdownFence(raw)
  if (cleaned === "") {
    return {
      _tag: "Error",
      message: ef.srErrEmpty,
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
            maybeError: Option.some(ef.srErrUnexpectedSep(lineNum)),
          }
        }
        if (REPLACE_END_PATTERN.test(trimmed)) {
          return {
            ...state,
            maybeError: Option.some(ef.srErrUnexpectedEnd(lineNum)),
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
              ef.srErrNestedStartInSearch(state.blocks.length + 1, state.startLine),
            ),
          }
        }
        if (REPLACE_END_PATTERN.test(trimmed)) {
          return {
            ...state,
            maybeError: Option.some(ef.srErrEndBeforeSep(state.blocks.length + 1, state.startLine)),
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
            ef.srErrNestedStartInReplace(state.blocks.length + 1, state.startLine),
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
      message: ef.srErrIncompleteInSearch(finalState.blocks.length + 1, finalState.startLine),
    }
  }
  if (finalState._tag === "InReplace") {
    return {
      _tag: "Error",
      message: ef.srErrIncompleteInReplace(finalState.blocks.length + 1, finalState.startLine),
    }
  }
  if (Array.isReadonlyArrayEmpty(finalState.blocks)) {
    return {
      _tag: "Error",
      message: ef.srErrNoBlocks,
    }
  }
  return { _tag: "Ok", blocks: finalState.blocks }
}

export const applySearchReplaceEdits = (
  originalContent: string,
  editsText: string,
): EditApplyResult => {
  const ef = t(getDocumentLanguage()).editFormat
  const parsed = parseSearchReplaceBlocks(editsText)
  if (parsed._tag === "Error") {
    return EditApplyResult.Error({ message: parsed.message })
  }

  const initialLines = originalContent.replace(/\r\n/g, "\n").split("\n")
  const blocks: ReadonlyArray<LineEditBlock> = Array.map(parsed.blocks, (block, index) => ({
    label: ef.srBlockLabel(index + 1),
    searchLines: block.searchLines,
    replaceLines: block.replaceLines,
    maybeHintLine: Option.none(),
    maybeInsertIndex: Option.none(),
    maybeExactText: Option.some({
      search: block.searchLines.join("\n"),
      replace: block.replaceLines.join("\n"),
    }),
    notFoundText: ef.srNotFoundText,
    missingContextText: ef.srMissingContextText,
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
  const ef = t(getDocumentLanguage()).editFormat
  const cleaned = stripOuterMarkdownFence(raw)
  if (cleaned === "") {
    return { _tag: "Error", message: ef.udErrEmpty }
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
            ef.udErrInvalidLine(state.hunks.length + 1, lineNum, previewLine(line)),
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
      message: ef.udErrNoHunks,
    }
  }

  return { _tag: "Ok", hunks: allHunks }
}

export const applyUnifiedDiffEdits = (
  originalContent: string,
  editsText: string,
): EditApplyResult => {
  const ef = t(getDocumentLanguage()).editFormat
  const parsed = parseUnifiedDiffHunks(editsText)
  if (parsed._tag === "Error") {
    return EditApplyResult.Error({ message: parsed.message })
  }

  const initialLines = originalContent.replace(/\r\n/g, "\n").split("\n")
  const blocks: ReadonlyArray<LineEditBlock> = Array.map(parsed.hunks, (hunk, index) => ({
    label: ef.udHunkLabel(index + 1),
    searchLines: hunk.searchLines,
    replaceLines: hunk.replaceLines,
    maybeHintLine: hunk.maybeHintLine,
    maybeInsertIndex: Option.map(hunk.maybeHintLine, (line) => Math.max(0, line - 1)),
    maybeExactText: Option.none(),
    notFoundText: ef.udNotFoundText,
    missingContextText: ef.udMissingContextText,
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
