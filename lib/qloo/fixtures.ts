import "server-only";
import detroit from "@/fixtures/detroit-gasworks.json";
import austin from "@/fixtures/austin-lantern.json";
import brooklyn from "@/fixtures/brooklyn-lowtide.json";
import nashville from "@/fixtures/nashville-copperline.json";
import london from "@/fixtures/london-basement.json";

// Fixture router: answers a Qloo request from the SAMPLE fixtures in /fixtures
// (hand-written, labelled, see scripts/make-fixtures.mjs). Only the five preset
// venues are covered. Anything else returns null, and the caller reports
// "no sample data" instead of inventing results.
//
// The router applies the same filters Qloo does for the params we send
// (filter.popularity.min/max, filter.exclude.entities, signal entities for
// demographics, take), so the agent's branch logic behaves the same way it
// would against the live API.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

interface FixtureSet {
  search: Record<string, Any>;
  tags: { keywords: string[]; response: Any };
  insights: Record<"tag" | "artist" | "demographics" | "brand" | "place" | "heatmap", Any>;
}

const SETS: Record<string, FixtureSet> = {
  "detroit-gasworks": detroit as FixtureSet,
  "austin-lantern": austin as FixtureSet,
  "brooklyn-lowtide": brooklyn as FixtureSet,
  "nashville-copperline": nashville as FixtureSet,
  "london-basement": london as FixtureSet,
};

export function hasFixtures(set: string | undefined): boolean {
  return !!set && set in SETS;
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function entitiesResponse(base: Any, entities: Any[]) {
  return { ...base, results: { ...base.results, entities } };
}

export function fixtureFor(set: string | undefined, pathname: string, params: Record<string, string>): unknown | null {
  const f = set ? SETS[set] : undefined;
  if (!f) return null;
  const take = params.take ? Number(params.take) : undefined;

  if (pathname === "/search") {
    const q = (params.query ?? "").trim().toLowerCase();
    return f.search[q] ?? { results: [] };
  }
  if (pathname === "/v2/tags") {
    const q = (params["filter.query"] ?? "").toLowerCase();
    return f.tags.keywords.some((k) => q.includes(k)) ? f.tags.response : { results: { tags: [] } };
  }
  if (pathname !== "/v2/insights") return null;

  switch (params["filter.type"]) {
    case "urn:tag":
      return f.insights.tag;
    case "urn:entity:artist": {
      const min = params["filter.popularity.min"] !== undefined ? Number(params["filter.popularity.min"]) : 0;
      const max = params["filter.popularity.max"] !== undefined ? Number(params["filter.popularity.max"]) : 1;
      const exclude = new Set(list(params["filter.exclude.entities"]));
      const ents = (f.insights.artist.results.entities as Any[])
        .filter((e) => !exclude.has(e.entity_id) && e.popularity >= min && e.popularity <= max)
        .slice(0, take ?? 20);
      return entitiesResponse(f.insights.artist, ents);
    }
    case "urn:demographics": {
      const ids = new Set(list(params["signal.interests.entities"]));
      return {
        ...f.insights.demographics,
        results: { demographics: (f.insights.demographics.results.demographics as Any[]).filter((d) => ids.has(d.entity_id)) },
      };
    }
    case "urn:entity:brand":
      return entitiesResponse(f.insights.brand, (f.insights.brand.results.entities as Any[]).slice(0, take ?? 20));
    case "urn:entity:place":
      return entitiesResponse(f.insights.place, (f.insights.place.results.entities as Any[]).slice(0, take ?? 20));
    case "urn:heatmap":
      return f.insights.heatmap;
  }
  return null;
}
