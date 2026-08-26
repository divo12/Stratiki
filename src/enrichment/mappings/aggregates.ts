import type { ViewMappingSet } from "../../book/view-mappings.js";

/**
 * View mappings for the Google Ads performance dataset.
 */
export const GOOGLE_ADS_MAPPINGS: ViewMappingSet = {
  columns: [
    { columnName: "campaign_id", jsonPath: "campaignId", normalizer: "" },
    { columnName: "clicks", jsonPath: "clicks", normalizer: "" },
    { columnName: "cost", jsonPath: "cost", normalizer: "" },
    { columnName: "day", jsonPath: "date", normalizer: "" },
    { columnName: "impressions", jsonPath: "impressions", normalizer: "" },
  ],
  datasetId: "google-ads/google-ads-performance",
  version: 1,
};

/**
 * View mappings for the Meta Ads insights dataset.
 */
export const META_ADS_MAPPINGS: ViewMappingSet = {
  columns: [
    { columnName: "campaign_id", jsonPath: "campaignId", normalizer: "" },
    { columnName: "impressions", jsonPath: "impressions", normalizer: "" },
    { columnName: "spend", jsonPath: "spend", normalizer: "" },
  ],
  datasetId: "meta-ads/meta-insights",
  version: 1,
};
