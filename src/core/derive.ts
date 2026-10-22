import type { Action, BgEntry, Entry, GroupEntry, LayerId, Mat, Page, PageState, TextEntry } from "./types";

const turn = (m: Mat): number => m[3] ?? 0;
/** An angle in (−π, π]. */
const wrapAngle = (r: number): number => { const t = Math.PI * 2; let a = ((r % t) + t) % t; if (a > Math.PI) a -= t; return a; };
/** A move as stored: rotation left out when there is none, so older works keep their exact shape. */
const mat = (s: number, dx: number, dy: number, r: number): Mat => { const a = wrapAngle(r); return Math.abs(a) < 1e-12 ? [s, dx, dy] : [s, dx, dy, a]; };

/** Where a move takes a point. */
export function applyMat(m: Mat, x: number, y: number): [number, number] {
  const r = turn(m), c = Math.cos(r), s = Math.sin(r);
  return [m[0] * (c * x - s * y) + m[1], m[0] * (s * x + c * y) + m[2]];
}

/** Compose two moves: apply B first, then A. */
export function mul(A: Mat, B: Mat): Mat {
  const [x, y] = applyMat([A[0], A[1], A[2], turn(A)], B[1], B[2]);
  return mat(A[0] * B[0], x, y, turn(A) + turn(B));
}

/** The move that undoes `m`. */
export function invert(m: Mat): Mat {
  const s = 1 / m[0], r = -turn(m), c = Math.cos(r), n = Math.sin(r);
  return mat(s, -s * (c * m[1] - n * m[2]), -s * (n * m[1] + c * m[2]), r);
}

/** Move by (dx, dy), scale by k and turn by r around the point (cx, cy). */
export function around(cx: number, cy: number, k: number, r: number, dx = 0, dy = 0): Mat {
  const c = Math.cos(r), n = Math.sin(r);
  // p' = k·R·(p − c) + c + d
  return mat(k, cx + dx - k * (c * cx - n * cy), cy + dy - k * (n * cx + c * cy), r);
}

export const bgOf = (L: readonly Entry[] | undefined): BgEntry | null => {
  const first = L?.[0];
  return first && first.kind === "bg" ? first : null;
};

const textOnly = (G: readonly Entry[]): G is TextEntry[] => G.length > 0 && G.every((e) => e.kind === "text");

/**
 * Text moved with its layer stays text (still editable). Its box centre follows the move; turning
 * adds to its own rotation. The centre comes from the box size saved at the last edit.
 */
export function moveText(t: TextEntry, m: Mat): TextEntry {
  const w = t.w ?? 0, h = t.h ?? 0, k = m[0];
  const [cx, cy] = applyMat(m, t.x + w / 2, t.y + h / 2);
  const out: TextEntry = { ...t, x: cx - (w * k) / 2, y: cy - (h * k) / 2, size: t.size * k };
  if (t.w !== undefined) out.w = w * k;
  if (t.h !== undefined) out.h = h * k;
  const r = turn(m);
  if (r) { let deg = t.rot + (r * 180) / Math.PI; deg = ((deg + 180) % 360 + 360) % 360 - 180; out.rot = deg; }
  return out;
}

/**
 * Move or resize wraps a layer's content in a group. The layer colour stays first and unmoved
 * (it fills the whole paper), while its holes move with the content. A layer that holds only
 * text keeps it as text, so it stays editable.
 */
function wrapKeepBg(L: Entry[], m: Mat, src?: [number, number]): Entry[] {
  const bg = bgOf(L);
  const content = bg ? L.slice(1) : L;
  const wrap = (G: Entry[]): Entry[] => {
    if (!G.length) return [];
    if (textOnly(G)) return G.map((t) => moveText(t, m));
    const only = G[0];
    if (!src && G.length === 1 && only && only.kind === "group" && only.m) {
      const g: GroupEntry = { ...only, m: mul(m, only.m) };
      return [g];
    }
    const g: GroupEntry = { kind: "group", items: G, opacity: 1, m };
    if (src) g.src = src;
    return [g];
  };
  const out = wrap(content);
  if (bg) out.unshift({ ...bg, holes: wrap(bg.holes) });
  return out;
}

/** Apply one action to a state in place. Entry objects are never mutated, only replaced. */
export function applyAction(s: PageState, a: Action): void {
  switch (a.type) {
    case "add": {
      const at = Math.max(0, Math.min(a.index, s.order.length));
      s.order.splice(at, 0, a.id);
      s.layers[a.id] = a.copyOf ? [...(s.layers[a.copyOf] ?? [])] : a.image ? [a.image] : a.text ? [{ kind: "text", ...a.text }] : [];
      return;
    }
    case "del":
      s.order = s.order.filter((x) => x !== a.id);
      return;
    case "move": {
      const i = s.order.indexOf(a.id);
      if (i < 0) return;
      s.order.splice(i, 1);
      s.order.splice(Math.max(0, Math.min(a.to, s.order.length)), 0, a.id);
      return;
    }
    case "merge": {
      const upper = s.layers[a.id], lower = s.layers[a.into];
      if (!upper || !lower || !s.order.includes(a.id) || !s.order.includes(a.into)) return;
      // the upper layer, colour included, becomes one group in the lower layer
      s.layers[a.into] = [...lower, { kind: "group", items: [...upper], opacity: a.alpha }];
      s.order = s.order.filter((x) => x !== a.id);
      return;
    }
    case "draw": {
      const L = s.layers[a.layer];
      if (!L || !s.order.includes(a.layer)) return;
      L.push(a.entry);
      const bg = bgOf(L);
      if (bg && a.entry.kind === "stroke" && a.entry.brush === "eraserall") L[0] = { ...bg, holes: [...bg.holes, a.entry] };
      return;
    }
    case "clear": {
      const bg = bgOf(s.layers[a.layer]);
      if (s.layers[a.layer]) s.layers[a.layer] = bg ? [{ ...bg, holes: [] }] : [];
      return;
    }
    case "xform": {
      const L = s.layers[a.layer];
      if (L && L.length) s.layers[a.layer] = wrapKeepBg(L, a.m);
      return;
    }
    case "resize": {
      const src: [number, number] = [s.w, s.h];
      s.w = a.w;
      s.h = a.h;
      for (const id of s.order) {
        const L = s.layers[id];
        if (L && L.length) s.layers[id] = wrapKeepBg(L, a.m, src);
      }
      return;
    }
    case "bg": {
      const L = s.layers[a.layer];
      if (!L) return;
      const rest = bgOf(L) ? L.slice(1) : L;
      s.layers[a.layer] = a.color ? [{ kind: "bg", color: a.color, holes: [] }, ...rest] : rest;
      return;
    }
    case "textset":
    case "textflat": {
      const L = s.layers[a.layer];
      if (!L) return;
      const i = L.findIndex((e) => e.kind === "text" && e.tid === a.tid);
      if (i < 0) return;
      if (a.type === "textflat") L[i] = { kind: "image", img: a.img, x: 0, y: 0, w: a.w, h: a.h, opacity: 1 };
      else if (a.text) L[i] = { kind: "text", ...a.text };
      else L.splice(i, 1);
      return;
    }
  }
}

function startState(page: Page): PageState {
  const layers: Record<LayerId, Entry[]> = {};
  for (const [id, L] of Object.entries(page.base.layers)) layers[id] = [...L];
  return { w: page.base.w, h: page.base.h, order: [...page.base.order], layers };
}

/** The current state of a page: its base with every action replayed. */
export function derive(page: Page): PageState {
  const s = startState(page);
  for (const a of page.actions) applyAction(s, a);
  return s;
}

/** The layer that should be active: the requested one if it still exists, else the top layer. */
export function validActive(s: PageState, wanted: LayerId): LayerId | undefined {
  return s.order.includes(wanted) ? wanted : s.order[s.order.length - 1];
}
