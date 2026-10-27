import { describe, expect, it } from "vitest";
import { ERROR_KEEP, addError, clearErrors, describeError, loadErrors, logError, parseErrors, type ErrorEntry } from "../../src/ui/errorLog";

class Mem {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

const e = (i: number, kind: ErrorEntry["kind"] = "crash"): ErrorEntry => ({ t: i, kind, msg: `boom ${i}` });

describe("error log (kept in this browser only)", () => {
  it("reads only good entries, whatever is stored", () => {
    for (const raw of [null, "", "{", "42", '{"a":1}']) expect(parseErrors(raw)).toEqual([]);
    expect(parseErrors(JSON.stringify([e(1), { t: "x", kind: "crash", msg: "" }, { t: 2, kind: "other", msg: "" }, null, { ...e(3), where: 5 }, { ...e(4, "logged"), where: "at x" }])))
      .toEqual([e(1), { ...e(4, "logged"), where: "at x" }]);
  });

  it("keeps the last 50 and shortens long text", () => {
    let list: ErrorEntry[] = [];
    for (let i = 0; i < ERROR_KEEP + 7; i++) list = addError(list, e(i));
    expect(list).toHaveLength(ERROR_KEEP);
    expect(list[0]!.t).toBe(7);
    const long = addError([], { t: 1, kind: "logged", msg: "m".repeat(2000), where: "w".repeat(5000) })[0]!;
    expect(long.msg.length).toBe(500);
    expect(long.where!.length).toBe(1200);
    expect(addError([], e(1))[0]).not.toHaveProperty("where");
  });

  it("describes errors, text and other things thrown", () => {
    const err = new TypeError("no paper");
    const d = describeError(err);
    expect(d.msg).toBe("TypeError: no paper");
    expect(d.where).toContain("no paper");
    const bare = new Error("x");
    bare.stack = "";
    expect(describeError(bare)).toEqual({ msg: "Error: x" });
    expect(describeError("plain")).toEqual({ msg: "plain" });
    expect(describeError({ code: 7 })).toEqual({ msg: '{"code":7}' });
    expect(describeError(undefined)).toEqual({ msg: "undefined" });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(describeError(loop).msg).toBe("[object Object]");
  });

  it("stores, adds and clears", () => {
    const s = new Mem();
    expect(loadErrors(s)).toEqual([]);
    logError(e(1), s);
    logError(e(2, "logged"), s);
    expect(loadErrors(s).map((x) => x.t)).toEqual([1, 2]);
    clearErrors(s);
    expect(loadErrors(s)).toEqual([]);
    // no storage, or storage that throws: nothing breaks
    expect(loadErrors(undefined)).toEqual([]);
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(loadErrors(bad)).toEqual([]);
    expect(() => logError(e(1), bad)).not.toThrow();
    expect(() => clearErrors(bad)).not.toThrow();
  });
});
