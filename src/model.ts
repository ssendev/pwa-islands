import { Array, Option, Schema, pipe } from "effect"
import { defineRouteUnion } from "foldkit/route"
import { defineTaggedUnion } from "foldkit/schema"
import type { Url } from "foldkit/url"
import { OPFS_APP_FOLDER } from "./storage"
export { OPFS_APP_FOLDER } from "./storage"

// MODEL

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

export const FileInspection = defineTaggedUnion({
  EditableText: {
    size: Schema.Number,
    text: Schema.String,
  },
  Binary: {
    size: Schema.Number,
  },
})
export type FileInspection = typeof FileInspection.Type

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

// 1. State of the INACTIVE backend (in background memory, no subPath/entries needed)
export const SavedBackend = defineTaggedUnion({
  Unsupported: {},
  NoFolderSelected: {},
  PermissionRequired: {
    folderName: Schema.String,
  },
  Granted: {
    rootName: Schema.String,
  },
})
export type SavedBackend = typeof SavedBackend.Type

// 2. Main Storage State
export const StorageState = defineTaggedUnion({
  Initializing: {},
  Unsupported: {},

  NoFolderSelected: {
    storageType: StorageType,
    otherBackend: SavedBackend, // Remembers the other backend's state!
  },

  PermissionRequired: {
    storageType: StorageType,
    folderName: Schema.String,
    otherBackend: SavedBackend,
  },

  Ready: {
    storageType: StorageType,
    rootName: Schema.String,
    subPath: Schema.Array(Schema.String),
    entriesState: EntriesState,
    otherBackend: SavedBackend,
  },
})
export type StorageState = typeof StorageState.Type

export const currentSubPathFromStorageState = (storageState: StorageState): ReadonlyArray<string> =>
  StorageState.match(storageState, {
    Initializing: () => [],
    Unsupported: () => [],
    NoFolderSelected: () => [],
    PermissionRequired: () => [],
    Ready: ({ subPath }) => subPath,
  })

export const PreviewContent = defineTaggedUnion({
  None: {},
  Image: {
    objectUrl: Schema.String,
  },
  Pdf: {
    objectUrl: Schema.String,
  },
})
export type PreviewContent = typeof PreviewContent.Type

export const BinaryEdit = defineTaggedUnion({
  Locked: {
    reason: Schema.String,
  },
  Disabled: {},
  Loading: {},
  Editing: {
    content: Schema.String,
  },
})
export type BinaryEdit = typeof BinaryEdit.Type

export const EditorFileMode = defineTaggedUnion({
  Text: {
    content: Schema.String,
  },
  Binary: {
    preview: PreviewContent,
    edit: BinaryEdit,
  },
})
export type EditorFileMode = typeof EditorFileMode.Type

export const HelpTopic = Schema.Literals(["api", "fs"])
export type HelpTopic = typeof HelpTopic.Type

export const NewTarget = Schema.Literals(["file", "folder"])
export type NewTarget = typeof NewTarget.Type

export const CopyDtsState = defineTaggedUnion({
  Idle: {},
  Copying: {},
  Copied: {},
  Error: {
    message: Schema.String,
  },
})
export type CopyDtsState = typeof CopyDtsState.Type

export const InstallPrompt = defineTaggedUnion({
  Unavailable: {},
  Available: {},
  Prompting: {},
})
export type InstallPrompt = typeof InstallPrompt.Type

export const PendingImportFile = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  lastModified: Schema.Number,
})
export type PendingImportFile = typeof PendingImportFile.Type

export const ImportCollisionAction = Schema.Literals(["replace", "rename", "skip"])
export type ImportCollisionAction = typeof ImportCollisionAction.Type

export const ResolvedImportItem = Schema.Struct({
  sourceName: Schema.String,
  targetName: Schema.String,
  action: ImportCollisionAction,
})
export type ResolvedImportItem = typeof ResolvedImportItem.Type

export const OverwriteSource = defineTaggedUnion({
  CreateFile: {
    content: Schema.String,
  },
  EditFile: {
    originalName: Schema.String,
    fileMode: EditorFileMode,
  },
})
export type OverwriteSource = typeof OverwriteSource.Type

export const ModalState = defineTaggedUnion({
  Closed: {},
  CreateFile: {
    name: Schema.String,
    content: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
  },
  CreateFolder: {
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
  },
  EditFolder: {
    originalName: Schema.String,
    name: Schema.String,
    maybeValidationError: Schema.Option(Schema.String),
  },
  EditFile: {
    originalName: Schema.String,
    name: Schema.String,
    fileMode: EditorFileMode,
    maybeValidationError: Schema.Option(Schema.String),
  },
  ConfirmDelete: {
    entryName: Schema.String,
    entryKind: FileEntryKind,
  },
  ConfirmOverwrite: {
    targetName: Schema.String,
    source: OverwriteSource,
  },
  ImportConflict: {
    current: PendingImportFile,
    suggestedName: Schema.String,
    queue: Schema.Array(PendingImportFile),
    resolved: Schema.Array(ResolvedImportItem),
    applyToAll: Schema.Boolean,
  },
  Help: {
    maybeOpenTopic: Schema.Option(HelpTopic),
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

export const Flags = Schema.Struct({
  hasDirectoryPicker: Schema.Boolean,
  hasOPFS: Schema.Boolean,
  origin: Schema.String,
})
export type Flags = typeof Flags.Type

export const AppRoute = defineRouteUnion({
  Folder: {
    subPath: Schema.Array(Schema.String),
  },
  New: {
    subPath: Schema.Array(Schema.String),
    target: NewTarget,
  },
  Edit: {
    subPath: Schema.Array(Schema.String),
    name: Schema.String,
  },
  Help: {
    subPath: Schema.Array(Schema.String),
    maybeTopic: Schema.Option(HelpTopic),
  },
})
export type AppRoute = typeof AppRoute.Type

export const Model = Schema.Struct({
  hasDirectoryPicker: Schema.Boolean,
  hasOPFS: Schema.Boolean,
  origin: Schema.String,
  storageState: StorageState,
  showFileInfo: Schema.Boolean,
  isSettingsOpen: Schema.Boolean,
  installPrompt: InstallPrompt,
  modalState: ModalState,
  maybeAlertBanner: Schema.Option(AlertBanner),
})
export type Model = typeof Model.Type

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
  const parts: ReadonlyArray<string> = [
    ...(fileCount > 0 ? [`${fileCount} ${fileCount === 1 ? "Datei" : "Dateien"}`] : []),
    ...(dirCount > 0 ? [`${dirCount} ${dirCount === 1 ? "Ordner" : "Ordner"}`] : []),
  ]
  return Array.join(parts, ", ")
}

export const encodeSubPath = (segments: ReadonlyArray<string>): string =>
  pipe(segments, Array.map(encodeURIComponent), Array.join("/"))

export const buildFolderUrl = (subPath: ReadonlyArray<string>): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  return `${pathPart}?pwaislands`
}

export const buildNewUrl = (subPath: ReadonlyArray<string>, target: NewTarget): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  return `${pathPart}?pwaislands=${target === "folder" ? "new-folder" : "new"}`
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
  maybeRaw: Option.Option<string>,
): Option.Option<{ readonly maybeTopic: Option.Option<HelpTopic> }> =>
  Option.flatMap(maybeRaw, parseHelpValue)

const parseHelpValue = (
  raw: string,
): Option.Option<{ readonly maybeTopic: Option.Option<HelpTopic> }> => {
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

export const parseNewActionParam = (
  maybeRaw: Option.Option<string>,
): Option.Option<{ readonly target: NewTarget }> => Option.flatMap(maybeRaw, parseNewActionValue)

const parseNewActionValue = (raw: string): Option.Option<{ readonly target: NewTarget }> => {
  const normalized = raw.trim().toLowerCase()
  if (normalized === "new" || normalized === "neu" || normalized === "new-file") {
    return Option.some({ target: "file" as const })
  }
  if (normalized === "new-folder" || normalized === "neuer-ordner") {
    return Option.some({ target: "folder" as const })
  }
  return Option.none()
}

export const decodeUrlPathnameSegments = (pathname: string): ReadonlyArray<string> =>
  pipe(
    pathname.split("/"),
    Array.filter((segment) => segment !== ""),
    Array.map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    }),
  )

export const parseUrlToRoute = (url: Url): AppRoute => {
  const segments = decodeUrlPathnameSegments(url.pathname)
  const searchStr = Option.getOrElse(url.search, () => "")
  const searchParams = new URLSearchParams(searchStr.startsWith("?") ? searchStr : `?${searchStr}`)
  const maybePwaislandsParam = Option.fromNullishOr(searchParams.get("pwaislands"))

  const maybeHelp = parseHelpParam(maybePwaislandsParam)
  if (Option.isSome(maybeHelp)) {
    return AppRoute.Help({
      subPath: segments,
      maybeTopic: maybeHelp.value.maybeTopic,
    })
  }

  const maybeNew = parseNewActionParam(maybePwaislandsParam)
  if (Option.isSome(maybeNew)) {
    return AppRoute.New({
      subPath: segments,
      target: maybeNew.value.target,
    })
  }

  if (isEditActionParam(maybePwaislandsParam)) {
    if (Array.isReadonlyArrayNonEmpty(segments)) {
      const name = Array.lastNonEmpty(segments)
      const subPath = Array.dropRight(segments, 1)
      return AppRoute.Edit({ subPath, name })
    }
  }

  return AppRoute.Folder({ subPath: segments })
}

export const isEditActionParam = (maybeRaw: Option.Option<string>): boolean =>
  Option.exists(maybeRaw, isEditActionValue)

const isEditActionValue = (raw: string): boolean => {
  const normalized = raw.trim().toLowerCase()
  return (
    normalized === "edit" ||
    normalized === "e" ||
    normalized === "bearbeiten" ||
    normalized === "true"
  )
}

export const computeDocumentTitle = (model: Model): string => {
  const subPath = currentSubPathFromStorageState(model.storageState)
  const folderParts = [...Array.reverse(subPath), APP_TITLE]
  const folderTitle = Array.join(folderParts, " — ")

  return ModalState.match(model.modalState, {
    Closed: () => folderTitle,
    CreateFile: () => `Neue Datei — ${folderTitle}`,
    CreateFolder: () => `Neuer Ordner — ${folderTitle}`,
    EditFolder: ({ originalName }) => `${originalName} bearbeiten — ${folderTitle}`,
    EditFile: ({ originalName }) => `${originalName} bearbeiten — ${folderTitle}`,
    ConfirmDelete: ({ entryName }) => `${entryName} löschen — ${folderTitle}`,
    ConfirmOverwrite: ({ targetName }) => `${targetName} überschreiben — ${folderTitle}`,
    ImportConflict: () => `Import-Konflikt — ${folderTitle}`,
    Help: ({ maybeOpenTopic }) =>
      Option.match(maybeOpenTopic, {
        onNone: () => `Hilfe — ${folderTitle}`,
        onSome: (topic) => `${HELP_TOPIC_TITLES[topic]} — Hilfe — ${folderTitle}`,
      }),
  })
}
