import type { HtmlBuilder } from "foldkit/html"

export type LlmResponseProps = {
  readonly content: string
  readonly reasoning: string
  readonly isStreaming: boolean
}

export const view = <Message>(props: LlmResponseProps, h: HtmlBuilder<Message>) => {
  const hasReasoning = props.reasoning.trim() !== ""
  const hasContent = props.content.trim() !== ""

  if (!hasReasoning && !hasContent && !props.isStreaming) {
    return h.empty
  }

  return h.div(
    [h.Class("llm-response")],
    [
      hasReasoning
        ? h.div(
            [h.Class("llm-response-thinking")],
            [
              h.span(
                [h.Class("llm-response-label")],
                [props.isStreaming && !hasContent ? "Thinking …" : "Thinking"],
              ),
              h.p([h.Class("llm-response-text")], [props.reasoning]),
            ],
          )
        : h.empty,
      hasContent
        ? h.div(
            [h.Class("llm-response-content")],
            [h.p([h.Class("llm-response-text")], [props.content])],
          )
        : h.empty,
      props.isStreaming ? h.span([h.Class("llm-response-streaming")], ["Schreibt …"]) : h.empty,
    ],
  )
}
