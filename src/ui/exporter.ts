import { zipSync, type Zippable } from "fflate";
import { MAX_AREA, derive, type LayerId, type LayerProps, type Page, type WorkDoc } from "../core";
import { t, type MessageKey } from "../i18n";
import { PageRenderer } from "../render";
import { openDialog } from "./dialog";
import { button, h } from "./dom";
import { toast } from "./toast";

export type ExportFormat = "png" | "jpg";
export type ExportWhat = "page" | "all" | "layer";

export interface ExportHost {
  doc(): WorkDoc;
  workName(): string;
  image(id: string): CanvasImageSource | undefined;
}

/** Resolutions offered: 1×, 2×, 4× while they stay within the 16-million-pixel canvas limit, and the largest that fits. */
export function scaleOptions(w: number, h: number): { key: string; d: number; ok: boolean }[] {
  const max = Math.sqrt(MAX_AREA / (w * h));
  return [...[1, 2, 4].map((k) => ({ key: `${k}x`, d: k, ok: k <= max + 1e-9 })), { key: "max", d: max, ok: true }];
}

/** A file name safe on every system. */
export function cleanFileName(v: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const n = v.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\.(png|jpe?g|zip)$/i, "").trim().slice(0, 80);
  return n || fallback;
}

/**
 * Draw a page (or one layer of it) at `d` device pixels per paper pixel. The paper colour is the
 * background unless the result should be transparent; JPG always gets a background.
 */
export function renderForExport(page: Page, props: Record<LayerId, LayerProps>, paper: string, d: number, opts: { layer?: LayerId; transparent: boolean; image: (id: string) => CanvasImageSource | undefined }): OffscreenCanvas {
  const s = derive(page);
  const shown: Record<LayerId, LayerProps> = opts.layer
    ? Object.fromEntries(s.order.map((id) => [id, { name: id, visible: id === opts.layer, opacity: id === opts.layer ? (props[id]?.opacity ?? 1) : 0 }]))
    : props;
  const r = new PageRenderer({ image: opts.image });
  r.setState(s, shown, d);
  const bg = opts.transparent ? undefined : paper === "none" ? "white" : paper;
  return r.flatten(bg);
}

const mime = (f: ExportFormat) => (f === "jpg" ? "image/jpeg" : "image/png");

function download(blob: Blob, file: string): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { attrs: { href: url, download: file } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The Export dialog (spec "Export"): PNG or JPG, this page / every page as one zip / the chosen layer, resolution, name. */
export function openExport(host: ExportHost): void {
  const doc = host.doc(), page = doc.pages[doc.current] as Page, s = derive(page);
  const st = { fmt: "png" as ExportFormat, what: "page" as ExportWhat, scale: "1x", transparent: doc.paper === "none" };
  const fmtSeg = h("div", { class: "seg", attrs: { role: "radiogroup", "aria-label": t("exportFormat") }, data: { field: "format" } });
  const whatSeg = h("div", { class: "seg", attrs: { role: "radiogroup", "aria-label": t("exportWhat") }, data: { field: "what" } });
  const scales = h("div", { class: "scales", attrs: { role: "radiogroup", "aria-label": t("exportScale") }, data: { field: "scale" } });
  const name = h("input", { class: "text-input", attrs: { type: "text", maxlength: "80", "aria-label": t("exportName") }, data: { field: "name" } });
  name.value = cleanFileName(host.workName(), "sketch");
  const ext = h("span", { class: "lbl" });
  const trans = h("input", { attrs: { type: "checkbox" }, data: { field: "transparent" } });
  const transRow = h("label", { class: "check" }, trans, h("span", { text: t("exportTransparent") }));
  const note = h("p", { class: "xnote" });
  const img = h("img", { class: "xpreview", attrs: { alt: t("exportPreview") }, data: { testid: "export-preview" } });
  const info = h("p", { class: "xinfo", attrs: { "aria-live": "polite" } });
  const save = button({ label: t("exportSave"), class: "primary", data: { action: "export-save" } });
  let blob: Blob | null = null, url = "", token = 0;

  const seg = (box: HTMLElement, items: [string, MessageKey | string][], cur: string, pick: (v: string) => void, disabled: (v: string) => boolean = () => false) => {
    box.replaceChildren(...items.map(([v, label]) => {
      const b = h("button", { attrs: { type: "button", role: "radio", "aria-checked": String(v === cur) }, data: { value: v } }, h("span", { text: label.startsWith("export") ? t(label as MessageKey) : label }));
      b.disabled = disabled(v);
      b.addEventListener("click", () => { if (v !== cur) pick(v); });
      return b;
    }));
  };
  const dpr = () => (scaleOptions(s.w, s.h).find((o) => o.key === st.scale) ?? { d: 1 }).d;
  const transparent = () => st.fmt === "png" && st.transparent;

  function sync(): void {
    seg(fmtSeg, [["png", "PNG"], ["jpg", "JPG"]], st.fmt, (v) => { st.fmt = v as ExportFormat; update(); });
    seg(whatSeg, [["page", "exportPage"], ["all", "exportAll"], ["layer", "exportLayer"]], st.what, (v) => { st.what = v as ExportWhat; if (v === "layer") st.transparent = true; update(); }, (v) => v === "all" && doc.pages.length < 2);
    scales.replaceChildren(...scaleOptions(s.w, s.h).map((o) => {
      const label = o.key === "max" ? t("exportScaleMax") : o.key.replace("x", "×");
      const b = h("button", { attrs: { type: "button", role: "radio", "aria-checked": String(o.key === st.scale) }, data: { value: o.key } },
        h("span", { text: t("exportScaleLine", { label, w: Math.round(s.w * o.d), h: Math.round(s.h * o.d) }) }));
      b.disabled = !o.ok;
      b.addEventListener("click", () => { st.scale = o.key; update(); });
      return b;
    }));
    ext.textContent = st.what === "all" ? ".zip" : `.${st.fmt}`;
    transRow.hidden = st.fmt !== "png";
    trans.checked = st.transparent;
    const layerName = doc.layers[page.active]?.name ?? page.active;
    const parts = [st.what === "all" ? t("exportNoteAll", { n: doc.pages.length }) : st.what === "layer" ? t("exportNoteLayer", { name: layerName }) : t("exportNotePage")];
    if (st.fmt === "jpg") parts.push(t("exportNoteJpg"));
    note.textContent = parts.join(" · ");
  }

  /** Make the preview (the page or layer that is open) whenever a choice changes. */
  function update(): void {
    sync();
    blob = null;
    save.disabled = true;
    info.textContent = t("exportMaking");
    const mine = ++token;
    setTimeout(async () => {
      if (mine !== token) return;
      const c = renderForExport(page, doc.layers, doc.paper, dpr(), { ...(st.what === "layer" ? { layer: page.active } : {}), transparent: transparent(), image: host.image });
      const b = await c.convertToBlob({ type: mime(st.fmt), quality: 0.92 });
      if (mine !== token) return;
      blob = b;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(b);
      img.src = url;
      info.textContent = t("exportInfo", { w: c.width, h: c.height, mb: (b.size / 1048576).toFixed(1) });
      save.disabled = false;
    }, 20);
  }

  trans.addEventListener("change", () => { st.transparent = trans.checked; update(); });
  save.addEventListener("click", async () => {
    const base = cleanFileName(name.value, "sketch");
    save.disabled = true;
    try {
      if (st.what !== "all") {
        if (!blob) return;
        const file = `${base}.${st.fmt}`;
        download(blob, file);
        toast(t("exportSaved", { file }));
        return;
      }
      // every page, each at the chosen resolution (capped by its own size), in one zip
      const files: Zippable = {};
      for (const [i, p] of doc.pages.entries()) {
        const ps = derive(p), opt = scaleOptions(ps.w, ps.h).find((o) => o.key === st.scale);
        const d = opt?.ok ? opt.d : Math.sqrt(MAX_AREA / (ps.w * ps.h));
        const c = renderForExport(p, doc.layers, doc.paper, d, { transparent: transparent(), image: host.image });
        const b = await c.convertToBlob({ type: mime(st.fmt), quality: 0.92 });
        files[`${base}-${i + 1}.${st.fmt}`] = [new Uint8Array(await b.arrayBuffer()), { level: 0 }];
      }
      const file = `${base}.zip`;
      download(new Blob([zipSync(files)], { type: "application/zip" }), file);
      toast(t("exportSaved", { file }));
    } catch (err) {
      console.error(err);
      toast(t("actionFailed"));
    } finally {
      save.disabled = false;
    }
  });

  openDialog(t("exportTitle"), [
    h("div", { class: "xrow" }, h("span", { class: "lbl", text: t("exportFormat") }), fmtSeg),
    h("div", { class: "xrow" }, h("span", { class: "lbl", text: t("exportWhat") }), whatSeg),
    h("div", { class: "xrow" }, h("span", { class: "lbl", text: t("exportScale") }), scales),
    h("div", { class: "xrow name" }, h("span", { class: "lbl", text: t("exportName") }), name, ext),
    transRow, note, img,
    h("div", { class: "sheet-foot" }, info, save),
  ], () => { token++; if (url) URL.revokeObjectURL(url); }, { id: "export", closeLabel: t("close") });
  update();
}
