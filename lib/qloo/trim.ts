// Trims a Qloo response to the fields the app reads (lib/qloo/normalize.ts).
//
// Live entity results are large (about 130 KB for 15 artists: biographies, 40+
// tags, external ids). The cache and the recorded fixtures keep only what the
// parsers use, so memory stays small and the recorded files stay reviewable.
// Values are never changed, only dropped. Responses carry no request headers or key.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const pick = (o: Any, keys: string[]) => {
  if (!o || typeof o !== "object") return undefined;
  const out: Any = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
};

/** Genre-like tags only: these are what tag matching and disambiguation use. */
const GENRE_TAG = /^urn:tag:(genre|subgenre)(:|$)/;

function trimTag(t: Any) {
  return pick(t, ["id", "tag_id", "name", "type", "subtype", "query"]);
}

function trimEntity(e: Any) {
  const p = e?.properties ?? {};
  const en = Array.isArray(p.short_descriptions)
    ? p.short_descriptions.filter((x: Any) => Array.isArray(x?.languages) && x.languages.includes("en")).slice(0, 1)
    : undefined;
  const tags = Array.isArray(e?.tags) ? e.tags.filter((t: Any) => GENRE_TAG.test(String(t?.type ?? t?.subtype ?? ""))).slice(0, 12).map(trimTag) : undefined;
  return {
    ...pick(e, ["name", "entity_id", "id", "type", "subtype", "types", "popularity", "disambiguation", "location", "affinity"]),
    properties: pick(
      {
        ...p,
        short_descriptions: en?.length ? en : undefined,
        // Long bios are only a fallback when no short description exists.
        description: !p.short_description && !en?.length && typeof p.description === "string" ? p.description.slice(0, 300) : undefined,
      },
      ["short_description", "short_descriptions", "description", "image", "address", "geocode"],
    ),
    tags,
    query: pick(e?.query, ["affinity", "explainability"]),
  };
}

export function trimResponse(pathname: string, data: Any): Any {
  if (!data || typeof data !== "object") return data;
  if (pathname === "/search") {
    return { results: Array.isArray(data.results) ? data.results.map(trimEntity) : [] };
  }
  const r = data.results ?? {};
  const results: Any = {};
  if (Array.isArray(r.entities)) results.entities = r.entities.map(trimEntity);
  if (Array.isArray(r.tags)) results.tags = r.tags.map(trimTag);
  if (Array.isArray(r.heatmap)) results.heatmap = r.heatmap.map((h: Any) => ({ location: h?.location, query: pick(h?.query, ["affinity", "affinity_rank", "popularity"]) }));
  if (Array.isArray(r.demographics)) results.demographics = r.demographics;
  return { success: data.success, results, query: pick(data.query, ["localities", "locality", "explainability"]) };
}
