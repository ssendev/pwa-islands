import { Array, Order, pipe } from "effect"
import { describe, expect, it } from "vitest"
import packageLockRaw from "../package-lock.json?raw"
import packageJsonRaw from "../package.json?raw"
import cargoLockRaw from "../src-tauri/Cargo.lock?raw"
import cargoTomlRaw from "../src-tauri/Cargo.toml?raw"
import {
  DIRECT_DESCRIPTIONS,
  NPM_DIRECT_DEV_LICENSES,
  NPM_DIRECT_RUNTIME_LICENSES,
  NPM_TRANSITIVE_DEV_LICENSES,
  NPM_TRANSITIVE_RUNTIME_LICENSES,
  TAURI_DIRECT_LICENSES,
  TAURI_TRANSITIVE_LICENSES,
  type SoftwareLicense,
} from "./licenses"

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

interface NameVersionLicense {
  readonly name: string
  readonly version: string
  readonly license: string
}

const extractPackageName = (lockPath: string): string => {
  const marker = "node_modules/"
  const lastIndex = lockPath.lastIndexOf(marker)
  if (lastIndex === -1) {
    return lockPath
  }
  return lockPath.slice(lastIndex + marker.length)
}

interface NameVersion {
  readonly name: string
  readonly version: string
}

const byNameThenVersion = Order.combine(
  Order.mapInput(Order.String, (entry: NameVersion) => entry.name),
  Order.mapInput(Order.String, (entry: NameVersion) => entry.version),
)

const dedupeByNameAndVersion = <T extends { readonly name: string; readonly version: string }>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const seen = new Set<string>()
  return Array.filter(entries, (entry) => {
    const key = `${entry.name}@${entry.version}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const toCoreFields = (entries: ReadonlyArray<SoftwareLicense>): ReadonlyArray<NameVersionLicense> =>
  Array.map(entries, ({ name, version, license }) => ({ name, version, license }))

const parseDirectCargoDependencies = (cargoToml: string): ReadonlyArray<string> => {
  const lines = cargoToml.split("\n")
  const initialState: { readonly inDeps: boolean; readonly names: ReadonlyArray<string> } = {
    inDeps: false,
    names: [],
  }

  const finalState = Array.reduce(lines, initialState, (state, rawLine) => {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) {
      return state
    }
    if (line.startsWith("[")) {
      const isDepsSection =
        line === "[dependencies]" ||
        (line.startsWith("[target.") && line.endsWith(".dependencies]"))
      return { inDeps: isDepsSection, names: state.names }
    }
    if (!state.inDeps) {
      return state
    }
    const eqIndex = line.indexOf("=")
    if (eqIndex === -1) {
      return state
    }
    const name = line.slice(0, eqIndex).trim()
    return { inDeps: true, names: [...state.names, name] }
  })

  return pipe(finalState.names, Array.dedupe, Array.sort(Order.String))
}

const parseCargoLockPackages = (
  cargoLock: string,
): ReadonlyArray<{ readonly name: string; readonly version: string }> => {
  const blocks = cargoLock.split("[[package]]").slice(1)
  return pipe(
    blocks,
    Array.flatMap((block) => {
      const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(block)
      const versionMatch = /^version\s*=\s*"([^"]+)"/m.exec(block)
      const sourceMatch = /^source\s*=\s*"([^"]+)"/m.exec(block)
      if (!nameMatch?.[1] || !versionMatch?.[1] || !sourceMatch?.[1]) {
        return []
      }
      return [{ name: nameMatch[1], version: versionMatch[1] }]
    }),
    dedupeByNameAndVersion,
    Array.sort(byNameThenVersion),
  )
}

describe("licenses", () => {
  it("lists all npm dependencies (direct, transitive, runtime, and dev) up to date with package-lock.json", () => {
    const packageJson = JSON.parse(packageJsonRaw) as PackageJson
    const lockJson = JSON.parse(packageLockRaw) as PackageLockJson

    const directRuntimeNames = new Set(Object.keys(packageJson.dependencies ?? {}))
    const directDevNames = new Set(Object.keys(packageJson.devDependencies ?? {}))

    const allLockEntries = pipe(
      Object.entries(lockJson.packages ?? {}),
      Array.filter(([lockPath]) => lockPath !== ""),
      Array.map(([lockPath, info]) => ({
        name: extractPackageName(lockPath),
        version: info.version ?? "",
        license: typeof info.license === "string" ? info.license : "UNKNOWN",
        isDev: Boolean(info.dev),
      })),
    )

    const normalize = (
      entries: ReadonlyArray<{
        readonly name: string
        readonly version: string
        readonly license: string
      }>,
    ): ReadonlyArray<NameVersionLicense> =>
      pipe(
        entries,
        Array.map(({ name, version, license }) => ({ name, version, license })),
        dedupeByNameAndVersion,
        Array.sort(byNameThenVersion),
      )

    const expectedDirectRuntime = normalize(
      Array.filter(allLockEntries, (e) => !e.isDev && directRuntimeNames.has(e.name)),
    )
    const expectedTransitiveRuntime = normalize(
      Array.filter(allLockEntries, (e) => !e.isDev && !directRuntimeNames.has(e.name)),
    )
    const expectedDirectDev = normalize(
      Array.filter(allLockEntries, (e) => e.isDev && directDevNames.has(e.name)),
    )
    const expectedTransitiveDev = normalize(
      Array.filter(allLockEntries, (e) => e.isDev && !directDevNames.has(e.name)),
    )

    expect(toCoreFields(NPM_DIRECT_RUNTIME_LICENSES)).toEqual(expectedDirectRuntime)
    expect(toCoreFields(NPM_TRANSITIVE_RUNTIME_LICENSES)).toEqual(expectedTransitiveRuntime)
    expect(toCoreFields(NPM_DIRECT_DEV_LICENSES)).toEqual(expectedDirectDev)
    expect(toCoreFields(NPM_TRANSITIVE_DEV_LICENSES)).toEqual(expectedTransitiveDev)

    Array.forEach(NPM_DIRECT_RUNTIME_LICENSES, (entry) => {
      expect(entry.description?.en.length).toBeGreaterThan(0)
      expect(entry.description?.de.length).toBeGreaterThan(0)
    })
  })

  it("lists all Tauri/Rust crates (direct and transitive) up to date with Cargo.toml and Cargo.lock", () => {
    const directNames = new Set(parseDirectCargoDependencies(cargoTomlRaw))
    const allCargoPackages = parseCargoLockPackages(cargoLockRaw)

    const expectedDirect = Array.filter(allCargoPackages, (pkg) => directNames.has(pkg.name))
    const expectedTransitive = Array.filter(allCargoPackages, (pkg) => !directNames.has(pkg.name))

    expect(Array.map(TAURI_DIRECT_LICENSES, ({ name, version }) => ({ name, version }))).toEqual(
      expectedDirect,
    )
    expect(
      Array.map(TAURI_TRANSITIVE_LICENSES, ({ name, version }) => ({ name, version })),
    ).toEqual(expectedTransitive)

    Array.forEach(TAURI_DIRECT_LICENSES, (entry) => {
      expect(entry.license.length).toBeGreaterThan(0)
      expect(entry.description?.en.length).toBeGreaterThan(0)
      expect(entry.description?.de.length).toBeGreaterThan(0)
    })
  })

  it("has no stale entries in DIRECT_DESCRIPTIONS", () => {
    const activeDirectNames = pipe(
      [
        ...Array.map(NPM_DIRECT_RUNTIME_LICENSES, (entry) => entry.name),
        ...Array.map(TAURI_DIRECT_LICENSES, (entry) => entry.name),
      ],
      Array.dedupe,
      Array.sort(Order.String),
    )
    const describedNames = pipe(Object.keys(DIRECT_DESCRIPTIONS), Array.sort(Order.String))

    expect(describedNames).toEqual(activeDirectNames)
  })
})
