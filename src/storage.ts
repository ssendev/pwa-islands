export const DB_NAME = "pwa-islands-db"
export const DB_VERSION = 1
export const STORE_NAME = "handles"
export const HANDLE_KEY = "selected_folder"
export const STORAGE_TYPE_KEY = "selected_storage_type"
export const ISLAND_PARAM = "pwaislands"

/**
 * OPFS hat pro Origin nur EINE Wurzel -- eine zweite Wurzel laesst sich nicht
 * waehlen. Damit die App nicht direkt im Origin-Wurzelverzeichnis schreibt,
 * liegen alle Dateien in diesem Unterordner.
 */
export const OPFS_APP_FOLDER = "PWA Islands"

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
}

export async function getStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(HANDLE_KEY)

      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen des gespeicherten Ordners:", error)
    return null
  }
}

export async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
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
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(HANDLE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/** Liest die zuletzt gewählte Speicherart ('fsa' oder 'opfs'). */
export async function getStoredStorageType(): Promise<"fsa" | "opfs" | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(STORAGE_TYPE_KEY)

      req.onsuccess = () => resolve((req.result as "fsa" | "opfs") ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error("Fehler beim Abrufen der gespeicherten Speicherart:", error)
    return null
  }
}

/** Speichert die zuletzt gewählte Speicherart. */
export async function storeStorageType(type: "fsa" | "opfs"): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(type, STORAGE_TYPE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function clearStoredStorageType(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(STORAGE_TYPE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function getOPFSDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function"
  ) {
    try {
      const root = await navigator.storage.getDirectory()
      return await root.getDirectoryHandle(OPFS_APP_FOLDER, { create: true })
    } catch (err) {
      console.error("Fehler beim Abrufen des OPFS-Handles:", err)
      return null
    }
  }
  return null
}

export async function getFileFromDirectory(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<File | null> {
  const cleanPath = relativePath.replace(/^\/+|\/+$/g, "")
  if (!cleanPath) return null

  const parts = cleanPath.split("/").filter(Boolean)
  if (parts.length === 0) return null

  // 1. Try walking nested directories
  try {
    let currentDir = root
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i])
    }
    const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1])
    return await fileHandle.getFile()
  } catch {
    // 2. Fallback nur für einfache Dateinamen (kein Unterordner): früher wurde
    //    hier immer der Basisname probiert. Das führte dazu, dass z. B. die
    //    Dev-Anfrage /src/style.css die gespeicherte style.css auslieferte und
    //    damit das Vite-Modul-Skript kaputt machte.
    if (parts.length > 1) return null
    try {
      const fileHandle = await root.getFileHandle(parts[0])
      return await fileHandle.getFile()
    } catch {
      return null
    }
  }
}

export async function findSavedFile(relativePath: string): Promise<File | null> {
  const cleanPath = relativePath.replace(/^\/+|\/+$/g, "")
  if (!cleanPath) return null

  // 1. Try FSA handle stored in IndexedDB
  try {
    const storedHandle = await getStoredDirectoryHandle()
    if (storedHandle) {
      let perm: PermissionState = "granted"
      if (storedHandle.queryPermission) {
        try {
          perm = await storedHandle.queryPermission({ mode: "read" })
        } catch {
          perm = "prompt"
        }
      }
      if (perm === "granted") {
        const file = await getFileFromDirectory(storedHandle, relativePath)
        if (file) return file
      }
    }
  } catch (err) {
    console.warn("findSavedFile FSA Fehler:", err)
  }

  // 2. Try OPFS
  try {
    const opfsHandle = await getOPFSDirectoryHandle()
    if (opfsHandle) {
      const file = await getFileFromDirectory(opfsHandle, relativePath)
      if (file) return file
    }
  } catch (err) {
    console.warn("findSavedFile OPFS Fehler:", err)
  }

  return null
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

export function splitPath(path: string): string[] {
  const clean = normalizePath(path)
  return clean ? clean.split("/").filter(Boolean) : []
}

/**
 * Findet die aktive Speicher-Wurzel: zuerst der gespeicherte FSA-Ordner,
 * danach OPFS. Liefert null, wenn keiner verfügbar ist (z. B. wenn die
 * Berechtigung für den gespeicherten Ordner fehlt).
 */
export async function findActiveStorage(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const storedHandle = await getStoredDirectoryHandle()
    if (storedHandle) {
      let perm: PermissionState = "granted"
      if (storedHandle.queryPermission) {
        try {
          perm = await storedHandle.queryPermission({ mode: "readwrite" })
        } catch {
          perm = "prompt"
        }
      }
      if (perm === "granted") return storedHandle
    }
  } catch (err) {
    console.warn("findActiveStorage FSA Fehler:", err)
  }

  try {
    return await getOPFSDirectoryHandle()
  } catch (err) {
    console.warn("findActiveStorage OPFS Fehler:", err)
    return null
  }
}

/**
 * Läuft von einer Wurzel-Handle entlang der Pfadsegmente zu einem
 * Verzeichnis. Mit create=true werden fehlende Ordner angelegt.
 */
export async function getDirectory(
  root: FileSystemDirectoryHandle,
  dirs: string[],
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const segment of dirs) {
    current = await current.getDirectoryHandle(segment, { create })
  }
  return current
}

export function getMimeType(filename: string, fallback?: string): string {
  const dotIndex = filename.lastIndexOf(".")
  if (dotIndex !== -1) {
    const ext = filename.slice(dotIndex + 1).toLowerCase()
    if (ext in MIME_TYPES) {
      return MIME_TYPES[ext]
    }
  }
  return fallback && fallback.length > 0 ? fallback : "application/octet-stream"
}
