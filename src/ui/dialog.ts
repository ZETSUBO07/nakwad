import { t } from "../i18n";
import { syncBack } from "./back";
import { button, h } from "./dom";

export interface DialogHandle {
  el: HTMLDialogElement;
  close(): void;
}

/**
 * A modal sheet built on <dialog>: focus stays inside, Esc closes, tapping outside closes.
 * `onClose` runs once however it was closed.
 */
export function openDialog(title: string, body: Node[], onClose: () => void, opts: { closeLabel?: string; id?: string } = {}): DialogHandle {
  const heading = h("h2", { text: title, attrs: { id: `dlg-${Math.random().toString(36).slice(2)}` } });
  const closeBtn = button({ label: opts.closeLabel ?? t("cancel"), class: "ghost", data: { action: "dialog-close" } });
  const sheet = h("div", { class: "sheet" }, h("div", { class: "sheet-head" }, heading, closeBtn), ...body);
  const el = h("dialog", { class: "dialog", attrs: { "aria-labelledby": heading.id } }, sheet);
  if (opts.id) el.id = opts.id;
  let done = false;
  const finish = () => { if (done) return; done = true; el.remove(); onClose(); syncBack(); };
  const close = () => { if (el.open) el.close(); finish(); };
  closeBtn.addEventListener("click", close);
  el.addEventListener("close", finish);
  // a press on the backdrop lands on the <dialog> itself, never on the sheet inside it
  el.addEventListener("pointerdown", (e) => { if (e.target === el) close(); });
  document.body.append(el);
  el.showModal();
  syncBack();
  return { el, close };
}
