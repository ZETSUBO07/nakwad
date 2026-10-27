import { t, type MessageKey } from "../i18n";
import { openDialog } from "./dialog";
import { button, h } from "./dom";
import type { Prefs } from "./prefs";

export interface SettingsHost {
  prefs: Prefs;
  savePrefs(): void;
  /** something changed that the page or the editor must apply */
  applied(what: "hand" | "finger" | "font" | "stab"): void;
  resetToolbar(): void;
  /** close settings and open the diagnostics page */
  diagnostics(): void;
}

/** One choice out of a few, shown as a row of buttons (radio group). */
function segment<T extends string>(label: MessageKey, options: [T, MessageKey][], get: () => T, set: (v: T) => void, field: string): HTMLElement {
  const box = h("div", { class: "seg", attrs: { role: "radiogroup", "aria-label": t(label) }, data: { field } });
  const render = () => {
    box.replaceChildren(...options.map(([v, key]) => {
      const b = h("button", { class: `seg-${v}`, attrs: { type: "button", role: "radio", "aria-checked": String(get() === v) }, data: { value: v } }, h("span", { text: t(key) }));
      b.addEventListener("click", () => { if (get() !== v) { set(v); render(); } });
      return b;
    }));
  };
  render();
  return h("div", { class: "xrow" }, h("span", { class: "lbl", text: t(label) }), box);
}

/** Settings: pen hand, fingers, app font style, stroke smoothing, toolbar position. */
export function openSettings(host: SettingsHost): void {
  const p = host.prefs;
  const change = (what: "hand" | "finger" | "font" | "stab") => { host.savePrefs(); host.applied(what); };
  const stab = h("input", { attrs: { type: "range", min: "0", max: "100", "aria-label": t("setStab") }, data: { field: "stab" } });
  stab.value = String(p.stab);
  const stabOut = h("output", { text: String(p.stab) });
  stab.addEventListener("input", () => { p.stab = Number(stab.value); stabOut.value = stab.value; change("stab"); });
  const reset = button({ label: t("setTbReset"), data: { action: "toolbar-reset" }, onClick: () => host.resetToolbar() });
  const diag = button({ label: t("diagButton"), class: "ghost", data: { action: "diagnostics" }, onClick: () => { dlg.close(); host.diagnostics(); } });
  const dlg = openDialog(t("settings"), [
    segment("setHand", [["left", "setHandLeft"], ["right", "setHandRight"]], () => p.hand, (v) => { p.hand = v; change("hand"); }, "hand"),
    segment("setFinger", [["pen", "setFingerPen"], ["draw", "setFingerDraw"]], () => p.finger, (v) => { p.finger = v; change("finger"); }, "finger"),
    segment("setFont", [["bright", "setFontBright"], ["brush", "setFontBrush"]], () => p.font, (v) => { p.font = v; change("font"); }, "font"),
    h("label", { class: "xrow stab" }, h("span", { class: "lbl", text: t("setStab") }), stab, stabOut),
    h("p", { class: "xnote", text: t("setStabNote") }),
    h("div", { class: "sheet-foot" }, diag, reset),
  ], () => undefined, { closeLabel: t("close"), id: "settings" });
}
