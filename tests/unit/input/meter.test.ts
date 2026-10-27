import { describe, expect, it } from "vitest";
import { METER_KEEP, StrokeMeter, median, rate, worstGap } from "../../../src/input";

describe("stroke meter (diagnostics)", () => {
  it("small helpers", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(rate([0, 5])).toBeNull(); // too few
    expect(rate([0, 10, 20])).toBeNull(); // too short
    expect(rate([0, 50, 100])).toBe(20);
    expect(worstGap([])).toBeNull();
    expect(worstGap([0, 7, 30, 37])).toBe(23);
  });

  it("a pen at 240 points a second on a 144 Hz screen", () => {
    const m = new StrokeMeter();
    expect(m.active).toBe(false);
    m.start("pen", 1000);
    expect(m.active).toBe(true);
    // points arrive in batches (coalesced), one time stamp may repeat
    for (let i = 1; i <= 120; i += 4) m.points([1000 + i * (1000 / 240), 1000 + (i + 1) * (1000 / 240), 1000 + (i + 2) * (1000 / 240), 1000 + (i + 3) * (1000 / 240), 1000 + (i + 3) * (1000 / 240)]);
    for (let f = 0; f <= 72; f++) m.frame(1000 + f * (1000 / 144) + (f === 40 ? 0 : 0));
    const s = m.end()!;
    expect(s.kind).toBe("pen");
    expect(s.samples).toBe(121);
    expect(s.ms).toBeCloseTo(500, 0);
    expect(s.rateHz).toBeCloseTo(240, 0);
    expect(s.fps).toBeCloseTo(144, 0);
    expect(s.worstFrameMs).toBeCloseTo(1000 / 144, 1);
    expect(m.active).toBe(false);
  });

  it("points before the stroke, a cancelled stroke and an empty end count for nothing", () => {
    const m = new StrokeMeter();
    m.points([1, 2, 3]);
    m.frame(1);
    expect(m.end()).toBeNull();
    m.start("touch", 0);
    m.points([10]);
    m.cancel();
    expect(m.end()).toBeNull();
    expect(m.recent).toEqual([]);
  });

  it("the summary takes the middle of recent strokes, per kind, and the worst frame of all", () => {
    const m = new StrokeMeter();
    const stroke = (kind: "pen" | "touch", hz: number, gap: number) => {
      m.start(kind, 0);
      m.points(Array.from({ length: 50 }, (_, i) => ((i + 1) * 1000) / hz));
      [0, 8, 16, 16 + gap].forEach((t) => m.frame(t));
      m.end();
    };
    stroke("pen", 200, 8);
    stroke("pen", 240, 30);
    stroke("pen", 260, 8);
    stroke("touch", 120, 8);
    const pen = m.summary("pen");
    expect(pen.strokes).toBe(3);
    expect(pen.rateHz).toBeCloseTo(240, 0);
    expect(pen.worstFrameMs).toBe(30);
    expect(m.summary("touch").rateHz).toBeCloseTo(120, 0);
    expect(m.summary("mouse")).toEqual({ strokes: 0, rateHz: null, fps: null, worstFrameMs: null });
    for (let i = 0; i < METER_KEEP + 5; i++) stroke("touch", 100, 8);
    expect(m.recent.length).toBe(METER_KEEP);
    expect(m.summary("pen").strokes).toBe(0);
  });
});
