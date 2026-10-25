/**
 * PWA Islands – Textprüfung
 *
 * Beantwortet die eine Frage, die an mehreren Stellen gebraucht wird: ist der
 * Inhalt einer Datei wirklich Text, oder würde eine Umwandlung in Text Daten
 * verlieren?
 *
 * Aufrufer mit unterschiedlichen Folgen:
 * - Der Editor (`src/files.ts`, `isEditableTextFile`) öffnet Binärdaten nicht,
 *   er will nur ein Ja/Nein.
 * - Die Islands-API (`src/api.ts`, `read` mit `ensureText`) wirft einen Fehler,
 *   weil der Aufrufer mit Text rechnet.
 *
 * Beide benutzen dieselbe Prüfung hier -- eine zweite, leicht abweichende
 * Kopie wäre genau die Stelle, an der die beiden Wege irgendwann
 * auseinanderlaufen.
 */

/** Ergebnis einer Textprüfung. */
export type TextCheck =
  /** Die Datei ist leer (null Bytes). Als Text gelesen ergibt sie "". */
  | { kind: "empty" }
  /** Der Inhalt lässt sich verlustfrei als Text darstellen. */
  | { kind: "text"; text: string }
  /** Mindestens ein Byte käme beim Zurückwandeln verändert an. */
  | { kind: "binary"; reason: string }

/**
 * Prüft per Rundlauf, ob sich die Bytes verlustfrei als UTF-8-Text darstellen
 * lassen: dekodieren, wieder kodieren, Byte für Byte vergleichen.
 *
 * `fatal: true` -- ungültige Sequenzen werfen, statt sie durch U+FFFD zu
 * ersetzen. Das ist die erste und häufigste Ablehnung.
 *
 * `ignoreBOM: true` -- das führende BOM bleibt Teil des dekodierten Textes und
 * wird damit auch wieder mitgeschrieben. Ohne das Flag verschwände es beim
 * erneuten Kodieren, und jede UTF-8-Datei mit BOM gälte als Binärdaten.
 *
 * Der anschließende Byte-Vergleich fängt den Rest: eine Datei kann zufällig
 * gültiges UTF-8 sein und trotzdem bei der Umwandlung etwas anderes ergeben.
 * Ein Blick auf "enthält U+FFFD?" würde dafür nicht genügen -- ein echter Text
 * darf dieses Zeichen enthalten.
 */
export function checkTextBytes(bytes: Uint8Array): TextCheck {
  if (bytes.byteLength === 0) {
    return { kind: "empty" }
  }

  const decoded = decodeUtf8Strict(bytes)
  if (decoded === null) {
    // `fatal: true` wirft bei ungültigem UTF-8 -- genau der Binärfall.
    return { kind: "binary", reason: "ungültiges UTF-8" }
  }
  const text = decoded

  const roundTrip = new TextEncoder().encode(text)
  if (roundTrip.length !== bytes.length) {
    return {
      kind: "binary",
      reason: `${bytes.length} Bytes gelesen, ${roundTrip.length} Bytes beim Zurückschreiben`,
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

/** Prüft einen Blob; liest ihn dafür einmal vollständig in den Speicher. */
export async function checkTextBlob(blob: Blob): Promise<TextCheck> {
  return checkTextBytes(new Uint8Array(await blob.arrayBuffer()))
}

/**
 * Liest einen Blob als Text und wirft, wenn er keiner ist.
 *
 * `empty` gilt als Text: eine leere Datei ist ein gültiger leerer Text, kein
 * Binärfall.
 */
export async function readTextOrThrow(blob: Blob, path: string): Promise<string> {
  const result = await checkTextBlob(blob)
  if (result.kind === "binary") {
    throw new Error(`Datei ist kein gültiger UTF-8-Text: ${result.reason} (${path}).`)
  }
  return result.kind === "text" ? result.text : ""
}

/** Dekodiert strikt als UTF-8; liefert null bei ungültigen Sequenzen. */
function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Ein Byte als zweistelliger Hex-Wert, z. B. `0x8f`. */
function toHex(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0")}`
}
