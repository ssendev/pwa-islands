/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite"
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

/**
 * Chromium-Ereignis, mit dem der Browser eine Installation der PWA anbietet.
 * Feuert nur, wenn die App noch nicht installiert ist -- genau daran erkennt
 * das Zahnrad-Menue, ob der Eintrag "App installieren" erscheinen soll.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

interface WindowEventMap {
  beforeinstallprompt: InstallPromptEvent
  appinstalled: Event
}

interface Window {
  showDirectoryPicker?(options?: {
    id?: string
    mode?: "read" | "readwrite"
    startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos"
  }): Promise<FileSystemDirectoryHandle>
}
