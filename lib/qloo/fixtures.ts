import "server-only";
import search from "@/fixtures/detroit-gasworks/search.json";
import tagsSearch from "@/fixtures/detroit-gasworks/tags-search.json";
import insightsTags from "@/fixtures/detroit-gasworks/insights-tags.json";
import insightsArtists from "@/fixtures/detroit-gasworks/insights-artists.json";
import insightsBrands from "@/fixtures/detroit-gasworks/insights-brands.json";
import insightsPlaces from "@/fixtures/detroit-gasworks/insights-places.json";
import insightsHeatmap from "@/fixtures/detroit-gasworks/insights-heatmap.json";
import insightsDemographics from "@/fixtures/detroit-gasworks/insights-demographics.json";

// Fixture router: answers a Qloo request from the SAMPLE fixtures in /fixtures.
// Only the Detroit sample venue is covered. Anything else returns null, and the
// caller reports "no sample data" instead of inventing results.

const FIXTURE_CITY = "detroit";

function locationOk(params: Record<string, string>): boolean {
  const loc = params["signal.location.query"] ?? params["filter.location.query"];
  return !loc || loc.toLowerCase().includes(FIXTURE_CITY);
}

export function fixtureFor(pathname: string, params: Record<string, string>): unknown | null {
  if (pathname === "/search") {
    const q = (params.query ?? "").trim().toLowerCase();
    const hit = (search.queries as Record<string, unknown>)[q];
    return hit ?? { results: [] };
  }
  if (pathname === "/v2/tags") {
    const q = (params["filter.query"] ?? "").toLowerCase();
    return q.includes("house") ? tagsSearch : { results: { tags: [] } };
  }
  if (pathname === "/v2/insights") {
    if (!locationOk(params)) return null;
    switch (params["filter.type"]) {
      case "urn:tag":
        return insightsTags;
      case "urn:entity:artist":
        return insightsArtists;
      case "urn:entity:brand":
        return insightsBrands;
      case "urn:entity:place":
        return insightsPlaces;
      case "urn:heatmap":
        return insightsHeatmap;
      case "urn:demographics":
        return insightsDemographics;
    }
  }
  return null;
}
