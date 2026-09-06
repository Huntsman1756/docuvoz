/**
 * Minimal ambient declarations for the File System Access API.
 *
 * TypeScript's bundled DOM lib covers `FileSystemFileHandle` and
 * `window.FileSystemFileHandle`, but omits `showOpenFilePicker` and the
 * `queryPermission` / `requestPermission` permission methods. These are
 * Chromium-only; the app guards every use with `supportsFileSystemAccess()`.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

type FileSystemPermissionState = "granted" | "denied" | "prompt";

interface FileSystemFileHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<FileSystemPermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<FileSystemPermissionState>;
}

interface FileSystemPickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface FileSystemPickerOptions {
  multiple?: boolean;
  types?: FileSystemPickerAcceptType[];
}

interface Window {
  showOpenFilePicker(options?: FileSystemPickerOptions): Promise<FileSystemFileHandle[]>;
}
