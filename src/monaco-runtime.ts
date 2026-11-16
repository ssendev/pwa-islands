import type * as Monaco from "monaco-editor"
import CssWorker from "monaco-editor/language/css/css.worker?worker"
import EditorWorker from "monaco-editor/editor/editor.worker?worker"
import HtmlWorker from "monaco-editor/language/html/html.worker?worker"
import JsonWorker from "monaco-editor/language/json/json.worker?worker"
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker"

const WORKER_BY_LABEL: Readonly<Record<string, new () => Worker>> = {
  json: JsonWorker,
  css: CssWorker,
  scss: CssWorker,
  less: CssWorker,
  html: HtmlWorker,
  handlebars: HtmlWorker,
  razor: HtmlWorker,
  typescript: TsWorker,
  javascript: TsWorker,
}

const globalWithMonaco = globalThis as typeof globalThis & {
  MonacoEnvironment?: Monaco.Environment
}

let monacoPromise: Promise<typeof Monaco> | undefined

/**
 * Lädt Monaco mit deutscher Lokalisierung.
 *
 * `monaco-editor/nls/lang/de` muss zwingend vor `monaco-editor` ausgewertet werden,
 * da Monaco bereits bei der Modul-Initialisierung `localize()` aufruft. Bei einem
 * statischen Import kann Vite/Rolldown die Chunks so aufteilen, dass `editor.api`
 * vor `de` ausgeführt wird.
 */
export function loadMonaco(): Promise<typeof Monaco> {
  if (monacoPromise === undefined) {
    monacoPromise = (async () => {
      if (globalWithMonaco.MonacoEnvironment === undefined) {
        globalWithMonaco.MonacoEnvironment = {
          getWorker(_workerId: string, label: string): Worker {
            const WorkerConstructor = WORKER_BY_LABEL[label] ?? EditorWorker
            return new WorkerConstructor()
          },
        }
      }
      await import("monaco-editor/nls/lang/de")
      return import("monaco-editor")
    })()
  }
  return monacoPromise
}
