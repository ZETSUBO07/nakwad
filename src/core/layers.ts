import type { Action, LayerId, LayerProps, LayerStep, PageState } from "./types";

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

export interface BulkState {
  /** how many of the chosen layers are on the page */
  count: number;
  /** delete them all (at least one layer stays, none locked) */
  delete: boolean;
  /** merge them into one (two or more, none locked) */
  merge: boolean;
  /** some are locked: why delete and merge are off */
  locked: boolean;
  /** true: the hide button hides (some are shown); false: it shows them all */
  hide: boolean;
  /** true: the lock button locks (some are unlocked); false: it unlocks them all */
  lock: boolean;
}

/** Only the chosen layers that are on the page, bottom → top. */
const chosen = (order: readonly LayerId[], ids: Iterable<LayerId>) => { const set = new Set(ids); return order.filter((id) => set.has(id)); };

/** What the bar for several chosen layers can do now. */
export function bulkState(s: PageState, props: Readonly<Record<LayerId, LayerProps>>, ids: Iterable<LayerId>): BulkState {
  const sel = chosen(s.order, ids);
  const locked = sel.some((id) => !!props[id]?.locked);
  return {
    count: sel.length,
    delete: sel.length > 0 && sel.length < s.order.length && !locked,
    merge: sel.length >= 2 && !locked,
    locked,
    hide: sel.some((id) => props[id]?.visible !== false),
    lock: sel.some((id) => !props[id]?.locked),
  };
}

/** The undo step for several layer steps: a single one stays as it is. */
const asAction = (steps: LayerStep[]): Action => (steps.length === 1 && steps[0] ? steps[0] : { type: "multi", steps });

/**
 * Delete the chosen layers in one undo step. The active layer stays when it is kept; otherwise the
 * nearest kept layer below it becomes active (or above, when none is below). Null when it is not allowed.
 */
export function deleteMany(s: PageState, props: Readonly<Record<LayerId, LayerProps>>, ids: Iterable<LayerId>, active: LayerId): { action: Action; active: LayerId } | null {
  const sel = chosen(s.order, ids);
  if (!bulkState(s, props, sel).delete) return null;
  const gone = new Set(sel), at = s.order.indexOf(active);
  const kept = s.order.filter((id) => !gone.has(id));
  let next: LayerId | undefined = active;
  if (gone.has(active) || at < 0) next = [...s.order.slice(0, Math.max(0, at))].reverse().find((id) => !gone.has(id)) ?? kept[0];
  if (next === undefined) return null;
  return { action: asAction(sel.map((id) => ({ type: "del", id }))), active: next };
}

/**
 * Merge the chosen layers into the lowest of them, in one undo step. Each keeps its own opacity and
 * they stay in the same order among themselves. Null when it is not allowed.
 */
export function mergeMany(s: PageState, props: Readonly<Record<LayerId, LayerProps>>, ids: Iterable<LayerId>): { action: Action; into: LayerId } | null {
  const sel = chosen(s.order, ids);
  if (!bulkState(s, props, sel).merge) return null;
  const [into, ...rest] = sel as [LayerId, ...LayerId[]];
  return { action: asAction(rest.map((id) => ({ type: "merge", id, into, alpha: props[id]?.opacity ?? 1 }))), into };
}
