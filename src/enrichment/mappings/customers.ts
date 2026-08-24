import { emitCreateView } from "../views/emitter.js";
import {
  HUBSPOT_RECORDS_MAPPINGS,
  SALESFORCE_RECORDS_MAPPINGS,
  STRIPE_EVENTS_MAPPINGS,
  ZENDESK_TICKETS_MAPPINGS,
} from "./crm.js";

/**
 * Emits the cross-dataset customer draft view: one row per distinct
 * normalized contact email, with the contributing sources aggregated.
 *
 * Matching is deterministic exact-key only (casefolded email); Phase 1 has
 * no fuzzy or probabilistic merging.
 *
 * @returns Deterministic CREATE VIEW SQL for `v_customers`.
 */
export function emitCustomersView(): string {
  const branches: readonly {
    column: string;
    source: CustomersSource;
    sql: string;
  }[] = [
    { source: "stripe", sql: emitCreateView(STRIPE_EVENTS_MAPPINGS), column: "customer_email" },
    {
      source: "zendesk",
      sql: emitCreateView(ZENDESK_TICKETS_MAPPINGS),
      column: "requester_email",
    },
    {
      source: "salesforce",
      sql: emitCreateView(SALESFORCE_RECORDS_MAPPINGS),
      column: "contact_email",
    },
    {
      source: "hubspot",
      sql: emitCreateView(HUBSPOT_RECORDS_MAPPINGS),
      column: "contact_email",
    },
  ];

  const union = branches
    .map(
      ({ column, source }) =>
        `SELECT ${column} AS match_key, '${source}' AS source FROM ${viewNameOf(source)}`,
    )
    .join(" UNION ALL ");

  return `CREATE VIEW IF NOT EXISTS v_customers AS SELECT match_key AS customer_email, group_concat(source, ',') AS sources FROM (${union}) WHERE match_key IS NOT NULL AND match_key <> '' GROUP BY match_key`;
}

type CustomersSource = "hubspot" | "salesforce" | "stripe" | "zendesk";

function viewNameOf(source: CustomersSource): string {
  switch (source) {
    case "stripe":
      return "v_stripe_stripe_events";
    case "zendesk":
      return "v_zendesk_zendesk_tickets";
    case "salesforce":
      return "v_salesforce_salesforce_records";
    case "hubspot":
      return "v_hubspot_hubspot_records";
  }
}
