import { LAYER_BUDGET_BYTES } from "../core";
import { t, type MessageKey } from "../i18n";
import { StrokeMeter, type PointerKind } from "../input";
import { storageInfo } from "../storage";
import { openDialog } from "./dialog";
import { button, formatDate, h } from "./dom";
import { clearErrors, loadErrors } from "./errorLog";
import { toast } from "./toast";

/**
 * The diagnostics page: what the tablet really does, measured while the app is used, next to the
 * targets in the spec. Nothing leaves the device; "copy" puts the report on the clipboard to paste
 * wherever the person wants.
 */

/** spec targets */
export const TARGET_FPS = 144;
export const TARGET_BLOCK_MS = 50;
export const TARGET_OPEN_MS = 1000;
/** about what the Focus Pen sends; shown for comparison, never used by the drawing code */
export const PEN_RATE_HINT = 240;

export const meter = new StrokeMeter();
const blocks = { count: 0, maxMs: 0 };
let openMs: number | null = null;
let started = false;

/** Watch for work that blocks the screen (long tasks) from now on. */
export function startDiagnostics(): void {
  if (started) return;
  started = true;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { blocks.count++; blocks.maxMs = Math.max(blocks.maxMs, e.duration); }
    }).observe({ type: "longtask", buffered: true });
  } catch { /* not in this browser: shown as unknown */ }
}

/** How long opening the last work took. */
export function noteOpen(ms: number): void { openMs = ms; }

/** A stroke began: count its points and the screen's frames until it ends. */
export function trackStroke(kind: PointerKind, t: number): void {
  meter.start(kind, t);
  const tick = (now: number) => { if (!meter.active) return; meter.frame(now); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

export interface DiagHost {
  /** the open work's current page: layers and paper size */
  work?(): { layers: number; w: number; h: number };
}

type Row = { key: MessageKey; value: string; ok?: boolean | null };

const mb = (b: number) => `${Math.round(b / 1e6).toLocaleString("en-US")} MB`;
const r0 = (n: number) => Math.round(n).toLocaleString("en-US");

function browserLine(): string {
  const ua = navigator.userAgent;
  const chrome = /Chrome\/(\d+)/.exec(ua)?.[1], android = /Android ([\d.]+)/.exec(ua)?.[1];
  return [chrome ? `Chrome ${chrome}` : ua.slice(0, 60), android ? `Android ${android}` : ""].filter(Boolean).join(" · ");
}

/** Screen refresh rate, by counting frames for a moment. */
function measureScreen(ms = 1000): Promise<number | null> {
  return new Promise((resolve) => {
    let first = 0, n = 0;
    const tick = (now: number) => {
      if (!first) first = now;
      n++;
      if (now - first >= ms) resolve(n > 2 ? ((n - 1) * 1000) / (now - first) : null); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(null), ms + 1500);
  });
}

/** The frame rate to aim for: the spec's 144, or the screen's own rate when it is lower. */
export const fpsTarget = (screenHz: number | null): number => Math.round(screenHz ? Math.min(TARGET_FPS, screenHz) : TARGET_FPS);

function strokeRows(screenHz: number | null = null): Row[] {
  const pen = meter.summary("pen"), touch = meter.summary("touch"), mouse = meter.summary("mouse");
  const best = [pen, touch, mouse].find((s) => s.strokes > 0);
  const rows: Row[] = [];
  rows.push({ key: "diagPenRate", value: pen.rateHz === null ? t("diagNoStrokes") : t("diagPerSecond", { n: r0(pen.rateHz) }) + ` · ${t("diagPenRateHint", { n: PEN_RATE_HINT })}` });
  if (touch.rateHz !== null) rows.push({ key: "diagTouchRate", value: t("diagPerSecond", { n: r0(touch.rateHz) }) });
  const fps = best?.fps ?? null, worst = Math.max(pen.worstFrameMs ?? 0, touch.worstFrameMs ?? 0, mouse.worstFrameMs ?? 0);
  const aim = fpsTarget(screenHz);
  rows.push({ key: "diagFps", value: fps === null ? t("diagNoStrokes") : `${t("diagFpsValue", { n: r0(fps) })} · ${t(aim < TARGET_FPS ? "diagTargetScreen" : "diagTarget", { n: aim })}`, ok: fps === null ? null : fps >= aim * 0.95 });
  if (best) rows.push({ key: "diagWorstFrame", value: t("diagMs", { n: r0(worst) }), ok: worst <= TARGET_BLOCK_MS });
  rows.push({ key: "diagStrokes", value: String(pen.strokes + touch.strokes + mouse.strokes) });
  return rows;
}

function report(rows: Row[]): string {
  const errs = loadErrors();
  return [
    `${t("appName")} · ${t("diagTitle")} · ${formatDate(Date.now())}`,
    ...rows.map((r) => `${t(r.key)}: ${r.value}${r.ok === false ? " ✗" : r.ok ? " ✓" : ""}`),
    "",
    `${t("diagErrors")} (${errs.length})`,
    ...[...errs].reverse().map((e) => `- ${new Date(e.t).toISOString()} [${e.kind}] ${e.msg}${e.where ? `\n  ${e.where.split("\n").slice(0, 4).join("\n  ")}` : ""}`),
  ].join("\n");
}

/** Open the diagnostics page. */
export function openDiagnostics(host: DiagHost = {}): void {
  const list = h("dl", { class: "diag", data: { testid: "diag" } });
  const rows: Row[] = [];
  const render = () => {
    list.replaceChildren(...rows.flatMap((r) => {
      const dd = h("dd", { text: r.value, data: { row: r.key } });
      if (r.ok === true) dd.classList.add("ok");
      if (r.ok === false) dd.classList.add("bad");
      return [h("dt", { text: t(r.key) }), dd];
    }));
  };
  const set = (key: MessageKey, value: string, ok?: boolean | null) => {
    const i = rows.findIndex((r) => r.key === key), row: Row = { key, value, ok: ok ?? null };
    if (i >= 0) rows[i] = row; else rows.push(row);
    render();
  };

  set("diagVersion", __APP_VERSION__);
  set("diagBrowser", browserLine());
  set("diagScreen", `${screen.width} × ${screen.height} · ×${Math.round(devicePixelRatio * 100) / 100}`);
  set("diagRefresh", t("diagMeasuring"));
  for (const r of strokeRows()) set(r.key, r.value, r.ok);
  set("diagBlocks", blocks.count ? `${t("diagBlocksValue", { n: blocks.count, ms: r0(blocks.maxMs) })} · ${t("diagBlocksTarget", { n: TARGET_BLOCK_MS })}` : t("diagBlocksNone"),
    blocks.count === 0 || blocks.maxMs <= TARGET_BLOCK_MS);
  set("diagOpen", openMs === null ? t("diagOpenNone") : `${t("diagMs", { n: r0(openMs) })} · ${t("diagOpenTarget", { n: TARGET_OPEN_MS })}`, openMs === null ? null : openMs <= TARGET_OPEN_MS);
  const w = host.work?.();
  if (w) {
    const bytes = w.layers * w.w * w.h * 4;
    set("diagLayersMem", t("diagLayersMemValue", { n: w.layers, used: mb(bytes), budget: mb(LAYER_BUDGET_BYTES) }), bytes <= LAYER_BUDGET_BYTES);
  }
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  set("diagHeap", heap ? t("diagOf", { used: mb(heap.usedJSHeapSize), all: mb(heap.jsHeapSizeLimit) }) : t("diagUnknown"));
  set("diagStorage", t("diagMeasuring"));

  void storageInfo().then((s) => {
    set("diagStorage", s.usedBytes !== null && s.quotaBytes !== null ? t("diagOf", { used: mb(s.usedBytes), all: mb(s.quotaBytes) }) : t("diagUnknown"));
    set("diagPersist", s.persisted === null ? t("diagUnknown") : t(s.persisted ? "diagYes" : "diagNo"), s.persisted);
  });
  void measureScreen().then((hz) => {
    set("diagRefresh", hz === null ? t("diagUnknown") : t("diagHz", { n: r0(hz) }));
    const fps = strokeRows(hz).find((r) => r.key === "diagFps");
    if (fps) set(fps.key, fps.value, fps.ok);
  });

  // errors, newest first
  const errBox = h("div", { class: "diag-errors", data: { testid: "diag-errors" } });
  const showErrors = () => {
    const errs = loadErrors();
    errBox.replaceChildren(
      h("h3", { text: `${t("diagErrors")} (${errs.length})` }),
      errs.length
        ? h("ol", {}, ...[...errs].reverse().map((e) => h("li", { class: e.kind }, h("small", { text: `${formatDate(e.t)} · ${t(e.kind === "crash" ? "diagCrash" : "diagLogged")}` }), h("code", { text: e.msg }))))
        : h("p", { class: "xnote", text: t("diagErrorsNone") }));
    clear.disabled = !errs.length;
  };
  const clear = button({ label: t("diagErrorsClear"), class: "ghost", data: { action: "diag-clear" }, onClick: () => { clearErrors(); showErrors(); } });
  const copy = button({ label: t("diagCopy"), class: "primary", data: { action: "diag-copy" }, onClick: () => {
    navigator.clipboard.writeText(report(rows)).then(() => toast(t("diagCopied")), () => toast(t("diagCopyFailed")));
  } });
  showErrors();
  openDialog(t("diagTitle"), [h("p", { class: "xnote", text: t("diagNote") }), list, errBox, h("div", { class: "sheet-foot" }, clear, copy)],
    () => undefined, { id: "diagnostics", closeLabel: t("close") });
}
