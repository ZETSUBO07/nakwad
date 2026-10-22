export type SaveStatus = "saved" | "dirty" | "saving" | "error";

type DocLike = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
type WinLike = Pick<Window, "addEventListener" | "removeEventListener">;

export interface AutoSaverOptions {
  /** does the actual save; must save the latest state when called */
  save: () => Promise<void>;
  /** called on every status change (the save pill in the UI) */
  onStatus?: (s: SaveStatus, error?: unknown) => void;
  /** wait after the last change before saving (spec: 1.5 s) */
  delayMs?: number;
  /** wait before trying again after a failed save */
  retryMs?: number;
  /** where to listen for the app being hidden; defaults to the page */
  events?: { document?: DocLike; window?: WinLike };
}

/**
 * Saves a short moment after the last change, and right away when the app is hidden or closed
 * (switching apps, HyperOS closing it). Never runs two saves at once: changes made during a save
 * are saved in the next round. A failed save is retried.
 */
export class AutoSaver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private dirty = false;
  private status: SaveStatus = "saved";
  private readonly delay: number;
  private readonly retry: number;
  private readonly doc: DocLike | undefined;
  private readonly win: WinLike | undefined;

  constructor(private readonly opts: AutoSaverOptions) {
    this.delay = opts.delayMs ?? 1500;
    this.retry = opts.retryMs ?? 5000;
    this.doc = opts.events ? opts.events.document : globalThis.document;
    this.win = opts.events ? opts.events.window : globalThis.window;
    this.doc?.addEventListener("visibilitychange", this.onVisibility);
    this.win?.addEventListener("pagehide", this.onHide);
  }

  get state(): SaveStatus {
    return this.status;
  }

  /** Something changed: save soon. */
  markDirty(): void {
    this.dirty = true;
    if (this.status !== "saving") this.setStatus("dirty");
    this.schedule(this.delay);
  }

  /** Save now if anything is unsaved, and wait for it (and any save already running). */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.running) await this.running;
    if (this.dirty) await this.saveNow();
  }

  dispose(): void {
    this.clearTimer();
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.win?.removeEventListener("pagehide", this.onHide);
  }

  private readonly onVisibility = () => { if (this.doc?.visibilityState === "hidden") void this.flush(); };
  private readonly onHide = () => { void this.flush(); };

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = undefined; void this.saveNow(); }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private setStatus(s: SaveStatus, error?: unknown): void {
    this.status = s;
    this.opts.onStatus?.(s, error);
  }

  private saveNow(): Promise<void> {
    if (this.running) return this.running.then(() => (this.dirty ? this.saveNow() : undefined));
    this.dirty = false;
    this.setStatus("saving");
    this.running = this.opts.save().then(
      () => {
        this.running = null;
        if (this.dirty) { this.setStatus("dirty"); this.schedule(this.delay); }
        else this.setStatus("saved");
      },
      (err: unknown) => {
        this.running = null;
        this.dirty = true;
        this.setStatus("error", err);
        this.schedule(this.retry);
      },
    );
    return this.running;
  }
}
