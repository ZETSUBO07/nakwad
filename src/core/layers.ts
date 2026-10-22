import type { LayerId, LayerProps, PageState } from "./types";

/**
 * Layer panel rules, kept apart from the screen so they are tested on their own.
 * `order` runs bottom → top; the panel shows it top → bottom.
 */

export type MoveWhere = "top" | "up" | "down" | "bottom";

/** Index in `order` that moving `id` to `where` gives, or null when it is already there. */
export function moveTarget(order: readonly LayerId[], id: LayerId, where: MoveWhere): number | null {
  const i = order.indexOf(id), last = order.length - 1;
  if (i < 0) return null;
  const to = where === "top" ? last : where === "bottom" ? 0 : where === "up" ? Math.min(last, i + 1) : Math.max(0, i - 1);
  return to === i ? null : to;
}

/**
 * Dragging a row in the panel: `slot` is the gap it is dropped into, counted from the top of the
 * list (0 = above the first row, n = below the last). Returns the index in `order`, or null if it
 * would not move.
 */
export function dropTarget(order: readonly LayerId[], id: LayerId, slot: number): number | null {
  const n = order.length, from = order.indexOf(id);
  if (from < 0) return null;
  const row = n - 1 - from; // where the row is in the panel
  const s = Math.max(0, Math.min(n, slot));
  if (s === row || s === row + 1) return null;
  // the list without the dragged row, then its new place in that list, turned back into an order index
  const panelIndex = s > row ? s - 1 : s;
  return n - 1 - panelIndex;
}

export interface LayerMenuState {
  top: boolean;
  up: boolean;
  down: boolean;
  bottom: boolean;
  duplicate: boolean;
  merge: boolean;
  clear: boolean;
  delete: boolean;
}

/** Which layer menu items can be used now (the others are shown dimmed). */
export function layerMenuState(s: PageState, props: Readonly<Record<LayerId, LayerProps>>, id: LayerId, maxLayers: number): LayerMenuState {
  const i = s.order.indexOf(id), n = s.order.length;
  const locked = !!props[id]?.locked;
  const below = i > 0 ? s.order[i - 1] : undefined;
  const hasContent = (s.layers[id] ?? []).some((e) => e.kind !== "bg" || e.holes.length > 0);
  return {
    top: i >= 0 && i < n - 1,
    up: i >= 0 && i < n - 1,
    down: i > 0,
    bottom: i > 0,
    duplicate: i >= 0 && n < maxLayers,
    // merging changes the layer below and removes this one: neither may be locked
    merge: !!below && !locked && !props[below]?.locked,
    clear: i >= 0 && !locked && hasContent,
    delete: i >= 0 && n > 1 && !locked,
  };
}

/** A layer can take strokes when it exists, is shown and is not locked. */
export function drawBlock(s: PageState, props: Readonly<Record<LayerId, LayerProps>>, id: LayerId): "missing" | "hidden" | "locked" | null {
  if (!s.order.includes(id)) return "missing";
  if (props[id]?.locked) return "locked";
  if (props[id] && !props[id].visible) return "hidden";
  return null;
}
