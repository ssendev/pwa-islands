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
                  h.th([], ["Package"]),
                  h.th([], ["Purpose"]),
                  h.th([], ["Version"]),
                  h.th([], ["License"]),
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
                  h.td([], [entry.description?.en ?? ""]),
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
            [h.tr([], [h.th([], ["Package"]), h.th([], ["Version"]), h.th([], ["License"])])],
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
          isSupported ? " available" : " not available",
        ],
      ),
    ],
  )

export const viewHelpEn = (
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
                  " Help",
                  h.span([h.Class("help-version-badge")], [`v${__APP_VERSION__}`]),
                ],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("modal-close-btn"),
                  h.AriaLabel("Close"),
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
                          h.span([h.Class("help-topic-title")], ["About PWA Islands"]),
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
                                  "Drop in HTML files, run them on a secure origin—no ",
                                  h.code([], ["file://"]),
                                  ", no server, no internet needed.",
                                ],
                              ),
                            ],
                          ),
                          h.p(
                            [h.Class("help-text")],
                            [
                              "PWA Islands lets you store, edit, and run single-file ",
                              h.code([], [".html"]),
                              " mini-apps locally on a secure origin. Use it directly in the browser as an offline-capable PWA, or install it as a native desktop/mobile app.",
                            ],
                          ),
                          h.h4([h.Class("help-subheading")], ["Features"]),
                          h.ul(
                            [h.Class("help-list")],
                            [
                              h.li(
                                [],
                                [
                                  h.strong([], ["Offline-first & secure origin"]),
                                  " — Run local ",
                                  h.code([], [".html"]),
                                  " files without ",
                                  h.code([], ["file://"]),
                                  " restrictions or an internet connection.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["PWA & Tauri"]),
                                  " — Works in the browser (File System API / OPFS) and as a native app (Linux, Windows, macOS, Android).",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Built-in editor"]),
                                  " — Inspect and edit your HTML apps in place with Monaco Editor.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Islands API"]),
                                  " — Give your mini-apps read/write access to files in the selected workspace folder via ",
                                  h.code([], ["import islands from '/api.js'"]),
                                  ".",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Multilingual UI"]),
                                  " — Supports English and German.",
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
                          h.span([h.Class("help-topic-title")], ["Edit with AI"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.p(
                            [h.Class("help-text")],
                            [
                              "Tip: Click ",
                              h.strong([], ["Create new file (+)"]),
                              " in the toolbar and choose the ready-made ",
                              h.strong([], ["PWA Island (with /api.js)"]),
                              " template under ",
                              h.strong([], ["Template"]),
                              " as a starting point.",
                            ],
                          ),
                          h.p(
                            [h.Class("help-text")],
                            [
                              h.strong([], ["With Chat API: "]),
                              "If an active provider is configured in ",
                              h.strong([], ["Settings → AI Chat"]),
                              " via ",
                              h.em([], ["+ Add provider"]),
                              " (or browser AI is available), select ",
                              viewIcon("ai", h),
                              " ",
                              h.strong([], ["Chat"]),
                              " in the mode menu at the bottom of the editor (",
                              viewIcon("edit", h),
                              " ▾) and type your requested changes directly into the chat box — the AI edits the file automatically.",
                            ],
                          ),
                          h.p(
                            [h.Class("help-text")],
                            [
                              h.strong([], ["Without Chat API (Copy mode via clipboard): "]),
                              "For ChatGPT, Claude, Gemini, etc., choose your ",
                              h.strong([], ["Edit format"]),
                              " (",
                              h.em([], ["Hash-Anchored Edits"]),
                              ", ",
                              h.em([], ["Search & Replace"]),
                              ", or ",
                              h.em([], ["Simplified Unified Diff"]),
                              ") in ",
                              h.strong([], ["Settings → AI Chat"]),
                              ":",
                            ],
                          ),
                          h.ol(
                            [h.Class("help-list")],
                            [
                              h.li(
                                [],
                                [
                                  h.strong([], ["Open Copy mode: "]),
                                  "Select ",
                                  viewIcon("clipboard", h),
                                  " ",
                                  h.strong([], ["Copy"]),
                                  " in the mode menu at the bottom of the editor (",
                                  viewIcon("edit", h),
                                  " ▾) to show the copy toolbar.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Copy file for AI: "]),
                                  "Choose ",
                                  h.strong([], ["With instructions"]),
                                  " (copies a short guide in the selected format, ",
                                  h.code([h.Class("help-path")], ["/api.d.ts"]),
                                  ", and the file) or ",
                                  h.strong([], ["File"]),
                                  " (file only — with ",
                                  h.code([h.Class("help-path")], ["LINE:HASH|"]),
                                  " prefixes for ",
                                  h.em([], ["Hash-Anchored Edits"]),
                                  ", otherwise as a regular code block). Use ",
                                  h.strong([], ["/app.d.ts"]),
                                  " if you only need to copy the API types.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Send to AI: "]),
                                  "Paste what you copied into your AI chat together with your requested changes.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Paste AI response: "]),
                                  "Copy the AI's response in the selected format and click ",
                                  h.strong([], ["Paste"]),
                                  ". On success, ",
                                  h.em([], ["Hash-Anchored Edits"]),
                                  " copies only the changed lines with their new hashes back to the clipboard; ",
                                  h.em([], ["Search & Replace"]),
                                  " and ",
                                  h.em([], ["Simplified Unified Diff"]),
                                  " clear the clipboard instead. On error, the error message is copied directly to the clipboard.",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Test: "]),
                                  "Clicking ",
                                  h.strong([], ["Preview"]),
                                  " opens the current content in a full-window preview without saving, while the editor stays open in the background for further edits (close via ",
                                  h.strong([], ["×"]),
                                  ", ",
                                  h.em([], ["Escape"]),
                                  ", or browser back).",
                                ],
                              ),
                              h.li(
                                [],
                                [
                                  h.strong([], ["Continue iterating: "]),
                                  "Send your next requested changes to the AI — for ",
                                  h.em([], ["Hash-Anchored Edits"]),
                                  " or an error from step 4, paste the automatically copied lines or error message from your clipboard first.",
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
                          h.span([h.Class("help-topic-title")], ["Building PWA Islands"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["What is an Island?"]),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "An Island is a single HTML file stored inside this app. It runs in the browser like a small standalone app and can read, write, and delete files via the Islands API.",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Creating an Island"]),
                              h.ol(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "Create a new ",
                                      h.code([h.Class("help-path")], [".html"]),
                                      " file via ",
                                      h.strong([], ["+ File"]),
                                      " (for example ",
                                      h.code([h.Class("help-path")], ["clock.html"]),
                                      ") or import an existing HTML file.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Import the API in your module: ",
                                      h.code(
                                        [h.Class("help-path")],
                                        ["import islands from '/api.js'"],
                                      ),
                                      ". This must be inside a ",
                                      h.code([h.Class("help-path")], ['<script type="module">']),
                                      " tag.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    ["Click the file in the list. It opens under its own path."],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Example"]),
                              h.pre(
                                [h.Class("help-code")],
                                [
                                  h.code(
                                    [],
                                    [
                                      `<script type="module">\n  import islands from '/api.js'\n\n  const entries = await islands.list()\n  await islands.write('notes/idea.txt', 'Hello World')\n  const content = await islands.read('notes/idea.txt')\n</script>`,
                                    ],
                                  ),
                                ],
                              ),
                              h.p(
                                [h.Class("help-hint")],
                                ["All paths are relative to the root of the selected folder."],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4(
                                [h.Class("help-heading")],
                                ["App startup and start pages (index.html)"],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "When opening the app, you land in the root directory (",
                                  h.code([h.Class("help-path")], ["/"]),
                                  ") by default.",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "Initially you see a file list because no start page exists yet.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "As soon as you create a file named ",
                                      h.code([h.Class("help-path")], ["index.html"]),
                                      ", it is loaded automatically when you open the app.",
                                    ],
                                  ),
                                ],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "This also applies to all subfolders: visiting ",
                                  h.code([h.Class("help-path")], ["/projects/"]),
                                  " automatically loads ",
                                  h.code([h.Class("help-path")], ["/projects/index.html"]),
                                  ". If the file is missing (or the requested path does not exist), the app shows the folder's file list instead.",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Edit mode (?pwaislands)"]),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "When the app is displaying a rendered page (such as ",
                                  h.code([h.Class("help-path")], ["index.html"]),
                                  "), you can switch back to the manager app using the ",
                                  h.code([h.Class("help-path")], ["?pwaislands"]),
                                  " query parameter:",
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
                                      " → Forces the root directory file list (even if an ",
                                      h.code([h.Class("help-path")], ["index.html"]),
                                      " exists).",
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Types for tools and AI agents"]),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "The file ",
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
                                  " describes the complete API with all TypeScript types. Copy it to your clipboard and provide it to an AI agent as context so it can write Islands without guessing the API.",
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
                            ["Storage: App (Tauri), FS API, and OPFS"],
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
                                  "Depending on the environment (web browser or native desktop app), PWA Islands supports different storage backends. In all cases, the Islands API works consistently with paths relative to the root of the selected project folder.",
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4(
                                [h.Class("help-heading")],
                                [viewIcon("desktop", h), " App (Tauri native file system)"],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "In the native desktop app, PWA Islands accesses the file system directly through Tauri. The project folder is chosen via the system file dialog.",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      h.strong([], ["Persistent access"]),
                                      ": Once selected, the folder is remembered and immediately available on every app launch without asking for permission again.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Files live as regular files on disk and can be edited anytime with external editors, IDEs, or tools.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Easy to back up with regular file system backups (e.g. Time Machine, rsync, or cloud sync).",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Only available in the installed desktop app (Tauri), not in the web browser.",
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
                                [viewIcon("folder", h), " Local Folder (FS API)"],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "A regular folder on your device, selected via ",
                                  h.code([h.Class("help-path")], ["showDirectoryPicker()"]),
                                  ". Files can be opened with other programs anytime and live on your file system, making them easy to back up along with their folder structure.",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "The folder handle is stored in IndexedDB. After a restart, however, ",
                                      h.strong([], ["permission"]),
                                      " is required again: the browser needs one click to re-grant access (“Allow access”).",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Renaming or moving the folder outside the browser invalidates the stored handle — simply select it again.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Only available in browsers supporting ",
                                      h.code([h.Class("help-path")], ["showDirectoryPicker"]),
                                      " (Chromium-based).",
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
                                [viewIcon("package", h), " App Storage (OPFS)"],
                              ),
                              h.p(
                                [h.Class("help-text")],
                                [
                                  "The ",
                                  h.em([], ["Origin Private File System"]),
                                  " is a private storage area managed by the browser, accessed via ",
                                  h.code(
                                    [h.Class("help-path")],
                                    ["navigator.storage.getDirectory()"],
                                  ),
                                  ". Everything is stored under the ",
                                  h.code([h.Class("help-path")], [OPFS_APP_FOLDER]),
                                  " folder.",
                                ],
                              ),
                              h.ul(
                                [h.Class("help-list")],
                                [
                                  h.li(
                                    [],
                                    [
                                      "Requires ",
                                      h.strong([], ["no folder selection and no permission"]),
                                      " — the app is ready to use immediately on startup.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "Files are ",
                                      h.strong([], ["tied to this browser"]),
                                      ": they are not visible in another browser or profile, and clearing site data deletes them.",
                                    ],
                                  ),
                                  h.li(
                                    [],
                                    ["Exporting to disk must be done manually (download file)."],
                                  ),
                                  h.li(
                                    [],
                                    [
                                      "The browser may evict storage when disk space is low; it is not meant for permanent archival.",
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [h.Class("help-section")],
                            [
                              h.h4([h.Class("help-heading")], ["Which one to use?"]),
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
                                              h.th([], [viewIcon("folder", h), " Local Folder"]),
                                              h.th([], [viewIcon("package", h), " App Storage"]),
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
                                              h.td([], ["Permission needed"]),
                                              h.td([], ["no (persistent access)"]),
                                              h.td([], ["yes, on every startup"]),
                                              h.td([], ["no"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Other programs"]),
                                              h.td([], ["yes"]),
                                              h.td([], ["yes"]),
                                              h.td([], ["no"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Other browser"]),
                                              h.td([], ["yes, re-select folder"]),
                                              h.td([], ["yes, re-select folder"]),
                                              h.td([], ["no"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Backup"]),
                                              h.td([], ["File system backup"]),
                                              h.td([], ["File system backup"]),
                                              h.td([], ["manual"]),
                                            ],
                                          ),
                                          h.tr(
                                            [],
                                            [
                                              h.td([], ["Available in"]),
                                              h.td([], ["Desktop app (Tauri)"]),
                                              h.td([], ["Chromium only"]),
                                              h.td([], ["all modern browsers"]),
                                            ],
                                          ),
                                          h.tr(
                                            [h.Class("help-supported-row")],
                                            [
                                              h.td([], ["In this environment"]),
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
                                  "In the web browser, you can switch the storage backend anytime via the gear icon ",
                                  viewIcon("settings", h),
                                  ". In the desktop app (Tauri), the native file system is used directly.",
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
                          h.span([h.Class("help-topic-title")], ["Licenses & Open Source"]),
                        ],
                      ),
                      h.div(
                        [h.Class("help-topic-body")],
                        [
                          h.p(
                            [],
                            [
                              h.strong([], ["PWA Islands"]),
                              " is licensed under the ",
                              h.strong([], ["MIT License"]),
                              ". View the ",
                              h.a(
                                [
                                  h.Href("https://github.com/ssendev/pwa-islands"),
                                  h.Target("_blank"),
                                  h.Rel("noopener noreferrer"),
                                ],
                                ["source code"],
                              ),
                              ".",
                            ],
                          ),
                          h.h4([], ["Web / JavaScript Dependencies"]),
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
                                      `Transitive JavaScript Dependencies (${NPM_TRANSITIVE_RUNTIME_LICENSES.length})`,
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
                          h.h4([], ["Desktop / Native Dependencies (Tauri / Rust)"]),
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
                                      `Transitive Rust Crates (${TAURI_TRANSITIVE_LICENSES.length})`,
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
                                      `Development Dependencies (${NPM_DIRECT_DEV_LICENSES.length})`,
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
                                      `Transitive Development Dependencies (${NPM_TRANSITIVE_DEV_LICENSES.length})`,
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
                      h.AriaLabel("Copy /api.d.ts"),
                      h.DataAttribute("tip", "Copy /api.d.ts"),
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
                            ["Copy ", h.span([h.Class("copy-dts-action")], ["/api.d.ts"])],
                          ),
                        Copying: () => h.span([h.Class("icon-label-btn-text")], ["Copying …"]),
                        Copied: () =>
                          h.span(
                            [h.Class("icon-label-btn-text")],
                            [viewIcon("check", h), " Copied!"],
                          ),
                      }),
                    ],
                  ),
                  h.button(
                    [
                      h.Type("button"),
                      h.Id("help-btn-close"),
                      h.Class("btn btn-secondary icon-label-btn"),
                      h.AriaLabel("Close"),
                      h.DataAttribute("tip", "Close"),
                      h.OnClick(Message.ClickedClose()),
                    ],
                    [
                      h.span(
                        [h.Class("icon-label-btn-icon"), h.AriaHidden(true)],
                        [viewIcon("close", h)],
                      ),
                      h.span([h.Class("icon-label-btn-text")], ["Close"]),
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
