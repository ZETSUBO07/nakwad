import { MAX_AREA, MAX_SIDE, MIN_SIDE, isHexColor, isPaperColor } from "./paper";
import { BRUSHES, SCHEMA_VERSION, type WorkDoc } from "./types";

/**
 * Checks a work read from storage or from a backup file before the app uses it.
 * Nothing read from outside is trusted: shapes, types, number ranges and sizes are all checked,
 * with hard limits so a damaged or hostile file cannot exhaust memory.
 * Messages are for logs and tests, not shown to the user as they are.
 */
export const LIMITS = {
  pages: 500,
  layersPerPage: 1000,
  entriesPerLayer: 200_000,
  actions: 10_000,
  pointsPerStroke: 500_000,
  maskPoints: 200_000,
  lineSetPaths: 200_000,
  lineSetNumbers: 5_000_000,
  groupDepth: 64,
  textLength: 20_000,
  nameLength: 200,
  fontName: 120,
  coordinate: 1e6,
} as const;

export type ValidationResult = { ok: true; doc: WorkDoc } | { ok: false; errors: string[] };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCoord = (v: unknown): boolean => isNum(v) && Math.abs(v) <= LIMITS.coordinate;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isUnit = (v: unknown): boolean => isNum(v) && v >= 0 && v <= 1;
const isPositive = (v: unknown): boolean => isNum(v) && v > 0 && v <= LIMITS.coordinate;

class Checker {
  errors: string[] = [];
  /** stops collecting after this many, so a broken file reports quickly */
  private readonly max = 50;
  fail(path: string, what: string): false {
    if (this.errors.length < this.max) this.errors.push(`${path}: ${what}`);
    return false;
  }
  full(): boolean { return this.errors.length >= this.max; }
}

function mat(c: Checker, v: unknown, path: string): boolean {
  if (!Array.isArray(v) || (v.length !== 3 && v.length !== 4) || !v.every(isCoord)) return c.fail(path, "expected [scale, dx, dy] or [scale, dx, dy, turn]");
  if (!((v[0] as number) > 0)) return c.fail(path, "scale must be positive");
  if (v.length === 4 && Math.abs(v[3] as number) > Math.PI * 2) return c.fail(path, "turn out of range");
  return true;
}

function mask(c: Checker, v: unknown, path: string): boolean {
  if (!isObj(v) || typeof v.inv !== "boolean" || !Array.isArray(v.pts)) return c.fail(path, "expected {pts, inv}");
  if (v.pts.length < 3 || v.pts.length > LIMITS.maskPoints) return c.fail(path, "mask needs 3 or more points within the limit");
  for (const p of v.pts) if (!Array.isArray(p) || p.length !== 2 || !isCoord(p[0]) || !isCoord(p[1])) return c.fail(path, "bad mask point");
  return true;
}

function text(c: Checker, v: unknown, path: string): boolean {
  if (!isObj(v)) return c.fail(path, "expected text");
  if (!isId(v.tid)) return c.fail(path + ".tid", "bad id");
  if (!isCoord(v.x) || !isCoord(v.y)) return c.fail(path, "bad position");
  if (typeof v.text !== "string" || v.text.length > LIMITS.textLength) return c.fail(path + ".text", "missing or too long");
  if (typeof v.font !== "string" || !v.font || v.font.length > LIMITS.fontName) return c.fail(path + ".font", "bad font name");
  if (!isPositive(v.size)) return c.fail(path + ".size", "bad size");
  if (!isHexColor(v.color)) return c.fail(path + ".color", "bad colour");
  if (v.align !== "left" && v.align !== "center" && v.align !== "right") return c.fail(path + ".align", "bad alignment");
  if (!isNum(v.rot) || Math.abs(v.rot) > 360) return c.fail(path + ".rot", "bad rotation");
  if ((v.w !== undefined && (!isNum(v.w) || v.w < 0 || v.w > LIMITS.coordinate)) || (v.h !== undefined && (!isNum(v.h) || v.h < 0 || v.h > LIMITS.coordinate))) return c.fail(path, "bad box size");
  return true;
}

function entry(c: Checker, v: unknown, path: string, depth: number): boolean {
  if (c.full()) return false;
  if (depth > LIMITS.groupDepth) return c.fail(path, "nested too deeply");
  if (!isObj(v) || typeof v.kind !== "string") return c.fail(path, "expected an entry");
  switch (v.kind) {
    case "stroke": {
      if (!(BRUSHES as readonly string[]).includes(v.brush as string)) return c.fail(path + ".brush", "unknown brush");
      if (!isHexColor(v.color)) return c.fail(path + ".color", "bad colour");
      if (!isPositive(v.size) || !isUnit(v.opacity) || typeof v.pressure !== "boolean" || !isNum(v.seed)) return c.fail(path, "bad stroke settings");
      if (v.vs !== undefined && !isPositive(v.vs)) return c.fail(path + ".vs", "bad view scale");
      if (!Array.isArray(v.points) || v.points.length < 1 || v.points.length > LIMITS.pointsPerStroke) return c.fail(path + ".points", "missing or too many points");
      for (const p of v.points) if (!Array.isArray(p) || p.length !== 4 || !isCoord(p[0]) || !isCoord(p[1]) || !isUnit(p[2]) || !isNum(p[3])) return c.fail(path + ".points", "bad point");
      return v.mask === undefined || mask(c, v.mask, path + ".mask");
    }
    case "image":
      if (!isId(v.img) || !isCoord(v.x) || !isCoord(v.y) || !isPositive(v.w) || !isPositive(v.h) || !isUnit(v.opacity)) return c.fail(path, "bad picture");
      return true;
    case "replace":
      if (!isId(v.img) || !isPositive(v.w) || !isPositive(v.h)) return c.fail(path, "bad replaced pixels");
      return true;
    case "selerase":
      return mask(c, v.mask, path + ".mask");
    case "selmove":
      if (!isCoord(v.dx) || !isCoord(v.dy)) return c.fail(path, "bad offset");
      return mask(c, v.mask, path + ".mask");
    case "lineset": {
      if (!isHexColor(v.color) || !isUnit(v.opacity) || !Array.isArray(v.paths) || v.paths.length > LIMITS.lineSetPaths) return c.fail(path, "bad line set");
      let total = 0;
      for (const lp of v.paths) {
        if (!isObj(lp) || typeof lp.v !== "boolean" || !isUnit(lp.a) || !Array.isArray(lp.pts)) return c.fail(path, "bad line");
        total += lp.pts.length;
        if (total > LIMITS.lineSetNumbers) return c.fail(path, "too many line points");
        if (!lp.pts.every(isCoord)) return c.fail(path, "bad line point");
        if (!lp.v && !isPositive(lp.w)) return c.fail(path, "line without width");
      }
      return true;
    }
    case "group": {
      if (!Array.isArray(v.items) || v.items.length > LIMITS.entriesPerLayer || !isUnit(v.opacity)) return c.fail(path, "bad group");
      if (v.m !== undefined && !mat(c, v.m, path + ".m")) return false;
      if (v.src !== undefined && (!Array.isArray(v.src) || v.src.length !== 2 || !v.src.every(isPositive))) return c.fail(path + ".src", "bad size");
      return v.items.every((x, i) => entry(c, x, `${path}.items[${i}]`, depth + 1));
    }
    case "bg":
      if (!isHexColor(v.color) || !Array.isArray(v.holes) || v.holes.length > LIMITS.entriesPerLayer) return c.fail(path, "bad layer colour");
      return v.holes.every((x, i) => entry(c, x, `${path}.holes[${i}]`, depth + 1));
    case "text":
      return text(c, v, path);
    default:
      return c.fail(path + ".kind", "unknown entry kind");
  }
}

const DRAW_KINDS = new Set(["stroke", "image", "replace", "selerase", "selmove", "lineset"]);

function action(c: Checker, v: unknown, path: string): boolean {
  if (!isObj(v)) return c.fail(path, "expected an action");
  switch (v.type) {
    case "add":
      if (!isId(v.id) || !Number.isInteger(v.index) || (v.index as number) < 0) return c.fail(path, "bad add");
      if (v.copyOf !== undefined && !isId(v.copyOf)) return c.fail(path + ".copyOf", "bad id");
      if (v.image !== undefined && !(isObj(v.image) && v.image.kind === "image" && entry(c, v.image, path + ".image", 0))) return c.fail(path + ".image", "bad picture");
      if (v.text !== undefined && !text(c, v.text, path + ".text")) return false;
      if (v.color !== undefined && !isHexColor(v.color)) return c.fail(path + ".color", "bad colour");
      return true;
    case "del":
      return isId(v.id) || c.fail(path, "bad delete");
    case "move":
      return (isId(v.id) && Number.isInteger(v.to) && (v.to as number) >= 0) || c.fail(path, "bad move");
    case "merge":
      return (isId(v.id) && isId(v.into) && isUnit(v.alpha)) || c.fail(path, "bad merge");
    case "multi": {
      const steps = v.steps;
      if (!Array.isArray(steps) || !steps.length || steps.length > LIMITS.layersPerPage) return c.fail(path, "bad bulk change");
      return steps.every((x, i) => (isObj(x) && (x.type === "del" || x.type === "merge") ? action(c, x, `${path}.steps[${i}]`) : c.fail(`${path}.steps[${i}]`, "bad bulk step")));
    }
    case "draw":
      if (!isId(v.layer) || !isObj(v.entry) || !DRAW_KINDS.has(v.entry.kind as string)) return c.fail(path, "bad draw");
      return entry(c, v.entry, path + ".entry", 0);
    case "clear":
      return isId(v.layer) || c.fail(path, "bad clear");
    case "xform":
      return isId(v.layer) ? mat(c, v.m, path + ".m") : c.fail(path, "bad move layer");
    case "resize":
      if (!Number.isInteger(v.w) || !Number.isInteger(v.h) || !sizeOk(v.w as number, v.h as number)) return c.fail(path, "bad paper size");
      return mat(c, v.m, path + ".m");
    case "bg":
      return (isId(v.layer) && (v.color === null || isHexColor(v.color))) || c.fail(path, "bad layer colour");
    case "textset":
      if (!isId(v.layer) || !isId(v.tid)) return c.fail(path, "bad text change");
      return v.text === null || text(c, v.text, path + ".text");
    case "textflat":
      return (isId(v.layer) && isId(v.tid) && isId(v.img) && isPositive(v.w) && isPositive(v.h)) || c.fail(path, "bad text to picture");
    default:
      return c.fail(path + ".type", "unknown action");
  }
}

const sizeOk = (w: number, h: number) => w >= MIN_SIDE && h >= MIN_SIDE && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_AREA;

function page(c: Checker, v: unknown, path: string): boolean {
  if (!isObj(v) || !isId(v.id) || !isObj(v.base) || !Array.isArray(v.actions) || !Array.isArray(v.redo) || !isId(v.active)) return c.fail(path, "bad page");
  const b = v.base;
  if (!Number.isInteger(b.w) || !Number.isInteger(b.h) || !sizeOk(b.w as number, b.h as number)) return c.fail(path + ".base", "bad paper size");
  if (!Array.isArray(b.order) || b.order.length > LIMITS.layersPerPage || !b.order.every(isId)) return c.fail(path + ".base.order", "bad layer list");
  if (new Set(b.order).size !== b.order.length) return c.fail(path + ".base.order", "repeated layer");
  if (!isObj(b.layers)) return c.fail(path + ".base.layers", "missing");
  for (const id of b.order as string[]) {
    const L = b.layers[id];
    if (!Array.isArray(L) || L.length > LIMITS.entriesPerLayer) return c.fail(`${path}.base.layers.${id}`, "missing or too long");
    if (!L.every((e, i) => entry(c, e, `${path}.base.layers.${id}[${i}]`, 0))) return false;
    const bgAt = L.findIndex((e) => isObj(e) && e.kind === "bg");
    if (bgAt > 0) return c.fail(`${path}.base.layers.${id}`, "layer colour must come first");
  }
  if (v.actions.length + v.redo.length > LIMITS.actions) return c.fail(path, "too many history steps");
  return v.actions.every((a, i) => action(c, a, `${path}.actions[${i}]`)) && v.redo.every((a, i) => action(c, a, `${path}.redo[${i}]`));
}

export function validateDoc(v: unknown): ValidationResult {
  const c = new Checker();
  const done = (): ValidationResult => (c.errors.length ? { ok: false, errors: c.errors } : { ok: true, doc: v as WorkDoc });
  if (!isObj(v)) { c.fail("doc", "expected an object"); return done(); }
  if (v.schema !== SCHEMA_VERSION) { c.fail("doc.schema", `expected ${SCHEMA_VERSION}, got ${String(v.schema)}`); return done(); }
  if (!isPaperColor(v.paper)) c.fail("doc.paper", "bad paper colour");
  if (!Array.isArray(v.pages) || v.pages.length < 1 || v.pages.length > LIMITS.pages) { c.fail("doc.pages", "need 1 or more pages within the limit"); return done(); }
  if (!Number.isInteger(v.current) || (v.current as number) < 0 || (v.current as number) >= v.pages.length) c.fail("doc.current", "out of range");
  if (!isObj(v.next) || !["layer", "image", "page"].every((k) => Number.isInteger((v.next as Record<string, unknown>)[k]) && ((v.next as Record<string, number>)[k] ?? -1) >= 0)) c.fail("doc.next", "bad id counters");
  if (!isObj(v.layers)) c.fail("doc.layers", "missing");
  else for (const [id, p] of Object.entries(v.layers)) {
    if (!isId(id) || !isObj(p) || typeof p.name !== "string" || p.name.length > LIMITS.nameLength || typeof p.visible !== "boolean" || !isUnit(p.opacity) || (p.locked !== undefined && typeof p.locked !== "boolean")) c.fail(`doc.layers.${id}`, "bad layer settings");
  }
  v.pages.forEach((p, i) => { if (!c.full()) page(c, p, `doc.pages[${i}]`); });
  if (!c.errors.length) {
    // every layer a page uses must have settings
    const layers = v.layers as Record<string, unknown>;
    for (const [i, p] of (v.pages as WorkDoc["pages"]).entries()) {
      for (const id of p.base.order) if (!layers[id]) c.fail(`doc.pages[${i}]`, `layer ${id} has no settings`);
      for (const a of [...p.actions, ...p.redo]) if (a.type === "add" && !layers[a.id]) c.fail(`doc.pages[${i}]`, `layer ${a.id} has no settings`);
    }
  }
  return done();
}
