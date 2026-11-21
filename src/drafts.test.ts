import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { decodeDraft, encodeDraft, hasDiskChangedSinceBase, type FileDraft } from "./drafts"
import { hashAndMeasureHistoryContent } from "./history"

describe("drafts", () => {
  it("encodes and decodes a valid draft round-trip", () => {
    const base = hashAndMeasureHistoryContent("<h1>Original</h1>")
    const draft: FileDraft = {
      content: "<h1>Edited</h1>",
      baseContentHash: base.contentHash,
      baseByteLength: base.byteLength,
      updatedAtMs: 1700000000000,
    }
    const encoded = encodeDraft(draft)
    const decoded = decodeDraft(encoded)
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isSome(decoded)) {
      expect(decoded.value).toEqual(draft)
    }
  })

  it("returns None for invalid or incomplete JSON", () => {
    expect(Option.isNone(decodeDraft("not json"))).toBe(true)
    expect(Option.isNone(decodeDraft("{}"))).toBe(true)
    expect(
      Option.isNone(
        decodeDraft(
          JSON.stringify({
            content: "abc",
            baseContentHash: "wrong",
            baseByteLength: 3,
            updatedAtMs: 1,
          }),
        ),
      ),
    ).toBe(true)
  })

  it("detects when disk content has changed since the draft base", () => {
    const original = "<p>Hello Welt 🌍</p>"
    const base = hashAndMeasureHistoryContent(original)
    expect(hasDiskChangedSinceBase(original, base.contentHash, base.byteLength)).toBe(false)
    expect(
      hasDiskChangedSinceBase("<p>Changed externally</p>", base.contentHash, base.byteLength),
    ).toBe(true)
  })
})
