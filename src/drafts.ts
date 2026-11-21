import { invoke } from "@tauri-apps/api/core"
import { Effect, Option, Stream } from "effect"
import { supportsTauri } from "./files"
import { hashAndMeasureHistoryContent } from "./history"

export const OPFS_DRAFTS_FOLDER = "pwa-islands-drafts"

export interface FileDraft {
  readonly content: string
  readonly baseContentHash: number
  readonly baseByteLength: number
  readonly updatedAtMs: number
}

export const encodeDraft = (draft: FileDraft): string => JSON.stringify(draft)

export const decodeDraft = (raw: string): Option.Option<FileDraft> => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) {
      return Option.none()
    }
    const record = parsed as Record<string, unknown>
    if (
      typeof record.content !== "string" ||
      typeof record.baseContentHash !== "number" ||
      !Number.isFinite(record.baseContentHash) ||
      typeof record.baseByteLength !== "number" ||
      !Number.isFinite(record.baseByteLength) ||
      typeof record.updatedAtMs !== "number" ||
      !Number.isFinite(record.updatedAtMs)
    ) {
      return Option.none()
    }
    return Option.some({
      content: record.content,
      baseContentHash: record.baseContentHash,
      baseByteLength: record.baseByteLength,
      updatedAtMs: record.updatedAtMs,
    })
  } catch {
    return Option.none()
  }
}

export const hasDiskChangedSinceBase = (
  diskContent: string,
  baseContentHash: number,
  baseByteLength: number,
): boolean => {
  const { contentHash, byteLength } = hashAndMeasureHistoryContent(diskContent)
  return contentHash !== baseContentHash || byteLength !== baseByteLength
}

const getOpfsDraftsDirectory = async (
  subPath: ReadonlyArray<string>,
  create: boolean,
): Promise<Option.Option<FileSystemDirectoryHandle>> => {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    return Option.none()
  }
  try {
    const root = await navigator.storage.getDirectory()
    const draftsRoot = await root.getDirectoryHandle(OPFS_DRAFTS_FOLDER, { create })
    const dir = await subPath.reduce<Promise<FileSystemDirectoryHandle>>(
      async (parentPromise, segment) => {
        const parent = await parentPromise
        return parent.getDirectoryHandle(segment, { create })
      },
      Promise.resolve(draftsRoot),
    )
    return Option.some(dir)
  } catch {
    return Option.none()
  }
}

export const saveFileDraft = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
  draft: FileDraft,
): Promise<void> => {
  const serialized = encodeDraft(draft)
  if (supportsTauri()) {
    await invoke("tauri_draft_write", {
      subPath: [...subPath],
      fileName,
      content: serialized,
    })
    return
  }
  const maybeDir = await getOpfsDraftsDirectory(subPath, true)
  if (Option.isNone(maybeDir)) {
    return
  }
  const fileHandle = await maybeDir.value.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(serialized)
  } finally {
    await writable.close()
  }
}

export const loadFileDraft = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<Option.Option<FileDraft>> => {
  try {
    if (supportsTauri()) {
      const raw = await invoke<string | null>("tauri_draft_read", {
        subPath: [...subPath],
        fileName,
      })
      return raw === null ? Option.none() : decodeDraft(raw)
    }
    const maybeDir = await getOpfsDraftsDirectory(subPath, false)
    if (Option.isNone(maybeDir)) {
      return Option.none()
    }
    const fileHandle = await maybeDir.value.getFileHandle(fileName, { create: false })
    const file = await fileHandle.getFile()
    const raw = await file.text()
    return decodeDraft(raw)
  } catch {
    return Option.none()
  }
}

export const clearFileDraft = async (
  subPath: ReadonlyArray<string>,
  fileName: string,
): Promise<void> => {
  try {
    if (supportsTauri()) {
      await invoke("tauri_draft_clear", {
        subPath: [...subPath],
        fileName,
      })
      return
    }
    const maybeDir = await getOpfsDraftsDirectory(subPath, false)
    if (Option.isNone(maybeDir)) {
      return
    }
    await maybeDir.value.removeEntry(fileName)
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return
    }
  }
}

export const listDraftFileNames = async (
  subPath: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  try {
    if (supportsTauri()) {
      return await invoke<ReadonlyArray<string>>("tauri_draft_list_entries", {
        subPath: [...subPath],
      })
    }
    const maybeDir = await getOpfsDraftsDirectory(subPath, false)
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

export const clearAllFileDrafts = async (): Promise<void> => {
  if (supportsTauri()) {
    await invoke("tauri_draft_clear_all")
    return
  }
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    return
  }
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(OPFS_DRAFTS_FOLDER, { recursive: true })
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return
    }
    throw error
  }
}
