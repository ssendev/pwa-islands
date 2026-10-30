import type * as Html from "foldkit/html"

import iconArchive from "./assets/noto/file-archive.svg"
import iconAudio from "./assets/noto/file-audio.svg"
import iconCheck from "./assets/noto/check.svg"
import iconClipboard from "./assets/noto/clipboard.svg"
import iconClose from "./assets/noto/close.svg"
import iconCode from "./assets/noto/file-code.svg"
import iconConfig from "./assets/noto/file-config.svg"
import iconCross from "./assets/noto/cross.svg"
import iconCss from "./assets/noto/file-css.svg"
import iconCsv from "./assets/noto/file-csv.svg"
import iconEdit from "./assets/noto/edit.svg"
import iconFile from "./assets/noto/file.svg"
import iconFolder from "./assets/noto/folder.svg"
import iconFolderOpen from "./assets/noto/folder-open.svg"
import iconFont from "./assets/noto/file-font.svg"
import iconHelp from "./assets/noto/help.svg"
import iconHtml from "./assets/noto/file-html.svg"
import iconImage from "./assets/noto/file-image.svg"
import iconInfo from "./assets/noto/file-info.svg"
import iconInstall from "./assets/noto/install.svg"
import iconLock from "./assets/noto/lock.svg"
import iconPackage from "./assets/noto/package.svg"
import iconPdf from "./assets/noto/file-pdf.svg"
import iconPlug from "./assets/noto/plug.svg"
import iconPlus from "./assets/noto/plus.svg"
import iconPuzzle from "./assets/noto/puzzle.svg"
import iconSave from "./assets/noto/save.svg"
import iconSettings from "./assets/noto/settings.svg"
import iconText from "./assets/noto/file-text.svg"
import iconTrash from "./assets/noto/trash.svg"
import iconUpload from "./assets/noto/upload.svg"
import iconVideo from "./assets/noto/file-video.svg"
import iconWarning from "./assets/noto/warning.svg"

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

const ICONS: Record<IconId, string> = {
  folder: iconFolder,
  "folder-open": iconFolderOpen,
  file: iconFile,
  "file-image": iconImage,
  "file-pdf": iconPdf,
  "file-html": iconHtml,
  "file-code": iconCode,
  "file-css": iconCss,
  "file-config": iconConfig,
  "file-text": iconText,
  "file-csv": iconCsv,
  "file-audio": iconAudio,
  "file-video": iconVideo,
  "file-archive": iconArchive,
  "file-font": iconFont,
  settings: iconSettings,
  help: iconHelp,
  "file-info": iconInfo,
  package: iconPackage,
  plug: iconPlug,
  install: iconInstall,
  plus: iconPlus,
  upload: iconUpload,
  edit: iconEdit,
  lock: iconLock,
  warning: iconWarning,
  save: iconSave,
  trash: iconTrash,
  close: iconClose,
  clipboard: iconClipboard,
  puzzle: iconPuzzle,
  check: iconCheck,
  cross: iconCross,
}

export const iconSrc = (id: IconId): string => ICONS[id]

export const iconHref = (id: IconId): string => iconSrc(id)

export const viewIcon = <Message>(id: IconId, h: Html.HtmlBuilder<Message>): Html.Html =>
  h.img([h.Class("svg-icon"), h.Src(iconSrc(id)), h.Alt(""), h.AriaHidden(true)])
