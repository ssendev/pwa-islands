import { Array, Schema } from "effect"
import type * as Html from "foldkit/html"

import { viewIcon } from "./icons"

export const AlertVariant = Schema.Literals(["info", "warning", "danger"])
export type AlertVariant = typeof AlertVariant.Type

export const AlertBanner = Schema.Struct({
  message: Schema.String,
  variant: AlertVariant,
})
export type AlertBanner = typeof AlertBanner.Type

export const Toast = Schema.Struct({
  id: Schema.Number,
  message: Schema.String,
  variant: AlertVariant,
})
export type Toast = typeof Toast.Type

export const view = <Message>(
  toasts: ReadonlyArray<Toast>,
  onDismiss: (id: number) => Message,
  h: Html.HtmlBuilder<Message>,
): Html.Html => {
  const containerAttrs = [
    h.Id("toast-container"),
    h.Class("toast-container"),
    h.AriaLive("polite"),
    h.AriaLabel("Meldungen"),
  ]

  return Array.match(toasts, {
    onEmpty: () => h.div(containerAttrs),
    onNonEmpty: (nonEmptyToasts) =>
      h.div(
        containerAttrs,
        Array.map(nonEmptyToasts, (toast) =>
          h.keyed("div")(
            String(toast.id),
            [
              h.Class(`toast alert alert-${toast.variant} alert-dismissible`),
              h.Role(toast.variant === "danger" ? "alert" : "status"),
            ],
            [
              h.span([h.Class("alert-message")], [toast.message]),
              h.button(
                [
                  h.Type("button"),
                  h.Class("alert-close-btn"),
                  h.AriaLabel("Hinweis schließen"),
                  h.OnClick(onDismiss(toast.id)),
                ],
                [viewIcon("close", h)],
              ),
            ],
          ),
        ),
      ),
  })
}
