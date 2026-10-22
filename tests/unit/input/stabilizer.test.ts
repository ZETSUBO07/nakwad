import { describe, expect, it } from "vitest";
import { Stabilizer } from "../../../src/input";
import type { Point } from "../../../src/core";

describe("stabilizer", () => {
  it("strength 0 follows the pen exactly and adds nothing at the end", () => {
    const s = new Stabilizer(0);
    expect(s.active).toBe(false);
    s.start([0, 0, 0.5, 0]);
    expect(s.add([10, 5, 0.9, 16])).toEqual([10, 5, 0.9, 16]);
    expect(s.finish()).toEqual([]);
  });

  it("smooths a shaky line and catches up when the pen lifts", () => {
    const s = new Stabilizer(60);
    expect(s.active).toBe(true);
    s.start([0, 0, 0.5, 0]);
    const out: Point[] = [];
    for (let i = 1; i <= 20; i++) out.push(s.add([i * 10, i % 2 ? 6 : -6, 0.5, i * 16]));
    const wobble = Math.max(...out.slice(5).map((p) => Math.abs(p[1])));
    expect(wobble).toBeLessThan(6);
    const tail = s.finish(4);
    expect(tail).toHaveLength(4);
    expect(tail[3]![0]).toBeCloseTo(200);
    expect(tail[3]![1]).toBeCloseTo(-6);
    expect(tail[3]![3]).toBeGreaterThan(320);
    expect(s.finish()).toEqual([]);
  });

  it("clamps strength and starts on the first point if start was skipped", () => {
    const s = new Stabilizer(500);
    expect(s.add([3, 4, 0.2, 1])).toEqual([3, 4, 0.2, 1]);
    const p = s.add([103, 4, 0.2, 2]);
    expect(p[0]).toBeGreaterThan(3);
    expect(p[0]).toBeLessThan(20);
    expect(new Stabilizer(-5).active).toBe(false);
  });
});
