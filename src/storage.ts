export const DB_NAME = 'pwa-islands-db'
export const DB_VERSION = 1
export const STORE_NAME = 'handles'
export const HANDLE_KEY = 'selected_folder'

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
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(HANDLE_KEY)

      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.error('Fehler beim Abrufen des gespeicherten Ordners:', error)
    return null
  }
}

export async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(handle, HANDLE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function clearStoredDirectoryHandle(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(HANDLE_KEY)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function getOPFSDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage.getDirectory === 'function'
  ) {
    try {
      return await navigator.storage.getDirectory()
    } catch (err) {
      console.error('Fehler beim Abrufen des OPFS-Handles:', err)
      return null
    }
  }
  return null
}

export async function getFileFromDirectory(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<File | null> {
  const cleanPath = relativePath.replace(/^\/+|\/+$/g, '')
  if (!cleanPath) return null

  const parts = cleanPath.split('/').filter(Boolean)
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
  const cleanPath = relativePath.replace(/^\/+|\/+$/g, '')
  if (!cleanPath) return null

  // 0. Zuerst der Cache-Spiegel: Dateien, die die App gespeichert hat, werden
  //    über die Cache Storage API gespiegelt, damit der Service Worker sie
  //    ohne Ordner-Berechtigung ausliefern kann.
  try {
    const cached = await getCachedFile(cleanPath)
    if (cached) return cached
  } catch (err) {
    console.warn('findSavedFile Cache Fehler:', err)
  }

  // 1. Try FSA handle stored in IndexedDB
  try {
    const storedHandle = await getStoredDirectoryHandle()
    if (storedHandle) {
      let perm: PermissionState = 'granted'
      if (storedHandle.queryPermission) {
        try {
          perm = await storedHandle.queryPermission({ mode: 'read' })
        } catch {
          perm = 'prompt'
        }
      }
      if (perm === 'granted') {
        const file = await getFileFromDirectory(storedHandle, relativePath)
        if (file) return file
      }
    }
  } catch (err) {
    console.warn('findSavedFile FSA Fehler:', err)
  }

  // 2. Try OPFS
  try {
    const opfsHandle = await getOPFSDirectoryHandle()
    if (opfsHandle) {
      const file = await getFileFromDirectory(opfsHandle, relativePath)
      if (file) return file
    }
  } catch (err) {
    console.warn('findSavedFile OPFS Fehler:', err)
  }

  return null
}

/**
 * Name des Cache-Speichers, in dem gespeicherte Dateien für den Service Worker
 * gespiegelt werden.
 */
export const FILES_CACHE_NAME = 'pwa-islands-files-v1'

function cachedFileRequest(name: string): Request {
  const cleanPath = name.replace(/^\/+|\/+$/g, '')
  // Schrägstriche müssen erhalten bleiben, damit Dateien in Unterordnern unter
  // ihrem vollen relativen Pfad (z. B. /projekte/meta.txt) abgelegt werden.
  // encodeURIComponent würde sie zu %2F machen und den Pfad zerstören.
  const encodedPath = cleanPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return new Request(`${location.origin}/${encodedPath}`)
}

/**
 * Legt eine Kopie einer gespeicherten Datei im Cache ab, damit der Service
 * Worker sie unter /<name> ausliefern kann.
 */
export async function cacheFile(name: string, content: string | Blob): Promise<void> {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(FILES_CACHE_NAME)
  const request = cachedFileRequest(name)
  let body: Blob
  if (typeof content === 'string') {
    body = new Blob([content], { type: getMimeType(name) })
  } else {
    body = content
  }
  await cache.put(
    request,
    new Response(body, {
      status: 200,
      headers: {
        'Content-Type': getMimeType(name, body.type),
        'Content-Length': body.size.toString(),
      },
    })
  )
}

/** Entfernt eine gespiegelte Datei aus dem Cache. */
export async function uncacheFile(name: string): Promise<void> {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(FILES_CACHE_NAME)
  await cache.delete(cachedFileRequest(name))
}

/** Liest eine gespiegelte Datei aus dem Cache (für den Service Worker). */
export async function getCachedFile(name: string): Promise<File | null> {
  if (typeof caches === 'undefined') return null
  const cache = await caches.open(FILES_CACHE_NAME)
  const response = await cache.match(cachedFileRequest(name))
  if (!response) return null
  const blob = await response.blob()
  return new File([blob], name, {
    type: response.headers.get('Content-Type') ?? getMimeType(name),
  })
}

/** Listet alle im Cache gespiegelten Dateinamen auf. */
export async function listCachedFileNames(): Promise<string[]> {
  if (typeof caches === 'undefined') return []
  const cache = await caches.open(FILES_CACHE_NAME)
  const requests = await cache.keys()
  return requests
    .map((req) => {
      const pathname = new URL(req.url).pathname
      if (!pathname.startsWith('/') || pathname.startsWith('/files')) return ''
      return decodeURIComponent(pathname.slice(1))
    })
    .filter((name) => name.length > 0)
}

const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
}

export function getMimeType(filename: string, fallback?: string): string {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex !== -1) {
    const ext = filename.slice(dotIndex + 1).toLowerCase()
    if (ext in MIME_TYPES) {
      return MIME_TYPES[ext]
    }
  }
  return fallback && fallback.length > 0 ? fallback : 'application/octet-stream'
}
