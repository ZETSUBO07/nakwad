import { isFontData, cleanName, type Store } from "../storage";

/**
 * Fonts for the text tool (spec: 12 fonts + imported ones).
 * The 4 menu fonts come with the app; the other 8 are separate files from our own site, fetched
 * the first time the text tool needs them and then kept by the browser (and, from M7, offline).
 */
export const TEXT_FONTS = ["Anuphan", "Noto Sans Thai", "Sarabun", "Kanit", "Prompt", "Mitr", "Mali", "Itim", "Sriracha", "Charm", "Chonburi", "Pattaya"] as const;
export const DEFAULT_TEXT_FONT = "Anuphan";
export const MAX_FONT_BYTES = 30 * 1024 * 1024;

const LAZY: Record<string, () => Promise<unknown>> = {
  Sarabun: () => Promise.all([import("@fontsource/sarabun/thai-400.css"), import("@fontsource/sarabun/latin-400.css")]),
  Kanit: () => Promise.all([import("@fontsource/kanit/thai-400.css"), import("@fontsource/kanit/latin-400.css")]),
  Prompt: () => Promise.all([import("@fontsource/prompt/thai-400.css"), import("@fontsource/prompt/latin-400.css")]),
  Mitr: () => Promise.all([import("@fontsource/mitr/thai-400.css"), import("@fontsource/mitr/latin-400.css")]),
  Itim: () => Promise.all([import("@fontsource/itim/thai-400.css"), import("@fontsource/itim/latin-400.css")]),
  Charm: () => Promise.all([import("@fontsource/charm/thai-400.css"), import("@fontsource/charm/latin-400.css")]),
  Chonburi: () => Promise.all([import("@fontsource/chonburi/thai-400.css"), import("@fontsource/chonburi/latin-400.css")]),
  Pattaya: () => Promise.all([import("@fontsource/pattaya/thai-400.css"), import("@fontsource/pattaya/latin-400.css")]),
};

// two Thai letters and two Latin ones, so both parts of each font are fetched
const SAMPLE = String.fromCharCode(0x0e01, 0x0e02) + "Aa";
const ready = new Map<string, Promise<boolean>>();

/** Make a font usable for drawing. Resolves false when it cannot be had (the text then shows in Anuphan). */
export function ensureFont(name: string): Promise<boolean> {
  let p = ready.get(name);
  if (!p) {
    p = (async () => {
      try {
        await LAZY[name]?.();
        const faces = await document.fonts.load(`48px "${name}"`, SAMPLE);
        if (!faces.length) ready.delete(name); // maybe an imported font not read yet: try again later
        return faces.length > 0;
      } catch (err) {
        console.error(err);
        ready.delete(name);
        return false;
      }
    })();
    ready.set(name, p);
  }
  return p;
}

/** Make every font in a set of names usable. */
export async function ensureFonts(names: Iterable<string>): Promise<void> {
  await Promise.all([...names].map(ensureFont));
}

const imported = new Set<string>();
export const importedFonts = (): string[] => [...imported].sort((a, b) => a.localeCompare(b));

async function addFace(name: string, data: ArrayBuffer): Promise<void> {
  const face = new FontFace(name, data);
  await face.load();
  document.fonts.add(face);
  imported.add(name);
  ready.set(name, Promise.resolve(true));
}

let loadedFromStore: Promise<void> | null = null;
/** Fonts the user imported earlier, read once per app start. Broken files are skipped, never deleted. */
export function loadImportedFonts(store: Store): Promise<void> {
  loadedFromStore ??= (async () => {
    for (const f of await store.listFonts().catch(() => [])) {
      try { await addFace(f.name, await f.data.arrayBuffer()); } catch (err) { console.error(err); }
    }
  })();
  return loadedFromStore;
}

export type ImportFontResult = { ok: true; name: string } | { ok: false; reason: "tooBig" | "notFont" | "exists" | "failed" };

/**
 * Import a font file: at most 30 MB, must look like TTF/OTF/WOFF/WOFF2 and load in the browser
 * (FontFace.load) before it is stored. A name already in use gets a suffix; an existing font is never replaced.
 */
export async function importFont(store: Store, file: File, suffix: string): Promise<ImportFontResult> {
  if (file.size > MAX_FONT_BYTES) return { ok: false, reason: "tooBig" };
  const data = await file.arrayBuffer();
  if (!isFontData(new Uint8Array(data.slice(0, 4)))) return { ok: false, reason: "notFont" };
  // quotes and backslashes would break the CSS font string; keep the name plain
  let name = cleanName(file.name.replace(/\.[^.]+$/, "").replace(/["\\]/g, ""), "Font").slice(0, 60);
  if ((TEXT_FONTS as readonly string[]).includes(name)) name = `${name} ${suffix}`;
  if (imported.has(name)) return { ok: false, reason: "exists" };
  try {
    await addFace(name, data.slice(0));
  } catch (err) {
    console.error(err);
    return { ok: false, reason: "notFont" };
  }
  try {
    if (!(await store.putFont(name, new Blob([data]), Date.now()))) return { ok: false, reason: "exists" };
  } catch (err) {
    console.error(err);
    return { ok: false, reason: "failed" };
  }
  return { ok: true, name };
}
