import "fake-indexeddb/auto";
import { commit, newWork, type WorkDoc } from "../../../src/core";
import { Store } from "../../../src/storage";

let n = 0;
/** A fresh, empty database for each test. */
export const freshStore = () => Store.open(`test-${Date.now()}-${n++}`);

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const png = (extra = 0) => new Blob([PNG, new Uint8Array([extra])], { type: "image/png" });

/** A small valid work with one picture (I1) and some undo history. */
export function sampleDoc(): WorkDoc {
  const doc = newWork({ w: 1000, h: 800, layerName: "Layer 1" });
  let p = doc.pages[0]!;
  p = commit(p, { type: "draw", layer: "L1", entry: { kind: "image", img: "I1", x: 0, y: 0, w: 10, h: 10, opacity: 1 } });
  p = commit(p, { type: "draw", layer: "L1", entry: { kind: "stroke", brush: "pen", color: "#000000", size: 3, opacity: 1, pressure: false, seed: 1, points: [[1, 1, 0.5, 0], [5, 5, 0.5, 9]] } });
  doc.pages[0] = p;
  doc.next.image = 1;
  return doc;
}

export const bytes = async (b: Blob | undefined) => (b ? [...new Uint8Array(await b.arrayBuffer())] : null);
