import { PAPER_PRESET_COLORS, dropTarget, layerMenuState, moveTarget, type LayerId, type LayerProps, type MoveWhere, type PageState } from "../core";
import { t, type MessageKey } from "../i18n";
import { openDialog } from "./dialog";
import { menuAt, type Area } from "./dock";
import { button, h, icon, type IconName } from "./dom";
import { paperPicker } from "./paperPicker";

/** What the panel asks the editor to do. Every change to the picture is one undo step. */
export interface LayersHost {
  state(): PageState;
  props(): Readonly<Record<LayerId, LayerProps>>;
  active(): LayerId;
  maxLayers(): number;
  layerCanvas(id: LayerId): CanvasImageSource | undefined;
  /** the work area menus stay inside */
  area(): Area;
  recentColors(): readonly string[];
  select(id: LayerId): void;
  add(): void;
  duplicate(id: LayerId): void;
  remove(id: LayerId): void;
  merge(id: LayerId): void;
  move(id: LayerId, to: number): void;
  clear(id: LayerId): void;
  /** the layer colour; `final` false while the colour wheel is dragged (one undo step for the drag) */
  bg(id: LayerId, color: string | null, final: boolean): void;
  setProps(id: LayerId, patch: Partial<LayerProps>, final: boolean): void;
  exportLayer(id: LayerId): void;
}

const LONG_PRESS_MS = 500;
const MOVE_PX = 8;
const EDGE_PX = 40;

/** Layer colour as the picker shows it: preset names for white and cream. */
const pickerValue = (c: string | null) => (!c ? "none" : c === PAPER_PRESET_COLORS.white ? "white" : c === PAPER_PRESET_COLORS.cream ? "cream" : c);
const fromPicker = (v: string) => (v === "none" ? null : v === "white" ? PAPER_PRESET_COLORS.white : v === "cream" ? PAPER_PRESET_COLORS.cream : v);
const colorOf = (s: PageState, id: LayerId) => { const first = (s.layers[id] ?? [])[0]; return first?.kind === "bg" ? first.color : null; };

type Press = { id: number; layer: LayerId; row: HTMLElement; x0: number; y0: number; y: number; timer: number; mode: "wait" | "scroll" | "menu" | "drag"; scroll0: number };

/**
 * The layer panel: rows top to bottom, tap to choose, eye to hide, colour circle for the layer
 * colour, long-press or right-click for the menu, drag the handle (or long-press and keep moving)
 * to reorder. The list scrolls by dragging too, so no gesture fights the browser.
 */
export class LayersPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly opIn: HTMLInputElement;
  private readonly opOut: HTMLOutputElement;
  private menu: HTMLElement | null = null;
  private pop: HTMLElement | null = null;
  private press: Press | null = null;
  private ghost: HTMLElement | null = null;
  private line: HTMLElement | null = null;
  private slot = -1;
  private scrollRaf = 0;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly host: LayersHost) {
    this.addBtn = button({ icon: "plus", title: t("layerAdd"), class: "icon-btn", data: { action: "layer-add" }, onClick: () => host.add() });
    const close = button({ icon: "close", title: t("layersToggle"), class: "icon-btn ghost", data: { action: "layers-close" } });
    close.addEventListener("click", () => this.el.dispatchEvent(new CustomEvent("closepanel")));
    this.list = h("div", { class: "lrows", attrs: { role: "listbox", "aria-label": t("layers") } });
    this.opIn = h("input", { attrs: { type: "range", min: "0", max: "100", "aria-label": t("layerOpacity") }, data: { field: "layer-opacity" } });
    this.opOut = h("output");
    this.opIn.addEventListener("input", () => { this.opOut.value = `${this.opIn.value}%`; host.setProps(host.active(), { opacity: Number(this.opIn.value) / 100 }, false); });
    this.opIn.addEventListener("change", () => host.setProps(host.active(), { opacity: Number(this.opIn.value) / 100 }, true));
    this.el = h("aside", { class: "layers", attrs: { "aria-label": t("layers") }, data: { testid: "layers" } },
      h("div", { class: "lhead" }, h("h2", { text: t("layers") }), h("span", { class: "spacer" }), this.addBtn, close),
      this.list,
      h("label", { class: "lfoot" }, h("span", { text: t("layerOpacity") }), this.opOut, this.opIn));

    this.list.addEventListener("pointerdown", this.onDown);
    this.list.addEventListener("pointermove", this.onMove);
    this.list.addEventListener("pointerup", this.onUp);
    this.list.addEventListener("pointercancel", this.onUp);
    this.list.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>(".lrow");
      if (row?.dataset.layer) this.openMenu(row.dataset.layer, row);
    });
    const outside = (e: PointerEvent) => {
      const tgt = e.target as Node;
      if (this.menu && !this.menu.contains(tgt)) this.closeMenu();
      if (this.pop && !this.pop.contains(tgt) && !(tgt instanceof Element && tgt.closest(".lbg"))) this.closePop();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { this.closeMenu(); this.closePop(); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", esc);
    this.offs.push(() => document.removeEventListener("pointerdown", outside, true), () => document.removeEventListener("keydown", esc));
  }

  /** Redraw the rows from the editor's state (cheap: a few dozen rows at most). */
  update(): void {
    if (this.press?.mode === "drag") return;
    const s = this.host.state(), props = this.host.props(), active = this.host.active();
    const rows = [...s.order].reverse().map((id) => this.row(id, s, props[id], id === active));
    this.list.replaceChildren(...rows);
    this.addBtn.disabled = s.order.length >= this.host.maxLayers();
    this.addBtn.title = this.addBtn.disabled ? t("layerFull", { n: this.host.maxLayers() }) : t("layerAdd");
    const p = props[active];
    this.opIn.value = String(Math.round((p?.opacity ?? 1) * 100));
    this.opOut.value = `${this.opIn.value}%`;
    this.thumbs();
  }

  /** Redraw just the small pictures (after a stroke). */
  thumbs(): void {
    for (const c of this.list.querySelectorAll<HTMLCanvasElement>(".lrow canvas")) {
      const id = (c.closest(".lrow") as HTMLElement).dataset.layer ?? "";
      const src = this.host.layerCanvas(id), x = c.getContext("2d");
      if (!x) continue;
      x.clearRect(0, 0, c.width, c.height);
      if (src) x.drawImage(src, 0, 0, c.width, c.height);
    }
  }

  private row(id: LayerId, s: PageState, p: LayerProps | undefined, active: boolean): HTMLElement {
    const name = p?.name ?? id, visible = p?.visible ?? true, color = colorOf(s, id);
    const ratio = s.w / s.h, tw = ratio >= 1.45 ? 54 : Math.round(36 * ratio), th = ratio >= 1.45 ? Math.round(54 / ratio) : 36;
    const thumb = h("canvas", { attrs: { width: String(tw * 2), height: String(th * 2) } });
    thumb.style.width = `${tw}px`;
    thumb.style.height = `${th}px`;
    const eye = button({ icon: visible ? "eye" : "eyeOff", title: t(visible ? "layerHide" : "layerShow", { name }), class: "icon-btn eye", data: { action: "layer-eye" } });
    eye.setAttribute("aria-pressed", String(visible));
    eye.addEventListener("click", () => this.host.setProps(id, { visible: !visible }, true));
    const bg = button({ title: t("layerColorOf", { name }), class: "icon-btn lbg", data: { action: "layer-color" } });
    const dot = h("span", { class: color ? "pdot" : "pdot pdot-none" });
    if (color) dot.style.background = color;
    bg.append(dot);
    bg.addEventListener("click", () => this.openPop(id, bg));
    const handle = h("span", { class: "lhandle", attrs: { "aria-label": t("layerDrag", { name }), title: t("layerDrag", { name }) }, data: { action: "layer-drag" } }, icon("handle"));
    const label = h("div", { class: "lname" }, h("b", { text: name }),
      p?.locked ? h("span", { class: "llock", attrs: { title: t("layerLockedIcon"), "aria-label": t("layerLockedIcon") } }, icon("lock")) : null,
      p && p.opacity < 1 ? h("small", { text: `${Math.round(p.opacity * 100)}%` }) : null);
    const row = h("div", { class: active ? "lrow active" : "lrow", attrs: { role: "option", "aria-selected": String(active), "aria-label": t("layerSelect", { name }) }, data: { layer: id } },
      eye, thumb, label, bg, handle);
    if (!visible) row.classList.add("hidden-layer");
    return row;
  }

  // ---------- press, long-press, scroll, drag ----------

  private readonly onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement, row = target.closest<HTMLElement>(".lrow");
    if (!row?.dataset.layer || this.press) return;
    // buttons inside the row do their own thing
    if (target.closest("button")) return;
    e.preventDefault();
    this.list.setPointerCapture(e.pointerId);
    const p: Press = { id: e.pointerId, layer: row.dataset.layer, row, x0: e.clientX, y0: e.clientY, y: e.clientY, timer: 0, mode: "wait", scroll0: this.list.scrollTop };
    this.press = p;
    if (target.closest(".lhandle")) { this.startDrag(p); return; }
    p.timer = window.setTimeout(() => { if (this.press === p && p.mode === "wait") { p.mode = "menu"; this.openMenu(p.layer, row); } }, LONG_PRESS_MS);
  };

  private readonly onMove = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    p.y = e.clientY;
    const moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > MOVE_PX;
    if (p.mode === "wait" && moved) { clearTimeout(p.timer); p.mode = "scroll"; }
    // long-press and keep moving: the menu gives way to dragging the row
    if (p.mode === "menu" && moved) { this.closeMenu(); this.startDrag(p); }
    if (p.mode === "scroll") this.list.scrollTop = p.scroll0 - (e.clientY - p.y0);
    if (p.mode === "drag") this.dragTo(e.clientY);
  };

  private readonly onUp = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    clearTimeout(p.timer);
    this.press = null;
    if (p.mode === "wait" && e.type === "pointerup") this.host.select(p.layer);
    if (p.mode === "drag") this.endDrag(p, e.type === "pointerup");
  };

  private startDrag(p: Press): void {
    p.mode = "drag";
    const r = p.row.getBoundingClientRect();
    this.ghost = p.row.cloneNode(true) as HTMLElement;
    this.ghost.classList.add("ghost");
    this.ghost.style.width = `${r.width}px`;
    this.line = h("div", { class: "ldrop" });
    this.list.append(this.line);
    this.el.append(this.ghost);
    p.row.classList.add("dragging");
    this.dragTo(p.y);
    const tick = () => {
      if (!this.press || this.press.mode !== "drag") return;
      const b = this.list.getBoundingClientRect(), y = this.press.y;
      // near the top or bottom edge the list scrolls by itself
      const speed = y < b.top + EDGE_PX ? -(b.top + EDGE_PX - y) : y > b.bottom - EDGE_PX ? y - (b.bottom - EDGE_PX) : 0;
      if (speed) { this.list.scrollTop += speed * 0.4; this.dragTo(y); }
      this.scrollRaf = requestAnimationFrame(tick);
    };
    this.scrollRaf = requestAnimationFrame(tick);
  }

  private dragTo(y: number): void {
    const rows = [...this.list.querySelectorAll<HTMLElement>(".lrow")];
    let slot = rows.length;
    for (const [i, r] of rows.entries()) { const b = r.getBoundingClientRect(); if (y < b.top + b.height / 2) { slot = i; break; } }
    this.slot = slot;
    const panel = this.el.getBoundingClientRect(), lb = this.list.getBoundingClientRect();
    if (this.ghost) this.ghost.style.transform = `translate(${lb.left - panel.left}px, ${Math.min(Math.max(y, lb.top), lb.bottom) - panel.top - 24}px)`;
    if (this.line) {
      const ref = rows[slot] ?? rows[rows.length - 1];
      const rb = ref?.getBoundingClientRect();
      const lineY = rb ? (rows[slot] ? rb.top - 3 : rb.bottom + 1) : lb.top;
      this.line.style.transform = `translateY(${lineY - lb.top + this.list.scrollTop}px)`;
    }
  }

  private endDrag(p: Press, drop: boolean): void {
    cancelAnimationFrame(this.scrollRaf);
    this.ghost?.remove();
    this.line?.remove();
    this.ghost = this.line = null;
    p.row.classList.remove("dragging");
    const to = drop ? dropTarget(this.host.state().order, p.layer, this.slot) : null;
    if (to !== null) this.host.move(p.layer, to);
    else this.update();
  }

  // ---------- menu ----------

  private openMenu(id: LayerId, row: HTMLElement): void {
    this.closeMenu();
    this.closePop();
    const s = this.host.state(), props = this.host.props(), p = props[id], m = layerMenuState(s, props, id, this.host.maxLayers());
    const item = (key: MessageKey, ic: IconName, enabled: boolean, act: () => void, data: string) => {
      const b = button({ icon: ic, label: t(key), class: "mi", data: { item: data } });
      b.setAttribute("role", "menuitem");
      b.disabled = !enabled;
      b.addEventListener("click", () => { this.closeMenu(); act(); });
      return b;
    };
    const move = (where: MoveWhere) => () => { const to = moveTarget(this.host.state().order, id, where); if (to !== null) this.host.move(id, to); };
    const menu = h("div", { class: "menu lmenu", attrs: { role: "menu", "aria-label": t("layerMenuOf", { name: p?.name ?? id }) }, data: { testid: "layer-menu" } },
      item("layerMoveTop", "top", m.top, move("top"), "top"),
      item("layerMoveUp", "up", m.up, move("up"), "up"),
      item("layerMoveDown", "down", m.down, move("down"), "down"),
      item("layerMoveBottom", "bottom", m.bottom, move("bottom"), "bottom"),
      h("hr"),
      item("layerDuplicate", "copy", m.duplicate, () => this.host.duplicate(id), "duplicate"),
      item("layerMergeDown", "merge", m.merge, () => this.host.merge(id), "merge"),
      item("layerRename", "rename", true, () => this.rename(id), "rename"),
      item("layerColor", "palette", true, () => this.openPop(id, row), "color"),
      item(p?.visible === false ? "layerShowItem" : "layerHideItem", p?.visible === false ? "eye" : "eyeOff", true, () => this.host.setProps(id, { visible: p?.visible === false }, true), "visible"),
      item(p?.locked ? "layerUnlock" : "layerLock", p?.locked ? "unlock" : "lock", true, () => this.host.setProps(id, { locked: !p?.locked }, true), "lock"),
      item("layerExport", "download", true, () => this.host.exportLayer(id), "export"),
      h("hr"),
      item("layerClear", "clear", m.clear, () => this.host.clear(id), "clear"),
      item("layerDelete", "trash", m.delete, () => this.host.remove(id), "delete"));
    this.el.append(menu);
    this.menu = menu;
    this.placeBeside(menu, row);
    (menu.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  /** Next to the row, on the side towards the middle of the screen. */
  private placeBeside(el: HTMLElement, row: HTMLElement): void {
    const a = this.host.area(), pr = this.el.getBoundingClientRect(), rr = row.getBoundingClientRect();
    const whole: Area = { left: Math.min(a.left, pr.left), top: Math.min(a.top, pr.top), right: Math.max(a.right, pr.right), bottom: Math.max(a.bottom, pr.bottom) };
    const at = menuAt({ x: rr.x, y: rr.y, w: rr.width, h: rr.height }, el.offsetWidth, el.offsetHeight, { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, whole);
    el.style.transform = `translate(${at.x - pr.left}px, ${at.y - pr.top}px)`;
  }

  closeMenu(): void { this.menu?.remove(); this.menu = null; }

  // ---------- layer colour ----------

  private openPop(id: LayerId, near: HTMLElement): void {
    this.closeMenu();
    this.closePop();
    const name = this.host.props()[id]?.name ?? id;
    const picker = paperPicker(() => pickerValue(colorOf(this.host.state(), id)), (v, final) => this.host.bg(id, fromPicker(v), final), () => this.host.recentColors(),
      { noneLabel: t("layerColorNone"), label: t("layerColorTitle") });
    const pop = h("div", { class: "menu bgpop", attrs: { role: "dialog", "aria-label": t("layerColorOf", { name }) }, data: { testid: "layer-color" } },
      h("h2", { text: t("layerColorOf", { name }) }), picker.el, h("p", { text: t("layerColorNote") }));
    this.el.append(pop);
    this.pop = pop;
    const row = near.closest<HTMLElement>(".lrow") ?? near;
    this.placeBeside(pop, row);
  }

  closePop(): void { this.pop?.remove(); this.pop = null; }

  private rename(id: LayerId): void {
    const input = h("input", { class: "text-input", attrs: { type: "text", maxlength: "60", "aria-label": t("layerName") } });
    input.value = this.host.props()[id]?.name ?? "";
    const ok = button({ label: t("save"), class: "primary", data: { action: "rename-ok" } });
    const dlg = openDialog(t("layerRenameTitle"), [input, h("div", { class: "sheet-foot" }, h("span"), ok)], () => undefined);
    const submit = () => { const v = input.value.trim(); dlg.close(); if (v) this.host.setProps(id, { name: v }, true); };
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    input.select();
  }

  destroy(): void {
    this.closeMenu();
    this.closePop();
    cancelAnimationFrame(this.scrollRaf);
    for (const off of this.offs) off();
  }
}
