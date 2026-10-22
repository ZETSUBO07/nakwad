import type { LayerId, TextAlign, TextData, TextId } from "../core";
import { t, type MessageKey } from "../i18n";
import { toScreen, type Frame, type View } from "../input";
import { TEXT_LINE, measureText } from "../render";
import type { Store } from "../storage";
import { button, h } from "./dom";
import { TEXT_FONTS, ensureFont, importFont, importedFonts } from "./fonts";
import { TEXT_SIZE_MAX, TEXT_SIZE_MIN, type Prefs } from "./prefs";
import { toast } from "./toast";

/** The text being edited: a new box (target null) or text already on a layer. */
export interface TextTarget { layer: LayerId; tid: TextId }

export interface TextHost {
  prefs: Prefs;
  savePrefs(): void;
  store: Store;
  frame(): Frame;
  view(): View;
  /** where the overlay lives (the work area) */
  container(): HTMLElement;
  /** room taken by a docked toolbar on each side of the work area */
  insets(): { left: number; right: number; top: number };
  /** the session ended: save the text (new or changed), or remove it when empty */
  finish(data: TextData, target: TextTarget | null): void;
  /** delete the text being edited */
  remove(target: TextTarget | null): void;
  /** turn the text into a picture (after saving it) */
  flatten(data: TextData, target: TextTarget | null): void;
}

const ROT_SNAP = 3;

/** One text box being typed in: a <textarea> laid exactly over where the text will be drawn, and its settings panel. */
export class TextSession {
  readonly box: HTMLElement;
  readonly panel: HTMLElement;
  private readonly area: HTMLTextAreaElement;
  private readonly fontList: HTMLElement;
  private readonly sizeIn: HTMLInputElement;
  private readonly sizeNum: HTMLInputElement;
  private readonly rotIn: HTMLInputElement;
  private readonly rotOut: HTMLOutputElement;
  private readonly alignSeg: HTMLElement;
  private drag: { id: number; x0: number; y0: number; px: number; py: number } | null = null;
  private done = false;

  constructor(private readonly host: TextHost, readonly data: TextData, readonly target: TextTarget | null) {
    this.area = h("textarea", { class: "text-input-box", attrs: { "aria-label": t("textBox"), spellcheck: "false", autocapitalize: "off", rows: "1" }, data: { testid: "text-box" } });
    this.area.value = data.text;
    this.area.addEventListener("input", () => { this.data.text = this.area.value; this.place(); });
    this.area.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); this.finish(); } });
    this.box = h("div", { class: "text-frame", attrs: { title: t("textMoveBox") } }, this.area);
    this.box.addEventListener("pointerdown", this.onDown);
    this.box.addEventListener("pointermove", this.onMove);
    this.box.addEventListener("pointerup", this.onUp);
    this.box.addEventListener("pointercancel", this.onUp);

    this.fontList = h("div", { class: "fontlist", attrs: { role: "radiogroup", "aria-label": t("textFonts") } });
    const file = h("input", { attrs: { type: "file", accept: ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2", hidden: "" }, data: { field: "font-file" } });
    file.addEventListener("change", () => void this.importFile(file));
    const importBtn = button({ label: t("textImport"), data: { action: "font-import" }, onClick: () => file.click() });

    this.sizeIn = h("input", { attrs: { type: "range", min: String(TEXT_SIZE_MIN), max: String(TEXT_SIZE_MAX), "aria-label": t("textSize") }, data: { field: "text-size" } });
    this.sizeNum = h("input", { class: "num", attrs: { type: "number", min: String(TEXT_SIZE_MIN), max: String(TEXT_SIZE_MAX), inputmode: "numeric", "aria-label": t("textSize") }, data: { field: "text-size-number" } });
    const setSize = (v: number) => { if (!Number.isFinite(v) || v < TEXT_SIZE_MIN) return; this.data.size = Math.min(TEXT_SIZE_MAX, Math.round(v)); this.remember(); this.sync(); this.place(); };
    this.sizeIn.addEventListener("input", () => setSize(Number(this.sizeIn.value)));
    this.sizeNum.addEventListener("change", () => setSize(Number(this.sizeNum.value)));

    this.alignSeg = h("div", { class: "seg", attrs: { role: "radiogroup", "aria-label": t("textAlign") } });
    for (const [v, key] of [["left", "textAlignLeft"], ["center", "textAlignCenter"], ["right", "textAlignRight"]] as [TextAlign, MessageKey][]) {
      const b = h("button", { attrs: { type: "button", role: "radio" }, data: { value: v } }, h("span", { text: t(key) }));
      b.addEventListener("click", () => { this.data.align = v; this.remember(); this.sync(); this.place(); });
      this.alignSeg.append(b);
    }
    this.rotIn = h("input", { attrs: { type: "range", min: "-180", max: "180", "aria-label": t("textRotate") }, data: { field: "text-rotate" } });
    this.rotOut = h("output");
    this.rotIn.addEventListener("input", () => {
      const v = Number(this.rotIn.value);
      this.data.rot = Math.abs(v) <= ROT_SNAP ? 0 : v; // snaps back to straight
      this.sync();
      this.place();
    });

    const flat = button({ label: t("textFlatten"), data: { action: "text-flatten" }, onClick: () => this.end("flatten") });
    flat.title = t("textFlattenTitle");
    const del = button({ label: t("textDelete"), data: { action: "text-delete" }, onClick: () => this.end("remove") });
    const ok = button({ label: t("textDone"), class: "primary", data: { action: "text-done" }, onClick: () => this.finish() });
    this.panel = h("div", { class: "text-panel menu", attrs: { role: "dialog", "aria-label": t("textPanel") }, data: { testid: "text-panel" } },
      h("h2", { text: t("textPanel") }),
      this.fontList, h("div", { class: "row" }, importBtn, file),
      h("label", { class: "tslider" }, h("span", { text: t("textSize") }), this.sizeNum, this.sizeIn),
      this.alignSeg,
      h("label", { class: "tslider" }, h("span", { text: t("textRotate") }), this.rotOut, this.rotIn),
      h("p", { class: "xnote", text: t("textNote") }),
      h("div", { class: "row end" }, flat, del, ok));

    const c = host.container();
    c.append(this.box, this.panel);
    this.renderFonts();
    this.sync();
    this.place();
    void ensureFont(data.font).then(() => this.place());
    requestAnimationFrame(() => this.area.focus({ preventScroll: true }));
  }

  get open(): boolean { return !this.done; }

  /** The toolbar colour changed while typing. */
  setColor(c: string): void { this.data.color = c; this.place(); }

  private remember(): void {
    this.host.prefs.text = { font: this.data.font, size: this.data.size, align: this.data.align };
    this.host.savePrefs();
  }

  private renderFonts(): void {
    const names = [...TEXT_FONTS, ...importedFonts()];
    this.fontList.replaceChildren(...names.map((name) => {
      const sample = h("span", { text: t("textFontSample") });
      sample.style.fontFamily = `"${name}", "Anuphan", sans-serif`;
      const b = h("button", { attrs: { type: "button", role: "radio", "aria-checked": String(name === this.data.font), title: name }, data: { font: name } }, sample, h("small", { text: name }));
      b.addEventListener("click", () => { this.data.font = name; this.remember(); this.renderFonts(); this.place(); void ensureFont(name).then(() => this.place()); });
      void ensureFont(name);
      return b;
    }));
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    const r = await importFont(this.host.store, f, t("textImportedSuffix"));
    if (!r.ok) { toast(t(r.reason === "tooBig" ? "textImportTooBig" : r.reason === "exists" ? "textImportExists" : r.reason === "failed" ? "actionFailed" : "textImportNotFont")); return; }
    this.data.font = r.name;
    this.remember();
    this.renderFonts();
    this.place();
    toast(t("textImported", { name: r.name }));
  }

  private sync(): void {
    this.sizeIn.value = String(Math.min(TEXT_SIZE_MAX, this.data.size));
    if (document.activeElement !== this.sizeNum) this.sizeNum.value = String(Math.round(this.data.size));
    this.rotIn.value = String(Math.round(this.data.rot));
    this.rotOut.value = t("textRotateValue", { n: Math.round(this.data.rot) });
    for (const b of this.alignSeg.querySelectorAll<HTMLElement>("[data-value]")) b.setAttribute("aria-checked", String(b.dataset.value === this.data.align));
  }

  /** Lay the box exactly over where the text will be drawn, following zoom and rotation. */
  place(): void {
    if (this.done) return;
    const f = this.host.frame(), v = this.host.view(), k = v.s * f.fit;
    const m = measureText({ ...this.data, text: this.data.text || " " });
    const cr = this.host.container().getBoundingClientRect();
    const c = toScreen(v, f, [this.data.x + m.w / 2, this.data.y + m.h / 2]);
    // a little room after the last letter for the caret
    const w = m.w * k + Math.max(8, this.data.size * k * 0.6), hh = Math.max(m.h, this.data.size * TEXT_LINE) * k;
    const a = this.area;
    a.style.width = `${w}px`;
    a.style.height = `${hh}px`;
    a.style.font = `${this.data.size * k}px "${this.data.font}", "Anuphan", sans-serif`;
    a.style.lineHeight = String(TEXT_LINE);
    a.style.color = this.data.color;
    a.style.textAlign = this.data.align;
    const pad = 12;
    // the settings panel goes to the other half of the screen, so it never covers the text
    const onLeft = c[0] - cr.left < cr.width / 2, ins = this.host.insets();
    this.panel.style.left = onLeft ? "auto" : `${ins.left + 12}px`;
    this.panel.style.right = onLeft ? `${ins.right + 12}px` : "auto";
    this.panel.style.top = `${ins.top + 12}px`;
    this.box.style.transform = `translate(${c[0] - cr.left - w / 2 - pad}px, ${c[1] - cr.top - hh / 2 - pad}px) rotate(${v.r + (this.data.rot * Math.PI) / 180}rad)`;
  }

  // dragging the frame (not the text inside) moves the box
  private readonly onDown = (e: PointerEvent) => {
    if (e.target !== this.box) return;
    e.preventDefault();
    this.box.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, px: this.data.x, py: this.data.y };
  };

  private readonly onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const v = this.host.view(), k = v.s * this.host.frame().fit;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0, c = Math.cos(-v.r), s = Math.sin(-v.r);
    this.data.x = d.px + (dx * c - dy * s) / k;
    this.data.y = d.py + (dx * s + dy * c) / k;
    this.place();
  };

  private readonly onUp = (e: PointerEvent) => {
    if (this.drag?.id === e.pointerId) this.drag = null;
  };

  /** Save what was typed and close. */
  finish(): void { this.end("finish"); }

  private end(how: "finish" | "remove" | "flatten"): void {
    if (this.done) return;
    this.done = true;
    this.data.text = this.area.value;
    this.box.remove();
    this.panel.remove();
    if (how === "remove") this.host.remove(this.target);
    else if (how === "flatten") this.host.flatten(this.data, this.target);
    else this.host.finish(this.data, this.target);
  }
}
