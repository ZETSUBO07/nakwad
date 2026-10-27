/**
 * The last 50 errors, kept in this browser only (never sent anywhere), for the diagnostics page.
 * Errors nobody caught also show a notice that the last saved work is safe, with a reload button.
 */

export interface ErrorEntry {
  /** when (ms since 1970) */
  t: number;
  /** "crash": nobody caught it · "logged": the app caught it and carried on */
  kind: "crash" | "logged";
  msg: string;
  /** stack or source, shortened */
  where?: string;
}

export const ERROR_KEEP = 50;
const KEY = "nakwad.errors";
const MSG_MAX = 500;
const WHERE_MAX = 1200;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const local = (): StorageLike | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

const isEntry = (v: unknown): v is ErrorEntry => {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.t === "number" && Number.isFinite(e.t) && (e.kind === "crash" || e.kind === "logged") && typeof e.msg === "string"
    && (e.where === undefined || typeof e.where === "string");
};

/** Stored list, with anything unreadable left out. */
export function parseErrors(raw: string | null): ErrorEntry[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(isEntry).slice(-ERROR_KEEP) : [];
  } catch {
    return [];
  }
}

/** The list with one more at the end, the oldest dropped past 50. */
export function addError(list: readonly ErrorEntry[], e: ErrorEntry): ErrorEntry[] {
  const entry: ErrorEntry = { t: e.t, kind: e.kind, msg: e.msg.slice(0, MSG_MAX) };
  if (e.where) entry.where = e.where.slice(0, WHERE_MAX);
  return [...list, entry].slice(-ERROR_KEEP);
}

/** A message and a place from anything that was thrown or logged. */
export function describeError(err: unknown): { msg: string; where?: string } {
  if (err instanceof Error) return err.stack ? { msg: `${err.name}: ${err.message}`, where: err.stack } : { msg: `${err.name}: ${err.message}` };
  if (typeof err === "string") return { msg: err };
  try { return { msg: JSON.stringify(err) ?? String(err) }; } catch { return { msg: String(err) }; }
}

export function loadErrors(s: StorageLike | undefined = local()): ErrorEntry[] {
  try { return parseErrors(s?.getItem(KEY) ?? null); } catch { return []; }
}

export function logError(e: ErrorEntry, s: StorageLike | undefined = local()): void {
  try { s?.setItem(KEY, JSON.stringify(addError(loadErrors(s), e))); } catch { /* storage full or blocked: nothing more to do */ }
}

export function clearErrors(s: StorageLike | undefined = local()): void {
  try { s?.removeItem(KEY); } catch { /* blocked */ }
}

let installed = false;

/**
 * Keep every error from now on: ones nobody caught (then `onCrash` runs) and ones the app logged
 * with console.error after catching them.
 */
export function installErrorLog(onCrash: () => void, now: () => number = Date.now): void {
  if (installed) return;
  installed = true;
  const crash = (err: unknown, fallback?: string) => {
    const d = describeError(err ?? fallback);
    logError({ t: now(), kind: "crash", ...d });
    onCrash();
  };
  window.addEventListener("error", (e) => crash(e.error, `${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => crash(e.reason));
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    const first = args.find((a) => a instanceof Error) ?? args.map((a) => (typeof a === "string" ? a : describeError(a).msg)).join(" ");
    logError({ t: now(), kind: "logged", ...describeError(first) });
  };
}
