import { Array, Option, pipe } from "effect"
import type * as Html from "foldkit/html"
import { Message } from "./message"
import {
  CopyDtsState,
  EditorFileMode,
  EntriesState,
  type FileEntry,
  type Model,
  ModalState,
  PreviewContent,
  PwaToastState,
  StorageState,
  computeDocumentTitle,
  formatDate,
  formatSize,
  formatSummaryText,
} from "./model"
import { OPFS_APP_FOLDER } from "./storage"
import rootIconUrl from "./assets/pwa-islands.svg"

type HtmlBuilder = Html.HtmlBuilder<Message>

// ---------------------------------------------------------------------------
// File Icons by Extension
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"])
const PDF_EXTENSIONS = new Set(["pdf"])

const FILE_ICON_GROUPS: ReadonlyArray<{
  readonly extensions: ReadonlySet<string>
  readonly icon: string
}> = [
  { extensions: IMAGE_EXTENSIONS, icon: "🖼️" },
  { extensions: PDF_EXTENSIONS, icon: "📕" },
  {
    extensions: new Set(["html", "htm", "xhtml"]),
    icon: "🌐",
  },
  {
    extensions: new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx"]),
    icon: "📜",
  },
  { extensions: new Set(["css"]), icon: "🎨" },
  {
    extensions: new Set(["json", "webmanifest", "yml", "yaml", "toml", "ini", "xml"]),
    icon: "⚙️",
  },
  {
    extensions: new Set(["md", "txt"]),
    icon: "📝",
  },
  {
    extensions: new Set(["csv"]),
    icon: "📊",
  },
  {
    extensions: new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]),
    icon: "🎵",
  },
  {
    extensions: new Set(["mp4", "webm", "mov", "mkv", "avi"]),
    icon: "🎬",
  },
  {
    extensions: new Set(["zip", "gz", "tar", "rar", "7z", "bz2"]),
    icon: "🗜️",
  },
  {
    extensions: new Set(["ttf", "otf", "woff", "woff2"]),
    icon: "🔤",
  },
]

const getExtension = (name: string): string => {
  const dotIndex = name.lastIndexOf(".")
  return dotIndex === -1 || dotIndex === name.length - 1
    ? ""
    : name.slice(dotIndex + 1).toLowerCase()
}

export const fileIconFor = (name: string, isDirectory: boolean): string => {
  if (isDirectory) return "📁"
  const ext = getExtension(name)
  for (const group of FILE_ICON_GROUPS) {
    if (group.extensions.has(ext)) return group.icon
  }
  return "📄"
}

// ---------------------------------------------------------------------------
// Toolbar & Breadcrumbs
// ---------------------------------------------------------------------------

const viewBreadcrumbs = (model: Model, h: HtmlBuilder): Html.Html =>
  StorageState.match(model.storageState, {
    Initializing: () =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfad")],
        [h.span([h.Class("breadcrumb-current")], ["Initialisiere..."])],
      ),

    Unsupported: () =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfad")],
        [h.span([h.Class("breadcrumb-current")], ["Dateisystem-APIs nicht unterstützt"])],
      ),

    NoFolderSelected: () =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfad")],
        [h.span([h.Class("breadcrumb-current")], ["PWA Islands"])],
      ),

    PermissionRequired: () =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfad")],
        [h.span([h.Class("breadcrumb-current")], ["PWA Islands"])],
      ),

    Ready: ({ subPath }) => {
      if (Array.isReadonlyArrayEmpty(subPath)) {
        return h.nav(
          [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfad")],
          [h.span([h.Class("breadcrumb-current"), h.Title("PWA Islands")], ["PWA Islands"])],
        )
      }

      const segmentNodes: Array<Html.Html> = []
      let accumulatedPath = ""
      for (let i = 0; i < subPath.length; i++) {
        const segment = subPath[i]
        accumulatedPath = accumulatedPath ? `${accumulatedPath}/${segment}` : segment
        const isLast = i === subPath.length - 1
        segmentNodes.push(h.span([h.Class("breadcrumb-separator"), h.AriaHidden(true)], ["/"]))
        if (isLast) {
          segmentNodes.push(h.span([h.Class("breadcrumb-current"), h.Title(segment)], [segment]))
        } else {
          segmentNodes.push(
            h.button(
              [
                h.Type("button"),
                h.Class("breadcrumb-item"),
                h.Title(segment),
                h.DataAttribute("segment", accumulatedPath),
                h.OnClick(Message.ClickedBreadcrumbSegment({ index: i })),
              ],
              [segment],
            ),
          )
        }
      }

      return h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfad")],
        [
          h.button(
            [
              h.Type("button"),
              h.Class("breadcrumb-item"),
              h.Title("PWA Islands"),
              h.DataAttribute("segment", ""),
              h.OnClick(Message.ClickedBreadcrumbRoot()),
            ],
            ["PWA Islands"],
          ),
          ...segmentNodes,
        ],
      )
    },
  })

const viewSettingsMenu = (model: Model, h: HtmlBuilder): Html.Html => {
  const isReady = model.storageState._tag === "Ready"
  const currentStorageType =
    model.storageState._tag === "Ready"
      ? Option.some(model.storageState.storageType)
      : Option.none()
  const isFsaReady = model.storageState._tag === "Ready" && model.storageState.storageType === "fsa"
  const canSwitchToOpfs =
    model.hasOPFS &&
    Option.match(currentStorageType, {
      onNone: () => true,
      onSome: (type) => type !== "opfs",
    })
  const canSwitchToFsa =
    model.hasDirectoryPicker &&
    Option.match(currentStorageType, {
      onNone: () => true,
      onSome: (type) => type !== "fsa",
    })

  return h.div(
    [h.Class("settings-menu"), h.Id("settings-menu")],
    [
      h.button(
        [
          h.Type("button"),
          h.Id("btn-settings"),
          h.Class("btn btn-secondary btn-icon"),
          h.Title("Einstellungen"),
          h.AriaLabel("Einstellungen"),
          h.AriaHasPopup("true"),
          h.AriaExpanded(model.isSettingsOpen),
          h.OnClick(Message.ClickedToggleSettings(), {
            propagation: "Stop",
          }),
        ],
        ["⚙️"],
      ),
      h.div(
        [
          h.Id("settings-menu-list"),
          h.Class("settings-menu-list"),
          h.Hidden(!model.isSettingsOpen),
          h.Role("menu"),
        ],
        [
          h.button(
            [
              h.Type("button"),
              h.Id("btn-open-help"),
              h.Class("settings-menu-item"),
              h.Role("menuitem"),
              h.OnClick(Message.ClickedOpenHelp()),
            ],
            ["❓ Hilfe"],
          ),
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-toggle-file-info"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.OnClick(Message.ClickedToggleFileInfo()),
                ],
                [model.showFileInfo ? "🔢 Datei-Infos ausblenden" : "🔢 Datei-Infos einblenden"],
              )
            : h.empty,
          canSwitchToOpfs
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-use-opfs"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.Title("Internen Browser-Speicher (OPFS) verwenden"),
                  h.OnClick(Message.ClickedUseOpfs()),
                ],
                ["📦 Zu App-Speicher wechseln"],
              )
            : h.empty,
          canSwitchToFsa
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-select-folder"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.OnClick(Message.ClickedSelectFolder()),
                ],
                ["📁 Zu lokalem Ordner wechseln"],
              )
            : h.empty,
          isFsaReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-change-folder"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.Title("Anderen Ordner wählen"),
                  h.OnClick(Message.ClickedChangeFolder()),
                ],
                ["📂 Ordner wechseln"],
              )
            : h.empty,
          isFsaReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-disconnect-folder"),
                  h.Class("settings-menu-item is-danger"),
                  h.Role("menuitem"),
                  h.Title("Ordner trennen"),
                  h.OnClick(Message.ClickedDisconnectFolder()),
                ],
                ["🔌 Trennen"],
              )
            : h.empty,
          model.canInstallApp
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-install-app"),
                  h.Class("settings-menu-item"),
                  h.Role("menuitem"),
                  h.Title("PWA Islands als App installieren"),
                  h.OnClick(Message.ClickedInstallApp()),
                ],
                ["📲 App installieren"],
              )
            : h.empty,
        ],
      ),
    ],
  )
}

const viewToolbar = (model: Model, h: HtmlBuilder): Html.Html => {
  const isReady = model.storageState._tag === "Ready"

  return h.div(
    [h.Class("files-toolbar")],
    [
      h.div(
        [h.Class("folder-icon"), h.AriaHidden(true)],
        [h.img([h.Class("breadcrumb-root-icon"), h.Src(rootIconUrl), h.Alt("")])],
      ),
      h.div(
        [h.Id("folder-actions"), h.Class("folder-actions")],
        [
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-new-file"),
                  h.Class("btn btn-primary"),
                  h.Title("Neue Datei erstellen"),
                  h.AriaLabel("Neue Datei erstellen"),
                  h.OnClick(Message.ClickedNewFile()),
                ],
                [
                  h.span(
                    [h.Class("btn-icon-only"), h.AriaHidden(true)],
                    [
                      h.span([h.Class("btn-icon-sub")], ["📄"]),
                      h.span([h.Class("btn-icon-main")], ["➕"]),
                    ],
                  ),
                  h.span([h.Class("btn-label")], ["Datei"]),
                ],
              )
            : h.empty,
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-new-folder"),
                  h.Class("btn btn-primary"),
                  h.Title("Neuen Ordner erstellen"),
                  h.AriaLabel("Neuen Ordner erstellen"),
                  h.OnClick(Message.ClickedNewFolder()),
                ],
                [
                  h.span(
                    [h.Class("btn-icon-only"), h.AriaHidden(true)],
                    [
                      h.span([h.Class("btn-icon-sub")], ["📁"]),
                      h.span([h.Class("btn-icon-main")], ["➕"]),
                    ],
                  ),
                  h.span([h.Class("btn-label")], ["Ordner"]),
                ],
              )
            : h.empty,
          isReady
            ? h.button(
                [
                  h.Type("button"),
                  h.Id("btn-import-file"),
                  h.Class("btn btn-secondary"),
                  h.Title("Externe Dateien hochladen"),
                  h.AriaLabel("Externe Dateien hochladen"),
                  h.OnClick(Message.ClickedImportFiles()),
                ],
                [
                  h.span([h.Class("btn-icon-only"), h.AriaHidden(true)], ["📥"]),
                  h.span([h.Class("btn-label")], ["Hochladen"]),
                ],
              )
            : h.empty,
          viewSettingsMenu(model, h),
        ],
      ),
      h.div([h.Id("folder-status"), h.Class("folder-status-box")], [viewBreadcrumbs(model, h)]),
    ],
  )
}

// ---------------------------------------------------------------------------
// Alert Banner & Main File List Content
// ---------------------------------------------------------------------------

const viewAlertContainer = (model: Model, h: HtmlBuilder): Html.Html =>
  Option.match(model.maybeAlertBanner, {
    onNone: () => h.div([h.Id("files-alert-area"), h.AriaLive("polite")]),
    onSome: (banner) =>
      h.div(
        [h.Id("files-alert-area"), h.AriaLive("polite")],
        [h.div([h.Class(`alert alert-${banner.variant}`)], [banner.message])],
      ),
  })

const viewEntryRow = (entry: FileEntry, showFileInfo: boolean, h: HtmlBuilder): Html.Html => {
  const isDir = entry.kind === "directory"
  const icon = fileIconFor(entry.name, isDir)
  const sizeDisplay = isDir
    ? "—"
    : Option.match(entry.maybeSize, {
        onNone: () => "—",
        onSome: formatSize,
      })
  const dateDisplay = isDir
    ? "—"
    : Option.match(entry.maybeLastModified, {
        onNone: () => "—",
        onSome: formatDate,
      })

  return h.keyed("tr")(
    entry.name,
    [
      h.Class(`file-row ${isDir ? "is-directory" : "is-file"}`),
      h.DataAttribute("entry", entry.name),
      h.DataAttribute("kind", entry.kind),
      h.Title(isDir ? "Ordner öffnen" : "Datei öffnen"),
      h.OnClick(Message.ClickedEntryRow({ entry })),
    ],
    [
      h.td(
        [h.Class("file-name-cell")],
        [
          h.span(
            [h.Class("file-name-inner")],
            [
              h.span([h.Class("file-icon"), h.AriaHidden(true)], [icon]),
              h.span([h.Class("file-name"), h.Title(entry.name)], [entry.name]),
            ],
          ),
        ],
      ),
      showFileInfo
        ? h.td([h.Class("file-size-cell"), h.DataAttribute("label", "Größe")], [sizeDisplay])
        : h.empty,
      showFileInfo
        ? h.td(
            [
              h.Class("file-date-cell"),
              h.DataAttribute("label", "Zuletzt geändert"),
              h.DataAttribute("label-short", "Geändert"),
            ],
            [dateDisplay],
          )
        : h.empty,
      h.td(
        [h.Class("files-actions-cell")],
        [
          h.div(
            [h.Class("files-actions-inner")],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class("btn btn-secondary btn-sm btn-edit-entry"),
                  h.DataAttribute("entry", entry.name),
                  h.Title(isDir ? "Ordner bearbeiten" : "Datei bearbeiten"),
                  h.AriaLabel(isDir ? "Ordner bearbeiten" : "Datei bearbeiten"),
                  h.OnClick(Message.ClickedEditEntry({ entry }), {
                    propagation: "Stop",
                  }),
                ],
                ["✏️ ", h.span([h.Class("btn-label")], ["Bearbeiten"])],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewFilesTable = (
  entries: ReadonlyArray<FileEntry>,
  showFileInfo: boolean,
  h: HtmlBuilder,
): Html.Html => {
  if (Array.isReadonlyArrayEmpty(entries)) {
    return h.div(
      [h.Class("empty-state")],
      [h.div([h.Class("empty-icon"), h.AriaHidden(true)], ["📁"]), h.h3([], ["Ordner ist leer"])],
    )
  }

  return h.div(
    [],
    [
      h.div([h.Class("files-summary")], [h.span([], [formatSummaryText(entries)])]),
      h.div(
        [h.Class("table-responsive")],
        [
          h.table(
            [h.Class("files-table")],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Scope("col"), h.Class("th-name")], ["Name"]),
                      showFileInfo
                        ? h.th([h.Scope("col"), h.Class("th-size")], ["Größe"])
                        : h.empty,
                      showFileInfo
                        ? h.th([h.Scope("col"), h.Class("th-date")], ["Zuletzt geändert"])
                        : h.empty,
                      h.th(
                        [h.Scope("col"), h.Class("th-actions")],
                        [h.span([h.Class("visually-hidden")], ["Aktion"])],
                      ),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                pipe(
                  entries,
                  Array.map((entry) => viewEntryRow(entry, showFileInfo, h)),
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewContentSection = (model: Model, h: HtmlBuilder): Html.Html =>
  h.div(
    [h.Id("files-content"), h.Class("files-content")],
    [
      StorageState.match(model.storageState, {
        Initializing: () =>
          h.div(
            [h.Class("loading-state")],
            [
              h.div([h.Class("spinner"), h.AriaHidden(true)]),
              h.p([], ["Dateien werden geladen..."]),
            ],
          ),

        Unsupported: () =>
          h.div(
            [h.Class("empty-state")],
            [
              h.p(
                [],
                ["In dieser Umgebung ist keine kompatible lokale Dateisystem-API verfügbar."],
              ),
            ],
          ),

        NoFolderSelected: () =>
          h.div(
            [h.Class("empty-state")],
            [
              h.div([h.Class("empty-icon"), h.AriaHidden(true)], ["📂"]),
              h.h3([], ["Kein Ordner ausgewählt"]),
              h.p([], ["Wähle einen lokalen Ordner, in dem deine Projekte gespeichert werden."]),
              h.div(
                [h.Class("empty-actions")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-select-folder-hero"),
                      h.Class("btn btn-primary"),
                      h.OnClick(Message.ClickedSelectFolder()),
                    ],
                    ["📂 Ordner wählen"],
                  ),
                ],
              ),
            ],
          ),

        PermissionRequired: ({ folderName }) =>
          h.div(
            [h.Class("empty-state")],
            [
              h.div([h.Class("empty-icon"), h.AriaHidden(true)], ["🔒"]),
              h.h3([], ["Zugriff erforderlich"]),
              h.p(
                [],
                [
                  "Um Ihre Dateien zu laden, bestätigen Sie bitte den dauerhaften Zugriff auf den Ordner ",
                  h.strong([], [folderName]),
                  ".",
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("btn-grant-permission-hero"),
                  h.Class("btn btn-primary"),
                  h.OnClick(Message.ClickedGrantPermission()),
                ],
                [`Zugriff auf "${folderName}" erlauben`],
              ),
            ],
          ),

        Ready: ({ entriesState }) =>
          EntriesState.match(entriesState, {
            Loading: () =>
              h.div(
                [h.Class("loading-state")],
                [
                  h.div([h.Class("spinner"), h.AriaHidden(true)]),
                  h.p([], ["Dateien werden geladen..."]),
                ],
              ),
            Loaded: ({ entries }) => viewFilesTable(entries, model.showFileInfo, h),
            Error: ({ message }) =>
              h.div(
                [h.Class("empty-state")],
                [
                  h.div([h.Class("empty-icon"), h.AriaHidden(true)], ["⚠️"]),
                  h.h3([], ["Fehler beim Lesen der Dateien"]),
                  h.p([], [message]),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-retry-list"),
                      h.Class("btn btn-primary"),
                      h.OnClick(Message.ClickedRetryList()),
                    ],
                    ["Erneut versuchen"],
                  ),
                ],
              ),
          }),
      }),
    ],
  )

// ---------------------------------------------------------------------------
// Editor Modal & Help Modal
// ---------------------------------------------------------------------------

const viewPreviewContent = (preview: PreviewContent, h: HtmlBuilder): Html.Html =>
  PreviewContent.match(preview, {
    None: () => h.empty,
    Image: ({ objectUrl }) =>
      h.figure(
        [h.Id("modal-file-preview"), h.Class("file-preview")],
        [h.img([h.Src(objectUrl), h.Alt("Vorschau der Datei"), h.Class("file-preview-image")])],
      ),
    Pdf: ({ objectUrl }) =>
      h.figure(
        [h.Id("modal-file-preview"), h.Class("file-preview")],
        [h.iframe([h.Src(objectUrl), h.Title("Vorschau der Datei"), h.Class("file-preview-pdf")])],
      ),
  })

const viewEditorFileBody = (fileMode: EditorFileMode, h: HtmlBuilder): ReadonlyArray<Html.Html> =>
  EditorFileMode.match(fileMode, {
    Text: ({ content }) => [
      h.div(
        [h.Class("form-group")],
        [
          h.label([h.For("modal-file-content")], ["Inhalt:"]),
          h.textarea([
            h.Id("modal-file-content"),
            h.Class("form-textarea"),
            h.Placeholder("Geben Sie hier den Dateiinhalt ein..."),
            h.Spellcheck(false),
            h.Value(content),
            h.OnInput((text) => Message.UpdatedModalTextContent({ content: text })),
          ]),
        ],
      ),
    ],

    Binary: ({ canEditBase64, isBase64Enabled, base64Content, isLoadingBase64, preview }) => [
      h.div(
        [h.Class("form-group")],
        [
          canEditBase64
            ? h.label(
                [h.Class("form-check")],
                [
                  h.input([
                    h.Type("checkbox"),
                    h.Id("modal-use-base64"),
                    h.Checked(isBase64Enabled),
                    h.Disabled(isLoadingBase64),
                    h.OnChange(() =>
                      Message.ToggledModalBase64({
                        isChecked: !isBase64Enabled,
                      }),
                    ),
                  ]),
                  h.span([], ["Binärdatei bearbeiten"]),
                ],
              )
            : h.empty,
          canEditBase64 && isBase64Enabled
            ? h.div(
                [h.Id("modal-base64-editor"), h.Class("form-group")],
                [
                  h.label([h.For("modal-file-content-b64")], ["Base64-Inhalt:"]),
                  h.textarea([
                    h.Id("modal-file-content-b64"),
                    h.Class("form-textarea form-textarea-mono"),
                    h.Spellcheck(false),
                    h.Placeholder("Base64-Daten dieser Datei"),
                    h.Disabled(isLoadingBase64),
                    h.Value(base64Content),
                    h.OnInput((value) =>
                      Message.UpdatedModalBase64Content({
                        base64Content: value,
                      }),
                    ),
                  ]),
                ],
              )
            : h.empty,
          isBase64Enabled ? h.empty : viewPreviewContent(preview, h),
        ],
      ),
    ],
  })

const viewEditorModal = (
  titleText: string,
  noun: "Datei" | "Ordner",
  isFolder: boolean,
  isEditingExisting: boolean,
  nameValue: string,
  extraBodyNodes: ReadonlyArray<Html.Html>,
  h: HtmlBuilder,
): Html.Html => {
  const saveLabel = isEditingExisting ? "Speichern" : "Erstellen"

  return h.div(
    [
      h.Class("modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy("modal-title"),
    ],
    [
      h.div(
        [h.Class("modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3([h.Id("modal-title"), h.Class("modal-title")], [titleText]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.ClickedCloseModal()),
                ],
                ["×"],
              ),
            ],
          ),
          h.form(
            [h.Id("modal-form"), h.OnSubmit(Message.ClickedSaveModal())],
            [
              h.div(
                [h.Class("modal-body")],
                [
                  h.div(
                    [h.Class("form-group")],
                    [
                      h.label([h.For("modal-file-name")], [`${noun}name:`]),
                      h.input([
                        h.Type("text"),
                        h.Id("modal-file-name"),
                        h.Class("form-input"),
                        h.Value(nameValue),
                        h.Required(true),
                        h.Placeholder(isFolder ? "z. B. projekte" : "z. B. index.html, daten.json"),
                        h.Autocomplete("off"),
                        h.OnInput((name) => Message.UpdatedModalName({ name })),
                      ]),
                    ],
                  ),
                  ...extraBodyNodes,
                ],
              ),
              h.footer(
                [h.Class("modal-footer")],
                [
                  h.div(
                    [h.Class("modal-footer-left")],
                    [
                      isEditingExisting
                        ? h.button(
                            [
                              h.Type("button"),
                              h.Id("modal-btn-delete"),
                              h.Class("btn btn-danger icon-label-btn"),
                              h.AriaLabel("Löschen"),
                              h.DataAttribute("tip", "Löschen"),
                              h.OnClick(Message.ClickedDeleteModalEntry()),
                            ],
                            [
                              h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["🗑️"]),
                              h.span([h.Class("icon-label-btn-text")], ["Löschen"]),
                            ],
                          )
                        : h.empty,
                    ],
                  ),
                  h.div(
                    [h.Class("modal-footer-right")],
                    [
                      h.button(
                        [
                          h.Type("button"),
                          h.Id("modal-btn-cancel"),
                          h.Class("btn btn-secondary icon-label-btn"),
                          h.AriaLabel("Abbrechen"),
                          h.DataAttribute("tip", "Abbrechen"),
                          h.OnClick(Message.ClickedCloseModal()),
                        ],
                        [
                          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["✕"]),
                          h.span([h.Class("icon-label-btn-text")], ["Abbrechen"]),
                        ],
                      ),
                      h.button(
                        [
                          h.Type("submit"),
                          h.Id("modal-btn-save"),
                          h.Class("btn btn-primary icon-label-btn"),
                          h.AriaLabel(saveLabel),
                          h.DataAttribute("tip", saveLabel),
                          h.OnClick(Message.ClickedSaveModal(), { defaultAction: "Prevent" }),
                        ],
                        [
                          h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["💾"]),
                          h.span([h.Class("icon-label-btn-text")], [saveLabel]),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewHelpModal = (
  model: Model,
  isApiOpen: boolean,
  isFsOpen: boolean,
  copyDtsState: CopyDtsState,
  h: HtmlBuilder,
): Html.Html => {
  const origin = typeof window !== "undefined" ? window.location.origin : ""

  const copyBtnLabel = CopyDtsState.match(copyDtsState, {
    Idle: () => "/api.d.ts kopieren",
    Copying: () => "Wird kopiert …",
    Copied: () => "✅ Kopiert!",
    Error: () => "/api.d.ts kopieren",
  })

  return h.div(
    [
      h.Class("modal-overlay help-modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabelledBy("help-modal-title"),
    ],
    [
      h.div(
        [h.Class("modal-content")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h3(
                [h.Id("help-modal-title"), h.Class("modal-title")],
                [h.span([h.Class("help-title-icon"), h.AriaHidden(true)], ["❓"]), " Hilfe"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.ClickedCloseModal()),
                ],
                ["×"],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              h.div(
                [h.Class("help-accordion")],
                [
                  // Topic 1: API
                  h.details(
                    [
                      h.Class("help-topic"),
                      h.DataAttribute("topic", "api"),
                      h.Open(isApiOpen),
                      h.OnToggle((isOpen) => Message.ToggledHelpTopic({ topic: "api", isOpen })),
                    ],
                    [
                      h.summary(
                        [h.Class("help-topic-summary")],
                        [
                          h.span([h.Class("help-topic-marker"), h.AriaHidden(true)], ["🧩"]),
                          h.span([h.Class("help-topic-title")], ["PWA Islands bauen"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Was ist eine Island?"]),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Eine Island ist eine einzelne HTML-Datei, die in dieser App liegt. Sie läuft im Browser wie eine kleine eigene App und kann über die Islands-API Dateien lesen, schreiben und löschen.",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["So entsteht eine Island"]),
                              h.ol(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "Über ",
                                      h.strong([], ["+ Datei"]),
                                      " eine neue ",
                                      h.code([h.Class("help-path")], [".html"]),
                                      "-Datei anlegen (zum Beispiel ",
                                      h.code([h.Class("help-path")], ["uhr.html"]),
                                      ") oder eine fertige HTML-Datei importieren.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Die API im eigenen Modul einbinden: ",
                                      h.code(
                                        [h.Class("help-path")],
                                        ["import islands from '/api.js'"],
                                      ),
                                      ". Das muss in einem ",
                                      h.code([h.Class("help-path")], ['<script type="module">']),
                                      " stehen.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Die Datei in der Liste antippen. Sie wird unter ihrem eigenen Pfad geöffnet.",
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Beispiel"]),
                              h.pre(
                                [h.Class("help-code")],
                                [
                                  h.code(
                                    [],
                                    [
                                      `<script type="module">\n  import islands from '/api.js'\n\n  const eintraege = await islands.list()\n  await islands.write('notizen/idee.txt', 'Hallo Welt')\n  const inhalt = await islands.read('notizen/idee.txt')\n</script>`,
                                    ],
                                  ),
                                ],
                              ),
                              h.p(
                                [h.Class("help-hint")],
                                ["Alle Pfade sind relativ zur Wurzel des gewählten Ordners."],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4(
                                [h.Class("help-heading")],
                                ["App-Start und Startseiten (index.html)"],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Beim Öffnen der App landen Sie standardmäßig im Hauptverzeichnis (",
                                  h.code([h.Class("help-path")], ["/"]),
                                  ").",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "Zu Beginn sehen Sie hier eine Dateiliste, da noch keine Startseite existiert.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Sobald Sie eine Datei namens ",
                                      h.code([h.Class("help-path")], ["index.html"]),
                                      " erstellen, wird diese automatisch geladen, wenn Sie die App öffnen.",
                                    ],
                                  ),
                                ],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Dieses Prinzip gilt auch für alle Unterordner: Die Adresse ",
                                  h.code([h.Class("help-path")], ["/projekte/"]),
                                  " lädt automatisch die Datei ",
                                  h.code([h.Class("help-path")], ["/projekte/index.html"]),
                                  ". Fehlt die Datei (oder existiert die aufgerufene Adresse gar nicht), zeigt die App stattdessen die Dateiliste des Ordners.",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4(
                                [h.Class("help-heading")],
                                ["Der Bearbeitungsmodus (?pwaislands)"],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Wenn die App eine fertige Webseite (wie die ",
                                  h.code([h.Class("help-path")], ["index.html"]),
                                  ") anzeigt, können Sie mit dem Parameter ",
                                  h.code([h.Class("help-path")], ["?pwaislands"]),
                                  " in der Adresse zurück in die Bearbeitungs-App wechseln:",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      h.code([h.Class("help-path")], [`${origin}/?pwaislands`]),
                                      " → Erzwingt die Dateiliste des Hauptverzeichnisses (auch wenn eine ",
                                      h.code([h.Class("help-path")], ["index.html"]),
                                      " existiert).",
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Typen für Werkzeuge und Agenten"]),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Die Datei ",
                                  h.code(
                                    [h.Class("help-path")],
                                    [
                                      h.a(
                                        [
                                          h.Class("help-link"),
                                          h.Href("/api.d.ts"),
                                          h.Target("_blank"),
                                          h.Rel("noopener"),
                                        ],
                                        [`${origin}/api.d.ts`],
                                      ),
                                    ],
                                  ),
                                  " beschreibt die komplette API mit allen Typen. Kopieren Sie sie in die Zwischenablage und geben Sie sie einem KI-Agenten als Kontext — damit kann er Islands schreiben, ohne die API zu raten.",
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),

                  // Topic 2: File System & Storage
                  h.details(
                    [
                      h.Class("help-topic"),
                      h.DataAttribute("topic", "fs"),
                      h.Open(isFsOpen),
                      h.OnToggle((isOpen) => Message.ToggledHelpTopic({ topic: "fs", isOpen })),
                    ],
                    [
                      h.summary(
                        [h.Class("help-topic-summary")],
                        [
                          h.span([h.Class("help-topic-marker"), h.AriaHidden(true)], ["💾"]),
                          h.span([h.Class("help-topic-title")], ["Speicher: FS API und OPFS"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Beide Speicherarten beruhen auf derselben Browser-Schnittstelle, der ",
                                  h.code([h.Class("help-path")], ["File System Access API"]),
                                  ". Sie liefern dasselbe ",
                                  h.code([h.Class("help-path")], ["FileSystemDirectoryHandle"]),
                                  " — die Islands-API arbeitet in beiden Fällen ausschließlich mit Pfaden relativ zur Wurzel.",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["📁 Lokaler Ordner (FS API)"]),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Ein normaler Ordner auf dem Gerät, gewählt über ",
                                  h.code([h.Class("help-path")], ["showDirectoryPicker()"]),
                                  ". Die Dateien lassen sich jederzeit mit anderen Programmen öffnen und liegen im Dateisystem, sind also mitsamt Ordnerstruktur leicht zu sichern.",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "Der Ordner-Handle wird in IndexedDB gemerkt. Nach einem Neustart fehlt aber die ",
                                      h.strong([], ["Berechtigung"]),
                                      ": der Browser braucht einen Klick, um sie erneut zu erteilen („Zugriff erlauben“).",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Ein Umbenennen oder Verschieben des Ordners außerhalb des Browsers macht das gemerkte Handle ungültig — dann neu auswählen.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Nur in Browsern mit ",
                                      h.code([h.Class("help-path")], ["showDirectoryPicker"]),
                                      " (Chromium-basiert).",
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["📦 App-Speicher (OPFS)"]),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "Das ",
                                  h.em([], ["Origin Private File System"]),
                                  " ist ein privater Speicherbereich des Browsers, erreichbar über ",
                                  h.code(
                                    [h.Class("help-path")],
                                    ["navigator.storage.getDirectory()"],
                                  ),
                                  ". Hier liegt alles unter dem Ordner ",
                                  h.code([h.Class("help-path")], [OPFS_APP_FOLDER]),
                                  ".",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "Braucht ",
                                      h.strong([], ["keine Ordnerauswahl und keine Berechtigung"]),
                                      " — die App ist nach dem Start sofort einsatzbereit.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Die Dateien sind ",
                                      h.strong([], ["an diesen Browser gebunden"]),
                                      ": in einem anderen Browser oder Profil sind sie nicht sichtbar, und mit dem Löschen der Websitedaten sind sie weg.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Ein Export auf die Festplatte ist von Hand nötig (Datei herunterladen).",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Der Browser darf den Speicher bei Platzmangel räumen; eine dauerhafte Ablage ist es nicht.",
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Welche Art wann?"]),
                              h.div(
                                [h.Class("help-table-wrap")],
                                [
                                  h.table(
                                    [h.Class("help-table")],
                                    [
                                      h.thead(
                                        [],
                                        [
                                          h.tr(
                                            [],
                                            [
                                              h.th([], []),
                                              h.th([], ["📁 Lokaler Ordner"]),
                                              h.th([], ["📦 App-Speicher"]),
                                            ],
                                          ),
                                        ],
                                      ),
                                      h.tbody(
                                        [],
                                        [
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Berechtigung nötig"]),
                                              h.td([], ["ja, bei jedem Start"]),
                                              h.td([], ["nein"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Andere Programme"]),
                                              h.td([], ["ja"]),
                                              h.td([], ["nein"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Anderer Browser"]),
                                              h.td([], ["ja, Ordner erneut wählen"]),
                                              h.td([], ["nein"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Sicherung"]),
                                              h.td([], ["Dateisystem-Backup"]),
                                              h.td([], ["von Hand"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Verfügbar in"]),
                                              h.td([], ["nur Chromium"]),
                                              h.td([], ["allen modernen Browsern"]),
                                            ],
                                          ),
                                          h.tr(
                                            [h.Class("help-supported-row")],
                                            [
                                              h.td([], ["In diesem Browser"]),
                                              h.td(
                                                [h.DataAttribute("support", "fsa")],
                                                [
                                                  h.span(
                                                    [
                                                      h.Class("help-supported"),
                                                      h.DataAttribute(
                                                        "supported",
                                                        model.hasDirectoryPicker ? "yes" : "no",
                                                      ),
                                                    ],
                                                    [
                                                      model.hasDirectoryPicker
                                                        ? "✅ verfügbar"
                                                        : "❌ nicht verfügbar",
                                                    ],
                                                  ),
                                                ],
                                              ),
                                              h.td(
                                                [h.DataAttribute("support", "opfs")],
                                                [
                                                  h.span(
                                                    [
                                                      h.Class("help-supported"),
                                                      h.DataAttribute(
                                                        "supported",
                                                        model.hasOPFS ? "yes" : "no",
                                                      ),
                                                    ],
                                                    [
                                                      model.hasOPFS
                                                        ? "✅ verfügbar"
                                                        : "❌ nicht verfügbar",
                                                    ],
                                                  ),
                                                ],
                                              ),
                                            ],
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                              h.p(
                                [h.Class("help-hint")],
                                [
                                  "Wechseln lässt sich die Art jederzeit über das Zahnrad ⚙️. Die Wahl wird gemerkt, die Dateien der jeweils anderen Art bleiben dabei unangetastet.",
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
              CopyDtsState.match(copyDtsState, {
                Error: ({ message }) =>
                  h.div(
                    [h.Id("help-copy-error"), h.Class("alert alert-danger")],
                    [
                      `Kopieren hat nicht geklappt: ${message} Öffnen Sie ${origin}/api.d.ts direkt im Browser und kopieren Sie den Text von Hand.`,
                    ],
                  ),
                Copied: () => h.empty,
                Copying: () => h.empty,
                Idle: () => h.empty,
              }),
            ],
          ),
          h.footer(
            [h.Class("modal-footer")],
            [
              h.div([h.Class("modal-footer-left")]),
              h.div(
                [h.Class("modal-footer-right")],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("help-btn-copy-dts"),
                      h.Class("btn btn-primary icon-label-btn"),
                      h.AriaLabel("/api.d.ts kopieren"),
                      h.DataAttribute("tip", "/api.d.ts kopieren"),
                      h.Disabled(copyDtsState._tag === "Copying"),
                      h.OnClick(Message.ClickedCopyDts()),
                    ],
                    [
                      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["📋"]),
                      h.span([h.Class("icon-label-btn-text")], [copyBtnLabel]),
                    ],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("help-btn-close"),
                      h.Class("btn btn-secondary icon-label-btn"),
                      h.AriaLabel("Schließen"),
                      h.DataAttribute("tip", "Schließen"),
                      h.OnClick(Message.ClickedCloseModal()),
                    ],
                    [
                      h.span([h.Class("icon-label-btn-icon"), h.AriaHidden(true)], ["✕"]),
                      h.span([h.Class("icon-label-btn-text")], ["Schließen"]),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const viewModalContainer = (model: Model, h: HtmlBuilder): Html.Html =>
  h.div(
    [h.Id("files-modal-container")],
    [
      ModalState.match(model.modalState, {
        Closed: () => h.empty,

        CreateFile: ({ name, content }) =>
          viewEditorModal(
            "Neue Datei erstellen",
            "Datei",
            false,
            false,
            name,
            viewEditorFileBody(EditorFileMode.Text({ content }), h),
            h,
          ),

        CreateFolder: ({ name }) =>
          viewEditorModal("Neuen Ordner erstellen", "Ordner", true, false, name, [], h),

        EditFolder: ({ originalName, name }) =>
          viewEditorModal(`Ordner bearbeiten: ${originalName}`, "Ordner", true, true, name, [], h),

        EditFile: ({ originalName, name, fileMode }) =>
          viewEditorModal(
            `Datei bearbeiten: ${originalName}`,
            "Datei",
            false,
            true,
            name,
            viewEditorFileBody(fileMode, h),
            h,
          ),

        Help: ({ isApiOpen, isFsOpen, copyDtsState }) =>
          viewHelpModal(model, isApiOpen, isFsOpen, copyDtsState, h),
      }),
    ],
  )

// ---------------------------------------------------------------------------
// PWA Update Toast
// ---------------------------------------------------------------------------

const viewPwaToast = (model: Model, h: HtmlBuilder): Html.Html =>
  PwaToastState.match(model.pwaToastState, {
    Hidden: () =>
      h.div(
        [h.Id("pwa-toast"), h.Role("alert"), h.AriaLabelledBy("toast-message")],
        [
          h.div([h.Class("message")], [h.span([h.Id("toast-message")])]),
          h.div(
            [h.Class("buttons")],
            [
              h.button(
                [h.Id("pwa-refresh"), h.Type("button"), h.OnClick(Message.ClickedPwaRefresh())],
                ["Neu laden"],
              ),
              h.button(
                [h.Id("pwa-close"), h.Type("button"), h.OnClick(Message.ClickedPwaClose())],
                ["Schließen"],
              ),
            ],
          ),
        ],
      ),

    OfflineReady: () =>
      h.div(
        [h.Id("pwa-toast"), h.Class("show"), h.Role("alert"), h.AriaLabelledBy("toast-message")],
        [
          h.div(
            [h.Class("message")],
            [h.span([h.Id("toast-message")], ["App ist bereit für die Offline-Nutzung"])],
          ),
          h.div(
            [h.Class("buttons")],
            [
              h.button(
                [h.Id("pwa-refresh"), h.Type("button"), h.OnClick(Message.ClickedPwaRefresh())],
                ["Neu laden"],
              ),
              h.button(
                [h.Id("pwa-close"), h.Type("button"), h.OnClick(Message.ClickedPwaClose())],
                ["Schließen"],
              ),
            ],
          ),
        ],
      ),

    NeedRefresh: () =>
      h.div(
        [
          h.Id("pwa-toast"),
          h.Class("show refresh"),
          h.Role("alert"),
          h.AriaLabelledBy("toast-message"),
        ],
        [
          h.div(
            [h.Class("message")],
            [
              h.span(
                [h.Id("toast-message")],
                ["Neuer Inhalt verfügbar, klicken Sie auf Neu laden zum Aktualisieren"],
              ),
            ],
          ),
          h.div(
            [h.Class("buttons")],
            [
              h.button(
                [h.Id("pwa-refresh"), h.Type("button"), h.OnClick(Message.ClickedPwaRefresh())],
                ["Neu laden"],
              ),
              h.button(
                [h.Id("pwa-close"), h.Type("button"), h.OnClick(Message.ClickedPwaClose())],
                ["Schließen"],
              ),
            ],
          ),
        ],
      ),
  })

// ---------------------------------------------------------------------------
// Root Document View
// ---------------------------------------------------------------------------

export const view = (model: Model, h: HtmlBuilder): Html.Document => ({
  title: computeDocumentTitle(model),
  body: h.div(
    [h.Id("app")],
    [
      h.main(
        [h.Id("router-view"), h.Class("router-view")],
        [
          h.div(
            [h.Class("files-page")],
            [
              viewAlertContainer(model, h),
              viewToolbar(model, h),
              viewContentSection(model, h),
              viewModalContainer(model, h),
            ],
          ),
        ],
      ),
      viewPwaToast(model, h),
    ],
  ),
})
