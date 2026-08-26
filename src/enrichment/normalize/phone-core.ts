export type PhoneCoreResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const ALLOWED_FORMATTING = /[\s().\-–—/]/gu;
const EXTENSION_SPLIT = /(?:ext(?:ension)?\.?|[x#*,;])/iu;
const DIGITS_ONLY = /^[0-9]+$/u;

/**
 * Normalizes one raw phone string into either E.164 form (when a leading plus
 * declares a country code) or a bare digit string, dropping any extension.
 *
 * Formatting characters (spaces, dashes, parentheses, dots, slashes) are
 * discarded. Letters and non-ASCII digits are rejected rather than guessed.
 *
 * @param raw - Raw phone text from a source record.
 * @returns Normalized number, or a labeled failure reason.
 */
export function normalizePhoneCore(raw: string): PhoneCoreResult {
  const withoutExtension = raw.split(EXTENSION_SPLIT)[0] ?? "";
  const cleaned = withoutExtension.replace(ALLOWED_FORMATTING, "");
  const hasPlus = cleaned.startsWith("+");
  const digits = hasPlus ? cleaned.slice(1) : cleaned;

  if (!DIGITS_ONLY.test(digits)) {
    return {
      ok: false,
      reason: "phone contains letters or non-ascii digits",
    };
  }
  if (digits.length < 7 || digits.length > 15) {
    return {
      ok: false,
      reason: `phone has ${digits.length} significant digits (expected 7-15)`,
    };
  }

  return { ok: true, value: hasPlus ? `+${digits}` : digits };
}
