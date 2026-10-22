import { derive } from "./derive";
import type { Action, Entry, LayerId, Page } from "./types";

/** Undo steps kept per page (spec: 100). Older steps are folded into the page's base. */
export const HISTORY_LIMIT = 100;

/** Add an action as a new undo step. Clears redo. */
export function commit(page: Page, action: Action, limit = HISTORY_LIMIT): Page {
  let next: Page = { ...page, actions: [...page.actions, action], redo: [] };
  if (next.actions.length > limit) next = fold(next, next.actions.length - limit);
  return next;
}

/**
 * Replace the last step instead of adding one. Used while a value is being dragged
 * (for example a layer colour in the colour picker) so the whole drag is one undo step.
 */
export function replaceLast(page: Page, action: Action): Page {
  if (!page.actions.length) return commit(page, action);
  return { ...page, actions: [...page.actions.slice(0, -1), action], redo: [] };
}

export const canUndo = (page: Page): boolean => page.actions.length > 0;
export const canRedo = (page: Page): boolean => page.redo.length > 0;

export function undo(page: Page): Page {
  const last = page.actions[page.actions.length - 1];
  if (!last) return page;
  return { ...page, actions: page.actions.slice(0, -1), redo: [...page.redo, last] };
}

export function redo(page: Page): Page {
  const next = page.redo[page.redo.length - 1];
  if (!next) return page;
  return { ...page, actions: [...page.actions, next], redo: page.redo.slice(0, -1) };
}

/** Bake the first `n` actions into the base. The derived state does not change. */
export function fold(page: Page, n: number): Page {
  if (n <= 0) return page;
  const s = derive({ ...page, actions: page.actions.slice(0, n) });
  const layers: Record<LayerId, Entry[]> = {};
  for (const id of s.order) layers[id] = s.layers[id] ?? [];
  return { ...page, base: { w: s.w, h: s.h, order: s.order, layers }, actions: page.actions.slice(n) };
}
