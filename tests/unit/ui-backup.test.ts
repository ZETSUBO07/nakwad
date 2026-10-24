import { describe, expect, it } from "vitest";
import { BACKUP_REMIND_DAYS, backupDue } from "../../src/ui/backup";
import { parsePrefs } from "../../src/ui/prefs";

const DAY = 86_400_000;
const now = 100 * DAY;
const work = (created: number, updated = created) => ({ created, updated });

describe("backup reminder", () => {
  it("the spec's wait is 14 days", () => { expect(BACKUP_REMIND_DAYS).toBe(14); });

  it("nothing to remind about without works", () => {
    expect(backupDue([], null, now)).toBe(false);
  });

  it("never backed up: remind once the oldest work is over 14 days old", () => {
    expect(backupDue([work(now - 13 * DAY)], null, now)).toBe(false);
    expect(backupDue([work(now - 13 * DAY), work(now - 15 * DAY)], null, now)).toBe(true);
  });

  it("backed up: remind after 14 days, only when something changed since", () => {
    const last = now - 20 * DAY;
    expect(backupDue([work(now - 30 * DAY, last - DAY)], last, now)).toBe(false); // nothing new
    expect(backupDue([work(now - 30 * DAY, last + DAY)], last, now)).toBe(true);
    expect(backupDue([work(now - 30 * DAY, now - DAY)], now - 10 * DAY, now)).toBe(false); // backed up recently
  });

  it("the date of the last backup is kept in the settings, and bad values are dropped", () => {
    expect(parsePrefs(JSON.stringify({ lastBackup: 123 })).lastBackup).toBe(123);
    for (const v of [-5, 0, "x", null, Number.POSITIVE_INFINITY]) expect(parsePrefs(JSON.stringify({ lastBackup: v })).lastBackup).toBe(null);
  });
});
