import { invoke } from "@tauri-apps/api/core"
import { Option } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  appendFileHistory,
  clearAllFileHistory,
  clearFileHistory,
  encodeHistoryRecord,
  hashHistoryContent,
  loadFileHistoryEntryAt,
  loadFileHistoryIndex,
  loadPreviousFileHistoryEntry,
  readAllHistoryMeta,
  readHistoryRecordAt,
  recordPreviousTauriApiFileVersion,
  truncateLatestFileHistoryEntry,
  type SliceReader,
} from "./history"

const tauriFiles = new Map<string, Uint8Array>()
const tauriFsFiles = new Map<string, Uint8Array>()
let apiHistoryEnabledMock = true

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>()
  return {
    ...actual,
    getStoredApiHistoryEnabled: async () => apiHistoryEnabledMock,
  }
})

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const subPath = (args?.subPath as ReadonlyArray<string> | undefined) ?? []
    const fileName = (args?.fileName as string | undefined) ?? ""
    const key = [...subPath, fileName].join("/")
    if (cmd === "tauri_history_append") {
      const incoming = new Uint8Array((args?.data as Array<number>) ?? [])
      const existing = tauriFiles.get(key) ?? new Uint8Array(0)
      const combined = new Uint8Array(existing.byteLength + incoming.byteLength)
      combined.set(existing, 0)
      combined.set(incoming, existing.byteLength)
      tauriFiles.set(key, combined)
      return undefined
    }
    if (cmd === "tauri_history_size") {
      return tauriFiles.get(key)?.byteLength ?? 0
    }
    if (cmd === "tauri_history_read_slice") {
      const bytes = tauriFiles.get(key) ?? new Uint8Array(0)
      const start = Math.min((args?.start as number) ?? 0, bytes.byteLength)
      const end = Math.min((args?.end as number) ?? 0, bytes.byteLength)
      if (end <= start) {
        return new ArrayBuffer(0)
      }
      return bytes.slice(start, end).buffer
    }
    if (cmd === "tauri_history_truncate") {
      const size = (args?.size as number) ?? 0
      if (size === 0) {
        tauriFiles.delete(key)
      } else {
        const existing = tauriFiles.get(key)
        if (existing) {
          tauriFiles.set(key, existing.slice(0, size))
        }
      }
      return undefined
    }
    if (cmd === "tauri_history_clear") {
      tauriFiles.delete(key)
      return undefined
    }
    if (cmd === "tauri_history_clear_all") {
      tauriFiles.clear()
      return undefined
    }
    if (cmd === "tauri_history_read_index") {
      const bytes = tauriFiles.get(key) ?? new Uint8Array(0)
      return readAllHistoryMeta(makeSliceReader(bytes), bytes.byteLength)
    }
    if (cmd === "tauri_fs_exists") {
      const subPathArg = (args?.subPath as string | undefined) ?? ""
      if (tauriFsFiles.has(subPathArg)) {
        return true
      }
      const prefix = `${subPathArg}/`
      return Array.from(tauriFsFiles.keys()).some((k) => k.startsWith(prefix))
    }
    if (cmd === "tauri_fs_read_file") {
      const subPathArg = (args?.subPath as string | undefined) ?? ""
      const bytes = tauriFsFiles.get(subPathArg)
      if (!bytes) {
        throw new Error(`Not a file: ${subPathArg}`)
      }
      return bytes.slice().buffer
    }
    if (cmd === "tauri_fs_list_entries") {
      const subPathArg = (args?.subPath as string | undefined) ?? ""
      const prefix = subPathArg ? `${subPathArg}/` : ""
      const names = new Set<string>()
      for (const path of tauriFsFiles.keys()) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length)
          const firstSegment = rest.split("/")[0]
          if (firstSegment) {
            names.add(firstSegment)
          }
        }
      }
      return Array.from(names).map((name) => ({ name }))
    }
    throw new Error(`Unexpected invoke command: ${cmd}`)
  }),
}))

const makeSliceReader = (bytes: Uint8Array): SliceReader => {
  return async (start, end) => {
    const slice = bytes.slice(start, end)
    return slice.buffer
  }
}

const concatRecords = (records: ReadonlyArray<Uint8Array>): Uint8Array => {
  const totalLength = records.reduce((sum, r) => sum + r.byteLength, 0)
  const combined = new Uint8Array(totalLength)
  records.reduce((offset, r) => {
    combined.set(r, offset)
    return offset + r.byteLength
  }, 0)
  return combined
}

describe("history binary format", () => {
  it("encodes and reads a single record backward from EOF", async () => {
    const timestamp = 1731580000123
    const content = "<html><body><h1>Hallo Welt! 🚀</h1></body></html>"
    const encoded = encodeHistoryRecord(content, timestamp)
    const reader = makeSliceReader(encoded)

    const maybeRecord = await readHistoryRecordAt(reader, encoded.byteLength)
    expect(Option.isSome(maybeRecord)).toBe(true)
    if (Option.isSome(maybeRecord)) {
      expect(maybeRecord.value.content).toBe(content)
      expect(maybeRecord.value.timestampMs).toBe(timestamp)
      expect(maybeRecord.value.startOffset).toBe(0)
      expect(maybeRecord.value.endOffset).toBe(encoded.byteLength)
    }
  })

  it("navigates backward through multiple appended records without reading the whole file", async () => {
    const r1 = encodeHistoryRecord("Version 1", 1000)
    const r2 = encodeHistoryRecord("Version 2 mit Umlauten: äöüß", 2000)
    const r3 = encodeHistoryRecord("", 3000)
    const combined = concatRecords([r1, r2, r3])
    const reader = makeSliceReader(combined)

    const step1 = await readHistoryRecordAt(reader, combined.byteLength)
    expect(Option.isSome(step1)).toBe(true)
    if (!Option.isSome(step1)) return
    expect(step1.value.content).toBe("")
    expect(step1.value.timestampMs).toBe(3000)

    const step2 = await readHistoryRecordAt(reader, step1.value.startOffset)
    expect(Option.isSome(step2)).toBe(true)
    if (!Option.isSome(step2)) return
    expect(step2.value.content).toBe("Version 2 mit Umlauten: äöüß")
    expect(step2.value.timestampMs).toBe(2000)

    const step3 = await readHistoryRecordAt(reader, step2.value.startOffset)
    expect(Option.isSome(step3)).toBe(true)
    if (!Option.isSome(step3)) return
    expect(step3.value.content).toBe("Version 1")
    expect(step3.value.timestampMs).toBe(1000)
    expect(step3.value.startOffset).toBe(0)

    const step4 = await readHistoryRecordAt(reader, step3.value.startOffset)
    expect(Option.isNone(step4)).toBe(true)
  })

  it("reads only 16-byte trailers via readAllHistoryMeta without reading content bytes", async () => {
    const combined = concatRecords([
      encodeHistoryRecord("first-entry-content", 100),
      encodeHistoryRecord("second-entry-content", 200),
      encodeHistoryRecord("third-entry-content", 300),
    ])
    const readSizes: Array<number> = []
    const trackingReader: SliceReader = async (start, end) => {
      readSizes.push(end - start)
      return combined.slice(start, end).buffer
    }

    const metaList = await readAllHistoryMeta(trackingReader, combined.byteLength)

    expect(readSizes).toEqual([16, 16, 16])
    expect(
      metaList.map((m) => ({
        timestampMs: m.timestampMs,
        byteLength: m.byteLength,
        contentHash: m.contentHash,
      })),
    ).toEqual([
      {
        timestampMs: 300,
        byteLength: "third-entry-content".length,
        contentHash: hashHistoryContent("third-entry-content"),
      },
      {
        timestampMs: 200,
        byteLength: "second-entry-content".length,
        contentHash: hashHistoryContent("second-entry-content"),
      },
      {
        timestampMs: 100,
        byteLength: "first-entry-content".length,
        contentHash: hashHistoryContent("first-entry-content"),
      },
    ])

    const middleEntry = metaList[1]
    const loadedMiddle = await readHistoryRecordAt(makeSliceReader(combined), middleEntry.endOffset)
    expect(Option.isSome(loadedMiddle)).toBe(true)
    if (Option.isSome(loadedMiddle)) {
      expect(loadedMiddle.value.content).toBe("second-entry-content")
      expect(loadedMiddle.value.timestampMs).toBe(200)
    }
  })

  it("returns none when the offset is too small or length is out of bounds", async () => {
    const badBuffer = new Uint8Array(16)
    const view = new DataView(badBuffer.buffer)
    view.setUint32(0, 0, true)
    view.setFloat64(4, 1234, true)
    view.setUint32(12, 999, true)

    expect(Option.isNone(await readHistoryRecordAt(makeSliceReader(badBuffer), 5))).toBe(true)
    expect(Option.isNone(await readHistoryRecordAt(makeSliceReader(badBuffer), 16))).toBe(true)
  })
})

describe("tauri history backend", () => {
  beforeEach(() => {
    tauriFiles.clear()
    tauriFsFiles.clear()
    apiHistoryEnabledMock = true
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("appends, indexes, navigates, truncates, and clears history via Tauri commands", async () => {
    const subPath = ["apps", "demo"]
    const fileName = "index.html"

    expect(await loadFileHistoryIndex(subPath, fileName)).toEqual([])
    expect(
      Option.isNone(await loadPreviousFileHistoryEntry(subPath, fileName, Option.none())),
    ).toBe(true)

    await appendFileHistory(subPath, fileName, "v1", 1000)
    await appendFileHistory(subPath, fileName, "v2", 2000)

    vi.mocked(invoke).mockClear()
    const index = await loadFileHistoryIndex(subPath, fileName)
    expect(index.map((entry) => entry.timestampMs)).toEqual([2000, 1000])
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("tauri_history_read_index", {
      subPath,
      fileName,
    })

    const latest = await loadPreviousFileHistoryEntry(subPath, fileName, Option.none())
    expect(Option.isSome(latest)).toBe(true)
    if (Option.isSome(latest)) {
      expect(latest.value.content).toBe("v2")
    }

    const atV1 = await loadFileHistoryEntryAt(subPath, fileName, index[1].endOffset)
    expect(Option.isSome(atV1)).toBe(true)
    if (Option.isSome(atV1)) {
      expect(atV1.value.content).toBe("v1")
    }

    await truncateLatestFileHistoryEntry(subPath, fileName)
    const afterTruncate = await loadFileHistoryIndex(subPath, fileName)
    expect(afterTruncate.map((entry) => entry.timestampMs)).toEqual([1000])

    await clearFileHistory(subPath, fileName)
    expect(await loadFileHistoryIndex(subPath, fileName)).toEqual([])

    await appendFileHistory(["a"], "one.html", "1", 100)
    await appendFileHistory(["b"], "two.html", "2", 200)
    await clearAllFileHistory()
    expect(await loadFileHistoryIndex(["a"], "one.html")).toEqual([])
    expect(await loadFileHistoryIndex(["b"], "two.html")).toEqual([])
  })

  it("records previous versions for Tauri api.js file and directory mutations", async () => {
    const encoder = new TextEncoder()
    tauriFsFiles.set("apps/demo/index.html", encoder.encode("alt"))
    tauriFsFiles.set("apps/demo/nested/data.json", encoder.encode('{"v":1}'))

    await recordPreviousTauriApiFileVersion("/apps/demo/index.html", 5000)

    const fileHistory = await loadPreviousFileHistoryEntry(
      ["apps", "demo"],
      "index.html",
      Option.none(),
    )
    expect(Option.isSome(fileHistory)).toBe(true)
    if (Option.isSome(fileHistory)) {
      expect(fileHistory.value.content).toBe("alt")
      expect(fileHistory.value.timestampMs).toBe(5000)
    }

    await recordPreviousTauriApiFileVersion("apps/demo/nested", 6000)
    const nestedHistory = await loadPreviousFileHistoryEntry(
      ["apps", "demo", "nested"],
      "data.json",
      Option.none(),
    )
    expect(Option.isSome(nestedHistory)).toBe(true)
    if (Option.isSome(nestedHistory)) {
      expect(nestedHistory.value.content).toBe('{"v":1}')
      expect(nestedHistory.value.timestampMs).toBe(6000)
    }

    apiHistoryEnabledMock = false
    await recordPreviousTauriApiFileVersion("apps/demo/index.html", 7000)
    const indexAfterDisabled = await loadFileHistoryIndex(["apps", "demo"], "index.html")
    expect(indexAfterDisabled.map((entry) => entry.timestampMs)).toEqual([5000])
  })

  it("skips appending when the content is identical to the latest saved version", async () => {
    const subPath = ["apps", "dedupe"]
    const fileName = "note.txt"

    await appendFileHistory(subPath, fileName, "v1", 1000)
    await appendFileHistory(subPath, fileName, "v1", 2000)
    expect((await loadFileHistoryIndex(subPath, fileName)).map((e) => e.timestampMs)).toEqual([
      1000,
    ])

    await appendFileHistory(subPath, fileName, "v2", 3000)
    await appendFileHistory(subPath, fileName, "v1", 4000)
    expect((await loadFileHistoryIndex(subPath, fileName)).map((e) => e.timestampMs)).toEqual([
      4000, 3000, 1000,
    ])
  })
})
