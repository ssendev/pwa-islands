import { Array, Match, Option, Order, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"

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

export const formatLlmContext = (fileName: string, content: string, apiDts: string): string => {
  const trimmedDts = apiDts.trimEnd()

  return [
    "## Anleitung für die Antwort (Hash-Anchored Line Edits)",
    "",
    "Die zu bearbeitende Datei ist im Format `ZEILE:HASH|INHALT` angegeben.",
    "Antworte **nur** mit einem Markdown-Codeblock (` ```hashline `) mit folgenden Befehlen:",
    "",
    "- `REPLACE <zeile>:<hash>` oder `REPLACE <start>:<hash>..<ende>:<hash>` (gefolgt von den neuen Zeilen und `END`)",
    "- `INSERT_AFTER <zeile>:<hash>` (gefolgt von den neuen Zeilen und `END`)",
    "- `INSERT_BEFORE <zeile>:<hash>` (gefolgt von den neuen Zeilen und `END`)",
    "- `DELETE <zeile>:<hash>` oder `DELETE <start>:<hash>..<ende>:<hash>`",
    "",
    "Wichtig:",
    "- Gib nur die geänderten Stellen aus, nicht die ganze Datei.",
    "- Schreibe in den neuen Zeilen **keine** `ZEILE:HASH|`-Präfixe.",
    "- Verwende exakt die Zeilennummern und Hashes aus der Datei unten.",
    "",
    "Beispiel:",
    "```hashline",
    "REPLACE 12:a3f..13:b4c",
    "  <p>Neuer Text</p>",
    "END",
    "INSERT_AFTER 20:c1d",
    "  <script>console.log('ok')</script>",
    "END",
    "DELETE 30:e2f",
    "```",
    "",
    "## /api.d.ts",
    "",
    "```ts",
    trimmedDts,
    "```",
    "",
    `## Datei: \`${fileName}\``,
    "",
    formatFencedHashlineFile(fileName, content),
  ].join("\n")
}

export const formatUpdatedHashlines = (fileName: string, changedLines: string): string =>
  [
    `Änderungen angewendet. Geänderte Zeilen in \`${fileName}\`:`,
    "",
    "```",
    changedLines,
    "```",
  ].join("\n") + "\n\n"

export const HashlineApplyResult = defineTaggedUnion({
  Ok: {
    content: Schema.String,
    appliedCount: Schema.Number,
    changedLines: Schema.String,
  },
  Error: {
    message: Schema.String,
  },
})
export type HashlineApplyResult = typeof HashlineApplyResult.Type

interface LineAnchor {
  readonly line: number
  readonly hash: string
}

type EditOp =
  | {
      readonly _tag: "Replace"
      readonly start: LineAnchor
      readonly end: LineAnchor
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "InsertAfter"
      readonly anchor: LineAnchor
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "InsertBefore"
      readonly anchor: LineAnchor
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "Delete"
      readonly start: LineAnchor
      readonly end: LineAnchor
    }

const ANCHOR_PATTERN = /^(\d+):([0-9a-fA-F]{2,8})$/
const COMMAND_PATTERN = /^(REPLACE|INSERT_AFTER|INSERT_BEFORE|DELETE)\s+(.+)$/i

const parseAnchor = (raw: string): Option.Option<LineAnchor> => {
  const match = ANCHOR_PATTERN.exec(raw.trim())
  if (!match) {
    return Option.none()
  }
  const line = Number(match[1])
  if (!Number.isInteger(line) || line < 1) {
    return Option.none()
  }
  return Option.some({
    line,
    hash: match[2].toLowerCase(),
  })
}

const parseRange = (
  raw: string,
): Option.Option<{ readonly start: LineAnchor; readonly end: LineAnchor }> => {
  const parts = raw.trim().split("..")
  if (parts.length === 1) {
    return Option.map(parseAnchor(parts[0]), (anchor) => ({ start: anchor, end: anchor }))
  }
  if (parts.length === 2) {
    const maybeStart = parseAnchor(parts[0])
    const maybeEnd = parseAnchor(parts[1])
    if (Option.isSome(maybeStart) && Option.isSome(maybeEnd)) {
      return Option.some({ start: maybeStart.value, end: maybeEnd.value })
    }
  }
  return Option.none()
}

const extractFencedLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  interface FenceState {
    readonly inFence: boolean
    readonly currentBlock: ReadonlyArray<string>
    readonly blocks: ReadonlyArray<ReadonlyArray<string>>
  }

  const finalState = Array.reduce(
    lines,
    { inFence: false, currentBlock: [], blocks: [] } as FenceState,
    (state, line) => {
      const trimmed = line.trim()
      if (!state.inFence) {
        if (trimmed.startsWith("```")) {
          return { ...state, inFence: true, currentBlock: [] }
        }
        return state
      }
      if (trimmed === "```") {
        return {
          inFence: false,
          currentBlock: [],
          blocks: [...state.blocks, state.currentBlock],
        }
      }
      return {
        ...state,
        currentBlock: [...state.currentBlock, line],
      }
    },
  )

  if (Array.isReadonlyArrayNonEmpty(finalState.blocks)) {
    return Array.flatten(finalState.blocks)
  }
  return lines
}

type ParseState =
  | {
      readonly _tag: "Idle"
      readonly ops: ReadonlyArray<EditOp>
      readonly errors: ReadonlyArray<string>
    }
  | {
      readonly _tag: "Collecting"
      readonly kind: "REPLACE" | "INSERT_AFTER" | "INSERT_BEFORE"
      readonly start: LineAnchor
      readonly end: LineAnchor
      readonly buffer: ReadonlyArray<string>
      readonly ops: ReadonlyArray<EditOp>
      readonly errors: ReadonlyArray<string>
    }

const initialParseState: ParseState = { _tag: "Idle", ops: [], errors: [] }

const parseEditOps = (
  rawText: string,
): { readonly ops: ReadonlyArray<EditOp>; readonly errors: ReadonlyArray<string> } => {
  const normalized = rawText.replace(/\r\n/g, "\n")
  const candidateLines = extractFencedLines(normalized.split("\n"))

  const finalState = Array.reduce(candidateLines, initialParseState, (state, line): ParseState => {
    if (state._tag === "Collecting") {
      if (line.trim() === "END") {
        const newOp: EditOp =
          state.kind === "REPLACE"
            ? { _tag: "Replace", start: state.start, end: state.end, lines: state.buffer }
            : state.kind === "INSERT_AFTER"
              ? { _tag: "InsertAfter", anchor: state.start, lines: state.buffer }
              : { _tag: "InsertBefore", anchor: state.start, lines: state.buffer }
        return {
          _tag: "Idle",
          ops: [...state.ops, newOp],
          errors: state.errors,
        }
      }
      return {
        ...state,
        buffer: [...state.buffer, line],
      }
    }

    const trimmed = line.trim()
    if (trimmed === "") {
      return state
    }

    const cmdMatch = COMMAND_PATTERN.exec(trimmed)
    if (!cmdMatch) {
      return {
        ...state,
        errors: [...state.errors, `Unbekannter Befehl: „${trimmed}“`],
      }
    }

    const keyword = cmdMatch[1].toUpperCase()
    const target = cmdMatch[2]

    if (keyword === "DELETE") {
      return Option.match(parseRange(target), {
        onNone: () => ({
          ...state,
          errors: [...state.errors, `Ungültige Zielangabe bei DELETE: „${target}“`],
        }),
        onSome: ({ start, end }) => ({
          ...state,
          ops: [...state.ops, { _tag: "Delete", start, end }],
        }),
      })
    }

    if (keyword === "REPLACE") {
      return Option.match(parseRange(target), {
        onNone: () => ({
          ...state,
          errors: [...state.errors, `Ungültige Zielangabe bei REPLACE: „${target}“`],
        }),
        onSome: ({ start, end }) => ({
          _tag: "Collecting",
          kind: "REPLACE",
          start,
          end,
          buffer: [],
          ops: state.ops,
          errors: state.errors,
        }),
      })
    }

    if (keyword === "INSERT_AFTER" || keyword === "INSERT_BEFORE") {
      return Option.match(parseAnchor(target), {
        onNone: () => ({
          ...state,
          errors: [...state.errors, `Ungültiger Anker bei ${keyword}: „${target}“`],
        }),
        onSome: (anchor) => ({
          _tag: "Collecting",
          kind: keyword,
          start: anchor,
          end: anchor,
          buffer: [],
          ops: state.ops,
          errors: state.errors,
        }),
      })
    }

    return state
  })

  if (finalState._tag === "Collecting") {
    return {
      ops: finalState.ops,
      errors: [...finalState.errors, `Unvollständiger ${finalState.kind}-Block: fehlendes END.`],
    }
  }

  return {
    ops: finalState.ops,
    errors: finalState.errors,
  }
}

interface LineSplice {
  readonly index: number
  readonly deleteCount: number
  readonly insertLines: ReadonlyArray<string>
  readonly description: string
}

const validateAnchor = (
  anchor: LineAnchor,
  originalLines: ReadonlyArray<string>,
): Option.Option<string> => {
  if (anchor.line < 1 || anchor.line > originalLines.length) {
    return Option.some(
      `Zeile ${anchor.line} existiert nicht (Datei hat ${originalLines.length} Zeilen).`,
    )
  }
  const actualHash = hashLine(originalLines[anchor.line - 1])
  if (actualHash !== anchor.hash) {
    return Option.some(
      `Zeile ${anchor.line}: Hash stimmt nicht überein (erwartet ${actualHash}, angegeben ${anchor.hash}).`,
    )
  }
  return Option.none()
}

const opToSplice = (
  op: EditOp,
  originalLines: ReadonlyArray<string>,
): {
  readonly splice: Option.Option<LineSplice>
  readonly errors: ReadonlyArray<string>
} =>
  Match.value(op).pipe(
    Match.tag("Replace", (replaceOp) => {
      const errors = Array.getSomes([
        validateAnchor(replaceOp.start, originalLines),
        replaceOp.end.line !== replaceOp.start.line
          ? validateAnchor(replaceOp.end, originalLines)
          : Option.none(),
        replaceOp.start.line > replaceOp.end.line
          ? Option.some(
              `Ungültiger Bereich bei REPLACE: ${replaceOp.start.line}..${replaceOp.end.line}.`,
            )
          : Option.none(),
      ])
      if (Array.isReadonlyArrayNonEmpty(errors)) {
        return { splice: Option.none(), errors }
      }
      return {
        splice: Option.some({
          index: replaceOp.start.line - 1,
          deleteCount: replaceOp.end.line - replaceOp.start.line + 1,
          insertLines: replaceOp.lines,
          description: `REPLACE ${replaceOp.start.line}..${replaceOp.end.line}`,
        }),
        errors: [],
      }
    }),
    Match.tag("Delete", (deleteOp) => {
      const errors = Array.getSomes([
        validateAnchor(deleteOp.start, originalLines),
        deleteOp.end.line !== deleteOp.start.line
          ? validateAnchor(deleteOp.end, originalLines)
          : Option.none(),
        deleteOp.start.line > deleteOp.end.line
          ? Option.some(
              `Ungültiger Bereich bei DELETE: ${deleteOp.start.line}..${deleteOp.end.line}.`,
            )
          : Option.none(),
      ])
      if (Array.isReadonlyArrayNonEmpty(errors)) {
        return { splice: Option.none(), errors }
      }
      return {
        splice: Option.some({
          index: deleteOp.start.line - 1,
          deleteCount: deleteOp.end.line - deleteOp.start.line + 1,
          insertLines: [],
          description: `DELETE ${deleteOp.start.line}..${deleteOp.end.line}`,
        }),
        errors: [],
      }
    }),
    Match.tag("InsertAfter", (insertOp) => {
      const maybeError = validateAnchor(insertOp.anchor, originalLines)
      if (Option.isSome(maybeError)) {
        return { splice: Option.none(), errors: [maybeError.value] }
      }
      return {
        splice: Option.some({
          index: insertOp.anchor.line,
          deleteCount: 0,
          insertLines: insertOp.lines,
          description: `INSERT_AFTER ${insertOp.anchor.line}`,
        }),
        errors: [],
      }
    }),
    Match.tag("InsertBefore", (insertOp) => {
      const maybeError = validateAnchor(insertOp.anchor, originalLines)
      if (Option.isSome(maybeError)) {
        return { splice: Option.none(), errors: [maybeError.value] }
      }
      return {
        splice: Option.some({
          index: insertOp.anchor.line - 1,
          deleteCount: 0,
          insertLines: insertOp.lines,
          description: `INSERT_BEFORE ${insertOp.anchor.line}`,
        }),
        errors: [],
      }
    }),
    Match.exhaustive,
  )

const splicesOverlap = (a: LineSplice, b: LineSplice): boolean => {
  if (a.deleteCount === 0 && b.deleteCount === 0) {
    return a.index === b.index
  }
  if (a.deleteCount === 0) {
    return a.index > b.index && a.index < b.index + b.deleteCount
  }
  if (b.deleteCount === 0) {
    return b.index > a.index && b.index < a.index + a.deleteCount
  }
  return a.index < b.index + b.deleteCount && b.index < a.index + a.deleteCount
}

export const applyHashlineEdits = (
  originalContent: string,
  responseText: string,
): HashlineApplyResult => {
  if (responseText.trim() === "") {
    return HashlineApplyResult.Error({ message: "Die Zwischenablage ist leer." })
  }

  const parsed = parseEditOps(responseText)
  if (Array.isReadonlyArrayNonEmpty(parsed.errors)) {
    return HashlineApplyResult.Error({ message: parsed.errors.join("\n") })
  }
  if (Array.isReadonlyArrayEmpty(parsed.ops)) {
    return HashlineApplyResult.Error({
      message: "Keine gültigen Bearbeitungsbefehle in der Zwischenablage gefunden.",
    })
  }

  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n")
  const validated = Array.map(parsed.ops, (op) => opToSplice(op, originalLines))
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
            ? Option.some(`Überlappende Bearbeitungen: ${a.description} und ${b.description}.`)
            : Option.none()
        }),
      ),
    ),
  )

  if (Array.isReadonlyArrayNonEmpty(overlapErrors)) {
    return HashlineApplyResult.Error({ message: overlapErrors.join("\n") })
  }

  const descendingSpliceOrder: Order.Order<LineSplice> = Order.make((a, b) => {
    if (b.index !== a.index) {
      return b.index < a.index ? -1 : 1
    }
    if (b.deleteCount !== a.deleteCount) {
      return b.deleteCount < a.deleteCount ? -1 : 1
    }
    return 0
  })

  const sortedDescending = Array.sort(splices, descendingSpliceOrder)

  const nextLines = Array.reduce(
    sortedDescending,
    originalLines as ReadonlyArray<string>,
    (lines, splice) => [
      ...lines.slice(0, splice.index),
      ...splice.insertLines,
      ...lines.slice(splice.index + splice.deleteCount),
    ],
  )

  const ascendingSpliceOrder: Order.Order<LineSplice> = Order.make((a, b) => {
    if (a.index !== b.index) {
      return a.index < b.index ? -1 : 1
    }
    if (a.deleteCount !== b.deleteCount) {
      return a.deleteCount < b.deleteCount ? -1 : 1
    }
    return 0
  })

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
        : `// ab Zeile ${newStart + 1} gelöscht`
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
  })
}
