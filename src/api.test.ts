import { Option } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

const appendFileHistoryBytesMock = vi.fn()
const getStoredApiHistoryEnabledMock = vi.fn<() => Promise<boolean>>()
const getStoredStorageTypeMock = vi.fn()
const findActiveStorageMock = vi.fn()

vi.mock("./history", () => ({
  appendFileHistoryBytes: (...args: ReadonlyArray<unknown>) => appendFileHistoryBytesMock(...args),
}))

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>()
  return {
    ...actual,
    findActiveStorage: () => findActiveStorageMock(),
    getStoredApiHistoryEnabled: () => getStoredApiHistoryEnabledMock(),
    getStoredStorageType: () => getStoredStorageTypeMock(),
  }
})

import api from "./api"

const createMemoryRoot = (initialFiles: Record<string, string | Uint8Array>) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(initialFiles).map(([key, value]) => [
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ]),
  )

  const makeFileHandle = (name: string): FileSystemFileHandle =>
    ({
      kind: "file",
      name,
      getFile: async () => {
        const bytes = files.get(name)
        if (!bytes) {
          throw new DOMException("Not found", "NotFoundError")
        }
        return new File([new Uint8Array(bytes)], name)
      },
      createWritable: async () => ({
        write: async (content: string | Uint8Array | Blob) => {
          if (typeof content === "string") {
            files.set(name, new TextEncoder().encode(content))
          } else if (content instanceof Uint8Array) {
            files.set(name, content)
          } else {
            files.set(name, new Uint8Array(await content.arrayBuffer()))
          }
        },
        close: async () => {},
      }),
    }) as unknown as FileSystemFileHandle

  const root = {
    kind: "directory",
    name: "root",
    getDirectoryHandle: async (name: string) => {
      if (name === "") {
        return root
      }
      throw new DOMException("Not found", "NotFoundError")
    },
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) {
        throw new DOMException("Not found", "NotFoundError")
      }
      return makeFileHandle(name)
    },
    removeEntry: async (name: string) => {
      files.delete(name)
    },
  } as unknown as FileSystemDirectoryHandle

  return { root, files }
}

describe("api.write Versionsverlauf", () => {
  beforeEach(() => {
    appendFileHistoryBytesMock.mockReset()
    getStoredApiHistoryEnabledMock.mockReset()
    getStoredStorageTypeMock.mockReset()
    findActiveStorageMock.mockReset()
    getStoredStorageTypeMock.mockResolvedValue(Option.some("opfs"))
  })

  it("speichert die vorherige Textversion beim Überschreiben, wenn api.js Versionen aktiviert sind", async () => {
    const { root, files } = createMemoryRoot({ "app.html": "alter inhalt" })
    findActiveStorageMock.mockResolvedValue(Option.some(root))
    getStoredApiHistoryEnabledMock.mockResolvedValue(true)

    await api.write("app.html", "neuer inhalt", { overwrite: true })

    expect(appendFileHistoryBytesMock).toHaveBeenCalledTimes(1)
    expect(appendFileHistoryBytesMock).toHaveBeenCalledWith(
      [],
      "app.html",
      new TextEncoder().encode("alter inhalt"),
      expect.any(Number),
    )
    expect(new TextDecoder().decode(files.get("app.html"))).toBe("neuer inhalt")
  })

  it("speichert keine Version, wenn api.js Versionen deaktiviert sind", async () => {
    const { root, files } = createMemoryRoot({ "app.html": "alter inhalt" })
    findActiveStorageMock.mockResolvedValue(Option.some(root))
    getStoredApiHistoryEnabledMock.mockResolvedValue(false)

    await api.write("app.html", "neuer inhalt", { overwrite: true })

    expect(appendFileHistoryBytesMock).not.toHaveBeenCalled()
    expect(new TextDecoder().decode(files.get("app.html"))).toBe("neuer inhalt")
  })

  it("speichert auch Versionen für Binärdateien", async () => {
    const oldBytes = new Uint8Array([0, 1, 2, 3, 255])
    const { root, files } = createMemoryRoot({ "image.bin": oldBytes })
    findActiveStorageMock.mockResolvedValue(Option.some(root))
    getStoredApiHistoryEnabledMock.mockResolvedValue(true)

    await api.write("image.bin", new Uint8Array([4, 5]), { overwrite: true })

    expect(appendFileHistoryBytesMock).toHaveBeenCalledTimes(1)
    expect(appendFileHistoryBytesMock).toHaveBeenCalledWith(
      [],
      "image.bin",
      oldBytes,
      expect.any(Number),
    )
    expect(files.get("image.bin")).toEqual(new Uint8Array([4, 5]))
  })

  it("speichert vor dem Löschen per api.remove eine Version der Datei", async () => {
    const { root, files } = createMemoryRoot({ "old.html": "zu loeschen" })
    findActiveStorageMock.mockResolvedValue(Option.some(root))
    getStoredApiHistoryEnabledMock.mockResolvedValue(true)

    await api.remove("old.html")

    expect(appendFileHistoryBytesMock).toHaveBeenCalledTimes(1)
    expect(appendFileHistoryBytesMock).toHaveBeenCalledWith(
      [],
      "old.html",
      new TextEncoder().encode("zu loeschen"),
      expect.any(Number),
    )
    expect(files.has("old.html")).toBe(false)
  })

  it("speichert bei api.rename nur die überschriebene Zieldatei und nicht die umbenannte Quelldatei", async () => {
    const { root, files } = createMemoryRoot({
      "source.html": "quellinhalt",
      "target.html": "zielinhalt",
    })
    findActiveStorageMock.mockResolvedValue(Option.some(root))
    getStoredApiHistoryEnabledMock.mockResolvedValue(true)

    await api.rename("source.html", "target.html")

    expect(appendFileHistoryBytesMock).toHaveBeenCalledTimes(1)
    expect(appendFileHistoryBytesMock).toHaveBeenCalledWith(
      [],
      "target.html",
      new TextEncoder().encode("zielinhalt"),
      expect.any(Number),
    )
    expect(files.has("source.html")).toBe(false)
    expect(new TextDecoder().decode(files.get("target.html"))).toBe("quellinhalt")
  })
})
