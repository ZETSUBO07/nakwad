/**
 * Why a storage operation failed. The UI turns the kind into a message from the text file.
 * - quota: the device is out of space; nothing already saved was lost
 * - unavailable: this browser window cannot store data (private mode, blocked site data)
 * - missing: the work no longer exists
 * - newer: the work was saved by a newer version of the app; it is left untouched
 * - invalid: the stored data failed validation; it is left untouched
 * - backup: a backup file is damaged or not from this app
 */
export type StorageErrorKind = "quota" | "unavailable" | "missing" | "newer" | "invalid" | "backup";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly details: readonly string[];
  constructor(kind: StorageErrorKind, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "StorageError";
    this.kind = kind;
    this.details = details;
  }
}

/** Map browser errors to StorageError; anything unexpected is passed through. */
export function asStorageError(err: unknown): unknown {
  if (err instanceof StorageError) return err;
  const name = err instanceof Error || (typeof DOMException !== "undefined" && err instanceof DOMException) ? (err as Error).name : "";
  if (name === "QuotaExceededError") return new StorageError("quota", "storage is full");
  if (name === "InvalidStateError" || name === "SecurityError" || name === "UnknownError") return new StorageError("unavailable", `storage unavailable: ${name}`);
  return err;
}
