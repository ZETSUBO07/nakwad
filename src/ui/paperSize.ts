import { FEW_LAYERS, MAX_SIDE, MIN_SIDE, PAPER_SIZES, layersFor, paperSizeProblem } from "../core";
import { t, type MessageKey } from "../i18n";
import { button, h } from "./dom";

export interface SizeState { w: number; h: number }

export interface SizeChooser {
  /** the preset buttons and the custom-size row, in that order */
  els: HTMLElement[];
  /** a line saying what the size gives (or what is wrong with it) */
  info: HTMLElement;
  valid(): boolean;
  render(fillInputs: boolean): void;
}

/**
 * Paper size choice, the same in the new-work, new-page and change-paper dialogs (spec):
 * the 7 presets (plus "use last"), a custom size with limits and a swap button, and how many
 * layers that size allows, warning when few.
 */
export function sizeChooser(size: SizeState, opts: { last?: SizeState | null; describe?: (w: number, h: number, layers: number) => string; changed?: () => void; enter?: () => void }): SizeChooser {
  const sizes = h("div", { class: "psizes", attrs: { role: "radiogroup", "aria-label": t("paperSizes") } });
  const wIn = h("input", { attrs: { type: "number", min: String(MIN_SIDE), max: String(MAX_SIDE), step: "1", inputmode: "numeric", "aria-label": t("paperWidth") }, data: { field: "w" } });
  const hIn = h("input", { attrs: { type: "number", min: String(MIN_SIDE), max: String(MAX_SIDE), step: "1", inputmode: "numeric", "aria-label": t("paperHeight") }, data: { field: "h" } });
  const swap = button({ icon: "swap", title: t("paperSwap"), class: "icon-btn", data: { action: "swap" }, onClick: () => { [size.w, size.h] = [size.h, size.w]; render(true); } });
  const custom = h("div", { class: "pcustom" }, h("span", { text: t("paperCustom") }), wIn, h("span", { text: "×" }), hIn, h("span", { text: t("paperPixels") }), swap);
  const info = h("p", { class: "nw-info", attrs: { "aria-live": "polite" } });
  const items: { key: MessageKey; w: number; h: number; last?: boolean }[] = [];
  if (opts.last) items.push({ key: "paperLast", w: opts.last.w, h: opts.last.h, last: true });
  for (const s of PAPER_SIZES) items.push({ key: `paper_${s.id}` as MessageKey, w: s.w, h: s.h });
  const valid = () => !paperSizeProblem(size.w, size.h);

  function render(fillInputs: boolean): void {
    sizes.replaceChildren();
    let picked = false;
    for (const it of items) {
      const on = !picked && it.w === size.w && it.h === size.h;
      if (on) picked = true;
      const k = 34 / Math.max(it.w, it.h);
      const shape = h("span", { class: "shape" });
      shape.style.width = `${Math.round(it.w * k)}px`;
      shape.style.height = `${Math.round(it.h * k)}px`;
      const b = h("button", { class: it.last ? "psize last" : "psize", attrs: { type: "button", role: "radio", "aria-checked": String(on) }, data: { w: String(it.w), h: String(it.h) } },
        shape, h("b", { text: t(it.key) }), h("small", { text: t("paperSizeLine", { w: it.w, h: it.h, layers: layersFor(it.w, it.h) }) }));
      b.addEventListener("click", () => { size.w = it.w; size.h = it.h; render(true); });
      sizes.append(b);
    }
    if (fillInputs) { wIn.value = String(size.w); hIn.value = String(size.h); }
    const ok = valid(), layers = ok ? layersFor(size.w, size.h) : 0;
    info.textContent = !ok ? t("paperInvalid", { min: MIN_SIDE, max: MAX_SIDE })
      : opts.describe ? opts.describe(size.w, size.h, layers)
      : t(layers < FEW_LAYERS ? "paperInfoBig" : "paperInfo", { w: size.w, h: size.h, layers });
    info.classList.toggle("warn", !ok || layers < FEW_LAYERS);
    opts.changed?.();
  }
  for (const input of [wIn, hIn]) {
    input.addEventListener("input", () => { size.w = Math.round(Number(wIn.value)); size.h = Math.round(Number(hIn.value)); render(false); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (valid()) opts.enter?.(); } });
  }
  render(true);
  return { els: [sizes, custom], info, valid, render };
}
