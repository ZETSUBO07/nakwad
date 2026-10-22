import type { Action, Entry, WorkDoc } from "./types";

function fromEntry(e: Entry, out: Set<string>): void {
  switch (e.kind) {
    case "image":
    case "replace":
      out.add(e.img);
      return;
    case "group":
      for (const x of e.items) fromEntry(x, out);
      return;
    case "bg":
      for (const x of e.holes) fromEntry(x, out);
      return;
    default:
      return;
  }
}

function fromAction(a: Action, out: Set<string>): void {
  if (a.type === "add" && a.image) out.add(a.image.img);
  else if (a.type === "draw") fromEntry(a.entry, out);
  else if (a.type === "textflat") out.add(a.img);
}

/**
 * Every picture a work still refers to, including steps that could be redone.
 * Storage deletes pictures that are not in this set.
 */
export function imagesInUse(doc: WorkDoc): Set<string> {
  const out = new Set<string>();
  for (const p of doc.pages) {
    for (const L of Object.values(p.base.layers)) for (const e of L) fromEntry(e, out);
    for (const a of p.actions) fromAction(a, out);
    for (const a of p.redo) fromAction(a, out);
  }
  return out;
}

function fontsFromEntry(e: Entry, out: Set<string>): void {
  if (e.kind === "text") out.add(e.font);
  else if (e.kind === "group") for (const x of e.items) fontsFromEntry(x, out);
}

/** Every font name used by text in a work (including undo/redo steps), so backups can carry imported fonts. */
export function fontsInUse(doc: WorkDoc): Set<string> {
  const out = new Set<string>();
  for (const p of doc.pages) {
    for (const L of Object.values(p.base.layers)) for (const e of L) fontsFromEntry(e, out);
    for (const a of [...p.actions, ...p.redo]) {
      if (a.type === "add" && a.text) out.add(a.text.font);
      else if (a.type === "textset" && a.text) out.add(a.text.font);
    }
  }
  return out;
}
