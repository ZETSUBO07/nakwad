import { newPage, type DrawEntry, type Page, type StrokeEntry, type TextData } from "../../../src/core";

export const page = (w = 2400, h = 1600): Page => newPage("P1", w, h, "L1");

export const stroke = (brush: StrokeEntry["brush"] = "pen", extra: Partial<StrokeEntry> = {}): StrokeEntry => ({
  kind: "stroke", brush, color: "#1d2230", size: 4, opacity: 1, pressure: false, seed: 1,
  points: [[10, 10, 0.5, 0], [20, 20, 0.5, 8]], ...extra,
});

export const draw = (layer: string, entry: DrawEntry = stroke()) => ({ type: "draw", layer, entry } as const);

export const textData = (extra: Partial<TextData> = {}): TextData => ({
  tid: "T1", x: 100, y: 200, text: "hello", font: "Anuphan", size: 72, color: "#e4472b", align: "left", rot: 0, ...extra,
});
