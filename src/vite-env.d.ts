/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

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
