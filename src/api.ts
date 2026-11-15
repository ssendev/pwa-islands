import { Array, Clock, Effect, Option, Order } from "effect"
import { invoke } from "@tauri-apps/api/core"
import { appendFileHistoryBytes, recordPreviousTauriApiFileVersion } from "./history"
import {
  checkTextBytes,
  collectDirectoryHandles,
  copyDirectory,
  findActiveStorage,
  getDirectory,
  getStoredApiHistoryEnabled,
  getStoredStorageType,
  normalizePath,
  readTextOrThrow,
  splitPath,
} from "./storage"
import type { IslandEntry, IslandsApi } from "./api-types"

export type {
  IslandEntry,
  IslandInput,
  IslandsApi,
  ReadOptions,
  WriteOptions,
  RemoveOptions,
} from "./api-types"

async function resolveFile(path: string, createParents = false): Promise<FileSystemFileHandle> {
  const root = await requireRoot()
  const { dirs, name } = splitEntryPath(path)
  const dir = createParents ? await getDirectory(root, dirs, true) : await getDirectory(root, dirs)
  return dir.getFileHandle(name, { create: createParents })
}

async function resolveDirectory(path: string, create = false): Promise<FileSystemDirectoryHandle> {
  const root = await requireRoot()
  const dirs = splitPath(normalizePath(path))
  return getDirectory(root, dirs, create)
}

async function requireRoot(): Promise<FileSystemDirectoryHandle> {
  return Option.match(await findActiveStorage(), {
    onNone: () => {
      throw new Error("Kein Speicher ausgewählt. Bitte zuerst einen Ordner auswählen.")
    },
    onSome: (root) => root,
  })
}

async function isTauriActive(): Promise<boolean> {
  const maybeType = await getStoredStorageType()
  return Option.exists(maybeType, (t) => t === "tauri")
}

function splitEntryPath(path: string): { dirs: ReadonlyArray<string>; name: string } {
  const parts = splitPath(normalizePath(path))
  if (!Array.isReadonlyArrayNonEmpty(parts)) {
    throw new Error("Ungültiger Pfad: Datei- oder Ordnername fehlt.")
  }
  return {
    dirs: Array.dropRight(parts, 1),
    name: Array.lastNonEmpty(parts),
  }
}

async function recordBrowserPathVersions(cleanPath: string, timestampMs: number): Promise<void> {
  try {
    const file = await (await resolveFile(cleanPath)).getFile()
    const { dirs, name } = splitEntryPath(cleanPath)
    await appendFileHistoryBytes(dirs, name, new Uint8Array(await file.arrayBuffer()), timestampMs)
    return
  } catch {
    // Keine Datei – prüfe ob es ein Verzeichnis ist
  }
  const dir = await resolveDirectory(cleanPath)
  const handles = await collectDirectoryHandles(dir)
  await handles.reduce<Promise<void>>(async (acc, handle) => {
    await acc
    const childPath = `${cleanPath}/${handle.name}`
    if (handle.kind === "file") {
      const file = await handle.getFile()
      const { dirs, name } = splitEntryPath(childPath)
      await appendFileHistoryBytes(
        dirs,
        name,
        new Uint8Array(await file.arrayBuffer()),
        timestampMs,
      )
    } else {
      await recordBrowserPathVersions(childPath, timestampMs)
    }
  }, Promise.resolve())
}

async function recordPreviousApiFileVersion(path: string): Promise<void> {
  try {
    if (!(await getStoredApiHistoryEnabled())) {
      return
    }
    const cleanPath = normalizePath(path)
    if (!cleanPath) {
      return
    }
    const timestampMs = Effect.runSync(Clock.currentTimeMillis)
    if (await isTauriActive()) {
      await recordPreviousTauriApiFileVersion(cleanPath, timestampMs)
      return
    }
    await recordBrowserPathVersions(cleanPath, timestampMs)
  } catch {
    // NOTE: Fehlende Quelldatei oder nicht verfügbares OPFS darf das Schreiben oder Löschen über api.js nicht blockieren
  }
}

async function removeEntryInternal(path: string, recursive: boolean): Promise<void> {
  if (await isTauriActive()) {
    await invoke("tauri_fs_remove_entry", {
      subPath: normalizePath(path),
      isDirectory: recursive,
    })
    return
  }

  const root = await requireRoot()
  const { dirs, name } = splitEntryPath(path)
  const dir = await getDirectory(root, dirs)
  await dir.removeEntry(name, { recursive })
}

const islandEntryOrder: Order.Order<IslandEntry> = Order.make((a, b) => {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1
  }
  const cmp = a.name.localeCompare(b.name, "de", { sensitivity: "base", numeric: true })
  return cmp < 0 ? -1 : cmp > 0 ? 1 : 0
})

const api: IslandsApi = {
  async list(path = "") {
    if (await isTauriActive()) {
      const cleanPath = normalizePath(path)
      const raw = await invoke<
        ReadonlyArray<{
          name: string
          isDirectory: boolean
          size: number | null
          lastModified: number | null
        }>
      >("tauri_fs_list_entries", { subPath: cleanPath })
      const entries: ReadonlyArray<IslandEntry> = Array.map(raw, (entry): IslandEntry => {
        const entryPath = cleanPath ? `${cleanPath}/${entry.name}` : entry.name
        if (entry.isDirectory) {
          return { name: entry.name, path: entryPath, kind: "directory" }
        }
        return {
          name: entry.name,
          path: entryPath,
          kind: "file",
          size: entry.size ?? undefined,
          lastModified: entry.lastModified ?? undefined,
        }
      })
      return Array.sort(entries, islandEntryOrder)
    }

    const dir = await resolveDirectory(path)
    const handles = await collectDirectoryHandles(dir)

    const entries: ReadonlyArray<IslandEntry> = await Promise.all(
      Array.map(handles, async (entry): Promise<IslandEntry> => {
        const entryPath = path ? `${normalizePath(path)}/${entry.name}` : entry.name
        if (entry.kind === "file") {
          const stats = await entry
            .getFile()
            .then((file) => ({ size: file.size, lastModified: file.lastModified }))
            .catch(() => ({ size: undefined, lastModified: undefined }))
          return { name: entry.name, path: entryPath, kind: "file", ...stats }
        }
        return { name: entry.name, path: entryPath, kind: "directory" }
      }),
    )

    return Array.sort(entries, islandEntryOrder)
  },

  async read(path, options) {
    if (await isTauriActive()) {
      const buffer = await invoke<ArrayBuffer>("tauri_fs_read_file", {
        subPath: normalizePath(path),
      })
      const bytes = new Uint8Array(buffer)
      if (options?.ensureText) {
        const check = checkTextBytes(bytes)
        if (check.kind === "binary") {
          throw new Error(`Datei ist kein gültiger UTF-8-Text: ${check.reason} (${path}).`)
        }
        return check.kind === "text" ? check.text : ""
      }
      return new TextDecoder().decode(bytes)
    }

    const file = await (await resolveFile(path)).getFile()
    return options?.ensureText ? readTextOrThrow(file, path) : file.text()
  },

  async readBlob(path) {
    if (await isTauriActive()) {
      const buffer = await invoke<ArrayBuffer>("tauri_fs_read_file", {
        subPath: normalizePath(path),
      })
      const parts = splitPath(normalizePath(path))
      const name = Array.isReadonlyArrayNonEmpty(parts) ? Array.lastNonEmpty(parts) : "file"
      return new File([buffer], name)
    }

    return (await resolveFile(path)).getFile()
  },

  async exists(path) {
    if (await isTauriActive()) {
      return await invoke<boolean>("tauri_fs_exists", { subPath: normalizePath(path) })
    }

    try {
      await resolveFile(path)
      return true
    } catch {
      try {
        await resolveDirectory(path)
        return true
      } catch {
        return false
      }
    }
  },

  async write(path, content, options) {
    const overwrite = options?.overwrite ?? false

    if (!overwrite && (await api.exists(path))) {
      throw new Error(`Datei existiert bereits: ${path}`)
    }

    if (overwrite) {
      await recordPreviousApiFileVersion(path)
    }

    if (await isTauriActive()) {
      let bytes: Uint8Array
      if (typeof content === "string") {
        bytes = new TextEncoder().encode(content)
      } else if (content instanceof Blob) {
        bytes = new Uint8Array(await content.arrayBuffer())
      } else if (content instanceof ArrayBuffer) {
        bytes = new Uint8Array(content)
      } else {
        bytes = content
      }
      await invoke("tauri_fs_write_file", {
        subPath: normalizePath(path),
        data: globalThis.Array.from(bytes),
      })
      return
    }

    const handle = await resolveFile(path, true)
    const writable = await handle.createWritable()
    try {
      await writable.write(content)
    } finally {
      await writable.close()
    }
  },

  async makeDir(path) {
    if (await isTauriActive()) {
      await invoke("tauri_fs_create_dir", { subPath: normalizePath(path) })
      return
    }

    await resolveDirectory(path, true)
  },

  async rename(from, to) {
    if (await isTauriActive()) {
      await recordPreviousApiFileVersion(to)
      await invoke("tauri_fs_rename", {
        fromSubPath: normalizePath(from),
        toSubPath: normalizePath(to),
      })
      return
    }

    await api.copy(from, to)
    await removeEntryInternal(from, false)
  },

  async remove(path, options) {
    const recursive = options?.recursive ?? false
    await recordPreviousApiFileVersion(path)
    await removeEntryInternal(path, recursive)
  },

  async copy(from, to) {
    await recordPreviousApiFileVersion(to)
    if (await isTauriActive()) {
      await invoke("tauri_fs_copy", {
        fromSubPath: normalizePath(from),
        toSubPath: normalizePath(to),
      })
      return
    }

    const maybeSource = await resolveDirectory(from).then(Option.some, () => Option.none())
    if (Option.isSome(maybeSource)) {
      const { dirs: toDirs, name: toName } = splitEntryPath(to)
      const target = await resolveDirectory(toDirs.join("/"), true)
      await copyDirectory(maybeSource.value, target, toName)
      return
    }

    const file = await resolveFile(from)
    const { dirs: toDirs, name: toName } = splitEntryPath(to)
    const target = await resolveDirectory(toDirs.join("/"), true)
    const blob = await file.getFile()
    const dest = await target.getFileHandle(toName, { create: true })
    const writable = await dest.createWritable()
    try {
      await writable.write(blob)
    } finally {
      await writable.close()
    }
  },
}

export default api
