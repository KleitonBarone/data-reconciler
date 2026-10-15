import type { NormalizationPolicy } from "../core/policy.js";

/** Example rules for the bundled commerce schemas, never a core default. */
export const commercePolicy: NormalizationPolicy = {
  version: "commerce.v1",
  text: { trim: true, unicode: true },
  identities: {
    order: { trim: true, unicode: true, case: "upper" },
    email: { trim: true, unicode: true, case: "lower" },
  },
  fields: {
    "/customerEmail": { trim: true, unicode: true, case: "lower" },
    "/status": { trim: true, unicode: true, case: "lower" },
    "/currency": { trim: true, unicode: true, case: "upper" },
  },
};
