export interface IslandEntry {
  /** Entry name without parent path. */
  name: string
  /** Path relative to the selected root, e.g. "notes/ideas.md". */
  path: string
  /** Entry kind. */
  kind: "file" | "directory"
  /** File size in bytes (only when kind === 'file'). */
  size?: number
  /** Last modified timestamp as Unix timestamp (only when kind === 'file'). */
  lastModified?: number
}

export type IslandInput = string | Blob | Uint8Array<ArrayBuffer> | ArrayBuffer

export interface WriteOptions {
  /**
   * Overwrite existing file. Default: false.
   * When false, an error is thrown if the file already exists
   * and the existing file remains unchanged.
   */
  overwrite?: boolean
}

export interface RemoveOptions {
  /**
   * Delete folder including its contents. Default: false.
   * When false, an error is thrown if the folder is not empty.
   * No effect for files.
   */
  recursive?: boolean
}

export interface ReadOptions {
  /**
   * Only read if the file can be losslessly represented as text:
   * round-trip via `TextEncoder`, otherwise an error is thrown.
   * Default: false.
   */
  ensureText?: boolean
}

export interface IslandsApi {
  /** Lists the contents of a directory (default: root). Sorted: folders first, then alphabetically. */
  list(path?: string): Promise<ReadonlyArray<IslandEntry>>

  /** Reads the content of a file as text (with `ensureText: true`, checks that the file is lossless text). */
  read(path: string, options?: ReadOptions): Promise<string>

  /** Reads the content of a file as a Blob (for binary data, images, downloads …). */
  readBlob(path: string): Promise<Blob>

  /** Checks whether an entry exists. */
  exists(path: string): Promise<boolean>

  /** Writes a file (creates it if needed; only overwrites with overwrite: true). Missing parent folders are created. */
  write(path: string, content: IslandInput, options?: WriteOptions): Promise<void>

  /** Creates a folder (nested paths allowed). */
  makeDir(path: string): Promise<void>

  /** Renames or moves an entry within the root. */
  rename(from: string, to: string): Promise<void>

  /** Deletes a file or folder (recursively only with recursive: true). */
  remove(path: string, options?: RemoveOptions): Promise<void>

  /** Copies an entry to a new location within the root. */
  copy(from: string, to: string): Promise<void>
}
