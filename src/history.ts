import { Option } from "effect"

export const OPFS_HISTORY_FOLDER = "pwa-islands-history"

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
export const encodeHistoryRecord = (content: string, timestampMs: number): Uint8Array => {
  const contentBytes = textEncoder.encode(content)
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
export const readHistoryRecordAt = async (
  readSlice: SliceReader,
  endOffset: number,
): Promise<Option.Option<HistoryRecord>> => {
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
    content: textDecoder.decode(contentBuffer),
    timestampMs: meta.timestampMs,
    contentHash: meta.contentHash,
    startOffset: meta.offset,
    endOffset,
  })
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

const getOpfsHistoryFileHandle = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  create: boolean,
): Promise<Option.Option<FileSystemFileHandle>> => {
  const maybeDir = await getOpfsHistoryDirectory(subPath, create)
  if (Option.isNone(maybeDir)) {
    return Option.none()
  }
  try {
    const fileHandle = await maybeDir.value.getFileHandle(fileName, { create })
    return Option.some(fileHandle)
  } catch {
    return Option.none()
  }
}

/**
 * Hängt den alten Dateiinhalt inkl. Bearbeitungszeitstempel an `pwa-islands-history/<pfad>` im OPFS an.
 */
export const appendFileHistory = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  oldContent: string,
  timestampMs: number,
): Promise<void> => {
  const maybeFileHandle = await getOpfsHistoryFileHandle(subPath, fileName, true)
  if (Option.isNone(maybeFileHandle)) {
    return
  }
  const fileHandle = maybeFileHandle.value
  const file = await fileHandle.getFile()
  const record = encodeHistoryRecord(oldContent, timestampMs)
  const writable = await fileHandle.createWritable({ keepExistingData: true })
  try {
    await writable.seek(file.size)
    await writable.write(new Uint8Array(record))
  } finally {
    await writable.close()
  }
}

/**
 * Liest genau die nächste ältere Version ab `maybeCursor` (oder ab Dateiende bei `Option.none()`).
 */
export const loadPreviousFileHistoryEntry = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  maybeCursor: Option.Option<number>,
): Promise<Option.Option<HistoryRecord>> => {
  const maybeFileHandle = await getOpfsHistoryFileHandle(subPath, fileName, false)
  if (Option.isNone(maybeFileHandle)) {
    return Option.none()
  }
  const file = await maybeFileHandle.value.getFile()
  const cursor = Option.match(maybeCursor, {
    onNone: () => file.size,
    onSome: (offset) => Math.min(offset, file.size),
  })
  return readHistoryRecordAt((start, end) => file.slice(start, end).arrayBuffer(), cursor)
}

/**
 * Lädt nur Offsets, Größen und Zeitstempel aller gespeicherten Versionen einer Datei aus dem OPFS (neueste zuerst).
 */
export const loadFileHistoryIndex = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<ReadonlyArray<HistoryEntryMeta>> => {
  const maybeFileHandle = await getOpfsHistoryFileHandle(subPath, fileName, false)
  if (Option.isNone(maybeFileHandle)) {
    return []
  }
  const file = await maybeFileHandle.value.getFile()
  return readAllHistoryMeta((start, end) => file.slice(start, end).arrayBuffer(), file.size)
}

/**
 * Springt direkt zu `endOffset` in der OPFS-Verlaufsdatei, prüft den Header erneut und lädt den Inhalt.
 */
export const loadFileHistoryEntryAt = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  endOffset: number,
): Promise<Option.Option<HistoryRecord>> => {
  const maybeFileHandle = await getOpfsHistoryFileHandle(subPath, fileName, false)
  if (Option.isNone(maybeFileHandle)) {
    return Option.none()
  }
  const file = await maybeFileHandle.value.getFile()
  if (endOffset > file.size) {
    return Option.none()
  }
  return readHistoryRecordAt((start, end) => file.slice(start, end).arrayBuffer(), endOffset)
}

/**
 * Löscht die gespeicherte Versionshistorie einer Datei im OPFS.
 */
export const clearFileHistory = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<void> => {
  const maybeDir = await getOpfsHistoryDirectory(subPath, false)
  if (Option.isNone(maybeDir)) {
    return
  }
  try {
    await maybeDir.value.removeEntry(fileName)
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return
    }
    throw error
  }
}
