import { describe, expect, it } from "vitest"
import {
  compareParsedVersions,
  filterHighestVersionPerKind,
  normalizeDownloadFilename,
  parseVersionString,
  renderDownloadsHtml,
  sanitizeDownloadsManifest,
  scanAvailableDownloads,
  serializeDownloadsManifest,
  type DownloadItem,
  type DownloadsManifest,
} from "../tools/downloads-page"

describe("downloads-page versioning", () => {
  it("entfernt sourcePath aus dem serialisierten Manifest", () => {
    const mockManifest: DownloadsManifest = {
      version: "0.1.153+",
      updatedAt: "2026-11-01T00:00:00.000Z",
      downloads: [
        {
          id: "linux-deb",
          platform: "Linux",
          title: "Debian (.deb)",
          filename: "pwa-islands_0.1.153_amd64.deb",
          url: "/downloads/pwa-islands_0.1.153_amd64.deb",
          size: "3.5 MB",
          bytes: 3500000,
          sha256: "abc",
          arch: "amd64",
          format: "deb",
          description: "Debian",
          sourcePath:
            "/home/user/src-tauri/target/release/bundle/deb/pwa-islands_0.1.153_amd64.deb",
        },
      ],
    }

    const sanitized = sanitizeDownloadsManifest(mockManifest)
    expect(sanitized.downloads[0].sourcePath).toBeUndefined()
    expect("sourcePath" in sanitized.downloads[0]).toBe(false)

    const serialized = serializeDownloadsManifest(mockManifest)
    expect(serialized).not.toContain("sourcePath")
    expect(serialized).not.toContain("/home/user/src-tauri")

    const html = renderDownloadsHtml(mockManifest)
    expect(html).toContain('<span class="hero-badge">Version 0.1.153+</span>')
  })

  it("normalisiert Paketnamen auf pwa-islands", () => {
    expect(normalizeDownloadFilename("PWA Islands_0.1.131_x64-setup.exe")).toBe(
      "pwa-islands_0.1.131_x64-setup.exe",
    )
    expect(normalizeDownloadFilename("PWA Islands_0.1.125_amd64.deb")).toBe(
      "pwa-islands_0.1.125_amd64.deb",
    )
    expect(normalizeDownloadFilename("PWA Islands_0.1.125_amd64.AppImage")).toBe(
      "pwa-islands_0.1.125_amd64.AppImage",
    )
    expect(normalizeDownloadFilename("PWA Islands-0.1.125-1.x86_64.rpm")).toBe(
      "pwa-islands-0.1.125-1.x86_64.rpm",
    )
  })
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

    const vWin = parseVersionString("PWA Islands_0.1.131_x64-setup.exe")
    expect(vWin).toEqual({
      raw: "0.1.131",
      major: 0,
      minor: 1,
      patch: 131,
      build: 0,
    })

    const vDirty = parseVersionString("PWA Islands_0.1.131+dirty_amd64.deb")
    expect(vDirty).toEqual({
      raw: "0.1.131",
      major: 0,
      minor: 1,
      patch: 131,
      build: 0,
    })

    const vPlus = parseVersionString("PWA Islands_0.1.131+_amd64.deb")
    expect(vPlus).toEqual({
      raw: "0.1.131",
      major: 0,
      minor: 1,
      patch: 131,
      build: 0,
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
      {
        id: "windows-exe",
        platform: "Windows",
        title: "Windows Installer (.exe)",
        filename: "pwa-islands_0.1.0_x64-setup.exe",
        url: "/downloads/pwa-islands_0.1.0_x64-setup.exe",
        size: "2.3 MB",
        bytes: 2300000,
        sha256: "hash7",
        arch: "x64",
        format: "exe",
        description: "Windows alt",
      },
      {
        id: "windows-exe",
        platform: "Windows",
        title: "Windows Installer (.exe)",
        filename: "pwa-islands_0.1.131_x64-setup.exe",
        url: "/downloads/pwa-islands_0.1.131_x64-setup.exe",
        size: "2.4 MB",
        bytes: 2400000,
        sha256: "hash8",
        arch: "x64",
        format: "exe",
        description: "Windows neu",
      },
    ]

    const filtered = filterHighestVersionPerKind(items)

    expect(filtered).toHaveLength(5)
    expect(filtered.map((item) => item.filename)).toEqual([
      "pwa-islands_0.1.125_universal.apk",
      "pwa-islands_0.1.131_x64-setup.exe",
      "pwa-islands_0.1.125_amd64.AppImage",
      "pwa-islands_0.1.125_amd64.deb",
      "pwa-islands-0.1.125-1.x86_64.rpm",
    ])
  })

  it("erkennt und filtert Windows-Builds in scanAvailableDownloads", () => {
    const manifestWindows = scanAvailableDownloads(process.cwd(), { targets: ["windows"] })
    expect(manifestWindows.downloads.some((d) => d.platform === "Windows")).toBe(true)
    expect(manifestWindows.downloads.every((d) => d.platform === "Windows")).toBe(true)

    const manifestExe = scanAvailableDownloads(process.cwd(), { targets: ["exe"] })
    expect(manifestExe.downloads.some((d) => d.platform === "Windows")).toBe(true)
    expect(manifestExe.downloads.every((d) => d.platform === "Windows")).toBe(true)

    const manifestAll = scanAvailableDownloads(process.cwd())
    expect(manifestAll.downloads.some((d) => d.platform === "Windows")).toBe(true)
  })

  it("enthält den WebView2 Link und erwähnt das Eigenständige Evergreen-Installationsprogramm", () => {
    const manifest = scanAvailableDownloads(process.cwd())
    const html = renderDownloadsHtml(manifest)
    expect(html).toContain("https://developer.microsoft.com/de-de/microsoft-edge/webview2")
    expect(html).toContain("Eigenständige")
    expect(html).toContain("Evergreen-Installationsprogramm")
    expect(html).toContain("ohne Internetverbindung")
  })
})
