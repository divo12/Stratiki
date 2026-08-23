export type AddressResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

export interface AddressJson {
  readonly city: string;
  readonly country: string;
  readonly line1: string;
  readonly postal: string;
  readonly region: string;
}

interface MutableAddress {
  city: string;
  country: string;
  line1: string;
  postal: string;
  region: string;
}

const POSTAL_PATTERN =
  /^\d{4,10}(?:-\d{4})?$|^[A-Za-z]{1,2}\d[A-Za-z\d]?(?: ?\d[A-Za-z]{2})?$/u;

/**
 * Parses one raw address string into canonical parts serialized as JSON.
 *
 * Grammar (comma-separated, positional): `line1, city[, region[ postal]][,
 * country]`. A trailing alphabetic-only part beyond the first three segments
 * is the country; anything that does not fit fails rather than guessing.
 *
 * @param raw - Raw address text from a source record.
 * @returns Canonical `{line1, city, region, postal, country}` JSON string.
 */
export function normalizeAddress(raw: string): AddressResult {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    return { ok: false, reason: "address needs at least street and city" };
  }

  const address: MutableAddress = {
    line1: parts[0] ?? "",
    city: "",
    region: "",
    postal: "",
    country: "",
  };

  const remainder = parts.slice(1);
  if (remainder.length >= 3) {
    const candidate = remainder.at(-1) ?? "";
    if (/^[A-Za-z][A-Za-z .'-]*$/u.test(candidate)) {
      address.country = candidate;
      remainder.pop();
    }
  }

  if (remainder.length < 1) {
    return { ok: false, reason: "address has no city after country split" };
  }

  address.city = remainder[0] ?? "";
  if (remainder.length >= 2) {
    const regionPart = remainder.at(-1) ?? "";
    const tokens = regionPart.split(/\s+/u).filter(Boolean);
    const twoTokenPostal =
      tokens.length >= 3 ? tokens.slice(-2).join(" ") : undefined;
    const singlePostal = tokens.at(-1) ?? "";

    if (twoTokenPostal !== undefined && POSTAL_PATTERN.test(twoTokenPostal)) {
      address.postal = twoTokenPostal;
      address.region = tokens.slice(0, -2).join(" ");
    } else if (POSTAL_PATTERN.test(singlePostal)) {
      address.postal = singlePostal;
      address.region = tokens.slice(0, -1).join(" ");
    } else {
      address.region = regionPart;
    }
  }

  return { ok: true, value: JSON.stringify(address satisfies AddressJson) };
}
