import { Array, Option, pipe } from "effect"
import {
  BinaryEdit,
  EditorFileMode,
  type FileEntry,
  PreviewContent,
  type StorageType,
} from "./model"
import {
  OPFS_APP_FOLDER,
  clearStoredDirectoryHandle,
  getOPFSDirectoryHandle,
  getStoredDirectoryHandle,
  getStoredFileInfoVisible,
  getStoredStorageType,
  storeDirectoryHandle,
  storeFileInfoVisible,
  storeStorageType,
} from "./storage"
import { checkTextBytes } from "./text"

// ---------------------------------------------------------------------------
// Browser File System Access API Types & Capabilities
// ---------------------------------------------------------------------------

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>
}

interface PermissionCapableHandle {
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
}

interface IterableDirectoryCapable {
  values?: () => AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>
  entries?: () => AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>
}

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: ReadonlyArray<string>
  readonly userChoice: Promise<{
    readonly outcome: "accepted" | "dismissed"
    readonly platform: string
  }>
  prompt(): Promise<void>
}

export const supportsDirectoryPicker = (): boolean =>
  typeof window !== "undefined" &&
  "showDirectoryPicker" in window &&
  typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === "function"

export const supportsOPFS = (): boolean =>
  typeof navigator !== "undefined" &&
  "storage" in navigator &&
  typeof navigator.storage?.getDirectory === "function"

export const showDirectoryPicker = (options?: {
  mode?: "read" | "readwrite"
}): Promise<FileSystemDirectoryHandle> => {
  if (!supportsDirectoryPicker()) {
    return Promise.reject(
      new Error("Die File System Access API wird in diesem Browser nicht unterstützt."),
    )
  }
  return (window as unknown as DirectoryPickerWindow).showDirectoryPicker(options)
}

export const queryDirectoryPermission = async (
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<PermissionState> => {
  const permHandle = handle as unknown as PermissionCapableHandle
  if (typeof permHandle.queryPermission === "function") {
    return await permHandle.queryPermission({ mode })
  }
  return "granted"
}

export const requestDirectoryPermission = async (
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<PermissionState> => {
  const permHandle = handle as unknown as PermissionCapableHandle
  if (typeof permHandle.requestPermission === "function") {
    return await permHandle.requestPermission({ mode })
  }
  return "granted"
}

export const getOPFSRootDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  const handle = await getOPFSDirectoryHandle()
  if (!handle) {
    throw new Error("Interner Browser-Speicher (OPFS) ist nicht verfügbar.")
  }
  return handle
}

export const saveDirectoryHandle = async (
  handle: FileSystemDirectoryHandle,
  type: StorageType,
): Promise<void> => {
  if (type === "fsa") {
    await storeDirectoryHandle(handle)
    runtimeBridge.savedFsaHandle = handle
  }
  await storeStorageType(type)
}

export const clearSavedDirectoryHandle = async (): Promise<void> => {
  runtimeBridge.savedFsaHandle = null
  runtimeBridge.pendingHandle = null
  await clearStoredDirectoryHandle()
}

export const getSavedDirectoryHandle = getStoredDirectoryHandle
export const getSavedStorageType = getStoredStorageType
export const getSavedFileInfoVisible = getStoredFileInfoVisible
export const saveFileInfoVisible = storeFileInfoVisible

// ---------------------------------------------------------------------------
// File Preview & Base64 Helpers
// ---------------------------------------------------------------------------

export const MAX_TEXT_EDIT_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

export const PREVIEWABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
])

const getFileExtension = (fileName: string): string => {
  const dotIdx = fileName.lastIndexOf(".")
  if (dotIdx < 0 || dotIdx === fileName.length - 1) {
    return ""
  }
  return fileName.slice(dotIdx + 1).toLowerCase()
}

export const getPreviewType = (fileName: string): Option.Option<"image" | "pdf"> => {
  const ext = getFileExtension(fileName)
  if (PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) {
    return Option.some("image")
  }
  if (ext === "pdf") {
    return Option.some("pdf")
  }
  return Option.none()
}

const BASE64_CHUNK_SIZE = 0x8000 // 32 KB

export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const chunkCount = Math.ceil(bytes.length / BASE64_CHUNK_SIZE)
  const chunks = Array.makeBy(chunkCount, (i) => {
    const start = i * BASE64_CHUNK_SIZE
    const slice = bytes.subarray(start, start + BASE64_CHUNK_SIZE)
    return String.fromCharCode(...slice)
  })
  return btoa(Array.join(chunks, ""))
}

export const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  const cleaned = base64.replace(/\s+/g, "")
  const binaryString = atob(cleaned)
  return Uint8Array.from(binaryString, (char) => char.charCodeAt(0))
}

// ---------------------------------------------------------------------------
// FileSystemHandleStorage
// ---------------------------------------------------------------------------

/**
 * Storage backend wrapping a `FileSystemDirectoryHandle`.
 * Works identically for both the File System Access API (user-picked local folder)
 * and the Origin Private File System (OPFS).
 */
export class FileSystemHandleStorage {
  readonly type: StorageType
  readonly rootHandle: FileSystemDirectoryHandle

  constructor(handle: FileSystemDirectoryHandle, type: StorageType) {
    this.rootHandle = handle
    this.type = type
  }

  get name(): string {
    return this.type === "opfs" ? OPFS_APP_FOLDER : this.rootHandle.name || "Lokaler Ordner"
  }

  async getDirectoryHandle(subPath: ReadonlyArray<string>): Promise<FileSystemDirectoryHandle> {
    return await Array.reduce(
      subPath,
      Promise.resolve(this.rootHandle),
      async (accPromise, seg) => {
        const dir = await accPromise
        return await dir.getDirectoryHandle(seg)
      },
    )
  }

  private async copyDirectoryRecursive(
    source: FileSystemDirectoryHandle,
    target: FileSystemDirectoryHandle,
  ): Promise<void> {
    const iterable = source as unknown as IterableDirectoryCapable
    const handles: Array<FileSystemDirectoryHandle | FileSystemFileHandle> = []

    if (typeof iterable.values === "function") {
      for await (const entry of iterable.values()) {
        handles.push(entry)
      }
    } else if (typeof iterable.entries === "function") {
      for await (const [, entry] of iterable.entries()) {
        handles.push(entry)
      }
    }

    for (const handle of handles) {
      if (handle.kind === "file") {
        const file = await handle.getFile()
        const newFileHandle = await target.getFileHandle(handle.name, {
          create: true,
        })
        const writable = await newFileHandle.createWritable()
        await writable.write(await file.arrayBuffer())
        await writable.close()
      } else {
        const newSubDir = await target.getDirectoryHandle(handle.name, {
          create: true,
        })
        await this.copyDirectoryRecursive(handle, newSubDir)
      }
    }
  }

  async listEntries(subPath: ReadonlyArray<string>): Promise<ReadonlyArray<FileEntry>> {
    const dir = await this.getDirectoryHandle(subPath)
    const iterable = dir as unknown as IterableDirectoryCapable

    const rawHandles: Array<FileSystemDirectoryHandle | FileSystemFileHandle> = []
    if (typeof iterable.values === "function") {
      for await (const entry of iterable.values()) {
        rawHandles.push(entry)
      }
    } else if (typeof iterable.entries === "function") {
      for await (const [, entry] of iterable.entries()) {
        rawHandles.push(entry)
      }
    } else {
      throw new Error("Das Verzeichnis-Handle unterstützt keine Iteration über Einträge.")
    }

    const entries: ReadonlyArray<FileEntry> = await Promise.all(
      Array.map(rawHandles, async (entry) => {
        if (entry.kind === "file") {
          try {
            const file = await entry.getFile()
            return {
              name: entry.name,
              kind: "file" as const,
              maybeSize: Option.some(file.size),
              maybeLastModified: Option.some(file.lastModified),
            }
          } catch {
            return {
              name: entry.name,
              kind: "file" as const,
              maybeSize: Option.none(),
              maybeLastModified: Option.none(),
            }
          }
        }
        return {
          name: entry.name,
          kind: "directory" as const,
          maybeSize: Option.none(),
          maybeLastModified: Option.none(),
        }
      }),
    )

    const sortedEntries = [...entries].sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name, "de", { sensitivity: "base" })
    })

    return sortedEntries
  }

  async inspectFile(
    subPath: ReadonlyArray<string>,
    name: string,
  ): Promise<{
    size: number
    isEditableText: boolean
    text?: string
  }> {
    const dir = await this.getDirectoryHandle(subPath)
    const fileHandle = await dir.getFileHandle(name)
    const file = await fileHandle.getFile()

    if (file.size > MAX_TEXT_EDIT_SIZE_BYTES) {
      return {
        size: file.size,
        isEditableText: false,
      }
    }

    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const textCheck = checkTextBytes(bytes)
    if (textCheck.kind === "binary") {
      return {
        size: file.size,
        isEditableText: false,
      }
    }

    return {
      size: file.size,
      isEditableText: true,
      text: textCheck.kind === "text" ? textCheck.text : "",
    }
  }

  async readFileBuffer(subPath: ReadonlyArray<string>, name: string): Promise<ArrayBuffer> {
    const dir = await this.getDirectoryHandle(subPath)
    const fileHandle = await dir.getFileHandle(name)
    const file = await fileHandle.getFile()
    return await file.arrayBuffer()
  }

  async getFileObject(subPath: ReadonlyArray<string>, name: string): Promise<globalThis.File> {
    const dir = await this.getDirectoryHandle(subPath)
    const fileHandle = await dir.getFileHandle(name)
    return await fileHandle.getFile()
  }

  async writeFile(subPath: ReadonlyArray<string>, name: string, content: string): Promise<void> {
    const dir = await this.getDirectoryHandle(subPath)
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async writeFileBuffer(
    subPath: ReadonlyArray<string>,
    name: string,
    data: ArrayBuffer | Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const dir = await this.getDirectoryHandle(subPath)
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
  }

  async renameBinaryFile(
    subPath: ReadonlyArray<string>,
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (oldName === newName) {
      return
    }
    const dir = await this.getDirectoryHandle(subPath)
    const oldFileHandle = await dir.getFileHandle(oldName)
    const file = await oldFileHandle.getFile()
    const buffer = await file.arrayBuffer()

    const newFileHandle = await dir.getFileHandle(newName, { create: true })
    const writable = await newFileHandle.createWritable()
    await writable.write(buffer)
    await writable.close()

    await dir.removeEntry(oldName)
  }

  async createDirectory(subPath: ReadonlyArray<string>, name: string): Promise<void> {
    const dir = await this.getDirectoryHandle(subPath)
    await dir.getDirectoryHandle(name, { create: true })
  }

  async renameDirectory(
    subPath: ReadonlyArray<string>,
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (oldName === newName) {
      return
    }
    const dir = await this.getDirectoryHandle(subPath)
    const oldDirHandle = await dir.getDirectoryHandle(oldName)
    const newDirHandle = await dir.getDirectoryHandle(newName, { create: true })
    await this.copyDirectoryRecursive(oldDirHandle, newDirHandle)
    await dir.removeEntry(oldName, { recursive: true })
  }

  async deleteEntry(
    subPath: ReadonlyArray<string>,
    name: string,
    kind: "file" | "directory" = "file",
  ): Promise<void> {
    const dir = await this.getDirectoryHandle(subPath)
    await dir.removeEntry(name, { recursive: kind === "directory" })
  }

  async disconnect(): Promise<void> {
    await clearSavedDirectoryHandle()
  }
}

// ---------------------------------------------------------------------------
// Imperative Runtime Bridge (Non-Serializable Handles)
// ---------------------------------------------------------------------------

const runtimeBridge: {
  activeStorage: FileSystemHandleStorage | null
  pendingHandle: FileSystemDirectoryHandle | null
  savedFsaHandle: FileSystemDirectoryHandle | null
  activePreviewObjectUrl: string | null
  deferredInstallPrompt: BeforeInstallPromptEvent | null
  pendingImportFiles: ReadonlyArray<globalThis.File>
} = {
  activeStorage: null,
  pendingHandle: null,
  savedFsaHandle: null,
  activePreviewObjectUrl: null,
  deferredInstallPrompt: null,
  pendingImportFiles: [],
}

export const getSavedFsaHandle = (): FileSystemDirectoryHandle | null =>
  runtimeBridge.savedFsaHandle

export const setSavedFsaHandle = (handle: FileSystemDirectoryHandle | null): void => {
  runtimeBridge.savedFsaHandle = handle
}

export const getPendingImportFiles = (): ReadonlyArray<globalThis.File> =>
  runtimeBridge.pendingImportFiles

export const setPendingImportFiles = (files: ReadonlyArray<globalThis.File>): void => {
  runtimeBridge.pendingImportFiles = files
}

export const getActiveStorage = (): FileSystemHandleStorage | null => runtimeBridge.activeStorage

export const setActiveStorage = (storage: FileSystemHandleStorage | null): void => {
  runtimeBridge.activeStorage = storage
}

export const getPendingHandle = (): FileSystemDirectoryHandle | null => runtimeBridge.pendingHandle

export const setPendingHandle = (handle: FileSystemDirectoryHandle | null): void => {
  runtimeBridge.pendingHandle = handle
}

export const revokeActivePreviewUrl = (): void => {
  if (runtimeBridge.activePreviewObjectUrl !== null) {
    URL.revokeObjectURL(runtimeBridge.activePreviewObjectUrl)
    runtimeBridge.activePreviewObjectUrl = null
  }
}

export const setActivePreviewUrl = (url: string): void => {
  revokeActivePreviewUrl()
  runtimeBridge.activePreviewObjectUrl = url
}

export const getDeferredInstallPrompt = (): BeforeInstallPromptEvent | null =>
  runtimeBridge.deferredInstallPrompt

export const setDeferredInstallPrompt = (prompt: BeforeInstallPromptEvent | null): void => {
  runtimeBridge.deferredInstallPrompt = prompt
}

export const loadEditorFileModeForEntry = async (
  storage: FileSystemHandleStorage,
  subPath: ReadonlyArray<string>,
  entryName: string,
): Promise<EditorFileMode> => {
  revokeActivePreviewUrl()
  const inspection = await storage.inspectFile(subPath, entryName)
  if (inspection.isEditableText) {
    return EditorFileMode.Text({
      content: inspection.text ?? "",
    })
  }

  const maybePreviewKind = getPreviewType(entryName)
  const preview = await Option.match(maybePreviewKind, {
    onNone: () => Promise.resolve(PreviewContent.None()),
    onSome: async (previewKind) => {
      try {
        const file = await storage.getFileObject(subPath, entryName)
        const objectUrl = URL.createObjectURL(file)
        setActivePreviewUrl(objectUrl)
        return previewKind === "image"
          ? PreviewContent.Image({ objectUrl })
          : PreviewContent.Pdf({ objectUrl })
      } catch {
        return PreviewContent.None()
      }
    },
  })

  const edit =
    inspection.size > MAX_TEXT_EDIT_SIZE_BYTES
      ? BinaryEdit.Locked({
          reason: `Die Datei ist größer als 10 MB (${(inspection.size / (1024 * 1024)).toFixed(1)} MB) und kann nicht im Texteditor bearbeitet werden.`,
        })
      : BinaryEdit.Disabled()

  return EditorFileMode.Binary({
    preview,
    edit,
  })
}

export const splitFileNameAndExt = (
  fileName: string,
): { readonly base: string; readonly ext: string } => {
  const lastDot = fileName.lastIndexOf(".")
  if (lastDot <= 0) {
    return { base: fileName, ext: "" }
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  }
}

export const findFreeFileName = (
  desiredName: string,
  existingNames: ReadonlySet<string>,
): string => {
  if (!existingNames.has(desiredName)) {
    return desiredName
  }
  const { base, ext } = splitFileNameAndExt(desiredName)
  const findCandidate = (counter: number): string => {
    const candidate = `${base} (${counter})${ext}`
    return existingNames.has(candidate) ? findCandidate(counter + 1) : candidate
  }
  return findCandidate(1)
}

export const decodeUrlPathnameSegments = (pathname: string): ReadonlyArray<string> =>
  pipe(
    pathname.split("/"),
    Array.filter((segment) => segment !== ""),
    Array.map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    }),
  )
