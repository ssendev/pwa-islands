import { Array, Match, pipe } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import {
  init as initMd4x,
  parseAST,
  type ComarkElementAttributes,
  type ComarkNode,
} from "md4x/wasm"
import { viewIcon } from "./icons"

let initPromise: Promise<void> | undefined

export const initMarkdown = (): Promise<void> => {
  const promise = initPromise ?? initMd4x()
  initPromise = promise
  return promise
}

const isSafeHref = (href: string): boolean => {
  const trimmed = href.trim().toLowerCase()
  if (trimmed === "") {
    return false
  }
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) {
    return true
  }
  return (
    trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:")
  )
}

const isSafeImageSrc = (src: string): boolean => {
  const trimmed = src.trim().toLowerCase()
  if (trimmed === "") {
    return false
  }
  if (trimmed.startsWith("/")) {
    return true
  }
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("data:image/")
  )
}

const stringProp = (props: ComarkElementAttributes, key: string): string | undefined => {
  const value = props[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

const alignAttributes = <Message>(
  props: ComarkElementAttributes,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> => {
  const align = stringProp(props, "align")
  if (align === "left" || align === "center" || align === "right") {
    return [h.Style({ textAlign: align })]
  }
  return []
}

const extractPlainText = (nodes: ReadonlyArray<ComarkNode>): string =>
  pipe(
    nodes,
    Array.map((node) => {
      if (typeof node === "string") {
        return node
      }
      const [, , ...children] = node
      return extractPlainText(children)
    }),
    Array.join(""),
  )

const extractCodeLanguage = (
  props: ComarkElementAttributes,
  children: ReadonlyArray<ComarkNode>,
): string | undefined => {
  const direct = stringProp(props, "language") ?? stringProp(props, "lang")
  if (direct !== undefined) {
    return direct
  }
  const codeChild = children.find((child) => typeof child !== "string" && child[0] === "code")
  if (codeChild !== undefined && typeof codeChild !== "string") {
    const cls = stringProp(codeChild[1], "class")
    if (cls !== undefined && cls.startsWith("language-")) {
      return cls.slice("language-".length)
    }
  }
  return undefined
}

type SimpleTagBuilder<Message> = (
  attrs: ReadonlyArray<Attribute<Message>>,
  children?: ReadonlyArray<Html | string>,
) => Html

const simpleTagBuilders = <Message>(
  h: HtmlBuilder<Message>,
): Record<string, SimpleTagBuilder<Message>> => ({
  h1: h.h1,
  h2: h.h2,
  h3: h.h3,
  h4: h.h4,
  h5: h.h5,
  h6: h.h6,
  p: h.p,
  strong: h.strong,
  em: h.em,
  del: h.del,
  blockquote: h.blockquote,
  ul: h.ul,
  table: h.table,
  thead: h.thead,
  tbody: h.tbody,
  tr: h.tr,
})

type RenderOptions<Message> = {
  readonly onCopyCode?: (code: string) => Message
  readonly codeblocksOpen?: boolean
}

const renderNode = <Message>(
  node: ComarkNode,
  opts: RenderOptions<Message>,
  h: HtmlBuilder<Message>,
): Html | string => {
  if (typeof node === "string") {
    return node
  }

  const [tag, props, ...children] = node
  const renderedChildren = Array.map(children, (child) => renderNode(child, opts, h))

  if (tag === null) {
    return h.span([], renderedChildren)
  }

  const simpleBuilder = simpleTagBuilders(h)[tag]
  if (simpleBuilder !== undefined) {
    return simpleBuilder([], renderedChildren)
  }

  return Match.value(tag).pipe(
    Match.when("ol", () => {
      const start = props.start
      const attrs =
        typeof start === "number" && start !== 1 ? [h.Attribute("start", String(start))] : []
      return h.ol(attrs, renderedChildren)
    }),
    Match.when("li", () => {
      if (props.task === true) {
        return h.li(
          [h.Class("llm-markdown-task")],
          [
            h.input([h.Type("checkbox"), h.Checked(props.checked === true), h.Disabled(true)]),
            h.span([], renderedChildren),
          ],
        )
      }
      return h.li([], renderedChildren)
    }),
    Match.when("pre", () => {
      const filename = stringProp(props, "filename")
      const language = extractCodeLanguage(props, children)
      const label = filename ?? language ?? "Code"
      const codeText = extractPlainText(children).replace(/\n$/, "")
      const onCopyCode = opts.onCopyCode
      const copyButton =
        onCopyCode !== undefined
          ? h.button(
              [
                h.Type("button"),
                h.Class("btn btn-icon llm-markdown-copy-btn"),
                h.AriaLabel("Code kopieren"),
                h.DataAttribute("tip", "Code kopieren"),
                h.OnClick(onCopyCode(codeText)),
              ],
              [viewIcon("clipboard", h)],
            )
          : h.empty
      return h.details(
        [
          h.Class("llm-markdown-codeblock"),
          ...((opts.codeblocksOpen ?? true) ? [h.Attribute("open", "")] : []),
        ],
        [
          h.summary(
            [h.Class("llm-markdown-codeblock-header")],
            [h.span([h.Class("llm-markdown-filename")], [label])],
          ),
          copyButton !== h.empty
            ? h.div([h.Class("llm-markdown-copy-sticky")], [copyButton])
            : h.empty,
          h.pre([], renderedChildren),
        ],
      )
    }),
    Match.when("code", () => {
      const className = stringProp(props, "class")
      return h.code(className !== undefined ? [h.Class(className)] : [], renderedChildren)
    }),
    Match.when("a", () => {
      const href = stringProp(props, "href")
      if (href !== undefined && isSafeHref(href)) {
        const title = stringProp(props, "title")
        const attrs = [
          h.Href(href),
          h.Target("_blank"),
          h.Rel("noopener noreferrer"),
          ...(title !== undefined ? [h.Title(title)] : []),
        ]
        return h.a(attrs, renderedChildren)
      }
      return h.span([], renderedChildren)
    }),
    Match.when("img", () => {
      const src = stringProp(props, "src")
      const alt = stringProp(props, "alt")
      if (src !== undefined && isSafeImageSrc(src)) {
        const title = stringProp(props, "title")
        return h.img([
          h.Src(src),
          ...(alt !== undefined ? [h.Alt(alt)] : []),
          ...(title !== undefined ? [h.Title(title)] : []),
        ])
      }
      return alt !== undefined ? h.span([], [alt]) : h.empty
    }),
    Match.when("br", () => h.br([])),
    Match.when("hr", () => h.hr([])),
    Match.when("th", () => h.th(alignAttributes(props, h), renderedChildren)),
    Match.when("td", () => h.td(alignAttributes(props, h), renderedChildren)),
    Match.when("html", () => extractPlainText(children)),
    Match.when("comment", () => h.empty),
    Match.orElse(() => h.div([], renderedChildren)),
  )
}

export type ViewMarkdownOptions<Message> = {
  readonly heal?: boolean
  readonly onCopyCode?: (code: string) => Message
  readonly codeblocksOpen?: boolean
}

export const viewMarkdown = <Message>(
  markdown: string,
  opts: ViewMarkdownOptions<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  try {
    const tree = parseAST(markdown, { heal: opts.heal })
    const nodes = Array.map(tree.nodes, (node) =>
      renderNode(node, { onCopyCode: opts.onCopyCode, codeblocksOpen: opts.codeblocksOpen }, h),
    )
    return h.div([h.Class("llm-markdown")], nodes)
  } catch {
    return h.p([h.Class("llm-response-text")], [markdown])
  }
}

const detectFileLanguage = (trimmed: string): string | undefined => {
  if (!trimmed.includes("\n")) {
    return undefined
  }
  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith("<!doctype ") ||
    lower.startsWith("<html") ||
    lower.startsWith("<svg") ||
    (trimmed.startsWith("<") && trimmed.endsWith(">"))
  ) {
    return "html"
  }
  if (lower.startsWith("<?xml")) {
    return "xml"
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed)
      return "json"
    } catch {
      return undefined
    }
  }
  if (/^\d+:[a-z0-9]+\|/m.test(trimmed)) {
    return ""
  }
  if (trimmed.startsWith("#!/")) {
    return "sh"
  }
  return undefined
}

const wrapWithCodeFence = (content: string, lang: string): string => {
  const fence = content.includes("```") ? "````" : "```"
  return `${fence}${lang}\n${content}\n${fence}`
}

export const formatUserMessageMarkdown = (content: string): string => {
  const trimmed = content.trim()
  if (trimmed === "" || /```[\s\S]*```/.test(trimmed)) {
    return content
  }
  const lang = detectFileLanguage(trimmed)
  if (lang !== undefined) {
    return wrapWithCodeFence(trimmed, lang)
  }
  return content
}

export const viewUserMarkdown = <Message>(
  content: string,
  opts: ViewMarkdownOptions<Message>,
  h: HtmlBuilder<Message>,
): Html => viewMarkdown(formatUserMessageMarkdown(content), opts, h)
