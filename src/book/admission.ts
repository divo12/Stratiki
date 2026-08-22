import { z } from "zod";

/**
 * Admission policy for the episode store: fail-closed filtering applied to
 * connector output before it becomes an immutable episode. Rejected content
 * never reaches storage; only an audit record of the rejection does.
 */

export const ADMISSION_MAX_BYTES = 10 * 1024 * 1024;

/** Token shapes that must never be persisted inside an admitted episode. */
const SECRET_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { label: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/u },
];

export const admissionRejectionSchema = z.object({
  reason: z.string(),
});
export type AdmissionRejection = z.infer<typeof admissionRejectionSchema>;

export interface AdmissionInput {
  readonly bytes: number;
  readonly content: string;
}

export type AdmissionDecision =
  | { readonly outcome: "admit" }
  | { readonly outcome: "reject"; readonly rejection: AdmissionRejection };

/**
 * Applies the fail-closed admission policy. Oversized payloads, non-JSON
 * content, and payloads containing credential-shaped strings are rejected
 * with a labeled reason; everything else is admitted.
 */
export function admitOrReject(input: AdmissionInput): AdmissionDecision {
  if (input.bytes > ADMISSION_MAX_BYTES) {
    return {
      outcome: "reject",
      rejection: {
        reason: `payload exceeds ${ADMISSION_MAX_BYTES} byte limit (${input.bytes} bytes)`,
      },
    };
  }

  try {
    JSON.parse(input.content);
  } catch {
    return {
      outcome: "reject",
      rejection: { reason: "payload is not valid JSON" },
    };
  }

  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(input.content)) {
      return {
        outcome: "reject",
        rejection: {
          reason: `payload contains a credential-shaped string (${secret.label})`,
        },
      };
    }
  }

  return { outcome: "admit" };
}
