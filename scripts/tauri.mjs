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

const commitCount = getCommitCount()
const version = process.env.APP_VERSION?.trim() || `0.1.${commitCount}`

const configOverride = {
  version,
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

if (insertIdx !== -1) {
  args.splice(insertIdx, 0, "--config", JSON.stringify(configOverride))
  console.log(
    `[tauri] Dynamische Version gesetzt: ${version} (Android versionCode: ${commitCount})`,
  )
}

const result = spawnSync(process.execPath, [tauriCli, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    APP_VERSION: version,
  },
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
