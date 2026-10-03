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

export function parseEntity(e: Any): RawEntity | null {
  const entityId = str(e?.entity_id) ?? str(e?.id);
  const name = str(e?.name);
  if (!entityId || !name) return null;
  const types: string[] = Array.isArray(e?.types) ? e.types : [];
  return {
    entityId,
    name,
    subtype: str(e?.subtype),
    types: [...types, ...(str(e?.subtype) ? [e.subtype] : [])],
    affinity: num(e?.query?.affinity),
    popularity: num(e?.popularity),
    description: str(e?.properties?.short_description) ?? str(e?.properties?.description),
    imageUrl: str(e?.properties?.image?.url),
    address: str(e?.properties?.address),
    lat: num(e?.location?.lat) ?? num(e?.properties?.geocode?.lat),
    lng: num(e?.location?.lon) ?? num(e?.location?.lng) ?? num(e?.properties?.geocode?.lon),
    tags: (Array.isArray(e?.tags) ? e.tags : []).map(parseTag).filter(Boolean) as TagInfo[],
  };
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
