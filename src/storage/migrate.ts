import { SCHEMA_VERSION, validateDoc, type WorkDoc } from "../core";

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Steps that turn a work saved by an older app into the current format.
 * Key n upgrades schema n to n + 1. Schema 1 is the first; none are needed yet.
 * Every step must be pure: it gets a copy and returns the upgraded copy.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type MigrateResult =
  | { ok: true; doc: WorkDoc; migrated: boolean }
  | { ok: false; reason: "newer" | "invalid"; errors: string[] };

/**
 * Read a stored work safely. A work from a newer app, or one that fails validation, is reported
 * and never changed: the caller must not write over it.
 */
export function migrateDoc(raw: unknown, migrations: Readonly<Record<number, Migration>> = MIGRATIONS, target: number = SCHEMA_VERSION): MigrateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "invalid", errors: ["not an object"] };
  const start = (raw as Record<string, unknown>).schema;
  if (typeof start !== "number" || !Number.isInteger(start)) return { ok: false, reason: "invalid", errors: ["missing schema version"] };
  if (start > target) return { ok: false, reason: "newer", errors: [`schema ${start} is newer than ${target}`] };
  let doc = structuredClone(raw) as Record<string, unknown>;
  for (let v = start; v < target; v++) {
    const step = migrations[v];
    if (!step) return { ok: false, reason: "invalid", errors: [`no upgrade from schema ${v}`] };
    doc = { ...step(doc), schema: v + 1 };
  }
  const checked = validateDoc(doc);
  return checked.ok ? { ok: true, doc: checked.doc, migrated: start !== target } : { ok: false, reason: "invalid", errors: checked.errors };
}
