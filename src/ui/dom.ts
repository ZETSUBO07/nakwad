/**
 * Small helpers to build the interface with DOM calls only: no HTML strings, so nothing from a
 * work (names, text) can ever be read as markup, and nothing needs inline styles (blocked by the CSP).
 */

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  data?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElProps = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) e.setAttribute(k, v);
  for (const [k, v] of Object.entries(props.data ?? {})) e.dataset[k] = v;
  for (const c of children) if (c) e.append(c);
  return e;
}

const SVG = "http://www.w3.org/2000/svg";

/** Line icons, 24×24, drawn with the current text colour. */
const ICONS = {
  plus: ["M12 5v14", "M5 12h14"],
  back: ["M15 18l-6-6 6-6"],
  gallery: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  rename: ["M4 20h4L19 9l-4-4L4 16z"],
  copy: ["M8 8h12v12H8z", "M16 8V4H4v12h4"],
  trash: ["M4 7h16", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  undo: ["M9 14L4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-3"],
  redo: ["M15 14l5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h3"],
  swap: ["M7 4v14", "M3 14l4 4 4-4", "M17 20V6", "M13 10l4-4 4 4"],
  settings: ["M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z", "M19 12l2-1-1-3-2 .2-1.3-1.5.2-2-3-1-1 2h-1.8l-1-2-3 1 .2 2L6 7.2 4 7 3 10l2 1v2l-2 1 1 3 2-.2 1.3 1.5-.2 2 3 1 1-2h1.8l1 2 3-1-.2-2 1.3-1.5 2 .2 1-3-2-1z"],
  clear: ["M4 20h16", "M7 16l9-9 3 3-9 9H7z", "M13 10l3 3"],
  caret: ["M8 10l4 4 4-4"],
  pen: ["M4 20l2-6L16 4l4 4L10 18z", "M14 6l4 4"],
  pencil: ["M4 20l1.5-5L15 5.5 18.5 9 9 18.5z", "M4 20l3.5-1.5", "M13 7.5l3.5 3.5"],
  ink: ["M5 19c4 0 6-2 7-5l5-9 2 1-4 10c-1 3-4 4-8 4z"],
  nib: ["M12 3l5 7-5 11-5-11z", "M12 10v4"],
  marker: ["M5 19l3-6 8-8 3 3-8 8z", "M5 19h6"],
  spray: ["M9 10h6v10H9z", "M10 10V7h4v3", "M17 4h.01", "M19 6h.01", "M17 8h.01", "M20 3h.01"],
  eraser: ["M8 20l-4-4L14 6l6 6-8 8z", "M4 20h16", "M9 11l6 6"],
  eraserall: ["M8 20l-4-4L14 6l6 6-8 8z", "M4 20h16", "M10 9l5 5", "M14 9l-5 5"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5", "M3 17l9 5 9-5"],
  eye: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z"],
  eyeOff: ["M3 3l18 18", "M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7", "M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1.1", "M9.9 9.9a3 3 0 0 0 4.2 4.2"],
  lock: ["M6 11h12v10H6z", "M8 11V8a4 4 0 0 1 8 0v3"],
  unlock: ["M6 11h12v10H6z", "M8 11V8a4 4 0 0 1 7.5-2"],
  handle: ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  top: ["M5 4h14", "M12 20V8", "M7 13l5-5 5 5"],
  up: ["M12 19V5", "M6 11l6-6 6 6"],
  down: ["M12 5v14", "M6 13l6 6 6-6"],
  bottom: ["M5 20h14", "M12 4v12", "M7 11l5 5 5-5"],
  merge: ["M8 4v6l4 4 4-4V4", "M12 14v6", "M5 20h14"],
  palette: ["M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5z", "M7.5 11h.01", "M10 7.5h.01", "M14.5 7.5h.01"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  move: ["M12 3v18", "M3 12h18", "M9 6l3-3 3 3", "M9 18l3 3 3-3", "M6 9l-3 3 3 3", "M18 9l3 3-3 3"],
  image: ["M4 5h16v14H4z", "M4 16l5-5 4 4 2-2 5 5", "M15 9h.01"],
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.classList.add("icon");
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}

export interface ButtonOpts {
  label?: string;
  icon?: IconName;
  /** accessible name and tooltip when the button shows only an icon */
  title?: string;
  class?: string;
  data?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
}

export function button(o: ButtonOpts): HTMLButtonElement {
  const b = h("button", { class: o.class ?? "", attrs: { type: "button" }, data: o.data ?? {} }, o.icon ? icon(o.icon) : null, o.label ? h("span", { text: o.label }) : null);
  if (o.title) { b.title = o.title; b.setAttribute("aria-label", o.title); }
  if (o.onClick) b.addEventListener("click", o.onClick);
  return b;
}

/** Thai date and time, e.g. "22 ต.ค. 2569 14:05". */
export function formatDate(ms: number): string {
  try { return new Date(ms).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return new Date(ms).toLocaleString(); }
}
