import { Array, Option, Schema, pipe } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { OPFS_APP_FOLDER } from "./storage"

// ---------------------------------------------------------------------------
// Storage & File Entry Schemas
// ---------------------------------------------------------------------------

export const StorageType = Schema.Literals(["fsa", "opfs"])
export type StorageType = typeof StorageType.Type

export const FileEntryKind = Schema.Literals(["file", "directory"])
export type FileEntryKind = typeof FileEntryKind.Type

export const FileEntry = Schema.Struct({
  name: Schema.String,
  kind: FileEntryKind,
  maybeSize: Schema.Option(Schema.Number),
  maybeLastModified: Schema.Option(Schema.Number),
})
export type FileEntry = typeof FileEntry.Type

export const EntriesState = defineTaggedUnion({
  Loading: {},
  Loaded: {
    entries: Schema.Array(FileEntry),
  },
  Error: {
    message: Schema.String,
  },
})
export type EntriesState = typeof EntriesState.Type

export const StorageState = defineTaggedUnion({
  Initializing: {},
  Unsupported: {},
  NoFolderSelected: {},
  PermissionRequired: {
    folderName: Schema.String,
  },
  Ready: {
    storageType: StorageType,
    rootName: Schema.String,
    subPath: Schema.Array(Schema.String),
    isFallback: Schema.Boolean,
    entriesState: EntriesState,
  },
})
export type StorageState = typeof StorageState.Type

// ---------------------------------------------------------------------------
// Modal & Toast Schemas
// ---------------------------------------------------------------------------

export const PreviewContent = defineTaggedUnion({
  None: {},
  Image: {
    objectUrl: Schema.String,
    name: Schema.String,
  },
  Pdf: {
    objectUrl: Schema.String,
  },
})
export type PreviewContent = typeof PreviewContent.Type

export const EditorFileMode = defineTaggedUnion({
  Text: {
    content: Schema.String,
  },
  Binary: {
    lockReason: Schema.String,
    canEditBase64: Schema.Boolean,
    isBase64Enabled: Schema.Boolean,
    base64Content: Schema.String,
    isLoadingBase64: Schema.Boolean,
    preview: PreviewContent,
  },
})
export type EditorFileMode = typeof EditorFileMode.Type

export const HelpTopic = Schema.Literals(["api", "fs"])
export type HelpTopic = typeof HelpTopic.Type

export const CopyDtsState = defineTaggedUnion({
  Idle: {},
  Copying: {},
  Copied: {},
  Error: {
    message: Schema.String,
  },
})
export type CopyDtsState = typeof CopyDtsState.Type

export const ModalState = defineTaggedUnion({
  Closed: {},
  CreateFile: {
    name: Schema.String,
    content: Schema.String,
  },
  CreateFolder: {
    name: Schema.String,
  },
  EditFolder: {
    originalName: Schema.String,
    name: Schema.String,
  },
  EditFile: {
    originalName: Schema.String,
    name: Schema.String,
    fileMode: EditorFileMode,
  },
  Help: {
    isApiOpen: Schema.Boolean,
    isFsOpen: Schema.Boolean,
    copyDtsState: CopyDtsState,
  },
})
export type ModalState = typeof ModalState.Type

export const AlertVariant = Schema.Literals(["info", "warning", "danger"])
export type AlertVariant = typeof AlertVariant.Type

export const AlertBanner = Schema.Struct({
  message: Schema.String,
  variant: AlertVariant,
})
export type AlertBanner = typeof AlertBanner.Type

// ---------------------------------------------------------------------------
// Flags & Model
// ---------------------------------------------------------------------------

export const Flags = Schema.Struct({
  hasDirectoryPicker: Schema.Boolean,
  hasOPFS: Schema.Boolean,
  initialPathname: Schema.String,
  initialSearch: Schema.String,
})
export type Flags = typeof Flags.Type

export const Model = Schema.Struct({
  hasDirectoryPicker: Schema.Boolean,
  hasOPFS: Schema.Boolean,
  storageState: StorageState,
  showFileInfo: Schema.Boolean,
  isSettingsOpen: Schema.Boolean,
  canInstallApp: Schema.Boolean,
  modalState: ModalState,
  maybeAlertBanner: Schema.Option(AlertBanner),
})
export type Model = typeof Model.Type

// ---------------------------------------------------------------------------
// Pure Helpers (Formatting, URL, Title)
// ---------------------------------------------------------------------------

const APP_TITLE = OPFS_APP_FOLDER

const HELP_TOPIC_TITLES: Readonly<Record<HelpTopic, string>> = {
  api: "PWA Islands bauen",
  fs: "Speicher: FS API und OPFS",
}

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const formatDate = (timestamp: number): string => {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)
}

export const formatSummaryText = (entries: ReadonlyArray<FileEntry>): string => {
  const fileCount = pipe(
    entries,
    Array.filter((entry) => entry.kind === "file"),
    Array.length,
  )
  const dirCount = pipe(
    entries,
    Array.filter((entry) => entry.kind === "directory"),
    Array.length,
  )
  const parts: Array<string> = []
  if (fileCount > 0) {
    parts.push(`${fileCount} ${fileCount === 1 ? "Datei" : "Dateien"}`)
  }
  if (dirCount > 0) {
    parts.push(`${dirCount} ${dirCount === 1 ? "Ordner" : "Ordner"}`)
  }
  return Array.join(parts, ", ")
}

export const encodeSubPath = (segments: ReadonlyArray<string>): string =>
  pipe(segments, Array.map(encodeURIComponent), Array.join("/"))

export const buildFolderUrl = (subPath: ReadonlyArray<string>): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  return `${pathPart}?pwaislands`
}

export const buildEditUrl = (subPath: ReadonlyArray<string>, entryName: string): string => {
  const encoded = encodeSubPath([...subPath, entryName])
  return `/${encoded}?pwaislands=edit`
}

export const buildHelpUrl = (
  subPath: ReadonlyArray<string>,
  maybeTopic: Option.Option<HelpTopic>,
): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  return Option.match(maybeTopic, {
    onNone: () => `${pathPart}?pwaislands=help`,
    onSome: (topic) => `${pathPart}?pwaislands=help-${topic}`,
  })
}

export const parseHelpParam = (
  raw: string | null,
): Option.Option<{ readonly maybeTopic: Option.Option<HelpTopic> }> => {
  if (raw === null) {
    return Option.none()
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === "help" || normalized === "h" || normalized === "hilfe") {
    return Option.some({ maybeTopic: Option.none() })
  }
  if (normalized === "help-api" || normalized === "hilfe-api") {
    return Option.some({ maybeTopic: Option.some("api") })
  }
  if (normalized === "help-fs" || normalized === "hilfe-fs") {
    return Option.some({ maybeTopic: Option.some("fs") })
  }
  return Option.none()
}

export const isEditActionParam = (raw: string | null): boolean => {
  if (raw === null) {
    return false
  }
  const normalized = raw.trim().toLowerCase()
  return (
    normalized === "edit" ||
    normalized === "e" ||
    normalized === "bearbeiten" ||
    normalized === "true"
  )
}

export const computeDocumentTitle = (model: Model): string => {
  const subPath: ReadonlyArray<string> = StorageState.match(model.storageState, {
    Initializing: () => [],
    Unsupported: () => [],
    NoFolderSelected: () => [],
    PermissionRequired: () => [],
    Ready: ({ subPath: readySubPath }) => readySubPath,
  })

  const folderParts = [...Array.reverse(subPath), APP_TITLE]
  const folderTitle = Array.join(folderParts, " — ")

  return ModalState.match(model.modalState, {
    Closed: () => folderTitle,
    CreateFile: () => `Neue Datei — ${folderTitle}`,
    CreateFolder: () => `Neuer Ordner — ${folderTitle}`,
    EditFolder: ({ originalName }) => `${originalName} bearbeiten — ${folderTitle}`,
    EditFile: ({ originalName }) => `${originalName} bearbeiten — ${folderTitle}`,
    Help: ({ isApiOpen, isFsOpen }) => {
      if (isApiOpen && !isFsOpen) {
        return `${HELP_TOPIC_TITLES.api} — Hilfe — ${folderTitle}`
      }
      if (isFsOpen && !isApiOpen) {
        return `${HELP_TOPIC_TITLES.fs} — Hilfe — ${folderTitle}`
      }
      return `Hilfe — ${folderTitle}`
    },
  })
}
