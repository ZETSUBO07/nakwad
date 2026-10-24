import { BRUSHES, isHexColor, isPaperColor, paperSizeProblem, type BrushId } from "../core";
import type { FingerMode } from "../input";
import { isTbState, type TbState } from "./dock";

/**
 * Settings kept in the browser (localStorage), separate from the works themselves.
 * Losing them loses nothing important, so every read is checked and falls back to defaults.
 */
export type Hand = "left" | "right";
export type FontStyle = "bright" | "brush";
export interface BrushSetting { size: number; op: number }

export interface Prefs {
  /** paper size and colour of the last new work ("use last" in the new-work dialog) */
  lastPaper: { w: number; h: number; paper: string } | null;
  /** last 5 paper colours picked by hand */
  paperRecent: string[];
  /** which hand holds the pen: tools go on the other side */
  hand: Hand;
  finger: FingerMode;
  /** stroke smoothing 0–100 */
  stab: number;
  font: FontStyle;
  brush: BrushId;
  color: string;
  /** last 5 drawing colours picked by hand */
  colorRecent: string[];
  /** size and strength remembered per brush */
  brushes: Record<BrushId, BrushSetting>;
  /** toolbar place, kept apart for landscape and portrait */
  toolbar: { land?: TbState; port?: TbState };
  /** layer panel open; null = decide by screen width */
  layersOpen: boolean | null;
  /** when everything was last backed up on this device (ms), null = never */
  lastBackup: number | null;
  /** last text settings, used for the next text box */
  text: { font: string; size: number; align: "left" | "center" | "right" };
}
export const TEXT_SIZE_MIN = 8, TEXT_SIZE_MAX = 600;

/** Starting size (paper pixels) and strength (%) of each brush, as tried in the prototype. */
export const BRUSH_DEFAULTS: Record<BrushId, BrushSetting> = {
  pen: { size: 4, op: 100 },
  pencil: { size: 6, op: 85 },
  ink: { size: 14, op: 100 },
  nib: { size: 16, op: 100 },
  marker: { size: 24, op: 45 },
  spray: { size: 30, op: 80 },
  eraser: { size: 24, op: 100 },
  eraserall: { size: 24, op: 100 },
};
export const SIZE_MIN = 1, SIZE_MAX = 300, OP_MIN = 5, OP_MAX = 100;
/** The size slider covers 1–100; bigger sizes (up to SIZE_MAX) are typed in the number box. */
export const SIZE_SLIDER_MAX = 100;
/** The colours always on the toolbar. */
export const SWATCHES = ["#1d2230", "#e23b3b", "#f08c1a", "#f2c522", "#2fa65a", "#2f54d6", "#8a3fd1", "#ffffff"] as const;

export const RECENT_COLORS = 5;
/** Low smoothing by default (spec): the line keeps up with the pen. */
export const DEFAULT_STAB = 5;
const PREFS_VERSION = 2;
const KEY = "nakwad.prefs";

export function defaultPrefs(): Prefs {
  return {
    lastPaper: null, paperRecent: [], hand: "left", finger: "pen", stab: DEFAULT_STAB, font: "bright",
    brush: "pen", color: SWATCHES[0], colorRecent: [], brushes: structuredClone(BRUSH_DEFAULTS), toolbar: {}, layersOpen: null, lastBackup: null,
    text: { font: "Anuphan", size: 72, align: "left" },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
const colors = (v: unknown) => (Array.isArray(v) ? v.filter(isHexColor).map((c) => c.toLowerCase()).slice(0, RECENT_COLORS) : []);

/** Read stored prefs, keeping only values that make sense. */
export function parsePrefs(raw: string | null): Prefs {
  const out = defaultPrefs();
  let v: unknown;
  try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
  if (!isObj(v)) return out;
  const lp = v.lastPaper;
  if (isObj(lp) && typeof lp.w === "number" && typeof lp.h === "number" && !paperSizeProblem(lp.w, lp.h) && isPaperColor(lp.paper)) {
    out.lastPaper = { w: lp.w, h: lp.h, paper: lp.paper as string };
  }
  out.paperRecent = colors(v.paperRecent);
  out.colorRecent = colors(v.colorRecent);
  if (v.hand === "left" || v.hand === "right") out.hand = v.hand;
  if (v.finger === "pen" || v.finger === "draw") out.finger = v.finger;
  if (v.font === "bright" || v.font === "brush") out.font = v.font;
  out.stab = clampInt(v.stab, 0, 100, out.stab);
  // settings saved before version 2 hold the old default of 20, which made the line trail the pen
  if (v.v !== PREFS_VERSION && out.stab === 20) out.stab = DEFAULT_STAB;
  if (typeof v.brush === "string" && (BRUSHES as readonly string[]).includes(v.brush)) out.brush = v.brush as BrushId;
  if (isHexColor(v.color)) out.color = v.color.toLowerCase();
  if (isObj(v.brushes)) {
    for (const b of BRUSHES) {
      const s = v.brushes[b];
      if (isObj(s)) out.brushes[b] = { size: clampInt(s.size, SIZE_MIN, SIZE_MAX, BRUSH_DEFAULTS[b].size), op: clampInt(s.op, OP_MIN, OP_MAX, BRUSH_DEFAULTS[b].op) };
    }
  }
  if (typeof v.layersOpen === "boolean") out.layersOpen = v.layersOpen;
  if (typeof v.lastBackup === "number" && Number.isFinite(v.lastBackup) && v.lastBackup > 0) out.lastBackup = v.lastBackup;
  if (isObj(v.text)) {
    const tx = v.text;
    if (typeof tx.font === "string" && tx.font.length > 0 && tx.font.length <= 120) out.text.font = tx.font;
    out.text.size = clampInt(tx.size, TEXT_SIZE_MIN, TEXT_SIZE_MAX, out.text.size);
    if (tx.align === "left" || tx.align === "center" || tx.align === "right") out.text.align = tx.align;
  }
  if (isObj(v.toolbar)) {
    if (isTbState(v.toolbar.land)) out.toolbar.land = v.toolbar.land;
    if (isTbState(v.toolbar.port)) out.toolbar.port = v.toolbar.port;
  }
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
  try { s?.setItem(KEY, JSON.stringify({ ...p, v: PREFS_VERSION })); } catch { /* private window or full: settings are optional */ }
}

/** Show the chosen font style and hand on the page (CSS reads these classes). */
export function applyPrefsToPage(p: Prefs, body: HTMLElement = document.body): void {
  body.classList.toggle("font-brush", p.font === "brush");
  body.classList.toggle("hand-left", p.hand === "left");
  body.classList.toggle("hand-right", p.hand === "right");
}
