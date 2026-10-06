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
}

export function parseTag(t: Any): TagInfo | null {
  const id = str(t?.id) ?? str(t?.tag_id);
  const name = str(t?.name);
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
  };
}

/**
 * The locality Qloo matched for a location query. Docs: a single
 * filter.location.query / signal.location.query adds `query.locality.signal`
 * (deep dive) or `query.localities.filter` (heatmap example). Absent means the
 * location parameter was not applied (Qloo silently ignores params a filter.type
 * does not support).
 */
export function matchedLocality(data: Any): string | undefined {
  const q = data?.query ?? data?.results?.query;
  const l = q?.locality?.signal ?? q?.locality?.filter ?? q?.localities?.signal ?? q?.localities?.filter;
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
