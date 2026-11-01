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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (insertIdx !== -1) {
    args.splice(insertIdx, 0, "--config", JSON.stringify(configOverride))
    console.log(
      `[tauri] Dynamische Version gesetzt: ${displayVersion} (Tauri: ${tauriVersion}, Android versionCode: ${commitCount})`,
    )
  }

  const result = spawnSync(process.execPath, [tauriCli, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      APP_VERSION: displayVersion,
    },
  })

  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
