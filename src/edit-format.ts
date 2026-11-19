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

const formatSearchReplaceInstructions = (
  fenceLang: string,
  toolHeader?: string,
): ReadonlyArray<string> => {
  const tr = t(getDocumentLanguage())
  return [
    ...tr.editFormat.searchReplaceRules,
    "",
    tr.hashline.exampleHeading,
    "",
    ...(toolHeader ? [toolHeader] : []),
    `\`\`\`${fenceLang}`,
    "<<<<<<< SEARCH",
    tr.editFormat.exampleOldText,
    "=======",
    tr.hashline.exampleNewText,
    ">>>>>>> REPLACE",
    "```",
  ]
}

const formatUnifiedDiffInstructions = (
  fenceLang: string,
  toolHeader?: string,
): ReadonlyArray<string> => {
  const tr = t(getDocumentLanguage())
  return [
    ...tr.editFormat.unifiedDiffRules,
    "",
    tr.hashline.exampleHeading,
    "",
    ...(toolHeader ? [toolHeader] : []),
    `\`\`\`${fenceLang}`,
    "@@",
    " <main>",
    `-${tr.editFormat.exampleOldText}`,
    `+${tr.hashline.exampleNewText}`,
    " </main>",
    "```",
  ]
}

export const formatSystemPromptForFormat = (format: EditFormat, useToolCalls = true): string => {
  const ef = t(getDocumentLanguage()).editFormat
  const basePrompt = Match.value(format).pipe(
    Match.when("hashline", () => formatHashlineSystemPrompt(useToolCalls)),
    Match.when("search-replace", () =>
      [
        ef.srHeading,
        "",
        useToolCalls ? ef.srUseToolCalls : ef.srUseTextToolCall,
        "",
        ...formatSearchReplaceInstructions(
          useToolCalls ? "" : "edit",
          useToolCalls ? undefined : "toolcall edit",
        ),
      ].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [
        ef.udHeading,
        "",
        useToolCalls ? ef.udUseToolCalls : ef.udUseTextToolCall,
        "",
        ...formatUnifiedDiffInstructions(
          useToolCalls ? "diff" : "edit",
          useToolCalls ? undefined : "toolcall edit",
        ),
      ].join("\n"),
    ),
    Match.exhaustive,
  )
  return [
    basePrompt,
    ...(useToolCalls ? ef.additionalToolsInstructions : ef.additionalTextToolsInstructions),
  ].join("\n")
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
        ...formatSearchReplaceInstructions(""),
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
        ...formatUnifiedDiffInstructions("diff"),
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

interface FencedCodeBlock {
  readonly lang: string
  readonly body: string
}

const OPENING_FENCE_PATTERN = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/
const TOOLCALL_MENTION_PATTERN =
  /(?:^|[\s*_`])tool[\s_-]*call[*_`]*\b[\s\S]*?\b(edit|read|search|write)\b/i
const INLINE_TOOLCALL_FENCE_PATTERN =
  /(?:^|[\s*_`])tool[\s_-]*call[*_`]*\b[\s\S]*?\b(edit|read|search|write)\b[\s\S]*?(`{3,}|~{3,})\s*([^\s`~]*)\s*$/i

const isToolCallLang = (lang: string): boolean =>
  lang === "edit" || lang === "read" || lang === "search" || lang === "write"

interface FencedScanResult {
  readonly blocks: ReadonlyArray<FencedCodeBlock>
  readonly strippedText: string
}

const scanFencedCodeBlocks = (text: string): FencedScanResult => {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const blocks: FencedCodeBlock[] = []
  const keptLines: string[] = []
  let pendingToolCall: string | undefined
  let pendingHeaderLines: string[] = []
  let activeFence:
    | {
        readonly char: string
        readonly len: number
        readonly lang: string
        readonly isTool: boolean
        readonly openingLine: string
        readonly lines: string[]
      }
    | undefined

  const flushPendingHeader = () => {
    if (pendingHeaderLines.length > 0) {
      keptLines.push(...pendingHeaderLines)
      pendingHeaderLines = []
    }
    pendingToolCall = undefined
  }

  for (const line of lines) {
    if (!activeFence) {
      const inlineMatch = INLINE_TOOLCALL_FENCE_PATTERN.exec(line)
      if (inlineMatch && inlineMatch[1] && inlineMatch[2]) {
        flushPendingHeader()
        const prefix = line.slice(0, inlineMatch.index).replace(/[*_`\s]+$/, "")
        if (prefix !== "") {
          keptLines.push(prefix)
        }
        activeFence = {
          char: inlineMatch[2][0] ?? "`",
          len: inlineMatch[2].length,
          lang: inlineMatch[1].toLowerCase(),
          isTool: true,
          openingLine: line,
          lines: [],
        }
        continue
      }
      const headerMatch = TOOLCALL_MENTION_PATTERN.exec(line)
      if (headerMatch && headerMatch[1]) {
        flushPendingHeader()
        pendingToolCall = headerMatch[1].toLowerCase()
        pendingHeaderLines = [line]
        continue
      }
      const openMatch = OPENING_FENCE_PATTERN.exec(line)
      if (openMatch && openMatch[1]) {
        const lang = pendingToolCall ?? (openMatch[2] ?? "").trim().toLowerCase()
        const isTool = isToolCallLang(lang)
        if (!isTool) {
          flushPendingHeader()
          keptLines.push(line)
        } else {
          pendingToolCall = undefined
          pendingHeaderLines = []
        }
        activeFence = {
          char: openMatch[1][0] ?? "`",
          len: openMatch[1].length,
          lang,
          isTool,
          openingLine: line,
          lines: [],
        }
        continue
      }
      if (line.trim() !== "") {
        flushPendingHeader()
        keptLines.push(line)
      } else if (pendingToolCall !== undefined) {
        pendingHeaderLines.push(line)
      } else {
        keptLines.push(line)
      }
      continue
    }

    const trimmed = line.trim()
    const isClosing =
      trimmed.length >= activeFence.len && [...trimmed].every((ch) => ch === activeFence?.char)
    if (isClosing) {
      blocks.push({ lang: activeFence.lang, body: activeFence.lines.join("\n") })
      if (!activeFence.isTool) {
        keptLines.push(...activeFence.lines, line)
      }
      activeFence = undefined
    } else {
      activeFence.lines.push(line)
    }
  }

  flushPendingHeader()
  if (activeFence) {
    keptLines.push(activeFence.openingLine, ...activeFence.lines)
  }

  return {
    blocks,
    strippedText: keptLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  }
}

export const stripTextToolCalls = (text: string): string => scanFencedCodeBlocks(text).strippedText

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
  scanFencedCodeBlocks(text).blocks.flatMap<ParsedTextToolCall>((block, index) => {
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
