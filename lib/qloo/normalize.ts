import "server-only";
import type { BrandPick, DemoProfile, HeatPoint, PlacePick, TagInfo } from "@/lib/types";

// Tolerant parsers for Qloo responses. Field names follow the documented shapes;
// every access is defensive because "invalid params are silently ignored" and
// response details may differ slightly between entity types.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const num = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface RawEntity {
  entityId: string;
  name: string;
  subtype?: string;
  types: string[];
  affinity?: number;
  popularity?: number;
  description?: string;
  disambiguation?: string;
  imageUrl?: string;
  address?: string;
  lat?: number;
  lng?: number;
  tags: TagInfo[];
  /** Raw per-result explainability: input entity -> normalised score (0..1). */
  explain?: { entityId: string; score: number }[];
}

export function parseTag(t: Any): TagInfo | null {
  const id = str(t?.id) ?? str(t?.tag_id);
  // Live tag names come with stray spaces and mixed case (" Techno", "instrumental  hip hop").
  const raw = str(t?.name)?.replace(/\s+/g, " ").trim();
  const name = raw && raw === raw.toLowerCase() ? raw.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : raw;
  if (!id || !name) return null;
  return { id, name, type: str(t?.type) ?? str(t?.subtype), affinity: num(t?.query?.affinity) };
}

/** English short description: properties.short_description, else the `short_descriptions` [{value, languages}] array. */
function shortDesc(e: Any): string | undefined {
  const p = e?.properties;
  const fromList = (l: Any) =>
    Array.isArray(l) ? str(l.find((x: Any) => Array.isArray(x?.languages) && x.languages.includes("en"))?.value) : undefined;
  return str(p?.short_description) ?? str(e?.short_description) ?? fromList(p?.short_descriptions) ?? str(p?.description) ?? str(e?.description);
}

// Field paths: the API examples nest metadata under `properties` and scores under
// `query` (https://docs.qloo.com/reference/basic-insights-use-case); the Schema &
// Taxonomy page shows a flattened view (top-level affinity, url, lat/lon). Accept both.
export function parseEntity(e: Any): RawEntity | null {
  const entityId = str(e?.entity_id) ?? str(e?.id);
  const name = str(e?.name);
  if (!entityId || !name) return null;
  const types: string[] = Array.isArray(e?.types) ? e.types : [];
  const g = e?.properties?.geocode;
  return {
    entityId,
    name,
    subtype: str(e?.subtype),
    types: [...types, ...(str(e?.subtype) ? [e.subtype] : [])],
    affinity: num(e?.query?.affinity) ?? num(e?.affinity),
    popularity: num(e?.popularity) ?? num(e?.properties?.popularity),
    description: shortDesc(e),
    disambiguation: str(e?.disambiguation),
    imageUrl: str(e?.properties?.image?.url) ?? str(e?.url),
    address: str(e?.properties?.address) ?? str(e?.address),
    lat: num(e?.location?.lat) ?? num(e?.location?.latitude) ?? num(g?.lat) ?? num(g?.latitude) ?? num(e?.lat),
    lng: num(e?.location?.lon) ?? num(e?.location?.lng) ?? num(e?.location?.longitude) ?? num(g?.lon) ?? num(g?.lng) ?? num(g?.longitude) ?? num(e?.lon),
    tags: (Array.isArray(e?.tags) ? e.tags : []).map(parseTag).filter(Boolean) as TagInfo[],
    explain: parseResultExplain(e?.query?.explainability),
  };
}

// ---- feature.explainability ----
// Docs (https://docs.qloo.com/reference/parameters, feature.explainability): each
// result gets `query.explainability` listing which input entities (e.g.
// signal.interests.entities) contributed, scores normalised 0..1; entities >= 0.1
// are always included. The top-level `query.explainability` holds the average
// influence per input entity over top-N subsets (top 3, 5, 10, all). If it cannot
// be computed, `query.explainability.warning` is set and results return normally.
// Verified live on 2026-10-06 for urn:entity:artist: per result
// query.explainability["signal.interests.entities"] = [{entity_id, score}] (scores
// sum to ~1), top level query.explainability["signal.interests.entities"] =
// {effect_on_top3_recs, effect_on_top5_recs, effect_on_top10_recs, effect_on_all_recs}.

function explainList(v: Any, scoreKey: "score" | "avg_score"): { entityId: string; score: number }[] {
  if (!Array.isArray(v)) return [];
  const out: { entityId: string; score: number }[] = [];
  for (const x of v) {
    const entityId = str(x?.entity_id) ?? str(x?.id);
    const score = num(x?.[scoreKey]) ?? num(x?.score) ?? num(x?.avg_score);
    if (entityId && score !== undefined) out.push({ entityId, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

function parseResultExplain(x: Any): { entityId: string; score: number }[] | undefined {
  if (!x || typeof x !== "object") return undefined;
  const list = Array.isArray(x) ? explainList(x, "score") : explainList(x["signal.interests.entities"] ?? x.entities, "score");
  return list.length ? list : undefined;
}

/** Top-level aggregate: prefers the top-5 subset, then top 3, top 10, all. */
export function parseExplainSummary(data: Any): { subset: string; drivers: { entityId: string; score: number }[] } | undefined {
  const x = data?.query?.explainability;
  if (!x || typeof x !== "object" || x.warning) return undefined;
  const sig = x["signal.interests.entities"] ?? x.entities;
  if (!sig || typeof sig !== "object") return undefined;
  for (const [key, subset] of [
    ["effect_on_top5_recs", "top 5"],
    ["effect_on_top3_recs", "top 3"],
    ["effect_on_top10_recs", "top 10"],
    ["effect_on_all_recs", "all"],
  ] as const) {
    const drivers = explainList(sig[key], "avg_score");
    if (drivers.length) return { subset, drivers };
  }
  return undefined;
}

/**
 * The locality Qloo matched for a location query. Live (2026-10-06):
 * signal.location.query echoes `query.localities.signal` {name, location{lat,lon}}
 * (artists and brands too, despite the parameter guide), filter.location.query
 * echoes `query.localities.filter` as an array. Absent means the location
 * parameter was not applied (Qloo silently ignores unsupported params).
 */
export function matchedLocality(data: Any): string | undefined {
  const q = data?.query ?? data?.results?.query;
  const first = (v: Any) => (Array.isArray(v) ? v[0] : v);
  const l = first(q?.localities?.signal ?? q?.localities?.filter ?? q?.locality?.signal ?? q?.locality?.filter);
  return str(l?.name) ?? str(l?.disambiguation) ?? (l ? "matched" : undefined);
}

export function parseSearch(data: Any): RawEntity[] {
  const list = Array.isArray(data?.results) ? data.results : Array.isArray(data?.results?.entities) ? data.results.entities : [];
  return list.map(parseEntity).filter(Boolean) as RawEntity[];
}

export function parseEntities(data: Any): RawEntity[] {
  const list = Array.isArray(data?.results?.entities) ? data.results.entities : [];
  return list.map(parseEntity).filter(Boolean) as RawEntity[];
}

export function parseTagList(data: Any): TagInfo[] {
  const list = Array.isArray(data?.results?.tags) ? data.results.tags : Array.isArray(data?.results) ? data.results : [];
  return list.map(parseTag).filter(Boolean) as TagInfo[];
}

export function parseHeatmap(data: Any): HeatPoint[] {
  const list = Array.isArray(data?.results?.heatmap) ? data.results.heatmap : [];
  const out: HeatPoint[] = [];
  for (const p of list) {
    const lat = num(p?.location?.latitude) ?? num(p?.location?.lat);
    const lng = num(p?.location?.longitude) ?? num(p?.location?.lon) ?? num(p?.location?.lng);
    const affinity = num(p?.query?.affinity) ?? num(p?.query?.affinity_rank);
    if (lat === undefined || lng === undefined || affinity === undefined) continue;
    out.push({ lat, lng, affinity, popularity: num(p?.query?.popularity), geohash: str(p?.location?.geohash) });
  }
  return out;
}

export function parseDemographics(data: Any, names: Map<string, string>): DemoProfile[] {
  const list = Array.isArray(data?.results?.demographics) ? data.results.demographics : [];
  const out: DemoProfile[] = [];
  for (const d of list) {
    const entityId = str(d?.entity_id) ?? str(d?.id);
    if (!entityId) continue;
    const pick = (o: Any) =>
      Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === "number")) as Record<string, number>;
    out.push({ entityId, name: names.get(entityId) ?? entityId, age: pick(d?.query?.age), gender: pick(d?.query?.gender) });
  }
  return out;
}

export function toBrand(e: RawEntity): BrandPick {
  return {
    entityId: e.entityId,
    name: e.name,
    affinity: e.affinity ?? 0,
    popularity: e.popularity,
    category: e.description ?? e.tags[0]?.name,
  };
}

export function toPlace(e: RawEntity): PlacePick {
  return {
    entityId: e.entityId,
    name: e.name,
    affinity: e.affinity ?? 0,
    address: e.address,
    category: e.description ?? e.tags[0]?.name,
    lat: e.lat,
    lng: e.lng,
  };
}
