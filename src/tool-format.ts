const unescapePartialJsonString = (raw: string): string => {
  let result = ""
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== "\\") {
      result += ch
      continue
    }
    if (i + 1 >= raw.length) {
      break
    }
    const next = raw[i + 1]
    i += 1
    if (next === "n") {
      result += "\n"
    } else if (next === "r") {
      result += "\r"
    } else if (next === "t") {
      result += "\t"
    } else if (next === "b") {
      result += "\b"
    } else if (next === "f") {
      result += "\f"
    } else if (next === '"' || next === "\\" || next === "/") {
      result += next
    } else if (next === "u") {
      const hex = raw.slice(i + 1, i + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        result += String.fromCharCode(Number.parseInt(hex, 16))
        i += 4
      }
    } else {
      result += next
    }
  }
  return result
}

const readJsonString = (
  input: string,
  startIndex: number,
): { readonly value: string; readonly nextIndex: number; readonly complete: boolean } => {
  let i = startIndex + 1
  let rawInner = ""
  while (i < input.length) {
    const ch = input[i]
    if (ch === "\\") {
      if (i + 1 >= input.length) {
        return {
          value: unescapePartialJsonString(rawInner),
          nextIndex: input.length,
          complete: false,
        }
      }
      rawInner += input.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === '"') {
      return {
        value: unescapePartialJsonString(rawInner),
        nextIndex: i + 1,
        complete: true,
      }
    }
    rawInner += ch
    i += 1
  }
  return {
    value: unescapePartialJsonString(rawInner),
    nextIndex: input.length,
    complete: false,
  }
}

const findMatchingDelimiter = (input: string, startIndex: number): number => {
  const openChar = input[startIndex]
  const closeChar = openChar === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  for (let i = startIndex; i < input.length; i += 1) {
    const ch = input[i]
    if (inString) {
      if (ch === "\\") {
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === openChar) {
      depth += 1
    } else if (ch === closeChar) {
      depth -= 1
      if (depth === 0) {
        return i + 1
      }
    }
  }
  return -1
}

const skipWhitespace = (input: string, startIndex: number): number => {
  let i = startIndex
  while (i < input.length && /\s/.test(input[i] ?? "")) {
    i += 1
  }
  return i
}

const parsePartialJsonObjectDetailed = (
  trimmed: string,
): { readonly record: Record<string, unknown>; readonly isComplete: boolean } | undefined => {
  if (!trimmed.startsWith("{")) {
    return undefined
  }
  const record: Record<string, unknown> = {}
  let isComplete = false
  let i = 1
  while (i < trimmed.length) {
    i = skipWhitespace(trimmed, i)
    if (trimmed[i] === ",") {
      i = skipWhitespace(trimmed, i + 1)
    }
    if (trimmed[i] === "}") {
      isComplete = true
      break
    }
    if (i >= trimmed.length) {
      break
    }
    if (trimmed[i] !== '"') {
      break
    }
    const keyResult = readJsonString(trimmed, i)
    if (!keyResult.complete) {
      break
    }
    i = skipWhitespace(trimmed, keyResult.nextIndex)
    if (trimmed[i] !== ":") {
      break
    }
    i = skipWhitespace(trimmed, i + 1)
    if (i >= trimmed.length) {
      break
    }
    const ch = trimmed[i]
    if (ch === '"') {
      const valResult = readJsonString(trimmed, i)
      record[keyResult.value] = valResult.value
      i = valResult.nextIndex
      if (!valResult.complete) {
        break
      }
    } else if (ch === "{" || ch === "[") {
      const endIndex = findMatchingDelimiter(trimmed, i)
      if (endIndex === -1) {
        break
      }
      try {
        record[keyResult.value] = JSON.parse(trimmed.slice(i, endIndex))
        i = endIndex
      } catch {
        break
      }
    } else {
      let endIndex = i
      while (
        endIndex < trimmed.length &&
        trimmed[endIndex] !== "," &&
        trimmed[endIndex] !== "}" &&
        !/\s/.test(trimmed[endIndex] ?? "")
      ) {
        endIndex += 1
      }
      const token = trimmed.slice(i, endIndex)
      try {
        record[keyResult.value] = JSON.parse(token)
        i = endIndex
      } catch {
        break
      }
    }
  }
  return { record, isComplete }
}

const parsePartialJsonObject = (trimmed: string): Record<string, unknown> | undefined => {
  const detailed = parsePartialJsonObjectDetailed(trimmed)
  return detailed !== undefined && Object.keys(detailed.record).length > 0
    ? detailed.record
    : undefined
}

export type LenientJsonObject =
  | { readonly _tag: "Valid"; readonly record: Record<string, unknown> }
  | { readonly _tag: "Repaired"; readonly record: Record<string, unknown> }
  | { readonly _tag: "Truncated"; readonly record: Record<string, unknown> }
  | { readonly _tag: "NotAnObject"; readonly value: unknown }
  | { readonly _tag: "Invalid"; readonly detail: string }

export const parseJsonObjectLenient = (raw: string): LenientJsonObject => {
  const trimmed = raw.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isPlainObject(parsed)
      ? { _tag: "Valid", record: parsed }
      : { _tag: "NotAnObject", value: parsed }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const partial = parsePartialJsonObjectDetailed(trimmed)
    if (partial === undefined) {
      return { _tag: "Invalid", detail }
    }
    if (partial.isComplete) {
      return { _tag: "Repaired", record: partial.record }
    }
    return Object.keys(partial.record).length > 0
      ? { _tag: "Truncated", record: partial.record }
      : { _tag: "Invalid", detail }
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const formatRecordEntry = ([key, value]: readonly [string, unknown]): string => {
  if (typeof value === "string") {
    return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return `${key}: ${String(value)}`
  }
  const json = JSON.stringify(value, null, 2)
  return json.includes("\n") ? `${key}:\n${json}` : `${key}: ${json}`
}

const formatRecordPretty = (record: Record<string, unknown>): string => {
  const entries = Object.entries(record)
  if (entries.length === 0) {
    return "{}"
  }
  if (entries.length === 1 && entries[0] !== undefined) {
    const [key, value] = entries[0]
    if (typeof value === "string" && value.includes("\n")) {
      return value
    }
    return formatRecordEntry([key, value])
  }
  const formattedEntries = entries.map(formatRecordEntry)
  return formattedEntries.reduce((acc, part, index) => {
    if (index === 0) {
      return part
    }
    const prev = formattedEntries[index - 1] ?? ""
    const separator = prev.includes("\n") || part.includes("\n") ? "\n\n" : "\n"
    return `${acc}${separator}${part}`
  }, "")
}

export const formatToolArguments = (raw: string, _name?: string): string => {
  const trimmed = raw.trim()
  if (trimmed === "") {
    return ""
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isPlainObject(parsed) ? formatRecordPretty(parsed) : JSON.stringify(parsed, null, 2)
  } catch {
    const partial = parsePartialJsonObject(trimmed)
    return partial !== undefined ? formatRecordPretty(partial) : trimmed
  }
}
