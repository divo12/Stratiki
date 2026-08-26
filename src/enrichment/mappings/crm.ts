import type { ViewMappingSet } from "../../book/view-mappings.js";

/**
 * View mappings for the Stripe events dataset. Event payloads are projected
 * raw; no field qualifies for normalization yet.
 */
export const STRIPE_EVENTS_MAPPINGS: ViewMappingSet = {
  columns: [
    { columnName: "created_at", jsonPath: "createdAt", normalizer: "" },
    {
      columnName: "customer_email",
      jsonPath: "customerEmail",
      normalizer: "text-casefold",
    },
    { columnName: "event_id", jsonPath: "id", normalizer: "" },
    { columnName: "event_type", jsonPath: "type", normalizer: "text-casefold" },
  ],
  datasetId: "stripe/stripe-events",
  version: 1,
};

/**
 * View mappings for the Zendesk tickets dataset.
 */
export const ZENDESK_TICKETS_MAPPINGS: ViewMappingSet = {
  columns: [
    {
      columnName: "requester_email",
      jsonPath: "requesterEmail",
      normalizer: "text-casefold",
    },
    { columnName: "status", jsonPath: "status", normalizer: "text-casefold" },
    { columnName: "ticket_id", jsonPath: "id", normalizer: "" },
    { columnName: "updated_at", jsonPath: "updatedAt", normalizer: "" },
  ],
  datasetId: "zendesk/zendesk-tickets",
  version: 1,
};

/**
 * View mappings for the Salesforce records dataset.
 */
export const SALESFORCE_RECORDS_MAPPINGS: ViewMappingSet = {
  columns: [
    {
      columnName: "contact_email",
      jsonPath: "Email",
      normalizer: "text-casefold",
    },
    {
      columnName: "last_modified",
      jsonPath: "LastModifiedDate",
      normalizer: "",
    },
    { columnName: "record_id", jsonPath: "Id", normalizer: "" },
  ],
  datasetId: "salesforce/salesforce-records",
  version: 1,
};

/**
 * View mappings for the HubSpot records dataset.
 */
export const HUBSPOT_RECORDS_MAPPINGS: ViewMappingSet = {
  columns: [
    {
      columnName: "contact_email",
      jsonPath: "properties.email",
      normalizer: "text-casefold",
    },
    { columnName: "record_id", jsonPath: "id", normalizer: "" },
  ],
  datasetId: "hubspot/hubspot-records",
  version: 1,
};
