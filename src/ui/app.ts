import { newWork } from "../core";
import { pseudoMessages, setMessages, t } from "../i18n";
import { th } from "../i18n/th";
import { Store } from "../storage";
import { closeTopDialog, initBack, syncBack } from "./back";
import { askRestore, takeSharedFile } from "./backup";
import { openEditor, type Editor } from "./editor";
import { Gallery } from "./gallery";
import { noteOpen, startDiagnostics } from "./diagnostics";
import { button, h } from "./dom";
import { installErrorLog } from "./errorLog";
import { askNewWork } from "./newWork";
import { startOffline } from "./offline";
import { applyPrefsToPage, loadPrefs, savePrefs } from "./prefs";
import { toast } from "./toast";

/**
 * The app: starts at the gallery, opens works in the editor, and back.
 * On start, leftovers of earlier sessions are tidied (after any crash recovery data is kept safe,
 * see Store.cleanupOnStart).
 */
export async function startApp(root: HTMLElement): Promise<void> {
  // test hook: ?lang=pseudo shows every text about 40% longer, to catch text that would overflow
  if (new URLSearchParams(location.search).get("lang") === "pseudo") setMessages(pseudoMessages(th));
  document.title = t("appName");
  document.body.classList.add("app");
  installErrorLog(showCrash);
  startDiagnostics();

  let store: Store | null = null;
  try {
    store = await Store.open();
    await store.cleanupOnStart(Date.now());
  } catch (err) {
    console.error(err);
  }
  const prefs = loadPrefs();
  applyPrefsToPage(prefs);
  let busy = false;
  /** a work is open (or opening): never reload then */
  let inWork = false;
  let reloadWhenBack = false;
  /** the work that is open */
  let editor: Editor | null = null;

  const gallery = new Gallery(store, prefs, {
    open: (id) => void open(id),
    create: () => void create(),
  });

  async function showGallery(): Promise<void> {
    inWork = false;
    editor = null;
    syncBack();
    if (reloadWhenBack) { location.reload(); return; }
    root.replaceChildren(gallery.el);
    await gallery.show();
  }

  async function open(id: string): Promise<void> {
    if (!store || busy) return;
    busy = true;
    inWork = true;
    try {
      const t0 = performance.now();
      const r = await openEditor({ store, prefs, savePrefs: () => savePrefs(prefs) }, id, () => void showGallery());
      if (!r.ok) { inWork = false; toast(r.message, 6000); return; }
      root.replaceChildren(r.editor.el);
      noteOpen(performance.now() - t0);
      editor = r.editor;
      syncBack();
    } finally {
      busy = false;
    }
  }

  async function create(): Promise<void> {
    if (!store || busy) return;
    inWork = true; // the new-work window counts as busy too
    const choice = await askNewWork(prefs);
    if (!choice) { inWork = false; return; }
    busy = true;
    let id: string | null = null;
    try {
      const doc = newWork({ w: choice.w, h: choice.h, paper: choice.paper, layerName: t("layerDefaultName", { n: 1 }) });
      const count = (await store.listWorks()).length;
      id = (await store.createWork(doc, t("workDefaultName", { n: count + 1 }), Date.now())).id;
    } catch (err) {
      console.error(err);
      toast(t("actionFailed"));
    } finally {
      busy = false;
    }
    if (id) await open(id); else inWork = false;
  }

  // back: the top window, then the editor's menus and tools, then the work itself; in the gallery it leaves the app
  initBack({
    needed: () => !!editor || !!document.querySelector("dialog[open]"),
    back: () => {
      if (closeTopDialog()) return true;
      if (!editor) return false;
      if (!editor.back()) void editor.close();
      return true;
    },
  });
  await showGallery();
  // a backup file shared to the app from another app (Android share menu)
  const shared = await takeSharedFile(import.meta.env.BASE_URL).catch((err: unknown) => { console.error(err); return null; });
  if (shared && store && await askRestore(shared.name)) await gallery.restore(shared);
  // only the built app has a service worker (the dev server reloads by itself)
  if (import.meta.env.PROD) {
    void startOffline(navigator.serviceWorker, {
      base: import.meta.env.BASE_URL,
      idle: () => !inWork && !document.querySelector("dialog[open]"),
      reload: () => location.reload(),
      reloadLater: () => { reloadWhenBack = true; },
    });
  }
}

/** Something went wrong that nobody caught: say the saved work is safe and offer a reload. Shown once until closed. */
function showCrash(): void {
  if (document.querySelector(".crash")) return;
  const box = h("div", { class: "crash", attrs: { role: "alert" }, data: { testid: "crash" } },
    h("span", { text: t("crashText") }),
    button({ label: t("crashReload"), class: "primary", data: { action: "crash-reload" }, onClick: () => location.reload() }),
    button({ icon: "close", title: t("close"), class: "icon-btn ghost", data: { action: "crash-close" }, onClick: () => box.remove() }));
  document.body.append(box);
}
