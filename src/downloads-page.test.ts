import { describe, expect, it } from "vitest"
import {
  compareParsedVersions,
  filterHighestVersionPerKind,
  parseVersionString,
  type DownloadItem,
} from "../tools/downloads-page"

describe("downloads-page versioning", () => {
  it("extrahiert Versionsnummern korrekt aus Paketdateinamen", () => {
    const vDebOld = parseVersionString("pwa-islands_0.1.0_amd64.deb")
    expect(vDebOld).toEqual({
      raw: "0.1.0",
      major: 0,
      minor: 1,
      patch: 0,
      build: 0,
    })

    const vDebNew = parseVersionString("pwa-islands_0.1.125_amd64.deb")
    expect(vDebNew).toEqual({
      raw: "0.1.125",
      major: 0,
      minor: 1,
      patch: 125,
      build: 0,
    })

    const vRpm = parseVersionString("pwa-islands-0.1.125-1.x86_64.rpm")
    expect(vRpm).toEqual({
      raw: "0.1.125",
      major: 0,
      minor: 1,
      patch: 125,
      build: 1,
    })
  })

  it("vergleicht Versionen korrekt", () => {
    const v1 = parseVersionString("pwa-islands_0.1.0_amd64.deb")!
    const v2 = parseVersionString("pwa-islands_0.1.125_amd64.deb")!
    const v3 = parseVersionString("pwa-islands-0.1.125-1.x86_64.rpm")!
    const v4 = parseVersionString("pwa-islands-0.1.125-2.x86_64.rpm")!

    expect(compareParsedVersions(v2, v1)).toBeGreaterThan(0)
    expect(compareParsedVersions(v1, v2)).toBeLessThan(0)
    expect(compareParsedVersions(v4, v3)).toBeGreaterThan(0)
  })

  it("filtert mehrere Versionen derselben Paketart auf die höchste Version", () => {
    const items: DownloadItem[] = [
      {
        id: "linux-appimage",
        platform: "Linux",
        title: "Linux AppImage",
        filename: "pwa-islands_0.1.125_amd64.AppImage",
        url: "/downloads/pwa-islands_0.1.125_amd64.AppImage",
        size: "100 MB",
        bytes: 100000000,
        sha256: "hash1",
        arch: "x86_64",
        format: "AppImage",
        description: "AppImage",
      },
      {
        id: "linux-deb",
        platform: "Linux",
        title: "Debian / Ubuntu (.deb)",
        filename: "pwa-islands_0.1.0_amd64.deb",
        url: "/downloads/pwa-islands_0.1.0_amd64.deb",
        size: "3 MB",
        bytes: 3000000,
        sha256: "hash2",
        arch: "amd64",
        format: "deb",
        description: "Debian alt",
      },
      {
        id: "linux-deb",
        platform: "Linux",
        title: "Debian / Ubuntu (.deb)",
        filename: "pwa-islands_0.1.125_amd64.deb",
        url: "/downloads/pwa-islands_0.1.125_amd64.deb",
        size: "3.5 MB",
        bytes: 3500000,
        sha256: "hash3",
        arch: "amd64",
        format: "deb",
        description: "Debian neu",
      },
      {
        id: "linux-rpm",
        platform: "Linux",
        title: "Fedora / openSUSE (.rpm)",
        filename: "pwa-islands-0.1.0-1.x86_64.rpm",
        url: "/downloads/pwa-islands-0.1.0-1.x86_64.rpm",
        size: "3 MB",
        bytes: 3000000,
        sha256: "hash4",
        arch: "x86_64",
        format: "rpm",
        description: "RPM alt",
      },
      {
        id: "linux-rpm",
        platform: "Linux",
        title: "Fedora / openSUSE (.rpm)",
        filename: "pwa-islands-0.1.125-1.x86_64.rpm",
        url: "/downloads/pwa-islands-0.1.125-1.x86_64.rpm",
        size: "3.5 MB",
        bytes: 3500000,
        sha256: "hash5",
        arch: "x86_64",
        format: "rpm",
        description: "RPM neu",
      },
      {
        id: "android-apk",
        platform: "Android",
        title: "Android (.apk)",
        filename: "pwa-islands_0.1.125_universal.apk",
        url: "/downloads/pwa-islands_0.1.125_universal.apk",
        size: "35 MB",
        bytes: 35000000,
        sha256: "hash6",
        arch: "universal",
        format: "apk",
        description: "Android",
      },
    ]

    const filtered = filterHighestVersionPerKind(items)

    expect(filtered).toHaveLength(4)
    expect(filtered.map((item) => item.filename)).toEqual([
      "pwa-islands_0.1.125_amd64.AppImage",
      "pwa-islands_0.1.125_amd64.deb",
      "pwa-islands-0.1.125-1.x86_64.rpm",
      "pwa-islands_0.1.125_universal.apk",
    ])
  })
})
