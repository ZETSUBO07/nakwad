/**
 * Offline and updates (spec "ตัวแอป PWA"). The service worker keeps every app file so the app opens
 * without a network. A new version is fetched in the background while the app is used and waits;
 * it takes over the next time the app is opened, before any work is open, so the page never
 * reloads in the middle of drawing.
 */

/** The parts of a registration this file uses (a fake one stands in for it in the unit tests). */
export interface RegistrationLike {
  readonly waiting: { postMessage(msg: unknown): void } | null;
}

export interface ContainerLike {
  readonly controller: unknown;
  register(url: string, opts: { scope: string }): Promise<RegistrationLike>;
  addEventListener(type: "controllerchange", fn: () => void): void;
}

export interface OfflineOptions {
  /** where the app lives, e.g. "/nakwad/" */
  base: string;
  /** true while it is safe to reload: the app has just opened and no work is open */
  idle(): boolean;
  reload(): void;
  /** the switch happened while something got opened: reload at the next safe moment instead */
  reloadLater(): void;
}

export type OfflineResult = "unsupported" | "ready" | "updating" | "failed";

/** Register the service worker; if a new version is already waiting and nothing is open, switch to it. */
export async function startOffline(sw: ContainerLike | undefined, o: OfflineOptions): Promise<OfflineResult> {
  if (!sw) return "unsupported";
  let reg: RegistrationLike;
  try {
    reg = await sw.register(`${o.base}sw.js`, { scope: o.base });
  } catch (err) {
    console.error(err);
    return "failed";
  }
  // a waiting version with no page using the old one yet is a first install: nothing to switch
  if (!reg.waiting || !sw.controller || !o.idle()) return "ready";
  let reloaded = false;
  sw.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    if (o.idle()) o.reload(); else o.reloadLater();
  });
  reg.waiting.postMessage({ type: "SKIP_WAITING" });
  return "updating";
}
