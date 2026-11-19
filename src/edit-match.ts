import { Array, Option, Order } from "effect"
import { getDocumentLanguage, t } from "./i18n"

export const extractFencedLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
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

export interface LineEditBlock {
  readonly label: string
  readonly notFoundText: string
  readonly missingContextText: string
  readonly searchLines: ReadonlyArray<string>
  readonly replaceLines: ReadonlyArray<string>
  readonly maybeHintLine: Option.Option<number>
  readonly maybeInsertIndex: Option.Option<number>
  readonly maybeExactText: Option.Option<{ readonly search: string; readonly replace: string }>
}

export interface ChangedRegion {
  readonly start: number
  readonly length: number
}

export type LineEditsResult =
  | {
      readonly _tag: "Ok"
      readonly lines: ReadonlyArray<string>
      readonly appliedCount: number
      readonly regions: ReadonlyArray<ChangedRegion>
      readonly notes: ReadonlyArray<string>
    }
  | { readonly _tag: "Error"; readonly errors: ReadonlyArray<string> }

type BlockOutcome =
  | {
      readonly _tag: "Applied"
      readonly lines: ReadonlyArray<string>
      readonly start: number
      readonly deleteCount: number
      readonly insertCount: number
      readonly maybeNote: Option.Option<string>
    }
  | { readonly _tag: "Unchanged"; readonly note: string }
  | { readonly _tag: "Failed"; readonly error: string }

interface MatchStrategy {
  readonly normalize: (line: string) => string
  readonly maybeNote: Option.Option<string>
  readonly reindents: boolean
}

const getMatchStrategies = (): ReadonlyArray<MatchStrategy> => {
  const em = t(getDocumentLanguage()).editMatch
  return [
    { normalize: (line) => line, maybeNote: Option.none(), reindents: false },
    {
      normalize: (line) => line.trimEnd(),
      maybeNote: Option.some(em.noteTrailingWhitespace),
      reindents: false,
    },
    {
      normalize: (line) => line.trim(),
      maybeNote: Option.some(em.noteIndentAdjusted),
      reindents: true,
    },
    {
      normalize: (line) => line.replace(/\s+/g, " ").trim(),
      maybeNote: Option.some(em.noteInnerWhitespace),
      reindents: true,
    },
  ]
}

const MAX_PREVIEW_CHARS = 160
const MAX_REGION_PREVIEW_LINES = 12
const MAX_LISTED_MATCHES = 10

export const previewLine = (line: string): string =>
  line.length > MAX_PREVIEW_CHARS ? `${line.slice(0, MAX_PREVIEW_CHARS)}…` : line

const isBlank = (line: string): boolean => line.trim() === ""

const leadingWhitespace = (line: string): string => /^\s*/.exec(line)?.[0] ?? ""

const isEmptyFile = (lines: ReadonlyArray<string>): boolean => lines.length === 1 && lines[0] === ""

interface SearchCandidate {
  readonly searchLines: ReadonlyArray<string>
  readonly replaceLines: ReadonlyArray<string>
  readonly maybeNote: Option.Option<string>
}

const countLeadingBlank = (lines: ReadonlyArray<string>): number => {
  const firstContent = lines.findIndex((line) => !isBlank(line))
  return firstContent === -1 ? lines.length : firstContent
}

const trimBlankEdges = (block: LineEditBlock): Option.Option<SearchCandidate> => {
  const leading = countLeadingBlank(block.searchLines)
  const trailing = countLeadingBlank([...block.searchLines].reverse())
  if ((leading === 0 && trailing === 0) || leading >= block.searchLines.length) {
    return Option.none()
  }
  const replaceLeading = Math.min(leading, countLeadingBlank(block.replaceLines))
  const replaceTrailing = Math.min(
    trailing,
    countLeadingBlank([...block.replaceLines].reverse()),
    Math.max(0, block.replaceLines.length - replaceLeading),
  )
  return Option.some({
    searchLines: block.searchLines.slice(leading, block.searchLines.length - trailing),
    replaceLines: block.replaceLines.slice(
      replaceLeading,
      block.replaceLines.length - replaceTrailing,
    ),
    maybeNote: Option.some(t(getDocumentLanguage()).editMatch.noteTrimmedBlankEdges),
  })
}

const findLineMatches = (
  normalizedFile: ReadonlyArray<string>,
  normalizedSearch: ReadonlyArray<string>,
): ReadonlyArray<number> => {
  if (
    Array.isReadonlyArrayEmpty(normalizedSearch) ||
    normalizedSearch.length > normalizedFile.length
  ) {
    return []
  }
  const firstSearchLine = normalizedSearch[0]
  return Array.filter(
    Array.makeBy(normalizedFile.length - normalizedSearch.length + 1, (start) => start),
    (start) =>
      normalizedFile[start] === firstSearchLine &&
      Array.every(normalizedSearch, (line, offset) => normalizedFile[start + offset] === line),
  )
}

const pickClosestMatch = (
  matches: ReadonlyArray<number>,
  maybeHintIndex: Option.Option<number>,
): Option.Option<number> => {
  if (matches.length === 1) {
    return Option.fromNullishOr(matches[0])
  }
  return Option.flatMap(maybeHintIndex, (hintIndex) => {
    const byDistance = Order.mapInput(Order.Number, (n: number) => Math.abs(n - hintIndex))
    const sorted = Array.sort(matches, byDistance)
    const first = sorted[0]
    const second = sorted[1]
    if (first === undefined) {
      return Option.none()
    }
    if (second !== undefined && Math.abs(first - hintIndex) === Math.abs(second - hintIndex)) {
      return Option.none()
    }
    return Option.some(first)
  })
}

const reindentReplaceLines = (
  replaceLines: ReadonlyArray<string>,
  searchLines: ReadonlyArray<string>,
  fileLines: ReadonlyArray<string>,
  matchStart: number,
): ReadonlyArray<string> => {
  const anchorOffset = searchLines.findIndex((line) => !isBlank(line))
  if (anchorOffset === -1) {
    return replaceLines
  }
  const searchIndent = leadingWhitespace(searchLines[anchorOffset] ?? "")
  const fileIndent = leadingWhitespace(fileLines[matchStart + anchorOffset] ?? "")
  if (searchIndent === fileIndent) {
    return replaceLines
  }
  if (fileIndent.startsWith(searchIndent)) {
    const extra = fileIndent.slice(searchIndent.length)
    return Array.map(replaceLines, (line) => (isBlank(line) ? line : extra + line))
  }
  if (searchIndent.startsWith(fileIndent)) {
    const surplus = searchIndent.slice(fileIndent.length)
    return Array.map(replaceLines, (line) =>
      line.startsWith(surplus) ? line.slice(surplus.length) : line,
    )
  }
  return replaceLines
}

const formatLineNumbers = (indices: ReadonlyArray<number>): string => {
  const unique = Array.dedupe(indices)
  const listed = unique
    .slice(0, MAX_LISTED_MATCHES)
    .map((index) => String(index + 1))
    .join(", ")
  return unique.length > MAX_LISTED_MATCHES ? `${listed}, …` : listed
}

const formatNumbered = (fileLines: ReadonlyArray<string>, start: number, count: number): string =>
  Array.makeBy(Math.min(count, MAX_REGION_PREVIEW_LINES), (offset) => {
    const index = start + offset
    return `    ${index + 1}: ${previewLine(fileLines[index] ?? "")}`
  })
    .concat(count > MAX_REGION_PREVIEW_LINES ? ["    …"] : [])
    .join("\n")

export const describeClosestRegion = (
  fileLines: ReadonlyArray<string>,
  searchLines: ReadonlyArray<string>,
): Option.Option<string> => {
  const trimmedFile = Array.map(fileLines, (line) => line.trim())
  const trimmedSearch = Array.map(searchLines, (line) => line.trim())
  const contentCount = trimmedSearch.filter((line) => line !== "").length
  if (contentCount === 0) {
    return Option.none()
  }
  const windowCount = Math.max(1, fileLines.length - searchLines.length + 1)
  const scoreAt = (start: number): number =>
    trimmedSearch.reduce(
      (score, line, offset) =>
        line !== "" && trimmedFile[start + offset] === line ? score + 1 : score,
      0,
    )
  const best = Array.reduce(
    Array.makeBy(windowCount, (start) => start),
    { start: 0, score: 0 },
    (acc, start) => {
      const score = scoreAt(start)
      return score > acc.score ? { start, score } : acc
    },
  )
  if (best.score === 0) {
    return Option.none()
  }
  const regionLength = Math.min(searchLines.length, fileLines.length - best.start)
  const firstDiffOffset = searchLines.findIndex(
    (line, offset) => (fileLines[best.start + offset] ?? "").trimEnd() !== line.trimEnd(),
  )
  const differenceText =
    firstDiffOffset === -1
      ? ""
      : (() => {
          const expected = searchLines[firstDiffOffset] ?? ""
          const maybeActual = Option.fromNullishOr(fileLines[best.start + firstDiffOffset])
          const onlyWhitespace = Option.match(maybeActual, {
            onNone: () => false,
            onSome: (actual) =>
              actual.replace(/\s+/g, "") === expected.replace(/\s+/g, "") && actual !== expected,
          })
          const em = t(getDocumentLanguage()).editMatch
          return [
            em.firstDiffLine(firstDiffOffset + 1, onlyWhitespace),
            em.expectedLine(previewLine(expected)),
            Option.match(maybeActual, {
              onNone: () => em.fileEof,
              onSome: (actual) =>
                em.fileActualLine(previewLine(actual), best.start + firstDiffOffset + 1),
            }),
          ].join("\n")
        })()
  return Option.some(
    [
      t(getDocumentLanguage()).editMatch.closestRegion(
        best.start + 1,
        best.start + regionLength,
        best.score,
        contentCount,
      ),
      formatNumbered(fileLines, best.start, regionLength),
      differenceText,
    ]
      .filter((part) => part !== "")
      .join("\n"),
  )
}

const notFoundError = (
  block: LineEditBlock,
  fileLines: ReadonlyArray<string>,
  notFoundText: string,
): string => {
  const em = t(getDocumentLanguage()).editMatch
  const firstContentLine = block.searchLines.find((line) => !isBlank(line)) ?? ""
  const hint = Option.match(describeClosestRegion(fileLines, block.searchLines), {
    onNone: () => em.noSimilarRegion,
    onSome: (text) => text,
  })
  return [
    `${block.label} ${notFoundText}`,
    em.searchedLines(block.searchLines.length, previewLine(firstContentLine)),
    hint,
  ].join("\n")
}

const applyBlock = (
  lines: ReadonlyArray<string>,
  block: LineEditBlock,
  hintOffset: number,
): BlockOutcome => {
  const maybeHintIndex = Option.map(block.maybeHintLine, (line) =>
    Math.max(0, line - 1 + hintOffset),
  )
  const replaceAt = (
    start: number,
    deleteCount: number,
    replaceLines: ReadonlyArray<string>,
    maybeNote: Option.Option<string>,
  ): BlockOutcome => ({
    _tag: "Applied",
    lines: [...lines.slice(0, start), ...replaceLines, ...lines.slice(start + deleteCount)],
    start,
    deleteCount,
    insertCount: replaceLines.length,
    maybeNote: Option.map(maybeNote, (note) => `${block.label}: ${note}.`),
  })

  if (
    Array.isReadonlyArrayNonEmpty(block.searchLines) &&
    block.searchLines.length === block.replaceLines.length &&
    Array.every(block.searchLines, (line, index) => block.replaceLines[index] === line)
  ) {
    return {
      _tag: "Unchanged",
      note: t(getDocumentLanguage()).editMatch.identicalSearchReplace(block.label),
    }
  }

  if (Array.isReadonlyArrayEmpty(block.searchLines)) {
    if (isEmptyFile(lines)) {
      return replaceAt(0, 1, block.replaceLines, Option.none())
    }
    return Option.match(block.maybeInsertIndex, {
      onNone: () => ({
        _tag: "Failed",
        error: `${block.label} ${block.missingContextText}`,
      }),
      onSome: (insertIndex) => {
        const index = Math.min(lines.length, Math.max(0, insertIndex + hintOffset))
        return replaceAt(
          index,
          0,
          block.replaceLines,
          Option.some(t(getDocumentLanguage()).editMatch.insertedWithoutContext(index + 1)),
        )
      },
    })
  }

  const exactTextOutcome = Option.flatMap(
    block.maybeExactText,
    ({ search, replace }): Option.Option<BlockOutcome> => {
      const content = lines.join("\n")
      const step = Math.max(1, search.length)
      const charIndices = Array.unfold(content.indexOf(search), (fromIndex) =>
        fromIndex === -1
          ? Option.none()
          : Option.some([fromIndex, content.indexOf(search, fromIndex + step)] as const),
      )
      if (Array.isReadonlyArrayEmpty(charIndices)) {
        return Option.none()
      }
      const lineIndexAt = (charIndex: number): number =>
        content.slice(0, charIndex).split("\n").length - 1
      const lineIndices = Array.map(charIndices, lineIndexAt)
      const maybePickedLine = pickClosestMatch(lineIndices, maybeHintIndex)
      return Option.match(maybePickedLine, {
        onNone: () =>
          Option.some<BlockOutcome>({
            _tag: "Failed",
            error: t(getDocumentLanguage()).editMatch.ambiguousMatch(
              block.label,
              charIndices.length,
              formatLineNumbers(lineIndices),
            ),
          }),
        onSome: (pickedLine) => {
          const charIndex = charIndices[lineIndices.indexOf(pickedLine)] ?? 0
          const nextContent =
            content.slice(0, charIndex) + replace + content.slice(charIndex + search.length)
          const nextLines = nextContent.split("\n")
          const searchLineCount = search.split("\n").length
          return Option.some<BlockOutcome>({
            _tag: "Applied",
            lines: nextLines,
            start: pickedLine,
            deleteCount: searchLineCount,
            insertCount: searchLineCount + nextLines.length - lines.length,
            maybeNote: Option.none(),
          })
        },
      })
    },
  )
  if (Option.isSome(exactTextOutcome)) {
    return exactTextOutcome.value
  }

  const candidates: ReadonlyArray<SearchCandidate> = [
    { searchLines: block.searchLines, replaceLines: block.replaceLines, maybeNote: Option.none() },
    ...Option.toArray(trimBlankEdges(block)),
  ]

  const attempts = Array.flatMap(getMatchStrategies(), (strategy) =>
    Array.map(candidates, (candidate) => ({ strategy, candidate })),
  )

  const normalizedFileCache = new Map<MatchStrategy, ReadonlyArray<string>>()
  const normalizedFileFor = (strategy: MatchStrategy): ReadonlyArray<string> => {
    const cached = normalizedFileCache.get(strategy)
    if (cached) {
      return cached
    }
    const normalized = Array.map(lines, strategy.normalize)
    normalizedFileCache.set(strategy, normalized)
    return normalized
  }

  const maybeFirstHit = Array.findFirst(attempts, ({ strategy, candidate }) => {
    const matches = findLineMatches(
      normalizedFileFor(strategy),
      Array.map(candidate.searchLines, strategy.normalize),
    )
    return Array.isReadonlyArrayNonEmpty(matches)
      ? Option.some({ strategy, candidate, matches })
      : Option.none()
  })

  return Option.match(maybeFirstHit, {
    onNone: () => ({
      _tag: "Failed",
      error: notFoundError(block, lines, block.notFoundText),
    }),
    onSome: ({ strategy, candidate, matches }) =>
      Option.match(pickClosestMatch(matches, maybeHintIndex), {
        onNone: () => ({
          _tag: "Failed",
          error: t(getDocumentLanguage()).editMatch.ambiguousMatch(
            block.label,
            matches.length,
            formatLineNumbers(matches),
          ),
        }),
        onSome: (start) => {
          const replaceLines = strategy.reindents
            ? reindentReplaceLines(candidate.replaceLines, candidate.searchLines, lines, start)
            : candidate.replaceLines
          const notes = [
            ...Option.toArray(candidate.maybeNote),
            ...Option.toArray(strategy.maybeNote),
          ]
          return replaceAt(
            start,
            candidate.searchLines.length,
            replaceLines,
            Array.isReadonlyArrayNonEmpty(notes) ? Option.some(notes.join(", ")) : Option.none(),
          )
        },
      }),
  })
}

const shiftRegions = (
  regions: ReadonlyArray<ChangedRegion>,
  start: number,
  deleteCount: number,
  insertCount: number,
): ReadonlyArray<ChangedRegion> => {
  const delta = insertCount - deleteCount
  const shifted = Array.flatMap(regions, (region): ReadonlyArray<ChangedRegion> => {
    if (region.start >= start + deleteCount) {
      return [{ start: region.start + delta, length: region.length }]
    }
    if (region.start + region.length <= start) {
      return [region]
    }
    return []
  })
  return [...shifted, { start, length: insertCount }]
}

export const applyLineEditBlocks = (
  originalLines: ReadonlyArray<string>,
  blocks: ReadonlyArray<LineEditBlock>,
): LineEditsResult => {
  const finalState = Array.reduce(
    blocks,
    {
      lines: originalLines,
      hintOffset: 0,
      appliedCount: 0,
      regions: [] as ReadonlyArray<ChangedRegion>,
      notes: [] as ReadonlyArray<string>,
      errors: [] as ReadonlyArray<string>,
    },
    (state, block) => {
      const outcome = applyBlock(state.lines, block, state.hintOffset)
      if (outcome._tag === "Failed") {
        return { ...state, errors: [...state.errors, outcome.error] }
      }
      if (outcome._tag === "Unchanged") {
        return { ...state, notes: [...state.notes, outcome.note] }
      }
      return {
        lines: outcome.lines,
        hintOffset: state.hintOffset + outcome.insertCount - outcome.deleteCount,
        appliedCount: state.appliedCount + 1,
        regions: shiftRegions(
          state.regions,
          outcome.start,
          outcome.deleteCount,
          outcome.insertCount,
        ),
        notes: [...state.notes, ...Option.toArray(outcome.maybeNote)],
        errors: state.errors,
      }
    },
  )

  if (Array.isReadonlyArrayNonEmpty(finalState.errors)) {
    const failedCount = finalState.errors.length
    const summary =
      blocks.length > 1
        ? [
            t(getDocumentLanguage()).editMatch.blocksFailedSummary(
              failedCount,
              blocks.length,
              finalState.appliedCount,
            ),
          ]
        : []
    return { _tag: "Error", errors: [...finalState.errors, ...summary] }
  }

  if (finalState.appliedCount === 0) {
    return {
      _tag: "Error",
      errors: [...finalState.notes, t(getDocumentLanguage()).editMatch.noChangeAllIdentical],
    }
  }

  const byStart = Order.mapInput(Order.Number, (region: ChangedRegion) => region.start)
  return {
    _tag: "Ok",
    lines: finalState.lines,
    appliedCount: finalState.appliedCount,
    regions: Array.sort(finalState.regions, byStart),
    notes: finalState.notes,
  }
}
