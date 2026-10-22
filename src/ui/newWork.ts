import { FEW_LAYERS, MAX_SIDE, MIN_SIDE, PAPER_SIZES, isHexColor, layersFor, paperSizeProblem } from "../core";
import { t, type MessageKey } from "../i18n";
import { openDialog } from "./dialog";
import { button, h } from "./dom";
import { paperPicker } from "./paperPicker";
import { remember, savePrefs, type Prefs } from "./prefs";

export interface PaperChoice { w: number; h: number; paper: string }

/** Ask for the paper of a new work. Resolves to null when cancelled. Remembers the choice. */
export function askNewWork(prefs: Prefs): Promise<PaperChoice | null> {
  return new Promise((resolve) => {
    const last = prefs.lastPaper;
    const nw: PaperChoice = last ? { ...last } : { w: PAPER_SIZES[0].w, h: PAPER_SIZES[0].h, paper: "white" };
    let result: PaperChoice | null = null;

    const sizes = h("div", { class: "psizes", attrs: { role: "radiogroup", "aria-label": t("paperSizes") } });
    const wIn = h("input", { attrs: { type: "number", min: String(MIN_SIDE), max: String(MAX_SIDE), step: "1", inputmode: "numeric", "aria-label": t("paperWidth") }, data: { field: "w" } });
    const hIn = h("input", { attrs: { type: "number", min: String(MIN_SIDE), max: String(MAX_SIDE), step: "1", inputmode: "numeric", "aria-label": t("paperHeight") }, data: { field: "h" } });
    const swap = button({ icon: "swap", title: t("paperSwap"), class: "icon-btn", onClick: () => { [nw.w, nw.h] = [nw.h, nw.w]; render(true); } });
    const custom = h("div", { class: "pcustom" }, h("span", { text: t("paperCustom") }), wIn, h("span", { text: "×" }), hIn, h("span", { text: t("paperPixels") }), swap);
    const info = h("p", { class: "nw-info", attrs: { "aria-live": "polite" } });
    const ok = button({ label: t("newWorkStart"), class: "primary", data: { action: "start" } });
    const picker = paperPicker(() => nw.paper, (v, final) => { nw.paper = v; if (final && isHexColor(v)) { prefs.paperRecent = remember(prefs.paperRecent, v); savePrefs(prefs); } }, () => prefs.paperRecent);

    const items: { key: MessageKey; w: number; h: number; last?: boolean }[] = [];
    if (last) items.push({ key: "paperLast", w: last.w, h: last.h, last: true });
    for (const s of PAPER_SIZES) items.push({ key: `paper_${s.id}` as MessageKey, w: s.w, h: s.h });

    function render(fillInputs: boolean): void {
      sizes.replaceChildren();
      let picked = false;
      for (const it of items) {
        const on = !picked && it.w === nw.w && it.h === nw.h;
        if (on) picked = true;
        const k = 34 / Math.max(it.w, it.h);
        const shape = h("span", { class: "shape" });
        shape.style.width = `${Math.round(it.w * k)}px`;
        shape.style.height = `${Math.round(it.h * k)}px`;
        const b = h("button", { class: it.last ? "psize last" : "psize", attrs: { type: "button", role: "radio", "aria-checked": String(on) }, data: { w: String(it.w), h: String(it.h) } },
          shape, h("b", { text: t(it.key) }), h("small", { text: t("paperSizeLine", { w: it.w, h: it.h, layers: layersFor(it.w, it.h) }) }));
        b.addEventListener("click", () => { nw.w = it.w; nw.h = it.h; render(true); });
        sizes.append(b);
      }
      if (fillInputs) { wIn.value = String(nw.w); hIn.value = String(nw.h); }
      const valid = !paperSizeProblem(nw.w, nw.h);
      const layers = valid ? layersFor(nw.w, nw.h) : 0;
      info.textContent = !valid ? t("paperInvalid", { min: MIN_SIDE, max: MAX_SIDE })
        : t(layers < FEW_LAYERS ? "paperInfoBig" : "paperInfo", { w: nw.w, h: nw.h, layers });
      info.classList.toggle("warn", !valid || layers < FEW_LAYERS);
      ok.disabled = !valid;
    }
    for (const input of [wIn, hIn]) {
      input.addEventListener("input", () => { nw.w = Math.round(Number(wIn.value)); nw.h = Math.round(Number(hIn.value)); render(false); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!ok.disabled) ok.click(); } });
    }
    render(true);

    const colour = h("div", { class: "xrow" }, h("span", { class: "lbl", text: t("paperColor") }), picker.el);
    const foot = h("div", { class: "sheet-foot" }, info, ok);
    const dlg = openDialog(t("newWorkTitle"), [sizes, custom, colour, foot], () => resolve(result), { id: "new-work" });
    ok.addEventListener("click", () => {
      if (paperSizeProblem(nw.w, nw.h)) return;
      result = { ...nw };
      prefs.lastPaper = { ...nw };
      savePrefs(prefs);
      dlg.close();
    });
  });
}
