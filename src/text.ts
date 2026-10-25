export type TextCheck =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "binary"; reason: string }

// NOTE: fatal: true throws on invalid UTF-8; ignoreBOM: true preserves BOM across roundtrip
export function checkTextBytes(bytes: Uint8Array): TextCheck {
  if (bytes.byteLength === 0) {
    return { kind: "empty" }
  }

  const decoded = decodeUtf8Strict(bytes)
  if (Option.isNone(decoded)) {
    return { kind: "binary", reason: "ungültiges UTF-8" }
  }
  const text = decoded.value

  const roundTrip = new TextEncoder().encode(text)
  if (roundTrip.byteLength !== bytes.byteLength) {
    return {
      kind: "binary",
      reason: `${bytes.byteLength} Bytes gelesen, ${roundTrip.byteLength} Bytes beim Zurückschreiben`,
    }
  }

  const firstMismatch = bytes.findIndex((found, index) => found !== roundTrip[index])
  if (firstMismatch !== -1) {
    return {
      kind: "binary",
      reason: `Abweichung an Byte ${firstMismatch} (gelesen ${toHex(bytes[firstMismatch])}, zurückgeschrieben ${toHex(roundTrip[firstMismatch])})`,
    }
  }

  return { kind: "text", text }
}

export async function checkTextBlob(blob: Blob): Promise<TextCheck> {
  return checkTextBytes(new Uint8Array(await blob.arrayBuffer()))
}

export async function readTextOrThrow(blob: Blob, path: string): Promise<string> {
  const result = await checkTextBlob(blob)
  if (result.kind === "binary") {
    throw new Error(`Datei ist kein gültiger UTF-8-Text: ${result.reason} (${path}).`)
  }
  return result.kind === "text" ? result.text : ""
}

function decodeUtf8Strict(bytes: Uint8Array): Option.Option<string> {
  try {
    return Option.some(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return Option.none()
  }
}

function toHex(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0")}`
}
import { Option } from "effect"
