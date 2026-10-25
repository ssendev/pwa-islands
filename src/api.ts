import { Option } from "effect"
import { findActiveStorage, normalizePath, splitPath, getDirectory } from "./storage.ts"
import { readTextOrThrow } from "./text.ts"
import type { IslandEntry, IslandsApi } from "./api-types.ts"

export type {
  IslandEntry,
  IslandInput,
  IslandsApi,
  ReadOptions,
  WriteOptions,
  RemoveOptions,
} from "./api-types.ts"

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

function splitEntryPath(path: string): { dirs: ReadonlyArray<string>; name: string } {
  const parts = [...splitPath(normalizePath(path))]
  const name = parts.pop()
  if (!name) {
    throw new Error("Ungültiger Pfad: Datei- oder Ordnername fehlt.")
  }
  return { dirs: parts, name }
}

const api: IslandsApi = {
  async list(path = "") {
    const dir = await resolveDirectory(path)
    const entries: Array<IslandEntry> = []

    for await (const entry of dir.values()) {
      const entryPath = path ? `${normalizePath(path)}/${entry.name}` : entry.name
      if (entry.kind === "file") {
        const stats = await entry
          .getFile()
          .then((file) => ({ size: file.size, lastModified: file.lastModified }))
          .catch(() => ({ size: undefined, lastModified: undefined }))
        entries.push({ name: entry.name, path: entryPath, kind: "file", ...stats })
      } else {
        entries.push({ name: entry.name, path: entryPath, kind: "directory" })
      }
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name, "de", { sensitivity: "base", numeric: true })
    })

    return entries
  },

  async read(path, options) {
    const file = await (await resolveFile(path)).getFile()
    return options?.ensureText ? readTextOrThrow(file, path) : file.text()
  },

  async readBlob(path) {
    return (await resolveFile(path)).getFile()
  },

  async exists(path) {
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

    const handle = await resolveFile(path, true)
    const writable = await handle.createWritable()
    try {
      await writable.write(
        content instanceof Uint8Array || content instanceof ArrayBuffer
          ? new Blob([content as BlobPart])
          : content,
      )
    } finally {
      await writable.close()
    }
  },

  async makeDir(path) {
    await resolveDirectory(path, true)
  },

  async rename(from, to) {
    await api.copy(from, to)
    await api.remove(from)
  },

  async remove(path, options) {
    const recursive = options?.recursive ?? false
    const root = await requireRoot()
    const { dirs, name } = splitEntryPath(path)
    const dir = await getDirectory(root, dirs)
    await dir.removeEntry(name, { recursive })
  },

  async copy(from, to) {
    const source = await resolveDirectory(from).catch(() => null)
    if (source) {
      const { dirs: toDirs, name: toName } = splitEntryPath(to)
      const target = await resolveDirectory(toDirs.join("/"), true)
      await copyDirectory(source, target, toName)
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

async function copyDirectory(
  source: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const destDir = await target.getDirectoryHandle(name, { create: true })
  for await (const entry of source.values()) {
    if (entry.kind === "file") {
      const blob = await entry.getFile()
      const fileHandle = await destDir.getFileHandle(entry.name, { create: true })
      const writable = await fileHandle.createWritable()
      try {
        await writable.write(blob)
      } finally {
        await writable.close()
      }
    } else {
      await copyDirectory(entry, destDir, entry.name)
    }
  }
}

export default api
