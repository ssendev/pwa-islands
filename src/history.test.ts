import { invoke } from "@tauri-apps/api/core"
import { Option } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  appendFileHistory,
  clearFileHistory,
  encodeHistoryRecord,
  hashHistoryContent,
  loadFileHistoryEntryAt,
  loadFileHistoryIndex,
  loadPreviousFileHistoryEntry,
  readAllHistoryMeta,
  readHistoryRecordAt,
  truncateLatestFileHistoryEntry,
  type SliceReader,
} from "./history"

const tauriFiles = new Map<string, Uint8Array>()

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
    if (cmd === "tauri_history_read_index") {
      const bytes = tauriFiles.get(key) ?? new Uint8Array(0)
      return readAllHistoryMeta(makeSliceReader(bytes), bytes.byteLength)
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
  })
})
