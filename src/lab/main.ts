import "../styles.css";
import "./lab.css";
import { BRUSHES, commit, derive, newWork, redo, undo, type BrushId, type LayerProps, type Page, type Point, type StrokeEntry } from "../core";
import { t, type MessageKey } from "../i18n";
import { PageRenderer, fitScale, onCanvasRestored, targetDpr } from "../render";
import { IDENTITY, Stabilizer, attachInput, zoomPercent, type Frame, type View } from "../input";
import { exposeScenes } from "./scenes";

// Brush lab: try every brush, layer colour and both erasers on the real drawing engine,
// with the real pen and finger rules (M5): zoom, rotate, undo/redo taps, finger modes.

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
hint.textContent = `${t("labHint")} · ${t("labGestures")}`;
const desk = document.createElement("div");
desk.className = "desk";
const canvas = document.createElement("canvas");
const out = canvas.getContext("2d", { desynchronized: true, alpha: false }) as CanvasRenderingContext2D;
const ring = document.createElement("div");
ring.className = "hover-ring";
ring.hidden = true;
desk.append(canvas, ring);
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
const fingerBtn = button(t("labFingerDraw"), () => { input.setFingerMode(input.fingerMode === "draw" ? "pen" : "draw"); sync(); });
fingerBtn.dataset.action = "finger-draw";
const stabLabel = document.createElement("label");
stabLabel.textContent = t("labStabilizer");
const stabInput = document.createElement("input");
stabInput.type = "range"; stabInput.min = "0"; stabInput.max = "100"; stabInput.value = "5";
stabLabel.append(stabInput);
const zoomBtn = button("", () => fitView());
zoomBtn.dataset.action = "zoom";
zoomBtn.title = t("labFit");
const spacer = document.createElement("span");
spacer.className = "spacer";
const meter = document.createElement("span");
meter.className = "meter";
bar.append(sizeLabel, layerColor,
  button(t("labUndo"), () => apply(undo(page))),
  button(t("labRedo"), () => apply(redo(page))),
  button(t("labClear"), () => apply(commit(page, { type: "clear", layer: "L2" }))),
  fingerBtn, stabLabel, zoomBtn, spacer, meter);

function sync(): void {
  for (const b of brushButtons) b.setAttribute("aria-pressed", String(b.dataset.brush === tool.brush));
  for (const s of swatches) s.setAttribute("aria-pressed", String(s.dataset.color === tool.color && tool.brush !== "eraser" && tool.brush !== "eraserall"));
  layerColor.setAttribute("aria-pressed", String((derive(page).layers.L2 ?? [])[0]?.kind === "bg"));
  fingerBtn.setAttribute("aria-pressed", String(input.fingerMode === "draw"));
}

// ---------- layout and drawing ----------

let fit = 1;
let view: View = IDENTITY;
/** set while an automated test draws its own scene, so the lab does not draw over it */
let paused = false;

function frame(): Frame {
  const r = desk.getBoundingClientRect(), s = derive(page);
  return { center: [r.left + r.width / 2, r.top + r.height / 2], fit, w: s.w, h: s.h };
}

/** Sharpness follows the zoom: re-render the layers when the needed resolution changed. */
function resolution(force: boolean): void {
  const s = derive(page);
  const dpr = targetDpr(fit, view.s, window.devicePixelRatio || 1, s.w, s.h);
  if (!force && Math.abs(dpr - renderer.resolution) / renderer.resolution < 0.05) return;
  renderer.setState(s, props, dpr);
  canvas.width = renderer.width;
  canvas.height = renderer.height;
}

function layout(): void {
  if (paused) return;
  const s = derive(page);
  const r = desk.getBoundingClientRect();
  fit = fitScale(r.width, r.height, s.w, s.h);
  canvas.style.width = `${s.w * fit}px`;
  canvas.style.height = `${s.h * fit}px`;
  resolution(true);
  place();
  draw();
}

function place(): void {
  canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) rotate(${view.r}rad) scale(${view.s})`;
  zoomBtn.textContent = t("labZoom", { n: String(zoomPercent(view, frame())) });
}

function setView(v: View, settled: boolean): void {
  if (paused) return;
  view = v;
  place();
  if (settled) { resolution(false); draw(); }
}
function fitView(): void { setView(IDENTITY, true); }

let live: StrokeEntry | null = null;
let predicted: Point[] = [];
let frameMs = 0;
function draw(): void {
  if (paused) return;
  const t0 = performance.now();
  const entry = live && predicted.length ? { ...live, points: [...live.points, ...predicted] } : live;
  renderer.composite(out, "white", entry ? { kind: "draw", layer: "L2", entry } : undefined);
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

let stab = new Stabilizer(0);
let lastCommitted: StrokeEntry | null = null;

const input = attachInput(desk, {
  frame,
  view: () => view,
  setView,
  strokeStart(p, kind) {
    if (paused) return;
    stab = new Stabilizer(Number(stabInput.value));
    renderer.prepareStroke("L2");
    live = {
      kind: "stroke", brush: tool.brush, color: tool.color, size: tool.size, opacity: OPACITY[tool.brush],
      // stroke width keeps the size the user sees on screen, whatever the zoom
      pressure: kind === "pen", seed: (Math.random() * 1e9) | 0, vs: fit * view.s, points: [stab.start(p)],
    };
    predicted = [];
    draw();
  },
  strokeMove(points, guess) {
    if (!live) return;
    for (const p of points) live.points.push(stab.add(p));
    // the line up to the pen, plus where the pen is about to be, drawn at once
    predicted = [...stab.tail(), ...guess];
    draw();
  },
  strokeEnd() {
    if (!live) return;
    live.points.push(...stab.finish());
    const entry = live;
    live = null;
    predicted = [];
    page = commit(page, { type: "draw", layer: "L2", entry });
    renderer.applyDraw(derive(page), "L2", entry);
    lastCommitted = entry;
    sync();
    draw();
  },
  strokeCancel() { live = null; predicted = []; draw(); },
  undo: () => apply(undo(page)),
  redo: () => apply(redo(page)),
  fit: fitView,
  hover(at) {
    if (!at) { ring.hidden = true; return; }
    const d = tool.size * view.s * fit, r = desk.getBoundingClientRect();
    ring.hidden = false;
    ring.style.width = ring.style.height = `${d}px`;
    ring.style.transform = `translate(${at[0] - r.left - d / 2}px, ${at[1] - r.top - d / 2}px)`;
  },
});

onCanvasRestored(canvas, () => { if (!paused) { renderer.rebuild(); draw(); } });
new ResizeObserver(() => layout()).observe(desk);
sync();
layout();
exposeScenes(canvas, out, () => { paused = true; view = IDENTITY; canvas.style.transform = ""; }, {
  view: () => view,
  setView: (v: View) => setView(v, true),
  frame,
  strokes: () => (derive(page).layers.L2 ?? []).length,
  lastStroke: () => lastCommitted?.points ?? null,
  fingerMode: () => input.fingerMode,
});
