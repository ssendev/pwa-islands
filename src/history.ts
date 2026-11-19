import { invoke } from "@tauri-apps/api/core"
import { Array, Effect, Option, Stream } from "effect"
import { supportsTauri } from "./files"
import { getStoredApiHistoryEnabled, normalizePath, splitPath } from "./storage"

export const OPFS_HISTORY_FOLDER = "pwa-islands-history"

// Binary format contract: must match `src-tauri/src/lib.rs` (`HISTORY_TRAILER_SIZE_BYTES = 16`, LE) exactly
const TRAILER_SIZE_BYTES = 16
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8")

export interface HistoryRecord {
  readonly content: string
  readonly timestampMs: number
  readonly contentHash: number
  readonly startOffset: number
  readonly endOffset: number
}

export interface HistoryBytesRecord {
  readonly bytes: Uint8Array
  readonly timestampMs: number
  readonly contentHash: number
  readonly startOffset: number
  readonly endOffset: number
}

export interface HistoryEntryMeta {
  readonly offset: number
  readonly endOffset: number
  readonly timestampMs: number
  readonly byteLength: number
  readonly contentHash: number
}

/**
 * Computes a deterministic 32-bit FNV-1a hash over UTF-8 bytes.
 */
export const hashContentBytes = (bytes: Uint8Array): number =>
  bytes.reduce((acc, byte) => Math.imul(acc ^ byte, FNV_PRIME), FNV_OFFSET_BASIS) >>> 0

/**
 * Computes the 32-bit hash and UTF-8 byte length for a text content.
 */
export const hashAndMeasureHistoryContent = (
  content: string,
): { readonly contentHash: number; readonly byteLength: number } => {
  const bytes = textEncoder.encode(content)
  return {
    contentHash: hashContentBytes(bytes),
    byteLength: bytes.byteLength,
  }
}

/**
 * Computes the 32-bit hash for a text content.
 */
export const hashHistoryContent = (content: string): number =>
  hashAndMeasureHistoryContent(content).contentHash

/**
 * Encodes a version entry as a binary block for the append-only history:
 * `[UTF-8 Content] [Hash (Uint32 LE, 4 Bytes)] [Timestamp (Float64 LE, 8 Bytes)] [Content Length (Uint32 LE, 4 Bytes)]`.
 */
export const encodeHistoryBytesRecord = (
  contentBytes: Uint8Array,
  timestampMs: number,
  contentHash = hashContentBytes(contentBytes),
): Uint8Array => {
  const record = new Uint8Array(contentBytes.byteLength + TRAILER_SIZE_BYTES)
  record.set(contentBytes, 0)
  const view = new DataView(
    record.buffer,
    record.byteOffset + contentBytes.byteLength,
    TRAILER_SIZE_BYTES,
  )
  view.setUint32(0, contentHash, true)
  view.setFloat64(4, timestampMs, true)
  view.setUint32(12, contentBytes.byteLength, true)
  return record
}

export const encodeHistoryRecord = (content: string, timestampMs: number): Uint8Array =>
  encodeHistoryBytesRecord(textEncoder.encode(content), timestampMs)

export type SliceReader = (start: number, end: number) => Promise<ArrayBuffer>

/**
 * Reads only the 16-byte header (hash + timestamp + length) from `endOffset` without loading the content.
 */
export const readHistoryMetaAt = async (
  readSlice: SliceReader,
  endOffset: number,
): Promise<Option.Option<HistoryEntryMeta>> => {
  if (endOffset < TRAILER_SIZE_BYTES) {
    return Option.none()
  }

  const trailerBuffer = await readSlice(endOffset - TRAILER_SIZE_BYTES, endOffset)
  if (trailerBuffer.byteLength < TRAILER_SIZE_BYTES) {
    return Option.none()
  }

  const trailerView = new DataView(trailerBuffer)
  const contentHash = trailerView.getUint32(0, true)
  const timestampMs = trailerView.getFloat64(4, true)
  const contentLength = trailerView.getUint32(12, true)
  const startOffset = endOffset - TRAILER_SIZE_BYTES - contentLength

  if (startOffset < 0) {
    return Option.none()
  }

  return Option.some({
    offset: startOffset,
    endOffset,
    timestampMs,
    byteLength: contentLength,
    contentHash,
  })
}

/**
 * Reads exactly one entry backwards from `endOffset` using the length stored at the end.
 */
export const readHistoryBytesRecordAt = async (
  readSlice: SliceReader,
  endOffset: number,
): Promise<Option.Option<HistoryBytesRecord>> => {
  const maybeMeta = await readHistoryMetaAt(readSlice, endOffset)
  if (Option.isNone(maybeMeta)) {
    return Option.none()
  }
  const meta = maybeMeta.value

  const contentBuffer = await readSlice(meta.offset, endOffset - TRAILER_SIZE_BYTES)
  if (contentBuffer.byteLength !== meta.byteLength) {
    return Option.none()
  }

  return Option.some({
    bytes: new Uint8Array(contentBuffer),
    timestampMs: meta.timestampMs,
    contentHash: meta.contentHash,
    startOffset: meta.offset,
    endOffset,
  })
}

export const readHistoryRecordAt = async (
  readSlice: SliceReader,
  endOffset: number,
): Promise<Option.Option<HistoryRecord>> => {
  const maybeRecord = await readHistoryBytesRecordAt(readSlice, endOffset)
  return Option.map(maybeRecord, (record) => ({
    content: textDecoder.decode(record.bytes),
    timestampMs: record.timestampMs,
    contentHash: record.contentHash,
    startOffset: record.startOffset,
    endOffset: record.endOffset,
  }))
}

/**
 * Reads all offsets and timestamps of a binary history file (newest version first),
 * ohne die Version-Inhalte zu laden.
 */
export const readAllHistoryMeta = async (
  readSlice: SliceReader,
  totalSize: number,
): Promise<ReadonlyArray<HistoryEntryMeta>> => {
  const collect = async (
    cursor: number,
    acc: ReadonlyArray<HistoryEntryMeta>,
  ): Promise<ReadonlyArray<HistoryEntryMeta>> => {
    if (cursor < TRAILER_SIZE_BYTES) {
      return acc
    }
    const maybeMeta = await readHistoryMetaAt(readSlice, cursor)
    if (Option.isNone(maybeMeta)) {
      return acc
    }
    return collect(maybeMeta.value.offset, [...acc, maybeMeta.value])
  }

  return collect(totalSize, [])
}

const getOpfsHistoryDirectory = async (
  subPath: ReadonlyArray<string>,
  create: boolean,
): Promise<Option.Option<FileSystemDirectoryHandle>> => {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    return Option.none()
  }
  try {
    const root = await navigator.storage.getDirectory()
    const historyRoot = await root.getDirectoryHandle(OPFS_HISTORY_FOLDER, { create })
    const dir = await subPath.reduce<Promise<FileSystemDirectoryHandle>>(
      async (parentPromise, segment) => {
        const parent = await parentPromise
        return parent.getDirectoryHandle(segment, { create })
      },
      Promise.resolve(historyRoot),
    )
    return Option.some(dir)
  } catch {
    return Option.none()
  }
}

interface HistoryFileStore {
  readonly getSize: () => Promise<number>
  readonly readSlice: SliceReader
  readonly readIndex: () => Promise<ReadonlyArray<HistoryEntryMeta>>
  readonly append: (record: Uint8Array) => Promise<void>
  readonly truncate: (size: number) => Promise<void>
  readonly clear: () => Promise<void>
}

const getTauriHistoryFileStore = (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Option.Option<HistoryFileStore> => {
  const pathSegments = [...subPath]
  return Option.some({
    getSize: () =>
      invoke<number>("tauri_history_size", {
        subPath: pathSegments,
        fileName,
      }),
    readSlice: (start, end) =>
      invoke<ArrayBuffer>("tauri_history_read_slice", {
        subPath: pathSegments,
        fileName,
        start,
        end,
      }),
    readIndex: () =>
      invoke<ReadonlyArray<HistoryEntryMeta>>("tauri_history_read_index", {
        subPath: pathSegments,
        fileName,
      }),
    append: (record) =>
      invoke("tauri_history_append", {
        subPath: pathSegments,
        fileName,
        data: globalThis.Array.from(record),
      }),
    truncate: (size) =>
      invoke("tauri_history_truncate", {
        subPath: pathSegments,
        fileName,
        size,
      }),
    clear: () =>
      invoke("tauri_history_clear", {
        subPath: pathSegments,
        fileName,
      }),
  })
}

const getOpfsHistoryFileStore = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  create: boolean,
): Promise<Option.Option<HistoryFileStore>> => {
  const maybeDir = await getOpfsHistoryDirectory(subPath, create)
  if (Option.isNone(maybeDir)) {
    return Option.none()
  }
  const dir = maybeDir.value
  let fileHandle: FileSystemFileHandle
  try {
    fileHandle = await dir.getFileHandle(fileName, { create })
  } catch {
    return Option.none()
  }
  let cachedFilePromise: Promise<File> | undefined
  const getFile = () => {
    if (cachedFilePromise === undefined) {
      cachedFilePromise = fileHandle.getFile()
    }
    return cachedFilePromise
  }
  const clear = async () => {
    try {
      await dir.removeEntry(fileName)
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return
      }
      throw error
    }
  }
  const getSize = async () => (await getFile()).size
  const readSlice: SliceReader = async (start, end) =>
    (await getFile()).slice(start, end).arrayBuffer()
  return Option.some({
    getSize,
    readSlice,
    readIndex: async () => {
      const size = await getSize()
      return size === 0 ? [] : readAllHistoryMeta(readSlice, size)
    },
    append: async (record) => {
      const file = await fileHandle.getFile()
      const writable = await fileHandle.createWritable({ keepExistingData: true })
      try {
        await writable.seek(file.size)
        await writable.write(new Uint8Array(record))
      } finally {
        await writable.close()
      }
    },
    truncate: async (size) => {
      if (size === 0) {
        await clear()
        return
      }
      const writable = await fileHandle.createWritable({ keepExistingData: true })
      try {
        await writable.truncate(size)
      } finally {
        await writable.close()
      }
    },
    clear,
  })
}

const getHistoryFileStore = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  create: boolean,
): Promise<Option.Option<HistoryFileStore>> =>
  supportsTauri()
    ? getTauriHistoryFileStore(subPath, fileName)
    : getOpfsHistoryFileStore(subPath, fileName, create)

const isSameAsLatestVersion = async (
  store: HistoryFileStore,
  oldBytes: Uint8Array,
  contentHash: number,
): Promise<boolean> => {
  const size = await store.getSize()
  if (size < TRAILER_SIZE_BYTES) {
    return false
  }
  const maybeLatestMeta = await readHistoryMetaAt(store.readSlice, size)
  if (Option.isNone(maybeLatestMeta)) {
    return false
  }
  const latestMeta = maybeLatestMeta.value
  if (latestMeta.byteLength !== oldBytes.byteLength || latestMeta.contentHash !== contentHash) {
    return false
  }
  const maybeLatestRecord = await readHistoryBytesRecordAt(store.readSlice, size)
  if (Option.isNone(maybeLatestRecord)) {
    return false
  }
  const latestBytes = maybeLatestRecord.value.bytes
  return (
    latestBytes.byteLength === oldBytes.byteLength &&
    oldBytes.every((byte, index) => byte === latestBytes[index])
  )
}

/**
 * Appends the old file content including modification timestamp to the history file
 * (in Tauri im internen App-Speicher, im Browser im OPFS) an, sofern er sich
 * von der zuletzt gespeicherten Version unterscheidet.
 */
export const appendFileHistoryBytes = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  oldBytes: Uint8Array,
  timestampMs: number,
): Promise<void> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, true)
  if (Option.isNone(maybeStore)) {
    return
  }
  const contentHash = hashContentBytes(oldBytes)
  if (await isSameAsLatestVersion(maybeStore.value, oldBytes, contentHash)) {
    return
  }
  const record = encodeHistoryBytesRecord(oldBytes, timestampMs, contentHash)
  await maybeStore.value.append(record)
}

export const appendFileHistory = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  oldContent: string,
  timestampMs: number,
): Promise<void> =>
  appendFileHistoryBytes(subPath, fileName, textEncoder.encode(oldContent), timestampMs)

const splitTauriApiEntryPath = (
  path: string,
): Option.Option<{ readonly dirs: ReadonlyArray<string>; readonly name: string }> => {
  const parts = splitPath(normalizePath(path))
  if (!Array.isReadonlyArrayNonEmpty(parts)) {
    return Option.none()
  }
  return Option.some({
    dirs: Array.dropRight(parts, 1),
    name: Array.lastNonEmpty(parts),
  })
}

const recordTauriApiPathVersions = async (
  cleanPath: string,
  timestampMs: number,
): Promise<void> => {
  const maybeEntry = splitTauriApiEntryPath(cleanPath)
  if (Option.isNone(maybeEntry)) {
    return
  }
  try {
    const buffer = await invoke<ArrayBuffer>("tauri_fs_read_file", {
      subPath: cleanPath,
    })
    await appendFileHistoryBytes(
      maybeEntry.value.dirs,
      maybeEntry.value.name,
      new Uint8Array(buffer),
      timestampMs,
    )
    return
  } catch {
    // Cannot read as file — check if it is a directory
  }
  const entries = await invoke<ReadonlyArray<{ readonly name: string }>>("tauri_fs_list_entries", {
    subPath: cleanPath,
  })
  await entries.reduce<Promise<void>>(async (acc, entry) => {
    await acc
    await recordTauriApiPathVersions(`${cleanPath}/${entry.name}`, timestampMs)
  }, Promise.resolve())
}

/**
 * Sichert vor einer mutierenden api.js-Operation in Tauri die bisherige Version
 * der betroffenen Datei (bzw. rekursiv aller Dateien eines Ordners).
 */
export const recordPreviousTauriApiFileVersion = async (
  path: string,
  timestampMs: number,
): Promise<void> => {
  try {
    if (!(await getStoredApiHistoryEnabled())) {
      return
    }
    const cleanPath = normalizePath(path)
    if (!cleanPath) {
      return
    }
    const exists = await invoke<boolean>("tauri_fs_exists", { subPath: cleanPath })
    if (!exists) {
      return
    }
    await recordTauriApiPathVersions(cleanPath, timestampMs)
  } catch {
    // NOTE: Missing source file or history errors must not block api.js operations
  }
}

/**
 * Reads the next older version from `maybeCursor` (or from end of file when `Option.none()`).
 */
export const loadPreviousFileHistoryEntry = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  maybeCursor: Option.Option<number>,
): Promise<Option.Option<HistoryRecord>> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, false)
  if (Option.isNone(maybeStore)) {
    return Option.none()
  }
  const totalSize = await maybeStore.value.getSize()
  if (totalSize === 0) {
    return Option.none()
  }
  const cursor = Option.match(maybeCursor, {
    onNone: () => totalSize,
    onSome: (offset) => Math.min(offset, totalSize),
  })
  return readHistoryRecordAt(maybeStore.value.readSlice, cursor)
}

/**
 * Loads only offsets, sizes, and timestamps of all saved versions of a file (newest first).
 */
export const loadFileHistoryIndex = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<ReadonlyArray<HistoryEntryMeta>> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, false)
  if (Option.isNone(maybeStore)) {
    return []
  }
  return maybeStore.value.readIndex()
}

/**
 * Jumps directly to `endOffset` in the history file, re-verifies the header, and loads the content.
 */
export const loadFileHistoryEntryAt = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  endOffset: number,
): Promise<Option.Option<HistoryRecord>> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, false)
  if (Option.isNone(maybeStore)) {
    return Option.none()
  }
  const totalSize = await maybeStore.value.getSize()
  if (endOffset > totalSize) {
    return Option.none()
  }
  return readHistoryRecordAt(maybeStore.value.readSlice, endOffset)
}

export const loadFileHistoryBytesAt = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  endOffset: number,
): Promise<Option.Option<HistoryBytesRecord>> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, false)
  if (Option.isNone(maybeStore)) {
    return Option.none()
  }
  return readHistoryBytesRecordAt(maybeStore.value.readSlice, endOffset)
}

/**
 * Entfernt nur den neuesten Eintrag am Dateiende durch Trunkieren der Verlaufsdatei.
 */
export const truncateLatestFileHistoryEntry = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<void> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, false)
  if (Option.isNone(maybeStore)) {
    return
  }
  const totalSize = await maybeStore.value.getSize()
  if (totalSize === 0) {
    return
  }
  const maybeMeta = await readHistoryMetaAt(maybeStore.value.readSlice, totalSize)
  if (Option.isNone(maybeMeta)) {
    return
  }
  await maybeStore.value.truncate(maybeMeta.value.offset)
}

export const hasFileHistory = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<boolean> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, false)
  if (Option.isNone(maybeStore)) {
    return false
  }
  return (await maybeStore.value.getSize()) > 0
}

/**
 * Lists all file names in the history folder for `subPath` that have at least one entry.
 */
export const listHistoryFileNames = async (
  subPath: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  try {
    if (supportsTauri()) {
      return await invoke<ReadonlyArray<string>>("tauri_history_list_entries", {
        subPath: [...subPath],
      })
    }
    const maybeDir = await getOpfsHistoryDirectory(subPath, false)
    if (Option.isNone(maybeDir)) {
      return []
    }
    const dir = maybeDir.value
    const dirWithValues = dir as unknown as {
      values: () => AsyncIterableIterator<FileSystemHandle>
    }
    const handles = await Effect.runPromise(
      Stream.runCollect(
        Stream.fromAsyncIterable(dirWithValues.values(), (error) =>
          error instanceof Error ? error : new Error(String(error)),
        ),
      ),
    )
    const results = await Promise.all(
      handles.map(async (handle) => {
        if (handle.kind !== "file") {
          return Option.none<string>()
        }
        try {
          const file = await (handle as FileSystemFileHandle).getFile()
          return file.size > 0 ? Option.some(handle.name) : Option.none<string>()
        } catch {
          return Option.none<string>()
        }
      }),
    )
    return results.flatMap((item) => (Option.isSome(item) ? [item.value] : []))
  } catch {
    return []
  }
}

/**
 * Deletes the saved version history of a file.
 */
export const clearFileHistory = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<void> => {
  const maybeStore = await getHistoryFileStore(subPath, fileName, false)
  if (Option.isNone(maybeStore)) {
    return
  }
  await maybeStore.value.clear()
}

/**
 * Deletes the entire saved version history of all files.
 */
export const clearAllFileHistory = async (): Promise<void> => {
  if (supportsTauri()) {
    await invoke("tauri_history_clear_all")
    return
  }
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    return
  }
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(OPFS_HISTORY_FOLDER, { recursive: true })
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return
    }
    throw error
  }
}
