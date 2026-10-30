import { Array, Option, Order, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import {
  OPFS_APP_FOLDER,
  checkTextBytes,
  clearStoredDirectoryHandle,
  collectDirectoryHandles,
  copyDirectory,
  getFileExtension,
  getOPFSDirectoryHandle,
  getStoredDirectoryHandle,
  getStoredFileInfoVisible,
  getStoredStorageType,
  invalidateRootCache,
  storeDirectoryHandle,
  storeFileInfoVisible,
  storeStorageType,
} from "./storage"

// STORAGE & FILE ENTRY TYPES

export const StorageType = Schema.Literals(["fsa", "opfs", "tauri"])
export type StorageType = typeof StorageType.Type

export const FileEntryKind = Schema.Literals(["file", "directory"])
export type FileEntryKind = typeof FileEntryKind.Type

export const FileEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: FileEntryKind,
  maybeSize: Schema.Option(Schema.Number),
  maybeLastModified: Schema.Option(Schema.Number),
})
export type FileEntry = typeof FileEntry.Type

export const FileInspection = defineTaggedUnion({
  EditableText: {
    size: Schema.Number,
    text: Schema.String,
  },
  Binary: {
    size: Schema.Number,
  },
})
export type FileInspection = typeof FileInspection.Type

// CAPABILITIES

export const supportsTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export const supportsDirectoryPicker = (): boolean =>
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"

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
  return window.showDirectoryPicker!(options)
}

export const queryDirectoryPermission = async (
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<PermissionState> => {
  if (typeof handle.queryPermission === "function") {
    return await handle.queryPermission({ mode })
  }
  return "granted"
}

export const requestDirectoryPermission = async (
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<PermissionState> => {
  if (typeof handle.requestPermission === "function") {
    return await handle.requestPermission({ mode })
  }
  return "granted"
}

export const getOPFSRootDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  return Option.match(await getOPFSDirectoryHandle(), {
    onNone: () => {
      throw new Error("Interner Browser-Speicher (OPFS) ist nicht verfügbar.")
    },
    onSome: (handle) => handle,
  })
}

export const saveDirectoryHandle = async (
  handle: FileSystemDirectoryHandle | null,
  type: StorageType,
): Promise<void> => {
  if (type === "fsa" && handle) {
    await storeDirectoryHandle(handle)
    runtimeBridge.savedFsaHandle = Option.some(handle)
  }
  await storeStorageType(type)
}

export const clearSavedDirectoryHandle = async (): Promise<void> => {
  runtimeBridge.savedFsaHandle = Option.none()
  runtimeBridge.pendingHandle = Option.none()
  await clearStoredDirectoryHandle()
}

export const folderNameFromPath = (folderPath: string): string => {
  const cleaned = folderPath.replace(/[\\/]+$/, "")
  const parts = Array.filter(cleaned.split(/[\\/]/), Boolean)
  return Array.isReadonlyArrayNonEmpty(parts) ? Array.lastNonEmpty(parts) : "Lokaler Ordner"
}

export const pickTauriDirectory = async (): Promise<Option.Option<string>> => {
  const { invoke } = await import("@tauri-apps/api/core")
  const picked = await invoke<string | null>("tauri_fs_pick_folder")
  return Option.fromNullishOr(picked)
}

export const setTauriRootDirectory = async (folderPath: string): Promise<boolean> => {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke<string>("tauri_fs_set_root", { path: folderPath })
    return true
  } catch {
    return false
  }
}

export const clearTauriRootDirectory = async (): Promise<void> => {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("tauri_fs_clear_root")
  } catch {
    // Ignore when not running in Tauri
  }
}

export const getSavedTauriFolder = async (): Promise<Option.Option<string>> => {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const root = await invoke<string | null>("tauri_fs_get_root")
    return Option.fromNullishOr(root)
  } catch {
    return Option.none()
  }
}

export const saveTauriFolder = async (folderPath: string): Promise<void> => {
  invalidateRootCache()
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke<string>("tauri_fs_set_root", { path: folderPath })
  runtimeBridge.savedTauriFolder = Option.some(folderPath)
  await storeStorageType("tauri")
}

export const clearSavedTauriFolder = async (): Promise<void> => {
  invalidateRootCache()
  runtimeBridge.savedTauriFolder = Option.none()
  await clearTauriRootDirectory()
}

export const getSavedDirectoryHandle = getStoredDirectoryHandle
export const getSavedStorageType = getStoredStorageType
export const saveStorageType = storeStorageType
export const getSavedFileInfoVisible = getStoredFileInfoVisible
export const saveFileInfoVisible = storeFileInfoVisible

// PREVIEWS & TRANSFORMS

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
  const chunkCount = Math.ceil(bytes.byteLength / BASE64_CHUNK_SIZE)
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

const fileEntryOrder: Order.Order<FileEntry> = Order.make((a, b) => {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1
  }
  const cmp = a.name.localeCompare(b.name, "de", { sensitivity: "base" })
  return cmp < 0 ? -1 : cmp > 0 ? 1 : 0
})

// STORAGE BACKEND

/**
 * Storage backend wrapping a `FileSystemDirectoryHandle`.
 * Works identically for both the File System Access API (user-picked local folder)
 * and the Origin Private File System (OPFS).
 */
export class FileSystemHandleStorage {
  readonly type: StorageType
  readonly rootHandle: FileSystemDirectoryHandle | null

  constructor(handle: FileSystemDirectoryHandle, type: StorageType) {
    this.rootHandle = handle
    this.type = type
  }

  get name(): string {
    return this.type === "opfs" ? OPFS_APP_FOLDER : this.rootHandle?.name || "Lokaler Ordner"
  }

  async getDirectoryHandle(subPath: ReadonlyArray<string>): Promise<FileSystemDirectoryHandle> {
    if (!this.rootHandle) {
      throw new Error("Kein lokales Handle verfügbar.")
    }
    return await Array.reduce(
      subPath,
      Promise.resolve(this.rootHandle),
      async (accPromise, seg) => {
        const dir = await accPromise
        return await dir.getDirectoryHandle(seg)
      },
    )
  }

  async listEntries(subPath: ReadonlyArray<string>): Promise<ReadonlyArray<FileEntry>> {
    const dir = await this.getDirectoryHandle(subPath)
    const rawHandles = await collectDirectoryHandles(dir)

    const entries: ReadonlyArray<FileEntry> = await Promise.all(
      Array.map(rawHandles, async (entry) => {
        const id = `${entry.kind}:${entry.name}`
        if (entry.kind === "file") {
          try {
            const file = await entry.getFile()
            return {
              id,
              name: entry.name,
              kind: "file" as const,
              maybeSize: Option.some(file.size),
              maybeLastModified: Option.some(file.lastModified),
            }
          } catch {
            return {
              id,
              name: entry.name,
              kind: "file" as const,
              maybeSize: Option.none(),
              maybeLastModified: Option.none(),
            }
          }
        }
        return {
          id,
          name: entry.name,
          kind: "directory" as const,
          maybeSize: Option.none(),
          maybeLastModified: Option.none(),
        }
      }),
    )

    return Array.sort(entries, fileEntryOrder)
  }

  async inspectFile(subPath: ReadonlyArray<string>, name: string): Promise<FileInspection> {
    const dir = await this.getDirectoryHandle(subPath)
    const fileHandle = await dir.getFileHandle(name)
    const file = await fileHandle.getFile()

    if (file.size > MAX_TEXT_EDIT_SIZE_BYTES) {
      return FileInspection.Binary({ size: file.size })
    }

    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const textCheck = checkTextBytes(bytes)
    return textCheck.kind === "binary"
      ? FileInspection.Binary({ size: file.size })
      : FileInspection.EditableText({
          size: file.size,
          text: textCheck.kind === "text" ? textCheck.text : "",
        })
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
    await copyDirectory(oldDirHandle, newDirHandle)
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

export class TauriStorage {
  readonly type: StorageType = "tauri"
  readonly rootHandle = null
  readonly folderPath: string

  constructor(folderPath = "") {
    this.folderPath = folderPath
  }

  get name(): string {
    return folderNameFromPath(this.folderPath)
  }

  private joinSubPath(subPath: ReadonlyArray<string>, name?: string): string {
    const parts = name !== undefined ? [...subPath, name] : [...subPath]
    return parts.filter(Boolean).join("/")
  }

  async listEntries(subPath: ReadonlyArray<string>): Promise<ReadonlyArray<FileEntry>> {
    const { invoke } = await import("@tauri-apps/api/core")
    const relPath = this.joinSubPath(subPath)
    const raw = await invoke<
      ReadonlyArray<{
        name: string
        isDirectory: boolean
        size: number | null
        lastModified: number | null
      }>
    >("tauri_fs_list_entries", { subPath: relPath })

    const entries: ReadonlyArray<FileEntry> = Array.map(raw, (item) => ({
      id: `${item.isDirectory ? "directory" : "file"}:${item.name}`,
      name: item.name,
      kind: item.isDirectory ? ("directory" as const) : ("file" as const),
      maybeSize: Option.fromNullishOr(item.size),
      maybeLastModified: Option.fromNullishOr(item.lastModified),
    }))

    return Array.sort(entries, fileEntryOrder)
  }

  async inspectFile(subPath: ReadonlyArray<string>, name: string): Promise<FileInspection> {
    const { invoke } = await import("@tauri-apps/api/core")
    const relPath = this.joinSubPath(subPath, name)
    const buffer = await invoke<ArrayBuffer>("tauri_fs_read_file", { subPath: relPath })
    const size = buffer.byteLength

    if (size > MAX_TEXT_EDIT_SIZE_BYTES) {
      return FileInspection.Binary({ size })
    }

    const bytes = new Uint8Array(buffer)
    const textCheck = checkTextBytes(bytes)
    return textCheck.kind === "binary"
      ? FileInspection.Binary({ size })
      : FileInspection.EditableText({
          size,
          text: textCheck.kind === "text" ? textCheck.text : "",
        })
  }

  async readFileBuffer(subPath: ReadonlyArray<string>, name: string): Promise<ArrayBuffer> {
    const { invoke } = await import("@tauri-apps/api/core")
    const relPath = this.joinSubPath(subPath, name)
    return await invoke<ArrayBuffer>("tauri_fs_read_file", { subPath: relPath })
  }

  async getFileObject(subPath: ReadonlyArray<string>, name: string): Promise<globalThis.File> {
    const buffer = await this.readFileBuffer(subPath, name)
    return new File([buffer], name)
  }

  async writeFile(subPath: ReadonlyArray<string>, name: string, content: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core")
    const relPath = this.joinSubPath(subPath, name)
    const bytes = new TextEncoder().encode(content)
    await invoke("tauri_fs_write_file", {
      subPath: relPath,
      data: globalThis.Array.from(bytes),
    })
  }

  async writeFileBuffer(
    subPath: ReadonlyArray<string>,
    name: string,
    data: ArrayBuffer | Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core")
    const relPath = this.joinSubPath(subPath, name)
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    await invoke("tauri_fs_write_file", {
      subPath: relPath,
      data: globalThis.Array.from(bytes),
    })
  }

  async renameBinaryFile(
    subPath: ReadonlyArray<string>,
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (oldName === newName) {
      return
    }
    const { invoke } = await import("@tauri-apps/api/core")
    const fromPath = this.joinSubPath(subPath, oldName)
    const toPath = this.joinSubPath(subPath, newName)
    await invoke("tauri_fs_rename", {
      fromSubPath: fromPath,
      toSubPath: toPath,
    })
  }

  async createDirectory(subPath: ReadonlyArray<string>, name: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core")
    const relPath = this.joinSubPath(subPath, name)
    await invoke("tauri_fs_create_dir", { subPath: relPath })
  }

  async renameDirectory(
    subPath: ReadonlyArray<string>,
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (oldName === newName) {
      return
    }
    const { invoke } = await import("@tauri-apps/api/core")
    const fromPath = this.joinSubPath(subPath, oldName)
    const toPath = this.joinSubPath(subPath, newName)
    await invoke("tauri_fs_rename", {
      fromSubPath: fromPath,
      toSubPath: toPath,
    })
  }

  async deleteEntry(
    subPath: ReadonlyArray<string>,
    name: string,
    kind: "file" | "directory" = "file",
  ): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core")
    const relPath = this.joinSubPath(subPath, name)
    await invoke("tauri_fs_remove_entry", {
      subPath: relPath,
      isDirectory: kind === "directory",
    })
  }

  async disconnect(): Promise<void> {
    await clearSavedTauriFolder()
  }
}

export type StorageBackend = FileSystemHandleStorage | TauriStorage

// RUNTIME BRIDGE

const runtimeBridge: {
  activeStorage: Option.Option<StorageBackend>
  pendingHandle: Option.Option<FileSystemDirectoryHandle>
  savedFsaHandle: Option.Option<FileSystemDirectoryHandle>
  savedTauriFolder: Option.Option<string>
  maybeActivePreviewObjectUrl: Option.Option<string>
  deferredInstallPrompt: Option.Option<BeforeInstallPromptEvent>
  pendingImportFiles: ReadonlyArray<globalThis.File>
} = {
  activeStorage: Option.none(),
  pendingHandle: Option.none(),
  savedFsaHandle: Option.none(),
  savedTauriFolder: Option.none(),
  maybeActivePreviewObjectUrl: Option.none(),
  deferredInstallPrompt: Option.none(),
  pendingImportFiles: [],
}

export const getSavedFsaHandle = (): Option.Option<FileSystemDirectoryHandle> =>
  runtimeBridge.savedFsaHandle

export const setSavedFsaHandle = (handle: Option.Option<FileSystemDirectoryHandle>): void => {
  runtimeBridge.savedFsaHandle = handle
}

export const getSavedTauriFolderCached = (): Option.Option<string> => runtimeBridge.savedTauriFolder

export const setSavedTauriFolder = (folderPath: Option.Option<string>): void => {
  runtimeBridge.savedTauriFolder = folderPath
}

export const getPendingImportFiles = (): ReadonlyArray<globalThis.File> =>
  runtimeBridge.pendingImportFiles

export const setPendingImportFiles = (files: ReadonlyArray<globalThis.File>): void => {
  runtimeBridge.pendingImportFiles = files
}

export const getActiveStorage = (): Option.Option<StorageBackend> => runtimeBridge.activeStorage

export const requireActiveStorage = (): StorageBackend =>
  Option.match(getActiveStorage(), {
    onNone: () => {
      throw new Error("Kein aktiver Speicher verfügbar.")
    },
    onSome: (storage) => storage,
  })

export const setActiveStorage = (storage: Option.Option<StorageBackend>): void => {
  runtimeBridge.activeStorage = storage
}

export const getPendingHandle = (): Option.Option<FileSystemDirectoryHandle> =>
  runtimeBridge.pendingHandle

export const setPendingHandle = (handle: Option.Option<FileSystemDirectoryHandle>): void => {
  runtimeBridge.pendingHandle = handle
}

export const revokeActivePreviewUrl = (): void => {
  Option.match(runtimeBridge.maybeActivePreviewObjectUrl, {
    onNone: () => undefined,
    onSome: (url) => URL.revokeObjectURL(url),
  })
  runtimeBridge.maybeActivePreviewObjectUrl = Option.none()
}

export const setActivePreviewUrl = (url: string): void => {
  revokeActivePreviewUrl()
  runtimeBridge.maybeActivePreviewObjectUrl = Option.some(url)
}

export const getDeferredInstallPrompt = (): Option.Option<BeforeInstallPromptEvent> =>
  runtimeBridge.deferredInstallPrompt

export const setDeferredInstallPrompt = (prompt: Option.Option<BeforeInstallPromptEvent>): void => {
  runtimeBridge.deferredInstallPrompt = prompt
}

export const PreviewContent = defineTaggedUnion({
  None: {},
  Image: {
    objectUrl: Schema.String,
  },
  Pdf: {
    objectUrl: Schema.String,
  },
})
export type PreviewContent = typeof PreviewContent.Type

export const BinaryEdit = defineTaggedUnion({
  Locked: {
    reason: Schema.String,
  },
  Disabled: {},
  Loading: {},
  Editing: {
    content: Schema.String,
  },
})
export type BinaryEdit = typeof BinaryEdit.Type

export const EditorFileMode = defineTaggedUnion({
  Text: {
    content: Schema.String,
  },
  Binary: {
    preview: PreviewContent,
    edit: BinaryEdit,
  },
})
export type EditorFileMode = typeof EditorFileMode.Type

const loadBinaryEditorFileMode = async (
  storage: StorageBackend,
  subPath: ReadonlyArray<string>,
  entryName: string,
  size: number,
): Promise<EditorFileMode> => {
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
    size > MAX_TEXT_EDIT_SIZE_BYTES
      ? BinaryEdit.Locked({
          reason: `Die Datei ist größer als 10 MB (${(size / (1024 * 1024)).toFixed(1)} MB) und kann nicht im Texteditor bearbeitet werden.`,
        })
      : BinaryEdit.Disabled()

  return EditorFileMode.Binary({
    preview,
    edit,
  })
}

export const loadEditorFileModeForEntry = async (
  storage: StorageBackend,
  subPath: ReadonlyArray<string>,
  entryName: string,
): Promise<EditorFileMode> => {
  revokeActivePreviewUrl()
  const inspection = await storage.inspectFile(subPath, entryName)
  return await FileInspection.match(inspection, {
    EditableText: ({ text }) => Promise.resolve(EditorFileMode.Text({ content: text })),
    Binary: ({ size }) => loadBinaryEditorFileMode(storage, subPath, entryName, size),
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
