import { th, type MessageKey } from "./th";

export type { MessageKey };
export type Messages = Record<MessageKey, string>;

let current: Messages = th;

/** The text for `key` in the current language, with {placeholders} filled from `params`. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = current[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Switch every later t() call to another language's messages. */
export function setMessages(messages: Messages): void {
  current = messages;
}

/** Keys present in `base` but missing (or empty) in `other`: used by tests to keep languages complete. */
export function missingKeys(base: Record<string, string>, other: Record<string, string>): string[] {
  return Object.keys(base).filter((k) => !other[k]);
}

/** Placeholders ({name}) used in `base` but absent from `other`, per key. */
export function placeholderMismatches(base: Record<string, string>, other: Record<string, string>): string[] {
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  return Object.keys(base).filter((k) => other[k] !== undefined && names(base[k] ?? "") !== names(other[k] ?? ""));
}

/**
 * A test-only language: every message about 40% longer, wrapped in markers, placeholders kept.
 * Running the UI with it shows text that would overflow or get cut once translated.
 */
export function pseudoMessages(base: Messages): Messages {
  const out = {} as Record<MessageKey, string>;
  for (const k of Object.keys(base) as MessageKey[]) {
    const s = base[k];
    const pad = "~".repeat(Math.ceil(s.length * 0.4));
    out[k] = `[${s}${pad}]`;
  }
  return out;
}
