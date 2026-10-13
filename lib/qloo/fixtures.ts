import "server-only";
import detroit from "@/fixtures/detroit-gasworks.json";
import austin from "@/fixtures/austin-lantern.json";
import brooklyn from "@/fixtures/brooklyn-lowtide.json";
import nashville from "@/fixtures/nashville-copperline.json";
import london from "@/fixtures/london-basement.json";
import { cacheKey } from "./cache";

// Recorded-mode router. fixtures/<venue-id>.json holds real responses recorded
// from the Qloo hackathon API (scripts/record-fixtures.mjs), trimmed to the fields
// the app reads (lib/qloo/trim.ts). Only the five preset venues are covered.
//
// Lookup: the exact request (same path and params) first. If the planner asks
// for something that was not recorded (e.g. a different popularity band), the
// router answers from the recorded responses of the same kind and applies the
// filters Qloo applies for the params we send (popularity band, excluded
// entities, take). Anything else returns null, and the caller reports "no
// recorded data" instead of inventing results.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface RecordedSet {
  recordedAt: string;
  note: string;
  calls: Record<string, Any>;
}

const SETS: Record<string, RecordedSet> = {
  "detroit-gasworks": detroit as RecordedSet,
  "austin-lantern": austin as RecordedSet,
  "brooklyn-lowtide": brooklyn as RecordedSet,
  "nashville-copperline": nashville as RecordedSet,
  "london-basement": london as RecordedSet,
};

/** Date the preset responses were recorded (newest set), for the UI label. */
export function recordedOn(): string | undefined {
  return Object.values(SETS)
    .map((s) => s.recordedAt)
    .sort()
    .pop();
}

export function hasFixtures(set: string | undefined): boolean {
  return !!set && set in SETS;
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

function parseKey(key: string): { path: string; params: Record<string, string> } {
  const i = key.indexOf("?");
  const params: Record<string, string> = {};
  for (const kv of key.slice(i + 1).split("&")) {
    const j = kv.indexOf("=");
    if (j > 0) params[kv.slice(0, j)] = kv.slice(j + 1);
  }
  return { path: key.slice(0, i), params };
}

function stripExplain(d: Any): Any {
  const ents = (d?.results?.entities ?? []).map((e: Any) => ({ ...e, query: { ...e.query, explainability: undefined } }));
  return { ...d, results: { ...d.results, entities: ents }, query: { ...d.query, explainability: undefined } };
}

function nearest(f: RecordedSet, pathname: string, params: Record<string, string>): Any | null {
  const same = Object.entries(f.calls)
    .map(([k, data]) => ({ ...parseKey(k), data }))
    .filter((c) => c.path === pathname);
  const take = params.take ? Number(params.take) : 20;

  if (pathname === "/search") {
    const hit = same.find((c) => c.params.query?.toLowerCase() === params.query?.toLowerCase() && c.params.types === params.types);
    return hit?.data ?? { results: [] };
  }
  if (pathname === "/v2/tags") {
    const hit = same.find((c) => c.params["filter.query"]?.toLowerCase() === params["filter.query"]?.toLowerCase());
    return hit?.data ?? { success: true, results: { tags: [] } };
  }
  const kind = same.filter((c) => c.params["filter.type"] === params["filter.type"]);
  if (!kind.length) return null;
  if (params["filter.type"] !== "urn:entity:artist") return kind[0].data;

  // Artists: pool every recorded artist result for this venue and apply the band.
  const min = params["filter.popularity.min"] !== undefined ? Number(params["filter.popularity.min"]) : 0;
  const max = params["filter.popularity.max"] !== undefined ? Number(params["filter.popularity.max"]) : 1;
  const exclude = new Set(list(params["filter.exclude.entities"]));
  const pool = new Map<string, Any>();
  for (const c of kind) for (const e of c.data?.results?.entities ?? []) if (!pool.has(e.entity_id)) pool.set(e.entity_id, e);
  const ents = [...pool.values()]
    .filter((e) => !exclude.has(e.entity_id) && typeof e.popularity === "number" && e.popularity >= min && e.popularity <= max)
    .sort((a, b) => (b.query?.affinity ?? 0) - (a.query?.affinity ?? 0))
    .slice(0, take);
  return { ...kind[0].data, results: { entities: ents } };
}

/**
 * When a heatmap, demographics or brand request was not recorded exactly (the agent
 * chose different acts than at recording time), the router answers with the recorded
 * call of the same kind. This returns the acts that recorded call was about, so the
 * UI can name them truthfully. Undefined when the exact request was recorded.
 */
export function recordedSubject(set: string | undefined, pathname: string, params: Record<string, string>): { ids: string[]; names: string[] } | undefined {
  const f = set ? SETS[set] : undefined;
  if (!f || pathname !== "/v2/insights" || f.calls[cacheKey(pathname, params)]) return undefined;
  const type = params["filter.type"];
  if (!type || type === "urn:entity:artist" || !params["signal.interests.entities"]) return undefined;
  const hit = Object.keys(f.calls)
    .map(parseKey)
    .find((c) => c.path === pathname && c.params["filter.type"] === type);
  if (!hit) return undefined;
  const ids = list(decodeURIComponent(hit.params["signal.interests.entities"] ?? ""));
  const want = list(params["signal.interests.entities"]);
  if (ids.length === want.length && ids.every((x) => want.includes(x))) return undefined;
  const names = new Map<string, string>();
  for (const data of Object.values(f.calls)) {
    const ents = Array.isArray(data?.results) ? data.results : (data?.results?.entities ?? []);
    for (const e of ents) if (e?.entity_id && e?.name) names.set(e.entity_id, e.name);
  }
  return { ids, names: ids.map((x) => names.get(x) ?? x) };
}

export function fixtureFor(
  set: string | undefined,
  pathname: string,
  params: Record<string, string>,
  opts: { noExplain?: boolean } = {},
): unknown | null {
  const f = set ? SETS[set] : undefined;
  if (!f) return null;
  const data = f.calls[cacheKey(pathname, params)] ?? nearest(f, pathname, params);
  if (data == null) return null;
  return opts.noExplain && params["filter.type"] === "urn:entity:artist" ? stripExplain(data) : data;
}
