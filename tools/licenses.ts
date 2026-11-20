import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const VIRTUAL_ID = "virtual:licenses-data"
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`
const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url))

interface LicenseEntry {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly url: string
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

interface LockPackage {
  readonly version?: string
  readonly license?: string
  readonly dev?: boolean
}

interface PackageLockJson {
  readonly packages?: Readonly<Record<string, LockPackage>>
}

interface CargoMetadataPackage {
  readonly name: string
  readonly version: string
  readonly license: string | null
  readonly source: string | null
  readonly dependencies?: ReadonlyArray<{ readonly name: string; readonly kind: string | null }>
}

interface CargoMetadata {
  readonly packages: ReadonlyArray<CargoMetadataPackage>
}

const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const extractPackageName = (lockPath: string): string => {
  const marker = "node_modules/"
  const lastIndex = lockPath.lastIndexOf(marker)
  if (lastIndex === -1) {
    return lockPath
  }
  return lockPath.slice(lastIndex + marker.length)
}

const sortAndDedupe = (entries: ReadonlyArray<LicenseEntry>): ReadonlyArray<LicenseEntry> => {
  const seen = new Set<string>()
  const unique: Array<LicenseEntry> = []
  for (const entry of entries) {
    const key = `${entry.name}@${entry.version}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(entry)
    }
  }
  return unique.sort((a, b) => compareString(a.name, b.name) || compareString(a.version, b.version))
}

const collectLicensesData = () => {
  const packageJson = JSON.parse(
    readFileSync(join(ROOT_DIR, "package.json"), "utf8"),
  ) as PackageJson
  const lockJson = JSON.parse(
    readFileSync(join(ROOT_DIR, "package-lock.json"), "utf8"),
  ) as PackageLockJson

  const directRuntimeNames = new Set(Object.keys(packageJson.dependencies ?? {}))
  const directDevNames = new Set(Object.keys(packageJson.devDependencies ?? {}))

  const npmDirectRuntime: Array<LicenseEntry> = []
  const npmTransitiveRuntime: Array<LicenseEntry> = []
  const npmDirectDev: Array<LicenseEntry> = []
  const npmTransitiveDev: Array<LicenseEntry> = []

  for (const [lockPath, info] of Object.entries(lockJson.packages ?? {})) {
    if (!lockPath) {
      continue
    }
    const name = extractPackageName(lockPath)
    const entry: LicenseEntry = {
      name,
      version: info.version ?? "",
      license: typeof info.license === "string" ? info.license : "UNKNOWN",
      url: `https://www.npmjs.com/package/${name}`,
    }
    if (info.dev) {
      if (directDevNames.has(name)) {
        npmDirectDev.push(entry)
      } else {
        npmTransitiveDev.push(entry)
      }
    } else if (directRuntimeNames.has(name)) {
      npmDirectRuntime.push(entry)
    } else {
      npmTransitiveRuntime.push(entry)
    }
  }

  const cargoMetaRaw = execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      join(ROOT_DIR, "src-tauri/Cargo.toml"),
      "--format-version",
      "1",
    ],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  )
  const cargoMeta = JSON.parse(cargoMetaRaw) as CargoMetadata
  const rootCrate = cargoMeta.packages.find((pkg) => pkg.source === null)
  const directCargoNames = new Set(
    (rootCrate?.dependencies ?? []).filter((dep) => dep.kind === null).map((dep) => dep.name),
  )

  const rustDirect: Array<LicenseEntry> = []
  const rustTransitive: Array<LicenseEntry> = []

  for (const pkg of cargoMeta.packages) {
    if (pkg.source === null) {
      continue
    }
    const entry: LicenseEntry = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || "UNKNOWN",
      url: `https://crates.io/crates/${pkg.name}`,
    }
    if (directCargoNames.has(pkg.name)) {
      rustDirect.push(entry)
    } else {
      rustTransitive.push(entry)
    }
  }

  return {
    npmDirectRuntime: sortAndDedupe(npmDirectRuntime),
    npmTransitiveRuntime: sortAndDedupe(npmTransitiveRuntime),
    npmDirectDev: sortAndDedupe(npmDirectDev),
    npmTransitiveDev: sortAndDedupe(npmTransitiveDev),
    rustDirect: sortAndDedupe(rustDirect),
    rustTransitive: sortAndDedupe(rustTransitive),
  }
}

export function licensesPlugin(): Plugin {
  let cachedModule: string | null = null

  return {
    name: "pwa-islands:licenses",
    resolveId(id) {
      if (id === VIRTUAL_ID) {
        return RESOLVED_VIRTUAL_ID
      }
      return undefined
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) {
        return undefined
      }
      if (cachedModule === null) {
        cachedModule = `export default ${JSON.stringify(collectLicensesData())}`
      }
      return cachedModule
    },
  }
}
