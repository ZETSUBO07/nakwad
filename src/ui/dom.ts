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
