export interface TextNormalization {
  /** Lowercased, whitespace-collapsed key intended for matching columns. */
  readonly matchKey: string;

  /** Display form: NFC-folded and trimmed, original casing preserved. */
  readonly display: string;
}

/**
 * Folds one raw text value for matching while preserving a display form.
 *
 * Matching key applies NFC normalization, whitespace collapse, trim, and
 * lowercasing; display keeps the original casing so capitalization signals
 * survive for extraction consumers.
 *
 * @param raw - Raw text from a source record.
 * @returns Match key and display forms.
 */
export function normalizeText(raw: string): TextNormalization {
  const display = raw.normalize("NFC").replace(/\s+/gu, " ").trim();

  return { matchKey: display.toLowerCase(), display };
}
