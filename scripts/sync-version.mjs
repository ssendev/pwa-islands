#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const tauriConfPath = join(rootDir, "src-tauri", "tauri.conf.json")
const backupPath = join(rootDir, "src-tauri", ".tauri.conf.json.backup")

const args = process.argv.slice(2)

if (args.includes("--restore")) {
  try {
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, tauriConfPath)
      unlinkSync(backupPath)
      console.log("[sync-version] src-tauri/tauri.conf.json wurde aus Backup wiederhergestellt.")
    } else {
      execFileSync("git", ["checkout", "src-tauri/tauri.conf.json"], {
        cwd: rootDir,
        stdio: "ignore",
      })
      console.log("[sync-version] src-tauri/tauri.conf.json wurde auf den Git-Stand zurückgesetzt.")
    }
  } catch (err) {
    console.warn("[sync-version] Zurücksetzen fehlgeschlagen:", err)
  }
  process.exit(0)
}

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
  return null
}

export function syncTauriVersion() {
  const commitCount = getCommitCount()
  if (commitCount === null) {
    console.log(
      "[sync-version] Git-Commit-Anzahl nicht verfügbar, Versionssynchronisierung übersprungen.",
    )
    return null
  }

  if (!existsSync(tauriConfPath)) {
    return null
  }

  const raw = readFileSync(tauriConfPath, "utf8")
  const conf = JSON.parse(raw)
  const baseVersion = "0.1"
  const newVersion = `${baseVersion}.${commitCount}`

  let changed = false
  if (conf.version !== newVersion) {
    conf.version = newVersion
    changed = true
  }

  if (!conf.bundle) {
    conf.bundle = {}
  }
  if (!conf.bundle.android) {
    conf.bundle.android = {}
  }
  if (conf.bundle.android.versionCode !== commitCount) {
    conf.bundle.android.versionCode = commitCount
    changed = true
  }

  if (changed) {
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, raw, "utf8")
    }
    const formatted = JSON.stringify(conf, null, 2) + "\n"
    writeFileSync(tauriConfPath, formatted, "utf8")
    console.log(
      `[sync-version] src-tauri/tauri.conf.json aktualisiert: version=${newVersion}, android.versionCode=${commitCount}`,
    )
  } else {
    console.log(
      `[sync-version] src-tauri/tauri.conf.json ist bereits aktuell: ${newVersion} (code: ${commitCount})`,
    )
  }

  return newVersion
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncTauriVersion()
}
