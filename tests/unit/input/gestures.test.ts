import { beforeEach, describe, expect, it } from "vitest";
import { GestureRecognizer, type GestureOptions, type Ptr } from "../../../src/input";

let log: string[];
const handlers = {
  strokeStart: (p: Ptr) => log.push(`start ${p.id}`),
  strokeMove: (p: Ptr) => log.push(`move ${p.id}`),
  strokeEnd: (p: Ptr) => log.push(`end ${p.id}`),
  strokeCancel: () => log.push("cancel"),
  pinchStart: () => log.push("pinchStart"),
  pinch: () => log.push("pinch"),
  pinchEnd: () => log.push("pinchEnd"),
  tap: (n: number) => log.push(`tap ${n}`),
  fit: () => log.push("fit"),
};
const make = (o: Partial<GestureOptions> = {}) => new GestureRecognizer(handlers, o);
const pen = (id: number, x: number, y: number, t: number): Ptr => ({ id, kind: "pen", x, y, t });
const finger = (id: number, x: number, y: number, t: number, size = 10): Ptr => ({ id, kind: "touch", x, y, t, width: size, height: size });
const uniq = () => [...new Set(log)];

beforeEach(() => { log = []; });

describe("pen and mouse", () => {
  it("draw", () => {
    const g = make();
    g.down(pen(1, 0, 0, 0));
    expect(g.isDrawing).toBe(true);
    g.move(pen(1, 5, 5, 10));
    g.up(pen(1, 5, 5, 20));
    g.down({ id: 2, kind: "mouse", x: 0, y: 0, t: 30 });
    g.up({ id: 2, kind: "mouse", x: 0, y: 0, t: 40 }, true);
    expect(log).toEqual(["start 1", "move 1", "end 1", "start 2", "cancel"]);
  });

  it("a new pen contact while the last lift never arrived ends that stroke and draws again", () => {
    const g = make();
    g.down(pen(1, 0, 0, 0));
    g.move(pen(1, 5, 0, 1));
    g.down(pen(2, 0, 0, 100));
    g.move(pen(2, 0, 9, 102));
    g.up(pen(2, 0, 9, 103));
    g.up(pen(1, 5, 0, 104)); // a late lift of the old contact changes nothing
    expect(log).toEqual(["start 1", "move 1", "end 1", "start 2", "move 2", "end 2"]);
    expect(g.drawingId).toBe(null);
  });

  it("the pen takes over from a finger (or resting palm) that was drawing", () => {
    const g = make({ fingerMode: "draw" });
    g.down(finger(5, 0, 0, 0));
    g.move(finger(5, 10, 0, 10));
    g.down(pen(1, 50, 50, 20));
    g.move(pen(1, 60, 50, 30));
    g.move(finger(5, 20, 0, 31));
    g.up(finger(5, 20, 0, 35));
    g.up(pen(1, 60, 50, 40));
    expect(log).toEqual(["start 5", "move 5", "cancel", "start 1", "move 1", "end 1"]);
  });
});

describe("fingers while the pen is busy (resting hand)", () => {
  it("touches during the stroke and just after it do nothing", () => {
    const g = make({ fingerMode: "draw" });
    g.down(pen(1, 0, 0, 0));
    g.down(finger(5, 0, 0, 10));
    g.move(finger(5, 50, 0, 20));
    g.up(finger(5, 50, 0, 30));
    g.up(pen(1, 0, 0, 100));
    g.down(finger(6, 0, 0, 200));
    g.up(finger(6, 0, 0, 210));
    expect(log).toEqual(["start 1", "end 1"]);
    g.down(finger(7, 0, 0, 500));
    expect(log).toContain("start 7");
  });

  it("the pen ends a finger gesture and its fingers are ignored afterwards", () => {
    const g = make();
    g.down(finger(5, 0, 0, 0));
    g.down(finger(6, 100, 0, 10));
    g.down(pen(1, 0, 0, 20));
    g.move(finger(5, 50, 50, 30));
    g.up(finger(5, 50, 50, 40));
    g.up(finger(6, 0, 0, 40));
    expect(log).toEqual(["pinchStart", "pinchEnd", "start 1"]);
  });

  it("a mouse leaves no resting hand: fingers work right after it", () => {
    const g = make();
    g.down({ id: 1, kind: "mouse", x: 0, y: 0, t: 0 });
    g.up({ id: 1, kind: "mouse", x: 0, y: 0, t: 10 });
    g.down(finger(5, 0, 0, 20));
    g.down(finger(6, 100, 0, 25));
    g.up(finger(5, 0, 0, 60));
    g.up(finger(6, 100, 0, 65));
    expect(log).toEqual(["start 1", "end 1", "pinchStart", "pinchEnd", "tap 2"]);
  });

  it("large contacts are palms", () => {
    const g = make({ fingerMode: "draw" });
    g.down(finger(5, 0, 0, 0, 80));
    g.move(finger(5, 10, 0, 10, 80));
    g.up(finger(5, 10, 0, 20, 80));
    g.down({ id: 6, kind: "touch", x: 0, y: 0, t: 30, height: 60 });
    expect(log).toEqual([]);
  });
});

describe("finger modes", () => {
  it("in pen mode one finger does nothing", () => {
    const g = make();
    g.down(finger(5, 0, 0, 0));
    g.move(finger(5, 100, 0, 50));
    g.up(finger(5, 100, 0, 400));
    expect(log).toEqual([]);
  });

  it("in draw mode one finger draws, and a second finger turns it into a pinch", () => {
    const g = make({ fingerMode: "draw" });
    g.down(finger(5, 0, 0, 0));
    g.move(finger(5, 30, 0, 50));
    g.down(finger(6, 200, 0, 60));
    g.move(finger(6, 300, 0, 70));
    g.up(finger(6, 300, 0, 400));
    g.up(finger(5, 30, 0, 410));
    expect(uniq()).toEqual(["start 5", "move 5", "cancel", "pinchStart", "pinch", "pinchEnd"]);
  });

  it("a single-finger stroke in draw mode ends normally and is not a tap", () => {
    const g = make({ fingerMode: "draw" });
    g.down(finger(5, 0, 0, 0));
    g.up(finger(5, 0, 0, 50));
    expect(log).toEqual(["start 5", "end 5"]);
  });
});

describe("two and three finger gestures", () => {
  it("two fingers pinch", () => {
    const g = make();
    g.down(finger(5, 0, 0, 0));
    g.down(finger(6, 100, 0, 5));
    g.move(finger(6, 300, 0, 200));
    g.up(finger(5, 0, 0, 600));
    g.move(finger(6, 400, 0, 610));
    g.up(finger(6, 400, 0, 620));
    expect(log).toEqual(["pinchStart", "pinch", "pinchEnd"]);
  });

  it("quick taps undo and redo", () => {
    const g = make();
    g.down(finger(5, 0, 0, 0));
    g.down(finger(6, 100, 0, 10));
    g.up(finger(5, 0, 0, 100));
    g.up(finger(6, 100, 0, 110));
    g.down(finger(7, 0, 0, 1000));
    g.down(finger(8, 100, 0, 1010));
    g.down(finger(9, 200, 0, 1020));
    g.move(finger(9, 205, 0, 1030));
    g.up(finger(7, 0, 0, 1100));
    g.up(finger(8, 100, 0, 1110));
    g.up(finger(9, 200, 0, 1120));
    expect(log.filter((l) => l.startsWith("tap"))).toEqual(["tap 2", "tap 3"]);
  });

  it("slow, moved or cancelled touches are not taps", () => {
    const g = make();
    const two = (t0: number, dx: number, end: number, cancel = false) => {
      g.down(finger(5, 0, 0, t0));
      g.down(finger(6, 100, 0, t0 + 5));
      if (dx) g.move(finger(6, 100 + dx, 0, t0 + 20));
      g.up(finger(5, 0, 0, t0 + end));
      g.up(finger(6, 100 + dx, 0, t0 + end + 5), cancel);
    };
    two(0, 0, 400);
    two(1000, 40, 100);
    two(2000, 0, 100, true);
    expect(log.filter((l) => l.startsWith("tap"))).toEqual([]);
  });

  it("a quick pinch-in fits the paper", () => {
    const g = make();
    g.down(finger(5, 0, 0, 0));
    g.down(finger(6, 400, 0, 5));
    g.move(finger(5, 150, 0, 100));
    g.move(finger(6, 250, 0, 110));
    g.up(finger(5, 150, 0, 150));
    g.up(finger(6, 250, 0, 160));
    expect(log.slice(-2)).toEqual(["pinchEnd", "fit"]);
    expect(log.filter((l) => l === "fit")).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("tap"))).toEqual([]);
  });

  it("reset forgets everything mid-gesture", () => {
    const g = make({ fingerMode: "draw" });
    g.down(finger(5, 0, 0, 0));
    g.reset();
    g.down(finger(6, 0, 0, 10));
    g.down(finger(7, 100, 0, 20));
    g.reset();
    g.up(finger(6, 0, 0, 30));
    expect(log).toEqual(["start 5", "cancel", "start 6", "cancel", "pinchStart", "pinchEnd"]);
  });
});
