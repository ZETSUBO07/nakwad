import { PAPER_SIZES, isHexColor, paperSizeProblem } from "../core";
import { t } from "../i18n";
import { openDialog } from "./dialog";
import { button, h } from "./dom";
import { paperPicker } from "./paperPicker";
import { sizeChooser } from "./paperSize";
import { remember, savePrefs, type Prefs } from "./prefs";

export interface PaperChoice { w: number; h: number; paper: string }

/** Ask for the paper of a new work. Resolves to null when cancelled. Remembers the choice. */
export function askNewWork(prefs: Prefs): Promise<PaperChoice | null> {
  return new Promise((resolve) => {
    const last = prefs.lastPaper;
    const nw: PaperChoice = last ? { ...last } : { w: PAPER_SIZES[0].w, h: PAPER_SIZES[0].h, paper: "white" };
    let result: PaperChoice | null = null;
    const ok = button({ label: t("newWorkStart"), class: "primary", data: { action: "start" } });
    const chooser = sizeChooser(nw, { last, changed: () => { ok.disabled = !!paperSizeProblem(nw.w, nw.h); }, enter: () => ok.click() });
    const picker = paperPicker(() => nw.paper, (v, final) => { nw.paper = v; if (final && isHexColor(v)) { prefs.paperRecent = remember(prefs.paperRecent, v); savePrefs(prefs); } }, () => prefs.paperRecent);
    const colour = h("div", { class: "xrow" }, h("span", { class: "lbl", text: t("paperColor") }), picker.el);
    const foot = h("div", { class: "sheet-foot" }, chooser.info, ok);
    const dlg = openDialog(t("newWorkTitle"), [...chooser.els, colour, foot], () => resolve(result), { id: "new-work" });
    ok.addEventListener("click", () => {
      if (!chooser.valid()) return;
      result = { ...nw };
      prefs.lastPaper = { ...nw };
      savePrefs(prefs);
      dlg.close();
    });
  });
}
