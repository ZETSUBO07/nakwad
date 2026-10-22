import { afterEach, describe, expect, it } from "vitest";
import { missingKeys, placeholderMismatches, pseudoMessages, setMessages, t } from "../../src/i18n";
import { th } from "../../src/i18n/th";

afterEach(() => setMessages(th));

describe("t()", () => {
  it("returns the Thai text for a key", () => {
    expect(t("appName")).toBe(th.appName);
  });

  it("fills placeholders and leaves unknown ones as they are", () => {
    expect(t("versionLabel", { version: "1.2.3" })).toContain("1.2.3");
    expect(t("versionLabel")).toContain("{version}");
  });

  it("switches language with setMessages", () => {
    setMessages(pseudoMessages(th));
    expect(t("appName").startsWith("[")).toBe(true);
  });
});

describe("message files", () => {
  it("every Thai message is non-empty", () => {
    for (const [key, value] of Object.entries(th)) expect(value.trim(), key).not.toBe("");
  });

  it("missingKeys and placeholderMismatches catch an incomplete translation", () => {
    const partial = { appName: "x", versionLabel: "v" } as Record<string, string>;
    expect(missingKeys(th, partial)).toContain("appTagline");
    expect(placeholderMismatches(th, partial)).toEqual(["versionLabel"]);
  });

  it("the pseudo language keeps every key and placeholder and is at least 40% longer", () => {
    const pseudo = pseudoMessages(th);
    expect(missingKeys(th, pseudo)).toEqual([]);
    expect(placeholderMismatches(th, pseudo)).toEqual([]);
    for (const key of Object.keys(th) as (keyof typeof th)[]) expect(pseudo[key].length).toBeGreaterThanOrEqual(th[key].length * 1.4);
  });
});
