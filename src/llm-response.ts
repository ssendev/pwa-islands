import { Array } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { viewMarkdown } from "./markdown"

export type LlmToolDetail = {
  readonly summary: string
  readonly name: string
  readonly arguments: string
  readonly result: string
}

export type LlmResponseProps<Message = never> = {
  readonly content: string
  readonly reasoning: string
  readonly isStreaming: boolean
  readonly assistantContent?: string
  readonly toolDetails?: ReadonlyArray<LlmToolDetail>
  readonly isThinkingMarkdown?: boolean
  readonly isContentMarkdown?: boolean
  readonly onToggleThinkingMarkdown?: Message
  readonly onToggleContentMarkdown?: Message
  readonly onCopyCode?: (code: string) => Message
}

const formatToolArguments = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed === "") {
    return ""
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return trimmed
  }
}

const viewMarkdownToggleButton = <Message>(
  isMarkdown: boolean,
  message: Message | undefined,
  label: string,
  h: HtmlBuilder<Message>,
) =>
  message !== undefined
    ? h.button(
        [
          h.Type("button"),
          h.Class("llm-markdown-toggle-btn"),
          h.AriaPressed(isMarkdown ? "true" : "false"),
          h.AriaLabel(label),
          h.OnClick(message),
        ],
        [isMarkdown ? "md" : "txt"],
      )
    : h.empty

export const view = <Message>(props: LlmResponseProps<Message>, h: HtmlBuilder<Message>) => {
  const toolDetails = props.toolDetails ?? []
  const hasToolDetails = Array.isReadonlyArrayNonEmpty(toolDetails)
  const displayContent = hasToolDetails ? (props.assistantContent ?? "") : props.content
  const hasReasoning = props.reasoning.trim() !== ""
  const hasContent = displayContent.trim() !== ""
  const isThinkingMarkdown = props.isThinkingMarkdown ?? true
  const isContentMarkdown = props.isContentMarkdown ?? true

  if (!hasReasoning && !hasContent && !hasToolDetails && !props.isStreaming) {
    return h.empty
  }

  return h.div(
    [h.Class("llm-response")],
    [
      hasReasoning
        ? h.div(
            [h.Class("llm-response-thinking")],
            [
              h.div(
                [h.Class("llm-response-section-header")],
                [
                  h.span(
                    [h.Class("llm-response-label")],
                    [props.isStreaming && !hasContent ? "Thinking …" : "Thinking"],
                  ),
                  viewMarkdownToggleButton(
                    isThinkingMarkdown,
                    props.onToggleThinkingMarkdown,
                    "Thinking-Markdown umschalten",
                    h,
                  ),
                ],
              ),
              isThinkingMarkdown
                ? viewMarkdown(
                    props.reasoning,
                    { heal: props.isStreaming, onCopyCode: props.onCopyCode },
                    h,
                  )
                : h.p([h.Class("llm-response-text")], [props.reasoning]),
            ],
          )
        : h.empty,
      hasContent
        ? h.div(
            [h.Class("llm-response-content")],
            [
              props.onToggleContentMarkdown !== undefined
                ? h.div(
                    [h.Class("llm-response-section-header")],
                    [
                      h.span([h.Class("llm-response-label")], ["Antwort"]),
                      viewMarkdownToggleButton(
                        isContentMarkdown,
                        props.onToggleContentMarkdown,
                        "Antwort-Markdown umschalten",
                        h,
                      ),
                    ],
                  )
                : h.empty,
              isContentMarkdown
                ? viewMarkdown(
                    displayContent,
                    { heal: props.isStreaming, onCopyCode: props.onCopyCode },
                    h,
                  )
                : h.p([h.Class("llm-response-text")], [displayContent]),
            ],
          )
        : h.empty,
      hasToolDetails
        ? h.div(
            [h.Class("llm-response-tools")],
            Array.map(toolDetails, (detail) => {
              const formattedArgs = formatToolArguments(detail.arguments)
              const trimmedResult = detail.result.trim()
              return h.details(
                [h.Class("llm-tool-details")],
                [
                  h.summary([h.Class("llm-tool-summary")], [detail.summary]),
                  h.div(
                    [h.Class("llm-tool-body")],
                    [
                      formattedArgs !== ""
                        ? h.div(
                            [h.Class("llm-tool-section")],
                            [
                              h.span([h.Class("llm-tool-section-label")], ["Argumente"]),
                              h.pre([h.Class("llm-tool-pre")], [h.code([], [formattedArgs])]),
                            ],
                          )
                        : h.empty,
                      trimmedResult !== ""
                        ? h.div(
                            [h.Class("llm-tool-section")],
                            [
                              h.span([h.Class("llm-tool-section-label")], ["Ergebnis"]),
                              h.pre([h.Class("llm-tool-pre")], [h.code([], [trimmedResult])]),
                            ],
                          )
                        : h.empty,
                    ],
                  ),
                ],
              )
            }),
          )
        : h.empty,
      props.isStreaming ? h.span([h.Class("llm-response-streaming")], ["Schreibt …"]) : h.empty,
    ],
  )
}
