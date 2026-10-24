/**
 * The Android back button (and back gesture). A web app gets it as a step back in the browser
 * history, so while back should do something inside the app (a work or a window is open) one
 * extra history entry is kept; back uses it up, the app does its step, and puts it back if it is
 * still needed. With nothing open there is no extra entry, so back leaves the app.
 *
 * Order of a back press: the top window (dialog) → the open menu or panel of the editor → the
 * editor itself (saved, back to the gallery) → leave the app.
 */

export interface BackHost {
  /** something is open that back should close */
  needed(): boolean;
  /** close the top thing; false when there was nothing to close */
  back(): boolean;
}

const MARK = { nakwad: "back" } as const;
let host: BackHost | null = null;
let armed = false;
/** history steps we took ourselves, whose popstate is not a back press */
let skip = 0;

export function initBack(h: BackHost): void {
  host = h;
  // a reload can leave us on our own entry: treat it as the extra one
  armed = (history.state as { nakwad?: string } | null)?.nakwad === MARK.nakwad;
  window.addEventListener("popstate", onPop);
  syncBack();
}

function onPop(): void {
  if (skip > 0) { skip--; return; }
  armed = false;
  if (!host) return;
  // the closing itself can open nothing, so check again afterwards
  host.back();
  syncBack();
}

/** Call after something opened or closed: keeps exactly one extra entry while back has work to do. */
export function syncBack(): void {
  if (!host) return;
  const need = host.needed();
  if (need && !armed) {
    history.pushState(MARK, "");
    armed = true;
  } else if (!need && armed) {
    armed = false;
    skip++;
    history.back();
  }
}

/** Close the top open dialog, if any. */
export function closeTopDialog(): boolean {
  const open = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
  const top = open[open.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
