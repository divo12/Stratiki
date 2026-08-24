import { normalizePhoneCore } from "./phone-core.js";

export type PhoneResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalizes one raw phone value for a view column, delegating to the core.
 *
 * @param raw - Raw phone text from a source record.
 * @returns Normalized E.164 or digit string, or a labeled failure.
 */
export function normalizePhone(raw: string): PhoneResult {
  return normalizePhoneCore(raw);
}
