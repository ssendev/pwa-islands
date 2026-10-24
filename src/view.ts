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

import rootIconUrl from "./assets/pwa-islands.svg"

type HtmlBuilder = Html.HtmlBuilder<Message>

// ---------------------------------------------------------------------------
// Toolbar & Breadcrumbs
// ---------------------------------------------------------------------------

const viewBreadcrumbs = (model: Model, h: HtmlBuilder): Html.Html =>
  StorageState.match(model.storageState, {
    Initializing: () =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfadnavigation")],
        [h.span([h.Class("breadcrumb-current")], ["Initialisiere..."])],
      ),

    Unsupported: () =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfadnavigation")],
        [h.span([h.Class("breadcrumb-current")], ["Dateisystem-APIs nicht unterstützt"])],
      ),

    NoFolderSelected: () =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfadnavigation")],
        [h.span([h.Class("breadcrumb-current")], ["Kein Ordner ausgewählt"])],
      ),

    PermissionRequired: ({ folderName }) =>
      h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfadnavigation")],
        [h.span([h.Class("breadcrumb-current")], [`${folderName} (Zugriff erforderlich)`])],
      ),

    Ready: ({ subPath }) => {
      if (Array.isReadonlyArrayEmpty(subPath)) {
        return h.nav(
          [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfadnavigation")],
          [h.span([h.Class("breadcrumb-current"), h.Title("PWA Islands")], ["PWA Islands"])],
        )
      }

      const segmentNodes: Array<Html.Html> = []
      for (let i = 0; i < subPath.length; i++) {
        const segment = subPath[i]
        const isLast = i === subPath.length - 1
        segmentNodes.push(h.span([h.Class("breadcrumb-sep"), h.AriaHidden(true)], ["/"]))
        if (isLast) {
          segmentNodes.push(h.span([h.Class("breadcrumb-current"), h.Title(segment)], [segment]))
        } else {
          segmentNodes.push(
            h.button(
              [
                h.Type("button"),
                h.Class("breadcrumb-item"),
                h.Title(segment),
                h.OnClick(Message.ClickedBreadcrumbSegment({ index: i })),
              ],
              [segment],
            ),
          )
        }
      }

      return h.nav(
        [h.Id("folder-name-display"), h.Class("breadcrumbs"), h.AriaLabel("Pfadnavigation")],
        [
          h.button(
            [
              h.Type("button"),
              h.Class("breadcrumb-item"),
              h.Title("PWA Islands"),
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
          h.Class("btn btn-icon"),
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
          h.Class(
            model.isSettingsOpen ? "settings-menu-dropdown" : "settings-menu-dropdown hidden",
          ),
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

const viewHeader = (model: Model, h: HtmlBuilder): Html.Html => {
  const isReady = model.storageState._tag === "Ready"

  return h.header(
    [h.Class("files-toolbar")],
    [
      h.div(
        [h.Class("files-toolbar-info")],
        [
          h.span(
            [h.Class("folder-icon"), h.AriaHidden(true)],
            [h.img([h.Class("breadcrumb-root-icon"), h.Src(rootIconUrl), h.Alt("")])],
          ),
          viewBreadcrumbs(model, h),
          h.div(
            [h.Class("files-toolbar-actions")],
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
                    ["📄➕ Datei"],
                  )
                : h.empty,
              isReady
                ? h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-new-folder"),
                      h.Class("btn btn-secondary"),
                      h.Title("Neuen Ordner erstellen"),
                      h.AriaLabel("Neuen Ordner erstellen"),
                      h.OnClick(Message.ClickedNewFolder()),
                    ],
                    ["📁➕ Ordner"],
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
                    ["📥 Hochladen"],
                  )
                : h.empty,
              viewSettingsMenu(model, h),
            ],
          ),
        ],
      ),
    ],
  )
}

// ---------------------------------------------------------------------------
// Alert Banner & Main File List Content
// ---------------------------------------------------------------------------

const viewAlertContainer = (model: Model, h: HtmlBuilder): Html.Html =>
  Option.match(model.maybeAlertBanner, {
    onNone: () => h.div([h.Id("files-alert-container"), h.AriaLive("polite")]),
    onSome: (banner) =>
      h.div(
        [h.Id("files-alert-container"), h.AriaLive("polite")],
        [h.div([h.Class(`alert alert-${banner.variant}`)], [banner.message])],
      ),
  })

const viewEntryRow = (entry: FileEntry, showFileInfo: boolean, h: HtmlBuilder): Html.Html => {
  const icon = entry.kind === "directory" ? "📁" : "📄"
  const sizeStr = Option.match(entry.maybeSize, {
    onNone: () => "—",
    onSome: formatSize,
  })
  const dateStr = Option.match(entry.maybeLastModified, {
    onNone: () => "—",
    onSome: formatDate,
  })

  return h.keyed("tr")(
    entry.name,
    [
      h.Class(
        entry.kind === "directory" ? "file-row is-clickable is-directory" : "file-row is-clickable",
      ),
      h.DataAttribute("name", entry.name),
      h.DataAttribute("kind", entry.kind),
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
              h.span([h.Class("file-name")], [entry.name]),
            ],
          ),
        ],
      ),
      showFileInfo ? h.td([h.Class("file-size-cell")], [sizeStr]) : h.empty,
      showFileInfo ? h.td([h.Class("file-date-cell")], [dateStr]) : h.empty,
      h.td(
        [h.Class("files-actions-cell")],
        [
          h.div(
            [h.Class("files-actions-inner")],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class("btn btn-sm btn-secondary btn-edit-entry"),
                  h.DataAttribute("name", entry.name),
                  h.DataAttribute("kind", entry.kind),
                  h.Title(entry.kind === "directory" ? "Ordner bearbeiten" : "Datei bearbeiten"),
                  h.OnClick(Message.ClickedEditEntry({ entry }), {
                    propagation: "Stop",
                  }),
                ],
                ["✏️ Bearbeiten"],
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
      [
        h.div([h.Class("empty-icon"), h.AriaHidden(true)], ["📁"]),
        h.h2([], ["Ordner ist leer"]),
        h.p(
          [],
          [
            "Dieser Ordner enthält noch keine Dateien. Klicken Sie auf „Neue Datei“, um eine Datei anzulegen.",
          ],
        ),
      ],
    )
  }

  return h.div(
    [h.Class("files-table-container")],
    [
      h.div([h.Class("files-summary")], [formatSummaryText(entries)]),
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
                      h.th([h.Class("th-name")], ["Name"]),
                      showFileInfo ? h.th([h.Class("th-size")], ["Größe"]) : h.empty,
                      showFileInfo ? h.th([h.Class("th-date")], ["Zuletzt geändert"]) : h.empty,
                      h.th([h.Class("th-actions")], ["Aktionen"]),
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
  h.section(
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
              h.h2([], ["Kein Ordner ausgewählt"]),
              h.p(
                [],
                [
                  "Wählen Sie einen lokalen Ordner auf Ihrem Gerät aus, um dessen Dateien anzuzeigen und zu verwalten.",
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("btn-select-folder-hero"),
                  h.Class("btn btn-primary btn-lg"),
                  h.OnClick(Message.ClickedSelectFolder()),
                ],
                ["📂 Ordner wählen"],
              ),
            ],
          ),

        PermissionRequired: ({ folderName }) =>
          h.div(
            [h.Class("empty-state")],
            [
              h.div([h.Class("empty-icon"), h.AriaHidden(true)], ["🔒"]),
              h.h2([], ["Zugriff erforderlich"]),
              h.p(
                [],
                [
                  "Für den zuletzt verwendeten Ordner ",
                  h.strong([], [folderName]),
                  " muss die Berechtigung für diese Sitzung erneut bestätigt werden.",
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Id("btn-grant-permission-hero"),
                  h.Class("btn btn-primary btn-lg"),
                  h.OnClick(Message.ClickedGrantPermission()),
                ],
                [`Zugriff auf „${folderName}“ erlauben`],
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
                [h.Class("empty-state error-state")],
                [
                  h.div([h.Class("empty-icon"), h.AriaHidden(true)], ["⚠️"]),
                  h.h2([], ["Fehler beim Lesen der Dateien"]),
                  h.p([], [message]),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("btn-retry-list"),
                      h.Class("btn btn-secondary"),
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
    Image: ({ objectUrl, name }) =>
      h.div(
        [h.Class("modal-preview-container")],
        [
          h.label([h.Class("form-label")], ["Vorschau"]),
          h.div(
            [h.Class("modal-preview-box")],
            [
              h.img([
                h.Src(objectUrl),
                h.Alt(`Vorschau von ${name}`),
                h.Class("modal-preview-image"),
              ]),
            ],
          ),
        ],
      ),
    Pdf: ({ objectUrl }) =>
      h.div(
        [h.Class("modal-preview-container")],
        [
          h.label([h.Class("form-label")], ["Vorschau"]),
          h.div(
            [h.Class("modal-preview-box modal-preview-box-pdf")],
            [h.iframe([h.Src(objectUrl), h.Title("PDF-Vorschau"), h.Class("modal-preview-pdf")])],
          ),
        ],
      ),
  })

const viewEditorFileBody = (fileMode: EditorFileMode, h: HtmlBuilder): ReadonlyArray<Html.Html> =>
  EditorFileMode.match(fileMode, {
    Text: ({ content }) => [
      h.div(
        [h.Class("form-group form-group-grow")],
        [
          h.label([h.For("modal-file-content")], ["Inhalt (UTF-8 Text)"]),
          h.textarea([
            h.Id("modal-file-content"),
            h.Class("form-textarea"),
            h.Rows(14),
            h.Spellcheck(false),
            h.Value(content),
            h.OnInput((text) => Message.UpdatedModalTextContent({ content: text })),
          ]),
        ],
      ),
    ],

    Binary: ({
      lockReason,
      canEditBase64,
      isBase64Enabled,
      base64Content,
      isLoadingBase64,
      preview,
    }) => [
      viewPreviewContent(preview, h),
      h.div(
        [h.Class("alert alert-warning modal-lock-notice")],
        [
          h.span([h.Class("lock-icon"), h.AriaHidden(true)], ["🔒"]),
          h.div(
            [h.Class("lock-notice-content")],
            [
              h.div([], [lockReason]),
              canEditBase64
                ? h.label(
                    [h.Class("checkbox-label"), h.For("modal-use-base64")],
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
            ],
          ),
        ],
      ),
      canEditBase64 && isBase64Enabled
        ? h.div(
            [h.Id("modal-base64-group"), h.Class("form-group form-group-grow")],
            [
              h.label([h.For("modal-file-content-b64")], ["Inhalt (Base64-kodiert)"]),
              h.textarea([
                h.Id("modal-file-content-b64"),
                h.Class("form-textarea"),
                h.Rows(10),
                h.Spellcheck(false),
                h.Placeholder("Base64-kodierte Binärdaten..."),
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
    ],
  })

const viewEditorModal = (
  titleText: string,
  isFolder: boolean,
  isEditingExisting: boolean,
  nameValue: string,
  extraBodyNodes: ReadonlyArray<Html.Html>,
  h: HtmlBuilder,
): Html.Html =>
  h.div(
    [h.Class("modal-overlay"), h.Role("dialog"), h.AriaModal(true), h.AriaLabel(titleText)],
    [
      h.div(
        [h.Class("modal-dialog")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h2([h.Class("modal-title")], [titleText]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("btn btn-icon modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.Title("Schließen"),
                  h.OnClick(Message.ClickedCloseModal()),
                ],
                ["✕"],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              h.div(
                [h.Class("form-group")],
                [
                  h.label([h.For("modal-file-name")], [isFolder ? "Ordnername" : "Dateiname"]),
                  h.input([
                    h.Type("text"),
                    h.Id("modal-file-name"),
                    h.Class("form-input"),
                    h.Value(nameValue),
                    h.Autocomplete("off"),
                    h.Spellcheck(false),
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
                          h.Class("btn btn-danger"),
                          h.OnClick(Message.ClickedDeleteModalEntry()),
                        ],
                        ["🗑️ Löschen"],
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
                      h.Class("btn btn-secondary"),
                      h.OnClick(Message.ClickedCloseModal()),
                    ],
                    ["Abbrechen"],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("modal-btn-save"),
                      h.Class("btn btn-primary"),
                      h.OnClick(Message.ClickedSaveModal()),
                    ],
                    ["💾 Speichern"],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )

const viewHelpModal = (
  model: Model,
  isApiOpen: boolean,
  isFsOpen: boolean,
  copyDtsState: CopyDtsState,
  h: HtmlBuilder,
): Html.Html => {
  const fsaStatus = model.hasDirectoryPicker ? "✅ verfügbar" : "❌ nicht verfügbar"
  const opfsStatus = model.hasOPFS ? "✅ verfügbar" : "❌ nicht verfügbar"

  const copyBtnLabel = CopyDtsState.match(copyDtsState, {
    Idle: () => "📋 /api.d.ts in Zwischenablage kopieren",
    Copying: () => "Wird kopiert …",
    Copied: () => "✅ Kopiert!",
    Error: () => "📋 /api.d.ts in Zwischenablage kopieren",
  })

  const isCopying = copyDtsState._tag === "Copying"

  return h.div(
    [
      h.Class("modal-overlay help-modal-overlay"),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabel("Hilfe"),
    ],
    [
      h.div(
        [h.Class("modal-dialog modal-dialog-help")],
        [
          h.header(
            [h.Class("modal-header")],
            [
              h.h2([h.Class("modal-title")], ["❓ Hilfe & Dokumentation"]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("btn btn-icon modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.Title("Schließen"),
                  h.OnClick(Message.ClickedCloseModal()),
                ],
                ["✕"],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body help-modal-body")],
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
                      h.span([h.Class("help-topic-title")], ["🏝️ PWA Islands bauen"]),
                      h.span([h.Class("help-topic-badge")], ["Insel-Architektur & API"]),
                    ],
                  ),
                  h.div(
                    [h.Class("help-topic-content")],
                    [
                      h.p(
                        [],
                        [
                          "Eine ",
                          h.strong([], ["PWA Island"]),
                          " ist eine eigenständige Mini-App – meist eine einzelne ",
                          h.code([], [".html"]),
                          "-Datei (oder ein Unterordner mit HTML, CSS und JS), die direkt aus deinem gewählten Speicher geladen und vom Service Worker unter ihrer echten URL ausgeliefert wird.",
                        ],
                      ),
                      h.h3([], ["Schnellstart"]),
                      h.ol(
                        [h.Class("help-steps")],
                        [
                          h.li(
                            [],
                            [
                              "Klicke oben auf ",
                              h.strong([], ["📄➕ Datei"]),
                              " und erstelle z.\u00a0B. ",
                              h.code([], ["Notizen.html"]),
                              ".",
                            ],
                          ),
                          h.li(
                            [],
                            [
                              "Binde bei Bedarf die Islands-API mit ",
                              h.code([], ["import islands from '/api.js'"]),
                              " ein.",
                            ],
                          ),
                          h.li(
                            [],
                            [
                              "Speichere die Datei und klicke in der Dateiliste darauf, um deine Island zu starten.",
                            ],
                          ),
                          h.li(
                            [],
                            [
                              "Um aus einer laufenden Island zur Dateiverwaltung zurückzukehren, hänge ",
                              h.code([], ["?pwaislands"]),
                              " an die URL an (oder ",
                              h.code([], ["?pwaislands=edit"]),
                              " zum direkten Bearbeiten).",
                            ],
                          ),
                        ],
                      ),
                      h.h3([], ["Beispiel-Island"]),
                      h.pre(
                        [h.Class("help-code-block")],
                        [
                          h.code(
                            [],
                            [
                              `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <title>Meine Island</title>
</head>
<body>
  <h1 id="title">Lade…</h1>
  <script type="module">
    import islands from '/api.js'

    // Textdatei schreiben & lesen
    await islands.fs.writeText('hallo.txt', 'Hallo von meiner Island!')
    const text = await islands.fs.readText('hallo.txt')
    document.getElementById('title').textContent = text
  </script>
</body>
</html>`,
                            ],
                          ),
                        ],
                      ),
                      h.h3([], ["Überblick über /api.js"]),
                      h.ul(
                        [h.Class("help-list")],
                        [
                          h.li(
                            [],
                            [
                              h.code([], ["islands.storage.getStatus()"]),
                              " – Prüft aktiven Speicher-Typ (",
                              h.code([], ["'fsa' | 'opfs'"]),
                              ") und Berechtigungen.",
                            ],
                          ),
                          h.li(
                            [],
                            [
                              h.code([], ["islands.fs.list(path?)"]),
                              ", ",
                              h.code([], ["stat(path)"]),
                              ", ",
                              h.code([], ["exists(path)"]),
                              " – Dateien und Ordner abfragen.",
                            ],
                          ),
                          h.li(
                            [],
                            [
                              h.code([], ["islands.fs.readText(path)"]),
                              ", ",
                              h.code([], ["readJson(path)"]),
                              ", ",
                              h.code([], ["readBytes(path)"]),
                              " – Dateien lesen.",
                            ],
                          ),
                          h.li(
                            [],
                            [
                              h.code([], ["islands.fs.writeText(path, content)"]),
                              ", ",
                              h.code([], ["writeJson(path, data)"]),
                              ", ",
                              h.code([], ["writeBytes(path, bytes)"]),
                              " – Dateien schreiben (erstellt fehlende Elternordner standardmäßig automatisch).",
                            ],
                          ),
                          h.li(
                            [],
                            [
                              h.code([], ["islands.fs.mkdir(path)"]),
                              ", ",
                              h.code([], ["remove(path)"]),
                              ", ",
                              h.code([], ["copy(from, to)"]),
                              ", ",
                              h.code([], ["move(from, to)"]),
                              " – Dateisystem verwalten.",
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("help-dts-box")],
                        [
                          h.div(
                            [h.Class("help-dts-info")],
                            [
                              h.strong([], ["TypeScript-Typdefinitionen ("]),
                              h.code([], ["/api.d.ts"]),
                              h.strong([], [")"]),
                              h.p(
                                [],
                                [
                                  "Für volle Autovervollständigung in deinem Editor oder als Kontext für KI-Assistenten kannst du die komplette Typdefinition in die Zwischenablage kopieren:",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-dts-actions")],
                            [
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Id("help-btn-copy-dts"),
                                  h.Class("btn btn-primary"),
                                  h.Disabled(isCopying),
                                  h.OnClick(Message.ClickedCopyDts()),
                                ],
                                [copyBtnLabel],
                              ),
                            ],
                          ),
                        ],
                      ),
                      copyDtsState._tag === "Error"
                        ? h.div(
                            [h.Id("help-copy-error"), h.Class("alert alert-danger")],
                            [copyDtsState.message],
                          )
                        : h.div([h.Id("help-copy-error"), h.Class("alert alert-danger hidden")]),
                    ],
                  ),
                ],
              ),

              // Topic 2: FS API vs OPFS
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
                      h.span([h.Class("help-topic-title")], ["💾 Speicher: FS API und OPFS"]),
                      h.span(
                        [h.Class("help-topic-badge")],
                        ["Unterschiede & Browser-Unterstützung"],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("help-topic-content")],
                    [
                      h.p(
                        [],
                        [
                          "PWA Islands unterstützt zwei verschiedene Möglichkeiten, deine Dateien lokal auf deinem Gerät zu speichern. Über das ",
                          h.strong([], ["⚙️ Einstellungs-Menü"]),
                          " kannst du jederzeit zwischen beiden Modi wechseln, sofern dein Browser beide unterstützt.",
                        ],
                      ),
                      h.div(
                        [h.Class("help-comparison-table-wrapper")],
                        [
                          h.table(
                            [h.Class("help-comparison-table")],
                            [
                              h.thead(
                                [],
                                [
                                  h.tr(
                                    [],
                                    [
                                      h.th([], ["Eigenschaft"]),
                                      h.th([], ["📁 Lokaler Ordner (FS Access API)"]),
                                      h.th([], ["📦 App-Speicher (OPFS)"]),
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
                                      h.td([], [h.strong([], ["Status in diesem Browser"])]),
                                      h.td([], [fsaStatus]),
                                      h.td([], [opfsStatus]),
                                    ],
                                  ),
                                  h.tr(
                                    [],
                                    [
                                      h.td([], [h.strong([], ["Speicherort"])]),
                                      h.td(
                                        [],
                                        ["Ein frei wählbarer Ordner auf deiner Festplatte."],
                                      ),
                                      h.td(
                                        [],
                                        [
                                          "Abgeschotteter, privater Speicherbereich des Browsers für diese Website.",
                                        ],
                                      ),
                                    ],
                                  ),
                                  h.tr(
                                    [],
                                    [
                                      h.td([], [h.strong([], ["Zugriff mit externen Programmen"])]),
                                      h.td(
                                        [],
                                        [
                                          "Direkt möglich (z.\u00a0B. VS Code, Git, Datei-Explorer).",
                                        ],
                                      ),
                                      h.td(
                                        [],
                                        [
                                          "Nur innerhalb der App (oder über Datei-Upload/-Download).",
                                        ],
                                      ),
                                    ],
                                  ),
                                  h.tr(
                                    [],
                                    [
                                      h.td([], [h.strong([], ["Berechtigungen"])]),
                                      h.td(
                                        [],
                                        [
                                          "Browser fragt beim Öffnen/Neustart nach Lese-/Schreibrechten.",
                                        ],
                                      ),
                                      h.td([], ["Sofort ohne Rückfrage verfügbar."]),
                                    ],
                                  ),
                                  h.tr(
                                    [],
                                    [
                                      h.td([], [h.strong([], ["Typische Unterstützung"])]),
                                      h.td(
                                        [],
                                        [
                                          "Desktop-Browser auf Chromium-Basis (Chrome, Edge, Brave, Opera).",
                                        ],
                                      ),
                                      h.td(
                                        [],
                                        [
                                          "Nahezu alle modernen Browser (Chrome, Edge, Firefox, Safari / iOS, Android).",
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
                        [h.Class("help-note")],
                        [
                          h.strong([], ["Tipp:"]),
                          " Für die Entwicklung am Desktop empfiehlt sich ein ",
                          h.em([], ["lokaler Ordner"]),
                          ", damit du Dateien direkt in deinem gewohnten Code-Editor bearbeiten und mit Git versionieren kannst. Auf Mobilgeräten oder in Browsern wie Firefox und Safari sorgt ",
                          h.em([], ["OPFS"]),
                          " dafür, dass alle Islands trotzdem vollständig offline funktionieren.",
                        ],
                      ),
                    ],
                  ),
                ],
              ),
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
                      h.Id("help-btn-close"),
                      h.Class("btn btn-primary"),
                      h.OnClick(Message.ClickedCloseModal()),
                    ],
                    ["Schließen"],
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
            false,
            false,
            name,
            viewEditorFileBody(EditorFileMode.Text({ content }), h),
            h,
          ),

        CreateFolder: ({ name }) =>
          viewEditorModal("Neuen Ordner erstellen", true, false, name, [], h),

        EditFolder: ({ originalName, name }) =>
          viewEditorModal(`Ordner bearbeiten: ${originalName}`, true, true, name, [], h),

        EditFile: ({ originalName, name, fileMode }) =>
          viewEditorModal(
            `Datei bearbeiten: ${originalName}`,
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
        [h.Id("pwa-toast"), h.Role("alert"), h.AriaLive("assertive")],
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
        [h.Id("pwa-toast"), h.Class("show"), h.Role("alert"), h.AriaLive("assertive")],
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
        [h.Id("pwa-toast"), h.Class("show refresh"), h.Role("alert"), h.AriaLive("assertive")],
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
        [h.Class("files-app")],
        [
          viewHeader(model, h),
          viewAlertContainer(model, h),
          viewContentSection(model, h),
          viewModalContainer(model, h),
        ],
      ),
      viewPwaToast(model, h),
    ],
  ),
})
