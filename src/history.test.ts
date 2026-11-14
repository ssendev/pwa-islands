import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  encodeHistoryRecord,
  hashHistoryContent,
  readAllHistoryMeta,
  readHistoryRecordAt,
  type SliceReader,
} from "./history"

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
