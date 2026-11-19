#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")

export function getCommitCount(dir = rootDir) {
  try {
    const stdout = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const count = parseInt(stdout, 10)
    if (!isNaN(count)) {
      return count
    }
  } catch {
    // Git nicht verfügbar
  }
  return 1
}

export function isGitDirty(dir = rootDir) {
  try {
    const stdout = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (!stdout) return false
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l && !l.endsWith("src-tauri/tauri.conf.json") && !l.endsWith(".tauri.conf.json.backup"),
      )
    return lines.length > 0
  } catch {
    return false
  }
}

const commitCount = getCommitCount()
const dirty = isGitDirty()
const rawAppVersion = process.env.APP_VERSION?.trim()
const displayVersion = rawAppVersion || `0.1.${commitCount}${dirty ? "+" : ""}`
// Tauri verlangt strikt gültiges SemVer (nach '+' muss ein Bezeichner wie 'dirty' folgen).
// Ein einfaches '0.1.30+' führt bei tauri-build zu einem Fehler.
const tauriVersion = rawAppVersion
  ? rawAppVersion.endsWith("+")
    ? `${rawAppVersion}dirty`
    : rawAppVersion
  : `0.1.${commitCount}${dirty ? "+dirty" : ""}`

const configOverride = {
  version: tauriVersion,
  bundle: {
    android: {
      versionCode: commitCount,
    },
  },
}

const tauriCli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url))

const rawArgs = process.argv.slice(2)
const args = [...rawArgs]

// Position ermitteln, an der --config eingefügt werden kann:
// Bei 'android build ...' oder 'ios build ...' -> nach dem Subcommand (Index 2)
// Bei 'build ...' oder 'dev ...' -> nach dem Subcommand (Index 1)
let insertIdx = -1

if (args[0] === "android" || args[0] === "ios") {
  if (args[1] === "build" || args[1] === "dev") {
    insertIdx = 2
  }
} else if (args[0] === "build" || args[0] === "dev") {
  insertIdx = 1
}

const BUNDLE_TO_EXT = {
  appimage: "AppImage",
  deb: "deb",
  rpm: "rpm",
  nsis: "exe",
  msi: "msi",
  dmg: "dmg",
}

function getFlagValue(argv, flags) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    for (const flag of flags) {
      if (arg === flag && i + 1 < argv.length) return argv[i + 1]
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
    }
  }
  return null
}

function inferArch(target) {
  if (target) {
    if (target.includes("aarch64") || target.includes("arm64")) return "arm64"
    if (target.includes("x86_64") || target.includes("x64")) return "x64"
  }
  return process.arch === "arm64" ? "arm64" : "x64"
}

function defaultBundlesFor(target) {
  if (target?.includes("windows") || (!target && process.platform === "win32")) {
    return ["nsis", "msi"]
  }
  if (target?.includes("darwin") || (!target && process.platform === "darwin")) {
    return ["dmg"]
  }
  return ["deb", "rpm", "appimage"]
}

function runTauri(cliArgs, installPackage) {
  const env = {
    ...process.env,
    APP_VERSION: displayVersion,
    ...(installPackage ? { VITE_INSTALL_PACKAGE: installPackage } : {}),
  }
  if (installPackage) {
    console.log(`[tauri] VITE_INSTALL_PACKAGE=${installPackage}`)
  }
  const result = spawnSync(process.execPath, [tauriCli, ...cliArgs], {
    stdio: "inherit",
    env,
  })
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (insertIdx !== -1) {
    args.splice(insertIdx, 0, "--config", JSON.stringify(configOverride))
    console.log(
      `[tauri] Dynamische Version gesetzt: ${displayVersion} (Tauri: ${tauriVersion}, Android versionCode: ${commitCount})`,
    )
  }

  const isAndroidBuild = rawArgs[0] === "android" && rawArgs[1] === "build"
  const isDesktopBuild = rawArgs[0] === "build"

  if (isAndroidBuild) {
    const pkg = process.env.VITE_INSTALL_PACKAGE?.trim() || "pwa-islands.universal.apk"
    runTauri(args, pkg)
  } else if (isDesktopBuild) {
    const target = getFlagValue(rawArgs, ["--target", "-t"])
    const arch = inferArch(target)
    const explicitBundles = getFlagValue(rawArgs, ["--bundles", "-b"])

    if (explicitBundles) {
      const ext = BUNDLE_TO_EXT[explicitBundles.toLowerCase()]
      const pkg =
        process.env.VITE_INSTALL_PACKAGE?.trim() || (ext ? `pwa-islands.${arch}.${ext}` : null)
      runTauri(args, pkg)
    } else if (process.env.VITE_INSTALL_PACKAGE?.trim()) {
      runTauri(args, process.env.VITE_INSTALL_PACKAGE.trim())
    } else {
      for (const bundle of defaultBundlesFor(target)) {
        const ext = BUNDLE_TO_EXT[bundle]
        const pkg = `pwa-islands.${arch}.${ext}`
        runTauri([...args, "--bundles", bundle], pkg)
      }
    }
  } else {
    runTauri(args, process.env.VITE_INSTALL_PACKAGE?.trim() || null)
  }
  process.exit(0)
}
