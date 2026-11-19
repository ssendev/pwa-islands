import type * as Monaco from "monaco-editor"
import { getDocumentLanguage } from "./i18n"
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
 * Loads Monaco with German localization when the document language is `de`.
 *
 * `monaco-editor/nls/lang/de` must be evaluated before `monaco-editor`,
 * because Monaco already calls `localize()` during module initialization. With a
 * static import, Vite/Rolldown could split chunks so `editor.api` runs before `de`.
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
      if (getDocumentLanguage() === "de") {
        await import("monaco-editor/nls/lang/de")
      }
      return import("monaco-editor")
    })()
  }
  return monacoPromise
}
