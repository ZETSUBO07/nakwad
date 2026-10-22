import "../styles.css";
import "./lab.css";
import { BRUSHES, commit, derive, newWork, redo, undo, type BrushId, type LayerProps, type Page, type Point, type StrokeEntry } from "../core";
import { t, type MessageKey } from "../i18n";
import { PageRenderer, fitScale, onCanvasRestored, targetDpr } from "../render";
import { exposeScenes } from "./scenes";

// Brush lab: try every brush, layer colour and both erasers on the real drawing engine.
// Simple input only; gestures, zoom and finger modes come in milestone M5.

const brushKey = (b: BrushId) => ("brush" + b[0]?.toUpperCase() + b.slice(1)) as MessageKey;
const SIZES: Record<BrushId, number> = { pen: 4, pencil: 6, ink: 14, nib: 16, marker: 24, spray: 30, eraser: 24, eraserall: 24 };
const OPACITY: Record<BrushId, number> = { pen: 1, pencil: 0.85, ink: 1, nib: 1, marker: 0.45, spray: 0.8, eraser: 1, eraserall: 1 };
const COLORS = ["#1d2230", "#e4472b", "#f2c94c", "#2e9e5b", "#2f54d6", "#ffffff"];
const LAYER_COLOR = "#cfe3ff";

const doc = newWork({ layerName: "1" });
let page: Page = doc.pages[0] as Page;
page = commit(page, { type: "add", id: "L2", index: 1 });
page = { ...page, actions: [], base: { ...page.base, order: ["L1", "L2"], layers: { L1: [], L2: [] } }, active: "L2" };
const props: Record<string, LayerProps> = { L1: { name: "1", visible: true, opacity: 1 }, L2: { name: "2", visible: true, opacity: 1 } };

const tool = { brush: "pen" as BrushId, color: COLORS[0] as string, size: SIZES.pen };
const renderer = new PageRenderer({ image: () => undefined });

const root = document.getElementById("app") as HTMLElement;
const bar = document.createElement("div");
bar.className = "labbar";
const hint = document.createElement("p");
hint.className = "labhint";
hint.textContent = t("labHint");
const desk = document.createElement("div");
desk.className = "desk";
const canvas = document.createElement("canvas");
const out = canvas.getContext("2d", { desynchronized: true, alpha: false }) as CanvasRenderingContext2D;
desk.append(canvas);
root.append(bar, hint, desk);
document.title = t("labTitle");

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

const title = document.createElement("h1");
title.textContent = t("labTitle");
const back = document.createElement("a");
back.href = import.meta.env.BASE_URL;
back.textContent = t("labBack");
bar.append(back, title);

const brushButtons = BRUSHES.map((b) => {
  const el = button(t(brushKey(b)), () => { tool.brush = b; tool.size = SIZES[b]; sizeInput.value = String(tool.size); sync(); });
  el.dataset.brush = b;
  return el;
});
bar.append(...brushButtons);

const swatches = COLORS.map((c) => {
  const el = button("", () => { tool.color = c; if (tool.brush === "eraser" || tool.brush === "eraserall") tool.brush = "pen"; sync(); });
  el.className = "swatch";
  el.style.background = c;
  el.setAttribute("aria-label", c);
  el.dataset.color = c;
  return el;
});
bar.append(...swatches);

const sizeLabel = document.createElement("label");
sizeLabel.textContent = t("labSize");
const sizeInput = document.createElement("input");
sizeInput.type = "range"; sizeInput.min = "1"; sizeInput.max = "80"; sizeInput.value = String(tool.size);
sizeInput.addEventListener("input", () => { tool.size = Number(sizeInput.value); });
sizeLabel.append(sizeInput);

const layerColor = button(t("labLayerColor"), () => {
  const has = (derive(page).layers.L2 ?? [])[0]?.kind === "bg";
  apply(commit(page, { type: "bg", layer: "L2", color: has ? null : LAYER_COLOR }));
});
layerColor.dataset.action = "layer-colour";
const spacer = document.createElement("span");
spacer.className = "spacer";
const meter = document.createElement("span");
meter.className = "meter";
bar.append(sizeLabel, layerColor,
  button(t("labUndo"), () => apply(undo(page))),
  button(t("labRedo"), () => apply(redo(page))),
  button(t("labClear"), () => apply(commit(page, { type: "clear", layer: "L2" }))),
  spacer, meter);

function sync(): void {
  for (const b of brushButtons) b.setAttribute("aria-pressed", String(b.dataset.brush === tool.brush));
  for (const s of swatches) s.setAttribute("aria-pressed", String(s.dataset.color === tool.color && tool.brush !== "eraser" && tool.brush !== "eraserall"));
  layerColor.setAttribute("aria-pressed", String((derive(page).layers.L2 ?? [])[0]?.kind === "bg"));
}

// ---------- layout and drawing ----------

let fit = 1;
/** set while an automated test draws its own scene, so the lab does not draw over it */
let paused = false;
function layout(): void {
  if (paused) return;
  const s = derive(page);
  const r = desk.getBoundingClientRect();
  fit = fitScale(r.width, r.height, s.w, s.h);
  canvas.style.width = `${Math.floor(s.w * fit)}px`;
  canvas.style.height = `${Math.floor(s.h * fit)}px`;
  renderer.setState(s, props, targetDpr(fit, 1, window.devicePixelRatio || 1, s.w, s.h));
  canvas.width = renderer.width;
  canvas.height = renderer.height;
  draw();
}

let live: StrokeEntry | null = null;
let frameMs = 0;
function draw(): void {
  if (paused) return;
  const t0 = performance.now();
  renderer.composite(out, "white", live ? { kind: "draw", layer: "L2", entry: live } : undefined);
  const dt = performance.now() - t0;
  frameMs = frameMs ? frameMs * 0.9 + dt * 0.1 : dt;
  meter.textContent = t("labFrameTime", { ms: frameMs.toFixed(1) });
}

function apply(next: Page): void {
  page = next;
  renderer.setState(derive(page), props);
  sync();
  draw();
}

const toPaper = (e: PointerEvent): [number, number] => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / fit, (e.clientY - r.top) / fit];
};
const pressure = (e: PointerEvent) => (e.pointerType === "pen" ? e.pressure || 0.5 : 0.5);

let raf = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = toPaper(e);
  renderer.prepareStroke("L2");
  live = {
    kind: "stroke", brush: tool.brush, color: tool.color, size: tool.size, opacity: OPACITY[tool.brush],
    pressure: e.pointerType === "pen", seed: (Math.random() * 1e9) | 0, vs: fit, points: [[x, y, pressure(e), e.timeStamp]],
  };
  draw();
});
canvas.addEventListener("pointermove", (e) => {
  if (!live) return;
  const events = e.getCoalescedEvents?.() ?? [];
  for (const ev of events.length ? events : [e]) {
    const [x, y] = toPaper(ev);
    live.points.push([x, y, pressure(ev), ev.timeStamp] as Point);
  }
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
});
const end = () => {
  if (!live) return;
  const entry = live;
  live = null;
  page = commit(page, { type: "draw", layer: "L2", entry });
  renderer.applyDraw(derive(page), "L2", entry);
  sync();
  draw();
};
canvas.addEventListener("pointerup", end);
canvas.addEventListener("pointercancel", end);

onCanvasRestored(canvas, () => { if (!paused) { renderer.rebuild(); draw(); } });
new ResizeObserver(() => layout()).observe(desk);
sync();
layout();
exposeScenes(canvas, out, () => { paused = true; });
