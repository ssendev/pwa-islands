// IndexedDB-Persistenz wird aus storage.ts wiederverwendet (siehe Import).
import {
  getStoredDirectoryHandle,
  storeDirectoryHandle,
  clearStoredDirectoryHandle,
  getStoredStorageType,
  storeStorageType,
  clearStoredStorageType,
  getOPFSDirectoryHandle,
  ISLAND_PARAM,
} from "./storage.ts"
import rootIconUrl from "./assets/pwa-islands.svg"

export interface FileEntry {
  name: string
  kind: "file" | "directory"
  size?: number
  lastModified?: number
}

/**
 * Generische Abstraktion über Dateisystem-Backends (File System Access API & OPFS).
 */
export interface IFileStorage {
  readonly type: "fsa" | "opfs"
  readonly name: string
  /** Anzeigename des Wurzelordners ohne Unterpfad. */
  readonly rootName: string
  readonly isFallback: boolean
  readonly canChangeFolder: boolean

  listFiles(): Promise<FileEntry[]>
  readFile(name: string): Promise<string>
  /** Liest die Datei als Blob -- fuer Binaerdateien, die der Editor nicht anfassen darf. */
  readFileBlob(name: string): Promise<Blob>
  /** Groesse in Bytes, ohne die Datei zu laden (0, wenn unbekannt). */
  getFileSize(name: string): Promise<number>
  createFile(name: string, content: string | Blob): Promise<void>
  writeFile(name: string, content: string | Blob): Promise<void>
  createDirectory(name: string): Promise<void>
  deleteEntry(name: string): Promise<void>
  /** True, wenn unter dem Namen bereits eine Datei oder ein Ordner liegt. */
  hasEntry(name: string): Promise<boolean>
  entryKind(name: string): Promise<"file" | "directory" | null>
  /** Benennt eine Datei oder einen Ordner um. */
  renameEntry(oldName: string, newName: string): Promise<void>
  ensureWritePermission(): Promise<boolean>
}

/**
 * Universelle Implementierung für FileSystemDirectoryHandle (funktioniert für FSA und OPFS).
 */
export class FileSystemHandleStorage implements IFileStorage {
  private readonly handle: FileSystemDirectoryHandle
  readonly type: "fsa" | "opfs"
  readonly isFallback: boolean
  /**
   * Anzeigename (z. B. "Origin Private File System" oder der Ordnername), damit
   * der Pfad in der Oberfläche erhalten bleibt, wenn in einen Unterordner
   * gewechselt wird.
   */
  private readonly displayName: string
  /** Pfad dieses Ordners relativ zur Wurzel, z. B. "projekte" oder "a/b". */
  readonly subPath: string
  /** Wurzel-Handle, auf dem die Navigation gestartet wurde (für "nach oben"). */
  readonly rootHandle: FileSystemDirectoryHandle

  constructor(
    handle: FileSystemDirectoryHandle,
    type: "fsa" | "opfs",
    isFallback: boolean = false,
    subPath: string = "",
    displayName?: string,
    rootHandle?: FileSystemDirectoryHandle,
  ) {
    this.handle = handle
    this.type = type
    this.isFallback = isFallback
    this.subPath = subPath
    this.rootHandle = rootHandle ?? handle
    this.displayName = displayName ?? (type === "opfs" ? "Origin Private File System" : handle.name)
  }

  get name(): string {
    return this.subPath ? `${this.displayName}/${this.subPath}` : this.displayName
  }

  /** Anzeigename des Wurzelordners ohne Unterpfad. */
  get rootName(): string {
    return this.displayName
  }

  get canChangeFolder(): boolean {
    return this.type === "fsa"
  }

  get rawHandle(): FileSystemDirectoryHandle {
    return this.handle
  }

  async listFiles(): Promise<FileEntry[]> {
    const entries: FileEntry[] = []

    for await (const entry of this.handle.values()) {
      if (entry.kind === "file") {
        try {
          const file = await entry.getFile()
          entries.push({
            name: entry.name,
            kind: "file",
            size: file.size,
            lastModified: file.lastModified,
          })
        } catch {
          entries.push({
            name: entry.name,
            kind: "file",
          })
        }
      } else if (entry.kind === "directory") {
        entries.push({
          name: entry.name,
          kind: "directory",
        })
      }
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name, "de", { sensitivity: "base", numeric: true })
    })

    return entries
  }

  async readFile(name: string): Promise<string> {
    const fileHandle = await this.handle.getFileHandle(name)
    const file = await fileHandle.getFile()
    return await file.text()
  }

  async readFileBlob(name: string): Promise<Blob> {
    const fileHandle = await this.handle.getFileHandle(name)
    return await fileHandle.getFile()
  }

  async getFileSize(name: string): Promise<number> {
    try {
      const fileHandle = await this.handle.getFileHandle(name)
      return (await fileHandle.getFile()).size
    } catch (err) {
      console.warn(`Groesse von "${name}" nicht lesbar:`, err)
      return 0
    }
  }

  async ensureWritePermission(): Promise<boolean> {
    if (this.type !== "fsa") return true
    if (!this.handle.queryPermission || !this.handle.requestPermission) return true

    let perm = await this.handle.queryPermission({ mode: "readwrite" })
    if (perm === "granted") return true

    perm = await this.handle.requestPermission({ mode: "readwrite" })
    return perm === "granted"
  }

  async createFile(name: string, content: string | Blob): Promise<void> {
    if (!(await this.ensureWritePermission())) {
      throw new Error("Schreibzugriff verweigert.")
    }
    // Vorhandene Dateien nicht ueberschreiben -- auch nicht, wenn der Name
    // bereits als Ordner existiert (dann meldet der Browser TypeMismatchError).
    if (await this.hasEntry(name)) {
      throw new Error(`Datei "${name}" existiert bereits.`)
    }
    const fileHandle = await this.handle.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  /**
   * Überschreibt eine vorhandene Datei (oder erstellt sie, falls sie fehlt).
   * Für Bearbeitungen, im Gegensatz zu {@link createFile}.
   */
  async writeFile(name: string, content: string | Blob): Promise<void> {
    if (!(await this.ensureWritePermission())) {
      throw new Error("Schreibzugriff verweigert.")
    }
    const fileHandle = await this.handle.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async createDirectory(name: string): Promise<void> {
    if (!(await this.ensureWritePermission())) {
      throw new Error("Schreibzugriff verweigert.")
    }
    await this.handle.getDirectoryHandle(name, { create: true })
  }

  async deleteEntry(name: string): Promise<void> {
    if (!(await this.ensureWritePermission())) {
      throw new Error("Schreibzugriff verweigert.")
    }
    await this.handle.removeEntry(name, { recursive: true })
  }

  /**
   * Benennt eine Datei oder einen Ordner um. Die Plattform kennt kein
   * Umbenennen; daher wird kopiert und anschliessend das Original geloescht.
   * Existiert das Ziel bereits, wird nichts veraendert.
   */
  async renameEntry(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return
    if (oldName.includes("/") || newName.includes("/")) {
      throw new Error("Name darf keinen Schraegstrich enthalten.")
    }
    if (!(await this.ensureWritePermission())) {
      throw new Error("Schreibzugriff verweigert.")
    }

    // Kollision vorab pruefen: `getFileHandle`/`getDirectoryHandle` liefern
    // ohne `create` einen NotFoundError, wenn der Name frei ist.
    if (await this.hasEntry(newName)) {
      throw new Error(`"${newName}" existiert bereits.`)
    }

    let kind: FileSystemHandleKind
    try {
      kind = (await this.handle.getFileHandle(oldName)).kind
    } catch (err) {
      if (
        !(
          err instanceof DOMException &&
          (err.name === "NotFoundError" || err.name === "TypeMismatchError")
        )
      ) {
        throw err
      }
      kind = (await this.handle.getDirectoryHandle(oldName)).kind
    }

    if (kind === "file") {
      const source = await this.handle.getFileHandle(oldName)
      const target = await this.handle.getFileHandle(newName, { create: true })
      const writable = await target.createWritable()
      await writable.write(await source.getFile())
      await writable.close()
    } else {
      await this.copyDirectoryEntry(oldName, newName)
    }

    await this.handle.removeEntry(oldName, { recursive: true })
  }

  /**
   * True, wenn unter dem Namen bereits Datei oder Ordner existiert. Wird unter
   * dem Namen ein Ordner gefunden, melden Browser einen `TypeMismatchError` --
   * der zaehlt hier ebenfalls als "belegt".
   */
  async hasEntry(name: string): Promise<boolean> {
    return (await this.entryKind(name)) !== null
  }

  /**
   * Fragt Datei und Ordner der Reihe nach ab; was zuerst greift, gewinnt.
   *
   * `TypeMismatchError` heisst "der Name existiert, aber als das andere" --
   * das wird hier zu `null` fuer diese Abfrage und die andere entscheidet.
   */
  async entryKind(name: string): Promise<"file" | "directory" | null> {
    const misses = new Set(["NotFoundError", "TypeMismatchError"])
    const isMiss = (err: unknown) => err instanceof DOMException && misses.has(err.name)

    try {
      await this.handle.getFileHandle(name)
      return "file"
    } catch (err) {
      if (!isMiss(err)) throw err
    }
    try {
      await this.handle.getDirectoryHandle(name)
      return "directory"
    } catch (err) {
      if (!isMiss(err)) throw err
    }
    return null
  }

  /** Kopiert einen Ordner samt Inhalt rekursiv unter einen neuen Namen. */
  private async copyDirectoryEntry(sourceName: string, targetName: string): Promise<void> {
    const source = await this.handle.getDirectoryHandle(sourceName)
    const target = await this.handle.getDirectoryHandle(targetName, { create: true })

    for await (const entry of source.values()) {
      if (entry.kind === "file") {
        const file = await (entry as FileSystemFileHandle).getFile()
        const targetFile = await target.getFileHandle(entry.name, { create: true })
        const writable = await targetFile.createWritable()
        await writable.write(file)
        await writable.close()
      } else {
        await this.copyDirectoryInto(entry as FileSystemDirectoryHandle, target)
      }
    }
  }

  /** Rekursionshelfer: kopiert `source` inklusive Inhalt nach `target`. */
  private async copyDirectoryInto(
    source: FileSystemDirectoryHandle,
    target: FileSystemDirectoryHandle,
  ): Promise<void> {
    const nested = await target.getDirectoryHandle(source.name, { create: true })
    for await (const entry of source.values()) {
      if (entry.kind === "file") {
        const file = await (entry as FileSystemFileHandle).getFile()
        const targetFile = await nested.getFileHandle(entry.name, { create: true })
        const writable = await targetFile.createWritable()
        await writable.write(file)
        await writable.close()
      } else {
        await this.copyDirectoryInto(entry as FileSystemDirectoryHandle, nested)
      }
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp))
}

/**
 * Visueller Inhalt einer Datei, die der Editor nicht als Text anbietet.
 * `previewUrl` ist eine Object-URL und muss beim Schliessen freigegeben werden.
 */
interface ContentPreview {
  kind: "image"
  previewUrl: string
}

interface EditorModalOptions {
  /** 'file' zeigt zusaetzlich den Inhalt, 'folder' nur den Namen. */
  kind: "file" | "folder"
  /** 'create' legt neu an, 'edit' aendert Name und/oder Inhalt. */
  mode: "create" | "edit"
  name?: string
  initialContent?: string
  /**
   * Nur bei Binaerdateien gesetzt: dann gibt es kein Inhaltsfeld, sondern nur
   * die Vorschau bzw. die Base64-Option. Der Inhalt bleibt beim Speichern
   * unveraendert.
   */
  contentLocked?: boolean
  /** Optionale Vorschau statt Textfeld (z. B. ein Bild). */
  preview?: ContentPreview
  /**
   * Nur bei Binaerdateien unterhalb der Groessengrenze: erlaubt das Bearbeiten
   * der Datei als Base64-Text. `base64` ist die Vorabbelegung des Feldes.
   */
  base64Editable?: boolean
  base64?: string
  onSave: (name: string, content: string | Blob | null) => Promise<void>
  /** Nur bei mode 'edit': loescht den Eintrag. */
  onDelete?: () => Promise<void>
  /**
   * Wird beim Schliessen des Fensters aufgerufen (nach `onSave`/`onDelete`).
   * Der Aufrufer setzt hier die Adresszeile vom Eintrag ("...=edit") zurueck
   * auf den Ordnerlink.
   */
  onClose?: () => void
}

/**
 * Baut eine Bildvorschau ueber eine Object-URL. Der Aufrufer (Editor-Modal)
 * gibt die URL beim Schliessen wieder frei.
 */
function buildImagePreview(blob: Blob): ContentPreview {
  return {
    kind: "image",
    previewUrl: URL.createObjectURL(blob),
  }
}

/** Dateiendungen, die als Bild angezeigt werden koennen (Browser-Standard). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"])

/** Obergrenze fuer Dateien, die der Editor als Text laedt (10 MB). */
const MAX_EDITABLE_TEXT_BYTES = 10 * 1024 * 1024

/** Dateiendungen, die der Editor als Text oeffnen und speichern darf. */
const TEXT_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "css",
  "json",
  "webmanifest",
  "txt",
  "md",
  "csv",
  "svg",
  "xml",
  "yml",
  "yaml",
  "sh",
  "toml",
  "ini",
  "map",
])

/**
 * Prueft, ob eine Datei gefahrlos als Text bearbeitet werden kann: sie muss
 * vollstaendig gelesen werden koennen und beim Zurueckwandeln in Bytes wieder
 * exakt dieselben Daten ergeben (UTF-8-Roundtrip). Nur dann ist garantiert,
 * dass ein Speichern ohne Aenderung die Datei nicht veraendert.
 *
 * Eine reine Endungspruefung reicht nicht -- eine `.png`, die als `.xml`
 * gespeichert wurde, wuerde sonst beim Speichern zerstoert.
 *
 * Grosse Dateien werden nie als Text geoeffnet: das Dekodieren im Browser
 * blockiert die Oberflaeche. Sie gelten ab {@link MAX_EDITABLE_TEXT_BYTES} als
 * Blob (nur umbenennen/loeschen).
 */
async function isEditableTextFile(file: Blob, name: string): Promise<boolean> {
  const ext = getExtension(name)
  if (!TEXT_EXTENSIONS.has(ext)) return false
  if (file.size > MAX_EDITABLE_TEXT_BYTES) return false

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // `ignoreBOM: true` behaelt die Bytefolge bei -- sonst wuerde ein fuehrendes
    // BOM beim Speichern verloren gehen und der Vergleich scheitern.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    if (text.includes("\uFFFD")) return false
    const roundtrip = new TextEncoder().encode(text)
    if (roundtrip.length !== bytes.length) return false
    for (let i = 0; i < bytes.length; i++) {
      if (roundtrip[i] !== bytes[i]) return false
    }
    return true
  } catch {
    // `fatal: true` wirft bei ungueltigem UTF-8 -- genau der Binaerfall.
    return false
  }
}

/** Endung ohne Punkt, klein geschrieben; leer, wenn keine vorhanden ist. */
function getExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".")
  return dotIndex === -1 || dotIndex === name.length - 1
    ? ""
    : name.slice(dotIndex + 1).toLowerCase()
}

/**
 * Sucht den tiefsten Ordner, den der Pfad hergibt -- in einem Durchgang.
 *
 * `/foo/bar.html` liefert `foo` (der Pfad zeigt auf eine Datei, also bleibt
 * der Elternordner uebrig), `/foo/sub` liefert `foo/sub`, ein unbekannter Pfad
 * die Wurzel `""`. Die Sicht des Dateisystems entscheidet; der Name wird nicht
 * gedeutet.
 */
async function findDeepestDirectory(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  let handle = root
  let reached = ""
  for (const segment of path ? path.split("/") : []) {
    try {
      handle = await handle.getDirectoryHandle(segment)
    } catch {
      break
    }
    reached = reached ? `${reached}/${segment}` : segment
  }
  return reached
}

/**
 * Uebersetzt die Fehler des File System Access API beim Ordnerwechsel in eine
 * verstaendliche deutsche Meldung.
 *
 * Die Browser liefern `NotFoundError` (Ordner fehlt) bzw. `TypeMismatchError`
 * mit dem englischen Text "Wrong type" (der Eintrag ist eine Datei, kein
 * Ordner). Letzteres sieht man, wenn eine Adresse auf eine Datei zeigt -- die
 * rohe Meldung sagt dann nichts aus.
 */
function describeFolderError(err: unknown): string {
  const name = err instanceof Error ? err.name : ""
  if (name === "TypeMismatchError") return "Der Eintrag ist eine Datei, kein Ordner."
  if (name === "NotFoundError") return "Der Ordner wurde nicht gefunden."
  if (name === "NotAllowedError") return "Kein Zugriff auf den Ordner."
  return err instanceof Error ? err.message : String(err)
}

/**
 * Maskiert Text fuer die Ausgabe in HTML-Attributen und -Textknoten.
 * Datei- und Ordnernamen koennen beliebige Zeichen enthalten.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Baut den Pfad als Breadcrumb. Jeder Abschnitt ist ein Button mit seinem
 * Zielpfad in `data-segment`; der letzte Eintrag ist der aktuelle Ordner und
 * daher nicht anklickbar. Die Wurzel ist immer "PWA Islands" -- unabhaengig
 * davon, ob lokal (FS API) oder im App-Speicher (OPFS) gearbeitet wird. Das
 * App-Icon gehoert NICHT zum Pfad: es steht als eigenes Element ("Item 1")
 * neben den Buttons in der Toolbar.
 */
function buildBreadcrumbs(storage: FileSystemHandleStorage): string {
  return breadcrumbSegments(storage.subPath)
    .map((segment, index, all) => {
      const isLast = index === all.length - 1
      // Erster Abschnitt ohne Auslassungspunkt, alle weiteren davor.
      const separator =
        index === 0 ? "" : `<span class="breadcrumb-separator" aria-hidden="true">/</span>`
      if (isLast) {
        return `${separator}<span class="breadcrumb-current">${escapeHtml(segment.label)}</span>`
      }
      return `${separator}<button type="button" class="breadcrumb-item" data-segment="${escapeHtml(
        segment.path,
      )}" title="${escapeHtml(segment.label)}">${escapeHtml(segment.label)}</button>`
    })
    .join("")
}

interface BreadcrumbSegment {
  /** Angezeigter Text. */
  label: string
  /** Zielpfad ab der Wurzel; "" steht fuer die Wurzel selbst. */
  path: string
}

/**
 * Zerlegt einen Ordnerpfad in Breadcrumb-Abschnitte. Die Wurzel ist immer
 * "PWA Islands" -- unabhaengig davon, ob lokal (FS API) oder im App-Speicher
 * (OPFS) gearbeitet wird.
 *
 * Wird auch fuer den Fenstertitel benutzt, damit Titel und Brotkrumen nicht
 * auseinanderlaufen koennen.
 */
function breadcrumbSegments(folderPath: string): BreadcrumbSegment[] {
  const rootLabel = "PWA Islands"
  const segments = folderPath ? folderPath.split("/") : []
  const result: BreadcrumbSegment[] = [{ label: rootLabel, path: "" }]

  let accumulated = ""
  for (const segment of segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    result.push({ label: segment, path: accumulated })
  }

  return result
}

/**
 * Baut aus einem Base64-Text wieder einen Blob. Whitespace und Zeilenumbrueche
 * werden ignoriert; ungueltige Zeichen fuehren zu einer verstaendlichen Meldung,
 * damit nicht versehentlich eine kaputte Datei gespeichert wird.
 */
function base64ToBlob(base64: string): Blob {
  const cleaned = base64.replace(/\s+/g, "")
  let binary: string
  try {
    binary = atob(cleaned)
  } catch {
    throw new Error("Der Base64-Inhalt ist ungültig.")
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes])
}

/**
 * Baut aus einem Blob den Base64-Text fuer das Bearbeitungsfeld.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/**
 * Baut den Inhaltsbereich des Editors: bei editierbaren Textdateien das
 * Textfeld, bei Binaerdateien nur einen kurzen Hinweis -- plus eine Vorschau
 * (Bild) und/oder die Option, die Bytes als Base64 zu bearbeiten.
 */
function renderFileContent(options: {
  locked: boolean
  preview?: ContentPreview
  base64Editable?: boolean
}): string {
  const editorHtml = `<div class="form-group">
      <label for="modal-file-content">Inhalt:</label>
      <textarea
        id="modal-file-content"
        class="form-textarea"
        placeholder="Geben Sie hier den Dateiinhalt ein..."
      ></textarea>
    </div>`

  if (!options.locked) return editorHtml

  const previewHtml =
    options.preview?.kind === "image"
      ? `<figure id="modal-file-preview" class="file-preview">
          <img
            src="${escapeHtml(options.preview.previewUrl)}"
            alt="Vorschau der Datei"
            class="file-preview-image"
          />
        </figure>`
      : ""

  const base64Html = options.base64Editable
    ? `<label class="form-check">
        <input type="checkbox" id="modal-use-base64" />
        <span>Binärdatei bearbeiten</span>
      </label>
      <div id="modal-base64-editor" class="form-group" hidden>
        <label for="modal-file-content-b64">Base64-Inhalt:</label>
        <textarea
          id="modal-file-content-b64"
          class="form-textarea form-textarea-mono"
          spellcheck="false"
          placeholder="Base64-Daten dieser Datei"
        ></textarea>
      </div>`
    : ""

  return `<div class="form-group">
    ${base64Html}
    ${previewHtml}
  </div>`
}

/**
 * Fragt bei einem Namenskonflikt beim Import nach: ueberschreiben, umbenennen
 * oder ueberspringen. Die Option "fuer alle" wird separat gefragt (siehe
 * {@link askApplyToAll}).
 */
function askImportCollision(name: string): "replace" | "rename" | "skip" {
  if (confirm(`"${name}"\n\nexistiert bereits. überschreiben?`)) {
    return "replace"
  }
  // Zweite Frage: umbenennen, wenn nicht ersetzt werden soll.
  if (confirm(`"${name}"\n\numbenennen?`)) {
    return "rename"
  }
  return "skip"
}

/**
 * Nach der ersten Entscheidung einmalig fragen, ob sie fuer alle weiteren
 * Konflikte gelten soll. `count` sind die noch offenen Konflikte.
 */
function askApplyToAll(decision: "replace" | "rename" | "skip", count: number): boolean {
  const label =
    decision === "replace" ? "überschreiben" : decision === "rename" ? "umbenennen" : "überspringen"
  return confirm(`Alle weiteren ${count} Konflikte auch ${label}?`)
}

/**
 * Zaehlt, wie viele der noch folgenden Dateien einen Namenskonflikt haben.
 * `files` sind die importierten Dateien, `fromIndex` die naechste Position.
 */
async function countRemainingCollisions(
  storage: IFileStorage,
  files: File[],
  fromIndex: number,
): Promise<number> {
  let count = 0
  const seen = new Set<string>()
  for (let i = fromIndex; i < files.length; i++) {
    const name = files[i].name
    if (seen.has(name)) {
      count++
      continue
    }
    seen.add(name)
    if (await storage.hasEntry(name)) count++
  }
  return count
}

/**
 * Sucht einen freien Namen der Form "name (1).ext", "name (2).ext", ...
 * Heisst die Datei bereits "name (2).ext", wird ab 3 weitergezaehlt -- eine
 * vorhandene Datei wird dabei nie ueberschrieben.
 */
async function findFreeName(storage: IFileStorage, name: string): Promise<string> {
  if (!(await storage.hasEntry(name))) return name

  const dotIndex = name.lastIndexOf(".")
  let base = dotIndex > 0 ? name.slice(0, dotIndex) : name
  const ext = dotIndex > 0 ? name.slice(dotIndex) : ""

  // Bereits vorhandene Nummerierung aufgreifen: "foto (2)" -> Basis "foto", Start 3.
  let startIndex = 1
  const numbered = /^(.*) \((\d+)\)$/.exec(base)
  if (numbered) {
    base = numbered[1]
    startIndex = Number(numbered[2]) + 1
  }

  for (let i = startIndex; i < startIndex + 1000; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!(await storage.hasEntry(candidate))) return candidate
  }
  throw new Error(`Für "${name}" wurde kein freier Name gefunden.`)
}

/**
 * Schliesst ein offenes Bearbeiten-Fenster, falls eins da ist. Wird vom
 * Zurueck-Button benutzt: die Adresse springt dann auf den Ordnerlink zurueck
 * und das Fenster muss mitgehen.
 */
function closeOpenEditor(): void {
  const modal = document.querySelector<HTMLElement>(".modal-overlay")
  if (!modal) return
  // Den vorhandenen Schliessen-Weg nutzen, damit Listener, Object-URL und
  // `onClose` (Adresse zuruecksetzen) genau einmal laufen.
  modal.querySelector<HTMLButtonElement>(".modal-close-btn")?.click()
}

/**
 * Öffnet das Bearbeiten-Fenster für eine Datei oder einen Ordner. Im Modus
 * 'edit' lässt sich der Name ändern (Umbenennen) und der Eintrag löschen; bei
 * Dateien kommt das Inhaltsfeld hinzu.
 */
function openEditorModal(options: EditorModalOptions): void {
  const existingModal = document.querySelector(".modal-overlay")
  if (existingModal) existingModal.remove()

  const isCreate = options.mode === "create"
  const isFolder = options.kind === "folder"
  const noun = isFolder ? "Ordner" : "Datei"
  const title = isCreate ? `Neuen ${noun} erstellen` : `${noun} bearbeiten: ${options.name}`

  const modalOverlay = document.createElement("div")
  modalOverlay.className = "modal-overlay"

  modalOverlay.innerHTML = `
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header">
        <h3 id="modal-title">${escapeHtml(title)}</h3>
        <button type="button" class="modal-close-btn" aria-label="Schließen">&times;</button>
      </header>
      <form id="modal-form">
        <div class="modal-body">
          <div class="form-group">
            <label for="modal-file-name">${noun}name:</label>
            <input
              type="text"
              id="modal-file-name"
              class="form-input"
              value="${escapeHtml(options.name ?? (isFolder ? "Neuer Ordner" : "notiz.txt"))}"
              required
              placeholder="${isFolder ? "z. B. projekte" : "z. B. index.html, daten.json"}"
            />
          </div>
          ${
            isFolder
              ? ""
              : renderFileContent({
                  locked: Boolean(options.contentLocked),
                  preview: options.preview,
                  base64Editable: options.base64Editable,
                })
          }
        </div>
        <footer class="modal-footer">
          <div class="modal-footer-left">
            ${
              options.onDelete
                ? `<button type="button" id="modal-btn-delete" class="btn btn-danger icon-label-btn" aria-label="Löschen" data-tip="Löschen">
                    <span class="icon-label-btn-icon" aria-hidden="true">🗑️</span>
                    <span class="icon-label-btn-text">Löschen</span>
                  </button>`
                : ""
            }
          </div>
          <div class="modal-footer-right">
            <button type="button" id="modal-btn-cancel" class="btn btn-secondary icon-label-btn" aria-label="Abbrechen" data-tip="Abbrechen">
              <span class="icon-label-btn-icon" aria-hidden="true">✕</span>
              <span class="icon-label-btn-text">Abbrechen</span>
            </button>
            <button type="submit" id="modal-btn-save" class="btn btn-primary icon-label-btn" aria-label="${
              isCreate ? "Erstellen" : "Speichern"
            }" data-tip="${isCreate ? "Erstellen" : "Speichern"}">
              <span class="icon-label-btn-icon" aria-hidden="true">💾</span>
              <span class="icon-label-btn-text">${isCreate ? "Erstellen" : "Speichern"}</span>
            </button>
          </div>
        </footer>
      </form>
    </div>
  `

  document.body.appendChild(modalOverlay)

  const nameInput = modalOverlay.querySelector<HTMLInputElement>("#modal-file-name")!
  const contentTextarea = modalOverlay.querySelector<HTMLTextAreaElement>("#modal-file-content")
  const base64Checkbox = modalOverlay.querySelector<HTMLInputElement>("#modal-use-base64")
  const base64Wrapper = modalOverlay.querySelector<HTMLDivElement>("#modal-base64-editor")
  const base64Textarea = modalOverlay.querySelector<HTMLTextAreaElement>("#modal-file-content-b64")
  const form = modalOverlay.querySelector<HTMLFormElement>("#modal-form")!
  const closeBtn = modalOverlay.querySelector<HTMLButtonElement>(".modal-close-btn")!
  const cancelBtn = modalOverlay.querySelector<HTMLButtonElement>("#modal-btn-cancel")!
  const saveBtn = modalOverlay.querySelector<HTMLButtonElement>("#modal-btn-save")!
  const deleteBtn = modalOverlay.querySelector<HTMLButtonElement>("#modal-btn-delete")

  if (contentTextarea) {
    contentTextarea.value = options.initialContent ?? ""
    if (options.contentLocked) contentTextarea.readOnly = true
  }

  if (base64Textarea) base64Textarea.value = options.base64 ?? ""

  // Ohne Haken bleibt die Datei unangetastet und die Vorschau sichtbar. Mit Haken
  // wird der Base64-Text zur einzigen Inhaltsquelle und die Vorschau weicht dem
  // Feld.
  const previewFigure = modalOverlay.querySelector<HTMLElement>("#modal-file-preview")
  const syncBase64State = () => {
    const active = Boolean(base64Checkbox?.checked)
    if (base64Wrapper) base64Wrapper.hidden = !active
    if (previewFigure) previewFigure.hidden = active
    if (active) base64Textarea?.focus()
  }
  base64Checkbox?.addEventListener("change", syncBase64State)
  if (isCreate) {
    nameInput.focus()
    nameInput.select()
  } else if (contentTextarea && !options.contentLocked) {
    contentTextarea.focus()
  } else {
    // Bei gesperrtem Inhalt ist der Name das einzige Feld, das sich aendert.
    nameInput.focus()
  }

  function closeModal() {
    document.removeEventListener("keydown", handleKeydown)
    // Object-URLs belegen Speicher, bis sie freigegeben werden.
    if (options.preview?.previewUrl) URL.revokeObjectURL(options.preview.previewUrl)
    modalOverlay.remove()
    options.onClose?.()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closeModal()
    }
  }

  document.addEventListener("keydown", handleKeydown)
  closeBtn.addEventListener("click", closeModal)
  cancelBtn.addEventListener("click", closeModal)

  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    const name = nameInput.value.trim()
    if (!name) {
      alert(`Bitte geben Sie einen gültigen ${noun}namen ein.`)
      return
    }

    saveBtn.disabled = true
    saveBtn.querySelector<HTMLElement>(".icon-label-btn-text")!.textContent = "Wird gespeichert..."

    try {
      // Bei gesperrtem Inhalt (Binaerdatei) ist der Inhalt nur dann eine Quelle,
      // wenn die Base64-Bearbeitung aktiviert wurde; sonst null uebergeben und
      // die Datei bleibt byte-identisch.
      let payload: string | Blob | null
      if (!options.contentLocked) {
        payload = contentTextarea?.value ?? ""
      } else if (base64Checkbox?.checked && base64Textarea) {
        payload = base64ToBlob(base64Textarea.value)
      } else {
        payload = null
      }
      await options.onSave(name, payload)
      closeModal()
    } catch (err: unknown) {
      saveBtn.disabled = false
      saveBtn.querySelector<HTMLElement>(".icon-label-btn-text")!.textContent = isCreate
        ? "Erstellen"
        : "Speichern"
      alert(`Fehler beim Speichern: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  deleteBtn?.addEventListener("click", async () => {
    if (!options.onDelete) return
    if (!confirm(`Möchten Sie "${options.name}" wirklich löschen?`)) return

    deleteBtn.disabled = true
    deleteBtn.querySelector<HTMLElement>(".icon-label-btn-text")!.textContent = "Wird gelöscht..."

    try {
      await options.onDelete()
      closeModal()
    } catch (err: unknown) {
      deleteBtn.disabled = false
      deleteBtn.querySelector<HTMLElement>(".icon-label-btn-text")!.textContent = "Löschen"
      alert(`Löschen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/**
 * Deeplink aus der aktuellen Adresse, z. B. `/foo/bar.html?pwaislands=edit`.
 * Liefert null, wenn der Parameter fehlt (normale App-Adresse).
 */
interface IslandDeepLink {
  /**
   * Der ganze Pfad aus der Adresse, relativ zur Wurzel, z. B. "foo/bar.html".
   * Leer fuer die Wurzel.
   */
  path: string
  /** Der Wert des Parameters (z. B. "", "1", "e", "edit"), klein geschrieben. */
  mode: string
}

/**
 * Zerlegt einen URL-Pfad in seine Abschnitte und dekodiert sie.
 *
 * - "/foo/bar.html" -> ["foo", "bar.html"]
 * - "/"             -> []
 *
 * Ein ungueltiger Prozent-Code fuehrt zu einer leeren Liste -- die Adresse ist
 * dann nicht brauchbar und die App startet in der Wurzel.
 */
function pathSegments(pathname: string): string[] {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    return []
  }
}

/**
 * Der Pfad aus der Adresse als relativer Pfad zur Wurzel: "/foo/bar" -> "foo/bar".
 * Die Wurzel selbst ist "".
 */
function pathnameToPath(pathname: string): string {
  return pathSegments(pathname).join("/")
}

/**
 * Wertet den `?pwaislands`-Parameter aus (siehe ISLAND_PARAM). Nur bekannte
 * Schreibweisen gelten als Bearbeiten-Wunsch; alles andere zeigt die
 * Dateiverwaltung im passenden Ordner.
 */
function readIslandDeepLink(): IslandDeepLink | null {
  if (typeof window === "undefined") return null

  const params = new URLSearchParams(window.location.search)
  if (!params.has(ISLAND_PARAM)) return null

  const rawMode = (params.get(ISLAND_PARAM) ?? "").trim().toLowerCase()

  return { path: pathnameToPath(window.location.pathname), mode: rawMode }
}

/**
 * True, wenn der Parameter-Wert das Bearbeiten-Fenster oeffnen soll.
 * Nur bekannte Schreibweisen zaehlen -- ein blosses `?pwaislands` (leer) oder
 * `=1` zeigt die Datei nur in der Liste, nicht im Editor.
 */
function isEditMode(mode: string): boolean {
  return mode === "e" || mode === "edit" || mode === "bearbeiten" || mode === "true"
}

/**
 * Zerlegt einen Pfad in Elternpfad und letzten Abschnitt:
 * "foo/sub" -> { parentPath: "foo", name: "sub" }, "sub" -> { parentPath: "", name: "sub" }.
 *
 * Gebraucht, wenn ein Eintrag im Editor geoeffnet werden soll, ohne dass er
 * selbst das Ziel der Adresse ist: das Fenster zeigt den Eintrag innerhalb
 * seines Elternordners, also muss dorthin navigiert werden.
 */
function parentAndName(path: string): { parentPath: string; name: string } | null {
  if (!path) return null
  const segments = path.split("/").filter(Boolean)
  const name = segments.pop()
  if (!name) return null
  return { parentPath: segments.join("/"), name }
}

/**
 * Der Deeplink wird nur einmal je Seitenaufruf ausgewertet -- sonst wuerde
 * jedes erneute Einlesen der Liste (z. B. nach dem Speichern) den Editor
 * ungefragt wieder oeffnen.
 */
const islandDeepLink: IslandDeepLink | null = readIslandDeepLink()

/**
 * Baut aus dem Ordnerpfad die Adresse fuer die Adresszeile: `foo/bar` ->
 * `/foo/bar?pwaislands`.
 *
 * Der Ordner steht im Pfad, nicht in einem Hash -- die Adresse soll lesbar
 * sein und sich kopieren lassen. Der ISLAND_PARAM-Parameter sorgt dafuer,
 * dass der Service Worker die App-Shell ausliefert statt der unter dem Pfad
 * gespeicherten Datei bzw. des Index-Fallbacks (siehe sw.ts).
 *
 * Der Parameterwert wird bewusst geleert: der Bearbeiten-Wunsch (`=edit`) gilt
 * nur fuer den Aufruf, der ihn mitbringt. Nach dem Navigieren steht die
 * Adresse fuer "Dateiverwaltung in diesem Ordner", nicht fuer "Editor oeffnen"
 * -- sonst wuerde ein spaeteres Neuladen den Editor erneut aufreissen.
 */
function folderUrl(folderPath: string): string {
  return `${encodePath(folderPath)}?${ISLAND_PARAM}`
}

/**
 * Baut die Adresse fuer eine einzelne Datei: `foo/bar.html` mit Modus "edit"
 * wird zu `/foo/bar.html?pwaislands=edit`.
 *
 * Dieselbe Form, die ein Deeplink von aussen hat -- ein Kopieren der Adresse
 * aus dem offenen Editor ergibt also genau den Link, der die Datei spaeter
 * wieder im Editor oeffnet.
 */
function entryUrl(entryPath: string, mode: string): string {
  return `${encodePath(entryPath)}?${ISLAND_PARAM}=${encodeURIComponent(mode)}`
}

/** Kodiert einen relativen Pfad als absoluten URL-Pfad; "" wird zu "/". */
function encodePath(path: string): string {
  if (!path) return "/"
  return `/${path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`
}

/**
 * Voller relativer Pfad einer Datei inklusive Unterordner, z. B.
 * "projekte/meta.txt". Ausserhalb eines Ordners der blosse Name.
 */
function relativePathOf(storage: IFileStorage, name: string): string {
  if (storage instanceof FileSystemHandleStorage && storage.subPath) {
    return `${storage.subPath}/${name}`
  }
  return name
}

async function renderGenericFileList(
  contentEl: HTMLElement,
  storage: IFileStorage,
  handlers: {
    onRefresh: () => void
    onRequestNewFile: () => void
    onRequestNewFolder: () => void
    onRequestImport: () => void
    onRequestEdit: (name: string, kind: "file" | "directory") => void
    onRequestOpen: (name: string) => void
    onRequestOpenFolder: (name: string) => void
  },
): Promise<void> {
  contentEl.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Dateien werden geladen...</p>
    </div>
  `

  try {
    const entries = await storage.listFiles()

    if (entries.length === 0) {
      contentEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">📁</div>
          <h3>Ordner ist leer</h3>
        </div>
      `
      return
    }

    const fileCount = entries.filter((e) => e.kind === "file").length
    const dirCount = entries.filter((e) => e.kind === "directory").length

    let summaryText = ""
    if (dirCount > 0 && fileCount > 0) {
      summaryText = `${fileCount} ${fileCount === 1 ? "Datei" : "Dateien"}, ${dirCount} ${dirCount === 1 ? "Ordner" : "Ordner"}`
    } else if (fileCount > 0) {
      summaryText = `${fileCount} ${fileCount === 1 ? "Datei" : "Dateien"}`
    } else {
      summaryText = `${dirCount} ${dirCount === 1 ? "Ordner" : "Ordner"}`
    }

    const rows = entries
      .map((entry) => {
        const isDir = entry.kind === "directory"
        const icon = isDir ? "📁" : "📄"
        const sizeDisplay = isDir ? "—" : entry.size !== undefined ? formatBytes(entry.size) : "—"
        const dateDisplay = isDir
          ? "—"
          : entry.lastModified !== undefined
            ? formatDate(entry.lastModified)
            : "—"

        return `
          <tr class="file-row ${isDir ? "is-directory" : "is-file"}" data-entry="${encodeURIComponent(
            entry.name,
          )}" data-kind="${entry.kind}" title="${isDir ? "Ordner öffnen" : "Datei öffnen"}">
            <td class="file-name-cell">
              <span class="file-name-inner">
                <span class="file-icon" aria-hidden="true">${icon}</span>
                <span class="file-name" title="${entry.name}">${entry.name}</span>
              </span>
            </td>
            <td class="file-size-cell" data-label="Größe">${sizeDisplay}</td>
            <td class="file-date-cell" data-label="Zuletzt geändert" data-label-short="Geändert">${dateDisplay}</td>
            <td class="files-actions-cell">
              <div class="files-actions-inner">
                <button type="button" class="btn btn-secondary btn-sm btn-edit-entry" data-entry="${encodeURIComponent(
                  entry.name,
                )}" title="${isDir ? "Ordner bearbeiten" : "Datei bearbeiten"}" aria-label="${isDir ? "Ordner bearbeiten" : "Datei bearbeiten"}">
                  ✏️ <span class="btn-label">Bearbeiten</span>
                </button>
              </div>
            </td>
          </tr>
        `
      })
      .join("")

    contentEl.innerHTML = `
      <div class="files-summary">
        <span>${summaryText}</span>
      </div>
      <div class="table-responsive">
        <table class="files-table">
          <thead>
            <tr>
              <th scope="col" class="th-name">Name</th>
              <th scope="col" class="th-size">Größe</th>
              <th scope="col" class="th-date">Zuletzt geändert</th>
              <th scope="col" class="th-actions"><span class="visually-hidden">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `

    // Die ganze Zeile ist klickbar: Ordner oeffnen, Dateien laden. Die
    // Aktionsbuttons liegen in derselben Zeile und muessen den Klick
    // abfangen, damit Bearbeiten/Loeschen nicht zusaetzlich navigiert.
    contentEl.querySelectorAll<HTMLTableRowElement>(".file-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return
        const entryName = decodeURIComponent(row.dataset.entry || "")
        if (!entryName) return
        if (row.dataset.kind === "directory") handlers.onRequestOpenFolder(entryName)
        else handlers.onRequestOpen(entryName)
      })
    })

    const editButtons = contentEl.querySelectorAll<HTMLButtonElement>(".btn-edit-entry")
    editButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const target = e.currentTarget as HTMLButtonElement
        const entryName = decodeURIComponent(target.dataset.entry || "")
        const kind = target.closest(".file-row")?.getAttribute("data-kind")
        if (entryName)
          handlers.onRequestEdit(entryName, kind === "directory" ? "directory" : "file")
      })
    })
  } catch (err: unknown) {
    console.error("Fehler beim Laden der Dateiliste:", err)
    contentEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Fehler beim Lesen der Dateien</h3>
        <p>${err instanceof Error ? err.message : "Unbekannter Fehler aufgetreten."}</p>
        <button id="btn-retry-list" type="button" class="btn btn-primary">
          Erneut versuchen
        </button>
      </div>
    `
    contentEl
      .querySelector<HTMLButtonElement>("#btn-retry-list")
      ?.addEventListener("click", handlers.onRefresh)
  }
}

export function renderFilesView(container: HTMLElement): void {
  const hasDirectoryPicker = typeof window !== "undefined" && "showDirectoryPicker" in window
  const hasOPFS =
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function"

  const isFallbackToOPFS = !hasDirectoryPicker && hasOPFS

  container.innerHTML = `
    <div class="files-page">
      <div id="files-alert-area"></div>

      <div class="files-toolbar">
        <div class="folder-icon" aria-hidden="true">
          <img class="breadcrumb-root-icon" src="${rootIconUrl}" alt="" />
        </div>
        <div class="folder-actions" id="folder-actions"></div>
        <div class="folder-status-box" id="folder-status">
          <nav id="folder-name-display" class="breadcrumbs" aria-label="Pfad">Speicher wird überprüft...</nav>
        </div>
      </div>

      <div id="files-content" class="files-content">
        <div class="loading-state">
          <div class="spinner"></div>
          <p>Dateien werden geladen...</p>
        </div>
      </div>

      <input type="file" id="files-import-input" multiple style="display: none;" />
    </div>
  `

  const alertArea = container.querySelector<HTMLDivElement>("#files-alert-area")!
  const folderNameDisplay = container.querySelector<HTMLElement>("#folder-name-display")!
  const folderActions = container.querySelector<HTMLDivElement>("#folder-actions")!
  const filesContent = container.querySelector<HTMLDivElement>("#files-content")!
  const fileImportInput = container.querySelector<HTMLInputElement>("#files-import-input")!

  if (!hasDirectoryPicker && !hasOPFS) {
    folderNameDisplay.textContent = "Dateisystem-APIs nicht unterstützt"
    alertArea.innerHTML = `
      <div class="alert alert-danger">
        <strong>Browser wird nicht unterstützt:</strong> Weder die File System Access API noch OPFS sind in diesem Browser verfügbar.
      </div>
    `
    filesContent.innerHTML = `
      <div class="empty-state">
        <p>In dieser Umgebung ist keine kompatible lokale Dateisystem-API verfügbar.</p>
      </div>
    `
    return
  }

  let currentStorage: IFileStorage | null = null
  /**
   * Die aktuell gewaehlte Speicherart. Bleibt auch dann gesetzt, wenn (noch)
   * kein Ordner offen ist -- so bietet das Zahnrad-Menue im Leerzustand nur
   * den Wechsel in die *andere* Speicherart an.
   */
  let currentStorageType: "fsa" | "opfs" | null = null

  /** Sammelt die Menüeinträge des Zahnrads -- eine einzige Quelle der Wahrheit. */
  interface SettingsAction {
    id: string
    html: string
    /** Kurze Beschreibung der Speicherart, erscheint als Tooltip/Untertitel. */
    hint?: string
    danger?: boolean
    run: () => void
  }

  /**
   * Baut die Einträge des Zahnrad-Menüs. Reihenfolge ist immer:
   * 1. Speicherwechsel (immer zuerst, immer nur in die *andere* Art),
   * 2. Ordnerverwaltung (wechseln / trennen), falls verfügbar.
   * Welche Speicherart aktiv ist, entscheidet `currentStorageType`.
   */
  function buildSettingsActions(): SettingsAction[] {
    const actions: SettingsAction[] = []

    if (currentStorageType !== "opfs" && hasOPFS) {
      actions.push({
        id: "btn-use-opfs",
        html: "📦 Zu App-Speicher wechseln",
        hint: "App-Speicher (OPFS): liegt versteckt im Browser, funktioniert ohne Ordnerauswahl und ohne Berechtigung. Die Dateien sind aber an diesen Browser gebunden.",
        run: () => void handleUseOPFS(),
      })
    }

    if (currentStorageType !== "fsa" && hasDirectoryPicker) {
      actions.push({
        id: "btn-select-folder",
        html: "💻 Zu lokalem Ordner wechseln",
        hint: "Lokaler Ordner (FS API): ein normaler Ordner auf dem Gerät, jederzeit mit anderen Programmen bearbeitbar. Der Browser fragt nach Zugriff.",
        run: () => void handleSwitchToLocalFolder(),
      })
    }

    if (currentStorage?.canChangeFolder) {
      actions.push({
        id: "btn-change-folder",
        html: "📂 Ordner wechseln",
        run: () => void handleSelectFolder(),
      })
      actions.push({
        id: "btn-disconnect-folder",
        html: "🔌 Trennen",
        danger: true,
        run: () => void handleDisconnectFolder(),
      })
    }

    return actions
  }

  /** Baut das komplette Zahnrad-Menü; leer, wenn es nichts anzubieten gibt. */
  function renderSettingsMenu(): string {
    const actions = buildSettingsActions()
    if (actions.length === 0) return ""

    return `
      <div class="settings-menu" id="settings-menu">
        <button
          id="btn-settings"
          type="button"
          class="btn btn-secondary btn-icon"
          aria-haspopup="true"
          aria-expanded="false"
          aria-label="Einstellungen"
          title="Einstellungen"
        >
          ⚙️
        </button>
        <div class="settings-menu-list" id="settings-menu-list" hidden>
          ${actions
            .map((a) => {
              const classes = `settings-menu-item${a.danger ? " is-danger" : ""}`
              // Der Erklaertext erscheint als Tooltip (data-tooltip), nicht
              // dauerhaft im Eintrag -- das Menue soll schlank bleiben.
              const tip = a.hint
                ? ` data-tooltip="${escapeHtml(a.hint)}" aria-description="${escapeHtml(a.hint)}"`
                : ""
              return `<button id="${a.id}" type="button" class="${classes}"${tip}>${a.html}</button>`
            })
            .join("")}
        </div>
      </div>
    `
  }

  /** Verdrahtet die Aktionen des zuletzt gerenderten Menüs mit ihren Handlern. */
  function bindSettingsActions(scope: HTMLElement) {
    for (const action of buildSettingsActions()) {
      scope.querySelector<HTMLButtonElement>(`#${action.id}`)?.addEventListener("click", () => {
        closeSettingsMenu()
        action.run()
      })
    }
  }

  /**
   * Beim Start (noch) keine Speicherart bekannt? Dann die zuletzt gewaehlte
   * Speicherart nachladen, damit der Leerzustand nicht beide Wechsel anbietet.
   */
  function ensureStorageTypeKnown() {
    if (currentStorageType) return
    void getStoredStorageType().then((stored) => {
      if (!currentStorageType && !currentStorage) {
        currentStorageType = stored ?? (hasDirectoryPicker ? "fsa" : null)
        void updateView(null)
      }
    })
  }
  /** Aufräumfunktion des Einstellungen-Menüs (Listener), falls es offen ist. */
  let settingsMenuCleanup: (() => void) | null = null

  /**
   * True, sobald die Adresse einmal an den Ordner angepasst wurde. Ab dann
   * legt jeder Ordnerwechsel einen History-Schritt an (Zurueck-Button), statt
   * nur zu ersetzen.
   */
  let urlSyncDone = false

  /**
   * True, sobald ein Deeplink aufgeloest wurde (oder keiner vorlag). Vorher
   * darf `syncUrl` nur ersetzen: der erste Listenaufbau laeuft schon durch,
   * bevor der Link den Ordner gewechselt hat, und wuerde sonst einen
   * ueberfluessigen Schritt auf die Wurzel anlegen.
   */
  let deepLinkResolved = false

  /**
   * True, wenn der aktuelle History-Schritt ein Editor-Schritt direkt ueber
   * dem Ordnerlink ist. Dann ersetzt das naechste Oeffnen ihn nur, statt einen
   * weiteren Schritt anzulegen.
   */
  let editorStepOnFolder = false

  /**
   * True, waehrend der Browser die Adresse selbst gesetzt hat (Zurueck-/
   * Vorwaerts-Button). Dann darf `syncUrl` die Adresse nicht erneut schreiben,
   * sonst entstuende bei jedem Zurueck-Klick ein neuer History-Eintrag.
   */
  let urlFromBrowser = false

  /**
   * Name des Eintrags im offenen Editor, sonst null. Solange etwas bearbeitet
   * wird, gehoert die Adresse dem Editor (`/foo/bar.html?pwaislands=edit`) und
   * `syncUrl` darf sie nicht auf den Ordnerlink zuruecksetzen --
   * `refreshCurrentList` laeuft auch nach dem Speichern, waehrend das Fenster
   * noch offen ist. Der Name geht ausserdem in den Fenstertitel ein.
   */
  let editorEntryName: string | null = null

  async function updateView(storage: IFileStorage | null) {
    currentStorage = storage
    if (storage) currentStorageType = storage.type

    if (!storage) {
      /*
       * Auch ohne offenen Ordner zeigt die Kopfzeile die aktive Speicherart:
       * bei der lokalen Variante das PC-Symbol -- so ist auf den ersten Blick
       * klar, in welcher Art gearbeitet wird. Den Ordnernamen gibt es hier
       * noch nicht, der Hinweis steht im Leerzustand darunter.
       */
      folderNameDisplay.innerHTML =
        currentStorageType === "fsa" ? '<span class="breadcrumb-current">💻 PWA Islands</span>' : ""

      folderActions.innerHTML = renderSettingsMenu()
      bindSettingsActions(container)

      filesContent.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📂</div>
          <h3>Kein Ordner ausgewählt</h3>
          <p>Wähle einen lokalen Ordner, in dem deine Projekte gespeichert werden.</p>
          <div class="empty-actions">
            <button id="btn-select-folder-hero" type="button" class="btn btn-primary">
              📂 Ordner wählen
            </button>
          </div>
        </div>
      `
      container
        .querySelector<HTMLButtonElement>("#btn-select-folder-hero")
        ?.addEventListener("click", handleSelectFolder)

      setupSettingsMenu(container)
      ensureStorageTypeKnown()
      return
    }

    // Den Pfad als Breadcrumb aufbauen: jeder Abschnitt ist anklickbar und
    // springt direkt in den entsprechenden Ordner.
    updateBreadcrumbs()

    folderActions.innerHTML = `
      <button id="btn-new-file" type="button" class="btn btn-primary">
        <!-- Kein Whitespace zwischen den beiden Spans: ein Textknoten im
             Raster wird zu einer eigenen Zelle und schiebt die Zeichen
             auseinander. -->
        <span class="btn-icon-only" aria-hidden="true"><span class="btn-icon-sub">📄</span><span class="btn-icon-main">➕</span></span>
        <span class="btn-label">Datei</span>
      </button>
      <button id="btn-new-folder" type="button" class="btn btn-primary">
        <span class="btn-icon-only" aria-hidden="true"><span class="btn-icon-sub">📁</span><span class="btn-icon-main">➕</span></span>
        <span class="btn-label">Ordner</span>
      </button>
      <button id="btn-import-file" type="button" class="btn btn-secondary">
        <span class="btn-icon-only" aria-hidden="true">📥</span>
        <span class="btn-label">Hochladen</span>
      </button>
      ${renderSettingsMenu()}
    `

    container
      .querySelector<HTMLButtonElement>("#btn-new-file")
      ?.addEventListener("click", handleCreateFile)
    container
      .querySelector<HTMLButtonElement>("#btn-new-folder")
      ?.addEventListener("click", handleCreateFolder)
    container
      .querySelector<HTMLButtonElement>("#btn-import-file")
      ?.addEventListener("click", handleImportFiles)

    bindSettingsActions(container)
    setupSettingsMenu(container)

    await refreshCurrentList()
  }

  /**
   * Verdrahtet das Einstellungen-Menü (Zahnrad): öffnet/schließt beim Klick,
   * schließt bei Klick außerhalb und bei Escape.
   */
  function setupSettingsMenu(scope: HTMLElement) {
    const menu = scope.querySelector<HTMLDivElement>("#settings-menu")
    const toggle = scope.querySelector<HTMLButtonElement>("#btn-settings")
    const list = scope.querySelector<HTMLDivElement>("#settings-menu-list")
    if (!menu || !toggle || !list) return

    const setOpen = (open: boolean) => {
      list.hidden = !open
      toggle.setAttribute("aria-expanded", String(open))
      menu.classList.toggle("is-open", open)
    }

    toggle.addEventListener("click", (e) => {
      e.stopPropagation()
      setOpen(!menu.classList.contains("is-open"))
    })

    // Klick außerhalb schließt das Menü.
    const onDocumentClick = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) closeSettingsMenu()
    }
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettingsMenu()
    }

    settingsMenuCleanup = () => {
      document.removeEventListener("click", onDocumentClick)
      document.removeEventListener("keydown", onKeydown)
      setOpen(false)
    }

    document.addEventListener("click", onDocumentClick)
    document.addEventListener("keydown", onKeydown)
  }

  function closeSettingsMenu() {
    settingsMenuCleanup?.()
    settingsMenuCleanup = null
  }

  /**
   * Hält die Adresszeile mit dem aktuellen Ordner synchron. Beim Wechsel in
   * einen Ordner wird die Adresse per History-API ersetzt (kein Neuladen, kein
   * Request) und der neue Stand als "pushState" abgelegt, damit der
   * Zurueck-Button des Browsers wieder eine Ebene nach oben fuehrt.
   *
   * Scheitert der History-Aufruf (z. B. in einem eingebetteten Kontext ohne
   * eigene History), bleibt die Adresse unveraendert -- die Ordneranzeige
   * darf davon nicht abhaengen.
   */
  function syncUrl(folderPath: string) {
    // Der Editor ist offen: dessen Adresse stehen lassen.
    if (editorEntryName) return

    // Die Adresse kam gerade vom Browser (Zurueck-Button): nichts schreiben,
    // aber ab jetzt wieder normale Schritte anlegen.
    if (urlFromBrowser) {
      urlFromBrowser = false
      urlSyncDone = true
      return
    }

    const url = folderUrl(folderPath)

    try {
      if (url === `${window.location.pathname}${window.location.search}`) {
        return
      }
      // Solange der Deeplink noch nicht aufgeloest ist, wird nur ersetzt: die
      // Adresse aus dem Link ist der Ausgangspunkt, kein Schritt dorthin.
      // Danach legt jeder Ordnerwechsel einen Schritt an -- wiederholtes
      // Ersetzen wuerde den Zurueck-Button wirkungslos machen.
      if (urlSyncDone && deepLinkResolved) {
        window.history.pushState({ folderPath }, "", url)
        editorStepOnFolder = false
      } else {
        window.history.replaceState({ folderPath }, "", url)
      }
    } catch (err) {
      console.warn("Adresse konnte nicht aktualisiert werden:", err)
    }

    urlSyncDone = true
  }

  /**
   * Haelt den Fenster- bzw. Tab-Titel am angezeigten Pfad. Beim offenen Editor
   * kommt der bearbeitete Eintrag davor, damit im Tab erkennbar ist,
   * dass gerade etwas bearbeitet wird.
   *
   * Aufbau: "bar.html bearbeiten — foo — PWA Islands".
   */
  function updateDocumentTitle(entryName?: string) {
    const storage = currentStorage
    // Ohne Speicher (Startphase) bleibt der Titel, wie er ist.
    if (!storage) return

    const segments =
      storage instanceof FileSystemHandleStorage
        ? breadcrumbSegments(storage.subPath)
        : [{ label: storage.name, path: "" }]

    // Wurzel nach hinten, Pfad davor -- der spezifischste Teil steht vorn und
    // bleibt sichtbar, wenn der Tab den Titel abschneidet.
    const trail = segments.map((segment) => segment.label).reverse()
    if (entryName) trail.unshift(`${entryName} bearbeiten`)
    document.title = trail.join(" — ")
  }

  /**
   * Aktualisiert den Breadcrumb in der Toolbar. Muss nach jedem Wechsel des
   * aktuellen Ordners aufgerufen werden, weil `refreshCurrentList` nur den
   * Listenbereich neu rendert.
   */
  function updateBreadcrumbs() {
    const storage = currentStorage
    folderNameDisplay.innerHTML =
      storage instanceof FileSystemHandleStorage
        ? buildBreadcrumbs(storage)
        : storage
          ? escapeHtml(storage.name)
          : ""

    // Der Pfad darf horizontal scrollen -- der aktuelle Ordner muss aber ohne
    // Zutun sichtbar sein, deshalb ans rechte Ende springen.
    folderNameDisplay.scrollLeft = folderNameDisplay.scrollWidth

    // Klick-Handler nach jedem Neuaufbau erneut binden -- die Buttons werden
    // komplett ersetzt, bestehende Listener verschwinden mit ihnen.
    folderNameDisplay.querySelectorAll<HTMLButtonElement>(".breadcrumb-item").forEach((crumb) => {
      crumb.addEventListener("click", () => {
        void navigateToSegment(crumb.dataset.segment ?? "")
      })
    })

    // Adresse mit dem angezeigten Ordner synchron halten. Auch der Aufruf
    // ohne Pfadwechsel (z. B. nach dem Speichern) ist billig: syncUrl bricht ab,
    // wenn sich nichts geaendert hat.
    syncUrl(storage instanceof FileSystemHandleStorage ? storage.subPath : "")

    // Titel mit demselben Pfad bestuecken -- beim offenen Editor mit Eintrag.
    updateDocumentTitle(editorEntryName ?? undefined)
  }

  async function refreshCurrentList() {
    if (!currentStorage) return
    updateBreadcrumbs()

    await renderGenericFileList(filesContent, currentStorage, {
      onRefresh: refreshCurrentList,
      onRequestNewFile: handleCreateFile,
      onRequestNewFolder: handleCreateFolder,
      onRequestImport: handleImportFiles,
      onRequestEdit: handleEditEntry,
      onRequestOpen: (name) => {
        // Echte Browser-Navigation (kein SPA-Routing), damit der Service
        // Worker unter /<pfad> die gespeicherte Datei ausliefern kann. Der
        // volle relative Pfad bleibt erhalten, damit Dateien in Unterordnern
        // unter /<ordner>/<name> geladen werden.
        const path = relativePathOf(currentStorage!, name)
        window.location.assign(
          `/${path
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/")}`,
        )
      },
      onRequestOpenFolder: (name) => {
        void openFolder(name)
      },
    })
  }

  /** Öffnet einen Unterordner und zeigt dessen Inhalt in der Liste. */
  async function openFolder(name: string) {
    if (!currentStorage) return
    const storage = currentStorage
    if (!(storage instanceof FileSystemHandleStorage)) return

    try {
      if (!(await storage.ensureWritePermission())) {
        console.warn("Kein Schreibzugriff auf den Ordner; Inhalt wird nur gelesen.")
      }
    } catch (err) {
      console.error("Fehler bei der Berechtigungsprüfung:", err)
    }

    await navigateToSegment(storage.subPath ? `${storage.subPath}/${name}` : name)
  }

  /**
   * Wechselt zu einem beliebigen Punkt im aktuellen Pfad. Ein leerer Zielpfad
   * steht fuer die Wurzel. Der Pfad wird vom Wurzel-Handle aus neu aufgebaut,
   * damit auch mehrere Ebenen auf einmal moeglich sind.
   *
   * `history: "none"` bedeutet: die Adresse kommt gerade vom Browser
   * (Zurueck-Button) und darf nicht erneut geschrieben werden. Auch der
   * Fruehausstieg (Ziel ist schon der aktuelle Ordner) verbraucht das Flag --
   * sonst bliebe es liegen und der naechste Ordnerwechsel wuerde die Adresse
   * stumm ueberspringen.
   */
  async function navigateToSegment(targetPath: string, options?: { history?: "none" }) {
    if (!currentStorage) return
    const storage = currentStorage
    if (!(storage instanceof FileSystemHandleStorage)) return
    if (targetPath === storage.subPath) {
      // Adresse kam vom Browser und beschreibt schon den aktuellen Ordner:
      // Flag verbrauchen, sonst ueberspringt der naechste Ordnerwechsel die
      // Adresse (die Leiste bliebe auf dem alten Pfad stehen).
      if (options?.history === "none") urlSyncDone = true
      return
    }

    try {
      let handle = storage.rootHandle
      for (const segment of targetPath ? targetPath.split("/") : []) {
        handle = await handle.getDirectoryHandle(segment)
      }
      currentStorage = new FileSystemHandleStorage(
        handle,
        storage.type,
        storage.isFallback,
        targetPath,
        storage.rootName,
        storage.rootHandle,
      )
      // Der History-Eintrag kommt vom Browser selbst -- sonst wuerde jeder
      // Zurueck-Klick einen neuen Eintrag erzeugen und die History aufblaehen.
      if (options?.history === "none") urlSyncDone = true
      await refreshCurrentList()
    } catch (err: unknown) {
      // Der Grund steckt in `err.name`: `NotFoundError` (Ordner gibt es nicht),
      // `TypeMismatchError` (Eintrag ist eine Datei, kein Ordner). Letzteres
      // passiert z. B. bei einer Adresse, die auf eine Datei zeigt; die reine
      // Meldung "Wrong type" sagt im Deutschen nichts aus.
      const reason = describeFolderError(err)
      alert(`Ordner "${targetPath}" konnte nicht geöffnet werden: ${reason}`)
    }
  }

  function handleCreateFile() {
    if (!currentStorage) return
    const storage = currentStorage
    openEditorModal({
      kind: "file",
      mode: "create",
      onSave: async (fileName, content) => {
        await storage.createFile(fileName, content instanceof Blob ? content : (content ?? ""))
        await refreshCurrentList()
      },
    })
  }

  function handleCreateFolder() {
    if (!currentStorage) return
    const storage = currentStorage
    openEditorModal({
      kind: "folder",
      mode: "create",
      onSave: async (folderName) => {
        await storage.createDirectory(folderName)
        await refreshCurrentList()
      },
    })
  }

  /**
   * Öffnet das Bearbeiten-Fenster. Dateien werden vorher gelesen, damit der
   * Inhalt im Feld steht; das Umbenennen ist in beiden Fällen möglich. Der
   * Löschen-Button ruft dieselbe Logik wie bisher die Aktionsspalte auf.
   */
  async function handleEditEntry(name: string, kind: "file" | "directory") {
    if (!currentStorage) return
    const storage = currentStorage

    // Die Adresszeile zeigt waehrend des Bearbeitens den Eintrag samt `=edit`
    // und kehrt beim Schliessen zum Ordnerlink zurueck. Fuer Dateien ist das
    // `/foo/bar.html?pwaislands=edit`, fuer einen Ordner dessen Pfad ohne
    // Dateiendung: `/foo/sub?pwaislands=edit`.
    const entryPath = relativePathOf(storage, name)
    const editUrl = entryUrl(entryPath, "edit")
    const folderPathBeforeEdit = storage instanceof FileSystemHandleStorage ? storage.subPath : ""
    const folderUrlBeforeEdit = folderUrl(folderPathBeforeEdit)
    if (editUrl) {
      editorEntryName = name
      try {
        // Der Editor bekommt einen eigenen Schritt, damit der Zurueck-Button
        // zum Ordner fuehrt und nicht daran vorbei.
        //
        // Frueher stand hier immer `replaceState`. Das hat den Ordner-Eintrag
        // ueberschrieben: `/foo?pwaislands` wurde zu
        // `/foo/bar.html?pwaislands=edit`, und Zurueck sprang vom Editor
        // direkt auf die Wurzel -- fuer den Benutzer sah es aus, als haette
        // der Zurueck-Button eine Ebene zu weit gefuehrt.
        //
        // Nur der erste Editor-Schritt eines Ordnerbesuchs wird gepusht;
        // danach wird ersetzt. Sonst legte jedes Oeffnen einen Eintrag an.
        //
        // Im State steht der ORDNER, nicht der Eintrag: `handlePopState`
        // nutzt ihn als Rueckfallebene, wenn die Adresse keinen Ordnerpfad
        // hergibt (Datei in der Wurzel, z. B. `/bar.html`).
        const state = { folderPath: folderPathBeforeEdit }
        if (editorStepOnFolder) {
          window.history.replaceState(state, "", editUrl)
        } else {
          window.history.pushState(state, "", editUrl)
          editorStepOnFolder = true
        }
      } catch (err) {
        console.warn("Adresse konnte nicht aktualisiert werden:", err)
      }
      // Titel nachziehen: der Editor steht jetzt im Tab.
      updateDocumentTitle(editorEntryName)
    }

    /** Setzt die Adresse nach dem Schliessen des Editors auf den Ordner zurueck. */
    const restoreAddress = () => {
      editorEntryName = null
      // Titel zurueck auf den reinen Pfad.
      updateDocumentTitle()
      if (!editUrl) return
      try {
        // Ersetzen, nicht pushen: der Editor-Eintrag wird wieder zum
        // Ordnerlink. Der Schritt darunter ist derselbe Ordnerlink, also
        // ersetzt das naechste Oeffnen ihn nur -- die History-Laenge bleibt
        // beim Oeffnen und Schliessen gleich.
        window.history.replaceState({ folderPath: folderPathBeforeEdit }, "", folderUrlBeforeEdit)
        editorStepOnFolder = true
      } catch {
        // History nicht verfuegbar -- die Ordneranzeige haengt nicht davon ab.
      }
      // Der Ordnerpfad hat sich nicht geaendert, aber die Adresse schon; beim
      // naechsten Ordnerwechsel soll wieder ein Schritt entstehen.
      urlSyncDone = true
    }

    const removeEntry = async () => {
      try {
        if (!(await storage.ensureWritePermission())) {
          throw new Error("Schreibzugriff erforderlich.")
        }
      } catch (err) {
        console.error("Fehler bei der Berechtigungsprüfung:", err)
      }
      await storage.deleteEntry(name)
      await refreshCurrentList()
    }

    const saveEntry = async (newName: string, content: string | Blob | null | undefined) => {
      if (newName !== name) await storage.renameEntry(name, newName)
      // content === null bedeutet: Binaerdatei, Inhalt bleibt unveraendert.
      if (kind === "file" && content !== null && content !== undefined) {
        await storage.writeFile(newName, content)
      }
      await refreshCurrentList()
    }

    if (kind === "directory") {
      openEditorModal({
        kind: "folder",
        mode: "edit",
        name,
        onSave: saveEntry,
        onDelete: removeEntry,
        onClose: restoreAddress,
      })
      return
    }

    try {
      // Grosse Dateien (> 10 MB) werden gar nicht erst als Text geladen. Ist es
      // ein Bild, zeigen wir trotzdem eine Vorschau.
      const size = await storage.getFileSize(name)
      if (size > MAX_EDITABLE_TEXT_BYTES) {
        const tooLargeBlob = IMAGE_EXTENSIONS.has(getExtension(name))
          ? await storage.readFileBlob(name)
          : null
        openEditorModal({
          kind: "file",
          mode: "edit",
          name,
          contentLocked: true,
          preview: tooLargeBlob ? buildImagePreview(tooLargeBlob) : undefined,
          onSave: saveEntry,
          onDelete: removeEntry,
          onClose: restoreAddress,
        })
        return
      }

      const blob = await storage.readFileBlob(name)
      const editable = await isEditableTextFile(blob, name)
      openEditorModal({
        kind: "file",
        mode: "edit",
        name,
        // Nur Textdateien werden dekodiert; bei Binaerdateien waere die
        // Textdarstellung verlustbehaftet und ein Speichern wuerde die Datei
        // zerstoeren.
        initialContent: editable ? await blob.text() : "",
        contentLocked: !editable,
        preview:
          !editable && IMAGE_EXTENSIONS.has(getExtension(name))
            ? buildImagePreview(blob)
            : undefined,
        // Bis zur Groessengrenze laesst sich jede Datei als Base64 bearbeiten.
        base64Editable: !editable && blob.size <= MAX_EDITABLE_TEXT_BYTES,
        base64:
          !editable && blob.size <= MAX_EDITABLE_TEXT_BYTES ? await blobToBase64(blob) : undefined,
        onSave: saveEntry,
        onDelete: removeEntry,
        onClose: restoreAddress,
      })
    } catch (err: unknown) {
      alert(
        `Datei "${name}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`,
      )
      // Der Editor wurde nicht geoeffnet -- die Adresse darf nicht auf den
      // Eintrag zeigen.
      restoreAddress()
    }
  }

  async function handleImportFiles() {
    if (!currentStorage) return

    try {
      if (!(await currentStorage.ensureWritePermission())) {
        alert("Schreibzugriff erforderlich, um Dateien zu importieren.")
        return
      }
    } catch (err) {
      console.error("Fehler bei der Berechtigungsprüfung:", err)
    }

    fileImportInput.value = ""
    fileImportInput.onchange = async () => {
      if (!fileImportInput.files || fileImportInput.files.length === 0 || !currentStorage) return
      const storage = currentStorage
      const files = Array.from(fileImportInput.files)
      let imported = 0
      let skipped = 0
      // Merkt sich die Antwort des ersten Konflikts und wendet sie auf alle
      // weiteren an -- sonst waere der Hinweis im Dialog gelogen.
      let applyToAll: "replace" | "rename" | "skip" | null = null

      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index]
          let decision: "replace" | "rename" | "skip" = "rename"
          const collision = await storage.hasEntry(file.name)

          if (collision) {
            decision = applyToAll ?? askImportCollision(file.name)

            // Nur einmal fragen, und nur wenn noch weitere Dateien folgen.
            if (!applyToAll && index < files.length - 1) {
              const remaining = await countRemainingCollisions(storage, files, index + 1)
              if (remaining > 0 && askApplyToAll(decision, remaining)) {
                applyToAll = decision
              }
            }

            if (decision === "skip") {
              skipped++
              continue
            }
          }

          const targetName =
            decision === "replace" ? file.name : await findFreeName(storage, file.name)

          if (decision === "replace") {
            await storage.writeFile(targetName, file)
          } else {
            await storage.createFile(targetName, file)
          }
          imported++
        }

        await refreshCurrentList()

        if (skipped > 0) {
          alert(`${imported} Datei(en) importiert, ${skipped} übersprungen.`)
        }
      } catch (err: unknown) {
        await refreshCurrentList()
        alert(
          `Dateien konnten nicht importiert werden: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    fileImportInput.click()
  }

  /**
   * Merkt sich die Speicherart dauerhaft (IndexedDB). Wird NUR von den
   * Wechsel-Aktionen im Zahnrad-Menü aufgerufen: dort -- und nur dort --
   * entscheidet der Nutzer aktiv, in welcher Art gearbeitet wird. Das blosse
   * Öffnen eines Ordners oder ein Neuladen soll die Wahl nicht ändern.
   * Fehler werden nur geloggt, damit sie den Aufbau der Ansicht nicht stoppen.
   */
  async function persistStorageChoice(type: "fsa" | "opfs") {
    currentStorageType = type
    try {
      await storeStorageType(type)
    } catch (err) {
      console.warn("Speicherart konnte nicht gespeichert werden:", err)
    }
  }

  async function handleSelectFolder() {
    try {
      if (!window.showDirectoryPicker) {
        if (hasOPFS) {
          await handleUseOPFS()
          return
        }
        alert("Die File System Access API wird von diesem Browser nicht unterstützt.")
        return
      }

      // showDirectoryPicker erzeugt die User Gesture automatisch
      const handle = await window.showDirectoryPicker({
        mode: "readwrite",
      })

      // Speicherart ZUERST schreiben: das Ablegen eines FileSystemDirectoryHandle
      // kann fehlschlagen (DataCloneError). Dann soll die Wahl trotzdem stehen.
      await persistStorageChoice("fsa")
      await storeDirectoryHandle(handle)
      const storage = new FileSystemHandleStorage(handle, "fsa", false)
      await updateView(storage)
      await applyDeepLink()
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return
      }
      console.error("Fehler bei der Ordnerauswahl:", err)
      alertArea.innerHTML = `
        <div class="alert alert-danger">
          <strong>Auswahlfehler:</strong> ${err instanceof Error ? err.message : "Ordner konnte nicht ausgewählt werden"}
        </div>
      `
    }
  }

  /**
   * Wechselt zum zuletzt gespeicherten lokalen Ordner. Die Wahl wird sofort
   * beim Klick persistiert -- nicht erst, wenn die Berechtigung später erteilt
   * wird; sonst greift beim nächsten Neuladen wieder die alte OPFS-Wahl.
   * Aufgerufen aus dem Zahnrad-Menü (`buildSettingsActions`).
   */
  async function handleSwitchToLocalFolder() {
    await persistStorageChoice("fsa")
    // Init ohne die gespeicherte Wahl auszulesen: der lokale Ordner soll
    // Vorrang haben, auch wenn in der Datenbank noch 'opfs' stehen sollte.
    await initStorage(true)
  }

  async function handleUseOPFS() {
    const opfsHandle = await getOPFSDirectoryHandle()
    if (opfsHandle) {
      await persistStorageChoice("opfs")
      const storage = new FileSystemHandleStorage(opfsHandle, "opfs", isFallbackToOPFS)
      await updateView(storage)
      await applyDeepLink()
    } else {
      alert("Zugriff auf das Origin Private File System fehlgeschlagen.")
    }
  }

  async function handleDisconnectFolder() {
    await clearStoredDirectoryHandle()
    await clearStoredStorageType()
    /*
     * Nach dem Trennen bleibt die Voreinstellung bestehen (lokal, sofern
     * verfuegbar). Mit `null` wuerde das Zahnrad beide Wechsel gleichzeitig
     * anbieten -- es gaebe also zwei Wege zum selben Ziel.
     */
    currentStorageType = hasDirectoryPicker ? "fsa" : null
    await updateView(null)
  }

  // Hilfsfunktion: Bereitet die UI so vor, dass der Klick direkt in requestPermission resultiert.
  function showReopenButtonUI(storedHandle: FileSystemDirectoryHandle) {
    folderNameDisplay.innerHTML = `<span class="breadcrumb-current">💻 ${escapeHtml(storedHandle.name)}</span>`

    // Das Zahnrad-Menü kommt zentral aus buildSettingsActions(): Dort gibt es
    // den Speicherwechsel nur in die *andere* Art. Ein "Trennen" ergänzt den
    // Eintrag, weil der Ordner zwar bekannt, aber nicht freigegeben ist.
    folderActions.innerHTML = renderSettingsMenu()

    filesContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔒</div>
        <h3>Zugriff erforderlich</h3>
        <p>Um Ihre Dateien zu laden, bestätigen Sie bitte den dauerhaften Zugriff auf den Ordner <strong>${storedHandle.name}</strong>.</p>
        <button id="btn-grant-permission-hero" type="button" class="btn btn-primary">
          Zugriff auf "${storedHandle.name}" erlauben
        </button>
      </div>
    `

    // 2. Erst wenn der Nutzer aktiv auf den Button klickt, das Recht anfordern!
    const handleUserClickToUnlock = async () => {
      try {
        if (storedHandle.requestPermission) {
          // WICHTIG: Erster Aufruf in diesem Click-Handler (keine IDB-Ladezeiten dazwischen!)
          const permission = await storedHandle.requestPermission({ mode: "readwrite" })

          if (permission === "granted") {
            // Der Nutzer hat den Zugriff gerade bestätigt -- das ist eine
            // bewusste Wahl der lokalen Speicherart.
            await persistStorageChoice("fsa")
            const storage = new FileSystemHandleStorage(storedHandle, "fsa", false)
            await updateView(storage)
            await applyDeepLink()
          } else {
            alert("Zugriff verweigert.")
          }
        }
      } catch (err) {
        console.error("requestPermission Fehler:", err)
      }
    }

    container
      .querySelector<HTMLButtonElement>("#btn-grant-permission-hero")
      ?.addEventListener("click", handleUserClickToUnlock)

    bindSettingsActions(container)
    setupSettingsMenu(container)
  }

  // 1. Beim App-Start NUR prüfen, ob das Recht noch da ist
  async function initStorage(forceLocal = false) {
    // Kein Picker vorhanden -> es bleibt nur der App-Speicher.
    if (!hasDirectoryPicker) {
      await handleUseOPFS()
      return
    }

    // Die gespeicherte Wahl, falls ueberhaupt eine vorliegt.
    let storedType: "fsa" | "opfs" | null = null

    try {
      // Wenn OPFS zuvor ausdruecklich gewaehlt wurde, diese Wahl beibehalten.
      // Bei forceLocal (Zahnrad -> "Zu lokalem Ordner wechseln") wird dieser
      // Zweig uebersprungen, damit der lokale Ordner erreichbar bleibt.
      if (!forceLocal) {
        storedType = await getStoredStorageType()
        currentStorageType = storedType
        if (storedType === "opfs" && hasOPFS) {
          await handleUseOPFS()
          return
        }
      } else {
        currentStorageType = "fsa"
      }

      // Async-Ladevorgang (Datenbank) isolieren von requestPermission
      const storedHandle = await getStoredDirectoryHandle()
      if (!storedHandle) {
        /*
         * Erststart ohne gespeicherten Ordner: die Voreinstellung ist die
         * lokale Speicherart (FSA), nicht OPFS. Es wird hier nichts persistiert
         * -- die Wahl entsteht erst durch einen aktiven Wechsel bzw. das
         * Auswaehlen eines Ordners.
         */
        currentStorageType = forceLocal ? "fsa" : storedType
        if (!currentStorageType && hasDirectoryPicker) currentStorageType = "fsa"
        await updateView(null)
        return
      }
      let permission: PermissionState = "prompt"
      if (storedHandle.queryPermission) {
        try {
          permission = await storedHandle.queryPermission({ mode: "readwrite" })
        } catch (err) {
          console.warn("queryPermission fehlgeschlagen:", err)
        }
      }

      // Ab hier steht fest, dass der lokale Ordner verwendet wird.
      if (permission === "granted") {
        currentStorageType = "fsa"
        // Perfekt, Browser/Android hat es sich (im Hintergrund) gemerkt
        const storage = new FileSystemHandleStorage(storedHandle, "fsa", false)
        await updateView(storage)
        await applyDeepLink()
      } else {
        // WICHTIG: Jetzt NICHT sofort requestPermission() aufrufen!
        // Zeige stattdessen die UI-Buttons an.
        showReopenButtonUI(storedHandle)
      }
    } catch (err) {
      console.error("Fehler beim Initialisieren des gespeicherten Ordners:", err)
      await updateView(null)
    }
  }

  /**
   * Bringt die Ansicht mit einer Adresse vom Typ `?pwaislands` in Einklang.
   *
   * Das ist der einzige Weg, eine Island-Adresse aufzuloesen -- sowohl beim
   * Laden (Deeplink) als auch beim Zurueck-/Vorwaerts-Button. Zwei getrennte
   * Wege hatten sich schon einmal auseinanderentwickelt (der Editor ging nur
   * im einen auf).
   *
   * Regeln, abgeleitet aus dem Dateisystem statt aus der Schreibweise des
   * Namens (ein Punkt sagt nichts -- "projekte/v1.2" ist ein Ordner, "notes"
   * eine Datei):
   *
   * - `=edit` und der Pfad ist ein Eintrag: in den ELTERNordner wechseln und
   *   den Eintrag dort im Editor oeffnen. Der Editor sitzt immer im
   *   Elternordner, auch bei einem Ordner-Eintrag.
   * - sonst: in den tiefsten Ordner wechseln, den der Pfad hergibt.
   *
   * @returns true, wenn die Adresse aufgeloest werden konnte.
   */
  async function applyUrlState(path: string, mode: string): Promise<boolean> {
    if (!currentStorage || !(currentStorage instanceof FileSystemHandleStorage)) return false

    if (isEditMode(mode) && path) {
      const target = parentAndName(path)
      if (target) {
        const reached = await navigateToFolder(target.parentPath)
        if (!reached) return false
        // Ohne Eintrag (umbenannt, geloescht) bleibt die Liste stehen; der
        // Aufrufer korrigiert dann die Adresse.
        return await openEntryEditor(target.name)
      }
    }

    return await navigateToFolder(path)
  }

  /**
   * Wechselt in den tiefsten Ordner, den der Pfad hergibt. Zeigt der Pfad auf
   * eine Datei (`/foo/bar.html`), ist das ihr Elternordner.
   */
  async function navigateToFolder(path: string): Promise<boolean> {
    const storage = currentStorage
    if (!(storage instanceof FileSystemHandleStorage)) return false

    const folder = await findDeepestDirectory(storage.rootHandle, path)
    await navigateToSegment(folder, { history: "none" })
    return currentStorage instanceof FileSystemHandleStorage && currentStorage.subPath === folder
  }

  /** Oeffnet einen Eintrag des aktuellen Ordners im Editor. */
  async function openEntryEditor(name: string): Promise<boolean> {
    if (!currentStorage) return false
    try {
      const kind = await currentStorage.entryKind(name)
      if (!kind) return false
      await handleEditEntry(name, kind)
      return true
    } catch (err) {
      console.warn(`Eintrag "${name}" aus der Adresse konnte nicht geoeffnet werden:`, err)
      return false
    }
  }

  /**
   * Setzt die Adresse ohne neuen History-Schritt auf den uebergebenen Wert.
   * Wird gebraucht, wenn das Schliessen des Editors die Adresse bereits
   * ueberschrieben hat, der Browser aber auf einem anderen Schritt steht.
   */
  function restoreUrl(url: string) {
    try {
      if (url === `${window.location.pathname}${window.location.search}`) return
      window.history.replaceState(window.history.state, "", url)
    } catch (err) {
      console.warn("Adresse konnte nicht wiederhergestellt werden:", err)
    }
  }

  /** True, wenn ein Bearbeiten-Fenster offen ist. */
  function hasOpenEditor(): boolean {
    return document.querySelector(".modal-overlay") !== null
  }

  /**
   * Setzt die Adresse auf den Ordner zurueck, in dem wir tatsaechlich stehen.
   *
   * Wird benutzt, wenn die Adresse ins Leere zeigt (Eintrag umbenannt oder
   * geloescht): sonst behauptet sie weiter ein Ziel, das es nicht gibt, und
   * ein Neuladen landet im Nirgendwo.
   */
  function syncUrlToCurrentFolder() {
    const storage = currentStorage
    const folderPath = storage instanceof FileSystemHandleStorage ? storage.subPath : ""
    // `urlFromBrowser` verbrauchen, damit die Korrektur kein neuer Schritt wird.
    urlFromBrowser = false
    editorEntryName = null
    updateDocumentTitle()
    syncUrl(folderPath)
  }

  /**
   * Loest den Deeplink einmalig nach dem Aufbau der Ansicht auf.
   *
   * `islandDeepLink` ist beim Laden ausgewertet; nach dem Aufloesen uebernimmt
   * `handlePopState` mit der jeweils aktuellen Adresse.
   */
  async function applyDeepLink() {
    const link = islandDeepLink
    if (!link) {
      // Ohne Deeplink ist nichts aufzuloesen; Ordnerwechsel sind echte Schritte.
      deepLinkResolved = true
      return
    }
    try {
      await resolveDeepLink(link)
    } finally {
      // Auch bei einem Fehlschlag: ab jetzt sind Ordnerwechsel echte Schritte.
      deepLinkResolved = true
    }
  }

  /** Loest einen Deeplink auf und korrigiert die Adresse, wenn er ins Leere zeigt. */
  async function resolveDeepLink(link: IslandDeepLink) {
    if (!(await applyUrlState(link.path, link.mode))) {
      // Adresse zeigt ins Leere: auf den Ordner zuruecksetzen, in dem wir
      // tatsaechlich stehen. Sonst behauptet die Adresse etwas Falsches.
      syncUrlToCurrentFolder()
    }
  }

  /**
   * Der Zurueck-/Vorwaerts-Button: die Adresse ist die einzige Quelle.
   *
   * Reihenfolge ist wichtig: die Adresse wird gelesen, *bevor* das Fenster
   * geschlossen wird. `restoreAddress` schreibt beim Schliessen die
   * Ordneradresse per `replaceState` -- der Browser steht aber schon auf dem
   * Zielschritt, dessen Adresse damit ueberschrieben wuerde. Deshalb wird der
   * Editor hier stumm geschlossen und die Adresse danach neu gesetzt.
   */
  async function handlePopState() {
    if (!(currentStorage instanceof FileSystemHandleStorage)) return

    const link = readIslandDeepLink()
    const path = link ? link.path : pathnameToPath(window.location.pathname)
    const mode = link ? link.mode : ""
    const url = `${window.location.pathname}${window.location.search}`

    closeOpenEditor()

    // Das Schliessen hat die Adresse moeglicherweise ueberschrieben. Sie ist
    // hier die einzige Quelle, also den Stand von vorher wiederherstellen.
    restoreUrl(url)

    const resolved = await applyUrlState(path, mode)
    if (!resolved || (isEditMode(mode) && !hasOpenEditor())) {
      // Adresse passt nicht zur Lage (Eintrag umbenannt oder geloescht):
      // auf den erreichten Ordner korrigieren, statt sie luegen zu lassen.
      syncUrlToCurrentFolder()
    }

    // Der Schritt kam vom Browser: kein neuer History-Eintrag, aber der
    // naechste Ordnerwechsel soll wieder einen anlegen. Das Flag wird hier
    // verbraucht, weil `syncUrl` je nach Verlauf gar nicht mehr laeuft.
    urlFromBrowser = false
    urlSyncDone = true
  }
  window.addEventListener("popstate", () => {
    void handlePopState()
  })

  void initStorage()
}
