import type * as Html from "foldkit/html"
import iconsUrl from "./assets/icons.svg"

export type IconId =
  | "folder"
  | "folder-open"
  | "file"
  | "file-image"
  | "file-pdf"
  | "file-html"
  | "file-code"
  | "file-css"
  | "file-config"
  | "file-text"
  | "file-csv"
  | "file-audio"
  | "file-video"
  | "file-archive"
  | "file-font"
  | "settings"
  | "help"
  | "file-info"
  | "package"
  | "plug"
  | "install"
  | "plus"
  | "upload"
  | "edit"
  | "lock"
  | "warning"
  | "save"
  | "trash"
  | "close"
  | "clipboard"
  | "puzzle"
  | "check"
  | "cross"

export const iconHref = (id: IconId): string => `${iconsUrl}#${id}`

export const viewIcon = <Message>(id: IconId, h: Html.HtmlBuilder<Message>): Html.Html =>
  h.svg(
    [h.Class("svg-icon"), h.ViewBox("0 0 24 24"), h.AriaHidden(true)],
    [h.use([h.Attribute("href", iconHref(id))])],
  )
