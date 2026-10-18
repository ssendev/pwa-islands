// IndexedDB-Persistenz wird aus storage.ts wiederverwendet (siehe Import).
import {
  getStoredDirectoryHandle,
  storeDirectoryHandle,
  clearStoredDirectoryHandle,
  getStoredStorageType,
  storeStorageType,
  clearStoredStorageType,
  getOPFSDirectoryHandle,
} from './storage.ts'

export interface FileEntry {
  name: string
  kind: 'file' | 'directory'
  size?: number
  lastModified?: number
}

/**
 * Generische Abstraktion über Dateisystem-Backends (File System Access API & OPFS).
 */
export interface IFileStorage {
  readonly type: 'fsa' | 'opfs'
  readonly name: string
  readonly isFallback: boolean
  readonly canChangeFolder: boolean

  listFiles(): Promise<FileEntry[]>
  readFile(name: string): Promise<string>
  createFile(name: string, content: string | Blob): Promise<void>
  writeFile(name: string, content: string | Blob): Promise<void>
  createDirectory(name: string): Promise<void>
  deleteEntry(name: string): Promise<void>
  ensureWritePermission(): Promise<boolean>
}

/**
 * Universelle Implementierung für FileSystemDirectoryHandle (funktioniert für FSA und OPFS).
 */
export class FileSystemHandleStorage implements IFileStorage {
  private readonly handle: FileSystemDirectoryHandle
  readonly type: 'fsa' | 'opfs'
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
    type: 'fsa' | 'opfs',
    isFallback: boolean = false,
    subPath: string = '',
    displayName?: string,
    rootHandle?: FileSystemDirectoryHandle
  ) {
    this.handle = handle
    this.type = type
    this.isFallback = isFallback
    this.subPath = subPath
    this.rootHandle = rootHandle ?? handle
    this.displayName = displayName ?? (type === 'opfs' ? 'Origin Private File System' : handle.name)
  }

  get name(): string {
    return this.subPath ? `${this.displayName}/${this.subPath}` : this.displayName
  }

  /** Anzeigename des Wurzelordners ohne Unterpfad. */
  get rootName(): string {
    return this.displayName
  }

  get canChangeFolder(): boolean {
    return this.type === 'fsa'
  }

  get rawHandle(): FileSystemDirectoryHandle {
    return this.handle
  }

  /** Wechselt in einen direkten Unterordner und liefert die gescopte Sicht. */
  async enterDirectory(name: string): Promise<FileSystemHandleStorage> {
    const nextHandle = await this.handle.getDirectoryHandle(name)
    const nextPath = this.subPath ? `${this.subPath}/${name}` : name
    return new FileSystemHandleStorage(
      nextHandle,
      this.type,
      this.isFallback,
      nextPath,
      this.displayName,
      this.rootHandle
    )
  }

  async listFiles(): Promise<FileEntry[]> {
    const entries: FileEntry[] = []

    for await (const entry of this.handle.values()) {
      if (entry.kind === 'file') {
        try {
          const file = await entry.getFile()
          entries.push({
            name: entry.name,
            kind: 'file',
            size: file.size,
            lastModified: file.lastModified,
          })
        } catch {
          entries.push({
            name: entry.name,
            kind: 'file',
          })
        }
      } else if (entry.kind === 'directory') {
        entries.push({
          name: entry.name,
          kind: 'directory',
        })
      }
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name, 'de', { sensitivity: 'base', numeric: true })
    })

    return entries
  }

  async readFile(name: string): Promise<string> {
    const fileHandle = await this.handle.getFileHandle(name)
    const file = await fileHandle.getFile()
    return await file.text()
  }

  async ensureWritePermission(): Promise<boolean> {
    if (this.type !== 'fsa') return true
    if (!this.handle.queryPermission || !this.handle.requestPermission) return true

    let perm = await this.handle.queryPermission({ mode: 'readwrite' })
    if (perm === 'granted') return true

    perm = await this.handle.requestPermission({ mode: 'readwrite' })
    return perm === 'granted'
  }

  async createFile(name: string, content: string | Blob): Promise<void> {
    if (!(await this.ensureWritePermission())) {
      throw new Error('Schreibzugriff verweigert.')
    }
    // Vorhandene Dateien nicht überschreiben.
    let alreadyExists = false
    try {
      await this.handle.getFileHandle(name)
      alreadyExists = true
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
        throw err
      }
    }
    if (alreadyExists) {
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
      throw new Error('Schreibzugriff verweigert.')
    }
    const fileHandle = await this.handle.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async createDirectory(name: string): Promise<void> {
    if (!(await this.ensureWritePermission())) {
      throw new Error('Schreibzugriff verweigert.')
    }
    await this.handle.getDirectoryHandle(name, { create: true })
  }

  async deleteEntry(name: string): Promise<void> {
    if (!(await this.ensureWritePermission())) {
      throw new Error('Schreibzugriff verweigert.')
    }
    await this.handle.removeEntry(name, { recursive: true })
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

interface FileEditorModalOptions {
  mode: 'create' | 'edit'
  fileName?: string
  initialContent?: string
  onSave: (fileName: string, content: string) => Promise<void>
}

/**
 * Öffnet ein modales Dialogfenster mit Textarea zur Erstellung oder Bearbeitung einer Datei.
 */
function openFileEditorModal(options: FileEditorModalOptions): void {
  const existingModal = document.querySelector('.modal-overlay')
  if (existingModal) existingModal.remove()

  const isCreate = options.mode === 'create'
  const modalOverlay = document.createElement('div')
  modalOverlay.className = 'modal-overlay'

  modalOverlay.innerHTML = `
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header">
        <h3 id="modal-title">${isCreate ? 'Neue Datei erstellen' : `Datei bearbeiten: ${options.fileName}`}</h3>
        <button type="button" class="modal-close-btn" aria-label="Schließen">&times;</button>
      </header>
      <form id="modal-form">
        <div class="modal-body">
          <div class="form-group">
            <label for="modal-file-name">Dateiname:</label>
            <input
              type="text"
              id="modal-file-name"
              class="form-input"
              value="${options.fileName ?? 'notiz.txt'}"
              ${isCreate ? 'required placeholder="z. B. index.html, daten.json"' : 'disabled'}
            />
          </div>
          <div class="form-group">
            <label for="modal-file-content">Inhalt:</label>
            <textarea
              id="modal-file-content"
              class="form-textarea"
              placeholder="Geben Sie hier den Dateiinhalt ein..."
            ></textarea>
          </div>
        </div>
        <footer class="modal-footer">
          <button type="button" id="modal-btn-cancel" class="btn btn-secondary">
            Abbrechen
          </button>
          <button type="submit" id="modal-btn-save" class="btn btn-primary">
            ${isCreate ? 'Erstellen' : 'Speichern'}
          </button>
        </footer>
      </form>
    </div>
  `

  document.body.appendChild(modalOverlay)

  const nameInput = modalOverlay.querySelector<HTMLInputElement>('#modal-file-name')!
  const contentTextarea = modalOverlay.querySelector<HTMLTextAreaElement>('#modal-file-content')!
  const form = modalOverlay.querySelector<HTMLFormElement>('#modal-form')!
  const closeBtn = modalOverlay.querySelector<HTMLButtonElement>('.modal-close-btn')!
  const cancelBtn = modalOverlay.querySelector<HTMLButtonElement>('#modal-btn-cancel')!
  const saveBtn = modalOverlay.querySelector<HTMLButtonElement>('#modal-btn-save')!

  contentTextarea.value = options.initialContent ?? ''

  if (isCreate) {
    nameInput.focus()
    nameInput.select()
  } else {
    contentTextarea.focus()
  }

  function closeModal() {
    document.removeEventListener('keydown', handleKeydown)
    modalOverlay.remove()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      closeModal()
    }
  }

  document.addEventListener('keydown', handleKeydown)
  closeBtn.addEventListener('click', closeModal)
  cancelBtn.addEventListener('click', closeModal)

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const fileName = (isCreate ? nameInput.value : options.fileName)?.trim()
    if (!fileName) {
      alert('Bitte geben Sie einen gültigen Dateinamen ein.')
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Wird gespeichert...'

    try {
      await options.onSave(fileName, contentTextarea.value)
      closeModal()
    } catch (err: unknown) {
      saveBtn.disabled = false
      saveBtn.textContent = isCreate ? 'Erstellen' : 'Speichern'
      alert(`Fehler beim Speichern der Datei: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

function openFolderNameModal(options: { onSave: (name: string) => Promise<void> }): void {
  const existingModal = document.querySelector('.modal-overlay')
  if (existingModal) existingModal.remove()

  const modalOverlay = document.createElement('div')
  modalOverlay.className = 'modal-overlay'

  modalOverlay.innerHTML = `
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header">
        <h3 id="modal-title">Neuen Ordner erstellen</h3>
        <button type="button" class="modal-close-btn" aria-label="Schließen">&times;</button>
      </header>
      <form id="modal-form">
        <div class="modal-body">
          <div class="form-group">
            <label for="modal-file-name">Ordnername:</label>
            <input
              type="text"
              id="modal-file-name"
              class="form-input"
              value="Neuer Ordner"
              required
              placeholder="z. B. projekte"
            />
          </div>
        </div>
        <footer class="modal-footer">
          <button type="button" id="modal-btn-cancel" class="btn btn-secondary">
            Abbrechen
          </button>
          <button type="submit" id="modal-btn-save" class="btn btn-primary">
            Erstellen
          </button>
        </footer>
      </form>
    </div>
  `

  document.body.appendChild(modalOverlay)

  const nameInput = modalOverlay.querySelector<HTMLInputElement>('#modal-file-name')!
  const form = modalOverlay.querySelector<HTMLFormElement>('#modal-form')!
  const closeBtn = modalOverlay.querySelector<HTMLButtonElement>('.modal-close-btn')!
  const cancelBtn = modalOverlay.querySelector<HTMLButtonElement>('#modal-btn-cancel')!
  const saveBtn = modalOverlay.querySelector<HTMLButtonElement>('#modal-btn-save')!

  nameInput.focus()
  nameInput.select()

  function closeModal() {
    document.removeEventListener('keydown', handleKeydown)
    modalOverlay.remove()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeModal()
  }

  document.addEventListener('keydown', handleKeydown)
  closeBtn.addEventListener('click', closeModal)
  cancelBtn.addEventListener('click', closeModal)

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const folderName = nameInput.value.trim()
    if (!folderName) {
      alert('Bitte geben Sie einen gültigen Ordnernamen ein.')
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Wird erstellt...'

    try {
      await options.onSave(folderName)
      closeModal()
    } catch (err: unknown) {
      saveBtn.disabled = false
      saveBtn.textContent = 'Erstellen'
      alert(`Fehler beim Erstellen des Ordners: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
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
    onNavigateUp: () => void
    onRequestNewFile: () => void
    onRequestNewFolder: () => void
    onRequestImport: () => void
    onRequestEdit: (name: string) => void
    onRequestOpen: (name: string) => void
    onRequestOpenFolder: (name: string) => void
  }
): Promise<void> {
  contentEl.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Dateien werden geladen...</p>
    </div>
  `

  try {
    const entries = await storage.listFiles()
    const currentSubPath = storage instanceof FileSystemHandleStorage ? storage.subPath : ''

    if (entries.length === 0) {
      contentEl.innerHTML = `
        ${
          currentSubPath
            ? `<div class="files-breadcrumb">
                <button type="button" id="btn-navigate-up" class="btn btn-secondary btn-sm">
                  ⬅️ Übergeordneter Ordner
                </button>
                <span class="breadcrumb-path">${storage.name}</span>
              </div>`
            : ''
        }
        <div class="empty-state">
          <div class="empty-icon">📁</div>
          <h3>Verzeichnis ist leer</h3>
          <p>In <strong>${storage.name}</strong> wurden keine Dateien gefunden. Sie können neue Dateien erstellen oder importieren.</p>
          <div class="empty-actions">
            <button id="btn-empty-new-file" type="button" class="btn btn-primary">
              ➕ Neue Datei
            </button>
            <button id="btn-empty-new-folder" type="button" class="btn btn-secondary">
              📁 Neuer Ordner
            </button>
            <button id="btn-empty-import-file" type="button" class="btn btn-secondary">
              📥 Dateien importieren
            </button>
          </div>
        </div>
      `
      contentEl.querySelector<HTMLButtonElement>('#btn-navigate-up')?.addEventListener('click', handlers.onNavigateUp)
      contentEl.querySelector<HTMLButtonElement>('#btn-empty-new-file')?.addEventListener('click', handlers.onRequestNewFile)
      contentEl.querySelector<HTMLButtonElement>('#btn-empty-new-folder')?.addEventListener('click', handlers.onRequestNewFolder)
      contentEl.querySelector<HTMLButtonElement>('#btn-empty-import-file')?.addEventListener('click', handlers.onRequestImport)
      return
    }

    const fileCount = entries.filter((e) => e.kind === 'file').length
    const dirCount = entries.filter((e) => e.kind === 'directory').length

    let summaryText = ''
    if (dirCount > 0 && fileCount > 0) {
      summaryText = `${fileCount} Datei${fileCount === 1 ? '' : 'en'}, ${dirCount} Ordner`
    } else if (fileCount > 0) {
      summaryText = `${fileCount} Datei${fileCount === 1 ? '' : 'en'}`
    } else {
      summaryText = `${dirCount} Ordner`
    }

    const rows = entries
      .map((entry) => {
        const isDir = entry.kind === 'directory'
        const icon = isDir ? '📁' : '📄'
        const sizeDisplay = isDir ? '—' : entry.size !== undefined ? formatBytes(entry.size) : '—'
        const dateDisplay = isDir
          ? '—'
          : entry.lastModified !== undefined
            ? formatDate(entry.lastModified)
            : '—'

        return `
          <tr class="file-row ${isDir ? 'is-directory' : 'is-file'}">
            <td class="file-name-cell">
              <span class="file-icon" aria-hidden="true">${icon}</span>
              <span class="file-name" title="${entry.name}">${entry.name}</span>
            </td>
            <td class="file-size-cell">${sizeDisplay}</td>
            <td class="file-date-cell">${dateDisplay}</td>
            <td class="files-actions-cell">
              ${
                isDir
                  ? `<button type="button" class="btn btn-primary btn-sm btn-open-folder" data-entry="${encodeURIComponent(entry.name)}" title="Ordner öffnen">
                      📂 Öffnen
                    </button>`
                  : `<button type="button" class="btn btn-primary btn-sm btn-open-entry" data-entry="${encodeURIComponent(entry.name)}" title="Datei öffnen">
                      📂 Öffnen
                    </button>
                    <button type="button" class="btn btn-secondary btn-sm btn-edit-entry" data-entry="${encodeURIComponent(entry.name)}" title="Datei bearbeiten">
                      ✏️ Bearbeiten
                    </button>`
              }
              <button type="button" class="btn btn-danger btn-sm btn-delete-entry" data-entry="${encodeURIComponent(entry.name)}" title="Löschen">
                🗑️ Löschen
              </button>
            </td>
          </tr>
        `
      })
      .join('')

    contentEl.innerHTML = `
      ${
        currentSubPath
          ? `<div class="files-breadcrumb">
              <button type="button" id="btn-navigate-up" class="btn btn-secondary btn-sm">
                ⬅️ Übergeordneter Ordner
              </button>
              <span class="breadcrumb-path">${storage.name}</span>
            </div>`
          : ''
      }
      <div class="files-summary">
        <span>${summaryText}${
          currentSubPath ? '' : ` in <strong>${storage.name}</strong>`
        }</span>
      </div>
      <div class="table-responsive">
        <table class="files-table">
          <thead>
            <tr>
              <th scope="col" class="th-name">Name</th>
              <th scope="col" class="th-size">Größe</th>
              <th scope="col" class="th-date">Zuletzt geändert</th>
              <th scope="col" class="th-actions">Aktionen</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `

    contentEl.querySelector<HTMLButtonElement>('#btn-navigate-up')?.addEventListener('click', handlers.onNavigateUp)

    const openButtons = contentEl.querySelectorAll<HTMLButtonElement>('.btn-open-entry')
    openButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement
        const entryName = decodeURIComponent(target.dataset.entry || '')
        if (entryName) handlers.onRequestOpen(entryName)
      })
    })

    const openFolderButtons = contentEl.querySelectorAll<HTMLButtonElement>('.btn-open-folder')
    openFolderButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement
        const entryName = decodeURIComponent(target.dataset.entry || '')
        if (entryName) handlers.onRequestOpenFolder(entryName)
      })
    })

    const editButtons = contentEl.querySelectorAll<HTMLButtonElement>('.btn-edit-entry')
    editButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement
        const entryName = decodeURIComponent(target.dataset.entry || '')
        if (entryName) handlers.onRequestEdit(entryName)
      })
    })

    const deleteButtons = contentEl.querySelectorAll<HTMLButtonElement>('.btn-delete-entry')
    deleteButtons.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const target = e.currentTarget as HTMLButtonElement
        const entryName = decodeURIComponent(target.dataset.entry || '')
        if (!entryName) return

        try {
          if (!(await storage.ensureWritePermission())) {
            alert('Schreibzugriff erforderlich.')
            return
          }
        } catch (err) {
          console.error('Fehler bei der Berechtigungsprüfung:', err)
        }

        if (confirm(`Möchten Sie "${entryName}" wirklich löschen?`)) {
          try {
            await storage.deleteEntry(entryName)
            handlers.onRefresh()
          } catch (err: unknown) {
            alert(`Löschen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      })
    })

  } catch (err: unknown) {
    console.error('Fehler beim Laden der Dateiliste:', err)
    contentEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Fehler beim Lesen der Dateien</h3>
        <p>${err instanceof Error ? err.message : 'Unbekannter Fehler aufgetreten.'}</p>
        <button id="btn-retry-list" type="button" class="btn btn-primary">
          Erneut versuchen
        </button>
      </div>
    `
    contentEl.querySelector<HTMLButtonElement>('#btn-retry-list')?.addEventListener('click', handlers.onRefresh)
  }
}

export function renderFilesView(container: HTMLElement): void {
  const hasDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window
  const hasOPFS =
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage.getDirectory === 'function'

  const isFallbackToOPFS = !hasDirectoryPicker && hasOPFS

  container.innerHTML = `
    <div class="files-page">
      <div id="files-alert-area"></div>

      <div class="files-toolbar">
        <div class="folder-status-box" id="folder-status">
          <span class="status-indicator" id="status-indicator"></span>
          <span id="folder-name-display">Speicher wird überprüft...</span>
        </div>
        <div class="folder-actions" id="folder-actions"></div>
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

  const alertArea = container.querySelector<HTMLDivElement>('#files-alert-area')!
  const folderNameDisplay = container.querySelector<HTMLSpanElement>('#folder-name-display')!
  const statusIndicator = container.querySelector<HTMLSpanElement>('#status-indicator')!
  const folderActions = container.querySelector<HTMLDivElement>('#folder-actions')!
  const filesContent = container.querySelector<HTMLDivElement>('#files-content')!
  const fileImportInput = container.querySelector<HTMLInputElement>('#files-import-input')!

  if (!hasDirectoryPicker && !hasOPFS) {
    statusIndicator.className = 'status-indicator status-error'
    folderNameDisplay.textContent = 'Dateisystem-APIs nicht unterstützt'
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

  async function updateView(storage: IFileStorage | null) {
    currentStorage = storage

    if (!storage) {
      statusIndicator.className = 'status-indicator status-neutral'
      folderNameDisplay.textContent = 'Kein Ordner ausgewählt'

      folderActions.innerHTML = `
        <button id="btn-select-folder" type="button" class="btn btn-primary">
          📁 Ordner auswählen
        </button>
        ${
          hasOPFS
            ? `<button id="btn-use-opfs" type="button" class="btn btn-secondary">
                OPFS nutzen
              </button>`
            : ''
        }
      `
      container.querySelector<HTMLButtonElement>('#btn-select-folder')?.addEventListener('click', handleSelectFolder)
      container.querySelector<HTMLButtonElement>('#btn-use-opfs')?.addEventListener('click', handleUseOPFS)

      filesContent.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📂</div>
          <h3>Kein Ordner ausgewählt</h3>
          <p>Wählen Sie einen lokalen Ordner aus, in dem Daten gespeichert sind, um die Dateien anzuzeigen.</p>
          <div class="empty-actions">
            <button id="btn-select-folder-hero" type="button" class="btn btn-primary">
              Ordner wählen
            </button>
            ${
              hasOPFS
                ? `<button id="btn-use-opfs-hero" type="button" class="btn btn-secondary">
                    OPFS-Speicher nutzen
                  </button>`
                : ''
            }
          </div>
        </div>
      `
      container.querySelector<HTMLButtonElement>('#btn-select-folder-hero')?.addEventListener('click', handleSelectFolder)
      container.querySelector<HTMLButtonElement>('#btn-use-opfs-hero')?.addEventListener('click', handleUseOPFS)
      return
    }

    if (storage.type === 'opfs') {
      statusIndicator.className = 'status-indicator status-warning'
      folderNameDisplay.innerHTML = `
        <span class="badge badge-warning">OPFS</span>
        <span>${storage.name}</span>
      `
    } else {
      statusIndicator.className = 'status-indicator status-success'
      folderNameDisplay.innerHTML = `
        <span class="badge badge-success">Lokal</span>
        <span>Ordner: ${storage.name}</span>
      `
    }

    folderActions.innerHTML = `
      <button id="btn-new-file" type="button" class="btn btn-primary">
        ➕ Neue Datei
      </button>
      <button id="btn-new-folder" type="button" class="btn btn-primary">
        📁 Neuer Ordner
      </button>
      <button id="btn-import-file" type="button" class="btn btn-secondary">
        📥 Dateien importieren
      </button>
      <button id="btn-refresh-folder" type="button" class="btn btn-secondary">
        🔄 Aktualisieren
      </button>
      ${
        storage.canChangeFolder
          ? `<button id="btn-change-folder" type="button" class="btn btn-secondary">
              Ordner wechseln
            </button>
            <button id="btn-disconnect-folder" type="button" class="btn btn-danger">
              Trennen
            </button>`
          : ''
      }
      ${
        hasDirectoryPicker && storage.type === 'opfs'
          ? `<button id="btn-switch-picker" type="button" class="btn btn-secondary">
              📁 Zu lokalem Ordner wechseln
            </button>`
          : ''
      }
      ${
        hasOPFS && storage.type === 'fsa'
          ? `<button id="btn-use-opfs" type="button" class="btn btn-secondary">
              OPFS nutzen
            </button>`
          : ''
      }
    `

    container.querySelector<HTMLButtonElement>('#btn-new-file')?.addEventListener('click', handleCreateFile)
    container.querySelector<HTMLButtonElement>('#btn-new-folder')?.addEventListener('click', handleCreateFolder)
    container.querySelector<HTMLButtonElement>('#btn-import-file')?.addEventListener('click', handleImportFiles)
    container.querySelector<HTMLButtonElement>('#btn-refresh-folder')?.addEventListener('click', () => refreshCurrentList())
    container.querySelector<HTMLButtonElement>('#btn-change-folder')?.addEventListener('click', handleSelectFolder)
    container.querySelector<HTMLButtonElement>('#btn-disconnect-folder')?.addEventListener('click', handleDisconnectFolder)
    container.querySelector<HTMLButtonElement>('#btn-switch-picker')?.addEventListener('click', handleSwitchToLocalFolder)
    container.querySelector<HTMLButtonElement>('#btn-use-opfs')?.addEventListener('click', handleUseOPFS)

    await refreshCurrentList()
  }

  async function refreshCurrentList() {
    if (!currentStorage) return

    await renderGenericFileList(filesContent, currentStorage, {
      onRefresh: refreshCurrentList,
      onNavigateUp: () => {
        void navigateUp()
      },
      onRequestNewFile: handleCreateFile,
      onRequestNewFolder: handleCreateFolder,
      onRequestImport: handleImportFiles,
      onRequestEdit: handleEditFile,
      onRequestOpen: (name) => {
        // Echte Browser-Navigation (kein SPA-Routing), damit der Service
        // Worker unter /<pfad> die gespeicherte Datei ausliefern kann. Der
        // volle relative Pfad bleibt erhalten, damit Dateien in Unterordnern
        // unter /<ordner>/<name> geladen werden.
        const path = relativePathOf(currentStorage!, name)
        window.location.assign(
          `/${path.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
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
        console.warn('Kein Schreibzugriff auf den Ordner; Inhalt wird nur gelesen.')
      }
    } catch (err) {
      console.error('Fehler bei der Berechtigungsprüfung:', err)
    }

    try {
      const next = await storage.enterDirectory(name)
      currentStorage = next
      await refreshCurrentList()
    } catch (err: unknown) {
      alert(`Ordner "${name}" konnte nicht geöffnet werden: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Geht eine Ebene nach oben (nur innerhalb eines geöffneten Ordners). */
  async function navigateUp() {
    if (!currentStorage) return
    const storage = currentStorage
    if (!(storage instanceof FileSystemHandleStorage) || !storage.subPath) return

    const parentPath = storage.subPath.includes('/')
      ? storage.subPath.slice(0, storage.subPath.lastIndexOf('/'))
      : ''

    try {
      let handle = storage.rootHandle
      if (parentPath) {
        for (const segment of parentPath.split('/')) {
          handle = await handle.getDirectoryHandle(segment)
        }
      }
      currentStorage = new FileSystemHandleStorage(
        handle,
        storage.type,
        storage.isFallback,
        parentPath,
        storage.rootName,
        storage.rootHandle
      )
      await refreshCurrentList()
    } catch (err: unknown) {
      alert(`Übergeordneter Ordner konnte nicht geöffnet werden: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function handleCreateFile() {
    if (!currentStorage) return
    const storage = currentStorage
    openFileEditorModal({
      mode: 'create',
      onSave: async (fileName, content) => {
        await storage.createFile(fileName, content)
        await refreshCurrentList()
      },
    })
  }

  function handleCreateFolder() {
    if (!currentStorage) return
    const storage = currentStorage
    openFolderNameModal({
      onSave: async (folderName) => {
        await storage.createDirectory(folderName)
        await refreshCurrentList()
      },
    })
  }

  async function handleEditFile(fileName: string) {
    if (!currentStorage) return
    const storage = currentStorage
    try {
      const content = await storage.readFile(fileName)
      openFileEditorModal({
        mode: 'edit',
        fileName,
        initialContent: content,
        onSave: async (name, newContent) => {
          await storage.writeFile(name, newContent)
          await refreshCurrentList()
        },
      })
    } catch (err: unknown) {
      alert(`Datei "${fileName}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleImportFiles() {
    if (!currentStorage) return

    try {
      if (!(await currentStorage.ensureWritePermission())) {
        alert('Schreibzugriff erforderlich, um Dateien zu importieren.')
        return
      }
    } catch (err) {
      console.error('Fehler bei der Berechtigungsprüfung:', err)
    }

    fileImportInput.value = ''
    fileImportInput.onchange = async () => {
      if (!fileImportInput.files || fileImportInput.files.length === 0 || !currentStorage) return
      try {
        for (const file of Array.from(fileImportInput.files)) {
          await currentStorage.createFile(file.name, file)
        }
        await refreshCurrentList()
      } catch (err: unknown) {
        alert(`Dateien konnten nicht importiert werden: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    fileImportInput.click()
  }

  async function handleSelectFolder() {
    try {
      if (!window.showDirectoryPicker) {
        if (hasOPFS) {
          await handleUseOPFS()
          return
        }
        alert('Die File System Access API wird von diesem Browser nicht unterstützt.')
        return
      }

      // showDirectoryPicker erzeugt die User Gesture automatisch
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
      })

      await storeDirectoryHandle(handle)
      await storeStorageType('fsa')
      const storage = new FileSystemHandleStorage(handle, 'fsa', false)
      await updateView(storage)
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      console.error('Fehler bei der Ordnerauswahl:', err)
      alertArea.innerHTML = `
        <div class="alert alert-danger">
          <strong>Auswahlfehler:</strong> ${err instanceof Error ? err.message : 'Ordner konnte nicht ausgewählt werden'}
        </div>
      `
    }
  }

  async function handleSwitchToLocalFolder() {
    // Um User Gesture Verluste durch IndexedDB zu vermeiden, nutzen wir
    // stattdessen den strikten und sicheren Start-Ablauf:
    await initStorage(true)
  }

  async function handleUseOPFS() {
    const opfsHandle = await getOPFSDirectoryHandle()
    if (opfsHandle) {
      await storeStorageType('opfs')
      const storage = new FileSystemHandleStorage(opfsHandle, 'opfs', isFallbackToOPFS)
      await updateView(storage)
    } else {
      alert('Zugriff auf das Origin Private File System fehlgeschlagen.')
    }
  }

  async function handleDisconnectFolder() {
    await clearStoredDirectoryHandle()
    await clearStoredStorageType()
    await updateView(null)
  }

  // Hilfsfunktion: Bereitet die UI so vor, dass der Klick direkt in requestPermission resultiert.
  function showReopenButtonUI(storedHandle: FileSystemDirectoryHandle) {
    statusIndicator.className = 'status-indicator status-warning'
    folderNameDisplay.textContent = `Ordner: ${storedHandle.name} (Zugriff erforderlich)`

    folderActions.innerHTML = `
      <button id="btn-grant-permission" type="button" class="btn btn-primary">
        🔓 Zugriff erlauben
      </button>
      <button id="btn-change-folder" type="button" class="btn btn-secondary">
        Ordner wechseln
      </button>
    `

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
          const permission = await storedHandle.requestPermission({ mode: 'readwrite' })

          if (permission === 'granted') {
            const storage = new FileSystemHandleStorage(storedHandle, 'fsa', false)
            await updateView(storage)
          } else {
            alert('Zugriff verweigert.')
          }
        }
      } catch (err) {
        console.error('requestPermission Fehler:', err)
      }
    }

    container.querySelector<HTMLButtonElement>('#btn-grant-permission')?.addEventListener('click', handleUserClickToUnlock)
    container.querySelector<HTMLButtonElement>('#btn-grant-permission-hero')?.addEventListener('click', handleUserClickToUnlock)
    container.querySelector<HTMLButtonElement>('#btn-change-folder')?.addEventListener('click', handleSelectFolder)
  }

  // 1. Beim App-Start NUR prüfen, ob das Recht noch da ist
  async function initStorage(forceLocal = false) {
    if (isFallbackToOPFS && !forceLocal) {
      await handleUseOPFS()
      return
    }

    try {
      // Wenn OPFS zuvor ausdrücklich gewählt wurde, diese Wahl beibehalten
      // (solange kein FSA-Ordner erzwungen wird).
      if (!forceLocal) {
        const storedType = await getStoredStorageType()
        if (storedType === 'opfs' && hasOPFS) {
          await handleUseOPFS()
          return
        }
      }

      // Async-Ladevorgang (Datenbank) isolieren von requestPermission
      const storedHandle = await getStoredDirectoryHandle()
      if (!storedHandle) {
        await updateView(null)
        return
      }

      let permission: PermissionState = 'prompt'
      if (storedHandle.queryPermission) {
        try {
          permission = await storedHandle.queryPermission({ mode: 'readwrite' })
        } catch (err) {
          console.warn('queryPermission fehlgeschlagen:', err)
        }
      }

      if (permission === 'granted') {
        // Perfekt, Browser/Android hat es sich (im Hintergrund) gemerkt
        const storage = new FileSystemHandleStorage(storedHandle, 'fsa', false)
        await updateView(storage)
      } else {
        // WICHTIG: Jetzt NICHT sofort requestPermission() aufrufen!
        // Zeige stattdessen die UI-Buttons an.
        showReopenButtonUI(storedHandle)
      }
    } catch (err) {
      console.error('Fehler beim Initialisieren des gespeicherten Ordners:', err)
      await updateView(null)
    }
  }

  initStorage()
}
