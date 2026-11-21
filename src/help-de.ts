import { Array, Option } from "effect"
import type * as Html from "foldkit/html"
import { CopyDtsState, Message, type Model, type ViewInputs } from "./help"
import { viewIcon } from "./icons"
import {
  NPM_DIRECT_DEV_LICENSES,
  NPM_DIRECT_RUNTIME_LICENSES,
  NPM_TRANSITIVE_DEV_LICENSES,
  NPM_TRANSITIVE_RUNTIME_LICENSES,
  TAURI_DIRECT_LICENSES,
  TAURI_TRANSITIVE_LICENSES,
  type SoftwareLicense,
} from "./licenses"
import { OPFS_APP_FOLDER } from "./storage"

const viewDirectLicenseTable = (
  entries: ReadonlyArray<SoftwareLicense>,
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
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
                  h.th([], ["Paket"]),
                  h.th([], ["Zweck"]),
                  h.th([], ["Version"]),
                  h.th([], ["Lizenz"]),
                ],
              ),
            ],
          ),
          h.tbody(
            [],
            Array.map(entries, (entry) =>
              h.keyed("tr")(
                entry.name,
                [],
                [
                  h.td(
                    [],
                    [
                      h.a(
                        [h.Href(entry.url), h.Target("_blank"), h.Rel("noopener noreferrer")],
                        [entry.name],
                      ),
                    ],
                  ),
                  h.td([], [entry.description?.de ?? ""]),
                  h.td([], [h.code([], [entry.version])]),
                  h.td([], [entry.license]),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  )

const viewTransitiveLicenseTable = (
  entries: ReadonlyArray<SoftwareLicense>,
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
  h.div(
    [h.Class("help-table-wrap")],
    [
      h.table(
        [h.Class("help-table")],
        [
          h.thead(
            [],
            [h.tr([], [h.th([], ["Paket"]), h.th([], ["Version"]), h.th([], ["Lizenz"])])],
          ),
          h.tbody(
            [],
            Array.map(entries, (entry) =>
              h.keyed("tr")(
                `${entry.name}@${entry.version}`,
                [],
                [
                  h.td(
                    [],
                    [
                      h.a(
                        [h.Href(entry.url), h.Target("_blank"), h.Rel("noopener noreferrer")],
                        [entry.name],
                      ),
                    ],
                  ),
                  h.td([], [h.code([], [entry.version])]),
                  h.td([], [entry.license]),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  )

const API_DTS_HREF = "/api.d.ts"

const viewSupportCell = (
  supportKind: "tauri" | "fsa" | "opfs",
  isSupported: boolean,
  h: Html.HtmlBuilder<Message>,
): Html.Html =>
  h.td(
    [h.DataAttribute("support", supportKind)],
    [
      h.span(
        [h.Class("help-supported"), h.DataAttribute("supported", isSupported ? "yes" : "no")],
        [
          viewIcon(isSupported ? "check" : "cross", h),
          isSupported ? " verfügbar" : " nicht verfügbar",
        ],
      ),
    ],
  )

export const viewHelpDe = (
  model: Model,
  context: ViewInputs,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const isAboutOpen = Option.exists(model.maybeOpenTopic, (topic) => topic === "about")
  const isAiOpen = Option.exists(model.maybeOpenTopic, (topic) => topic === "ai")
  const isApiOpen = Option.exists(model.maybeOpenTopic, (topic) => topic === "api")
  const isFsOpen = Option.exists(model.maybeOpenTopic, (topic) => topic === "fs")
  const isLicensesOpen = Option.exists(model.maybeOpenTopic, (topic) => topic === "licenses")
  const isFsaSupported = !context.hasTauri && context.hasDirectoryPicker
  const isOpfsSupported = !context.hasTauri && context.hasOPFS

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
                [
                  h.span([h.Class("help-title-icon")], [viewIcon("help", h)]),
                  " Hilfe",
                  h.span([h.Class("help-version-badge")], [`v${__APP_VERSION__}`]),
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Schließen"),
                  h.OnClick(Message.ClickedClose()),
                ],
                [viewIcon("close", h)],
              ),
            ],
          ),
          h.div(
            [h.Class("modal-body")],
            [
              h.div(
                [h.Class("help-accordion")],
                [
                  h.details(
                    [
                      h.Class("help-topic"),
                      h.Name("help-topic"),
                      h.DataAttribute("topic", "about"),
                      h.Open(isAboutOpen),
                      h.OnToggle((isOpen) => Message.ToggledTopic({ topic: "about", isOpen })),
                    ],
                    [
                      h.summary(
                        [h.Class("help-topic-summary")],
                        [
                          h.span(
                            [h.Class("help-topic-marker"), h.AriaHidden(true)],
                            [viewIcon("file-info", h)],
                          ),
                          h.span([h.Class("help-topic-title")], ["Über PWA Islands"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.p(
                            [h.Class("help-text")],
                            [
                              h.em(
                                [],
                                [
                                  "HTML-Dateien ablegen und in einem sicheren Kontext ausführen — ohne ",
                                  h.code([], ["file://"]),
                                  ", ohne Server, ohne Internet.",
                                ],
                              ),
                            ],
                          ),
                          h.p(
                            [h.Class("help-text")],
                            [
                              "Mit PWA Islands kannst du einzelne ",
                              h.code([], [".html"]),
                              "-Mini-Apps lokal in einem sicheren Kontext speichern, bearbeiten und ausführen. Nutze es direkt im Browser als offline-fähige PWA oder installiere es als native Desktop-/Mobile-App.",
                            ],
                          ),
                          h.h4([h.Class("help-subheading")], ["Funktionen"]),
                          h.ul(
                            [h.Class("help-list")],
                            [
                              h.li(
                                [],
                                [
                                  h.strong([], ["Offline-first & sicherer Kontext"]),
                                  " — Lokale ",
                                  h.code([], [".html"]),
                                  "-Dateien ohne ",
                                  h.code([], ["file://"]),
                                  "-Einschränkungen und ohne Internetverbindung ausführen.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["PWA & Tauri"]),
                                  " — Läuft im Browser (File System API / OPFS) und als native App (Linux, Windows, macOS, Android).",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Integrierter Editor"]),
                                  " — HTML-Apps direkt im eingebauten Monaco-Editor ansehen und bearbeiten.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Islands API"]),
                                  " — Lese- und Schreibzugriff für Mini-Apps auf Dateien im gewählten Arbeitsordner über ",
                                  h.code([], ["import islands from '/api.js'"]),
                                  ".",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Mehrsprachige Oberfläche"]),
                                  " — Unterstützt Deutsch und Englisch.",
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                  h.details(
                    [
                      h.Class("help-topic"),
                      h.Name("help-topic"),
                      h.DataAttribute("topic", "ai"),
                      h.Open(isAiOpen),
                      h.OnToggle((isOpen) => Message.ToggledTopic({ topic: "ai", isOpen })),
                    ],
                    [
                      h.summary(
                        [h.Class("help-topic-summary")],
                        [
                          h.span(
                            [h.Class("help-topic-marker"), h.AriaHidden(true)],
                            [viewIcon("ai", h)],
                          ),
                          h.span([h.Class("help-topic-title")], ["Mit KI bearbeiten"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.p(
                            [h.Class("help-text")],
                            [
                              "Tipp: Klicke in der Werkzeugleiste auf ",
                              h.strong([], ["Neue Datei erstellen (+)"]),
                              " und wähle unter ",
                              h.strong([], ["Vorlage"]),
                              " die fertige ",
                              h.strong([], ["PWA Island (mit /api.js)"]),
                              "-Vorlage als Startpunkt.",
                            ],
                          ),
                          h.p(
                            [h.Class("help-text")],
                            [
                              h.strong([], ["Mit Chat-API: "]),
                              "Wenn in den ",
                              h.strong([], ["Einstellungen → KI-Chat"]),
                              " über ",
                              h.em([], ["+ Provider hinzufügen"]),
                              " ein aktiver Provider eingerichtet ist (oder Browser-KI verfügbar ist), wähle im Editor unten im Modus-Menü (",
                              viewIcon("edit", h),
                              " ▾) den Punkt ",
                              viewIcon("ai", h),
                              " ",
                              h.strong([], ["Chat"]),
                              " und schreibe deine Änderungswünsche direkt in das Chat-Feld – die KI bearbeitet die Datei automatisch. Mit ",
                              h.code([], ["/clear"]),
                              " kannst du den Chat-Verlauf jederzeit zurücksetzen.",
                            ],
                          ),
                          h.p(
                            [h.Class("help-text")],
                            [
                              h.strong(
                                [],
                                ["Ohne Chat-API (Kopieren-Modus über die Zwischenablage): "],
                              ),
                              "Für ChatGPT, Claude, Gemini & Co. wählst du das ",
                              h.strong([], ["Bearbeitungsformat"]),
                              " (",
                              h.em([], ["Hash-Anchored Edits"]),
                              ", ",
                              h.em([], ["Search & Replace"]),
                              " oder ",
                              h.em([], ["Vereinfachter Unified Diff"]),
                              ") in den ",
                              h.strong([], ["Einstellungen → KI-Chat"]),
                              ":",
                            ],
                          ),
                          h.ol(
                            [h.Class("help-list")],
                            [
                              h.li(
                                [],
                                [
                                  h.strong([], ["Kopieren-Modus öffnen: "]),
                                  "Wähle im Editor unten im Modus-Menü (",
                                  viewIcon("edit", h),
                                  " ▾) den Punkt ",
                                  viewIcon("clipboard", h),
                                  " ",
                                  h.strong([], ["Kopieren"]),
                                  ", um die Kopier-Leiste einzublenden.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Datei für die KI kopieren: "]),
                                  "Wähle ",
                                  h.strong([], ["Mit Anleitung"]),
                                  " (kopiert Kurzanleitung im gewählten Format, ",
                                  h.code([h.Class("help-path")], ["/api.d.ts"]),
                                  " und die Datei) oder ",
                                  h.strong([], ["Datei"]),
                                  " (nur die Datei). Über ",
                                  h.strong([], ["/app.d.ts"]),
                                  " kopierst du bei Bedarf nur die API-Typen.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["An die KI senden: "]),
                                  "Füge das Kopierte zusammen mit deinen Änderungswünschen in die KI ein.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["KI-Antwort einfügen: "]),
                                  "Kopiere die Antwort der KI im gewählten Format und klicke auf ",
                                  h.strong([], ["Einfügen"]),
                                  ". Bei Erfolg werden bei ",
                                  h.em([], ["Hash-Anchored Edits"]),
                                  " nur die geänderten Zeilen mit den neuen Hashes wieder in die Zwischenablage kopiert; bei ",
                                  h.em([], ["Search & Replace"]),
                                  " und ",
                                  h.em([], ["Vereinfachter Unified Diff"]),
                                  " wird die Zwischenablage stattdessen geleert. Bei Fehlern landet die Fehlermeldung direkt in der Zwischenablage.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Testen: "]),
                                  "Mit ",
                                  h.strong([], ["Vorschau"]),
                                  " wird der aktuelle Inhalt ohne Speichern als Vollfenster-Vorschau geöffnet, während der Editor im Hintergrund für weitere Edits offen bleibt (Schließen über ",
                                  h.strong([], ["×"]),
                                  ", ",
                                  h.em([], ["Escape"]),
                                  " oder Browser-Zurück).",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Weiterarbeiten: "]),
                                  "Sende der KI deine nächsten Änderungswünsche – bei ",
                                  h.em([], ["Hash-Anchored Edits"]),
                                  " oder einem Fehler aus Schritt 4 füge zuerst die automatisch kopierten Zeilen bzw. die Fehlermeldung aus der Zwischenablage mit ein.",
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                  h.details(
                    [
                      h.Class("help-topic"),
                      h.Name("help-topic"),
                      h.DataAttribute("topic", "api"),
                      h.Open(isApiOpen),
                      h.OnToggle((isOpen) => Message.ToggledTopic({ topic: "api", isOpen })),
                    ],
                    [
                      h.summary(
                        [h.Class("help-topic-summary")],
                        [
                          h.span(
                            [h.Class("help-topic-marker"), h.AriaHidden(true)],
                            [viewIcon("puzzle", h)],
                          ),
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
                                      h.code(
                                        [h.Class("help-path")],
                                        [`${context.origin}/?pwaislands`],
                                      ),
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
                                          h.Href(API_DTS_HREF),
                                          h.Target("_blank"),
                                          h.Rel("noopener"),
                                        ],
                                        [`${context.origin}/api.d.ts`],
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
                  h.details(
                    [
                      h.Class("help-topic"),
                      h.Name("help-topic"),
                      h.DataAttribute("topic", "fs"),
                      h.Open(isFsOpen),
                      h.OnToggle((isOpen) => Message.ToggledTopic({ topic: "fs", isOpen })),
                    ],
                    [
                      h.summary(
                        [h.Class("help-topic-summary")],
                        [
                          h.span(
                            [h.Class("help-topic-marker"), h.AriaHidden(true)],
                            [viewIcon("save", h)],
                          ),
                          h.span(
                            [h.Class("help-topic-title")],
                            ["Speicher: App (Tauri), FS API und OPFS"],
                          ),
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
                                  "PWA Islands unterstützt je nach Umgebung (Web-Browser oder native Desktop-App) verschiedene Speicherarten. In allen Fällen arbeitet die Islands-API einheitlich mit Pfaden relativ zur Wurzel des ausgewählten Projektordners.",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4(
                                [h.Class("help-heading")],
                                [viewIcon("desktop", h), " App (Tauri natives Dateisystem)"],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "In der nativen Desktop-App greift PWA Islands direkt über Tauri auf das Dateisystem zu. Der Projektordner wird über den System-Dateidialog gewählt.",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      h.strong([], ["Dauerhafter Zugriff"]),
                                      ": Nach dem ersten Auswählen bleibt der Ordner gemerkt und steht nach jedem App-Start sofort ohne erneute Berechtigungsabfrage zur Verfügung.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Die Dateien liegen als normale Dateien im Dateisystem und lassen sich jederzeit mit externen Editoren, IDEs oder Tools bearbeiten.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Einfache Sicherung über reguläre Dateisystem-Backups (z. B. Time Machine, rsync oder Cloud-Sync).",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Nur in der installierten Desktop-App (Tauri) verfügbar, nicht im Web-Browser.",
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4(
                                [h.Class("help-heading")],
                                [viewIcon("folder", h), " Lokaler Ordner (FS API)"],
                              ),
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
                              h.h4(
                                [h.Class("help-heading")],
                                [viewIcon("package", h), " App-Speicher (OPFS)"],
                              ),
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
                                              h.th([]),
                                              h.th([], [viewIcon("desktop", h), " App (Tauri)"]),
                                              h.th([], [viewIcon("folder", h), " Lokaler Ordner"]),
                                              h.th([], [viewIcon("package", h), " App-Speicher"]),
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
                                              h.td([], ["nein (dauerhafter Zugriff)"]),
                                              h.td([], ["ja, bei jedem Start"]),
                                              h.td([], ["nein"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Andere Programme"]),
                                              h.td([], ["ja"]),
                                              h.td([], ["ja"]),
                                              h.td([], ["nein"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Anderer Browser"]),
                                              h.td([], ["ja, Ordner erneut wählen"]),
                                              h.td([], ["ja, Ordner erneut wählen"]),
                                              h.td([], ["nein"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Sicherung"]),
                                              h.td([], ["Dateisystem-Backup"]),
                                              h.td([], ["Dateisystem-Backup"]),
                                              h.td([], ["von Hand"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Verfügbar in"]),
                                              h.td([], ["Desktop-App (Tauri)"]),
                                              h.td([], ["nur Chromium"]),
                                              h.td([], ["allen modernen Browsern"]),
                                            ],
                                          ),
                                          h.tr(
                                            [h.Class("help-supported-row")],
                                            [
                                              h.td([], ["In dieser Umgebung"]),
                                              viewSupportCell("tauri", context.hasTauri, h),
                                              viewSupportCell("fsa", isFsaSupported, h),
                                              viewSupportCell("opfs", isOpfsSupported, h),
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
                                  "Im Web-Browser lässt sich die Speicherart jederzeit über das Zahnrad ",
                                  viewIcon("settings", h),
                                  " wechseln. In der Desktop-App (Tauri) wird direkt das native Dateisystem verwendet.",
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                  h.details(
                    [
                      h.Class("help-topic"),
                      h.Name("help-topic"),
                      h.DataAttribute("topic", "licenses"),
                      h.Open(isLicensesOpen),
                      h.OnToggle((isOpen) => Message.ToggledTopic({ topic: "licenses", isOpen })),
                    ],
                    [
                      h.summary(
                        [h.Class("help-topic-summary")],
                        [
                          h.span(
                            [h.Class("help-topic-marker"), h.AriaHidden(true)],
                            [viewIcon("file-code", h)],
                          ),
                          h.span([h.Class("help-topic-title")], ["Lizenzen & Open Source"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.p(
                            [],
                            [
                              h.strong([], ["PWA Islands"]),
                              " steht unter der ",
                              h.strong([], ["MIT-Lizenz"]),
                              ". Zum ",
                              h.a(
                                [
                                  h.Href("https://github.com/ssendev/pwa-islands"),
                                  h.Target("_blank"),
                                  h.Rel("noopener noreferrer"),
                                ],
                                ["Quellcode"],
                              ),
                              ".",
                            ],
                          ),
                          h.h4([], ["Web- / JavaScript-Abhängigkeiten"]),
                          viewDirectLicenseTable(NPM_DIRECT_RUNTIME_LICENSES, h),
                          h.details(
                            [h.Class("help-topic")],
                            [
                              h.summary(
                                [h.Class("help-topic-summary")],
                                [
                                  h.span(
                                    [h.Class("help-topic-title")],
                                    [
                                      `Transitive JavaScript-Abhängigkeiten (${NPM_TRANSITIVE_RUNTIME_LICENSES.length})`,
                                    ],
                                  ),
                                ],
                              ),
                              h.div(
                                [h.Class("help-topic-body")],
                                [viewTransitiveLicenseTable(NPM_TRANSITIVE_RUNTIME_LICENSES, h)],
                              ),
                            ],
                          ),
                          h.h4([], ["Desktop- / Native Abhängigkeiten (Tauri / Rust)"]),
                          viewDirectLicenseTable(TAURI_DIRECT_LICENSES, h),
                          h.details(
                            [h.Class("help-topic")],
                            [
                              h.summary(
                                [h.Class("help-topic-summary")],
                                [
                                  h.span(
                                    [h.Class("help-topic-title")],
                                    [
                                      `Transitive Rust-Crates (${TAURI_TRANSITIVE_LICENSES.length})`,
                                    ],
                                  ),
                                ],
                              ),
                              h.div(
                                [h.Class("help-topic-body")],
                                [viewTransitiveLicenseTable(TAURI_TRANSITIVE_LICENSES, h)],
                              ),
                            ],
                          ),
                          h.details(
                            [h.Class("help-topic")],
                            [
                              h.summary(
                                [h.Class("help-topic-summary")],
                                [
                                  h.span(
                                    [h.Class("help-topic-title")],
                                    [
                                      `Entwicklungsabhängigkeiten (${NPM_DIRECT_DEV_LICENSES.length})`,
                                    ],
                                  ),
                                ],
                              ),
                              h.div(
                                [h.Class("help-topic-body")],
                                [viewTransitiveLicenseTable(NPM_DIRECT_DEV_LICENSES, h)],
                              ),
                            ],
                          ),
                          h.details(
                            [h.Class("help-topic")],
                            [
                              h.summary(
                                [h.Class("help-topic-summary")],
                                [
                                  h.span(
                                    [h.Class("help-topic-title")],
                                    [
                                      `Transitive Entwicklungsabhängigkeiten (${NPM_TRANSITIVE_DEV_LICENSES.length})`,
                                    ],
                                  ),
                                ],
                              ),
                              h.div(
                                [h.Class("help-topic-body")],
                                [viewTransitiveLicenseTable(NPM_TRANSITIVE_DEV_LICENSES, h)],
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
                      h.Class("btn btn-primary icon-label-btn copy-dts-btn"),
                      h.AriaLabel("/api.d.ts kopieren"),
                      h.DataAttribute("tip", "/api.d.ts kopieren"),
                      h.Disabled(
                        CopyDtsState.match(model.copyDtsState, {
                          Idle: () => false,
                          Copying: () => true,
                          Copied: () => false,
                        }),
                      ),
                      h.OnClick(Message.ClickedCopyDts()),
                    ],
                    [
                      h.span(
                        [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                        [viewIcon("clipboard", h)],
                      ),
                      CopyDtsState.match(model.copyDtsState, {
                        Idle: () =>
                          h.span(
                            [h.Class("icon-label-btn-text")],
                            ["/api.d.ts", h.span([h.Class("copy-dts-action")], [" kopieren"])],
                          ),
                        Copying: () => h.span([h.Class("icon-label-btn-text")], ["Wird kopiert …"]),
                        Copied: () =>
                          h.span(
                            [h.Class("icon-label-btn-text")],
                            [viewIcon("check", h), " Kopiert!"],
                          ),
                      }),
                    ],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("help-btn-close"),
                      h.Class("btn btn-secondary icon-label-btn"),
                      h.AriaLabel("Schließen"),
                      h.DataAttribute("tip", "Schließen"),
                      h.OnClick(Message.ClickedClose()),
                    ],
                    [
                      h.span(
                        [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                        [viewIcon("close", h)],
                      ),
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
