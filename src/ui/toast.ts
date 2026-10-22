import { h } from "./dom";

let box: HTMLElement | null = null;
let timer = 0;

/** A short message at the bottom of the screen, read out by screen readers. */
export function toast(message: string, ms = 3200): void {
  if (!box) {
    box = h("div", { class: "toast", attrs: { role: "status", "aria-live": "polite" } });
    document.body.append(box);
  }
  box.textContent = message;
  box.hidden = false;
  clearTimeout(timer);
  timer = window.setTimeout(() => { if (box) box.hidden = true; }, ms);
}
