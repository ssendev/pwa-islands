// LLM / AGENT
// Alles rund um den OpenAI-kompatiblen LLM-Zugang lebt hier.

import {
  DEFAULT_EDIT_FORMAT,
  EditApplyResult,
  type EditFormat,
  applyEditsForFormat,
  formatToolResultForFormat,
  getEditorEditToolForFormat,
} from "./edit-format"

export type LlmSettings = {
  enabled: boolean
  editFormat: EditFormat
  baseUrl: string
  apiKey: string
  models: string
  streaming: boolean
  toolCalls: boolean
  thinkingParam: string
  thinkingLevels: string
  extraArgs: string
}

export type LlmSelection = {
  model: string
  thinkingLevel: string
}

export type LlmTestMode = "models" | "chat" | "tools"

export type LlmRequestConfig = LlmSettings & LlmSelection

export type LlmReplyParts = {
  content: string
  reasoning: string
}

export type LlmTestResult = {
  content: string
  reasoning: string
  models: ReadonlyArray<string>
}

export type ThinkingPreset = {
  id: string
  label: string
  param: string
  levels: string
}

export const THINKING_PRESETS: ReadonlyArray<ThinkingPreset> = [
  {
    id: "none",
    label: "Standard (ohne Parameter)",
    param: "",
    levels: "",
  },
  {
    id: "openai",
    label: "OpenAI / vLLM (Stufen)",
    param: "reasoning_effort",
    levels: "Aus=none, Minimal=minimal, Niedrig=low, Mittel=medium, Hoch=high",
  },
  {
    id: "qwen-template",
    label: "Qwen / vLLM-Template (An/Aus)",
    param: "chat_template_kwargs.enable_thinking",
    levels: "Aus=false, An=true",
  },
  {
    id: "enable-thinking",
    label: "An / Aus (Standard)",
    param: "enable_thinking",
    levels: "Aus=false, An=true",
  },
  {
    id: "ollama-think",
    label: "Ollama (An/Aus)",
    param: "think",
    levels: "Aus=false, An=true",
  },
  {
    id: "openrouter",
    label: "OpenRouter (Stufen)",
    param: "reasoning.effort",
    levels: "Aus=none, Minimal=minimal, Niedrig=low, Mittel=medium, Hoch=high",
  },
]

export const emptyLlmSettings: LlmSettings = {
  enabled: false,
  editFormat: DEFAULT_EDIT_FORMAT,
  baseUrl: "",
  apiKey: "",
  models: "",
  streaming: true,
  toolCalls: true,
  thinkingParam: "",
  thinkingLevels: "",
  extraArgs: "",
}

export const emptyLlmSelection: LlmSelection = {
  model: "",
  thinkingLevel: "",
}

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.trim().replace(/\/+$/, "")}${path}`

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey === "" ? {} : { Authorization: `Bearer ${apiKey}` }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("Antwort ist kein gültiges JSON")
  }
}

const errorDetail = (body: unknown): string => {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return `: ${body.error.message}`
  }
  return ""
}

const ensureOk = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    const detail = await readJson(response).then(errorDetail, () => "")
    throw new Error(`HTTP ${response.status}${detail}`)
  }
  const body = await readJson(response)
  if (isRecord(body) && "error" in body && body.error) {
    throw new Error(`Fehlerantwort${errorDetail(body)}`)
  }
  return body
}

/** Extrahiert die Modellnamen (`data[].id`) aus einer `/models`-Antwort. */
export const extractModelNames = (body: unknown): ReadonlyArray<string> => {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Unerwartete Antwort: keine Modellliste")
  }
  return body.data.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === "string" && entry.id.trim() !== "" ? [entry.id] : [],
  )
}

const MESSAGE_KEYS: ReadonlyArray<string> = ["content", "text"]
const REASONING_KEYS: ReadonlyArray<string> = [
  "reasoning_content",
  "reasoning",
  "thinking",
  "reasoning_details",
]

const extractTextValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((item: unknown) => {
      if (typeof item === "string") {
        return [item]
      }
      if (isRecord(item)) {
        if (typeof item.text === "string") {
          return [item.text]
        }
        if (typeof item.content === "string") {
          return [item.content]
        }
      }
      return []
    })
    return parts.length > 0 ? parts.join("") : undefined
  }
  return undefined
}

const extractFirstField = (container: unknown, keys: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(container)) {
    return undefined
  }
  const found = keys
    .map((key) => extractTextValue(container[key]))
    .find((text): text is string => text !== undefined)
  return found
}

/** Extrahiert Antworttext und Reasoning getrennt aus einer `/chat/completions`-JSON-Antwort. */
export const extractChatParts = (body: unknown): LlmReplyParts => {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
    throw new Error("Unerwartete Antwort: keine choices")
  }
  const first: unknown = body.choices[0]
  const message = isRecord(first) ? (first.message ?? first) : undefined
  const content = extractFirstField(message, MESSAGE_KEYS) ?? extractFirstField(first, MESSAGE_KEYS)
  const reasoning =
    extractFirstField(message, REASONING_KEYS) ?? extractFirstField(first, REASONING_KEYS)

  if (content === undefined && reasoning === undefined) {
    throw new Error("Unerwartete Antwort: keine Nachricht")
  }
  return {
    content: content ?? "",
    reasoning: reasoning ?? "",
  }
}

/** Extrahiert den Antworttext (oder ersatzweise Reasoning) aus einer `/chat/completions`-JSON-Antwort. */
export const extractChatReply = (body: unknown): string => {
  const parts = extractChatParts(body)
  return parts.content.trim() !== "" ? parts.content : parts.reasoning
}

const parseSseJsonChunk = (payload: string): unknown => {
  let chunk: unknown
  try {
    chunk = JSON.parse(payload)
  } catch {
    throw new Error("Streaming-Chunk ist kein gültiges JSON")
  }
  if (isRecord(chunk) && "error" in chunk && chunk.error) {
    throw new Error(`Fehlerantwort${errorDetail(chunk)}`)
  }
  return chunk
}

const extractDeltaParts = (chunk: unknown): LlmReplyParts => {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    return { content: "", reasoning: "" }
  }
  const first: unknown = chunk.choices[0]
  const delta = isRecord(first) ? (first.delta ?? first.message ?? first) : undefined
  return {
    content: extractFirstField(delta, MESSAGE_KEYS) ?? "",
    reasoning: extractFirstField(delta, REASONING_KEYS) ?? "",
  }
}

const parseSseDataPayload = (payload: string): LlmReplyParts =>
  extractDeltaParts(parseSseJsonChunk(payload))

/** Extrahiert Antworttext und Reasoning getrennt aus einer SSE-Streaming-Antwort. */
export const extractStreamParts = (sseText: string): LlmReplyParts => {
  const dataLines = sseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))

  if (dataLines.length === 0) {
    throw new Error("Unerwartete Streaming-Antwort: keine Daten")
  }

  const parts = dataLines
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload !== "" && payload !== "[DONE]")
    .map(parseSseDataPayload)

  return {
    content: parts.map((part) => part.content).join(""),
    reasoning: parts.map((part) => part.reasoning).join(""),
  }
}

/** Extrahiert den zusammengesetzten Antworttext (oder ersatzweise Reasoning) aus einer SSE-Streaming-Antwort. */
export const extractStreamReply = (sseText: string): string => {
  const parts = extractStreamParts(sseText)
  return parts.content.trim() !== "" ? parts.content : parts.reasoning
}

/** Prüft `GET /models`: die Antwort muss eine OpenAI-Modellliste (`data`-Array) sein. */
export const listModels = async (settings: LlmSettings): Promise<ReadonlyArray<string>> => {
  const response = await fetch(joinUrl(settings.baseUrl, "/models"), {
    headers: authHeaders(settings.apiKey),
  })
  const body = await ensureOk(response)
  return extractModelNames(body)
}

export type LabeledOption = {
  readonly label: string
  readonly value: string
}

export type ModelOption = LabeledOption

export type ThinkingLevelOption = LabeledOption

const parseLabeledOptions = (raw: string): ReadonlyArray<LabeledOption> => {
  const seen = new Set<string>()
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      if (entry === "") {
        return []
      }
      const eqIndex = entry.indexOf("=")
      const label = eqIndex === -1 ? entry : entry.slice(0, eqIndex).trim()
      const value = eqIndex === -1 ? entry : entry.slice(eqIndex + 1).trim()
      if (label === "" || value === "" || seen.has(value)) {
        return []
      }
      seen.add(value)
      return [{ label, value }]
    })
}

/** Parst kommagetrennte Modelle (`Modell-ID` oder `Anzeigename=Modell-ID`) und entfernt Leerwerte/Duplikate. */
export const parseModelOptions = (raw: string): ReadonlyArray<ModelOption> =>
  parseLabeledOptions(raw)

/** Kombiniert manuelle, entdeckte und das aktive Modell dedupliziert zu Select-Optionen. */
export const resolveModelOptions = (
  models: string,
  discoveredModels: ReadonlyArray<string>,
  activeModel: string,
): ReadonlyArray<ModelOption> => {
  const manualOptions = parseModelOptions(models)
  const trimmedActive = activeModel.trim()
  const seen = new Set<string>()
  return [
    ...manualOptions,
    ...discoveredModels.map((id) => ({ label: id, value: id })),
    ...(trimmedActive !== "" ? [{ label: trimmedActive, value: trimmedActive }] : []),
  ].filter((item) => {
    if (seen.has(item.value)) {
      return false
    }
    seen.add(item.value)
    return true
  })
}

/** Parst kommagetrennte Modell-IDs und entfernt Leerwerte/Duplikate. */
export const parseModelList = (raw: string): ReadonlyArray<string> =>
  parseLabeledOptions(raw).map((option) => option.value)

/** Parst kommagetrennte Thinking-Level (`Wert` oder `Label=Wert`) und entfernt Leerwerte/Duplikate. */
export const parseThinkingLevels = (raw: string): ReadonlyArray<ThinkingLevelOption> =>
  parseLabeledOptions(raw)

/** Wandelt einen Thinking-Level-String in einen typisierten JSON-Wert um (Boolean, Zahl, JSON oder String). */
export const parseThinkingValue = (raw: string): unknown => {
  const trimmed = raw.trim()
  if (trimmed === "true") {
    return true
  }
  if (trimmed === "false") {
    return false
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed)
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  return trimmed
}

const setNestedField = (
  target: Record<string, unknown>,
  segments: ReadonlyArray<string>,
  value: unknown,
): Record<string, unknown> => {
  if (segments.length === 0) {
    return target
  }
  const [head, ...rest] = segments
  if (head === undefined) {
    return target
  }
  if (rest.length === 0) {
    return { ...target, [head]: value }
  }
  const existing = target[head]
  const nested = isRecord(existing) && !Array.isArray(existing) ? existing : {}
  return { ...target, [head]: setNestedField(nested, rest, value) }
}

/** Parst optionale zusätzliche Request-Parameter als JSON-Objekt. */
export const parseExtraArgs = (raw: string): Record<string, unknown> => {
  const trimmed = raw.trim()
  if (trimmed === "") {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error("Zusätzliche Parameter sind kein gültiges JSON")
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error("Zusätzliche Parameter müssen ein JSON-Objekt sein")
  }
  return parsed
}

/** Baut den Request-Body für `/chat/completions` inkl. Thinking-Parameter und Extra-Parametern. */
export const buildChatRequestBody = (
  config: LlmRequestConfig,
  prompt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const extra = parseExtraArgs(config.extraArgs)
  const baseBody: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 500,
    stream: config.streaming,
    ...overrides,
    ...extra,
  }
  const thinkingParam = config.thinkingParam.trim()
  const thinkingLevel = config.thinkingLevel.trim()
  if (thinkingParam === "" || thinkingLevel === "") {
    return baseBody
  }
  const segments = thinkingParam
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
  return setNestedField(baseBody, segments, parseThinkingValue(thinkingLevel))
}

/** Sendet eine kurze Chat-Anfrage und gibt Antworttext und Reasoning getrennt zurück. */
export const chatOnceParts = async (
  config: LlmRequestConfig,
  prompt: string,
): Promise<LlmReplyParts> => {
  const requestBody = buildChatRequestBody(config, prompt)
  const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey) },
    body: JSON.stringify(requestBody),
  })
  if (config.streaming) {
    if (!response.ok) {
      const detail = await readJson(response).then(errorDetail, () => "")
      throw new Error(`HTTP ${response.status}${detail}`)
    }
    const text = await response.text()
    return extractStreamParts(text)
  }
  const body = await ensureOk(response)
  return extractChatParts(body)
}

/** Sendet eine kurze Chat-Anfrage und gibt den Antworttext zurück. */
export const chatOnce = async (config: LlmRequestConfig, prompt: string): Promise<string> => {
  const parts = await chatOnceParts(config, prompt)
  return parts.content.trim() !== "" ? parts.content : parts.reasoning
}

/** Bestimmt das für einen LLM-Test zu verwendende Modell (leer, falls `/models` abgefragt wird). */
export const resolveTestModel = (config: LlmRequestConfig): string => {
  const manualModels = parseModelList(config.models)
  return config.model.trim() !== "" ? config.model.trim() : (manualModels[0] ?? "")
}

const PING_TOOL_PROMPT = "Rufe das Tool ping_test mit token='ok' auf."

const PING_TOOL_OVERRIDES: Record<string, unknown> = {
  tools: [
    {
      type: "function",
      function: {
        name: "ping_test",
        description: "Bestätigt, dass Tool-Aufrufe funktionieren.",
        parameters: {
          type: "object",
          properties: {
            token: { type: "string", description: "Ein beliebiger Text, z. B. ok" },
          },
          required: ["token"],
        },
      },
    },
  ],
  tool_choice: "auto",
}

const readSseStream = async <T>(
  response: Response,
  initialState: T,
  applyChunk: (state: T, chunk: unknown) => { state: T; changed: boolean },
  onUpdate: (state: T) => void,
): Promise<T> => {
  const applyLines = (
    lines: ReadonlyArray<string>,
    acc: T,
    sawData: boolean,
  ): { state: T; sawData: boolean; changed: boolean } => {
    const dataLines = lines.map((line) => line.trim()).filter((line) => line.startsWith("data:"))
    if (dataLines.length === 0) {
      return { state: acc, sawData, changed: false }
    }
    const payloads = dataLines
      .map((line) => line.slice("data:".length).trim())
      .filter((payload) => payload !== "" && payload !== "[DONE]")
    const result = payloads.reduce<{ state: T; changed: boolean }>(
      (current, payload) => {
        const step = applyChunk(current.state, parseSseJsonChunk(payload))
        return {
          state: step.state,
          changed: current.changed || step.changed,
        }
      },
      { state: acc, changed: false },
    )
    return { state: result.state, sawData: true, changed: result.changed }
  }

  if (!response.body) {
    const text = await response.text()
    const step = applyLines(text.split(/\r?\n/), initialState, false)
    if (!step.sawData) {
      throw new Error("Unerwartete Streaming-Antwort: keine Daten")
    }
    if (step.changed) {
      onUpdate(step.state)
    }
    return step.state
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  const pump = async (buffer: string, acc: T, sawData: boolean): Promise<T> => {
    const { done, value } = await reader.read()
    if (done) {
      const trailing = buffer + decoder.decode()
      const finalStep = applyLines(trailing.split(/\r?\n/), acc, sawData)
      if (!finalStep.sawData) {
        throw new Error("Unerwartete Streaming-Antwort: keine Daten")
      }
      if (finalStep.changed) {
        onUpdate(finalStep.state)
      }
      return finalStep.state
    }
    const combined = buffer + decoder.decode(value, { stream: true })
    const lines = combined.split(/\r?\n/)
    const remainder = lines[lines.length - 1] ?? ""
    const completeLines = lines.slice(0, -1)
    const step = applyLines(completeLines, acc, sawData)
    if (step.changed) {
      onUpdate(step.state)
    }
    return pump(remainder, step.state, step.sawData)
  }

  try {
    return await pump("", initialState, false)
  } finally {
    reader.releaseLock()
  }
}

/**
 * Sendet eine Chat-Anfrage im Streaming-Modus und ruft `onUpdate` bei jedem Chunk
 * mit dem bis dahin akkumulierten Antworttext und Reasoning auf.
 */
export const streamChatParts = async (
  config: LlmRequestConfig,
  prompt: string,
  onUpdate: (parts: LlmReplyParts) => void,
  signal?: AbortSignal,
): Promise<LlmReplyParts> => {
  const requestBody = buildChatRequestBody({ ...config, streaming: true }, prompt)
  const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey) },
    body: JSON.stringify(requestBody),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const detail = await readJson(response).then(errorDetail, () => "")
    throw new Error(`HTTP ${response.status}${detail}`)
  }
  return readSseStream<LlmReplyParts>(
    response,
    { content: "", reasoning: "" },
    (state, chunk) => {
      const delta = extractDeltaParts(chunk)
      const changed = delta.content !== "" || delta.reasoning !== ""
      return {
        state: changed
          ? { content: state.content + delta.content, reasoning: state.reasoning + delta.reasoning }
          : state,
        changed,
      }
    },
    onUpdate,
  )
}

type StreamingToolCallState = {
  reasoning: string
  calls: ReadonlyArray<LlmToolCall>
}

const formatToolCallSummary = (calls: ReadonlyArray<LlmToolCall>): string =>
  calls.map((call) => `Tool-Aufruf: ${call.name}(${call.arguments})`).join("\n")

/**
 * Testet Tool-Calling im Streaming-Modus und ruft `onUpdate` bei jedem Chunk
 * (inkl. gestreamtem Thinking/Reasoning und Tool-Aufruf-Fragmenten) auf.
 */
export const streamToolCallParts = async (
  config: LlmRequestConfig,
  onUpdate: (parts: LlmReplyParts) => void,
  signal?: AbortSignal,
): Promise<LlmReplyParts> => {
  const activeModel = resolveTestModel(config)
  if (activeModel === "") {
    throw new Error("Kein Modell ausgewählt oder angegeben")
  }
  const requestBody = buildChatRequestBody(
    { ...config, model: activeModel, streaming: true },
    PING_TOOL_PROMPT,
    PING_TOOL_OVERRIDES,
  )
  const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey) },
    body: JSON.stringify(requestBody),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const detail = await readJson(response).then(errorDetail, () => "")
    throw new Error(`HTTP ${response.status}${detail}`)
  }

  const finalState = await readSseStream<StreamingToolCallState>(
    response,
    { reasoning: "", calls: [] },
    (state, chunk) => {
      const deltaParts = extractDeltaParts(chunk)
      const first: unknown =
        isRecord(chunk) && Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
      const delta = isRecord(first) ? (first.delta ?? first.message ?? first) : undefined
      const rawToolCalls =
        isRecord(delta) && Array.isArray(delta.tool_calls) ? delta.tool_calls : []

      const nextCalls = rawToolCalls.reduce<ReadonlyArray<LlmToolCall>>((acc, item) => {
        if (!isRecord(item) || !isRecord(item.function)) {
          return acc
        }
        const idx = typeof item.index === "number" ? item.index : 0
        const namePart = typeof item.function.name === "string" ? item.function.name : ""
        const argsPart = typeof item.function.arguments === "string" ? item.function.arguments : ""
        const existing = acc[idx] ?? { name: "", arguments: "" }
        const updated = acc.slice()
        updated[idx] = {
          name: existing.name + namePart,
          arguments: existing.arguments + argsPart,
        }
        return updated
      }, state.calls)

      const changed = deltaParts.reasoning !== "" || rawToolCalls.length > 0
      return {
        state: changed
          ? {
              reasoning: state.reasoning + deltaParts.reasoning,
              calls: nextCalls,
            }
          : state,
        changed,
      }
    },
    (state) => {
      onUpdate({
        content: formatToolCallSummary(state.calls),
        reasoning: state.reasoning,
      })
    },
  )

  const validCalls = finalState.calls.filter((call) => call.name.trim() !== "")
  if (validCalls.length === 0) {
    throw new Error("Kein Tool-Aufruf in der Antwort erhalten")
  }
  return {
    content: formatToolCallSummary(validCalls),
    reasoning: finalState.reasoning.trim(),
  }
}

export type LlmToolCall = {
  name: string
  arguments: string
}

/** Extrahiert Tool-Aufrufe aus einer `/chat/completions`-JSON-Antwort. */
export const extractToolCalls = (body: unknown): ReadonlyArray<LlmToolCall> => {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
    throw new Error("Unerwartete Antwort: keine choices")
  }
  const first: unknown = body.choices[0]
  const message = isRecord(first) ? (first.message ?? first) : undefined
  const rawCalls = isRecord(message) && Array.isArray(message.tool_calls) ? message.tool_calls : []
  return rawCalls.flatMap((call) => {
    if (!isRecord(call) || !isRecord(call.function)) {
      return []
    }
    const name = typeof call.function.name === "string" ? call.function.name.trim() : ""
    if (name === "") {
      return []
    }
    const args = typeof call.function.arguments === "string" ? call.function.arguments.trim() : ""
    return [{ name, arguments: args }]
  })
}

/** Testet Tool-Calling über `/chat/completions` mit einem einfachen Ping-Tool. */
export const testToolCall = async (config: LlmRequestConfig): Promise<LlmTestResult> => {
  const activeModel = resolveTestModel(config)
  if (activeModel === "") {
    throw new Error("Kein Modell ausgewählt oder angegeben")
  }
  const requestBody = buildChatRequestBody(
    { ...config, model: activeModel, streaming: false },
    PING_TOOL_PROMPT,
    PING_TOOL_OVERRIDES,
  )
  const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey) },
    body: JSON.stringify(requestBody),
  })
  const body = await ensureOk(response)
  const calls = extractToolCalls(body)
  const first: unknown = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined
  const message = isRecord(first) ? (first.message ?? first) : undefined
  const reasoning =
    extractFirstField(message, REASONING_KEYS) ?? extractFirstField(first, REASONING_KEYS) ?? ""

  if (calls.length === 0) {
    throw new Error("Kein Tool-Aufruf in der Antwort erhalten")
  }
  return {
    content: calls.map((call) => `Tool-Aufruf: ${call.name}(${call.arguments})`).join("\n"),
    reasoning: reasoning.trim(),
    models: [],
  }
}

const runChatTest = async (config: LlmRequestConfig): Promise<LlmTestResult> => {
  const activeModel = resolveTestModel(config)
  if (activeModel === "") {
    throw new Error("Kein Modell ausgewählt oder angegeben")
  }
  const parts = await chatOnceParts({ ...config, model: activeModel }, "Antworte nur mit: ok")
  if (parts.content.trim() === "" && parts.reasoning.trim() === "") {
    throw new Error("Unerwartete Antwort: leere Chat-Antwort")
  }
  return {
    content: parts.content.trim(),
    reasoning: parts.reasoning.trim(),
    models: [],
  }
}

/**
 * Testet den Zugang je nach Modus:
 * - `"models"`: Modellliste über `GET /models`
 * - `"chat"`: Chat-Anfrage über `/chat/completions`
 * - `"tools"`: Tool-Aufruf über `/chat/completions`
 * - ohne Modus (Standard): Chat mit aktivem/manuellem Modell, sonst `/models`.
 */
export const testLlmConnection = async (
  config: LlmRequestConfig,
  mode?: LlmTestMode,
): Promise<LlmTestResult> => {
  if (mode === "models") {
    const models = await listModels(config)
    return {
      content: "",
      reasoning: "",
      models,
    }
  }
  if (mode === "tools") {
    return testToolCall(config)
  }
  if (mode === "chat" || resolveTestModel(config) !== "") {
    return runChatTest(config)
  }
  const models = await listModels(config)
  return {
    content: "",
    reasoning: "",
    models,
  }
}

export type EditorChatToolCall = {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export type EditorChatMessage =
  | { readonly _tag: "System"; readonly content: string }
  | { readonly _tag: "User"; readonly content: string }
  | {
      readonly _tag: "Assistant"
      readonly content: string
      readonly toolCalls: ReadonlyArray<EditorChatToolCall>
    }
  | { readonly _tag: "Tool"; readonly toolCallId: string; readonly content: string }

export const EDITOR_EDIT_TOOL = {
  type: "function",
  function: {
    name: "edit",
    description:
      "Wendet Hash-Anchored Line Edits (REPLACE, INSERT_AFTER, INSERT_BEFORE, DELETE) auf die aktuell geöffnete Datei an.",
    parameters: {
      type: "object",
      properties: {
        edits: {
          type: "string",
          description: "Die Hashline-Bearbeitungsbefehle für die Datei.",
        },
      },
      required: ["edits"],
      additionalProperties: false,
    },
  },
} as const

const toOpenAiEditorMessages = (
  messages: ReadonlyArray<EditorChatMessage>,
): ReadonlyArray<Record<string, unknown>> =>
  messages.map((msg) => {
    if (msg._tag === "System") {
      return { role: "system", content: msg.content }
    }
    if (msg._tag === "User") {
      return { role: "user", content: msg.content }
    }
    if (msg._tag === "Tool") {
      return { role: "tool", tool_call_id: msg.toolCallId, content: msg.content }
    }
    return {
      role: "assistant",
      content: msg.content === "" && msg.toolCalls.length > 0 ? null : msg.content,
      ...(msg.toolCalls.length > 0
        ? {
            tool_calls: msg.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    }
  })

const extractEditorToolArgs = (rawArguments: string, depth = 0): string => {
  const trimmed = rawArguments.trim()
  if (trimmed === "") {
    return ""
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string") {
      if (depth < 2 && (parsed.trim().startsWith("{") || parsed.trim().startsWith('"'))) {
        return extractEditorToolArgs(parsed, depth + 1)
      }
      return parsed
    }
    if (isRecord(parsed)) {
      if (typeof parsed.edits === "string") {
        return parsed.edits
      }
      if (typeof parsed.text === "string") {
        return parsed.text
      }
      if (typeof parsed.patch === "string") {
        return parsed.patch
      }
    }
  } catch {
    return rawArguments
  }
  return ""
}

const extractNonStreamingEditorResponse = (
  body: unknown,
): {
  readonly content: string
  readonly reasoning: string
  readonly toolCalls: ReadonlyArray<EditorChatToolCall>
} => {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
    throw new Error("Unerwartete Antwort: keine choices")
  }
  const first: unknown = body.choices[0]
  const message = isRecord(first) ? (first.message ?? first) : undefined
  const content = isRecord(message) && typeof message.content === "string" ? message.content : ""
  const reasoning =
    extractFirstField(message, REASONING_KEYS) ?? extractFirstField(first, REASONING_KEYS) ?? ""
  const rawCalls = isRecord(message) && Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls: ReadonlyArray<EditorChatToolCall> = rawCalls.flatMap((call, idx) => {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string") {
      return []
    }
    const id = typeof call.id === "string" && call.id !== "" ? call.id : `call_${idx}`
    const args =
      typeof call.function.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function.arguments ?? {})
    return [{ id, name: call.function.name, arguments: args }]
  })
  return { content, reasoning: reasoning.trim(), toolCalls }
}

export const requestEditorChatCompletion = async (
  config: LlmRequestConfig,
  messages: ReadonlyArray<EditorChatMessage>,
  onUpdate?: (parts: LlmReplyParts) => void,
  signal?: AbortSignal,
): Promise<{
  readonly content: string
  readonly reasoning: string
  readonly toolCalls: ReadonlyArray<EditorChatToolCall>
}> => {
  const activeModel = resolveTestModel(config)
  if (activeModel === "") {
    throw new Error("Kein Modell ausgewählt oder angegeben")
  }
  const requestBody = buildChatRequestBody({ ...config, model: activeModel }, "", {
    messages: toOpenAiEditorMessages(messages),
    max_tokens: 4096,
    tools: [getEditorEditToolForFormat(config.editFormat)],
    tool_choice: "auto",
  })
  const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey) },
    body: JSON.stringify(requestBody),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const detail = await readJson(response).then(errorDetail, () => "")
    throw new Error(`HTTP ${response.status}${detail}`)
  }
  if (!config.streaming) {
    const body = await readJson(response)
    return extractNonStreamingEditorResponse(body)
  }

  const finalState = await readSseStream<{
    content: string
    reasoning: string
    calls: ReadonlyArray<EditorChatToolCall>
  }>(
    response,
    { content: "", reasoning: "", calls: [] },
    (state, chunk) => {
      const deltaParts = extractDeltaParts(chunk)
      const first: unknown =
        isRecord(chunk) && Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
      const delta = isRecord(first) ? (first.delta ?? first.message ?? first) : undefined
      const rawToolCalls =
        isRecord(delta) && Array.isArray(delta.tool_calls) ? delta.tool_calls : []

      const nextCalls = rawToolCalls.reduce<ReadonlyArray<EditorChatToolCall>>((acc, item) => {
        if (!isRecord(item) || !isRecord(item.function)) {
          return acc
        }
        const idx = typeof item.index === "number" ? item.index : 0
        const idPart = typeof item.id === "string" ? item.id : ""
        const namePart = typeof item.function.name === "string" ? item.function.name : ""
        const argsPart = typeof item.function.arguments === "string" ? item.function.arguments : ""
        const existing = acc[idx] ?? { id: `call_${idx}`, name: "", arguments: "" }
        const updated = acc.slice()
        updated[idx] = {
          id: idPart !== "" ? idPart : existing.id,
          name: existing.name + namePart,
          arguments: existing.arguments + argsPart,
        }
        return updated
      }, state.calls)

      const changed =
        deltaParts.content !== "" || deltaParts.reasoning !== "" || rawToolCalls.length > 0
      return {
        state: changed
          ? {
              content: state.content + deltaParts.content,
              reasoning: state.reasoning + deltaParts.reasoning,
              calls: nextCalls,
            }
          : state,
        changed,
      }
    },
    (state) => {
      if (!onUpdate) {
        return
      }
      const streamingCalls = state.calls.filter((call) => call.name.trim() !== "")
      const toolSummary = formatToolCallsSummary(streamingCalls)
      const streamContent = joinNonEmptyParts([state.content, toolSummary])
      onUpdate({
        content: streamContent,
        reasoning: state.reasoning,
      })
    },
  )

  return {
    content: finalState.content,
    reasoning: finalState.reasoning.trim(),
    toolCalls: finalState.calls.filter((call) => call.name.trim() !== ""),
  }
}

export type EditorChatTurnBlock = {
  readonly content: string
  readonly reasoning: string
  readonly isError: boolean
}

export type EditorChatStreamUpdate = {
  readonly completedTurns: ReadonlyArray<EditorChatTurnBlock>
  readonly activeTurn: {
    readonly content: string
    readonly reasoning: string
  }
}

export type EditorChatTurnResult = {
  readonly messages: ReadonlyArray<EditorChatMessage>
  readonly updatedContent?: string
  readonly appliedCount: number
  readonly turns: ReadonlyArray<EditorChatTurnBlock>
}

const MAX_EDIT_ERROR_RETRIES = 4

const joinNonEmptyParts = (parts: ReadonlyArray<string>): string =>
  parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n")

const formatToolCallsSummary = (toolCalls: ReadonlyArray<EditorChatToolCall>): string =>
  toolCalls
    .map((call) => {
      const name = call.name.trim()
      if (name === "edit") {
        const args = extractEditorToolArgs(call.arguments).trim()
        return args !== "" ? `Tool-Aufruf: edit\n${args}` : "Tool-Aufruf: edit"
      }
      return name !== "" ? `Tool-Aufruf: ${name}` : ""
    })
    .filter((entry) => entry !== "")
    .join("\n\n")

export const runEditorChatTurn = async ({
  config,
  fileName,
  initialContent,
  initialMessages,
  onUpdate,
  signal,
}: {
  readonly config: LlmRequestConfig
  readonly fileName: string
  readonly initialContent: string
  readonly initialMessages: ReadonlyArray<EditorChatMessage>
  readonly onUpdate?: (update: EditorChatStreamUpdate) => void
  readonly signal?: AbortSignal
}): Promise<EditorChatTurnResult> => {
  const step = async (
    messages: ReadonlyArray<EditorChatMessage>,
    currentContent: string,
    errorRetriesLeft: number,
    completedTurns: ReadonlyArray<EditorChatTurnBlock>,
  ): Promise<EditorChatTurnResult> => {
    const turnOnUpdate = onUpdate
      ? (activeTurn: LlmReplyParts) => {
          onUpdate({
            completedTurns,
            activeTurn,
          })
        }
      : undefined
    const reply = await requestEditorChatCompletion(config, messages, turnOnUpdate, signal)
    const assistantMsg: EditorChatMessage = {
      _tag: "Assistant",
      content: reply.content,
      toolCalls: reply.toolCalls,
    }
    const toolSummary = formatToolCallsSummary(reply.toolCalls)
    const replyContent = joinNonEmptyParts([reply.content, toolSummary])
    const replyReasoning = reply.reasoning.trim()
    const replyTurns: ReadonlyArray<EditorChatTurnBlock> =
      replyContent !== "" || replyReasoning !== ""
        ? [{ content: replyContent, reasoning: replyReasoning, isError: false }]
        : []

    const editCall = reply.toolCalls.find((call) => call.name === "edit")
    if (!editCall) {
      return {
        messages: [...messages, assistantMsg],
        appliedCount: 0,
        turns: [...completedTurns, ...replyTurns],
      }
    }

    const editsText = extractEditorToolArgs(editCall.arguments)
    const applyResult = applyEditsForFormat(config.editFormat, currentContent, editsText)

    return EditApplyResult.match(applyResult, {
      Ok: ({ content: nextContent, appliedCount, updatedSnippet }) => {
        const toolMsg: EditorChatMessage = {
          _tag: "Tool",
          toolCallId: editCall.id,
          content: formatToolResultForFormat(config.editFormat, fileName, updatedSnippet),
        }
        return {
          messages: [...messages, assistantMsg, toolMsg],
          updatedContent: nextContent,
          appliedCount,
          turns: [...completedTurns, ...replyTurns],
        }
      },
      Error: ({ message: errorMessage }) => {
        const toolMsg: EditorChatMessage = {
          _tag: "Tool",
          toolCallId: editCall.id,
          content: `Fehler beim Anwenden der Änderungen: ${errorMessage}`,
        }
        const nextMessages = [...messages, assistantMsg, toolMsg]
        const errorTurn: EditorChatTurnBlock = {
          content: `Fehler beim Anwenden der Änderungen: ${errorMessage}`,
          reasoning: "",
          isError: true,
        }
        const nextCompletedTurns: ReadonlyArray<EditorChatTurnBlock> = [
          ...completedTurns,
          ...replyTurns,
          errorTurn,
        ]
        if (errorRetriesLeft <= 0) {
          onUpdate?.({
            completedTurns: nextCompletedTurns,
            activeTurn: { content: "", reasoning: "" },
          })
          throw new Error(errorMessage)
        }
        onUpdate?.({
          completedTurns: nextCompletedTurns,
          activeTurn: { content: "Korrigiere Bearbeitung …", reasoning: "" },
        })
        return step(nextMessages, currentContent, errorRetriesLeft - 1, nextCompletedTurns)
      },
    })
  }

  return step(initialMessages, initialContent, MAX_EDIT_ERROR_RETRIES, [])
}
