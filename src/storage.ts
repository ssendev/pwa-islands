import { Array, Data, Effect, Option, Stream } from "effect"

export class DirectoryIterationError extends Data.TaggedError("DirectoryIterationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const DB_NAME = "pwa-islands-db"
export const DB_VERSION = 1
export const STORE_NAME = "handles"
export const HANDLE_KEY = "selected_folder"
export const STORAGE_TYPE_KEY = "selected_storage_type"
export const FILE_INFO_VISIBLE_KEY = "file_info_visible"
export const ISLAND_PARAM = "pwaislands"

// NOTE: OPFS has a single root per origin; files are placed in a subfolder
export const OPFS_APP_FOLDER = "PWA Islands"

let dbPromise: Promise<IDBDatabase> | null = null

// NOTE: IndexedDB instance is cached to avoid reconnect overhead on island asset fetches
export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise
  }

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

  dbPromise = pending
  // NOTE: Evict failed connection so future calls can retry
  void pending.catch(() => {
    if (dbPromise === pending) {
      dbPromise = null
    }
  })

  return pending
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

const isStoredStorageType = (value: unknown): value is "fsa" | "opfs" =>
  value === "fsa" || value === "opfs"

export async function getStoredStorageType(): Promise<Option.Option<"fsa" | "opfs">> {
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

export async function storeStorageType(type: "fsa" | "opfs"): Promise<void> {
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
            new DirectoryIterationError({ message: "Fehler beim Lesen der Einträge", cause }),
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
              new DirectoryIterationError({ message: "Fehler beim Lesen der Einträge", cause }),
          ),
          ([, handle]) => handle,
        ),
      ),
    )
    return Array.fromIterable(chunk)
  }
  throw new Error("Das Verzeichnis-Handle unterstützt keine Iteration über Einträge.")
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

let rootCache: { root: FileSystemDirectoryHandle } | null = null

export function invalidateRootCache(): void {
  rootCache = null
}

// NOTE: Missing directory permission is intentionally un-cached so user prompts re-trigger
async function findCachedActiveStorage(): Promise<Option.Option<FileSystemDirectoryHandle>> {
  if (rootCache) {
    return Option.some(rootCache.root)
  }
  const maybeRoot = await findActiveStorage()
  if (Option.isSome(maybeRoot)) {
    rootCache = { root: maybeRoot.value }
  }
  return maybeRoot
}

export async function findSavedFile(
  relativePath: string,
  indexFile = DEFAULT_INDEX_FILE,
): Promise<Option.Option<SavedFile>> {
  if (Array.isReadonlyArrayEmpty(splitPath(relativePath))) {
    return Option.none()
  }

  try {
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
  return clean ? clean.split("/").filter(Boolean) : []
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

export function getMimeType(filename: string, fallback?: string): string {
  const dotIndex = filename.lastIndexOf(".")
  if (dotIndex !== -1) {
    const ext = filename.slice(dotIndex + 1).toLowerCase()
    if (ext in MIME_TYPES) {
      return MIME_TYPES[ext]
    }
  }
  return fallback && fallback !== "" ? fallback : "application/octet-stream"
}
