import { Array, Match, Option, Order, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import {
  HashlineApplyResult,
  applyHashlineEdits,
  formatApiDtsMessage,
  formatFencedHashlineFile,
  formatHashedFileMessage,
  formatHashlineSystemPrompt,
  formatLlmContext as formatHashlineContext,
  formatUpdatedHashlines,
} from "./hashline"

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
  const normalized = raw.replace(/\r\n/g, "\n").trim()
  const lines = normalized.split("\n")
  if (
    lines.length >= 2 &&
    lines[0]?.startsWith("```") &&
    lines[lines.length - 1]?.trim() === "```"
  ) {
    return lines.slice(1, -1).join("\n")
  }
  return normalized
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

const SEARCH_REPLACE_INSTRUCTIONS = [
  "- Gib Änderungen als `SEARCH`/`REPLACE`-Blöcke an.",
  "- Der `SEARCH`-Teil muss exakt (inkl. Einrückung) in der Datei vorkommen und eindeutig sein.",
  "- Gib nur die geänderten Stellen aus, nicht die ganze Datei.",
  "",
  "Beispiel:",
  "```",
  "<<<<<<< SEARCH",
  "  <p>Alter Text</p>",
  "=======",
  "  <p>Neuer Text</p>",
  ">>>>>>> REPLACE",
  "```",
]

const UNIFIED_DIFF_INSTRUCTIONS = [
  "- Jeder Block beginnt mit `@@` (Zeilennummern sind optional).",
  "- Unveränderte Kontextzeilen beginnen mit einem Leerzeichen (` `).",
  "- Entfernte Zeilen beginnen mit `-`, hinzugefügte Zeilen mit `+`.",
  "- Gib nur die geänderten Stellen mit genug Kontextzeilen aus, nicht die ganze Datei.",
  "",
  "Beispiel:",
  "```diff",
  "@@",
  " <main>",
  "-  <p>Alter Text</p>",
  "+  <p>Neuer Text</p>",
  " </main>",
  "```",
]

export const formatSystemPromptForFormat = (format: EditFormat, useToolCalls = true): string =>
  Match.value(format).pipe(
    Match.when("hashline", () => formatHashlineSystemPrompt(useToolCalls)),
    Match.when("search-replace", () =>
      [
        "## Anleitung für die Antwort (Search & Replace)",
        "",
        useToolCalls
          ? "Verwende für Änderungen an der Datei das Werkzeug `edit` mit `SEARCH`/`REPLACE`-Blöcken:"
          : "Antworte **nur** mit einem Markdown-Codeblock mit folgenden `SEARCH`/`REPLACE`-Blöcken:",
        "",
        ...SEARCH_REPLACE_INSTRUCTIONS,
      ].join("\n"),
    ),
    Match.when("unified-diff", () =>
      [
        "## Anleitung für die Antwort (Vereinfachter Unified Diff)",
        "",
        useToolCalls
          ? "Verwende für Änderungen an der Datei das Werkzeug `edit` mit einem vereinfachten Unified Diff:"
          : "Antworte **nur** mit einem Markdown-Codeblock (` ```diff `) im vereinfachten Unified-Diff-Format:",
        "",
        ...UNIFIED_DIFF_INSTRUCTIONS,
      ].join("\n"),
    ),
    Match.exhaustive,
  )

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
        ...SEARCH_REPLACE_INSTRUCTIONS,
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
        ...UNIFIED_DIFF_INSTRUCTIONS,
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
  readonly search: string
  readonly replace: string
}

type SearchReplaceParseState =
  | { readonly _tag: "Outside"; readonly blocks: ReadonlyArray<SearchReplaceBlock> }
  | {
      readonly _tag: "InSearch"
      readonly blocks: ReadonlyArray<SearchReplaceBlock>
      readonly searchLines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "InReplace"
      readonly blocks: ReadonlyArray<SearchReplaceBlock>
      readonly searchLines: ReadonlyArray<string>
      readonly replaceLines: ReadonlyArray<string>
    }

const parseSearchReplaceBlocks = (
  raw: string,
):
  | { readonly _tag: "Ok"; readonly blocks: ReadonlyArray<SearchReplaceBlock> }
  | { readonly _tag: "Error"; readonly message: string } => {
  const cleaned = stripOuterMarkdownFence(raw)
  if (cleaned === "") {
    return { _tag: "Error", message: "Keine SEARCH/REPLACE-Blöcke gefunden." }
  }

  const lines = cleaned.split("\n")
  const finalState = Array.reduce<string, SearchReplaceParseState>(
    lines,
    { _tag: "Outside", blocks: [] },
    (state, line): SearchReplaceParseState => {
      const trimmed = line.trim()
      if (state._tag === "Outside") {
        if (trimmed === "<<<<<<< SEARCH") {
          return { _tag: "InSearch", blocks: state.blocks, searchLines: [] }
        }
        return state
      }
      if (state._tag === "InSearch") {
        if (trimmed === "=======") {
          return {
            _tag: "InReplace",
            blocks: state.blocks,
            searchLines: state.searchLines,
            replaceLines: [],
          }
        }
        return {
          ...state,
          searchLines: [...state.searchLines, line],
        }
      }
      if (trimmed === ">>>>>>> REPLACE") {
        return {
          _tag: "Outside",
          blocks: [
            ...state.blocks,
            {
              search: state.searchLines.join("\n"),
              replace: state.replaceLines.join("\n"),
            },
          ],
        }
      }
      return {
        ...state,
        replaceLines: [...state.replaceLines, line],
      }
    },
  )

  if (finalState._tag !== "Outside") {
    return {
      _tag: "Error",
      message: "Unvollständiger SEARCH/REPLACE-Block (erwartet ======= und >>>>>>> REPLACE).",
    }
  }
  if (Array.isReadonlyArrayEmpty(finalState.blocks)) {
    return { _tag: "Error", message: "Keine SEARCH/REPLACE-Blöcke gefunden." }
  }
  return { _tag: "Ok", blocks: finalState.blocks }
}

const findAllSubstringIndices = (haystack: string, needle: string): ReadonlyArray<number> => {
  const collect = (fromIndex: number, acc: ReadonlyArray<number>): ReadonlyArray<number> => {
    const idx = haystack.indexOf(needle, fromIndex)
    if (idx === -1) {
      return acc
    }
    return collect(idx + Math.max(1, needle.length), [...acc, idx])
  }
  return collect(0, [])
}

export const applySearchReplaceEdits = (
  originalContent: string,
  editsText: string,
): EditApplyResult => {
  const parsed = parseSearchReplaceBlocks(editsText)
  if (parsed._tag === "Error") {
    return EditApplyResult.Error({ message: parsed.message })
  }

  const initialContent = originalContent.replace(/\r\n/g, "\n")

  const applyStep = (content: string, index: number): EditApplyResult => {
    if (index >= parsed.blocks.length) {
      return EditApplyResult.Ok({
        content,
        appliedCount: parsed.blocks.length,
        updatedSnippet: "",
      })
    }

    const block = parsed.blocks[index]
    if (!block) {
      return EditApplyResult.Error({ message: "Interner Fehler beim Lesen der Blöcke." })
    }

    if (block.search === "") {
      if (content === "") {
        return applyStep(block.replace, index + 1)
      }
      return EditApplyResult.Error({
        message: `SEARCH-Block ${index + 1} darf bei nicht-leerer Datei nicht leer sein.`,
      })
    }

    const matches = findAllSubstringIndices(content, block.search)
    if (Array.isReadonlyArrayEmpty(matches)) {
      const preview = block.search.split("\n")[0]?.trim() ?? ""
      return EditApplyResult.Error({
        message: `SEARCH-Block ${index + 1} nicht gefunden (${preview.slice(0, 60)}).`,
      })
    }
    if (matches.length > 1) {
      return EditApplyResult.Error({
        message: `SEARCH-Block ${index + 1} ist mehrdeutig (${matches.length} Treffer) – bitte mehr Kontextzeilen angeben.`,
      })
    }

    const matchIndex = matches[0]
    if (matchIndex === undefined) {
      return EditApplyResult.Error({ message: "Interner Fehler beim Ersetzen." })
    }
    const nextContent =
      content.slice(0, matchIndex) + block.replace + content.slice(matchIndex + block.search.length)
    return applyStep(nextContent, index + 1)
  }

  return applyStep(initialContent, 0)
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
    return { _tag: "Error", message: "Kein Unified Diff gefunden." }
  }

  const lines = cleaned.split("\n")
  const parsedState = Array.reduce(
    lines,
    {
      hunks: [] as ReadonlyArray<DiffHunk>,
      current: Option.none<DiffHunk>(),
      hasError: Option.none<string>(),
    },
    (state, line) => {
      if (Option.isSome(state.hasError)) {
        return state
      }
      if (Option.isNone(state.current) && (line.startsWith("--- ") || line.startsWith("+++ "))) {
        return state
      }
      if (line.trim().startsWith("@@")) {
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

      return Option.match(state.current, {
        onNone: () =>
          line.trim() === ""
            ? state
            : {
                ...state,
                hasError: Option.some(
                  `Unerwartete Diff-Zeile außerhalb eines @@-Blocks: "${line}"`,
                ),
              },
        onSome: (hunk) => {
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
          return {
            ...state,
            hasError: Option.some(`Ungültige Diff-Zeile (erwartet ' ', '-' oder '+'): "${line}"`),
          }
        },
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
    return { _tag: "Error", message: "Keine @@-Hunks im Unified Diff gefunden." }
  }

  return { _tag: "Ok", hunks: allHunks }
}

const findLineSliceMatches = (
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
): ReadonlyArray<number> => {
  if (needle.length === 0 || needle.length > haystack.length) {
    return []
  }
  const maxStart = haystack.length - needle.length
  return Array.flatMap(
    Array.makeBy(maxStart + 1, (i) => i),
    (startIdx) => {
      const matchesAll = Array.every(needle, (line, offset) => haystack[startIdx + offset] === line)
      return matchesAll ? [startIdx] : []
    },
  )
}

const pickUniqueClosestMatch = (
  matches: ReadonlyArray<number>,
  maybeHintLine: Option.Option<number>,
): Option.Option<number> => {
  if (matches.length === 1 && matches[0] !== undefined) {
    return Option.some(matches[0])
  }
  return Option.match(maybeHintLine, {
    onNone: () => Option.none(),
    onSome: (hintLine) => {
      const target = Math.max(0, hintLine - 1)
      const byDistance = Order.mapInput(Order.Number, (n: number) => Math.abs(n - target))
      const sorted = Array.sort(matches, byDistance)
      const first = sorted[0]
      const second = sorted[1]
      if (first === undefined) {
        return Option.none()
      }
      if (second !== undefined && Math.abs(first - target) === Math.abs(second - target)) {
        return Option.none()
      }
      return Option.some(first)
    },
  })
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

  const applyStep = (currentLines: ReadonlyArray<string>, index: number): EditApplyResult => {
    if (index >= parsed.hunks.length) {
      return EditApplyResult.Ok({
        content: currentLines.join("\n"),
        appliedCount: parsed.hunks.length,
        updatedSnippet: "",
      })
    }

    const hunk = parsed.hunks[index]
    if (!hunk) {
      return EditApplyResult.Error({ message: "Interner Fehler beim Lesen des Diffs." })
    }

    if (Array.isReadonlyArrayEmpty(hunk.searchLines)) {
      if (currentLines.length === 1 && currentLines[0] === "") {
        return applyStep(hunk.replaceLines, index + 1)
      }
      return EditApplyResult.Error({
        message: `Diff-Hunk ${index + 1} hat keine Kontext- oder Löschzeilen zum Zuordnen.`,
      })
    }

    const matches = findLineSliceMatches(currentLines, hunk.searchLines)
    if (Array.isReadonlyArrayEmpty(matches)) {
      return EditApplyResult.Error({
        message: `Diff-Hunk ${index + 1} konnte nicht zugeordnet werden.`,
      })
    }

    const maybeMatchIndex = pickUniqueClosestMatch(matches, hunk.maybeHintLine)
    return Option.match(maybeMatchIndex, {
      onNone: () =>
        EditApplyResult.Error({
          message: `Diff-Hunk ${index + 1} ist mehrdeutig (${matches.length} Treffer) – bitte mehr Kontextzeilen angeben.`,
        }),
      onSome: (matchIndex) => {
        const nextLines = [
          ...currentLines.slice(0, matchIndex),
          ...hunk.replaceLines,
          ...currentLines.slice(matchIndex + hunk.searchLines.length),
        ]
        return applyStep(nextLines, index + 1)
      },
    })
  }

  return applyStep(initialLines, 0)
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
