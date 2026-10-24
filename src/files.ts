import { Array, Option, pipe } from "effect"
import { EditorFileMode, type FileEntry, PreviewContent, type StorageType } from "./model"
import {
  OPFS_APP_FOLDER,
  clearStoredDirectoryHandle,
  clearStoredStorageType,
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
  } else {
    await clearStoredDirectoryHandle()
  }
  await storeStorageType(type)
}

export const clearSavedDirectoryHandle = async (): Promise<void> => {
  await clearStoredDirectoryHandle()
  await clearStoredStorageType()
}

export const getSavedDirectoryHandle = getStoredDirectoryHandle
export const getSavedStorageType = getStoredStorageType
export const getSavedFileInfoVisible = getStoredFileInfoVisible
export const saveFileInfoVisible = storeFileInfoVisible

// ---------------------------------------------------------------------------
// File Preview & Base64 Helpers
// ---------------------------------------------------------------------------

export const MAX_TEXT_EDIT_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

const PREVIEWABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
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

export const getPreviewType = (fileName: string): "image" | "pdf" | null => {
  const ext = getFileExtension(fileName)
  if (PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) {
    return "image"
  }
  if (ext === "pdf") {
    return "pdf"
  }
  return null
}

const BASE64_CHUNK_SIZE = 0x8000 // 32 KB

export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const chunks: Array<string> = []
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const slice = bytes.subarray(i, i + BASE64_CHUNK_SIZE)
    chunks.push(String.fromCharCode(...slice))
  }
  return btoa(chunks.join(""))
}

export const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  const cleaned = base64.replace(/\s+/g, "")
  const binaryString = atob(cleaned)
  const buffer = new ArrayBuffer(binaryString.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
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
  private rootHandle: FileSystemDirectoryHandle
  private currentSubPath: Array<string> = []

  constructor(handle: FileSystemDirectoryHandle, type: StorageType) {
    this.rootHandle = handle
    this.type = type
  }

  get name(): string {
    return this.type === "opfs" ? OPFS_APP_FOLDER : this.rootHandle.name || "Lokaler Ordner"
  }

  get subPath(): ReadonlyArray<string> {
    return this.currentSubPath
  }

  async navigateToSubPath(segments: ReadonlyArray<string>): Promise<void> {
    let dir = this.rootHandle
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg)
    }
    this.currentSubPath = [...segments]
  }

  private async getCurrentDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
    let dir = this.rootHandle
    for (const seg of this.currentSubPath) {
      dir = await dir.getDirectoryHandle(seg)
    }
    return dir
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

  async listEntries(): Promise<Array<FileEntry>> {
    const dir = await this.getCurrentDirectoryHandle()
    const entries: Array<FileEntry> = []
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

    for (const entry of rawHandles) {
      if (entry.kind === "file") {
        try {
          const file = await entry.getFile()
          entries.push({
            name: entry.name,
            kind: "file",
            maybeSize: Option.some(file.size),
            maybeLastModified: Option.some(file.lastModified),
          })
        } catch {
          entries.push({
            name: entry.name,
            kind: "file",
            maybeSize: Option.none(),
            maybeLastModified: Option.none(),
          })
        }
      } else {
        entries.push({
          name: entry.name,
          kind: "directory",
          maybeSize: Option.none(),
          maybeLastModified: Option.none(),
        })
      }
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name, "de", { sensitivity: "base" })
    })

    return entries
  }

  async inspectFile(name: string): Promise<{
    size: number
    isEditableText: boolean
    text?: string
  }> {
    const dir = await this.getCurrentDirectoryHandle()
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

  async readFileBuffer(name: string): Promise<ArrayBuffer> {
    const dir = await this.getCurrentDirectoryHandle()
    const fileHandle = await dir.getFileHandle(name)
    const file = await fileHandle.getFile()
    return await file.arrayBuffer()
  }

  async getFileObject(name: string): Promise<globalThis.File> {
    const dir = await this.getCurrentDirectoryHandle()
    const fileHandle = await dir.getFileHandle(name)
    return await fileHandle.getFile()
  }

  async writeFile(name: string, content: string): Promise<void> {
    const dir = await this.getCurrentDirectoryHandle()
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async writeFileBuffer(name: string, data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<void> {
    const dir = await this.getCurrentDirectoryHandle()
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
  }

  async renameBinaryFile(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) {
      return
    }
    const dir = await this.getCurrentDirectoryHandle()
    const oldFileHandle = await dir.getFileHandle(oldName)
    const file = await oldFileHandle.getFile()
    const buffer = await file.arrayBuffer()

    const newFileHandle = await dir.getFileHandle(newName, { create: true })
    const writable = await newFileHandle.createWritable()
    await writable.write(buffer)
    await writable.close()

    await dir.removeEntry(oldName)
  }

  async createDirectory(name: string): Promise<void> {
    const dir = await this.getCurrentDirectoryHandle()
    await dir.getDirectoryHandle(name, { create: true })
  }

  async renameDirectory(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) {
      return
    }
    const dir = await this.getCurrentDirectoryHandle()
    const oldDirHandle = await dir.getDirectoryHandle(oldName)
    const newDirHandle = await dir.getDirectoryHandle(newName, { create: true })
    await this.copyDirectoryRecursive(oldDirHandle, newDirHandle)
    await dir.removeEntry(oldName, { recursive: true })
  }

  async deleteEntry(name: string, kind: "file" | "directory" = "file"): Promise<void> {
    const dir = await this.getCurrentDirectoryHandle()
    await dir.removeEntry(name, { recursive: kind === "directory" })
  }

  async disconnect(): Promise<void> {
    await clearSavedDirectoryHandle()
  }
}

// ---------------------------------------------------------------------------
// Imperative Runtime Bridge (Non-Serializable Handles)
// ---------------------------------------------------------------------------

export type RegisterSWOptions = {
  immediate?: boolean
  onNeedReload?: () => void
  onOfflineReady?: () => void
  onNeedRefresh?: () => void
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
  onRegisteredSW?: (
    swScriptUrl: string,
    registration: ServiceWorkerRegistration | undefined,
  ) => void
  onRegisterError?: (error: unknown) => void
}

export type RegisterSWFn = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>

const runtimeBridge: {
  activeStorage: FileSystemHandleStorage | null
  pendingHandle: FileSystemDirectoryHandle | null
  activePreviewObjectUrl: string | null
  deferredInstallPrompt: BeforeInstallPromptEvent | null
  registerServiceWorker: RegisterSWFn | null
  refreshServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null
} = {
  activeStorage: null,
  pendingHandle: null,
  activePreviewObjectUrl: null,
  deferredInstallPrompt: null,
  registerServiceWorker: null,
  refreshServiceWorker: null,
}

export const getRegisterServiceWorker = (): RegisterSWFn | null =>
  runtimeBridge.registerServiceWorker

export const setRegisterServiceWorker = (fn: RegisterSWFn | null): void => {
  runtimeBridge.registerServiceWorker = fn
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

export const getRefreshServiceWorker = (): ((reloadPage?: boolean) => Promise<void>) | null =>
  runtimeBridge.refreshServiceWorker

export const setRefreshServiceWorker = (
  fn: ((reloadPage?: boolean) => Promise<void>) | null,
): void => {
  runtimeBridge.refreshServiceWorker = fn
}

export const loadEditorFileModeForEntry = async (
  storage: FileSystemHandleStorage,
  entryName: string,
): Promise<EditorFileMode> => {
  revokeActivePreviewUrl()
  const inspection = await storage.inspectFile(entryName)
  if (inspection.isEditableText) {
    return EditorFileMode.Text({
      content: inspection.text ?? "",
    })
  }

  const canEditBase64 = inspection.size <= MAX_TEXT_EDIT_SIZE_BYTES
  const lockReason =
    inspection.size > MAX_TEXT_EDIT_SIZE_BYTES
      ? `Die Datei ist größer als 10 MB (${(inspection.size / (1024 * 1024)).toFixed(1)} MB) und kann nicht im Texteditor bearbeitet werden.`
      : "Binärdatei erkannt – Inhalt kann als Base64 bearbeitet werden."

  const previewKind = getPreviewType(entryName)
  let preview: PreviewContent = PreviewContent.None()
  if (previewKind !== null) {
    try {
      const file = await storage.getFileObject(entryName)
      const objectUrl = URL.createObjectURL(file)
      setActivePreviewUrl(objectUrl)
      preview =
        previewKind === "image"
          ? PreviewContent.Image({ objectUrl, name: entryName })
          : PreviewContent.Pdf({ objectUrl })
    } catch {
      preview = PreviewContent.None()
    }
  }

  return EditorFileMode.Binary({
    lockReason,
    canEditBase64,
    isBase64Enabled: false,
    base64Content: "",
    isLoadingBase64: false,
    preview,
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
  let counter = 1
  while (existingNames.has(`${base} (${counter})${ext}`)) {
    counter++
  }
  return `${base} (${counter})${ext}`
}

export const decodeUrlPathnameSegments = (pathname: string): ReadonlyArray<string> =>
  pipe(
    pathname.split("/"),
    Array.filter((segment) => segment.length > 0),
    Array.map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    }),
  )
