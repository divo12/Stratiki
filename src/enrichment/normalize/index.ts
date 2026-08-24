import { normalizeAddress } from "./address.js";
import { normalizePhone } from "./phone.js";
import { normalizeText } from "./text.js";

/**
 * Kinds of normalization a view-mapping column can request.
 */
export type FieldKind = "address" | "phone-e164" | "text-casefold";

export type NormalizeResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const REGISTRY: Readonly<
  Record<FieldKind, (raw: string) => { ok: boolean; value?: string; reason?: string }>
> = {
  address: normalizeAddress,
  "phone-e164": normalizePhone,
  "text-casefold": (raw) => {
    const normalized = normalizeText(raw);

    return { ok: true, value: normalized.matchKey };
  },
};

/**
 * Applies the normalizer registered for one field kind.
 *
 * Dispatch is exhaustive over {@link FieldKind}; adding a kind without an
 * implementation is a compile error, so no dynamic lookup exists.
 *
 * @param kind - Declared normalization kind for the column.
 * @param raw - Raw cell text from the source record.
 * @returns Normalized string value, or a labeled failure reason.
 */
export function normalizeValue(kind: FieldKind, raw: string): NormalizeResult {
  const result = REGISTRY[kind](raw);

  return result.ok && result.value !== undefined
    ? { ok: true, value: result.value }
    : { ok: false, reason: result.reason ?? `${kind} normalization failed` };
}
