import { isHexColor, paperSizeProblem, type Mat } from "../core";
import { t, type MessageKey } from "../i18n";
import { openDialog } from "./dialog";
import { button, h } from "./dom";
import { paperPicker } from "./paperPicker";
import { sizeChooser, type SizeState } from "./paperSize";
import { remember, type Prefs } from "./prefs";

/** Ask for the size of a new page. Resolves to null when cancelled. */
export function askNewPage(current: SizeState): Promise<SizeState | null> {
  return new Promise((resolve) => {
    const size = { ...current };
    let result: SizeState | null = null;
    const ok = button({ label: t("pageAddStart"), class: "primary", data: { action: "page-create" } });
    const chooser = sizeChooser(size, { changed: () => { ok.disabled = !!paperSizeProblem(size.w, size.h); }, enter: () => ok.click() });
    const dlg = openDialog(t("pageAddTitle"), [...chooser.els, h("div", { class: "sheet-foot" }, chooser.info, ok)], () => resolve(result), { id: "new-page" });
    ok.addEventListener("click", () => { if (chooser.valid()) { result = { ...size }; dlg.close(); } });
  });
}

/** The move that puts the old drawing on the new paper: scaled to fit (centred), or kept at an anchor. */
export function resizeMove(from: SizeState, to: SizeState, fit: boolean, anchor: number): Mat {
  if (fit) {
    const s = Math.min(to.w / from.w, to.h / from.h);
    return [s, (to.w - from.w * s) / 2, (to.h - from.h * s) / 2];
  }
  const ax = anchor % 3, ay = Math.floor(anchor / 3);
  return [1, Math.round(((to.w - from.w) * ax) / 2), Math.round(((to.h - from.h) * ay) / 2)];
}

export interface PaperHost {
  prefs: Prefs;
  savePrefs(): void;
  size(): SizeState;
  paper(): string;
  /** the paper colour changes at once, for every page (not an undo step) */
  setPaper(v: string): void;
  /** change this page's size (one undo step) */
  resize(w: number, h: number, m: Mat): void;
}

/** Change the paper: its colour (all pages, at once) and this page's size (spec "กระดาษ"). */
export function openPaperDialog(host: PaperHost): void {
  const from = host.size(), size = { ...from };
  let fit = true, anchor = 4;
  const ok = button({ label: t("paperApply"), class: "primary", data: { action: "paper-apply" } });
  const chooser = sizeChooser(size, {
    describe: (w, hh, layers) => t("paperFrom", { w0: from.w, h0: from.h, w, h: hh, layers }),
    changed: () => { ok.disabled = !!paperSizeProblem(size.w, size.h); },
    enter: () => ok.click(),
  });
  const picker = paperPicker(() => host.paper(), (v, final) => {
    host.setPaper(v);
    if (final && isHexColor(v)) { host.prefs.paperRecent = remember(host.prefs.paperRecent, v); host.savePrefs(); }
  }, () => host.prefs.paperRecent);
  const colour = h("div", { class: "xrow" }, h("span", { class: "lbl" }, h("span", { text: t("paperColor") }), h("br"), h("small", { text: t("paperColorAll") })), picker.el);

  const fitSeg = h("div", { class: "seg", attrs: { role: "radiogroup", "aria-label": t("paperFit") }, data: { field: "fit" } });
  const anchorBox = h("div", { class: "anchor", attrs: { role: "group", "aria-label": t("paperAnchor") } });
  const anchorRow = h("div", { class: "xrow" }, h("span", { class: "lbl", text: t("paperAnchor") }), anchorBox, h("small", { class: "xnote", text: t("paperAnchorNote") }));
  const render = () => {
    fitSeg.replaceChildren(...([["scale", "paperFitScale"], ["keep", "paperFitKeep"]] as [string, MessageKey][]).map(([v, key]) => {
      const b = h("button", { attrs: { type: "button", role: "radio", "aria-checked": String((v === "scale") === fit) }, data: { value: v } }, h("span", { text: t(key) }));
      b.addEventListener("click", () => { fit = v === "scale"; render(); });
      return b;
    }));
    anchorBox.replaceChildren(...Array.from({ length: 9 }, (_, i) => {
      const b = h("button", { attrs: { type: "button", "aria-pressed": String(i === anchor), "aria-label": t(`anchor${i}` as MessageKey) }, data: { anchor: String(i) } });
      b.addEventListener("click", () => { anchor = i; render(); });
      return b;
    }));
    anchorRow.hidden = fit;
  };
  render();
  const dlg = openDialog(t("paperTitle"), [...chooser.els, colour, h("div", { class: "xrow" }, h("span", { class: "lbl", text: t("paperFit") }), fitSeg), anchorRow,
    h("div", { class: "sheet-foot" }, chooser.info, ok)], () => undefined, { id: "paper", closeLabel: t("close") });
  ok.addEventListener("click", () => {
    if (!chooser.valid()) return;
    dlg.close();
    if (size.w === from.w && size.h === from.h) return;
    host.resize(size.w, size.h, resizeMove(from, size, fit, anchor));
  });
}
