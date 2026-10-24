import { BRUSHES, isEraser, isHexColor, type BrushId, type StrokeEntry } from "../core";
import { t, type MessageKey } from "../i18n";
import { renderEntry } from "../render";
import { drop, inset, isHorizontal, menuAt, nextSize, place, defaultTb, type Area, type TbState } from "./dock";
import { button, h, icon, type IconName } from "./dom";
import { OP_MAX, OP_MIN, SIZE_MAX, SIZE_MIN, SIZE_SLIDER_MAX, SWATCHES, remember, type Prefs } from "./prefs";

export interface Tool { brush: BrushId; color: string; size: number; op: number }

export interface ToolbarHost {
  prefs: Prefs;
  savePrefs(): void;
  undo(): void;
  redo(): void;
  clear(): void;
  /** the work area the toolbar floats in (screen pixels) */
  area(): Area;
  /** the space the toolbar takes from the paper changed */
  insetChanged(): void;
  toolChanged(): void;
  /** show (or hide) the brush size as a circle on the paper while the size is being changed */
  sizePreview(show: boolean): void;
  /** switch the text tool on or off */
  toggleText(): void;
  textMode(): boolean;
  /** switch the move / scale / turn frame on or off */
  toggleMove(): void;
  moveMode(): boolean;
  selectMode(): boolean;
  /** leave the text, move or select tool for drawing */
  toDraw(): void;
  /** what the selection menu offers right now */
  selectItems(): MenuItem[];
}

export interface MenuItem {
  key: MessageKey;
  icon: IconName;
  enabled: boolean;
  /** shown as a radio item (the shape choice) */
  checked?: boolean;
  kbd?: string;
  data: string;
  act(): void;
}

const brushKey = (b: BrushId) => ("brush" + b.charAt(0).toUpperCase() + b.slice(1)) as MessageKey;
const descKey = (b: BrushId) => (brushKey(b) + "Desc") as MessageKey;
/** press and hold the eraser button this long to choose the eraser */
const ERASER_HOLD_MS = 450;
const orientation = (): "land" | "port" => (innerWidth >= innerHeight ? "land" : "port");

/**
 * The floating toolbar: drag it by the grip, it docks to the nearest edge or floats; tapping the
 * grip folds it full → compact → bubble. Its place is remembered separately for each orientation.
 */
export class Toolbar {
  readonly el: HTMLElement;
  private readonly grip: HTMLElement;
  private readonly bubble: HTMLElement;
  private readonly brushBtn: HTMLButtonElement;
  private readonly eraserBtn: HTMLButtonElement;
  private eraserHold = 0;
  private readonly textBtn: HTMLButtonElement;
  private readonly moveBtn: HTMLButtonElement;
  private readonly selBtn: HTMLButtonElement;
  private readonly swatchBox: HTMLElement;
  private readonly sizeIn: HTMLInputElement;
  private readonly sizeNum: HTMLInputElement;
  private readonly sizeDot: HTMLElement;
  private readonly opIn: HTMLInputElement;
  private readonly opOut: HTMLOutputElement;
  readonly undoBtn: HTMLButtonElement;
  readonly redoBtn: HTMLButtonElement;
  private menu: HTMLElement | null = null;
  private tb: TbState;
  private orient = orientation();
  private drag: { id: number; dx: number; dy: number; x0: number; y0: number; moved: boolean } | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly host: ToolbarHost) {
    const p = host.prefs;
    this.tb = p.toolbar[this.orient] ?? defaultTb(p.hand);

    this.bubble = h("span", { class: "bubble-icon" });
    this.grip = h("div", { class: "grip", attrs: { role: "button", tabindex: "0", "aria-label": t("toolbarGrip"), title: t("toolbarGrip") }, data: { action: "grip" } },
      h("span", { class: "dots" }), this.bubble);
    // while erasing, the brush button simply goes back to drawing
    this.brushBtn = button({ class: "brush-btn", data: { action: "brush" }, onClick: () => { if (isEraser(host.prefs.brush)) { this.closeMenu(); this.toggleEraser(); } else this.toggleMenu(); } });
    this.brushBtn.setAttribute("aria-haspopup", "menu");
    // tap: eraser on / back to the brush; press and hold (or right-click): which eraser
    this.eraserBtn = button({ class: "eraser-btn", data: { action: "eraser" } });
    this.eraserBtn.setAttribute("aria-haspopup", "menu");
    this.eraserBtn.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      clearTimeout(this.eraserHold);
      this.eraserHold = window.setTimeout(() => { this.eraserHold = -1; this.toggleEraserMenu(); }, ERASER_HOLD_MS);
    });
    const cancelHold = () => { if (this.eraserHold > 0) clearTimeout(this.eraserHold); };
    this.eraserBtn.addEventListener("pointerleave", cancelHold);
    this.eraserBtn.addEventListener("pointercancel", cancelHold);
    this.eraserBtn.addEventListener("click", () => {
      if (this.eraserHold === -1) { this.eraserHold = 0; return; } // the hold opened the menu
      cancelHold();
      this.closeMenu();
      this.toggleEraser();
    });
    // right-click with a mouse; a touch long-press also sends this, after the hold already opened the menu
    this.eraserBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); if (this.eraserHold === -1) return; cancelHold(); this.eraserHold = 0; this.toggleEraserMenu(); });
    this.selBtn = button({ icon: "select", title: t("selectTool"), data: { action: "select" }, onClick: () => this.toggleSelectMenu() });
    this.selBtn.setAttribute("aria-haspopup", "menu");
    this.moveBtn = button({ icon: "move", title: t("moveTool"), data: { action: "move" }, onClick: () => { this.closeMenu(); host.toggleMove(); } });
    this.textBtn = button({ label: "T", title: t("textTool"), class: "text-btn", data: { action: "text" }, onClick: () => { this.closeMenu(); host.toggleText(); } });

    this.swatchBox = h("div", { class: "tgroup swatches fo", attrs: { role: "group", "aria-label": t("colors") } });

    this.sizeDot = h("i", { class: "size-dot" });
    this.sizeIn = h("input", { attrs: { type: "range", min: String(SIZE_MIN), max: String(SIZE_SLIDER_MAX), "aria-label": t("size") }, data: { field: "size" } });
    // type an exact size, up to SIZE_MAX (the slider stops at SIZE_SLIDER_MAX)
    this.sizeNum = h("input", { class: "size-num", attrs: { type: "number", min: String(SIZE_MIN), max: String(SIZE_MAX), step: "1", inputmode: "numeric", "aria-label": t("sizeExact", { max: SIZE_MAX }), title: t("sizeExact", { max: SIZE_MAX }) }, data: { field: "size-number" } });
    const typed = (final: boolean) => {
      const v = Math.round(Number(this.sizeNum.value));
      if (!Number.isFinite(v) || v < SIZE_MIN) { if (final) this.sync(); return; }
      this.setting().size = Math.min(SIZE_MAX, v);
      if (final) this.changed(); else { this.host.savePrefs(); this.syncSlider(); this.host.toolChanged(); }
      host.sizePreview(!final);
    };
    this.sizeNum.addEventListener("input", () => typed(false));
    this.sizeNum.addEventListener("change", () => typed(true));
    this.sizeNum.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.sizeNum.blur(); } });
    this.opIn = h("input", { attrs: { type: "range", min: String(OP_MIN), max: String(OP_MAX), "aria-label": t("opacity") }, data: { field: "opacity" } });
    this.opOut = h("output");
    this.sizeIn.addEventListener("input", () => { this.setting().size = Number(this.sizeIn.value); this.changed(); host.sizePreview(true); });
    this.sizeIn.addEventListener("change", () => host.sizePreview(false));
    this.sizeIn.addEventListener("pointerup", () => host.sizePreview(false));
    this.opIn.addEventListener("input", () => { this.setting().op = Number(this.opIn.value); this.changed(); });
    const sliders = h("div", { class: "tgroup sliders fo" },
      h("div", { class: "slider" }, h("span", { class: "dot-box" }, this.sizeDot), this.sizeNum, this.sizeIn),
      h("label", { class: "slider", attrs: { title: t("opacity") } }, h("span", { class: "op-icon" }), this.opOut, this.opIn));

    this.undoBtn = button({ icon: "undo", title: t("undo"), data: { action: "undo" }, onClick: () => host.undo() });
    this.redoBtn = button({ icon: "redo", title: t("redo"), data: { action: "redo" }, onClick: () => host.redo() });
    const clear = button({ icon: "clear", title: t("clearLayer"), class: "fo", data: { action: "clear" }, onClick: () => host.clear() });

    this.el = h("div", { class: "tbar", attrs: { role: "toolbar", "aria-label": t("toolbar") }, data: { testid: "toolbar" } },
      this.grip,
      h("div", { class: "tgroup tools" }, this.brushBtn, this.eraserBtn, this.selBtn, this.moveBtn, this.textBtn),
      h("div", { class: "sep fo" }), this.swatchBox,
      h("div", { class: "sep fo" }), sliders,
      h("div", { class: "sep" }), h("div", { class: "tgroup actions" }, this.undoBtn, this.redoBtn, clear));

    this.grip.addEventListener("pointerdown", this.onGripDown);
    this.grip.addEventListener("pointermove", this.onGripMove);
    this.grip.addEventListener("pointerup", this.onGripUp);
    this.grip.addEventListener("pointercancel", this.onGripUp);
    this.grip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.setSize(nextSize(this.tb.size)); } });
    const onResize = () => {
      const o = orientation();
      if (o !== this.orient) { this.orient = o; this.tb = this.host.prefs.toolbar[o] ?? defaultTb(this.host.prefs.hand); }
      this.place();
    };
    window.addEventListener("resize", onResize);
    this.offs.push(() => window.removeEventListener("resize", onResize));
    const onDocDown = (e: PointerEvent) => {
      const tgt = e.target as Node;
      if (this.menu && !this.menu.contains(tgt) && !this.brushBtn.contains(tgt) && !this.selBtn.contains(tgt) && !this.eraserBtn.contains(tgt)) this.closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.closeMenu(); };
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKey);
    this.offs.push(() => document.removeEventListener("pointerdown", onDocDown, true), () => document.removeEventListener("keydown", onKey));
    this.sync();
  }

  get tool(): Tool {
    const p = this.host.prefs, s = p.brushes[p.brush];
    return { brush: p.brush, color: p.color, size: s.size, op: s.op };
  }

  /** How much room the docked toolbar takes on each side of the paper. */
  get insets() { return inset(this.tb, this.el.offsetWidth, this.el.offsetHeight); }

  private setting() { const p = this.host.prefs; return p.brushes[p.brush]; }

  private changed(): void {
    this.host.savePrefs();
    this.sync();
    this.host.toolChanged();
  }

  setBrush(b: BrushId): void {
    const p = this.host.prefs;
    p.brush = b;
    // remember which eraser the button uses, and which brush to go back to
    if (b === "eraser" || b === "eraserall") p.eraser = b; else p.drawBrush = b;
    this.changed();
  }

  /** The eraser button: erase with the chosen eraser, or go back to the brush used before. */
  toggleEraser(): void {
    const p = this.host.prefs;
    this.host.toDraw();
    this.setBrush(isEraser(p.brush) ? p.drawBrush : p.eraser);
  }

  setColor(c: string, pickedByHand = false): void {
    const p = this.host.prefs;
    if (!isHexColor(c)) return;
    p.color = c.toLowerCase();
    if (pickedByHand) p.colorRecent = remember(p.colorRecent, c);
    // choosing a colour while erasing means "draw again" with the brush used before
    if (isEraser(p.brush)) p.brush = p.drawBrush;
    this.changed();
  }

  /** [ and ] keys */
  sizeBy(d: number): void {
    const s = this.setting();
    s.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, s.size + d));
    this.changed();
    this.host.sizePreview(true);
    this.host.sizePreview(false);
  }

  /** Put the toolbar back to its starting place (settings). */
  reset(): void {
    this.tb = defaultTb(this.host.prefs.hand);
    this.store();
  }

  /** The pen hand changed: mirror a toolbar docked left or right. */
  handChanged(): void {
    if (this.tb.side === "left" || this.tb.side === "right") { this.tb = { ...this.tb, side: this.tb.side === "left" ? "right" : "left" }; this.store(); }
  }

  sync(): void {
    const tool = this.tool, er = isEraser(tool.brush), texting = this.host.textMode(), moving = this.host.moveMode(), selecting = this.host.selectMode();
    this.textBtn.setAttribute("aria-pressed", String(texting));
    this.moveBtn.setAttribute("aria-pressed", String(moving));
    this.selBtn.setAttribute("aria-pressed", String(selecting));
    const drawing = !texting && !moving && !selecting, shown = er ? this.host.prefs.drawBrush : tool.brush;
    this.brushBtn.setAttribute("aria-pressed", String(drawing && !er));
    this.brushBtn.replaceChildren(icon(shown), icon("caret"));
    this.brushBtn.title = t("brushCurrent", { name: t(brushKey(shown)) });
    this.brushBtn.setAttribute("aria-label", this.brushBtn.title);
    this.brushBtn.dataset.brush = tool.brush;
    const ek = this.host.prefs.eraser;
    this.eraserBtn.setAttribute("aria-pressed", String(drawing && er));
    this.eraserBtn.replaceChildren(icon(ek));
    this.eraserBtn.title = t("eraserButton", { name: t(brushKey(ek)) });
    this.eraserBtn.setAttribute("aria-label", this.eraserBtn.title);
    this.eraserBtn.dataset.eraser = ek;
    this.bubble.replaceChildren(icon(tool.brush));
    this.bubble.style.setProperty("--bc", er ? "var(--line)" : tool.color);
    this.syncSlider();
    if (document.activeElement !== this.sizeNum) this.sizeNum.value = String(tool.size);
    this.opIn.value = String(tool.op);
    this.opOut.value = t("opacityValue", { n: tool.op });
    this.sizeDot.style.background = er ? "transparent" : tool.color;
    this.sizeDot.style.opacity = String(er ? 1 : Math.max(0.25, tool.op / 100));
    this.renderSwatches();
    if (this.menu) this.drawPreviews();
  }

  /** The slider shows sizes above its end as full. */
  private syncSlider(): void {
    this.sizeIn.value = String(Math.min(SIZE_SLIDER_MAX, this.tool.size));
    const d = Math.max(3, Math.min(24, this.tool.size));
    this.sizeDot.style.width = this.sizeDot.style.height = `${d}px`;
  }

  private renderSwatches(): void {
    const p = this.host.prefs, er = isEraser(p.brush);
    const sw = (c: string, recent: boolean) => {
      const b = h("button", { class: "swatch", attrs: { type: "button", "aria-label": t("colorLabel", { color: c }), title: c, "aria-pressed": String(!er && c === p.color) }, data: { color: c, ...(recent ? { recent: "1" } : {}) } });
      b.style.setProperty("--c", c);
      b.addEventListener("click", () => this.setColor(c));
      return b;
    };
    const input = h("input", { attrs: { type: "color", "aria-label": t("colorPick") } });
    input.value = p.color;
    input.addEventListener("change", () => this.setColor(input.value, true));
    const custom = h("label", { class: "swatch pick", attrs: { title: t("colorPick") }, data: { action: "pick-color" } }, input);
    const isCustom = !(SWATCHES as readonly string[]).includes(p.color);
    if (isCustom && !er) custom.setAttribute("aria-current", "true");
    this.swatchBox.replaceChildren(...SWATCHES.map((c) => sw(c, false)), custom, ...p.colorRecent.filter((c) => !(SWATCHES as readonly string[]).includes(c)).map((c) => sw(c, true)));
  }

  // ---------- brush menu ----------

  private toggleMenu(): void {
    if (this.menu) { this.closeMenu(); return; }
    const p = this.host.prefs;
    const menu = h("div", { class: "menu brush-menu", attrs: { role: "menu", "aria-label": t("brushes") }, data: { testid: "brush-menu" } }, h("h2", { text: t("brushes") }));
    BRUSHES.forEach((b, i) => {
      const o = h("button", { class: "bopt", attrs: { type: "button", role: "menuitemradio", "aria-checked": String(b === p.brush) }, data: { brush: b } },
        h("canvas"), h("b", {}, icon(b), h("span", { text: t(brushKey(b)) }), h("kbd", { text: String(i + 1) })), h("small", { text: t(descKey(b)) }));
      o.addEventListener("click", () => { this.setBrush(b); this.closeMenu(); });
      menu.append(o);
    });
    this.popup(menu, this.brushBtn);
    this.drawPreviews();
  }

  /** Which eraser the eraser button uses: erase lines only, or everything with the layer colour. */
  private toggleEraserMenu(): void {
    const open = this.menu?.dataset.testid === "eraser-menu";
    this.closeMenu();
    if (open) return;
    const p = this.host.prefs;
    const menu = h("div", { class: "menu lmenu", attrs: { role: "menu", "aria-label": t("eraserChoose") }, data: { testid: "eraser-menu" } });
    for (const b of ["eraser", "eraserall"] as const) {
      const o = button({ icon: b, label: t(brushKey(b)), class: "mi", data: { brush: b } });
      o.setAttribute("role", "menuitemradio");
      o.setAttribute("aria-checked", String(p.eraser === b));
      o.append(h("small", { text: t(descKey(b)) }));
      o.addEventListener("click", () => { this.closeMenu(); this.host.toDraw(); this.setBrush(b); });
      menu.append(o);
    }
    this.popup(menu, this.eraserBtn);
  }

  /** Show a menu beside the button that opened it, towards the middle of the screen. */
  private popup(menu: HTMLElement, anchor: HTMLElement): void {
    this.el.parentElement?.append(menu);
    this.menu = menu;
    anchor.setAttribute("aria-expanded", "true");
    const a = this.host.area(), r = this.el.getBoundingClientRect(), br = anchor.getBoundingClientRect();
    const at = menuAt({ x: br.x, y: br.y, w: br.width, h: br.height }, menu.offsetWidth, menu.offsetHeight, { x: r.x, y: r.y, w: r.width, h: r.height }, a);
    const host = menu.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    menu.style.transform = `translate(${at.x - host.left}px, ${at.y - host.top}px)`;
  }

  private toggleSelectMenu(): void {
    const open = this.menu?.dataset.testid === "select-menu";
    this.closeMenu();
    if (open) return;
    const menu = h("div", { class: "menu lmenu sel-menu", attrs: { role: "menu", "aria-label": t("selectTool") }, data: { testid: "select-menu" } });
    for (const it of this.host.selectItems()) {
      if (it.data === "-") { menu.append(h("hr")); continue; }
      const b = button({ icon: it.icon, label: t(it.key), class: "mi", data: { item: it.data } });
      b.setAttribute("role", it.checked === undefined ? "menuitem" : "menuitemradio");
      if (it.checked !== undefined) b.setAttribute("aria-checked", String(it.checked));
      if (it.kbd) b.append(h("kbd", { text: it.kbd }));
      b.disabled = !it.enabled;
      b.addEventListener("click", () => { this.closeMenu(); it.act(); });
      menu.append(b);
    }
    this.popup(menu, this.selBtn);
  }

  /** a menu of the toolbar is open */
  get menuOpen(): boolean { return !!this.menu; }

  closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.brushBtn.setAttribute("aria-expanded", "false");
    this.selBtn.setAttribute("aria-expanded", "false");
    this.eraserBtn.setAttribute("aria-expanded", "false");
  }

  /** A short sample stroke of every brush, in the current colour and its own size and strength. */
  private drawPreviews(): void {
    if (!this.menu) return;
    const p = this.host.prefs;
    for (const c of this.menu.querySelectorAll<HTMLCanvasElement>(".bopt canvas")) {
      const b = (c.parentElement as HTMLElement).dataset.brush as BrushId;
      const r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (r.width < 2) continue;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      const x = c.getContext("2d");
      if (!x) continue;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = r.width, hh = r.height, pts: [number, number, number, number][] = [];
      let time = 0;
      for (let k = 0; k <= 40; k++) { const u = k / 40; time += u < 0.5 ? 22 : 7; pts.push([12 + u * (w - 24), hh / 2 + Math.sin(u * Math.PI * 2) * hh * 0.22, 0.5, time]); }
      const s = p.brushes[b], er = isEraser(b);
      const entry: StrokeEntry = { kind: "stroke", brush: er ? "pen" : b, color: er ? "#c9ced9" : p.color, size: Math.min(s.size, hh * 0.55), opacity: er ? 1 : s.op / 100, pressure: false, seed: 7, vs: 1, points: pts };
      renderEntry(x, entry, { dpr, w, h: hh, image: () => undefined });
    }
  }

  // ---------- placing and dragging ----------

  /** Put the toolbar where its state says, inside the work area. */
  place(): void {
    this.el.classList.toggle("compact", this.tb.size === "compact");
    this.el.classList.toggle("bubble", this.tb.size === "bubble");
    this.el.classList.toggle("horizontal", isHorizontal(this.tb));
    this.el.dataset.side = this.tb.side;
    const a = this.host.area(), parent = this.el.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const at = place(this.tb, this.el.offsetWidth, this.el.offsetHeight, a);
    this.el.style.transform = `translate(${at.x - parent.left}px, ${at.y - parent.top}px)`;
    this.host.insetChanged();
  }

  private setSize(s: TbState["size"]): void {
    this.tb = { ...this.tb, size: s };
    this.closeMenu();
    this.store();
  }

  private store(): void {
    this.host.prefs.toolbar[this.orient] = this.tb;
    this.host.savePrefs();
    this.place();
  }

  private readonly onGripDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    this.grip.setPointerCapture(e.pointerId);
    this.closeMenu();
    const r = this.el.getBoundingClientRect();
    this.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
  };

  private readonly onGripMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
    d.moved = true;
    this.el.classList.add("dragging");
    const a = this.host.area(), parent = this.el.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const at = place({ ...this.tb, side: "free", x: e.clientX - d.dx, y: e.clientY - d.dy }, this.el.offsetWidth, this.el.offsetHeight, a);
    this.el.style.transform = `translate(${at.x - parent.left}px, ${at.y - parent.top}px)`;
  };

  private readonly onGripUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.el.classList.remove("dragging");
    if (!d.moved) { this.setSize(nextSize(this.tb.size)); return; }
    const r = this.el.getBoundingClientRect();
    this.tb = drop(this.tb, { x: r.left, y: r.top, w: r.width, h: r.height }, this.host.area());
    this.store();
  };

  destroy(): void {
    this.closeMenu();
    for (const off of this.offs) off();
  }
}
