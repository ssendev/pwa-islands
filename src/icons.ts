import type * as Html from "foldkit/html"

import iconArchive from "@fluentui-emoji/svg/icons/modern/card-file-box.svg"
import iconAudio from "@fluentui-emoji/svg/icons/modern/musical-note.svg"
import iconCheck from "@fluentui-emoji/svg/icons/modern/check-mark.svg"
import iconClipboard from "@fluentui-emoji/svg/icons/modern/clipboard.svg"
import iconClose from "@fluentui-emoji/svg/icons/modern/multiply.svg"
import iconCode from "@fluentui-emoji/svg/icons/modern/laptop.svg"
import iconConfig from "@fluentui-emoji/svg/icons/modern/wrench.svg"
import iconCross from "@fluentui-emoji/svg/icons/modern/cross-mark.svg"
import iconCss from "@fluentui-emoji/svg/icons/modern/artist-palette.svg"
import iconCsv from "@fluentui-emoji/svg/icons/modern/bar-chart.svg"
import iconEdit from "@fluentui-emoji/svg/icons/modern/pencil.svg"
import iconFile from "@fluentui-emoji/svg/icons/modern/page-facing-up.svg"
import iconFolder from "@fluentui-emoji/svg/icons/modern/file-folder.svg"
import iconFolderOpen from "@fluentui-emoji/svg/icons/modern/open-file-folder.svg"
import iconFont from "@fluentui-emoji/svg/icons/modern/input-latin-letters.svg"
import iconHelp from "@fluentui-emoji/svg/icons/modern/red-question-mark.svg"
import iconHtml from "@fluentui-emoji/svg/icons/modern/globe-with-meridians.svg"
import iconImage from "@fluentui-emoji/svg/icons/modern/framed-picture.svg"
import iconInfo from "@fluentui-emoji/svg/icons/modern/information.svg"
import iconInstall from "@fluentui-emoji/svg/icons/modern/inbox-tray.svg"
import iconLock from "@fluentui-emoji/svg/icons/modern/locked.svg"
import iconPackage from "@fluentui-emoji/svg/icons/modern/package.svg"
import iconPdf from "@fluentui-emoji/svg/icons/modern/closed-book.svg"
import iconPlug from "@fluentui-emoji/svg/icons/modern/electric-plug.svg"
import iconPlus from "@fluentui-emoji/svg/icons/modern/plus.svg"
import iconPuzzle from "@fluentui-emoji/svg/icons/modern/puzzle-piece.svg"
import iconSave from "@fluentui-emoji/svg/icons/modern/floppy-disk.svg"
import iconSettings from "@fluentui-emoji/svg/icons/modern/gear.svg"
import iconText from "@fluentui-emoji/svg/icons/modern/memo.svg"
import iconTrash from "@fluentui-emoji/svg/icons/modern/wastebasket.svg"
import iconUpload from "@fluentui-emoji/svg/icons/modern/outbox-tray.svg"
import iconVideo from "@fluentui-emoji/svg/icons/modern/clapper-board.svg"
import iconWarning from "@fluentui-emoji/svg/icons/modern/warning.svg"

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
