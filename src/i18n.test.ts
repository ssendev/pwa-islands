import { Option } from "effect"
import { Command, given, message, model, story } from "foldkit/story"
import { describe, expect, it } from "vitest"

import { detectBrowserLanguage, formatDateTime, isLanguage, t, translations } from "./i18n"
import { Flags, Message, SaveDateFormat, SaveLanguage, SaveTimeFormat, init, update } from "./main"

const defaultFlags: Flags = {
  hasDirectoryPicker: true,
  hasOPFS: true,
  hasTauri: false,
  origin: "https://example.com",
}

const defaultUrl = {
  protocol: "https:",
  host: "example.com",
  port: Option.none(),
  pathname: "/",
  search: Option.none(),
  hash: Option.none(),
}

describe("i18n", () => {
  it("validates supported languages", () => {
    expect(isLanguage("de")).toBe(true)
    expect(isLanguage("en")).toBe(true)
    expect(isLanguage("fr")).toBe(false)
    expect(isLanguage(null)).toBe(false)
  })

  it("provides matching de and en translations", () => {
    expect(Object.keys(translations.de).sort()).toEqual(Object.keys(translations.en).sort())
    expect(t("de").settings.language).toBe("Sprache")
    expect(t("en").settings.language).toBe("Language")
    expect(t("de").toolbar.newFileLabel).toBe("Datei")
    expect(t("en").toolbar.newFileLabel).toBe("File")
    expect(t("de").files.versionHistoryFor("app.html")).toBe("Versionsverlauf für app.html")
    expect(t("en").files.versionHistoryFor("app.html")).toBe("Version history for app.html")
  })

  it("detects browser language with en fallback", () => {
    expect(["de", "en"]).toContain(detectBrowserLanguage())
  })

  it("defaults to en and uses de only when requested", () => {
    const defaultInit = init(defaultFlags, defaultUrl)
    expect(defaultInit.model.language).toBe("en")

    const deInit = init({ ...defaultFlags, language: "de" }, defaultUrl)
    expect(deInit.model.language).toBe("de")
  })

  it("updates language and dispatches SaveLanguage command on SelectedSettingsLanguage", () => {
    const initial = init(defaultFlags, defaultUrl).model

    story(
      update,
      given(initial),
      message(Message.SelectedSettingsLanguage({ language: "de" })),
      Command.resolve(SaveLanguage({ language: "de" }), Message.CompletedSaveLanguage()),
      model((nextModel) => {
        expect(nextModel.language).toBe("de")
      }),
    )
  })

  it("formats dates and times according to dateFormat and timeFormat settings", () => {
    const sample = new Date(2026, 2, 5, 14, 30, 0).getTime()
    expect(
      formatDateTime(sample, { language: "en", dateFormat: "iso", timeFormat: "24h" }),
    ).toContain("2026-03-05")
    expect(
      formatDateTime(sample, { language: "en", dateFormat: "iso", timeFormat: "24h" }),
    ).toContain("14:30")
    expect(
      formatDateTime(sample, { language: "en", dateFormat: "dmy", timeFormat: "24h" }),
    ).toContain("05.03.2026")
    expect(
      formatDateTime(sample, { language: "de", dateFormat: "mdy", timeFormat: "12h" }),
    ).toContain("03/05/2026")
  })

  it("updates dateFormat and timeFormat and dispatches save commands", () => {
    const initial = init(defaultFlags, defaultUrl).model

    story(
      update,
      given(initial),
      message(Message.SelectedSettingsDateFormat({ dateFormat: "iso" })),
      Command.resolve(SaveDateFormat({ dateFormat: "iso" }), Message.CompletedSaveDateFormat()),
      message(Message.SelectedSettingsTimeFormat({ timeFormat: "24h" })),
      Command.resolve(SaveTimeFormat({ timeFormat: "24h" }), Message.CompletedSaveTimeFormat()),
      model((nextModel) => {
        expect(nextModel.dateFormat).toBe("iso")
        expect(nextModel.timeFormat).toBe("24h")
      }),
    )
  })
})
