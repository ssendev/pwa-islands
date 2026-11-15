import { invoke } from "@tauri-apps/api/core"
import { Effect, Option, Stream } from "effect"
import { supportsTauri } from "./files"

export const OPFS_HISTORY_FOLDER = "pwa-islands-history"

// Binärformat-Vertrag: muss exakt mit `src-tauri/src/lib.rs` (`HISTORY_TRAILER_SIZE_BYTES = 16`, LE) übereinstimmen
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
 * Berechnet einen deterministischen 32-Bit-FNV-1a-Hash über UTF-8-Bytes.
 */
export const hashContentBytes = (bytes: Uint8Array): number =>
  bytes.reduce((acc, byte) => Math.imul(acc ^ byte, FNV_PRIME), FNV_OFFSET_BASIS) >>> 0

/**
 * Berechnet den 32-Bit-Hash sowie die UTF-8-Byte-Länge für einen Textinhalt.
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
 * Berechnet den 32-Bit-Hash für einen Textinhalt.
 */
export const hashHistoryContent = (content: string): number =>
  hashAndMeasureHistoryContent(content).contentHash

/**
 * Kodiert einen Versions-Eintrag als Binärblock für die Append-Only-Historie:
 * `[UTF-8 Inhalt] [Hash (Uint32 LE, 4 Bytes)] [Zeitstempel (Float64 LE, 8 Bytes)] [Inhaltslänge (Uint32 LE, 4 Bytes)]`.
 */
export const encodeHistoryBytesRecord = (
  contentBytes: Uint8Array,
  timestampMs: number,
): Uint8Array => {
  const contentHash = hashContentBytes(contentBytes)
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
 * Liest nur den 16-Byte-Header (Hash + Zeitstempel + Länge) ab `endOffset`, ohne den Inhalt zu laden.
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
 * Liest genau einen Eintrag rückwärts ab `endOffset` über die am Ende gespeicherte Länge.
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
 * Liest alle Offsets und Zeitstempel einer binären Verlaufsdatei (neueste Version zuerst),
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

/**
 * Hängt den alten Dateiinhalt inkl. Bearbeitungszeitstempel an die Verlaufsdatei
 * (in Tauri im internen App-Speicher, im Browser im OPFS) an.
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
  const record = encodeHistoryBytesRecord(oldBytes, timestampMs)
  await maybeStore.value.append(record)
}

export const appendFileHistory = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  oldContent: string,
  timestampMs: number,
): Promise<void> =>
  appendFileHistoryBytes(subPath, fileName, textEncoder.encode(oldContent), timestampMs)

/**
 * Liest genau die nächste ältere Version ab `maybeCursor` (oder ab Dateiende bei `Option.none()`).
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
 * Lädt nur Offsets, Größen und Zeitstempel aller gespeicherten Versionen einer Datei (neueste zuerst).
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
 * Springt direkt zu `endOffset` in der Verlaufsdatei, prüft den Header erneut und lädt den Inhalt.
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
 * Listet alle Dateinamen im Verlaufsordner für `subPath`, die mindestens einen Eintrag besitzen.
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
 * Löscht die gespeicherte Versionshistorie einer Datei.
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
 * Löscht den gesamten gespeicherten Versionsverlauf aller Dateien.
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
