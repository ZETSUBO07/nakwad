import type { Entry, Mat } from "./types";

/**
 * Whether two layer contents draw the same, checked cheaply, so the screen can skip redrawing
 * layers an undo did not touch. Entries are never changed in place, so the same object means the
 * same drawing. Replaying the history makes some wrappers anew each time (merged layers, moved
 * layers, layer colours, moved text): those are compared by their few fields, with what is inside
 * them again by object. False only means "draw it again", so it may err that way, never the other.
 */
export function sameEntries(a: readonly Entry[] | undefined, b: readonly Entry[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameEntry(a[i], b[i])) return false;
  return true;
}

const sameMat = (a: Mat | undefined, b: Mat | undefined) => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "group": {
      const g = b as typeof a;
      return a.opacity === g.opacity && sameMat(a.m, g.m) && a.src?.[0] === g.src?.[0] && a.src?.[1] === g.src?.[1] && sameEntries(a.items, g.items);
    }
    case "bg": {
      const g = b as typeof a;
      return a.color === g.color && sameEntries(a.holes, g.holes);
    }
    case "text":
      // small: compare every field
      return JSON.stringify(a) === JSON.stringify(b);
    default:
      return false;
  }
}
