import { isHexColor, isPaperColor, paperSizeProblem } from "../core";

/**
 * Small settings kept in the browser (localStorage), separate from the works themselves.
 * Losing them loses nothing important, so every read is checked and falls back to defaults.
 */
export interface Prefs {
  /** paper size and colour of the last new work ("use last" in the new-work dialog) */
  lastPaper: { w: number; h: number; paper: string } | null;
  /** last 5 paper colours picked by hand */
  paperRecent: string[];
}

export const DEFAULT_PREFS: Prefs = { lastPaper: null, paperRecent: [] };
const KEY = "nakwad.prefs";
export const RECENT_COLORS = 5;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read stored prefs, keeping only values that make sense. */
export function parsePrefs(raw: string | null): Prefs {
  let v: unknown;
  try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
  if (!isObj(v)) return { ...DEFAULT_PREFS, paperRecent: [] };
  const out: Prefs = { lastPaper: null, paperRecent: [] };
  const lp = v.lastPaper;
  if (isObj(lp) && typeof lp.w === "number" && typeof lp.h === "number" && !paperSizeProblem(lp.w, lp.h) && isPaperColor(lp.paper)) {
    out.lastPaper = { w: lp.w, h: lp.h, paper: lp.paper as string };
  }
  if (Array.isArray(v.paperRecent)) out.paperRecent = v.paperRecent.filter(isHexColor).map((c) => c.toLowerCase()).slice(0, RECENT_COLORS);
  return out;
}

/** Put a colour first in a recent list, without repeats. */
export function remember(list: readonly string[], color: string, max = RECENT_COLORS): string[] {
  if (!isHexColor(color)) return [...list];
  const c = color.toLowerCase();
  return [c, ...list.filter((x) => x !== c)].slice(0, max);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const local = (): StorageLike | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function loadPrefs(s: StorageLike | null = local()): Prefs {
  try { return parsePrefs(s?.getItem(KEY) ?? null); } catch { return parsePrefs(null); }
}

export function savePrefs(p: Prefs, s: StorageLike | null = local()): void {
  try { s?.setItem(KEY, JSON.stringify(p)); } catch { /* private window or full: settings are optional */ }
}
