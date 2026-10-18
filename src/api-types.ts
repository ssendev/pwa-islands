export interface IslandEntry {
  /** Name des Eintrags ohne übergeordneten Pfad. */
  name: string
  /** Pfad relativ zur ausgewählten Wurzel, z. B. "notizen/ideen.md". */
  path: string
  /** Art des Eintrags. */
  kind: 'file' | 'directory'
  /** Dateigröße in Bytes (nur bei kind === 'file'). */
  size?: number
  /** Zeitpunkt der letzten Änderung als Unix-Timestamp (nur bei kind === 'file'). */
  lastModified?: number
}

export type IslandInput = string | Blob | Uint8Array | ArrayBuffer

export interface WriteOptions {
  /**
   * Vorhandene Datei überschreiben. Standard: false.
   * Bei false wird ein Fehler geworfen, wenn die Datei bereits existiert,
   * und die bestehende Datei bleibt unverändert.
   */
  overwrite?: boolean
}

export interface RemoveOptions {
  /**
   * Ordner samt Inhalt löschen. Standard: false.
   * Bei false wird ein Fehler geworfen, wenn der Ordner nicht leer ist.
   * Für Dateien ohne Wirkung.
   */
  recursive?: boolean
}

export interface IslandsApi {
  /** Listet den Inhalt eines Verzeichnisses auf (Standard: Wurzel). Sortiert: Ordner zuerst, dann alphabetisch. */
  list(path?: string): Promise<IslandEntry[]>

  /** Liest den Inhalt einer Datei als Text. */
  read(path: string): Promise<string>

  /** Liest den Inhalt einer Datei als Blob (für Binärdaten, Bilder, Downloads …). */
  readBlob(path: string): Promise<Blob>

  /** Prüft, ob ein Eintrag existiert. */
  exists(path: string): Promise<boolean>

  /** Schreibt eine Datei (erzeugt sie bei Bedarf; überschreibt nur mit overwrite: true). Fehlende Elternordner werden angelegt. */
  write(path: string, content: IslandInput, options?: WriteOptions): Promise<void>

  /** Erstellt einen Ordner (verschachtelt erlaubt). */
  makeDir(path: string): Promise<void>

  /** Benennt einen Eintrag um bzw. verschiebt ihn innerhalb der Wurzel. */
  rename(from: string, to: string): Promise<void>

  /** Löscht eine Datei oder einen Ordner (rekursiv nur mit recursive: true). */
  remove(path: string, options?: RemoveOptions): Promise<void>

  /** Kopiert einen Eintrag an einen neuen Ort innerhalb der Wurzel. */
  copy(from: string, to: string): Promise<void>
}