import { Array, Option, Schema, pipe } from "effect"
import { defineRouteUnion } from "foldkit/route"
import type { Url } from "foldkit/url"

// SCHEMAS & TYPES

export const HelpTopic = Schema.Literals(["about", "ai", "api", "fs", "licenses"])
export type HelpTopic = typeof HelpTopic.Type

export const NewTarget = Schema.Literals(["file", "folder"])
export type NewTarget = typeof NewTarget.Type

export const AppRoute = defineRouteUnion({
  Folder: {
    subPath: Schema.Array(Schema.String),
  },
  New: {
    subPath: Schema.Array(Schema.String),
    target: NewTarget,
    isPreview: Schema.Boolean,
  },
  Edit: {
    subPath: Schema.Array(Schema.String),
    name: Schema.String,
    isPreview: Schema.Boolean,
  },
  History: {
    subPath: Schema.Array(Schema.String),
    name: Schema.String,
  },
  Help: {
    subPath: Schema.Array(Schema.String),
    maybeTopic: Schema.Option(HelpTopic),
  },
  Settings: {
    subPath: Schema.Array(Schema.String),
  },
  Downloads: {
    subPath: Schema.Array(Schema.String),
  },
})
export type AppRoute = typeof AppRoute.Type

// PURE ROUTE FUNCTIONS

export const encodeSubPath = (segments: ReadonlyArray<string>): string =>
  pipe(segments, Array.map(encodeURIComponent), Array.join("/"))

export const buildFolderUrl = (subPath: ReadonlyArray<string>): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  return `${pathPart}?pwaislands`
}

export const buildNewUrl = (
  subPath: ReadonlyArray<string>,
  target: NewTarget,
  isPreview = false,
): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  if (target === "folder") {
    return `${pathPart}?pwaislands=new-folder`
  }
  return `${pathPart}?pwaislands=${isPreview ? "new-preview" : "new"}`
}

export const buildEditUrl = (
  subPath: ReadonlyArray<string>,
  entryName: string,
  isPreview = false,
): string => {
  const encoded = encodeSubPath([...subPath, entryName])
  return `/${encoded}?pwaislands=${isPreview ? "edit-preview" : "edit"}`
}

export const buildHistoryUrl = (subPath: ReadonlyArray<string>, entryName: string): string => {
  const encoded = encodeSubPath([...subPath, entryName])
  return `/${encoded}?pwaislands=history`
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

export const buildSettingsUrl = (subPath: ReadonlyArray<string>): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  return `${pathPart}?pwaislands=settings`
}

export const buildDownloadsUrl = (subPath: ReadonlyArray<string>): string => {
  const encoded = encodeSubPath(subPath)
  const pathPart = encoded !== "" ? `/${encoded}` : "/"
  return `${pathPart}?pwaislands=downloads`
}

export const parseHelpParam = (
  maybeRaw: Option.Option<string>,
): Option.Option<{ readonly maybeTopic: Option.Option<HelpTopic> }> =>
  Option.flatMap(maybeRaw, parseHelpValue)

const parseHelpValue = (
  raw: string,
): Option.Option<{ readonly maybeTopic: Option.Option<HelpTopic> }> => {
  if (raw === "help") {
    return Option.some({ maybeTopic: Option.none() })
  }
  if (raw === "help-about") {
    return Option.some({ maybeTopic: Option.some("about" as const) })
  }
  if (raw === "help-ai") {
    return Option.some({ maybeTopic: Option.some("ai" as const) })
  }
  if (raw === "help-api") {
    return Option.some({ maybeTopic: Option.some("api" as const) })
  }
  if (raw === "help-fs") {
    return Option.some({ maybeTopic: Option.some("fs" as const) })
  }
  if (raw === "help-licenses") {
    return Option.some({ maybeTopic: Option.some("licenses" as const) })
  }
  return Option.none()
}

export const parseNewActionParam = (
  maybeRaw: Option.Option<string>,
): Option.Option<{ readonly target: NewTarget; readonly isPreview: boolean }> =>
  Option.flatMap(maybeRaw, parseNewActionValue)

const parseNewActionValue = (
  raw: string,
): Option.Option<{ readonly target: NewTarget; readonly isPreview: boolean }> => {
  if (raw === "new") {
    return Option.some({ target: "file" as const, isPreview: false })
  }
  if (raw === "new-preview") {
    return Option.some({ target: "file" as const, isPreview: true })
  }
  if (raw === "new-folder") {
    return Option.some({ target: "folder" as const, isPreview: false })
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

export interface IslandPathInfo {
  readonly folderSubPath: ReadonlyArray<string>
  readonly fileName: string
}

export const parseIslandPath = (pathname: string): IslandPathInfo => {
  const segments = decodeUrlPathnameSegments(pathname)
  if (Array.isReadonlyArrayNonEmpty(segments)) {
    const last = Array.lastNonEmpty(segments)
    if (last.includes(".")) {
      return {
        folderSubPath: Array.dropRight(segments, 1),
        fileName: last,
      }
    }
    return {
      folderSubPath: segments,
      fileName: "index.html",
    }
  }
  return {
    folderSubPath: [],
    fileName: "index.html",
  }
}

export const parsePathAndSearchToRoute = (pathname: string, search: string): AppRoute => {
  const segments = decodeUrlPathnameSegments(pathname)
  const searchParams = new URLSearchParams(search.startsWith("?") ? search : `?${search}`)
  const maybePwaislandsParam = Option.fromNullishOr(searchParams.get("pwaislands"))

  const maybeHelp = parseHelpParam(maybePwaislandsParam)
  if (Option.isSome(maybeHelp)) {
    return AppRoute.Help({
      subPath: segments,
      maybeTopic: maybeHelp.value.maybeTopic,
    })
  }

  if (isSettingsActionParam(maybePwaislandsParam)) {
    return AppRoute.Settings({ subPath: segments })
  }

  if (isDownloadsActionParam(maybePwaislandsParam)) {
    return AppRoute.Downloads({ subPath: segments })
  }

  const maybeNew = parseNewActionParam(maybePwaislandsParam)
  if (Option.isSome(maybeNew)) {
    return AppRoute.New({
      subPath: segments,
      target: maybeNew.value.target,
      isPreview: maybeNew.value.isPreview,
    })
  }

  const maybeEdit = parseEditActionParam(maybePwaislandsParam)
  if (Option.isSome(maybeEdit)) {
    if (Array.isReadonlyArrayNonEmpty(segments)) {
      const name = Array.lastNonEmpty(segments)
      const subPath = Array.dropRight(segments, 1)
      return AppRoute.Edit({ subPath, name, isPreview: maybeEdit.value.isPreview })
    }
  }

  if (isHistoryActionParam(maybePwaislandsParam)) {
    if (Array.isReadonlyArrayNonEmpty(segments)) {
      const name = Array.lastNonEmpty(segments)
      const subPath = Array.dropRight(segments, 1)
      return AppRoute.History({ subPath, name })
    }
  }

  return AppRoute.Folder({ subPath: segments })
}

export const parseUrlToRoute = (url: Url): AppRoute => {
  const searchStr = Option.getOrElse(url.search, () => "")
  return parsePathAndSearchToRoute(url.pathname, searchStr)
}

export const parseEditActionParam = (
  maybeRaw: Option.Option<string>,
): Option.Option<{ readonly isPreview: boolean }> => Option.flatMap(maybeRaw, parseEditActionValue)

const parseEditActionValue = (raw: string): Option.Option<{ readonly isPreview: boolean }> => {
  if (raw === "edit") {
    return Option.some({ isPreview: false })
  }
  if (raw === "edit-preview") {
    return Option.some({ isPreview: true })
  }
  return Option.none()
}

export const isEditActionParam = (maybeRaw: Option.Option<string>): boolean =>
  Option.isSome(parseEditActionParam(maybeRaw))

export const isHistoryActionParam = (maybeRaw: Option.Option<string>): boolean =>
  Option.exists(maybeRaw, (raw) => raw === "history")

export const isSettingsActionParam = (maybeRaw: Option.Option<string>): boolean =>
  Option.exists(maybeRaw, (raw) => raw === "settings")

export const isDownloadsActionParam = (maybeRaw: Option.Option<string>): boolean =>
  Option.exists(maybeRaw, (raw) => raw === "downloads")
