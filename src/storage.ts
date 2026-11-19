import { Array, Data, Effect, Option, Schema, Stream } from "effect"
import { invoke } from "@tauri-apps/api/core"
import {
  type DateFormat,
  type Language,
  type TimeFormat,
  getDocumentLanguage,
  isDateFormat,
  isLanguage,
  isTimeFormat,
  t,
} from "./i18n"

export class DirectoryIterationError extends Data.TaggedError("DirectoryIterationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const DB_NAME = "pwa-islands-db"
export const DB_VERSION = 1
export const STORE_NAME = "handles"
export const HANDLE_KEY = "selected_folder"
export const USER_TEMPLATES_KEY = "user_templates"
export const STORAGE_TYPE_KEY = "selected_storage_type"
export const FILE_INFO_VISIBLE_KEY = "file_info_visible"
export const HISTORY_ENABLED_KEY = "history_enabled"
export const API_HISTORY_ENABLED_KEY = "api_history_enabled"
export const ISLAND_PARAM = "pwaislands"

// NOTE: OPFS has a single root per origin; files are placed in a subfolder
export const OPFS_APP_FOLDER = "PWA Islands"

const storageCache: {
  dbPromise: Option.Option<Promise<IDBDatabase>>
  root: Option.Option<FileSystemDirectoryHandle>
} = {
  dbPromise: Option.none(),
  root: Option.none(),
}

// NOTE: IndexedDB instance is cached to avoid reconnect overhead on island asset fetches
export function openDB(): Promise<IDBDatabase> {
  return Option.match(storageCache.dbPromise, {
    onSome: (cached) => cached,
    onNone: () => {
      const pending: Promise<IDBDatabase> = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)

        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      storageCache.dbPromise = Option.some(pending)
      void pending.catch(() => {
        if (Option.exists(storageCache.dbPromise, (cached) => cached === pending)) {
          storageCache.dbPromise = Option.none()
        }
      })

      return pending
    },
  })
}

export async function getStoredDirectoryHandle(): Promise<
  Option.Option<FileSystemDirectoryHandle>
> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(HANDLE_KEY)

      req.onsuccess = () => resolve(Option.fromNullishOr(req.result))
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen des gespeicherten Ordners:", error)
    return Option.none()
  }
}

export async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  invalidateRootCache()
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(handle, HANDLE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function clearStoredDirectoryHandle(): Promise<void> {
  invalidateRootCache()
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(HANDLE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

const isStoredStorageType = (value: unknown): value is "fsa" | "opfs" | "tauri" =>
  value === "fsa" || value === "opfs" || value === "tauri"

export async function getStoredStorageType(): Promise<Option.Option<"fsa" | "opfs" | "tauri">> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(STORAGE_TYPE_KEY)

      req.onsuccess = () => resolve(Option.liftPredicate(req.result, isStoredStorageType))
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der gespeicherten Speicherart:", error)
    return Option.none()
  }
}

export async function storeStorageType(type: "fsa" | "opfs" | "tauri"): Promise<void> {
  invalidateRootCache()
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(type, STORAGE_TYPE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// NOTE: Defaults to true so missing preference leaves standard file info visible
export async function getStoredFileInfoVisible(): Promise<boolean> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(FILE_INFO_VISIBLE_KEY)

      req.onsuccess = () => resolve(req.result !== false)
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der Datei-Info-Einstellung:", error)
    return true
  }
}

export async function storeFileInfoVisible(visible: boolean): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(visible, FILE_INFO_VISIBLE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function getStoredBooleanFlag(key: string, defaultValue: boolean): Promise<boolean> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(key)

      req.onsuccess = () => resolve(typeof req.result === "boolean" ? req.result : defaultValue)
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der Verlaufs-Einstellung:", error)
    return defaultValue
  }
}

async function storeBooleanFlag(key: string, enabled: boolean): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(enabled, key)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// NOTE: Defaults to true so version saving is active unless explicitly disabled
export const getStoredHistoryEnabled = (): Promise<boolean> =>
  getStoredBooleanFlag(HISTORY_ENABLED_KEY, true)

export const storeHistoryEnabled = (enabled: boolean): Promise<void> =>
  storeBooleanFlag(HISTORY_ENABLED_KEY, enabled)

// NOTE: Defaults to true so api.js edits save versions unless explicitly disabled
export const getStoredApiHistoryEnabled = (): Promise<boolean> =>
  getStoredBooleanFlag(API_HISTORY_ENABLED_KEY, true)

export const storeApiHistoryEnabled = (enabled: boolean): Promise<void> =>
  storeBooleanFlag(API_HISTORY_ENABLED_KEY, enabled)

import {
  emptyLlmSettings,
  type LlmSettings,
  type OpenAiProviderConfig,
  type ProviderEditFormat,
} from "./agent"
import { parseEditFormat } from "./edit-format"

const LLM_SETTINGS_KEY = "llm_settings"

const parseProviderEditFormat = (raw: unknown): ProviderEditFormat =>
  raw === "" ? "" : typeof raw === "string" ? parseEditFormat(raw) : ""

const parseStoredProvider = (
  raw: unknown,
  fallbackEnabled: boolean,
): OpenAiProviderConfig | null => {
  if (typeof raw !== "object" || raw === null) {
    return null
  }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === "string" && r.id.trim() !== "" ? r.id : ""
  if (id === "") {
    return null
  }
  return {
    id,
    name: typeof r.name === "string" ? r.name : "",
    enabled: typeof r.enabled === "boolean" ? r.enabled : fallbackEnabled,
    baseUrl: typeof r.baseUrl === "string" ? r.baseUrl : "",
    apiKey: typeof r.apiKey === "string" ? r.apiKey : "",
    models: typeof r.models === "string" ? r.models : "",
    modelFilter: typeof r.modelFilter === "string" ? r.modelFilter : "",
    discoveredModels: Array.isArray(r.discoveredModels)
      ? r.discoveredModels.filter((m): m is string => typeof m === "string")
      : [],
    editFormat: parseProviderEditFormat(r.editFormat),
    streaming: typeof r.streaming === "boolean" ? r.streaming : true,
    toolCalls: typeof r.toolCalls === "boolean" ? r.toolCalls : true,
    thinkingParam:
      typeof r.thinkingParam === "string" ? r.thinkingParam : emptyLlmSettings.thinkingParam,
    thinkingLevels:
      typeof r.thinkingLevels === "string" ? r.thinkingLevels : emptyLlmSettings.thinkingLevels,
    extraArgs: typeof r.extraArgs === "string" ? r.extraArgs : "",
  }
}

export async function getStoredLlmSettings(): Promise<LlmSettings> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(LLM_SETTINGS_KEY)
      req.onsuccess = () => {
        const value: unknown = req.result
        const record = typeof value === "object" && value !== null ? value : {}
        const baseUrl =
          "baseUrl" in record && typeof record.baseUrl === "string" ? record.baseUrl : ""
        const enabled =
          "enabled" in record && typeof record.enabled === "boolean"
            ? record.enabled
            : baseUrl.trim() !== ""
        const editFormat =
          "editFormat" in record && typeof record.editFormat === "string"
            ? parseEditFormat(record.editFormat)
            : emptyLlmSettings.editFormat
        const apiKey = "apiKey" in record && typeof record.apiKey === "string" ? record.apiKey : ""
        const models = "models" in record && typeof record.models === "string" ? record.models : ""
        const streaming =
          "streaming" in record && typeof record.streaming === "boolean" ? record.streaming : true
        const toolCalls =
          "toolCalls" in record && typeof record.toolCalls === "boolean" ? record.toolCalls : true
        const thinkingParam =
          "thinkingParam" in record && typeof record.thinkingParam === "string"
            ? record.thinkingParam
            : emptyLlmSettings.thinkingParam
        const thinkingLevels =
          "thinkingLevels" in record && typeof record.thinkingLevels === "string"
            ? record.thinkingLevels
            : emptyLlmSettings.thinkingLevels
        const extraArgs =
          "extraArgs" in record && typeof record.extraArgs === "string" ? record.extraArgs : ""
        const rawProviders =
          "providers" in record && Array.isArray(record.providers)
            ? record.providers
                .map((p) => parseStoredProvider(p, enabled))
                .filter((p): p is OpenAiProviderConfig => p !== null)
            : null
        const providers: ReadonlyArray<OpenAiProviderConfig> =
          rawProviders !== null
            ? rawProviders
            : baseUrl.trim() !== "" || apiKey.trim() !== "" || models.trim() !== ""
              ? [
                  {
                    id: "default",
                    name: t(getDocumentLanguage()).common.defaultName,
                    enabled,
                    baseUrl,
                    apiKey,
                    models,
                    editFormat: "",
                    streaming,
                    toolCalls,
                    thinkingParam,
                    thinkingLevels,
                    extraArgs,
                  },
                ]
              : []
        const rawActiveId =
          "activeProviderId" in record && typeof record.activeProviderId === "string"
            ? record.activeProviderId
            : ""
        const activeProvider =
          providers.find((p) => p.id === rawActiveId) ?? providers[0] ?? undefined
        const activeProviderId = activeProvider?.id ?? ""
        const effectiveEnabled = providers.length > 0 ? providers.some((p) => p.enabled) : enabled
        resolve({
          enabled: effectiveEnabled,
          providers,
          activeProviderId,
          editFormat,
          baseUrl: activeProvider?.baseUrl ?? baseUrl,
          apiKey: activeProvider?.apiKey ?? apiKey,
          models: activeProvider?.models ?? models,
          streaming: activeProvider?.streaming ?? streaming,
          toolCalls: activeProvider?.toolCalls ?? toolCalls,
          thinkingParam: activeProvider?.thinkingParam ?? thinkingParam,
          thinkingLevels: activeProvider?.thinkingLevels ?? thinkingLevels,
          extraArgs: activeProvider?.extraArgs ?? extraArgs,
        })
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der LLM-Einstellungen:", error)
    return emptyLlmSettings
  }
}

export async function storeLlmSettings(settings: LlmSettings): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put({ ...settings }, LLM_SETTINGS_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export const DEFAULT_EDITOR_SPLIT_PERCENT = 62

export const clampEditorSplitPercent = (value: number): number =>
  Math.min(85, Math.max(20, Math.round(value * 10) / 10))

export type EditorPreferences = {
  llmBarMode: "Closed" | "Chat" | "Copy"
  llmModel: string
  llmThinkingLevel: string
  editorSplitPercent: number
}

export const emptyEditorPreferences: EditorPreferences = {
  llmBarMode: "Closed",
  llmModel: "",
  llmThinkingLevel: "",
  editorSplitPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
}

const EDITOR_PREFERENCES_KEY = "editor_preferences"

export async function getStoredEditorPreferences(): Promise<EditorPreferences> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(EDITOR_PREFERENCES_KEY)
      req.onsuccess = () => {
        const value: unknown = req.result
        const record = typeof value === "object" && value !== null ? value : {}
        const llmBarMode =
          "llmBarMode" in record &&
          (record.llmBarMode === "Closed" ||
            record.llmBarMode === "Chat" ||
            record.llmBarMode === "Copy")
            ? record.llmBarMode
            : "Closed"
        const llmModel =
          "llmModel" in record && typeof record.llmModel === "string" ? record.llmModel : ""
        const llmThinkingLevel =
          "llmThinkingLevel" in record && typeof record.llmThinkingLevel === "string"
            ? record.llmThinkingLevel
            : ""
        const editorSplitPercent =
          "editorSplitPercent" in record &&
          typeof record.editorSplitPercent === "number" &&
          Number.isFinite(record.editorSplitPercent)
            ? clampEditorSplitPercent(record.editorSplitPercent)
            : DEFAULT_EDITOR_SPLIT_PERCENT
        resolve({
          llmBarMode,
          llmModel,
          llmThinkingLevel,
          editorSplitPercent,
        })
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der Editor-Einstellungen:", error)
    return emptyEditorPreferences
  }
}

export async function storeEditorPreferences(prefs: EditorPreferences): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put({ ...prefs }, EDITOR_PREFERENCES_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export type LlmChatNames = {
  aiName: string
  userName: string
}

export const DEFAULT_LLM_CHAT_AI_NAME = "KI"
export const DEFAULT_LLM_CHAT_USER_NAME = "Du"
const LLM_CHAT_NAMES_KEY = "llm_chat_names"

export async function getStoredLlmChatNames(): Promise<LlmChatNames> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(LLM_CHAT_NAMES_KEY)
      req.onsuccess = () => {
        const value: unknown = req.result
        const record = typeof value === "object" && value !== null ? value : {}
        const aiName =
          "aiName" in record && typeof record.aiName === "string" && record.aiName.trim() !== ""
            ? record.aiName.trim()
            : DEFAULT_LLM_CHAT_AI_NAME
        const userName =
          "userName" in record &&
          typeof record.userName === "string" &&
          record.userName.trim() !== ""
            ? record.userName.trim()
            : DEFAULT_LLM_CHAT_USER_NAME
        resolve({ aiName, userName })
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der KI-Chat-Namen:", error)
    return { aiName: DEFAULT_LLM_CHAT_AI_NAME, userName: DEFAULT_LLM_CHAT_USER_NAME }
  }
}

export async function storeLlmChatNames(names: LlmChatNames): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put({ ...names }, LLM_CHAT_NAMES_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export const AppThemeSchema = Schema.Literals(["system", "light", "dark"])
export type AppTheme = typeof AppThemeSchema.Type

const APP_THEME_KEY = "app_theme"

const isAppTheme = (value: unknown): value is AppTheme =>
  value === "system" || value === "light" || value === "dark"

export async function getStoredAppTheme(): Promise<AppTheme> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(APP_THEME_KEY)
      req.onsuccess = () => {
        resolve(isAppTheme(req.result) ? req.result : "system")
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen des App-Themes:", error)
    return "system"
  }
}

export async function storeAppTheme(theme: AppTheme): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put(theme, APP_THEME_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

const APP_LANGUAGE_KEY = "app_language"

export async function getStoredLanguage(): Promise<Option.Option<Language>> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(APP_LANGUAGE_KEY)
      req.onsuccess = () => {
        resolve(isLanguage(req.result) ? Option.some(req.result) : Option.none())
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der Sprache:", error)
    return Option.none()
  }
}

export async function storeLanguage(language: Language): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put(language, APP_LANGUAGE_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

const APP_DATE_FORMAT_KEY = "app_date_format"
const APP_TIME_FORMAT_KEY = "app_time_format"

export async function getStoredDateFormat(): Promise<DateFormat> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(APP_DATE_FORMAT_KEY)
      req.onsuccess = () => {
        resolve(isDateFormat(req.result) ? req.result : "auto")
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen des Datumsformats:", error)
    return "auto"
  }
}

export async function storeDateFormat(format: DateFormat): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put(format, APP_DATE_FORMAT_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function getStoredTimeFormat(): Promise<TimeFormat> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(APP_TIME_FORMAT_KEY)
      req.onsuccess = () => {
        resolve(isTimeFormat(req.result) ? req.result : "auto")
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen des Zeitformats:", error)
    return "auto"
  }
}

export async function storeTimeFormat(format: TimeFormat): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put(format, APP_TIME_FORMAT_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export const MonacoThemeSchema = Schema.Literals([
  "system",
  "vs",
  "vs-dark",
  "hc-black",
  "hc-light",
])
export type MonacoTheme = typeof MonacoThemeSchema.Type

export const MonacoSettingsSchema = Schema.Struct({
  lineNumbers: Schema.Boolean,
  folding: Schema.Boolean,
  wordWrap: Schema.Boolean,
  scrollBeyondLastLine: Schema.Boolean,
  theme: MonacoThemeSchema,
  lineDecorationsWidth: Schema.Number,
  lineNumbersMinChars: Schema.Number,
  undoInTitlebar: Schema.Boolean,
})
export type MonacoSettings = typeof MonacoSettingsSchema.Type

export const defaultMonacoSettings: MonacoSettings = {
  lineNumbers: true,
  folding: true,
  wordWrap: true,
  scrollBeyondLastLine: true,
  theme: "system",
  lineDecorationsWidth: 10,
  lineNumbersMinChars: 5,
  undoInTitlebar: false,
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)))

const MONACO_SETTINGS_KEY = "monaco_settings"

const isMonacoTheme = (value: unknown): value is MonacoTheme =>
  value === "system" ||
  value === "vs" ||
  value === "vs-dark" ||
  value === "hc-black" ||
  value === "hc-light"

export async function getStoredMonacoSettings(): Promise<MonacoSettings> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(MONACO_SETTINGS_KEY)
      req.onsuccess = () => {
        const value: unknown = req.result
        const record = typeof value === "object" && value !== null ? value : {}
        const lineNumbers =
          "lineNumbers" in record && typeof record.lineNumbers === "boolean"
            ? record.lineNumbers
            : defaultMonacoSettings.lineNumbers
        const folding =
          "folding" in record && typeof record.folding === "boolean"
            ? record.folding
            : defaultMonacoSettings.folding
        const wordWrap =
          "wordWrap" in record && typeof record.wordWrap === "boolean"
            ? record.wordWrap
            : defaultMonacoSettings.wordWrap
        const scrollBeyondLastLine =
          "scrollBeyondLastLine" in record && typeof record.scrollBeyondLastLine === "boolean"
            ? record.scrollBeyondLastLine
            : defaultMonacoSettings.scrollBeyondLastLine
        const theme =
          "theme" in record && isMonacoTheme(record.theme)
            ? record.theme
            : defaultMonacoSettings.theme
        const lineDecorationsWidth =
          "lineDecorationsWidth" in record &&
          typeof record.lineDecorationsWidth === "number" &&
          Number.isFinite(record.lineDecorationsWidth)
            ? clampInt(record.lineDecorationsWidth, 0, 32)
            : defaultMonacoSettings.lineDecorationsWidth
        const lineNumbersMinChars =
          "lineNumbersMinChars" in record &&
          typeof record.lineNumbersMinChars === "number" &&
          Number.isFinite(record.lineNumbersMinChars)
            ? clampInt(record.lineNumbersMinChars, 0, 10)
            : defaultMonacoSettings.lineNumbersMinChars
        const undoInTitlebar =
          "undoInTitlebar" in record && typeof record.undoInTitlebar === "boolean"
            ? record.undoInTitlebar
            : defaultMonacoSettings.undoInTitlebar
        resolve({
          lineNumbers,
          folding,
          wordWrap,
          scrollBeyondLastLine,
          theme,
          lineDecorationsWidth,
          lineNumbersMinChars,
          undoInTitlebar,
        })
      }
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der Monaco-Einstellungen:", error)
    return defaultMonacoSettings
  }
}

export async function storeMonacoSettings(settings: MonacoSettings): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const req = tx.objectStore(STORE_NAME).put({ ...settings }, MONACO_SETTINGS_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function clearStoredStorageType(): Promise<void> {
  invalidateRootCache()
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(STORAGE_TYPE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function getOPFSDirectoryHandle(): Promise<Option.Option<FileSystemDirectoryHandle>> {
  if (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function"
  ) {
    try {
      const root = await navigator.storage.getDirectory()
      return Option.some(await root.getDirectoryHandle(OPFS_APP_FOLDER, { create: true }))
    } catch (err) {
      console.error("Fehler beim Abrufen des OPFS-Handles:", err)
      return Option.none()
    }
  }
  return Option.none()
}

export async function collectDirectoryHandles(
  dir: FileSystemDirectoryHandle,
): Promise<ReadonlyArray<FileSystemDirectoryHandle | FileSystemFileHandle>> {
  if (typeof dir.values === "function") {
    const chunk = await Effect.runPromise(
      Stream.runCollect(
        Stream.fromAsyncIterable(
          dir.values(),
          (cause) =>
            new DirectoryIterationError({
              message: t(getDocumentLanguage()).errors.dirReadEntriesFailed,
              cause,
            }),
        ),
      ),
    )
    return Array.fromIterable(chunk)
  }
  if (typeof dir.entries === "function") {
    const chunk = await Effect.runPromise(
      Stream.runCollect(
        Stream.map(
          Stream.fromAsyncIterable(
            dir.entries(),
            (cause) =>
              new DirectoryIterationError({
                message: t(getDocumentLanguage()).errors.dirReadEntriesFailed,
                cause,
              }),
          ),
          ([, handle]) => handle,
        ),
      ),
    )
    return Array.fromIterable(chunk)
  }
  throw new Error(t(getDocumentLanguage()).errors.dirHandleNoIteration)
}

export const DEFAULT_INDEX_FILE = "index.html"

export interface SavedFile {
  file: File
  path: string
}

const MISS_ERRORS = new Set(["NotFoundError", "TypeMismatchError"])

async function walkToParent(
  root: FileSystemDirectoryHandle,
  segments: ReadonlyArray<string>,
): Promise<Option.Option<FileSystemDirectoryHandle>> {
  return await Array.reduce(
    segments,
    Promise.resolve(Option.some(root)),
    async (currentPromise, segment) => {
      const maybeCurrent = await currentPromise
      if (Option.isNone(maybeCurrent)) {
        return Option.none<FileSystemDirectoryHandle>()
      }
      try {
        return Option.some(await maybeCurrent.value.getDirectoryHandle(segment))
      } catch (err) {
        if (err instanceof DOMException && MISS_ERRORS.has(err.name)) {
          return Option.none<FileSystemDirectoryHandle>()
        }
        throw err
      }
    },
  )
}

// NOTE: Resolves as direct file first, falling back to folder index.html
export async function resolveFileInDirectory(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  indexFile = DEFAULT_INDEX_FILE,
): Promise<Option.Option<SavedFile>> {
  const parts = splitPath(relativePath)
  if (!Array.isReadonlyArrayNonEmpty(parts)) {
    return Option.none()
  }

  const maybeParent = await walkToParent(root, Array.dropRight(parts, 1))
  if (Option.isNone(maybeParent)) {
    return Option.none()
  }
  const parent = maybeParent.value

  const name = Array.lastNonEmpty(parts)
  const filePath = parts.join("/")

  try {
    const fileHandle = await parent.getFileHandle(name)
    return Option.some({ file: await fileHandle.getFile(), path: filePath })
  } catch (err) {
    if (!(err instanceof DOMException && MISS_ERRORS.has(err.name))) {
      throw err
    }
  }

  if (!indexFile) {
    return Option.none()
  }
  try {
    const dir = await parent.getDirectoryHandle(name)
    const fileHandle = await dir.getFileHandle(indexFile)
    return Option.some({ file: await fileHandle.getFile(), path: `${filePath}/${indexFile}` })
  } catch (err) {
    if (err instanceof DOMException && MISS_ERRORS.has(err.name)) {
      return Option.none()
    }
    throw err
  }
}

export function invalidateRootCache(): void {
  storageCache.root = Option.none()
}

// NOTE: Missing directory permission is intentionally un-cached so user prompts re-trigger
async function findCachedActiveStorage(): Promise<Option.Option<FileSystemDirectoryHandle>> {
  return await Option.match(storageCache.root, {
    onSome: (root) => Promise.resolve(Option.some(root)),
    onNone: async () => {
      const maybeRoot = await findActiveStorage()
      if (Option.isSome(maybeRoot)) {
        storageCache.root = maybeRoot
      }
      return maybeRoot
    },
  })
}

export async function findSavedFile(
  relativePath: string,
  indexFile = DEFAULT_INDEX_FILE,
): Promise<Option.Option<SavedFile>> {
  const parts = splitPath(relativePath)
  if (Array.isReadonlyArrayEmpty(parts)) {
    return Option.none()
  }

  try {
    const maybeStoredType = await getStoredStorageType()
    if (Option.exists(maybeStoredType, (t) => t === "tauri")) {
      try {
        const joined = parts.join("/")
        const existsDirect = await invoke<boolean>("tauri_fs_exists", { subPath: joined })
        if (existsDirect) {
          const buffer = await invoke<ArrayBuffer>("tauri_fs_read_file", { subPath: joined })
          const fileName = Array.isReadonlyArrayNonEmpty(parts)
            ? Array.lastNonEmpty(parts)
            : DEFAULT_INDEX_FILE
          const file = new File([buffer], fileName)
          return Option.some({ file, path: joined })
        }
        if (indexFile) {
          const indexPath = `${joined}/${indexFile}`
          const existsIndex = await invoke<boolean>("tauri_fs_exists", { subPath: indexPath })
          if (existsIndex) {
            const buffer = await invoke<ArrayBuffer>("tauri_fs_read_file", { subPath: indexPath })
            const file = new File([buffer], indexFile)
            return Option.some({ file, path: indexPath })
          }
        }
        return Option.none()
      } catch (err) {
        console.warn("findSavedFile Tauri Fehler:", err)
        return Option.none()
      }
    }

    const maybeRoot = await findCachedActiveStorage()
    if (Option.isNone(maybeRoot)) {
      return Option.none()
    }
    return await resolveFileInDirectory(maybeRoot.value, relativePath, indexFile)
  } catch (err) {
    console.warn("findSavedFile Fehler:", err)
    return Option.none()
  }
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  zip: "application/zip",
}

export function normalizePath(path: string): string {
  return (path ?? "").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")
}

export function splitPath(path: string): ReadonlyArray<string> {
  const clean = normalizePath(path)
  return clean ? Array.filter(clean.split("/"), Boolean) : []
}

export async function findActiveStorage(): Promise<Option.Option<FileSystemDirectoryHandle>> {
  try {
    const maybeStoredType = await getStoredStorageType()
    if (Option.exists(maybeStoredType, (storedType) => storedType === "opfs")) {
      try {
        return await getOPFSDirectoryHandle()
      } catch (err) {
        console.warn("findActiveStorage OPFS Fehler:", err)
        return Option.none()
      }
    }

    const maybeStoredHandle = await getStoredDirectoryHandle()
    if (Option.isSome(maybeStoredHandle)) {
      const storedHandle = maybeStoredHandle.value
      const perm: PermissionState = storedHandle.queryPermission
        ? await storedHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const)
        : "granted"
      if (perm === "granted") {
        return maybeStoredHandle
      }
    }

    if (Option.isNone(maybeStoredType)) {
      return await getOPFSDirectoryHandle()
    }
  } catch (err) {
    console.warn("findActiveStorage Fehler:", err)
  }

  return Option.none()
}

export async function getDirectory(
  root: FileSystemDirectoryHandle,
  dirs: ReadonlyArray<string>,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  return await Array.reduce(dirs, Promise.resolve(root), async (currentPromise, segment) =>
    (await currentPromise).getDirectoryHandle(segment, { create }),
  )
}

export function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".")
  return dotIndex === -1 || dotIndex === fileName.length - 1
    ? ""
    : fileName.slice(dotIndex + 1).toLowerCase()
}

export function getMimeType(filename: string, fallback?: string): string {
  const ext = getFileExtension(filename)
  if (ext in MIME_TYPES) {
    return MIME_TYPES[ext]
  }
  return fallback && fallback !== "" ? fallback : "application/octet-stream"
}

// TEXT VALIDATION

export type TextCheck =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "binary"; reason: string }

// NOTE: fatal: true throws on invalid UTF-8; ignoreBOM: true preserves BOM across roundtrip
export function checkTextBytes(bytes: Uint8Array): TextCheck {
  if (bytes.byteLength === 0) {
    return { kind: "empty" }
  }

  const decoded = decodeUtf8Strict(bytes)
  if (Option.isNone(decoded)) {
    return { kind: "binary", reason: t(getDocumentLanguage()).errors.invalidUtf8 }
  }
  const text = decoded.value

  const roundTrip = new TextEncoder().encode(text)
  if (roundTrip.byteLength !== bytes.byteLength) {
    return {
      kind: "binary",
      reason: t(getDocumentLanguage()).errors.utf8ByteLengthMismatch(
        bytes.byteLength,
        roundTrip.byteLength,
      ),
    }
  }

  const firstMismatch = bytes.findIndex((found, index) => found !== roundTrip[index])
  if (firstMismatch !== -1) {
    return {
      kind: "binary",
      reason: t(getDocumentLanguage()).errors.utf8ByteMismatch(
        firstMismatch,
        bytes[firstMismatch],
        roundTrip[firstMismatch],
      ),
    }
  }

  return { kind: "text", text }
}

export async function checkTextBlob(blob: Blob): Promise<TextCheck> {
  return checkTextBytes(new Uint8Array(await blob.arrayBuffer()))
}

export async function readTextOrThrow(blob: Blob, path: string): Promise<string> {
  const result = await checkTextBlob(blob)
  if (result.kind === "binary") {
    throw new Error(t(getDocumentLanguage()).errors.fileNotValidUtf8(result.reason, path))
  }
  return result.kind === "text" ? result.text : ""
}

export async function copyDirectory(
  source: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
  name?: string,
): Promise<void> {
  const destDir =
    name !== undefined ? await target.getDirectoryHandle(name, { create: true }) : target
  const entries = await collectDirectoryHandles(source).catch(() => [])
  await Array.reduce(entries, Promise.resolve(), async (previous, entry) => {
    await previous
    if (entry.kind === "file") {
      const blob = await entry.getFile()
      const fileHandle = await destDir.getFileHandle(entry.name, { create: true })
      const writable = await fileHandle.createWritable()
      try {
        await writable.write(blob)
      } finally {
        await writable.close()
      }
    } else {
      await copyDirectory(entry, destDir, entry.name)
    }
  })
}

function decodeUtf8Strict(bytes: Uint8Array): Option.Option<string> {
  try {
    return Option.some(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return Option.none()
  }
}

export interface StoredUserTemplate {
  readonly id: string
  readonly label: string
  readonly defaultFileName: string
  readonly content: string
}

export const FS_TEMPLATES_FOLDER = "Vorlagen"
export const OPFS_TEMPLATES_FOLDER = "PWA Islands Vorlagen"
export const TAURI_TEMPLATES_FOLDER = "Vorlagen"

async function getTemplatesDir(
  type: string,
  rootHandle: FileSystemDirectoryHandle,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  if (type === "opfs") {
    const realRoot = await navigator.storage.getDirectory()
    return realRoot.getDirectoryHandle(OPFS_TEMPLATES_FOLDER, { create })
  }
  return rootHandle.getDirectoryHandle(FS_TEMPLATES_FOLDER, { create })
}

// NOTE: label doubles as file name; strip chars illegal on common filesystems
export const sanitizeTemplateName = (label: string): string => {
  const noControl = Array.join(
    Array.filter(Array.fromIterable(label), (ch) => ch.charCodeAt(0) >= 32),
    "",
  )
  const cleaned = noControl
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim()
    .replace(/[. ]+$/, "")
  return cleaned === "" ? t(getDocumentLanguage()).editor.templateFallbackName : cleaned
}

export async function getStoredUserTemplates(
  type: string,
  rootHandle: FileSystemDirectoryHandle | null,
): Promise<ReadonlyArray<StoredUserTemplate>> {
  if (type === "tauri") {
    try {
      const files = await invoke<
        ReadonlyArray<{
          name: string
          isDirectory: boolean
          size: number | null
          lastModified: number | null
        }>
      >("tauri_fs_list_entries", { subPath: TAURI_TEMPLATES_FOLDER })
      const textFiles = Array.filter(files, (f) => !f.isDirectory)
      const results = await Promise.all(
        Array.map(textFiles, async (f): Promise<ReadonlyArray<StoredUserTemplate>> => {
          try {
            const data = await invoke<ArrayBuffer>("tauri_fs_read_file", {
              subPath: `${TAURI_TEMPLATES_FOLDER}/${f.name}`,
            })
            const bytes = new Uint8Array(data)
            const text = decodeUtf8Strict(bytes)
            if (Option.isNone(text)) return []
            return [
              {
                id: `user:${f.name}`,
                label: f.name,
                defaultFileName: f.name,
                content: text.value,
              },
            ]
          } catch {
            return []
          }
        }),
      )
      return Array.flatten(results)
    } catch (err) {
      console.warn("Fehler beim Abrufen der Benutzervorlagen aus Tauri:", err)
      return []
    }
  }

  if (!rootHandle) {
    return []
  }

  try {
    const dir = await getTemplatesDir(type, rootHandle, false)
    const handles = await collectDirectoryHandles(dir)
    const results = await Promise.all(
      Array.map(
        Array.filter(handles, (h) => h.kind === "file"),
        async (h): Promise<ReadonlyArray<StoredUserTemplate>> => {
          try {
            const file = await (h as FileSystemFileHandle).getFile()
            const bytes = new Uint8Array(await file.arrayBuffer())
            const text = decodeUtf8Strict(bytes)
            if (Option.isNone(text)) return []
            return [
              {
                id: `user:${h.name}`,
                label: h.name,
                defaultFileName: h.name,
                content: text.value,
              },
            ]
          } catch {
            return []
          }
        },
      ),
    )
    return Array.flatten(results)
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return []
    console.error("Fehler beim Abrufen der Benutzervorlagen:", error)
    return []
  }
}

export async function saveUserTemplate(
  type: string,
  rootHandle: FileSystemDirectoryHandle | null,
  name: string,
  content: string,
): Promise<void> {
  const fileName = sanitizeTemplateName(name)
  if (type === "tauri") {
    const bytes = new TextEncoder().encode(content)
    await invoke("tauri_fs_write_file", {
      subPath: `${TAURI_TEMPLATES_FOLDER}/${fileName}`,
      data: globalThis.Array.from(bytes),
    })
    return
  }

  if (!rootHandle) {
    return
  }

  const dir = await getTemplatesDir(type, rootHandle, true)
  const fh = await dir.getFileHandle(fileName, { create: true })
  const w = await fh.createWritable()
  try {
    await w.write(content)
  } finally {
    await w.close()
  }
}

export async function deleteUserTemplate(
  type: string,
  rootHandle: FileSystemDirectoryHandle | null,
  name: string,
): Promise<void> {
  const fileName = sanitizeTemplateName(name)
  if (type === "tauri") {
    await invoke("tauri_fs_remove_entry", {
      subPath: `${TAURI_TEMPLATES_FOLDER}/${fileName}`,
      isDirectory: false,
    })
    return
  }

  if (!rootHandle) {
    return
  }

  try {
    const dir = await getTemplatesDir(type, rootHandle, false)
    await dir.removeEntry(fileName)
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return
    console.error("Fehler beim Löschen der Benutzervorlage:", error)
  }
}
