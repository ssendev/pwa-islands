/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

declare const __APP_VERSION__: string
declare const __INSTALL_PACKAGE__: string | null

declare module "virtual:licenses-data" {
  interface RawSoftwareLicense {
    readonly name: string
    readonly version: string
    readonly license: string
    readonly url: string
  }

  interface LicensesData {
    readonly npmDirectRuntime: ReadonlyArray<RawSoftwareLicense>
    readonly npmTransitiveRuntime: ReadonlyArray<RawSoftwareLicense>
    readonly npmDirectDev: ReadonlyArray<RawSoftwareLicense>
    readonly npmTransitiveDev: ReadonlyArray<RawSoftwareLicense>
    readonly rustDirect: ReadonlyArray<RawSoftwareLicense>
    readonly rustTransitive: ReadonlyArray<RawSoftwareLicense>
  }

  const licensesData: LicensesData
  export default licensesData
}

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite"
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface FileSystemDirectoryHandle {
  values?(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>
  entries?(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>
}

interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: ReadonlyArray<string>
  readonly userChoice: Promise<{
    readonly outcome: "accepted" | "dismissed"
    readonly platform: string
  }>
  prompt(): Promise<void>
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent
  appinstalled: Event
}

interface Window {
  showDirectoryPicker?(options?: {
    id?: string
    mode?: "read" | "readwrite"
    startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos"
  }): Promise<FileSystemDirectoryHandle>
}
