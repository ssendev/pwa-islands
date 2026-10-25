import { Array } from "effect"

export const DB_NAME = "pwa-islands-db"
export const DB_VERSION = 1
export const STORE_NAME = "handles"
export const HANDLE_KEY = "selected_folder"
export const STORAGE_TYPE_KEY = "selected_storage_type"
/**
 * Schluessel fuer die Sichtbarkeit von Groesse und Aenderungsdatum in der
 * Dateiliste (Zahnrad -> "Datei-Infos"). Absichtlich eine eigene Zeile in der
 * Ablage statt eines Feldes an der Speicherart: die Einstellung gehoert zur
 * Ansicht und soll auch beim Wechsel zwischen lokalem Ordner und App-Speicher
 * erhalten bleiben.
 */
export const FILE_INFO_VISIBLE_KEY = "file_info_visible"
export const ISLAND_PARAM = "pwaislands"

/**
 * OPFS hat pro Origin nur EINE Wurzel -- eine zweite Wurzel laesst sich nicht
 * waehlen. Damit die App nicht direkt im Origin-Wurzelverzeichnis schreibt,
 * liegen alle Dateien in diesem Unterordner.
 */
export const OPFS_APP_FOLDER = "PWA Islands"

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Oeffnet die IndexedDB genau einmal je Seitenaufruf.
 *
 * Der Service Worker fragt die Wurzel bei jeder Anfrage nach -- also auch fuer
 * jedes CSS, JS und Bild einer Island. Ohne diesen Zwischenspeicher wuerde jede
 * Anfrage eine neue Verbindung aufbauen, was den groessten Teil der Antwortzeit
 * ausmacht.
 */
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
  // Fehlversuch nicht festschreiben, sonst bliebe die App dauerhaft ohne DB.
  // Der Fehler wird hier nicht geschluckt: `pending` bleibt für den Aufrufer
  // abgelehnt, nur der Zwischenspeicher wird geraeumt.
  void pending.catch(() => {
    if (dbPromise === pending) dbPromise = null
  })

  return pending
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

/**
 * Liest, ob die Dateiliste Groesse und Aenderungsdatum zeigt. Vorgabe ist
 * `true`: ohne gespeicherte Wahl bleibt die gewohnte Tabellenansicht stehen.
 *
 * Fehler (kein IndexedDB, gesperrte Ablage) liefern ebenfalls `true` -- eine
 * fehlende Einstellung darf die Liste nicht veraendern.
 */
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

/** Speichert, ob die Dateiliste Groesse und Aenderungsdatum zeigt. */
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

/** Dateiname des Ordner-Index, wie bei einem Webserver. */
export const DEFAULT_INDEX_FILE = "index.html"

/** Eine gefundene gespeicherte Datei samt Pfad, unter dem sie gefunden wurde. */
export interface SavedFile {
  file: File
  /**
   * Der Pfad, der tatsaechlich die Datei ist -- bei einem Ordner also
   * `"foo/index.html"` statt `"foo"`. Entscheidet ueber den MIME-Typ: aus
   * `"projekte/v1.2"` laesst sich keine Endung ableiten, aus
   * `"projekte/v1.2/index.html"` schon.
   */
  path: string
}

const MISS_ERRORS = new Set(["NotFoundError", "TypeMismatchError"])

/**
 * Lauft den Pfad bis zum Elternordner ab. Liefert null, sobald ein Abschnitt
 * fehlt oder auf eine Datei zeigt -- ohne Ausnahme nach aussen.
 */
async function walkToParent(
  root: FileSystemDirectoryHandle,
  segments: ReadonlyArray<string>,
): Promise<FileSystemDirectoryHandle | null> {
  return await Array.reduce(
    segments,
    Promise.resolve<FileSystemDirectoryHandle | null>(root),
    async (currentPromise, segment) => {
      const current = await currentPromise
      if (!current) {
        return null
      }
      try {
        return await current.getDirectoryHandle(segment)
      } catch (err) {
        if (err instanceof DOMException && MISS_ERRORS.has(err.name)) {
          return null
        }
        throw err
      }
    },
  )
}

/**
 * Loest einen relativen Pfad zu einer gespeicherten Datei auf.
 *
 * Der Eintrag wird zuerst als Datei probiert, danach als Ordner mit
 * Index-Datei. Was er ist, entscheidet also das Dateisystem, nicht die
 * Schreibweise: ein Punkt im Namen sagt nichts -- "projekte/v1.2" ist ein
 * Ordner, "notes" eine Datei.
 *
 * Pro Aufruf kostet das im Trefferfall genau einen Handle-Zugriff; ein Ordner
 * kostet einen zusaetzlichen, weil der erste Versuch fehlschlaegt.
 */
export async function resolveFileInDirectory(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  indexFile = DEFAULT_INDEX_FILE,
): Promise<SavedFile | null> {
  const parts = splitPath(relativePath)
  if (Array.isReadonlyArrayEmpty(parts)) {
    return null
  }

  const parent = await walkToParent(root, parts.slice(0, -1))
  if (!parent) {
    return null
  }

  const name = parts[parts.length - 1]
  const filePath = parts.join("/")

  // 1. Der uebliche Fall: unter dem Pfad liegt direkt eine Datei.
  try {
    const fileHandle = await parent.getFileHandle(name)
    return { file: await fileHandle.getFile(), path: filePath }
  } catch (err) {
    if (!(err instanceof DOMException && MISS_ERRORS.has(err.name))) {
      throw err
    }
  }

  // 2. Ordner mit Index-Datei. Der zweite Versuch ist kein Fehler, sondern der
  //    Normalfall fuer /foo und /foo/ -- deshalb erst hier, nicht vorher.
  if (!indexFile) {
    return null
  }
  try {
    const dir = await parent.getDirectoryHandle(name)
    const fileHandle = await dir.getFileHandle(indexFile)
    return { file: await fileHandle.getFile(), path: `${filePath}/${indexFile}` }
  } catch (err) {
    if (err instanceof DOMException && MISS_ERRORS.has(err.name)) {
      return null
    }
    throw err
  }
}

let rootCache: { root: FileSystemDirectoryHandle | null } | null = null

/**
 * Verwirft den zwischengespeicherten Wurzel-Handle. Wird bei jedem Wechsel der
 * Speicherart oder des Ordners aufgerufen -- sonst zeigte die App weiter auf
 * den alten Speicher.
 */
export function invalidateRootCache(): void {
  rootCache = null
}

/**
 * Wie {@link findActiveStorage}, aber ohne erneuten IndexedDB-Zugriff bei jeder
 * Anfrage. Der Wert wird nur bei einem Wechsel der Speicherart oder des Ordners
 * verworfen (siehe {@link invalidateRootCache}).
 *
 * Eine fehlende Berechtigung wird bewusst NICHT zwischengespeichert: sie kann
 * der Benutzer jederzeit erteilen, ohne dass ein Ereignis hier ankaeme.
 */
async function findCachedActiveStorage(): Promise<FileSystemDirectoryHandle | null> {
  if (rootCache) {
    return rootCache.root
  }
  const root = await findActiveStorage()
  // null (kein Speicher) nicht festschreiben -- sonst bliebe die App nach dem
  // spaeteren Waehlen eines Ordners stumm.
  if (root) rootCache = { root }
  return root
}

/**
 * Sucht eine gespeicherte Datei zum relativen Pfad in der aktiven Speicherwurzel.
 * Liefert die Datei samt effektivem Pfad (siehe {@link SavedFile}).
 */
export async function findSavedFile(
  relativePath: string,
  indexFile = DEFAULT_INDEX_FILE,
): Promise<SavedFile | null> {
  if (Array.isReadonlyArrayEmpty(splitPath(relativePath))) {
    return null
  }

  try {
    const root = await findCachedActiveStorage()
    if (!root) {
      return null
    }
    return await resolveFileInDirectory(root, relativePath, indexFile)
  } catch (err) {
    console.warn("findSavedFile Fehler:", err)
    return null
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

/**
 * Findet die aktive Speicher-Wurzel: zuerst der gespeicherte FSA-Ordner,
 * danach OPFS. Liefert null, wenn keiner verfügbar ist (z. B. wenn die
 * Berechtigung für den gespeicherten Ordner fehlt).
 */
export async function findActiveStorage(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const storedType = await getStoredStorageType()
    if (storedType === "opfs") {
      try {
        return await getOPFSDirectoryHandle()
      } catch (err) {
        console.warn("findActiveStorage OPFS Fehler:", err)
        return null
      }
    }

    const storedHandle = await getStoredDirectoryHandle()
    if (storedHandle) {
      const perm: PermissionState = storedHandle.queryPermission
        ? await storedHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const)
        : "granted"
      if (perm === "granted") {
        return storedHandle
      }
    }

    if (!storedType) {
      return await getOPFSDirectoryHandle()
    }
  } catch (err) {
    console.warn("findActiveStorage Fehler:", err)
  }

  return null
}

/**
 * Läuft von einer Wurzel-Handle entlang der Pfadsegmente zu einem
 * Verzeichnis. Mit create=true werden fehlende Ordner angelegt.
 */
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
