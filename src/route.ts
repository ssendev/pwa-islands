import { Array, Option, Schema, pipe } from "effect"
import { defineRouteUnion } from "foldkit/route"
import { defineTaggedUnion } from "foldkit/schema"
import type { Url } from "foldkit/url"

// SCHEMAS & TYPES

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

export const HelpTopic = Schema.Literals(["api", "fs"])
export type HelpTopic = typeof HelpTopic.Type

export const NewTarget = Schema.Literals(["file", "folder"])
export type NewTarget = typeof NewTarget.Type

export const AlertVariant = Schema.Literals(["info", "warning", "danger"])
export type AlertVariant = typeof AlertVariant.Type

export const AlertBanner = Schema.Struct({
  message: Schema.String,
  variant: AlertVariant,
})
export type AlertBanner = typeof AlertBanner.Type

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

// PURE ROUTE & FORMATTING FUNCTIONS

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
    return Option.some({ maybeTopic: Option.some("api" as const) })
  }
  if (normalized === "help-fs" || normalized === "hilfe-fs") {
    return Option.some({ maybeTopic: Option.some("fs" as const) })
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
