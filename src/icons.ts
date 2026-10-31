import type * as Html from "foldkit/html"

import iconArchive from "./emoji/🗃️.svg"
import iconAudio from "./emoji/🎵.svg"
import iconCheck from "./emoji/✅.svg"
import iconClipboard from "./emoji/📋.svg"
import iconClose from "./emoji/✖️.svg"
import iconConfig from "./emoji/🔧.svg"
import iconCross from "./emoji/❌.svg"
import iconCss from "./emoji/🎨.svg"
import iconCsv from "./emoji/📊.svg"
import iconDesktop from "./emoji/💻.svg"
import iconEdit from "./emoji/✏️.svg"
import iconFile from "./emoji/📄.svg"
import iconFolder from "./emoji/📁.svg"
import iconFolderOpen from "./emoji/📂.svg"
import iconFont from "./emoji/🔤.svg"
import iconHelp from "./emoji/❓.svg"
import iconHtml from "./emoji/🌐.svg"
import iconImage from "./emoji/🖼️.svg"
import iconInfo from "./emoji/ℹ️.svg"
import iconInstall from "./emoji/📥.svg"
import iconLock from "./emoji/🔒.svg"
import iconPackage from "./emoji/📦.svg"
import iconPdf from "./emoji/📕.svg"
import iconPlug from "./emoji/🔌.svg"
import iconPlus from "./emoji/➕.svg"
import iconPuzzle from "./emoji/🧩.svg"
import iconSave from "./emoji/💾.svg"
import iconScroll from "./emoji/📜.svg"
import iconSettings from "./emoji/⚙️.svg"
import iconText from "./emoji/📝.svg"
import iconTrash from "./emoji/🗑️.svg"
import iconUpload from "./emoji/📤.svg"
import iconVideo from "./emoji/🎬.svg"
import iconWarning from "./emoji/⚠️.svg"

export const ICONS = {
  folder: iconFolder,
  "folder-open": iconFolderOpen,
  file: iconFile,
  "file-image": iconImage,
  "file-pdf": iconPdf,
  "file-html": iconHtml,
  "file-code": iconScroll,
  "file-css": iconCss,
  "file-config": iconConfig,
  "file-text": iconText,
  "file-csv": iconCsv,
  desktop: iconDesktop,
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
} as const

export type IconId = keyof typeof ICONS

export const iconSrc = (id: IconId): string => ICONS[id]

export const iconHref = (id: IconId): string => iconSrc(id)

export const viewIcon = <Message>(id: IconId, h: Html.HtmlBuilder<Message>): Html.Html =>
  h.img([h.Class("svg-icon"), h.Src(iconSrc(id)), h.Alt(""), h.AriaHidden(true)])
