import "monaco-editor/nls/lang/de"
import * as monaco from "monaco-editor"
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
  MonacoEnvironment?: monaco.Environment
}

if (globalWithMonaco.MonacoEnvironment === undefined) {
  globalWithMonaco.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      const WorkerConstructor = WORKER_BY_LABEL[label] ?? EditorWorker
      return new WorkerConstructor()
    },
  }
}

export { monaco }
