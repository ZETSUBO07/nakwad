import { isHexColor } from "../core";
import { t } from "../i18n";
import { h } from "./dom";

/**
 * Paper colour choice: white, cream, transparent, a colour picked by hand, and the last
 * five hand-picked colours. `onPick(value, final)` gets "white" | "cream" | "none" | "#rrggbb";
 * `final` is false while the colour wheel is still being dragged.
 */
export function paperPicker(get: () => string, onPick: (v: string, final: boolean) => void, recent: () => readonly string[], opts: { noneLabel?: string; label?: string } = {}): { el: HTMLElement; render(): void } {
  const el = h("div", { class: "paperpick" });
  function render(): void {
    const v = get(), custom = isHexColor(v);
    const seg = h("div", { class: "seg", attrs: { role: "radiogroup", "aria-label": opts.label ?? t("paperColor") } });
    for (const [value, label] of [["white", t("paperWhite")], ["cream", t("paperCream")], ["none", opts.noneLabel ?? t("paperNone")]] as const) {
      const b = h("button", { attrs: { type: "button", role: "radio", "aria-checked": String(v === value) }, data: { paper: value } },
        h("span", { class: `pdot pdot-${value}` }), h("span", { text: label }));
      b.addEventListener("click", () => { onPick(value, true); render(); });
      seg.append(b);
    }
    const dot = h("span", { class: "pdot pdot-wheel" });
    if (custom) dot.style.background = v;
    const input = h("input", { attrs: { type: "color", "aria-label": t("paperPickLabel") } });
    input.value = custom ? v : "#dfeaf7";
    const pick = h("label", { class: "pcust", attrs: { role: "radio", "aria-checked": String(custom) }, data: { paper: "custom" } }, dot, h("span", { text: t("paperPick") }), input);
    input.addEventListener("input", () => { dot.style.background = input.value; onPick(input.value.toLowerCase(), false); });
    input.addEventListener("change", () => { onPick(input.value.toLowerCase(), true); render(); });
    seg.append(pick);
    const rec = h("div", { class: "recent" });
    const list = recent();
    if (list.length) {
      rec.append(h("span", { text: t("paperRecent") }));
      for (const c of list) {
        const b = h("button", { class: "swatch", attrs: { type: "button", "aria-label": t("paperRecentLabel", { color: c }), "aria-pressed": String(c === v), title: c } });
        b.style.background = c;
        b.addEventListener("click", () => { onPick(c, true); render(); });
        rec.append(b);
      }
    }
    el.replaceChildren(seg, rec);
  }
  render();
  return { el, render };
}
