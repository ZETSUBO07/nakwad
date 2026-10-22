import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";

// Proves the storage test setup works before milestone M3 builds the real storage layer on it.
describe("IndexedDB test environment", () => {
  it("writes and reads back through idb on fake-indexeddb", async () => {
    const db = await openDB("env-check", 1, { upgrade: (d) => { d.createObjectStore("kv"); } });
    await db.put("kv", { hello: "world" }, "k");
    expect(await db.get("kv", "k")).toEqual({ hello: "world" });
    db.close();
  });
});
