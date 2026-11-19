import { Array } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { getDocumentLanguage, type Language, t } from "./i18n"
import { viewIcon } from "./icons"
import { viewMarkdown } from "./markdown"
import { formatToolArguments } from "./tool-format"

export { formatToolArguments }

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
  readonly toolKeyPrefix?: string
  readonly isThinkingMarkdown?: boolean
  readonly isContentMarkdown?: boolean
  readonly rawToolKeys?: ReadonlyArray<string>
  readonly onToggleThinkingMarkdown?: Message
  readonly onToggleContentMarkdown?: Message
  readonly onToggleToolMarkdown?: (toolKey: string) => Message
  readonly onCopyCode?: (code: string) => Message
  readonly language?: Language
}

const viewToolSection = <Message>(
  label: string,
  text: string,
  copyLabel: string,
  toggleKey: string,
  isPrettyOrMarkdown: boolean,
  renderAsMarkdown: boolean,
  toggleLabel: string,
  props: LlmResponseProps<Message>,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("llm-tool-section")],
    [
      h.div(
        [h.Class("llm-response-section-header")],
        [
          h.span([h.Class("llm-tool-section-label")], [label]),
          h.div(
            [h.Class("llm-response-section-actions")],
            [
              viewHeaderCopyButton(text, props.onCopyCode, copyLabel, h),
              viewMarkdownToggleButton(
                isPrettyOrMarkdown,
                props.onToggleToolMarkdown !== undefined
                  ? props.onToggleToolMarkdown(toggleKey)
                  : undefined,
                toggleLabel,
                h,
              ),
            ],
          ),
        ],
      ),
      renderAsMarkdown
        ? viewMarkdown(text, { heal: props.isStreaming, onCopyCode: props.onCopyCode }, h)
        : h.pre([h.Class("llm-tool-pre")], [h.code([], [text])]),
    ],
  )

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

const viewHeaderCopyButton = <Message>(
  text: string,
  onCopy: ((text: string) => Message) | undefined,
  label: string,
  h: HtmlBuilder<Message>,
) =>
  onCopy !== undefined
    ? h.button(
        [
          h.Type("button"),
          h.Class("llm-markdown-toggle-btn"),
          h.AriaLabel(label),
          h.DataAttribute("tip", label),
          h.OnClick(onCopy(text)),
        ],
        [viewIcon("clipboard", h)],
      )
    : h.empty

export const view = <Message>(props: LlmResponseProps<Message>, h: HtmlBuilder<Message>) => {
  const toolDetails = props.toolDetails ?? []
  const hasToolDetails = Array.isReadonlyArrayNonEmpty(toolDetails)
  const isThinkingMarkdown = props.isThinkingMarkdown ?? true
  const isContentMarkdown = props.isContentMarkdown ?? true
  const displayContent =
    hasToolDetails && isContentMarkdown ? (props.assistantContent ?? "") : props.content
  const hasReasoning = props.reasoning.trim() !== ""
  const hasContent = displayContent.trim() !== ""
  const rawToolKeys = props.rawToolKeys ?? []
  const language = props.language ?? getDocumentLanguage()
  const text = t(language).llmResponse
  const toolKeyPrefix = props.toolKeyPrefix ?? "tool"

  const hasRawContent = props.content.trim() !== ""
  const showContentSection =
    hasContent || (hasToolDetails && hasRawContent && props.onToggleContentMarkdown !== undefined)

  if (!hasReasoning && !showContentSection && !hasToolDetails && !props.isStreaming) {
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
                    [props.isStreaming && !hasContent ? text.thinkingStreaming : text.thinking],
                  ),
                  h.div(
                    [h.Class("llm-response-section-actions")],
                    [
                      viewHeaderCopyButton(props.reasoning, props.onCopyCode, text.copyThinking, h),
                      viewMarkdownToggleButton(
                        isThinkingMarkdown,
                        props.onToggleThinkingMarkdown,
                        text.toggleThinkingMarkdown,
                        h,
                      ),
                    ],
                  ),
                ],
              ),
              isThinkingMarkdown
                ? viewMarkdown(
                    props.reasoning,
                    { heal: props.isStreaming, onCopyCode: props.onCopyCode, language },
                    h,
                  )
                : h.p([h.Class("llm-response-text")], [props.reasoning]),
            ],
          )
        : h.empty,
      showContentSection
        ? h.div(
            [h.Class("llm-response-content")],
            [
              props.onToggleContentMarkdown !== undefined
                ? h.div(
                    [h.Class("llm-response-section-header")],
                    [
                      h.span([h.Class("llm-response-label")], [text.answer]),
                      h.div(
                        [h.Class("llm-response-section-actions")],
                        [
                          hasContent
                            ? viewHeaderCopyButton(
                                displayContent,
                                props.onCopyCode,
                                text.copyAnswer,
                                h,
                              )
                            : h.empty,
                          viewMarkdownToggleButton(
                            isContentMarkdown,
                            props.onToggleContentMarkdown,
                            text.toggleAnswerMarkdown,
                            h,
                          ),
                        ],
                      ),
                    ],
                  )
                : h.empty,
              hasContent
                ? isContentMarkdown
                  ? viewMarkdown(
                      displayContent,
                      { heal: props.isStreaming, onCopyCode: props.onCopyCode, language },
                      h,
                    )
                  : h.p([h.Class("llm-response-text")], [displayContent])
                : h.empty,
            ],
          )
        : h.empty,
      hasToolDetails
        ? h.div(
            [
              h.Key(props.isStreaming ? "tools-streaming" : "tools-done"),
              h.Class("llm-response-tools"),
            ],
            Array.map(toolDetails, (detail, index) => {
              const toolKey = `${toolKeyPrefix}:${index}`
              const argsKey = `${toolKey}:args`
              const resultKey = `${toolKey}:result`
              const isArgsPretty = !rawToolKeys.includes(argsKey)
              const isResultMarkdown = !rawToolKeys.includes(resultKey)
              const argsText = isArgsPretty
                ? formatToolArguments(detail.arguments, detail.name)
                : detail.arguments
              const resultText = isResultMarkdown ? detail.result.trim() : detail.result
              return h.details(
                [
                  h.Class(props.isStreaming ? "llm-tool-details is-streaming" : "llm-tool-details"),
                  h.DataAttribute("tool-key", toolKey),
                  ...(props.isStreaming ? [h.Attribute("open", "")] : []),
                ],
                [
                  h.summary([h.Class("llm-tool-summary")], [detail.summary]),
                  h.div(
                    [h.Class("llm-tool-body")],
                    [
                      argsText !== ""
                        ? viewToolSection(
                            text.arguments,
                            argsText,
                            text.copyArguments,
                            argsKey,
                            isArgsPretty,
                            false,
                            text.toggleToolView,
                            props,
                            h,
                          )
                        : h.empty,
                      resultText !== ""
                        ? viewToolSection(
                            text.result,
                            resultText,
                            text.copyResult,
                            resultKey,
                            isResultMarkdown,
                            isResultMarkdown,
                            text.toggleResultMarkdown,
                            props,
                            h,
                          )
                        : h.empty,
                    ],
                  ),
                ],
              )
            }),
          )
        : h.empty,
      props.isStreaming
        ? h.span(
            [h.Class("llm-response-streaming"), h.Role("status"), h.AriaLabel(text.writing)],
            [
              h.span([h.Class("llm-response-streaming-dot")]),
              h.span([h.Class("llm-response-streaming-dot")]),
              h.span([h.Class("llm-response-streaming-dot")]),
            ],
          )
        : h.empty,
    ],
  )
}
