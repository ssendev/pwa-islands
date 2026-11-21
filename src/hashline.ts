import { Array, Match, Option, Order, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { extractFencedLines } from "./edit-match"
import { getDocumentLanguage, t } from "./i18n"

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

export const hashLine = (line: string): string => {
  const hash = Array.reduce(
    Array.makeBy(line.length, (i) => line.charCodeAt(i)),
    FNV_OFFSET_BASIS,
    (acc, code) => Math.imul(acc ^ code, FNV_PRIME),
  )
  return ((hash >>> 0) & 0xfff).toString(16).padStart(3, "0")
}

export const formatHashlineFile = (content: string): string => {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  return Array.map(lines, (line, index) => `${index + 1}:${hashLine(line)}|${line}`).join("\n")
}

export const formatFencedHashlineFile = (_fileName: string, content: string): string => {
  const hashedFile = formatHashlineFile(content)
  return ["```", hashedFile, "```"].join("\n") + "\n\n"
}

const formatHashlineCommandLines = (wrapper: {
  readonly open: string
  readonly close: string
}): ReadonlyArray<string> => {
  const hl = t(getDocumentLanguage()).hashline
  return [
    ...hl.commandRules,
    "",
    hl.exampleHeading,
    "",
    wrapper.open,
    "REPLACE 12:a3f..13:b4c",
    hl.exampleNewText,
    "END",
    "INSERT_AFTER 20:c1d",
    "  <script>console.log('ok')</script>",
    "END",
    "DELETE 30:e2f",
    wrapper.close,
  ]
}

export const formatHashlineSystemPrompt = (useToolCalls = true): string => {
  const hl = t(getDocumentLanguage()).hashline
  return [
    hl.systemHeading,
    "",
    hl.systemFileFormat,
    useToolCalls ? hl.systemUseToolCalls : hl.systemUseTextToolCall,
    "",
    ...formatHashlineCommandLines(
      useToolCalls ? { open: "```hashline", close: "```" } : { open: "<edit>", close: "</edit>" },
    ),
  ].join("\n")
}

export const formatApiDtsMessage = (apiDts: string): string =>
  ["## /api.d.ts", "", "```ts", apiDts.trimEnd(), "```"].join("\n")

export const formatHashedFileMessage = (fileName: string, content: string): string =>
  [
    t(getDocumentLanguage()).hashline.fileHeading(fileName),
    "",
    formatFencedHashlineFile(fileName, content),
  ].join("\n")

export const formatLlmContext = (fileName: string, content: string, apiDts: string): string => {
  const hl = t(getDocumentLanguage()).hashline
  return [
    hl.systemHeading,
    "",
    hl.systemFileFormat,
    hl.contextReplyOnly,
    "",
    ...formatHashlineCommandLines({ open: "```hashline", close: "```" }),
    "",
    formatApiDtsMessage(apiDts),
    "",
    formatHashedFileMessage(fileName, content),
  ].join("\n")
}

export const formatUpdatedHashlines = (fileName: string, changedLines: string): string =>
  [t(getDocumentLanguage()).hashline.updatedHeading(fileName), "", "```", changedLines, "```"].join(
    "\n",
  ) + "\n\n"

export const HashlineApplyResult = defineTaggedUnion({
  Ok: {
    content: Schema.String,
    appliedCount: Schema.Number,
    changedLines: Schema.String,
    notes: Schema.Array(Schema.String),
  },
  Error: {
    message: Schema.String,
  },
})
export type HashlineApplyResult = typeof HashlineApplyResult.Type

interface LineAnchor {
  readonly line: number
  readonly maybeHash: Option.Option<string>
}

type CommandKind = "REPLACE" | "INSERT_AFTER" | "INSERT_BEFORE" | "DELETE"
type BlockCommandKind = Exclude<CommandKind, "DELETE">

type EditOp =
  | {
      readonly _tag: "Replace"
      readonly source: string
      readonly start: LineAnchor
      readonly end: LineAnchor
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "InsertAfter"
      readonly source: string
      readonly anchor: LineAnchor
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "InsertBefore"
      readonly source: string
      readonly anchor: LineAnchor
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "Delete"
      readonly source: string
      readonly start: LineAnchor
      readonly end: LineAnchor
    }

const COMMAND_PATTERN = /^(REPLACE|INSERT[ _-]?AFTER|INSERT[ _-]?BEFORE|DELETE)(?:\s+(.*))?$/i
const END_PATTERN = /^END(?:[ _](?:REPLACE|INSERT(?:[ _](?:AFTER|BEFORE))?))?$/
const ANCHOR_SOURCE = String.raw`(\d+)(?:\s*:\s*([0-9a-fA-F]{2,8})(?![0-9a-zA-Z]))?`
const TARGET_PATTERN = new RegExp(
  String.raw`^${ANCHOR_SOURCE}(?:\|.*?)?(?:\s*(?:\.\.\.?|–|—|-)\s*${ANCHOR_SOURCE}(?:\|.*)?)?\s*$`,
)
const COPIED_PREFIX_PATTERN = /^\d+:[0-9a-fA-F]{2,8}\|/
const MAX_PREVIEW_CHARS = 120
const MAX_LISTED_UNKNOWN_LINES = 3
const RELOCATE_WINDOW = 100

const preview = (text: string): string =>
  text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text

const keywordToKind = (keyword: string): CommandKind => {
  const upper = keyword.toUpperCase()
  if (upper.startsWith("INSERT")) {
    return upper.endsWith("AFTER") ? "INSERT_AFTER" : "INSERT_BEFORE"
  }
  return upper === "DELETE" ? "DELETE" : "REPLACE"
}

interface ParsedTarget {
  readonly start: LineAnchor
  readonly maybeEnd: Option.Option<LineAnchor>
}

const toAnchor = (
  lineText: string | undefined,
  hashText: string | undefined,
): Option.Option<LineAnchor> =>
  lineText === undefined
    ? Option.none()
    : Option.some({
        line: Number(lineText),
        maybeHash: Option.map(Option.fromNullishOr(hashText), (hash) => hash.toLowerCase()),
      })

const parseTarget = (raw: string): Option.Option<ParsedTarget> => {
  const match = TARGET_PATTERN.exec(raw.trim())
  if (!match) {
    return Option.none()
  }
  return Option.map(toAnchor(match[1], match[2]), (start) => ({
    start,
    maybeEnd: toAnchor(match[3], match[4]),
  }))
}

const isFullyHashedTarget = (target: ParsedTarget): boolean =>
  Option.isSome(target.start.maybeHash) &&
  Option.match(target.maybeEnd, {
    onNone: () => true,
    onSome: (end) => Option.isSome(end.maybeHash),
  })

interface ParseAccumulator {
  readonly ops: ReadonlyArray<EditOp>
  readonly errors: ReadonlyArray<string>
  readonly notes: ReadonlyArray<string>
  readonly unknownLines: ReadonlyArray<string>
}

type ParseState =
  | ({ readonly _tag: "Idle" } & ParseAccumulator)
  | ({
      readonly _tag: "Collecting"
      readonly kind: BlockCommandKind
      readonly source: string
      readonly start: LineAnchor
      readonly end: LineAnchor
      readonly buffer: ReadonlyArray<string>
    } & ParseAccumulator)

const initialParseState: ParseState = {
  _tag: "Idle",
  ops: [],
  errors: [],
  notes: [],
  unknownLines: [],
}

const stripCopiedPrefixes = (
  lines: ReadonlyArray<string>,
): { readonly lines: ReadonlyArray<string>; readonly isStripped: boolean } => {
  const contentLines = lines.filter((line) => line.trim() !== "")
  if (
    Array.isReadonlyArrayEmpty(contentLines) ||
    !contentLines.every((line) => COPIED_PREFIX_PATTERN.test(line))
  ) {
    return { lines, isStripped: false }
  }
  return {
    lines: Array.map(lines, (line) => line.replace(COPIED_PREFIX_PATTERN, "")),
    isStripped: true,
  }
}

const finishCollecting = (
  state: Extract<ParseState, { _tag: "Collecting" }>,
  isImplicitEnd: boolean,
): Extract<ParseState, { _tag: "Idle" }> => {
  const body = stripCopiedPrefixes(state.buffer)
  const newOp: EditOp =
    state.kind === "REPLACE"
      ? {
          _tag: "Replace",
          source: state.source,
          start: state.start,
          end: state.end,
          lines: body.lines,
        }
      : state.kind === "INSERT_AFTER"
        ? { _tag: "InsertAfter", source: state.source, anchor: state.start, lines: body.lines }
        : { _tag: "InsertBefore", source: state.source, anchor: state.start, lines: body.lines }
  const hl = t(getDocumentLanguage()).hashline
  const notes = [
    ...(body.isStripped ? [hl.noteStrippedPrefixes(state.source)] : []),
    ...(isImplicitEnd ? [hl.noteImplicitEnd(state.source)] : []),
  ]
  return {
    _tag: "Idle",
    ops: [...state.ops, newOp],
    errors: state.errors,
    notes: [...state.notes, ...notes],
    unknownLines: state.unknownLines,
  }
}

const startCommand = (
  state: Extract<ParseState, { _tag: "Idle" }>,
  commandLine: string,
  keyword: string,
  rawTarget: string,
): ParseState => {
  const hl = t(getDocumentLanguage()).hashline
  const kind = keywordToKind(keyword)
  const source = preview(commandLine)
  const allowsRange = kind === "REPLACE" || kind === "DELETE"
  const formatExample = allowsRange ? hl.formatExampleRange(kind) : hl.formatExampleSingle(kind)
  const withError = (message: string): ParseState => ({
    ...state,
    errors: [...state.errors, `[${source}] ${message}`],
  })

  if (rawTarget === "") {
    return withError(hl.errMissingTarget(formatExample))
  }

  return Option.match(parseTarget(rawTarget), {
    onNone: () => withError(hl.errInvalidTarget(preview(rawTarget), formatExample)),
    onSome: ({ start, maybeEnd }): ParseState => {
      if (kind === "DELETE") {
        return {
          ...state,
          ops: [
            ...state.ops,
            { _tag: "Delete", source, start, end: Option.getOrElse(maybeEnd, () => start) },
          ],
        }
      }
      if (kind !== "REPLACE" && Option.isSome(maybeEnd)) {
        return withError(hl.errSingleAnchorOnly(kind, formatExample))
      }
      return {
        _tag: "Collecting",
        kind,
        source,
        start,
        end: Option.getOrElse(maybeEnd, () => start),
        buffer: [],
        ops: state.ops,
        errors: state.errors,
        notes: state.notes,
        unknownLines: state.unknownLines,
      }
    },
  })
}

const matchImplicitCommand = (trimmed: string): Option.Option<RegExpExecArray> => {
  const match = COMMAND_PATTERN.exec(trimmed)
  if (!match || match[1] !== match[1]?.toUpperCase()) {
    return Option.none()
  }
  return Option.match(parseTarget(match[2] ?? ""), {
    onNone: () => Option.none(),
    onSome: (target) => (isFullyHashedTarget(target) ? Option.some(match) : Option.none()),
  })
}

const describeUnknownLines = (
  unknownLines: ReadonlyArray<string>,
  lastOp: Option.Option<EditOp>,
): ReadonlyArray<string> => {
  if (Array.isReadonlyArrayEmpty(unknownLines)) {
    return []
  }
  const listed = unknownLines
    .slice(0, MAX_LISTED_UNKNOWN_LINES)
    .map((line) => `„${preview(line)}“`)
    .join(", ")
  const hl = t(getDocumentLanguage()).hashline
  const more =
    unknownLines.length > MAX_LISTED_UNKNOWN_LINES
      ? hl.unknownMoreCount(unknownLines.length - MAX_LISTED_UNKNOWN_LINES)
      : ""
  const looksCopied = unknownLines.some((line) => COPIED_PREFIX_PATTERN.test(line))
  const followsDelete = Option.match(lastOp, {
    onNone: () => false,
    onSome: (op) => op._tag === "Delete",
  })
  const hints = [
    hl.unknownHintGeneral,
    ...(looksCopied ? [hl.unknownHintCopied] : []),
    ...(followsDelete ? [hl.unknownHintAfterDelete] : []),
  ]
  return [hl.errUnknownLines(listed, more, hints.join(" "))]
}

const parseEditOps = (
  rawText: string,
): {
  readonly ops: ReadonlyArray<EditOp>
  readonly errors: ReadonlyArray<string>
  readonly notes: ReadonlyArray<string>
} => {
  const normalized = rawText.replace(/\r\n/g, "\n")
  const candidateLines = extractFencedLines(normalized.split("\n"))

  const finalState = Array.reduce(candidateLines, initialParseState, (state, line): ParseState => {
    const trimmed = line.trim()
    if (state._tag === "Collecting") {
      if (END_PATTERN.test(trimmed)) {
        return finishCollecting(state, false)
      }
      return Option.match(matchImplicitCommand(trimmed), {
        onNone: () => ({ ...state, buffer: [...state.buffer, line] }),
        onSome: (match) =>
          startCommand(finishCollecting(state, true), trimmed, match[1] ?? "", match[2] ?? ""),
      })
    }

    if (trimmed === "" || trimmed.startsWith("```") || END_PATTERN.test(trimmed)) {
      return state
    }

    const cmdMatch = COMMAND_PATTERN.exec(trimmed)
    if (!cmdMatch) {
      return { ...state, unknownLines: [...state.unknownLines, trimmed] }
    }
    return startCommand(state, trimmed, cmdMatch[1] ?? "", (cmdMatch[2] ?? "").trim())
  })

  const unknownErrors = describeUnknownLines(finalState.unknownLines, Array.last(finalState.ops))

  if (finalState._tag === "Collecting") {
    return {
      ops: finalState.ops,
      errors: [
        ...finalState.errors,
        ...unknownErrors,
        t(getDocumentLanguage()).hashline.errIncompleteBlock(finalState.source, finalState.kind),
      ],
      notes: finalState.notes,
    }
  }

  return {
    ops: finalState.ops,
    errors: [...finalState.errors, ...unknownErrors],
    notes: finalState.notes,
  }
}

interface LineSplice {
  readonly opIndex: number
  readonly index: number
  readonly deleteCount: number
  readonly insertLines: ReadonlyArray<string>
  readonly description: string
}

const describeFileLine = (
  originalLines: ReadonlyArray<string>,
  originalHashes: ReadonlyArray<string>,
  line: number,
): string =>
  `\`${line}:${originalHashes[line - 1] ?? ""}|${preview(originalLines[line - 1] ?? "")}\``

const validateAnchor = (
  source: string,
  anchor: LineAnchor,
  originalLines: ReadonlyArray<string>,
  originalHashes: ReadonlyArray<string>,
): Option.Option<string> => {
  const hl = t(getDocumentLanguage()).hashline
  const lineCount = originalLines.length
  if (!Number.isInteger(anchor.line) || anchor.line < 1 || anchor.line > lineCount) {
    return Option.some(hl.errLineNotFound(source, anchor.line, lineCount))
  }
  const actualHash = originalHashes[anchor.line - 1] ?? ""
  return Option.match(anchor.maybeHash, {
    onNone: () =>
      Option.some(
        hl.errHashMissing(
          source,
          anchor.line,
          actualHash,
          describeFileLine(originalLines, originalHashes, anchor.line),
        ),
      ),
    onSome: (givenHash) => {
      if (givenHash === actualHash) {
        return Option.none()
      }
      const windowStart = Math.max(1, anchor.line - RELOCATE_WINDOW)
      const windowEnd = Math.min(lineCount, anchor.line + RELOCATE_WINDOW)
      const relocated = Array.filter(
        Array.makeBy(windowEnd - windowStart + 1, (offset) => windowStart + offset),
        (line) => line !== anchor.line && originalHashes[line - 1] === givenHash,
      )
      const relocationHint =
        relocated.length === 1 && relocated[0] !== undefined
          ? hl.relocationHintFound(
              relocated[0],
              describeFileLine(originalLines, originalHashes, relocated[0]),
            )
          : hl.relocationHintChanged
      return Option.some(
        hl.errHashMismatch(
          source,
          anchor.line,
          actualHash,
          givenHash,
          describeFileLine(originalLines, originalHashes, anchor.line),
          relocationHint,
        ),
      )
    },
  })
}

const validateRange = (
  source: string,
  start: LineAnchor,
  end: LineAnchor,
  originalLines: ReadonlyArray<string>,
  originalHashes: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Array.getSomes([
    validateAnchor(source, start, originalLines, originalHashes),
    end.line !== start.line
      ? validateAnchor(source, end, originalLines, originalHashes)
      : Option.none(),
    start.line > end.line
      ? Option.some(t(getDocumentLanguage()).hashline.errInvalidRange(source, end.line, start.line))
      : Option.none(),
  ])

const opToSplice = (
  op: EditOp,
  opIndex: number,
  originalLines: ReadonlyArray<string>,
  originalHashes: ReadonlyArray<string>,
): {
  readonly splice: Option.Option<LineSplice>
  readonly errors: ReadonlyArray<string>
} => {
  const result = (
    errors: ReadonlyArray<string>,
    splice: Omit<LineSplice, "opIndex" | "description">,
  ) =>
    Array.isReadonlyArrayNonEmpty(errors)
      ? { splice: Option.none(), errors }
      : {
          splice: Option.some({ ...splice, opIndex, description: op.source }),
          errors: [],
        }

  return Match.value(op).pipe(
    Match.tag("Replace", (replaceOp) =>
      result(
        validateRange(op.source, replaceOp.start, replaceOp.end, originalLines, originalHashes),
        {
          index: replaceOp.start.line - 1,
          deleteCount: replaceOp.end.line - replaceOp.start.line + 1,
          insertLines: replaceOp.lines,
        },
      ),
    ),
    Match.tag("Delete", (deleteOp) =>
      result(
        validateRange(op.source, deleteOp.start, deleteOp.end, originalLines, originalHashes),
        {
          index: deleteOp.start.line - 1,
          deleteCount: deleteOp.end.line - deleteOp.start.line + 1,
          insertLines: [],
        },
      ),
    ),
    Match.tag("InsertAfter", (insertOp) => {
      const isFileStart = insertOp.anchor.line === 0
      return result(
        isFileStart
          ? []
          : Option.toArray(
              validateAnchor(op.source, insertOp.anchor, originalLines, originalHashes),
            ),
        { index: insertOp.anchor.line, deleteCount: 0, insertLines: insertOp.lines },
      )
    }),
    Match.tag("InsertBefore", (insertOp) =>
      result(
        Option.toArray(validateAnchor(op.source, insertOp.anchor, originalLines, originalHashes)),
        { index: insertOp.anchor.line - 1, deleteCount: 0, insertLines: insertOp.lines },
      ),
    ),
    Match.exhaustive,
  )
}

const splicesOverlap = (a: LineSplice, b: LineSplice): boolean => {
  if (a.deleteCount === 0 && b.deleteCount === 0) {
    return false
  }
  if (a.deleteCount === 0) {
    return a.index > b.index && a.index < b.index + b.deleteCount
  }
  if (b.deleteCount === 0) {
    return b.index > a.index && b.index < a.index + a.deleteCount
  }
  return a.index < b.index + b.deleteCount && b.index < a.index + a.deleteCount
}

const ascendingSpliceOrder: Order.Order<LineSplice> = Order.combineAll([
  Order.mapInput(Order.Number, (splice: LineSplice) => splice.index),
  Order.mapInput(Order.Number, (splice: LineSplice) => splice.deleteCount),
  Order.mapInput(Order.Number, (splice: LineSplice) => splice.opIndex),
])

export const applyHashlineEdits = (
  originalContent: string,
  responseText: string,
): HashlineApplyResult => {
  if (responseText.trim() === "") {
    return HashlineApplyResult.Error({
      message: t(getDocumentLanguage()).hashline.errEmptyInput,
    })
  }

  const parsed = parseEditOps(responseText)
  if (Array.isReadonlyArrayNonEmpty(parsed.errors)) {
    return HashlineApplyResult.Error({ message: parsed.errors.join("\n") })
  }
  if (Array.isReadonlyArrayEmpty(parsed.ops)) {
    return HashlineApplyResult.Error({
      message: t(getDocumentLanguage()).hashline.errNoValidCommands,
    })
  }

  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n")
  const originalHashes = Array.map(originalLines, hashLine)
  const validated = Array.map(parsed.ops, (op, opIndex) =>
    opToSplice(op, opIndex, originalLines, originalHashes),
  )
  const validationErrors = Array.flatten(Array.map(validated, (v) => v.errors))
  if (Array.isReadonlyArrayNonEmpty(validationErrors)) {
    return HashlineApplyResult.Error({ message: validationErrors.join("\n") })
  }

  const splices = Array.getSomes(Array.map(validated, (v) => v.splice))
  const overlapErrors = Array.flatten(
    Array.map(splices, (a, idxA) =>
      Array.getSomes(
        Array.map(splices, (b, idxB) => {
          if (idxB <= idxA) {
            return Option.none()
          }
          return splicesOverlap(a, b)
            ? Option.some(
                t(getDocumentLanguage()).hashline.errOverlap(a.description, b.description),
              )
            : Option.none()
        }),
      ),
    ),
  )

  if (Array.isReadonlyArrayNonEmpty(overlapErrors)) {
    return HashlineApplyResult.Error({ message: overlapErrors.join("\n") })
  }

  const sortedDescending = Array.sort(splices, Order.flip(ascendingSpliceOrder))

  const nextLines = Array.reduce(
    sortedDescending,
    originalLines as ReadonlyArray<string>,
    (lines, splice) => [
      ...lines.slice(0, splice.index),
      ...splice.insertLines,
      ...lines.slice(splice.index + splice.deleteCount),
    ],
  )

  const sortedAscending = Array.sort(splices, ascendingSpliceOrder)
  const changedHunks = Array.reduce(
    sortedAscending,
    { offset: 0, hunks: [] as ReadonlyArray<string> },
    (state, splice) => {
      const newStart = splice.index + state.offset
      const hunk = Array.isReadonlyArrayNonEmpty(splice.insertLines)
        ? Array.map(
            splice.insertLines,
            (line, i) => `${newStart + i + 1}:${hashLine(line)}|${line}`,
          ).join("\n")
        : t(getDocumentLanguage()).hashline.deletedFromLine(newStart + 1)
      return {
        offset: state.offset + splice.insertLines.length - splice.deleteCount,
        hunks: [...state.hunks, hunk],
      }
    },
  ).hunks

  return HashlineApplyResult.Ok({
    content: nextLines.join("\n"),
    appliedCount: splices.length,
    changedLines: changedHunks.join("\n...\n"),
    notes: parsed.notes,
  })
}
